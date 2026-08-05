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
  HEALTH_PULL_REFRESH_TIMEOUT_MS,
  HEALTH_SYNC_COMPLETED_EVENT,
  HEALTH_SYNC_RESULT_EVENT,
  HealthSyncTimeoutError,
  healthSyncFailureMessage,
  healthSyncNotice,
  importHealthWorkoutBatches,
  isHealthHistoryImportComplete,
  isHealthHistoryTransferPending,
  markHealthHistoryTransferPending,
  retryableHealthSyncErrors,
  runHealthAwarePageRefresh,
} from '../src/lib/healthSync.js'
import { createPullToRefreshEndHandler } from '../src/lib/pullToRefresh.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
const app = read('frontend/src/App.jsx')
const service = read('frontend/src/services/HealthService.js')
const pullToRefresh = read('frontend/src/components/PullToRefresh.jsx')

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
  const manualOne = coordinator.run({ forceFresh: true })
  const manualTwo = coordinator.run({ forceFresh: true })
  assert.equal(calls.length, 1, 'manual callers do not start alongside an active automatic sync')
  automaticGate.resolve()
  await automatic
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(calls.length, 2, 'manual callers queue one fresh sync after an active automatic sync')
  assert.equal(calls[1].forceFresh, true, 'the queued sync retains manual freshness semantics')
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
  assert.deepEqual(calls, [{ forceFresh: true }], 'authenticated native pull refresh requests exactly one forced HealthKit sync')
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
  const calls = []
  let cancelCalls = 0
  let scheduledTimeoutMs = null
  const refresh = runHealthAwarePageRefresh({
    authenticated: true,
    native: true,
    syncNativeData: (options) => {
      calls.push(options)
      return syncGate.promise
    },
    onHealthSyncError: (error) => events.push(`health-failed:${error.message}`),
    afterHealthSync: () => events.push('post-sync'),
    refreshPage: () => events.push('page-refreshed'),
    scheduleTimeout: (callback, timeoutMs) => {
      scheduledTimeoutMs = timeoutMs
      queueMicrotask(callback)
      return 1
    },
    cancelTimeout: () => {
      cancelCalls += 1
    },
  })
  const settledRefresh = refresh.then((outcome) => ({ outcome, settled: true }))
  const deadlineOutcome = await Promise.race([
    settledRefresh,
    new Promise((resolve) => setTimeout(() => resolve({ settled: false }), 0)),
  ])
  assert.equal(deadlineOutcome.settled, true, 'an unresolved native sync settles through the manual-refresh deadline')
  assert.deepEqual(calls, [{ forceFresh: true }], 'the bounded path still requests exactly one forced-fresh native sync')
  assert.equal(scheduledTimeoutMs, HEALTH_PULL_REFRESH_TIMEOUT_MS, 'the manual-refresh deadline uses the exported mobile UX timeout')
  assert.equal(cancelCalls, 1, 'the deadline handle is cleaned up after bounded settlement')
  assert.deepEqual(events, [
    `health-failed:${deadlineOutcome.outcome.healthSyncError.message}`,
    'post-sync',
    'page-refreshed',
  ], 'the deadline reports one handled Health failure before refreshing exactly once')
  assert.equal(deadlineOutcome.outcome.healthSyncAttempted, true)
  assert.equal(deadlineOutcome.outcome.healthSyncResult, null, 'a timed-out sync does not emit a false Health success')
  assert.ok(deadlineOutcome.outcome.healthSyncError instanceof HealthSyncTimeoutError, 'the deadline exposes a named Health timeout')
  assert.match(healthSyncFailureMessage(deadlineOutcome.outcome.healthSyncError), /taking longer than expected/)

  syncGate.resolve({ complete: true })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(events.filter((event) => event === 'page-refreshed').length, 1, 'a late Health success does not refresh twice')
  assert.equal(events.filter((event) => event.startsWith('health-failed:')).length, 1, 'a late Health success does not report another failure')
}

