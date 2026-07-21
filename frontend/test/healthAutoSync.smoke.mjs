import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createHealthImportBatches,
  HEALTH_IMPORT_BATCH_SIZE,
  healthSyncFailureMessage,
} from '../src/lib/healthSync.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
const app = read('frontend/src/App.jsx')
const dashboard = read('frontend/src/pages/Dashboard.jsx')
const service = read('frontend/src/services/HealthService.js')

const workouts = Array.from({ length: HEALTH_IMPORT_BATCH_SIZE * 2 + 3 }, (_, index) => ({ id: index }))
const batches = createHealthImportBatches(workouts)
assert.deepEqual(batches.map((batch) => batch.length), [10, 10, 3], 'large health imports split into bounded batches')
assert.deepEqual(batches.flat(), workouts, 'batching preserves every workout and its order')
assert.throws(() => createHealthImportBatches(workouts, 0), /positive integer/, 'invalid batch size fails loudly')

const timeoutCopy = healthSyncFailureMessage({ code: 'ECONNABORTED', message: 'timeout of 15000ms exceeded' })
assert.match(timeoutCopy, /taking longer than expected/, 'raw Axios timeout is replaced with user-facing catch-up copy')
assert.ok(!timeoutCopy.includes('15000ms'), 'timeout copy does not expose an implementation detail')

assert.ok(app.includes('sync({ force: true, bypassInterval: true })'), 'cold native launch bypasses the persisted sync throttle once')
assert.ok(service.includes("api.post('/import/health', { workouts: batch }, { timeout: HEALTH_IMPORT_TIMEOUT_MS })"), 'each workout batch has a dedicated timeout')
assert.ok(service.includes('this.nativeSyncPromise'), 'concurrent native sync callers share one in-flight operation')
assert.ok(service.includes('announceHealthSyncCompleted(syncResult)'), 'successful syncs persist and announce their result')
assert.ok(dashboard.includes('HEALTH_SYNC_COMPLETED_EVENT'), 'dashboard refreshes after automatic health sync completes')

console.log('HEALTH AUTO-SYNC SMOKE OK (10)')
