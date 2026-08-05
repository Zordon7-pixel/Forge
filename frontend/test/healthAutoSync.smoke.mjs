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
  HEALTH_SYNC_COMPLETED_EVENT,
  HEALTH_SYNC_ORIGIN_PULL_REFRESH,
  HEALTH_SYNC_RESULT_EVENT,
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
  const calls = []
  const events = []
  const refresh = runHealthAwarePageRefresh({
    authenticated: true,
    native: true,
    syncNativeData: async (options) => {
      calls.push(options)
      events.push('health-started')
      const result = await syncGate.promise
      events.push('health-settled')
      return result
    },
    afterHealthSync: () => {
      events.push('post-sync')
    },
    refreshPage: () => {
      events.push('page-refreshed')
    },
  })
  await Promise.resolve()
  assert.deepEqual(calls, [{
    forceFresh: true,
    syncOrigin: HEALTH_SYNC_ORIGIN_PULL_REFRESH,
  }], 'authenticated native pull refresh requests exactly one forced HealthKit sync with pull provenance')
  assert.deepEqual(events, ['health-started'], 'page refresh waits while the HealthKit sync is unsettled')
  syncGate.resolve({ complete: true })
  const outcome = await refresh
  assert.deepEqual(events, ['health-started', 'health-settled', 'post-sync', 'page-refreshed'])
  assert.equal(outcome.healthSyncAttempted, true)
  assert.equal(outcome.healthSyncResult.complete, true)
  assert.equal(outcome.healthSyncError, null)
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
}

{
  const syncGate = deferred()
  const events = []
  let settled = false
  const refresh = runHealthAwarePageRefresh({
    authenticated: true,
    native: true,
    syncNativeData: () => syncGate.promise,
    onHealthSyncError: (error) => events.push(`health-failed:${error.message}`),
    afterHealthSync: () => events.push('post-sync'),
    refreshPage: () => events.push('page-refreshed'),
  })
  refresh.finally(() => { settled = true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(settled, false, 'a long-running valid HealthKit import is not abandoned for a stale page refresh')
  assert.deepEqual(events, [], 'post-sync work remains blocked until HealthKit actually settles')
  syncGate.resolve({ complete: true })
  await refresh
  assert.equal(settled, true)
  assert.deepEqual(events, ['post-sync', 'page-refreshed'], 'HealthKit settlement is followed by exactly one current-screen refresh')
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
  syncGate.resolve({ complete: true })
  assert.equal(await firstTouchEnd, true)
  assert.equal(reloadCalls, 1, 'the guarded refresh invokes the reload path exactly once')
  assert.equal(refreshInFlight.current, false, 'a successful in-place refresh releases the gesture guard')
  assert.equal(gestureResets, 2, 'every touchend still cleans up its gesture state')
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
assert.equal(shouldRefreshPageForHealthSyncEvent(lastResultEvent), false, 'pull-origin events defer network reloads to the shared app remount')
assert.equal(shouldRefreshPageForHealthSyncEvent({ detail: { origin: null } }), true, 'automatic Health events still refresh mounted data')

assert.ok(app.includes('sync({ force: true, bypassInterval: true })'), 'cold native launch bypasses the persisted sync throttle once')
assert.ok(service.indexOf('markHealthHistoryTransferPending()') < service.indexOf('this.getWorkoutHistory(historyOptions)'), 'durable transfer marker is written before native history advances')
assert.ok(service.includes("api.post('/import/health', { workouts: batch }, { timeout: HEALTH_IMPORT_TIMEOUT_MS })"), 'each workout batch has a dedicated timeout')
assert.ok(service.includes('createHealthSyncCoordinator'), 'native calls use the behavioral single-flight coordinator')
assert.ok(service.includes('announceHealthSyncResult(syncResult, { complete, origin: syncOrigin })'), 'sync result distinguishes complete from partial and preserves refresh provenance')
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
assert.ok(!healthSyncSource.includes('Promise.race([healthSyncPromise'), 'pull refresh waits for the actual HealthKit import instead of exposing stale data at a UI deadline')
assert.ok(dashboardSource.includes('shouldRefreshPageForHealthSyncEvent(event)'), 'Dashboard suppresses its duplicate fetch burst for pull-origin Health events')
assert.ok(healthSourceManager.includes('shouldRefreshPageForHealthSyncEvent(event)'), 'connected sources suppress duplicate pull-origin fetches')
assert.ok(layout.includes('<PullToRefresh onRefreshComplete={refreshAppShell}>'), 'the shared app shell owns the refresh completion')
assert.ok(layout.includes('<main key={appRefreshKey}'), 'the active screen remounts after HealthKit settles')
assert.ok(layout.includes('refreshKey={`${location.key}:${appRefreshKey}`}'), 'header readiness refreshes with the active screen')
assert.ok(layout.includes("/^\\/workout\\/active(?:\\/|$)/"), 'only an active workout is immersive; workout summaries retain pull-to-refresh')

console.log('HEALTH AUTO-SYNC SMOKE OK')
