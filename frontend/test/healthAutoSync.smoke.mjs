import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  announceHealthSyncResult,
  clearHealthHistoryTransferPending,
  createHealthImportBatches,
  createHealthSyncCoordinator,
  HEALTH_IMPORT_BATCH_SIZE,
  HEALTH_PULL_REFRESH_DEADLINE_MS,
  HEALTH_SYNC_COMPLETED_EVENT,
  HEALTH_SYNC_ORIGIN_PULL_REFRESH,
  HEALTH_SYNC_RESULT_EVENT,
  HealthPullRefreshTimeoutError,
  healthSyncFailureMessage,
  healthSyncNotice,
  importHealthWorkoutBatches,
  isHealthHistoryImportComplete,
  isHealthHistoryTransferPending,
  markHealthHistoryTransferPending,
  retryableHealthSyncErrors,
  runHealthAwarePageRefresh,
  shouldRefreshPageForHealthSyncEvent,
} from '../src/lib/healthSync.js'
import {
  createPullToRefreshEndHandler,
  measurePullRefreshGesture,
  PULL_REFRESH_THRESHOLD_PX,
  readPullRefreshScrollTop,
} from '../src/lib/pullToRefresh.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
const app = read('frontend/src/App.jsx')
const layout = read('frontend/src/components/Layout.jsx')
const service = read('frontend/src/services/HealthService.js')
const pullToRefresh = read('frontend/src/components/PullToRefresh.jsx')
const healthSyncSource = read('frontend/src/lib/healthSync.js')
const dashboardSource = read('frontend/src/pages/Dashboard.jsx')
const insightsSheetSource = read('frontend/src/components/InsightsSheet.jsx')
const healthSourceManager = read('frontend/src/components/HealthSourceManager.jsx')

class MemoryStorage {
  constructor() { this.values = new Map() }
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null }
  setItem(key, value) { this.values.set(key, String(value)) }
  removeItem(key) { this.values.delete(key) }
}

if (typeof globalThis.CustomEvent !== 'function') {
  globalThis.CustomEvent = class CustomEvent extends Event {
    constructor(type, options = {}) {
      super(type)
      this.detail = options.detail
    }
  }
}
globalThis.localStorage = new MemoryStorage()
globalThis.window = new EventTarget()

function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, reject, resolve }
}

function manualDeadline() {
  let callback = null
  let cancelled = 0
  let scheduledDelay = null
  const token = { kind: 'manual-deadline' }
  return {
    cancel(receivedToken) {
      assert.equal(receivedToken, token)
      cancelled += 1
      callback = null
    },
    expire() {
      const scheduled = callback
      callback = null
      scheduled?.()
    },
    get cancelled() { return cancelled },
    get scheduledDelay() { return scheduledDelay },
    schedule(nextCallback, delay) {
      callback = nextCallback
      scheduledDelay = delay
      return token
    },
  }
}

const workouts = Array.from({ length: HEALTH_IMPORT_BATCH_SIZE * 2 + 3 }, (_, index) => ({ id: index }))

{
  const verticalPull = measurePullRefreshGesture({
    startX: 100,
    startY: 20,
    currentX: 104,
    currentY: 20 + PULL_REFRESH_THRESHOLD_PX,
    atTop: true,
  })
  assert.equal(verticalPull.pulling, true, 'a deliberate vertical pull at the page top is recognized')
  assert.equal(verticalPull.distance, PULL_REFRESH_THRESHOLD_PX, 'the raw trigger distance remains available to touchend')

  const horizontalSwipe = measurePullRefreshGesture({
    startX: 5,
    startY: 20,
    currentX: 80,
    currentY: 35,
    atTop: true,
  })
  assert.equal(horizontalSwipe.cancelled, true, 'horizontal navigation cancels pull-to-refresh')

  const scrolledPull = measurePullRefreshGesture({
    startX: 100,
    startY: 20,
    currentX: 100,
    currentY: 120,
    atTop: false,
  })
  assert.equal(scrolledPull.cancelled, true, 'pull-to-refresh cannot trigger away from the top')
  assert.equal(readPullRefreshScrollTop({ scrollingElement: { scrollTop: 0.5 } }, { scrollY: 30 }), 0.5, 'the document scroll root wins over window fallback')
  assert.equal(readPullRefreshScrollTop({}, { scrollY: 12 }), 12, 'window scroll position remains a safe fallback')
}
const batches = createHealthImportBatches(workouts)
assert.deepEqual(batches.map((batch) => batch.length), [10, 10, 3], 'large health imports split into bounded batches')
assert.deepEqual(batches.flat(), workouts, 'batching preserves every workout and its order')
assert.throws(() => createHealthImportBatches(workouts, 0), /positive integer/, 'invalid batch size fails loudly')

