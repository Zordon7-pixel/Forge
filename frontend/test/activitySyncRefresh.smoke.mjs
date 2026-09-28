import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

class Storage { values = new Map(); getItem(k) { return this.values.get(k) ?? null } setItem(k, v) { this.values.set(k, String(v)) } removeItem(k) { this.values.delete(k) } }
globalThis.localStorage = new Storage()
globalThis.window = new EventTarget()
window.location = { pathname: '/', assign() { throw Error('Unexpected navigation') } }
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'iPhone' } })
globalThis.CustomEvent ||= class extends Event { constructor(t, o) { super(t); this.detail = o?.detail } }
const vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true } })
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(setImmediate) }
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
try {
  const { HealthService } = await vite.ssrLoadModule('/src/services/HealthService.js')
  const { default: api } = await vite.ssrLoadModule('/src/lib/api.js')
  const token = await vite.ssrLoadModule('/src/lib/tokenStore.js')
  const auth = await vite.ssrLoadModule('/src/lib/auth.js')
  const sync = await vite.ssrLoadModule('/src/lib/healthSync.js')
  const fg = await vite.ssrLoadModule('/src/lib/healthForegroundSync.js')
  let calls, rows, events, hook
  const login = (id = 'owner-a') => token.setToken(`fixture.${Buffer.from(JSON.stringify({ id, exp: 9999999999 })).toString('base64url')}.fake`)
  const session = () => ({ ...token.getAuthSession(), accountId: auth.getAuthenticatedUserId() })
  const reset = () => { token.clearToken(); localStorage.values.clear(); login(); localStorage.setItem('forge_health_authorized', '1'); localStorage.setItem('forge_health_authorized_version', '4'); calls = []; rows = new Set(); events = []; hook = null }
  window.addEventListener(sync.ACTIVITY_DATA_CHANGED_EVENT, event => events.push({ ...event.detail, rows: rows.size }))
  api.defaults.adapter = async config => {
    calls.push(config.url)
    let data = await hook?.(config)
    if (data === undefined) {
      data = { profile: {}, zones: [] }
      if (config.url === '/strava/status') data = { connected: true }
      if (config.url === '/strava/sync') { rows.add('physical-run'); data = { imported: 1 } }
      if (config.url === '/import/health') {
        let imported = 0, skipped = 0
        for (const w of JSON.parse(config.data).workouts) { if (rows.has(w.id)) skipped++; else { rows.add(w.id); imported++ } }
        data = { imported, skipped, errors: [] }
      }
    }
    return { status: 200, statusText: 'OK', headers: {}, config, data }
  }
  function fixture(overrides = {}) {
    let seq = 0, history = 0, summary = 0; const timers = new Map()
    const service = new HealthService({ apiClient: api, native: () => true, coordinatorOptions: { schedule(fn) { timers.set(++seq, fn); return seq }, cancel(id) { timers.delete(id) } }, bridge: {
      isAvailable: async () => ({ available: true }),
      getSummary: async () => { summary++; return { metricsSchemaVersion: 6 } },
      getWorkoutHistory: async () => { history++; return { workouts: [{ id: 'physical-run' }] } }, ...overrides,
    } })
    return { service, timers, get history() { return history }, get summary() { return summary } }
  }
  for (const stage of ['summary', 'profile']) {
    reset(); const f = fixture(stage === 'summary' ? { getSummary: async () => { throw Error('private synthetic detail') } } : {})
    if (stage === 'profile') hook = async c => { if (c.url === '/health/sync') throw Error('private profile detail') }
    const result = await f.service.syncNativeData()
    assert.equal(rows.size, 1); assert.equal(f.history, 1); assert.equal(result.complete, false)
    assert.equal(result.stages.workouts, 'complete'); assert.equal(result.stages.summary, 'error')
    if (stage === 'summary') assert.equal(result.metrics, null, 'unknown metrics are not fabricated zeros')
    assert.equal(events[0].rows, 1, 'activity publication follows simulated persistence')
    f.service.dispose()
  }
  reset()
  {
    const hang = deferred(); let summaries = 0
    const f = fixture({ getSummary: () => { summaries++; return hang.promise } })
    const first = f.service.syncNativeData(), timeout = assert.rejects(first, { code: 'HEALTH_SYNC_TIMEOUT' })
    await flush(); assert.equal(rows.size, 1); assert.equal(events.length, 1, 'saved activity is published before optional hang settles')
    for (const fn of [...f.timers.values()]) fn(); await timeout
    for (let i = 0; i < 8; i++) { const r = await f.service.syncNativeData(); assert.equal(r.stages.workouts, 'complete'); assert.equal(r.complete, false) }
    assert.equal(summaries, 1); assert.equal(f.service.pendingBridgeCalls.size, 1, 'optional hangs cannot fill both native slots')
    assert.equal(rows.size, 1, 'adapter replay control; backend dedup is tested separately')
    const count = events.length; hang.resolve({ metricsSchemaVersion: 6 }); await flush(); assert.equal(events.length, count, 'late cancelled summary cannot publish')
    f.service.dispose()
  }
  reset()
  {
    let connected = false
    hook = async c => c.url === '/strava/status' ? { connected } : undefined
    const s = session(), opts = { now: () => 1000000 }
    assert.equal((await fg.syncConnectedStrava(api, s, opts)).status, 'disconnected')
    assert.equal(localStorage.getItem(sync.healthAccountKey('forge_auto_strava_sync_last_sync_at', s.accountId)), null)
    connected = true; assert.equal((await fg.syncConnectedStrava(api, s, opts)).status, 'complete')
    const n = calls.length; assert.equal((await fg.syncConnectedStrava(api, s, opts)).status, 'cooldown'); assert.equal(calls.length, n)
    const out = await sync.runHealthAwarePageRefresh({ authenticated: true, native: false, syncConnectedProvider: () => fg.syncConnectedStrava(api, s, { ...opts, force: true }) })
    assert.equal(out.sourceStates.strava, 'complete'); assert.equal(calls.filter(p => p === '/strava/sync').length, 2)
    assert.equal(events.at(-1).source, 'strava'); assert.equal(events.at(-1).rows, 1)
    assert.equal('token' in events.at(-1), false)
  }
  reset()
  {
    const gate = deferred(); hook = async c => { if (c.url === '/strava/sync') { await gate.promise; rows.add('physical-run'); return { imported: 1 } } }
    const all = Array.from({ length: 12 }, () => fg.syncConnectedStrava(api, session(), { force: true }))
    await flush(); assert.equal(calls.filter(p => p === '/strava/sync').length, 1)
    gate.resolve(); await Promise.all(all); assert.equal(events.length, 1)
  }
  reset()
  {
    const gate = deferred(); hook = async c => { if (c.url === '/strava/status') { await gate.promise; return { connected: true } } }
    const old = session(), pending = fg.syncConnectedStrava(api, old, { force: true })
    await flush(); token.clearToken(); login(); gate.resolve(); await pending
    assert.equal(calls.includes('/strava/sync'), false); assert.equal(events.length, 0)
    assert.equal(sync.announceActivityDataChanged('strava', old), false)
    let changes = 0; const remove = sync.subscribeActivityDataChanged(() => changes++)
    sync.announceActivityDataChanged('apple', session()); await flush(); assert.equal(changes, 1)
    remove(); sync.announceActivityDataChanged('apple', session()); await flush(); assert.equal(changes, 1)
  }
  reset()
  {
    hook = async c => { if (c.url === '/strava/sync') throw Error('private offline failure') }
    const s = session(); await assert.rejects(fg.syncConnectedStrava(api, s, { force: true }))
    assert.equal(events.length, 0); assert.equal(localStorage.getItem(sync.healthAccountKey('forge_auto_strava_sync_last_sync_at', s.accountId)), null)
    const out = await sync.runHealthAwarePageRefresh({ authenticated: true, native: true, syncNativeData: async () => { throw Error('private Apple failure') }, syncConnectedProvider: () => fg.syncConnectedStrava(api, s, { force: true }) })
    assert.deepEqual(out.sourceStates, { apple: 'error', strava: 'error' })
    assert.equal(sync.activityRefreshNotice(out).includes('private'), false)
    hook = null; assert.equal((await fg.syncConnectedStrava(api, s, { force: true })).status, 'complete')
  }
  reset()
  {
    const options = [], f = fixture({ getSummary: async () => ({ metricsSchemaVersion: 5 }), getWorkoutHistory: async opt => { options.push(opt); return { workouts: [{ id: 'physical-run' }] } } })
    assert.equal((await f.service.syncNativeData()).stages.workouts, 'complete')
    assert.equal(localStorage.getItem(sync.healthAccountKey('forge_health_workout_import_version', 'owner-a')), null, 'old native schema cannot certify full-fidelity import upgrade')
    await f.service.syncNativeData(); assert.equal(options[0].forceFullSync, true); assert.equal(options[1].forceFullSync, true)
    f.service.dispose()
  }
  reset()
  {
    localStorage.removeItem('forge_health_authorized')
    const f = fixture(); await assert.rejects(f.service.syncNativeData(), /grant access/); assert.equal(f.history, 0)
    const outcome = await sync.runHealthAwarePageRefresh({ authenticated: true, native: true, syncNativeData: o => f.service.syncNativeData(o), syncConnectedProvider: () => fg.syncConnectedStrava(api, session(), { force: true }) })
    assert.deepEqual(outcome.sourceStates, { apple: 'error', strava: 'complete' }); assert.equal(rows.size, 1)
    f.service.dispose()
  }
  reset()
  {
    let reads = 0; const gate = deferred()
    const remove = sync.subscribeActivityDataChanged(async () => { reads++; if (reads === 1) await gate.promise })
    sync.announceActivityDataChanged('apple', session()); await flush()
    for (let i = 0; i < 20; i++) sync.announceActivityDataChanged('strava', session())
    await flush(); assert.equal(reads, 1); gate.resolve(); await flush(); assert.equal(reads, 2, 'burst drains one bounded follow-up')
    token.clearToken(); login(); sync.announceActivityDataChanged('apple', session()); await flush(); assert.equal(reads, 2, 'old mounted subscription cannot cross login generation')
    remove()
  }
  reset()
  {
    const first = deferred(); let posts = 0
    hook = async c => { if (c.url === '/strava/sync') { posts++; if (posts === 1) await first.promise; return { imported: 0 } } }
    const automatic = fg.syncConnectedStrava(api, session()); await flush()
    const pulls = Array.from({ length: 8 }, () => sync.runHealthAwarePageRefresh({ authenticated: true, native: false, syncConnectedProvider: () => fg.syncConnectedStrava(api, session(), { force: true }) }))
    await flush(); assert.equal(posts, 1); first.resolve(); await automatic; await Promise.all(pulls)
    assert.equal(posts, 2, 'concurrent explicit pulls share one post-auto fresh acquisition')
  }
  reset()
  {
    hook = async c => c.url === '/strava/sync' ? {} : undefined
    await assert.rejects(fg.syncConnectedStrava(api, session(), { force: true }), /acknowledgment/)
    assert.equal(events.length, 0); assert.equal(localStorage.getItem(sync.healthAccountKey('forge_auto_strava_sync_last_sync_at', 'owner-a')), null)
  }
  reset()
  {
    const first = deferred(), second = deferred(); let reads = 0, deadline
    const coordinator = sync.createHealthSyncCoordinator(() => ++reads === 1 ? first.promise : second.promise)
    const automatic = coordinator.run()
    await flush()
    const statuses = []
    const pull = sync.runHealthAwarePageRefresh({ authenticated: true, native: true, syncNativeData: o => coordinator.run(o), onSourceSettled: (...state) => statuses.push(state), scheduleDeadline: fn => { deadline = fn; return 1 }, cancelDeadline() {} })
    first.resolve({ complete: true }); await automatic; await flush()
    assert.equal(reads, 2); assert.equal(statuses.length, 0, 'older automatic success cannot complete newer manual status')
    deadline(); assert.equal((await pull).sourceStates.apple, 'pending')
    second.resolve({ complete: true }); await flush(); assert.deepEqual(statuses, [['apple', 'complete']])
  }
  reset()
  {
    const gate = deferred(); let deadline
    const pending = sync.runHealthAwarePageRefresh({ authenticated: true, native: false, syncConnectedProvider: () => fg.syncConnectedStrava(api, session(), { force: true }), scheduleDeadline: fn => { deadline = fn; return 1 }, cancelDeadline() {} })
    hook = async c => { if (c.url === '/strava/sync') { await gate.promise; rows.add('physical-run'); return { imported: 1 } } }
    await flush(); deadline(); const out = await pending
    assert.equal(out.sourceStates.strava, 'pending'); assert.match(sync.activityRefreshNotice(out), /still syncing/)
    assert.equal(out.healthSyncError, null, 'Strava timeout is not labeled an Apple Health error')
    assert.equal(out.refreshError.code, 'ACTIVITY_REFRESH_TIMEOUT')
    gate.resolve(); await flush(); assert.equal(events.at(-1).rows, 1)
  }
  for (const appleAvailable of [false, true]) {
    reset()
    const provider = deferred(), errors = []
    const f = fixture({
      isAvailable: async () => ({ available: appleAvailable }),
      getWorkoutHistory: async () => ({ workouts: [] }),
      addListener: async () => ({ remove() {} }),
    })
    hook = async c => {
      if (c.url === '/strava/sync') { await provider.promise; rows.add('physical-run'); return { imported: 1 } }
    }
    const doc = new EventTarget(); doc.visibilityState = 'visible'
    const lifecycle = fg.mountForegroundHealthSync({
      service: f.service, app: { addListener: async () => ({ remove() {} }) }, documentTarget: doc,
      getAccountId: auth.getAuthenticatedUserId, schedule: () => 1, cancel() {}, onError: error => errors.push(error),
      afterSync: s => fg.syncConnectedStrava(api, s),
    })
    await flush()
    assert.equal(calls.filter(path => path === '/strava/sync').length, 1, 'actual foreground lifecycle starts provider despite Apple failure or empty completion')
    assert.equal(rows.size, 0); assert.equal(events.length, 0, 'Apple outcome cannot publish uncommitted provider data')
    assert.equal(errors.length, appleAvailable ? 0 : 1)
    provider.resolve(); await flush()
    assert.equal(rows.size, 1); assert.equal(events.at(-1).source, 'strava'); assert.equal(events.at(-1).rows, 1)
    lifecycle.dispose(); f.service.dispose()
  }
  const rowError = { index: 0, error: 'Synthetic row failure', code: 'IMPORT_OPERATION_FAILED', retryable: true }
  const malformedAcks = [
    {}, null, [], { imported: 2, skipped: 0 }, { imported: 2, skipped: 0, errors: {} },
    { imported: '2', skipped: 0, errors: [] }, { imported: 1.5, skipped: .5, errors: [] },
    { imported: -1, skipped: 3, errors: [] }, { imported: 3, skipped: 0, errors: [] },
    { imported: 1, skipped: 0, errors: [] }, { imported: null, skipped: 2, errors: [] },
    { imported: 2, skipped: 0, errors: [], unexpected: true },
    ...[null, {}, { ...rowError, index: -1 }, { ...rowError, index: 2 }, { ...rowError, index: '0' },
      { ...rowError, index: .5 }, { ...rowError, error: '' }, { ...rowError, code: null },
      { ...rowError, retryable: false }, { ...rowError, retryable: 'true' },
      { ...rowError, code: 'IMPORT_ROW_INVALID', retryable: true }, { index: 0, error: 'no classification' }]
      .map(error => ({ imported: 1, skipped: 0, errors: [error] })),
    { imported: 0, skipped: 0, errors: [rowError, rowError] },
    { imported: 2, skipped: 0, errors: [rowError] },
  ]
  for (const acknowledgment of malformedAcks) {
    reset()
    const f = fixture({ getWorkoutHistory: async () => ({ workouts: [{ id: 'one' }, { id: 'two' }] }) })
    hook = async c => c.url === '/import/health' ? acknowledgment : undefined
    await assert.rejects(f.service.syncNativeData(), error => {
      assert.equal(error.code, 'HEALTH_IMPORT_ACK_INVALID', JSON.stringify(acknowledgment))
      assert.deepEqual(error.partialImportResult, { imported: 0, skipped: 0, errors: [] })
      return true
    })
    assert.equal(events.length, 0, 'malformed ACK cannot publish activity persistence')
    assert.equal(sync.isHealthHistoryTransferPending('owner-a'), true)
    assert.equal(localStorage.getItem(sync.healthAccountKey('forge_health_workout_import_version', 'owner-a')), null)
    hook = null
    assert.equal((await f.service.syncNativeData()).complete, true, 'valid retry can acknowledge the retained checkpoint')
    f.service.dispose()
  }
  for (const retryable of [true, false]) {
    reset()
    const f = fixture({ getWorkoutHistory: async () => ({ workouts: [{ id: 'one' }, { id: 'two' }] }) })
    hook = async c => c.url === '/import/health' ? { imported: 1, skipped: 0, errors: [{ ...rowError, index: 1, retryable, code: retryable ? 'IMPORT_OPERATION_FAILED' : 'IMPORT_ROW_INVALID' }] } : undefined
    const result = await f.service.syncNativeData()
    assert.equal(result.imported, 1); assert.equal(result.errors.length, 1); assert.equal(events.length, 1)
    assert.equal(result.complete, !retryable, 'valid terminal-invalid rows retain existing completion semantics, operational failures retry')
    assert.equal(sync.isHealthHistoryTransferPending('owner-a'), retryable)
    f.service.dispose()
  }
  reset()
  {
    const f = fixture()
    hook = async c => c.url === '/import/health' ? { imported: 0, skipped: 0, errors: [rowError] } : undefined
    assert.equal((await f.service.syncNativeData()).complete, false)
    assert.equal(events.length, 0, 'a valid all-failed batch acknowledges no persisted rows')
    assert.equal(sync.isHealthHistoryTransferPending('owner-a'), true)
    f.service.dispose()
  }
  reset()
  {
    const { fetchDailyExecution } = await vite.ssrLoadModule('/src/lib/dailyExecution.js')
    const configs = []
    hook = async c => {
      if (c.url.startsWith('/plans/today?')) { configs.push(c.forgeAuthSession); return { today: null, execution: { hasPlan: false, hasDay: false, sessions: [] } } }
    }
    const date = '2026-09-28', identity = session()
    assert.deepEqual(await fetchDailyExecution(date, { forgeAuthSession: identity }), await fetchDailyExecution(date), 'optional request identity does not change coaching normalization')
    assert.deepEqual(configs, [identity, undefined], 'other callers retain the existing unscoped default')
  }
  reset()
  {
    let batch = 0
    const f = fixture({ getWorkoutHistory: async () => ({ workouts: Array.from({ length: 11 }, (_, i) => ({ id: `row-${i}` })) }) })
    hook = async c => c.url === '/import/health' && ++batch === 2 ? {} : undefined
    await assert.rejects(f.service.syncNativeData(), error => {
      assert.equal(error.code, 'HEALTH_IMPORT_ACK_INVALID'); assert.equal(error.partialImportResult.imported, 10)
      return true
    })
    assert.equal(events.length, 1, 'valid earlier batch remains published; malformed later batch does not')
    assert.equal(sync.isHealthHistoryTransferPending('owner-a'), true)
    assert.equal(localStorage.getItem(sync.healthAccountKey('forge_health_workout_import_version', 'owner-a')), null)
    hook = null; assert.equal((await f.service.syncNativeData()).complete, true); assert.equal(rows.size, 11)
    f.service.dispose()
  }
  console.log('ACTIVITY SYNC REFRESH OK: real modules, source independence, post-persistence events, explicit cooldown bypass, coalescing, account generations, late completion and bounded native work; synthetic API/native boundaries')
} finally { await vite.close() }
