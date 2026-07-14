// Forged Hybrid run-integrity regression smoke.
// Run: node frontend/test/runIntegrity.smoke.mjs

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACTIVE_RUN_SESSION_KEY,
  clearActiveRunSession,
  elapsedFromSession,
  loadActiveRunSession,
  saveActiveRunSession,
} from '../src/lib/activeRunSession.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')
const read = (relativePath) => readFileSync(resolve(root, relativePath), 'utf8')

let passed = 0
let failed = 0
function check(condition, message) {
  if (condition) passed += 1
  else { failed += 1; console.error(`  FAIL: ${message}`) }
}

class MemoryStorage {
  constructor() { this.values = new Map() }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, String(value)) }
  removeItem(key) { this.values.delete(key) }
}

console.log('\n== active-run recovery ==')
const storage = new MemoryStorage()
const now = Date.parse('2026-07-14T12:30:00Z')
saveActiveRunSession({
  phase: 'running',
  startedAt: now - 31_000,
  elapsed: 26,
  distanceMiles: 0.11,
  routeCoords: [[38.9, -76.95, 14], [38.901, -76.951, 15]],
  mapMyRun: true,
  gpsStarted: true,
  gpsAvailable: true,
  lastFixAt: now - 1_000,
  clientRunId: 'run-client-id',
  navigationState: { plannedRoute: { coordinates: [[38.9, -76.95], [38.91, -76.96]] } },
}, storage, now)
const restored = loadActiveRunSession(storage, now + 4_000)
check(restored?.routeCoords.length === 2 && restored?.distanceMiles === 0.11, 'route and distance survive a reload')
check(restored?.lastFixAt === now - 1_000, 'the last GPS fix timestamp survives a reload')
check(elapsedFromSession(restored, now + 4_000) === 35, 'elapsed time is rebuilt from the persisted start timestamp')
check(restored?.navigationState?.plannedRoute?.coordinates?.length === 2, 'planned route survives a reload')
clearActiveRunSession(storage)
check(storage.getItem(ACTIVE_RUN_SESSION_KEY) === null, 'saved session is removed after a durable run save')

saveActiveRunSession({ phase: 'running', startedAt: now - 90_000_000, elapsed: 1 }, storage, now - 90_000_000)
check(loadActiveRunSession(storage, now) === null, 'stale sessions do not resurrect old runs')

console.log('\n== UI wiring ==')
const layout = read('frontend/src/components/Layout.jsx')
const activeRun = read('frontend/src/pages/ActiveRun.jsx')
const detail = read('frontend/src/components/RunDetailModal.jsx')
const history = read('frontend/src/pages/History.jsx')
check(/isImmersive\s*\?\s*\([\s\S]*?<main[\s\S]*?:\s*\([\s\S]*?<PullToRefresh>/.test(layout), 'immersive workout routes bypass destructive pull-to-refresh')
check(/saveActiveRunSession/.test(activeRun) && /loadActiveRunSession/.test(activeRun) && /clearActiveRunSession/.test(activeRun), 'ActiveRun persists, restores, and clears its session')
check(/FollowCurrentLocation/.test(activeRun) && /You are here/.test(activeRun) && /radius=\{15\}/.test(activeRun), 'map follows a prominent yellow current-location marker')
check(/enabled=\{!running \|\| plannedRoutePositions\.length > 0\}/.test(activeRun), 'ad-hoc runs follow the athlete without refitting the whole route on every GPS fix')
check(/Delete this \{isRun \? 'run' : 'activity'\}/.test(detail) && /onDelete=\{\(\) =>/.test(history), 'run detail exposes the confirmed delete flow')
check(/Active calories/.test(detail) && /Review or match watch zones/.test(detail), 'Apple Health calorie provenance and zone calibration are explicit')
check(/savedHrZones/.test(activeRun) && /profile\/hr-zones/.test(activeRun), 'live-run zones use the same saved watch profile as History')

console.log('\n== HealthKit source truth ==')
const swift = read('frontend/ios/App/App/ForgeHealthPlugin.swift')
const healthService = read('frontend/src/services/HealthService.js')
check(/workout\.statistics\(for: type\)/.test(swift), 'native import prefers statistics owned by the workout')
check(/predicateForObjects\(from: workout\)/.test(swift) && /workout\.sourceRevision\.source/.test(swift), 'heart-rate samples are scoped to the workout with a same-source fallback')
check(/timeWeightedAverage/.test(swift), 'sparse fallback samples use time weighting instead of an unweighted mean')
check(/metricsSchemaVersion": 4/.test(swift) && /REQUIRED_WORKOUT_IMPORT_VERSION = 4/.test(healthService), 'the next native build triggers one full re-import with corrected summaries')
check(/workoutUpgradeAvailable[\s\S]*workoutHistoryUpgradeRequired/.test(healthService), 'old TestFlight shells cannot prematurely mark the v4 import complete')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