const timeoutCopy = healthSyncFailureMessage({ code: 'ECONNABORTED', message: 'timeout of 15000ms exceeded' })
assert.match(timeoutCopy, /taking longer than expected/, 'raw Axios timeout is replaced with user-facing catch-up copy')
assert.ok(!timeoutCopy.includes('15000ms'), 'timeout copy does not expose an implementation detail')

{
  const gate = deferred()
  let executions = 0
  const coordinator = createHealthSyncCoordinator(async () => {
    executions += 1
    await gate.promise
    return { complete: true }
  })
  const first = coordinator.run()
  const second = coordinator.run()
  await Promise.resolve()
  assert.equal(executions, 1, 'ordinary concurrent callers share one native sync')
  gate.resolve()
  assert.deepEqual(await Promise.all([first, second]), [{ complete: true }, { complete: true }])
  assert.equal(coordinator.hasActiveOperation(), false, 'coordinator releases a completed operation')
}

{
  const autoGate = deferred()
  const calls = []
  const coordinator = createHealthSyncCoordinator(async ({ requestPermission }) => {
    calls.push(requestPermission)
    if (!requestPermission) {
      await autoGate.promise
      return { authorizationUpgradeRequired: true }
    }
    return { authorizationUpgradeRequired: false, upgraded: true }
  })
  const automatic = coordinator.run()
  await Promise.resolve()
  const permissionOne = coordinator.run({ requestPermission: true })
  const permissionTwo = coordinator.run({ requestPermission: true })
  autoGate.resolve()
  const results = await Promise.all([automatic, permissionOne, permissionTwo])
  assert.deepEqual(calls, [false, true], 'two permission waiters trigger exactly one upgrade after automatic sync')
  assert.equal(results[1].upgraded, true)
  assert.equal(results[2].upgraded, true)
}

{
  const automaticGate = deferred()
  const manualGate = deferred()
  const calls = []
  const coordinator = createHealthSyncCoordinator(async (options) => {
    calls.push(options)
    if (calls.length === 1) {
      await automaticGate.promise
      return { complete: true, source: 'automatic' }
    }
    await manualGate.promise
    return { complete: true, source: 'manual' }
  })
  const automatic = coordinator.run()
  await Promise.resolve()
  const manualOne = coordinator.run({
    forceFresh: true,
    syncOrigin: HEALTH_SYNC_ORIGIN_PULL_REFRESH,
  })
  const manualTwo = coordinator.run({
    forceFresh: true,
    syncOrigin: HEALTH_SYNC_ORIGIN_PULL_REFRESH,
  })
  assert.equal(calls.length, 1, 'manual callers do not start alongside an active automatic sync')
  automaticGate.resolve()
  await automatic
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls.length, 2, 'manual callers queue one fresh sync after an active automatic sync')
  assert.equal(calls[1].forceFresh, true, 'the queued sync retains manual freshness semantics')
  assert.equal(calls[1].syncOrigin, HEALTH_SYNC_ORIGIN_PULL_REFRESH, 'the queued sync retains pull-refresh provenance')
  manualGate.resolve()
  const manualResults = await Promise.all([manualOne, manualTwo])
  assert.deepEqual(manualResults.map((result) => result.source), ['manual', 'manual'])
  assert.equal(calls.length, 2, 'concurrent manual callers share the same fresh sync')
}

