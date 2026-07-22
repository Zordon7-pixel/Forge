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
  HEALTH_SYNC_RESULT_EVENT,
  healthSyncFailureMessage,
  healthSyncNotice,
  importHealthWorkoutBatches,
  isHealthHistoryImportComplete,
  isHealthHistoryTransferPending,
  markHealthHistoryTransferPending,
  retryableHealthSyncErrors,
} from '../src/lib/healthSync.js'

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
assert.ok(pullToRefresh.includes('await HealthService.syncNativeData()'), 'native pull-to-refresh waits for Apple Health sync')
assert.ok(pullToRefresh.indexOf('await HealthService.syncNativeData()') < pullToRefresh.indexOf('window.location.reload()'), 'page data reloads only after the health sync attempt')
assert.ok(pullToRefresh.includes("console.error('[PullToRefresh] Apple Health sync failed:'"), 'pull sync failures retain diagnostic context')

console.log('HEALTH AUTO-SYNC SMOKE OK (35)')