{
  const syncGate = deferred()
  const unhandledRejections = []
  let errorCalls = 0
  let refreshCalls = 0
  const captureUnhandledRejection = (error) => {
    unhandledRejections.push(error)
  }
  process.on('unhandledRejection', captureUnhandledRejection)
  try {
    const outcome = await runHealthAwarePageRefresh({
      authenticated: true,
      native: true,
      syncNativeData: () => syncGate.promise,
      onHealthSyncError: () => {
        errorCalls += 1
      },
      refreshPage: () => {
        refreshCalls += 1
      },
      scheduleTimeout: (callback) => {
        queueMicrotask(callback)
        return 1
      },
      cancelTimeout: () => {},
    })
    assert.ok(outcome.healthSyncError instanceof HealthSyncTimeoutError)
    syncGate.reject(new Error('late native rejection'))
    await new Promise((resolve) => setImmediate(resolve))
  } finally {
    process.off('unhandledRejection', captureUnhandledRejection)
  }
  assert.equal(errorCalls, 1, 'a late Health rejection does not invoke the handled error callback twice')
  assert.equal(refreshCalls, 1, 'a late Health rejection does not refresh twice')
  assert.deepEqual(unhandledRejections, [], 'a late Health rejection remains observed after the deadline')
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
  assert.equal(refreshInFlight.current, true, 'a successful reload path keeps the gesture guard raised until navigation')
  assert.equal(gestureResets, 2, 'every touchend still cleans up its gesture state')
}

{
  const syncGate = deferred()
  const refreshInFlight = { current: false }
  let fireDeadline
  let coordinatorCalls = 0
  let reloadCalls = 0
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
        scheduleTimeout: (callback) => {
          fireDeadline = callback
          return 1
        },
        cancelTimeout: () => {},
      })
    },
    onRefreshFailure: () => {},
    resetGesture: () => {},
  })

  const firstTouchEnd = onTouchEnd()
  const secondTouchEnd = onTouchEnd()
  assert.equal(await secondTouchEnd, false, 'a duplicate touchend cannot start a second deadline-bounded refresh')
  assert.equal(coordinatorCalls, 1, 'the synchronous gesture latch guards the timeout path')
  fireDeadline()
  assert.equal(await firstTouchEnd, true)
  assert.equal(reloadCalls, 1, 'the timeout path invokes ordinary reload exactly once')
  assert.equal(refreshInFlight.current, true, 'the timeout reload path keeps the gesture guard raised until navigation')
  syncGate.resolve({ complete: true })
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
window.addEventListener(HEALTH_SYNC_RESULT_EVENT, () => { resultEvents += 1 })
window.addEventListener(HEALTH_SYNC_COMPLETED_EVENT, () => { completionEvents += 1 })
const partialSummary = announceHealthSyncResult({ scanned: 2, imported: 1, errors: [{ retryable: true }] }, { complete: false })
assert.equal(partialSummary.status, 'partial')
assert.equal(resultEvents, 1, 'partial sync announces an explicit result')
assert.equal(completionEvents, 0, 'partial sync does not emit a completion-success event')
assert.match(healthSyncNotice(partialSummary), /1 unresolved/)
announceHealthSyncResult({ scanned: 2, imported: 2, errors: [] }, { complete: true })
assert.equal(resultEvents, 2)
assert.equal(completionEvents, 1, 'one complete sync emits exactly one completion-success event')

assert.ok(app.includes('sync({ force: true, bypassInterval: true })'), 'cold native launch bypasses the persisted sync throttle once')
assert.ok(service.indexOf('markHealthHistoryTransferPending()') < service.indexOf('this.getWorkoutHistory(historyOptions)'), 'durable transfer marker is written before native history advances')
assert.ok(service.includes("api.post('/import/health', { workouts: batch }, { timeout: HEALTH_IMPORT_TIMEOUT_MS })"), 'each workout batch has a dedicated timeout')
assert.ok(service.includes('createHealthSyncCoordinator'), 'native calls use the behavioral single-flight coordinator')
assert.ok(service.includes('announceHealthSyncResult(syncResult, { complete })'), 'sync result distinguishes complete from partial')
assert.ok(pullToRefresh.includes('await runHealthAwarePageRefresh({'), 'pull-to-refresh delegates sync and reload ordering to the tested coordinator')
assert.ok(pullToRefresh.includes('syncNativeData: (options) => HealthService.syncNativeData(options)'), 'pull-to-refresh forwards forced manual sync options to HealthService')
assert.ok(pullToRefresh.includes("console.error('[PullToRefresh] Apple Health sync failed:'"), 'pull sync failures retain diagnostic context')
assert.ok(pullToRefresh.includes('createPullToRefreshEndHandler({'), 'pull-to-refresh uses the executable gesture guard')

console.log('HEALTH AUTO-SYNC SMOKE OK')