{
  const syncGate = deferred()
  const deadline = manualDeadline()
  const calls = []
  const events = []
  const serverRows = []
  let visibleRows = []
  let pageRefreshes = 0
  const refreshCurrentPage = (source) => {
    pageRefreshes += 1
    visibleRows = [...serverRows]
    events.push(`page-refreshed:${source}`)
  }
  const handleHealthSyncResult = (event) => {
    if (shouldRefreshPageForHealthSyncEvent(event)) refreshCurrentPage('health-event')
  }
  window.addEventListener(HEALTH_SYNC_RESULT_EVENT, handleHealthSyncResult)
  const refresh = runHealthAwarePageRefresh({
    authenticated: true,
    native: true,
    syncNativeData: async (options) => {
      calls.push(options)
      events.push('health-started')
      const result = await syncGate.promise
      serverRows.push({ id: 'under-deadline-health-workout' })
      events.push('health-settled')
      announceHealthSyncResult(result, {
        complete: true,
        origin: HEALTH_SYNC_ORIGIN_PULL_REFRESH,
      })
      return result
    },
    afterHealthSync: () => {
      events.push('post-sync')
    },
    refreshPage: () => refreshCurrentPage('pull'),
    scheduleDeadline: deadline.schedule,
    cancelDeadline: deadline.cancel,
  })
  await Promise.resolve()
  assert.deepEqual(calls, [{
    forceFresh: true,
    syncOrigin: HEALTH_SYNC_ORIGIN_PULL_REFRESH,
  }], 'authenticated native pull refresh requests exactly one forced HealthKit sync with pull provenance')
  assert.deepEqual(events, ['health-started'], 'page refresh waits while the HealthKit sync is unsettled')
  assert.equal(
    shouldRefreshPageForHealthSyncEvent({ detail: { origin: null } }),
    false,
    'an automatic sync event settling while a pull waits cannot trigger an intermediate page fetch',
  )
  syncGate.resolve({ complete: true })
  const outcome = await refresh
  window.removeEventListener(HEALTH_SYNC_RESULT_EVENT, handleHealthSyncResult)
  assert.deepEqual(events, ['health-started', 'health-settled', 'post-sync', 'page-refreshed:pull'], 'under-deadline pull success uses its coordinated page refresh exactly once')
  assert.deepEqual(visibleRows, serverRows, 'under-deadline pull success refreshes the current Dashboard data')
  assert.equal(pageRefreshes, 1, 'under-deadline pull success performs one current-page refresh')
  assert.equal(outcome.healthSyncAttempted, true)
  assert.equal(outcome.healthSyncResult.complete, true)
  assert.equal(outcome.healthSyncError, null)
  assert.equal(deadline.scheduledDelay, HEALTH_PULL_REFRESH_DEADLINE_MS, 'ordinary pull sync uses the exported gesture deadline')
  assert.equal(deadline.cancelled, 1, 'ordinary settlement synchronously cancels its deadline')
  assert.equal(
    shouldRefreshPageForHealthSyncEvent({ detail: { origin: null } }),
    true,
    'ordinary automatic events resume page refresh behavior after the pull settles',
  )
}

{
  const syncGate = deferred()
  const events = []
  const refresh = runHealthAwarePageRefresh({
    authenticated: true,
    native: true,
    syncNativeData: () => syncGate.promise,
    onHealthSyncError: (error) => events.push(`health-failed:${error.message}`),
    refreshPage: () => events.push('page-refreshed'),
  })
  await Promise.resolve()
  assert.deepEqual(events, [], 'handled sync failure does not refresh before the failure settles')
  syncGate.reject(new Error('server unavailable'))
  const outcome = await refresh
  assert.deepEqual(events, ['health-failed:server unavailable', 'page-refreshed'])
  assert.equal(outcome.healthSyncAttempted, true)
  assert.equal(outcome.healthSyncResult, null)
  assert.match(outcome.healthSyncError.message, /server unavailable/)
  assert.equal(
    shouldRefreshPageForHealthSyncEvent({ detail: { origin: null } }),
    true,
    'a failed pull releases automatic Health event refreshes',
  )
}

