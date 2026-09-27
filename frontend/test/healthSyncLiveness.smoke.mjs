import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

class Storage {
  values = new Map()
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, String(value)) }
  removeItem(key) { this.values.delete(key) }
}
globalThis.localStorage = new Storage()
globalThis.window = new EventTarget()
window.location = { pathname: '/', assign: () => { throw new Error('Unexpected navigation') } }
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'iPhone' } })
globalThis.CustomEvent ||= class extends Event { constructor(name, options) { super(name); this.detail = options?.detail } }
const vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true } })
const flush = async () => { for (let i = 0; i < 12; i++) await new Promise((resolve) => setImmediate(resolve)) }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function clock() {
  let time = 1000000, seq = 0
  const timers = new Map()
  return {
    now: () => time,
    schedule(fn, delay) { const id = ++seq; timers.set(id, { at: time + delay, fn }); return id },
    cancel(id) { timers.delete(id) },
    async advance(ms) {
      time += ms
      // One scheduler generation per advance: explicitly expose any retry storm.
      for (const [id, item] of [...timers]) if (item.at <= time) { timers.delete(id); item.fn() }
      await flush()
    },
    get pending() { return timers.size },
  }
}

try {
  const { HealthService } = await vite.ssrLoadModule('/src/services/HealthService.js')
  const { default: api } = await vite.ssrLoadModule('/src/lib/api.js')
  const tokens = await vite.ssrLoadModule('/src/lib/tokenStore.js')
  const auth = await vite.ssrLoadModule('/src/lib/auth.js')
  const sync = await vite.ssrLoadModule('/src/lib/healthSync.js')
  const { mountForegroundHealthSync, syncConnectedStrava } = await vite.ssrLoadModule('/src/lib/healthForegroundSync.js')
  const token = (id) => `fixture.${Buffer.from(JSON.stringify({ id, exp: 9999999999 })).toString('base64url')}.synthetic`
  const login = (id = 'owner-a') => tokens.setToken(token(id))
  const reset = () => { tokens.clearToken(); localStorage.values.clear(); rows.clear(); login(); localStorage.setItem('forge_health_authorized', '1'); localStorage.setItem('forge_health_authorized_version', '4') }
  const calls = [], rows = new Set(), events = []
  let responseHook
  api.defaults.adapter = async (config) => {
    calls.push({ path: config.url, account: config.forgeAuthSession, signal: config.signal, data: JSON.parse(config.data || '{}') })
    const custom = await responseHook?.(config)
    if (custom) return { status: 200, statusText: 'OK', headers: {}, config, data: custom }
    let data = { profile: {}, zones: [] }
    if (config.url === '/import/health') {
      let imported = 0, skipped = 0
      for (const workout of JSON.parse(config.data).workouts) {
        const id = `${config.forgeAuthSession.accountId}:${workout.id}`
        if (rows.has(id)) skipped++
        else { rows.add(id); imported++ }
      }
      data = { imported, skipped, errors: [] }
    }
    return { status: 200, statusText: 'OK', headers: {}, config, data }
  }
  window.addEventListener(sync.HEALTH_SYNC_RESULT_EVENT, (event) => events.push(event.detail))
  function fixture(overrides = {}) {
    const time = clock(), historyOptions = []
    const bridge = {
      isAvailable: async () => ({ available: true }),
      requestAuthorization: async () => ({ authorized: true }),
      getSummary: async () => ({ metricsSchemaVersion: 6, workouts: [] }),
      getWorkoutHistory: async (options) => { historyOptions.push(options); return { workouts: [{ id: 'physical-1' }] } },
      ...overrides,
    }
    const service = new HealthService({ apiClient: api, bridge, native: () => true, coordinatorOptions: { schedule: time.schedule, cancel: time.cancel } })
    return { service, bridge, time, historyOptions }
  }

  // Real Axios request interception: capture at initiation, switch before dispatch.
  reset()
  const captured = { ...tokens.getAuthSession(), accountId: auth.getAuthenticatedUserId() }
  const sentBefore = calls.length
  const obsolete = api.post('/health/sync', {}, { forgeAuthSession: captured })
  login('owner-b')
  await assert.rejects(obsolete, /Account changed/)
  assert.equal(calls.length, sentBefore, 'old request cannot dispatch with successor token')
  const gate401 = deferred()
  responseHook = async (config) => { await gate401.promise; throw Object.assign(new Error('old401'), { config, response: { status: 401 } }) }
  const old401 = api.get('/profile/hr-zones', { forgeAuthSession: tokens.getAuthSession() })
  await flush(); login('owner-c'); gate401.resolve()
  await assert.rejects(old401, /old401/)
  assert.equal(auth.getAuthenticatedUserId(), 'owner-c', 'stale401 cannot clear successor login')
  responseHook = null

  // Successful real-service path: summary and history reach scoped API writes.
  reset()
  {
    const f = fixture({ getSummary: async () => ({ metricsSchemaVersion: 6, stepsToday: 321 }) })
    const before = calls.length
    const result = await f.service.syncNativeData()
    const writes = calls.slice(before)
    const profile = writes.find(call => call.path === '/health/sync')
    const imports = writes.filter(call => call.path === '/import/health')
    assert.equal(result.complete, true); assert.equal(result.imported, 1)
    assert.equal(profile.data.steps_today, 321, 'native summary reaches real profile persistence')
    assert.equal(f.historyOptions.length, 1, 'real service requests native history')
    assert.equal(imports.length, 1); assert.equal(imports[0].data.workouts[0].id, 'physical-1')
    for (const call of writes) {
      assert.equal(call.account.accountId, 'owner-a', 'profile, HR lookup and import share captured account')
      assert.equal(tokens.isAuthSessionCurrent(call.account), true)
      assert.equal(call.signal.aborted, false, 'live scoped requests retain cancellation signal')
    }
    f.service.dispose()
  }

  reset()
  const stravaGate = deferred(), stravaBefore = calls.length
  responseHook = async (config) => { if (config.url === '/strava/status') { await stravaGate.promise; return { connected: true } } }
  const enrichment = syncConnectedStrava(api, { ...tokens.getAuthSession(), accountId: 'owner-a' })
  await flush(); login('owner-b'); stravaGate.resolve(); await enrichment
  assert.equal(calls.slice(stravaBefore).filter((call) => call.path === '/strava/sync').length, 0, 'account switch after status cannot dispatch successor enrichment')
  assert.equal(localStorage.getItem(sync.healthAccountKey('forge_auto_strava_sync_last_sync_at', 'owner-b')), null)
  responseHook = null

  // Summary never settles: operation deadline releases every waiter and retries.
  reset()
  {
    const hang = deferred(), f = fixture({ getSummary: () => hang.promise })
    const before = calls.length, beforeEvents = events.length
    const first = f.service.syncNativeData(), rejected = assert.rejects(first, { code: 'HEALTH_SYNC_TIMEOUT' })
    await flush(); await f.time.advance(sync.HEALTH_SYNC_OPERATION_DEADLINE_MS); await rejected
    assert.equal(f.service.hasNativeSyncInFlight(), false)
    f.bridge.getSummary = async () => ({ metricsSchemaVersion: 6 })
    assert.equal((await f.service.syncNativeData()).complete, true)
    const after = calls.length, published = events.length
    hang.resolve({ metricsSchemaVersion: 6 }); await flush()
    assert.equal(calls.length, after, 'late summary cannot write profile or import')
    assert.equal(events.length, published, 'late operation cannot publish')
    assert.ok(after > before && published > beforeEvents)
    f.service.dispose()
  }

  // An old native history may still advance its anchor after cancellation.
  reset()
  {
    const late = deferred(), options = [], f = fixture({ getWorkoutHistory: (opt) => { options.push(opt); return late.promise } })
    const first = f.service.syncNativeData(), rejected = assert.rejects(first, { code: 'HEALTH_SYNC_TIMEOUT' })
    await flush()
    assert.equal(sync.isHealthHistoryTransferPending('owner-a'), true, 'checkpoint precedes native history')
    await f.time.advance(sync.HEALTH_SYNC_OPERATION_DEADLINE_MS); await rejected
    f.bridge.getWorkoutHistory = async (opt) => { options.push(opt); return { workouts: [{ id: 'physical-1' }] } }
    const retry = await f.service.syncNativeData()
    assert.equal(retry.complete, false, 'unsettled old anchor read prevents premature checkpoint acknowledgement')
    assert.equal(sync.isHealthHistoryTransferPending('owner-a'), true)
    assert.equal(options[1].forceFullSync, true)
    const beforeEvents = events.length, beforeCalls = calls.length
    late.resolve({ workouts: [{ id: 'stale-native-row' }] }); await flush()
    assert.equal(calls.length, beforeCalls)
    assert.equal(events.length, beforeEvents)
    assert.equal(sync.isHealthHistoryTransferPending('owner-a'), true, 'late old history cannot clear newer checkpoint')
    const replay = await f.service.syncNativeData()
    assert.equal(replay.complete, true); assert.equal(replay.imported, 0); assert.equal(replay.skipped, 1)
    assert.equal(options[2].forceFullSync, true)
    assert.equal(sync.isHealthHistoryTransferPending('owner-a'), false)
    f.service.dispose()
  }

  // Logout and login even to the SAME account invalidate pending continuations.
  reset()
  {
    const unresolved = [deferred(), deferred()], f = fixture()
    let nativeCalls = 0
    f.bridge.getWorkoutHistory = () => unresolved[nativeCalls++].promise
    for (let i = 0; i < 2; i++) {
      const rejected = assert.rejects(f.service.syncNativeData(), { code: 'HEALTH_SYNC_TIMEOUT' })
      await flush(); await f.time.advance(sync.HEALTH_SYNC_OPERATION_DEADLINE_MS); await rejected
    }
    for (let i = 0; i < 8; i++) await assert.rejects(f.service.syncNativeData(), /still pending/)
    assert.equal(nativeCalls, 2, 'repeated timeout retries never create unbounded native jobs')
    assert.equal(f.service.pendingBridgeCalls.size, 2)
    assert.equal(f.service.hasNativeSyncInFlight(), false)
    assert.equal(sync.isHealthHistoryTransferPending('owner-a'), true)
    unresolved.forEach((pending) => pending.resolve({ workouts: [] })); await flush()
    assert.equal(f.service.pendingBridgeCalls.size, 0)
    f.bridge.getWorkoutHistory = async () => ({ workouts: [] })
    assert.equal((await f.service.syncNativeData()).complete, true, 'native settlement restores safe retry capacity')
    f.service.dispose()
  }

  // Logout and login even to the SAME account invalidate pending continuations.
  for (const next of ['owner-a', 'owner-b']) {
    reset()
    const late = deferred(), f = fixture({ getWorkoutHistory: () => late.promise })
    const first = f.service.syncNativeData(), rejected = assert.rejects(first, { code: 'HEALTH_SYNC_CANCELLED' })
    await flush(); tokens.clearToken(); login(next); await rejected
    const before = calls.length, beforeEvents = events.length
    late.resolve({ workouts: [{ id: 'wrong-generation' }] }); await flush()
    assert.equal(calls.length, before); assert.equal(events.length, beforeEvents)
    assert.equal(f.service.getRecentNativeSyncResult(), null)
    assert.equal(sync.isHealthHistoryTransferPending('owner-a'), true)
    f.bridge.getWorkoutHistory = async (options) => { assert.equal(options.forceFullSync, true); return { workouts: [] } }
    assert.equal((await f.service.syncNativeData()).complete, true)
    if (next !== 'owner-a') assert.equal(sync.isHealthHistoryTransferPending('owner-a'), true, 'another account cannot acknowledge prior transfer')
    f.service.dispose()
  }

  // Account switch during the first batch cannot send a second batch.
  reset()
  {
    const gate = deferred(), f = fixture({ getWorkoutHistory: async () => ({ workouts: Array.from({ length: 23 }, (_, i) => ({ id: `batch-${i}` })) }) })
    responseHook = async (config) => { if (config.url === '/import/health') await gate.promise }
    const start = calls.length, operation = f.service.syncNativeData(), rejected = assert.rejects(operation, { code: 'HEALTH_SYNC_CANCELLED' })
    await flush(); login('owner-b'); await rejected; gate.resolve(); await flush()
    assert.equal(calls.slice(start).filter((call) => call.path === '/import/health').length, 1)
    assert.equal(sync.isHealthHistoryTransferPending('owner-a'), true)
    responseHook = null; f.service.dispose()
  }

  // Real permission escalation joins automatic work then requests once.
  reset()
  {
    localStorage.setItem('forge_health_authorized_version', '1')
    let authorizations = 0
    const f = fixture({ requestAuthorization: async () => { authorizations++; return { authorized: true } } })
    const all = await Promise.all([f.service.syncNativeData(), f.service.syncNativeData({ requestPermission: true }), f.service.syncNativeData({ requestPermission: true })])
    assert.equal(authorizations, 1); assert.equal(all[2].authorizationUpgradeRequired, false)
    f.service.dispose()
  }

  // Pull deadline settles UI at15s, real service remains bounded at120s.
  reset()
  {
    const authorization = deferred(), f = fixture({ requestAuthorization: () => authorization.promise })
    localStorage.removeItem('forge_health_authorized')
    localStorage.removeItem('forge_health_authorized_version')
    const operation = f.service.syncNativeData({ requestPermission: true }), rejected = assert.rejects(operation, { code: 'HEALTH_SYNC_CANCELLED' })
    await flush(); tokens.clearToken(); login('owner-b'); await rejected
    authorization.resolve({ authorized: true }); await flush()
    assert.equal(localStorage.getItem('forge_health_authorized_version'), null, 'late authorization cannot upgrade local state after cancellation')
    f.service.dispose()
  }

  reset()
  {
    const hang = deferred(), f = fixture({ getSummary: () => hang.promise })
    const operation = f.service.syncNativeData(), rejected = assert.rejects(operation, { code: 'HEALTH_SYNC_CANCELLED' })
    await flush()
    const event = new Event('storage'); event.key = 'forge_token'
    window.dispatchEvent(event); await rejected
    hang.resolve({ metricsSchemaVersion: 6 }); await flush()
    assert.equal(f.service.getRecentNativeSyncResult(), null, 'cross-document auth event invalidates generation even with same token')
    f.service.dispose()
  }

  // Pull deadline settles UI at15s, real service remains bounded at120s.
  reset()
  {
    const hang = deferred(), f = fixture({ getSummary: () => hang.promise }), gesture = clock()
    let refreshed = 0
    const pull = sync.runHealthAwarePageRefresh({ authenticated: true, native: true, syncNativeData: (options) => f.service.syncNativeData(options), scheduleDeadline: gesture.schedule, cancelDeadline: gesture.cancel, refreshPage: () => { refreshed++ } })
    await flush(); await gesture.advance(sync.HEALTH_PULL_REFRESH_DEADLINE_MS)
    assert.equal((await pull).healthSyncError.code, 'HEALTH_PULL_REFRESH_TIMEOUT')
    assert.equal(refreshed, 1); assert.equal(f.service.hasNativeSyncInFlight(), true)
    await f.time.advance(sync.HEALTH_SYNC_OPERATION_DEADLINE_MS)
    assert.equal(f.service.hasNativeSyncInFlight(), false)
    hang.resolve({ metricsSchemaVersion: 6 }); await flush()
    f.service.dispose()
  }

  // A workout observed after a manual read started needs a later read too.
  reset()
  {
    const gate = deferred(), f = fixture()
    let reads = 0
    f.bridge.getSummary = async () => { reads++; if (reads === 1) await gate.promise; return { metricsSchemaVersion: 6 } }
    const manual = f.service.syncNativeData({ forceFresh: true }); await flush()
    const observed1 = f.service.syncNativeData({ forceFresh: true, afterActive: true })
    const observed2 = f.service.syncNativeData({ forceFresh: true, afterActive: true })
    gate.resolve(); await Promise.all([manual, observed1, observed2])
    assert.equal(reads, 2, 'concurrent observer waiters coalesce one newer read even behind forceFresh')
    f.service.dispose()
  }

  // A partial transport failure keeps already committed batches and full retry.
  reset()
  {
    const f = fixture({ getWorkoutHistory: async (options) => { assert.equal(options.forceFullSync, true); return { workouts: Array.from({ length: 23 }, (_, i) => ({ id: `partial-${i}` })) } } })
    let batches = 0
    responseHook = async (config) => { if (config.url === '/import/health' && ++batches === 2) throw new Error('synthetic offline') }
    await assert.rejects(f.service.syncNativeData(), /synthetic offline/)
    assert.equal(sync.isHealthHistoryTransferPending('owner-a'), true)
    responseHook = null
    const retry = await f.service.syncNativeData()
    assert.equal(retry.imported, 13); assert.equal(retry.skipped, 10); assert.equal(retry.complete, true)
    f.service.dispose()
  }

  // Clearing the durable checkpoint is part of completion, not a best-effort
  // side effect. A storage failure must retain replay and cannot report success.
  reset()
  {
    const f = fixture(), remove = localStorage.removeItem
    localStorage.removeItem = function (key) {
      if (key === sync.healthAccountKey('forge.health.resyncNeeded', 'owner-a')) throw new Error('synthetic checkpoint clear failure')
      return remove.call(this, key)
    }
    try {
      const result = await f.service.syncNativeData()
      assert.equal(result.complete, false)
      assert.equal(result.imported, 1, 'actual imported work remains visible despite incomplete acknowledgment')
      assert.equal(sync.isHealthHistoryTransferPending('owner-a'), true)
      assert.equal(events.at(-1).status, 'partial', 'checkpoint failure never announces completion success')
    } finally { localStorage.removeItem = remove }
    const retry = await f.service.syncNativeData()
    assert.equal(f.historyOptions.at(-1).forceFullSync, true)
    assert.equal(retry.complete, true); assert.equal(retry.imported, 0); assert.equal(retry.skipped, 1)
    assert.equal(sync.isHealthHistoryTransferPending('owner-a'), false)
    f.service.dispose()
  }

  // Listener registration can settle after unmount; each fulfilled handle is removed.
  reset()
  {
    const delayed = deferred(), removed = [], doc = new EventTarget(), time = clock()
    const mounted = mountForegroundHealthSync({
      service: { syncNativeData: async () => ({ complete: true }), addWorkoutObserverListener: () => delayed.promise },
      app: { addListener: (name) => name === 'resume' ? Promise.reject(new Error('synthetic listener unavailable')) : Promise.resolve({ remove: () => removed.push(name) }) },
      documentTarget: doc, getAccountId: auth.getAuthenticatedUserId,
      now: time.now, schedule: time.schedule, cancel: time.cancel, onError: () => {},
    })
    mounted.dispose(); delayed.resolve({ remove: () => removed.push('workout') }); await flush()
    assert.deepEqual(removed.sort(), ['appStateChange', 'workout'])
    assert.equal(time.pending, 0)
  }

  // Every registration is attempted even when a sibling throws synchronously.
  for (const failed of ['appStateChange', 'resume', 'workoutObserved']) {
    reset()
    const attempted = [], removed = [], errors = [], callbacks = new Map(), time = clock()
    let reads = 0
    const register = (name, callback) => {
      attempted.push(name)
      if (name === failed) throw new Error(`register:${name}`)
      callbacks.set(name, callback)
      return { remove() { removed.push(name); callbacks.delete(name) } }
    }
    const lifecycle = mountForegroundHealthSync({
      service: { syncNativeData: async () => { reads++; return { complete: true } }, addWorkoutObserverListener: (callback) => register('workoutObserved', callback) },
      app: { addListener: register }, documentTarget: new EventTarget(), getAccountId: auth.getAuthenticatedUserId,
      now: time.now, schedule: time.schedule, cancel: time.cancel, onError: (error) => errors.push(error.message),
    })
    await flush()
    assert.deepEqual(attempted, ['appStateChange', 'resume', 'workoutObserved'])
    assert.deepEqual(errors, [`register:${failed}`])
    if (failed !== 'workoutObserved') {
      callbacks.get('workoutObserved')(); await flush()
      assert.equal(reads, 2, 'observer remains functional after either App registration throws')
    }
    lifecycle.dispose(); lifecycle.dispose(); await flush()
    assert.deepEqual(removed.sort(), attempted.filter((name) => name !== failed).sort())
    assert.equal(callbacks.size, 0); assert.equal(time.pending, 0)
  }

  // Cleanup isolates synchronous throws and rejected Promises, including all
  // handles arriving after disposal. Neither may abort sibling cleanup or leak
  // an unhandled rejection. A failed native removal cannot be forcibly repaired.
  for (const late of [false, true]) {
    reset()
    const errors = [], unhandled = [], attempted = [], callbacks = new Map(), pending = [], time = clock()
    const reject = (error) => unhandled.push(error)
    process.on('unhandledRejection', reject)
    try {
      let generation = 0, reads = 0
      const register = (name, callback) => {
        const key = `${generation}:${name}`
        callbacks.set(key, callback)
        const handle = { remove() {
          attempted.push(key); callbacks.delete(key)
          if (name === 'appStateChange') throw new Error(`remove:${key}`)
          if (name === 'resume') return Promise.reject(new Error(`remove:${key}`))
        } }
        if (!late) return handle
        const request = deferred(); pending.push(() => request.resolve(handle)); return request.promise
      }
      const doc = new EventTarget(); doc.visibilityState = 'visible'
      const mount = () => mountForegroundHealthSync({
        service: { syncNativeData: async () => { reads++; return { complete: true } }, addWorkoutObserverListener: (callback) => register('workoutObserved', callback) },
        app: { addListener: register }, documentTarget: doc, getAccountId: auth.getAuthenticatedUserId,
        now: time.now, schedule: time.schedule, cancel: time.cancel, onError: (error) => errors.push(error.message),
      })
      for (generation = 0; generation < 2; generation++) {
        const lifecycle = mount(); await flush()
        lifecycle.dispose(); lifecycle.dispose()
        pending.splice(0).forEach((settle) => settle()); await flush()
        assert.equal(callbacks.size, 0, 'all removable registrations are cleaned across remount')
        assert.equal(time.pending, 0)
        const before = reads; doc.dispatchEvent(new Event('visibilitychange')); await time.advance(300000)
        assert.equal(reads, before, 'disposed document listener and timers cannot sync')
      }
      assert.equal(attempted.length, 6, 'every handle removed exactly once despite sibling failures')
      assert.equal(new Set(attempted).size, 6)
      assert.deepEqual(errors.sort(), ['remove:0:appStateChange', 'remove:0:resume', 'remove:1:appStateChange', 'remove:1:resume'].sort())
      assert.deepEqual(unhandled, [])
    } finally { process.off('unhandledRejection', reject) }
  }

  // Real foreground lifecycle + real service, fake only clocks/native/API.
  reset()
  {
    const f = fixture(), time = clock(), listeners = new Map(), removed = []
    const realNow = Date.now
    Date.now = time.now
    let summaries = 0, hold = null
    f.bridge.getSummary = async () => { summaries++; if (hold) await hold.promise; return { metricsSchemaVersion: 6 } }
    f.bridge.addListener = (name, callback) => { listeners.set(name, callback); return Promise.resolve({ remove: () => { removed.push(name); listeners.delete(name) } }) }
    const doc = new EventTarget(); doc.visibilityState = 'visible'
    const app = { addListener: f.bridge.addListener }
    const mount = () => mountForegroundHealthSync({ service: f.service, app, documentTarget: doc, getAccountId: auth.getAuthenticatedUserId, now: time.now, schedule: time.schedule, cancel: time.cancel, onError: () => {} })
    const lifecycle = mount(); await flush(); assert.equal(summaries, 1)
    await time.advance(60000); listeners.get('workoutObserved')(); await flush()
    assert.equal(summaries, 2, 'new workout within60s bypasses normal cooldown')
    listeners.get('resume')(); await flush(); assert.equal(summaries, 2)
    listeners.get('appStateChange')({ isActive: false }); await flush(); assert.equal(summaries, 2)
    listeners.get('appStateChange')({ isActive: true }); await flush(); assert.equal(summaries, 2, 'Capacitor activation respects cooldown')
    doc.dispatchEvent(new Event('visibilitychange')); await flush(); assert.equal(summaries, 2, 'visible foreground return respects cooldown')
    await time.advance(300000); assert.equal(summaries, 3, 'periodic cooldown expires using the same persisted/operation clock')
    hold = deferred(); listeners.get('workoutObserved')(); await flush()
    for (let i = 0; i < 8; i++) listeners.get('workoutObserved')()
    assert.equal(summaries, 4)
    const released = hold; hold = null; released.resolve(); await flush(); await time.advance(0)
    assert.equal(summaries, 5, 'burst during active sync drains exactly one follow-up')
    await time.advance(0); assert.equal(summaries, 5)
    responseHook = async (config) => config.url === '/import/health' ? { errors: [{ retryable: true }], imported: 0, skipped: 0 } : null
    listeners.get('workoutObserved')(); await flush(); const failed = summaries
    assert.ok(localStorage.getItem(sync.healthAccountKey('forge.health.observerPending', 'owner-a')))
    for (let i = 0; i < 10; i++) listeners.get('workoutObserved')()
    await time.advance(29999); assert.equal(summaries, failed, 'partial retry has backoff despite new bursts')
    responseHook = null; await time.advance(1); assert.equal(summaries, failed + 1)
    assert.equal(localStorage.getItem(sync.healthAccountKey('forge.health.observerPending', 'owner-a')), null)
    lifecycle.dispose(); await flush(); assert.equal(removed.length, 3); assert.equal(time.pending, 0)
    const before = summaries; doc.dispatchEvent(new Event('visibilitychange')); await time.advance(300000)
    assert.equal(summaries, before, 'disposed lifecycle has no listeners or timers')
    const remount = mount(); await flush(); assert.equal(summaries, before + 1); remount.dispose(); f.service.dispose()
    Date.now = realNow
  }
  console.log('HEALTH SYNC LIVENESS OK: real service/coordinator/API interceptors; profile/import account identity, cooldown, observer bypass, timeout, late anchor, auth generations, partial retry, permission, pull deadline, event burst, teardown; no external calls')
} finally { await vite.close() }