{
  const syncGate = deferred()
  const deadline = manualDeadline()
  const events = []
  const serverRows = []
  let visibleRows = []
  let healthCalls = 0
  let pageRefreshes = 0
  const refreshCurrentPage = (source) => {
    pageRefreshes += 1
    visibleRows = [...serverRows]
    events.push(`page-refreshed:${source}:${visibleRows.length}`)
  }
  const handleHealthSyncResult = (event) => {
    if (shouldRefreshPageForHealthSyncEvent(event)) refreshCurrentPage('late-health-event')
  }
  window.addEventListener(HEALTH_SYNC_RESULT_EVENT, handleHealthSyncResult)
  const refresh = runHealthAwarePageRefresh({
    authenticated: true,
    native: true,
    syncNativeData: async () => {
      healthCalls += 1
      await syncGate.promise
      serverRows.push({ id: 'just-finished-health-workout' })
      const result = { complete: true, scanned: 1, imported: 1, errors: [] }
      announceHealthSyncResult(result, {
        complete: true,
        origin: HEALTH_SYNC_ORIGIN_PULL_REFRESH,
      })
      return result
    },
    onHealthSyncError: (error) => events.push(`health-failed:${error.message}`),
    afterHealthSync: () => events.push('post-sync'),
    refreshPage: () => refreshCurrentPage('deadline'),
    scheduleDeadline: deadline.schedule,
    cancelDeadline: deadline.cancel,
  })
  await Promise.resolve()
  assert.deepEqual(serverRows, [], 'the authenticated native pull begins before the new workout exists on the server')
  assert.deepEqual(visibleRows, [], 'the current page begins without the new workout')
  deadline.expire()
  const outcome = await refresh
  assert.equal(outcome.healthSyncResult, null, 'deadline never fabricates a successful Health sync result')
  assert.ok(outcome.healthSyncError instanceof HealthPullRefreshTimeoutError, 'unresolved native promise settles with the named gesture timeout')
  assert.deepEqual(events, [`health-failed:${outcome.healthSyncError.message}`, 'post-sync', 'page-refreshed:deadline:0'], 'deadline reports one Health failure, releases the gesture, and performs one ordinary stale page refresh')
  assert.equal(healthCalls, 1, 'the deadline leaves the real native sync alive without starting a replacement')
  syncGate.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  window.removeEventListener(HEALTH_SYNC_RESULT_EVENT, handleHealthSyncResult)
  assert.deepEqual(serverRows, [{ id: 'just-finished-health-workout' }], 'the late native sync still imports the completed workout')
  assert.deepEqual(visibleRows, serverRows, 'the late pull-origin success refresh makes the imported workout visible')
  assert.equal(pageRefreshes, 2, 'late success performs exactly one additional current-page refresh')
  assert.equal(healthCalls, 1, 'the late event refresh never re-runs HealthKit or creates a sync loop')
  assert.equal(events.filter((event) => event.startsWith('health-failed:')).length, 1, 'late native success cannot duplicate the error callback')
}

{
  const syncGate = deferred()
  const deadline = manualDeadline()
  const events = []
  const refresh = runHealthAwarePageRefresh({
    authenticated: true,
    native: true,
    syncNativeData: () => syncGate.promise,
    onHealthSyncError: () => events.push('health-failed'),
    refreshPage: () => events.push('page-refreshed'),
    scheduleDeadline: deadline.schedule,
    cancelDeadline: deadline.cancel,
  })
  await Promise.resolve()
  deadline.expire()
  await refresh
  syncGate.reject(new Error('late native rejection'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['health-failed', 'page-refreshed'], 'late native rejection stays observed without duplicate callbacks')
}

{
  let healthCalls = 0
  let refreshCalls = 0
  const syncNativeData = () => {
    healthCalls += 1
  }
  const refreshPage = () => {
    refreshCalls += 1
  }
  const webOutcome = await runHealthAwarePageRefresh({
    authenticated: true,
    native: false,
    syncNativeData,
    refreshPage,
  })
  const loggedOutOutcome = await runHealthAwarePageRefresh({
    authenticated: false,
    native: true,
    syncNativeData,
    refreshPage,
  })
  assert.equal(healthCalls, 0, 'web and logged-out pull refreshes never invoke HealthKit')
  assert.equal(refreshCalls, 2, 'web and logged-out pulls still refresh page data')
  assert.equal(webOutcome.healthSyncAttempted, false)
  assert.equal(loggedOutOutcome.healthSyncAttempted, false)
}

{
  const syncGate = deferred()
  const deadline = manualDeadline()
  const refreshInFlight = { current: false }
  let coordinatorCalls = 0
  let reloadCalls = 0
  let gestureResets = 0
  const onTouchEnd = createPullToRefreshEndHandler({
    refreshInFlight,
    shouldRefresh: () => true,
    onRefreshStart: () => {},
    runPageRefresh: () => {
      coordinatorCalls += 1
      return runHealthAwarePageRefresh({
        authenticated: true,
        native: true,
        syncNativeData: () => syncGate.promise,
        refreshPage: () => {
          reloadCalls += 1
        },
        scheduleDeadline: deadline.schedule,
        cancelDeadline: deadline.cancel,
      })
    },
    onRefreshFailure: () => {},
    resetGesture: () => {
      gestureResets += 1
    },
  })

  const firstTouchEnd = onTouchEnd()
  await Promise.resolve()
  const secondTouchEnd = onTouchEnd()
  assert.equal(await secondTouchEnd, false, 'a second touchend is ignored while the first page refresh is unsettled')
  assert.equal(coordinatorCalls, 1, 'duplicate touchend events launch exactly one page-refresh coordinator call')
  assert.equal(refreshInFlight.current, true, 'the gesture guard remains raised during the active refresh')
  deadline.expire()
  assert.equal(await firstTouchEnd, true)
  assert.equal(reloadCalls, 1, 'the timed-out guarded refresh invokes the reload path exactly once')
  assert.equal(refreshInFlight.current, false, 'a timed-out in-place refresh releases the gesture guard')
  assert.equal(gestureResets, 2, 'every touchend still cleans up its gesture state')
  syncGate.resolve({ complete: true })
}

{
  const syncGate = deferred()
  const refreshInFlight = { current: false }
  let coordinatorCalls = 0
  let refreshCalls = 0
  const onTouchEnd = createPullToRefreshEndHandler({
    refreshInFlight,
    shouldRefresh: () => true,
    onRefreshStart: () => {},
    runPageRefresh: () => {
      coordinatorCalls += 1
      return runHealthAwarePageRefresh({
        authenticated: true,
        native: true,
        syncNativeData: () => syncGate.promise,
        refreshPage: () => {
          refreshCalls += 1
        },
      })
    },
    onRefreshFailure: () => {},
    resetGesture: () => {},
  })

  const firstTouchEnd = onTouchEnd()
  const secondTouchEnd = onTouchEnd()
  assert.equal(await secondTouchEnd, false, 'a duplicate touchend cannot start a second long-running refresh')
  assert.equal(coordinatorCalls, 1, 'the synchronous gesture latch guards the full HealthKit operation')
  assert.equal(refreshCalls, 0, 'a long-running HealthKit operation cannot expose stale page data')
  assert.equal(refreshInFlight.current, true, 'the gesture guard remains raised until HealthKit settles')
  syncGate.resolve({ complete: true })
  assert.equal(await firstTouchEnd, true)
  assert.equal(refreshCalls, 1, 'HealthKit settlement invokes one current-screen refresh')
  assert.equal(refreshInFlight.current, false, 'the settled operation releases the gesture guard')
}

{
  const refreshInFlight = { current: false }
  let refreshCalls = 0
  let gestureResets = 0
  const onTouchEnd = createPullToRefreshEndHandler({
    refreshInFlight,
    shouldRefresh: () => true,
    onRefreshStart: () => {},
    runPageRefresh: async () => { refreshCalls += 1 },
    onRefreshFailure: () => {},
    resetGesture: () => { gestureResets += 1 },
  })

  assert.equal(await onTouchEnd({ touches: [{}] }), false, 'lifting one finger from a multi-touch gesture never refreshes')
  assert.equal(refreshCalls, 0)
  assert.equal(gestureResets, 1, 'multi-touch cancellation clears the stale gesture')
}

{
  const refreshInFlight = { current: false }
  let coordinatorCalls = 0
  let failureCalls = 0
  const onTouchEnd = createPullToRefreshEndHandler({
    refreshInFlight,
    shouldRefresh: () => true,
    onRefreshStart: () => {},
    runPageRefresh: () => {
      coordinatorCalls += 1
      return runHealthAwarePageRefresh({
        refreshPage: () => {
          if (coordinatorCalls === 1) throw new Error('reload unavailable')
        },
      })
    },
    onRefreshFailure: () => {
      failureCalls += 1
    },
    resetGesture: () => {},
  })

  assert.equal(await onTouchEnd(), false, 'a failed reload path does not leave the refresh active')
  assert.equal(refreshInFlight.current, false, 'a failed reload path safely lowers the gesture guard')
  assert.equal(failureCalls, 1, 'a failed reload path reports the failure once')
  assert.equal(await onTouchEnd(), true, 'the gesture can retry after a failed reload path')
  assert.equal(coordinatorCalls, 2, 'failure recovery permits one later page-refresh coordinator call')
}

{
  let calls = 0
  await assert.rejects(
    importHealthWorkoutBatches(workouts, async (batch) => {
      calls += 1
      if (calls === 1) return { imported: batch.length, skipped: 0, errors: [] }
      const error = new Error('timeout of 30000ms exceeded')
      error.code = 'ECONNABORTED'
      throw error
    }),
    (error) => {
      assert.equal(error.partialImportResult.imported, 10, 'completed batches remain represented after a later timeout')
      return true
    }
  )
  assert.equal(calls, 2, 'batching stops at the timed-out request')
}

{
  const partial = await importHealthWorkoutBatches([{ id: 1 }, { id: 2 }], async () => ({
    imported: 1,
    skipped: 0,
    errors: [{ index: 1, error: 'database unavailable', retryable: true }],
  }))
  assert.equal(partial.imported, 1)
  assert.equal(retryableHealthSyncErrors(partial.errors).length, 1, 'HTTP-200 row errors remain unresolved')
  assert.equal(isHealthHistoryImportComplete({ historyAvailable: true, errors: partial.errors }), false, 'retryable row errors prevent history completion')
  assert.equal(isHealthHistoryImportComplete({ historyAvailable: true, errors: [{ retryable: false }] }), true, 'terminal malformed rows do not trap the full-history retry loop')
}

markHealthHistoryTransferPending()
assert.equal(isHealthHistoryTransferPending(), true, 'a pending transfer survives in durable storage for the next process')
const restartedCoordinator = createHealthSyncCoordinator(async () => ({ forceFullSync: isHealthHistoryTransferPending() }))
assert.equal((await restartedCoordinator.run()).forceFullSync, true, 'a restarted sync observes the pending transfer marker')
clearHealthHistoryTransferPending()
assert.equal(isHealthHistoryTransferPending(), false)

let resultEvents = 0
let completionEvents = 0
let lastResultEvent = null
window.addEventListener(HEALTH_SYNC_RESULT_EVENT, (event) => {
  resultEvents += 1
  lastResultEvent = event
})
window.addEventListener(HEALTH_SYNC_COMPLETED_EVENT, () => { completionEvents += 1 })
const partialSummary = announceHealthSyncResult({ scanned: 2, imported: 1, errors: [{ retryable: true }] }, { complete: false })
assert.equal(partialSummary.status, 'partial')
assert.equal(resultEvents, 1, 'partial sync announces an explicit result')
assert.equal(completionEvents, 0, 'partial sync does not emit a completion-success event')
assert.match(healthSyncNotice(partialSummary), /1 unresolved/)
announceHealthSyncResult({ scanned: 2, imported: 2, errors: [] }, { complete: true })
assert.equal(resultEvents, 2)
assert.equal(completionEvents, 1, 'one complete sync emits exactly one completion-success event')
announceHealthSyncResult(
  { scanned: 1, imported: 1, errors: [] },
  { complete: true, origin: HEALTH_SYNC_ORIGIN_PULL_REFRESH },
)
assert.equal(resultEvents, 3)
assert.equal(lastResultEvent.detail.origin, HEALTH_SYNC_ORIGIN_PULL_REFRESH, 'pull provenance reaches Health result listeners')
assert.equal(shouldRefreshPageForHealthSyncEvent(lastResultEvent), true, 'a pull-origin result may refresh mounted data after its gesture coordinator releases')
assert.equal(shouldRefreshPageForHealthSyncEvent({ detail: { origin: null } }), true, 'automatic Health events still refresh mounted data')

assert.ok(app.includes('sync({ force: true, bypassInterval: true })'), 'cold native launch bypasses the persisted sync throttle once')
assert.ok(service.indexOf('markHealthHistoryTransferPending()') < service.indexOf('this.getWorkoutHistory(historyOptions)'), 'durable transfer marker is written before native history advances')
assert.ok(service.includes("api.post('/import/health', { workouts: batch }, { timeout: HEALTH_IMPORT_TIMEOUT_MS })"), 'each workout batch has a dedicated timeout')
assert.ok(service.includes('createHealthSyncCoordinator'), 'native calls use the behavioral single-flight coordinator')
assert.ok(service.includes('announceHealthSyncResult(syncResult, { complete, origin: syncOrigin })'), 'sync result distinguishes complete from partial and preserves refresh provenance')
assert.ok(service.includes('this.lastNativeSync = { result: syncResult, completedAt: Date.now() }'), 'the completed native result is cached for the keyed Dashboard remount')
assert.ok(service.includes('hasNativeSyncInFlight()'), 'Dashboard can join a cold-launch native sync instead of starting a parallel HealthKit read')
assert.ok(pullToRefresh.includes('await runHealthAwarePageRefresh({'), 'pull-to-refresh delegates sync and reload ordering to the tested coordinator')
assert.ok(pullToRefresh.includes('syncNativeData: (options) => HealthService.syncNativeData(options)'), 'pull-to-refresh forwards forced manual sync options to HealthService')
assert.ok(pullToRefresh.includes("console.error('[PullToRefresh] Apple Health sync failed:'"), 'pull sync failures retain diagnostic context')
assert.ok(healthSyncSource.includes("console.warn('[healthSync] refresh error reporter failed:'"), 'refresh error reporter failures retain diagnostic context')
assert.ok(pullToRefresh.includes('createPullToRefreshEndHandler({'), 'pull-to-refresh uses the executable gesture guard')
assert.ok(pullToRefresh.includes("window.addEventListener('touchstart'"), 'pull-to-refresh starts above the sticky header on every primary tab')
assert.ok(pullToRefresh.includes("window.addEventListener('touchcancel'"), 'cancelled iOS gestures cannot leave stale pull state')
assert.ok(!pullToRefresh.includes('}, [pulling, pullDistance])'), 'gesture listeners are stable throughout a pull')
assert.ok(pullToRefresh.includes("'form'") && pullToRefresh.includes("'[role=\"dialog\"]'"), 'forms and dialogs are excluded from destructive pull gestures')
assert.ok(pullToRefresh.includes('event.touches.length !== 1') && pullToRefresh.includes('resetGesture()'), 'multi-touch transitions cancel the stored pull gesture')
assert.ok(pullToRefresh.includes("'Syncing Apple Health'"), 'native refresh exposes clear HealthKit progress')
assert.ok(pullToRefresh.includes('refreshPage: () => onRefreshCompleteRef.current?.()'), 'pull refresh remounts current data without a duplicate cold-launch HealthKit sync')
assert.ok(!pullToRefresh.includes('window.location.reload()'), 'pull refresh does not hard-reload the native shell')
assert.ok(healthSyncSource.includes('HEALTH_PULL_REFRESH_DEADLINE_MS'), 'pull refresh owns one named gesture deadline')
assert.ok(healthSyncSource.includes('HealthPullRefreshTimeoutError'), 'pull refresh uses a distinguishable timeout error')
assert.ok(!/\bhealthSync(?:Notice|FailureMessage)\b/.test(pullToRefresh), 'pull refresh neither imports nor invokes diagnostic Health result copy')
assert.ok(!pullToRefresh.includes('refreshNotice'), 'pull refresh has no completed-result notice state')
assert.ok(!pullToRefresh.includes('showTemporaryNotice'), 'pull refresh has no post-refresh notice helper')
assert.ok(!pullToRefresh.includes('noticeTimerRef') && !pullToRefresh.includes('5000'), 'pull refresh has no five-second post-refresh timer')
assert.ok(pullToRefresh.includes('{(showIndicator || refreshing) && ('), 'the fixed pull indicator renders only while actively pulling or refreshing')
assert.ok(!pullToRefresh.includes('App refreshed.') && !pullToRefresh.includes('Could not refresh this page.'), 'ordinary and failed pulls leave no completed-result banner copy')
assert.ok(dashboardSource.includes('shouldRefreshPageForHealthSyncEvent(event)'), 'Dashboard suppresses its duplicate fetch burst for pull-origin Health events')
assert.ok(dashboardSource.includes('HealthService.getRecentNativeSyncResult()'), 'Dashboard reuses the pull sync result instead of reading HealthKit again after remount')
assert.ok(dashboardSource.includes('HealthService.hasNativeSyncInFlight()'), 'Dashboard joins an active automatic sync instead of duplicating it')
assert.ok(healthSourceManager.includes('shouldRefreshPageForHealthSyncEvent(event)'), 'connected sources suppress duplicate pull-origin fetches')
assert.ok(healthSourceManager.includes('setNotice(healthSyncNotice(result))'), 'explicit Apple Health sync retains successful diagnostic counts')
assert.ok(healthSourceManager.includes('setNotice(healthSyncFailureMessage(err))'), 'explicit Apple Health sync retains failure diagnostics')
assert.ok(dashboardSource.includes("api.get('/runs', { params: { limit: 5 } })") && dashboardSource.includes("api.get('/lifts')") && dashboardSource.includes("api.get('/workouts')"), 'Dashboard refreshes runs, legacy lifts, and completed workout sessions that feed Recent Activity')
assert.ok(dashboardSource.includes("console.error('[Dashboard] completed workout fetch failed:'"), 'completed workout fetch failures remain contextual and fail soft')
assert.ok(insightsSheetSource.includes("item._type === 'workout'") && insightsSheetSource.includes("/history?workoutId=${item.id}"), 'Recent Activity renders completed workout sessions and links them to History detail')
assert.ok(dashboardSource.includes('<RecentActivityCard recentActivity={recentActivity}'), 'Recent Activity remains the visible Dashboard result of ordinary and late successful imports')
assert.ok(layout.includes('<PullToRefresh onRefreshComplete={refreshAppShell}>'), 'the shared app shell owns the refresh completion')
assert.ok(layout.includes('<main key={appRefreshKey}'), 'the active screen remounts after HealthKit settles')
assert.ok(layout.includes('refreshKey={`${location.key}:${appRefreshKey}`}'), 'header readiness refreshes with the active screen')
assert.ok(layout.includes("/^\\/workout\\/active(?:\\/|$)/"), 'only an active workout is immersive; workout summaries retain pull-to-refresh')

console.log('HEALTH AUTO-SYNC SMOKE OK')
