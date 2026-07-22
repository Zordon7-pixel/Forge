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
import { getAuthenticatedUserId } from '../src/lib/auth.js'
import { clearToken, setToken } from '../src/lib/tokenStore.js'

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
const ownerUserId = 'user-owner-a'
saveActiveRunSession({
  phase: 'running',
  startedAt: now - 31_000,
  elapsed: 26,
  distanceMiles: 0.11,
  routeCoords: [[38.9, -76.95, 14, now - 2_000, 4.5], [38.901, -76.951, 15, now - 1_000, 6]],
  mapMyRun: true,
  gpsStarted: true,
  gpsAvailable: true,
  lastFixAt: now - 1_000,
  clientRunId: 'run-client-id',
  navigationState: { plannedRoute: { coordinates: [[38.9, -76.95], [38.91, -76.96]] } },
}, ownerUserId, storage, now)
const restored = loadActiveRunSession(ownerUserId, storage, now + 4_000)
check(restored?.routeCoords.length === 2 && restored?.distanceMiles === 0.11, 'route and distance survive a reload')
check(restored?.routeCoords[0][3] === now - 2_000 && restored?.routeCoords[0][4] === 4.5, 'GPS sample timestamps and horizontal accuracy survive a reload')
check(restored?.lastFixAt === now - 1_000, 'the last GPS fix timestamp survives a reload')
check(elapsedFromSession(restored, now + 4_000) === 35, 'elapsed time is rebuilt from the persisted start timestamp')
check(restored?.startedAt === now - 31_000 && restored?.clientRunId === 'run-client-id', 'capture identity and start time stay stable across a reload')
check(restored?.navigationState?.plannedRoute?.coordinates?.length === 2, 'planned route survives a reload')
check(restored?.ownerUserId === ownerUserId, 'restored session remains bound to its authenticated owner')
clearActiveRunSession(storage)
check(storage.getItem(ACTIVE_RUN_SESSION_KEY) === null, 'saved session is removed after a durable run save')

const longRouteStorage = new MemoryStorage()
const longRoute = Array.from({ length: 5002 }, (_, index) => [38.9 + index / 1_000_000, -76.95, 10, now + index, 5])
saveActiveRunSession({ phase: 'running', startedAt: now, routeCoords: longRoute }, ownerUserId, longRouteStorage, now)
const restoredLongRoute = loadActiveRunSession(ownerUserId, longRouteStorage, now + 1000)?.routeCoords || []
check(restoredLongRoute.length === 5000, 'persisted active routes are bounded to 5,000 points')
check(restoredLongRoute[0]?.[0] === longRoute[0][0] && restoredLongRoute.at(-1)?.[0] === longRoute.at(-1)[0], 'route bounding preserves both the start and finish instead of dropping the beginning')

saveActiveRunSession({ phase: 'running', startedAt: now - 90_000_000, elapsed: 1 }, ownerUserId, storage, now - 90_000_000)
check(loadActiveRunSession(ownerUserId, storage, now) === null, 'stale sessions do not resurrect old runs')

saveActiveRunSession({
  phase: 'running',
  startedAt: now - 10_000,
  navigationState: { plannedRoute: { coordinates: [[38.9, -76.95], [38.91, -76.96]] } },
}, ownerUserId, storage, now)
check(loadActiveRunSession('user-owner-b', storage, now + 1000) === null, 'another authenticated user cannot restore a private active-run session')
check(storage.getItem(ACTIVE_RUN_SESSION_KEY) === null, 'owner mismatch clears the private persisted session')

storage.setItem(ACTIVE_RUN_SESSION_KEY, JSON.stringify({
  phase: 'running',
  startedAt: now - 10_000,
  savedAt: now,
  navigationState: { plannedRoute: { coordinates: [[38.9, -76.95], [38.91, -76.96]] } },
}))
check(loadActiveRunSession(ownerUserId, storage, now + 1000) === null, 'legacy ownerless sessions cannot be restored')
check(storage.getItem(ACTIVE_RUN_SESSION_KEY) === null, 'ownerless private session is removed')

saveActiveRunSession({ phase: 'running', startedAt: now - 10_000 }, null, storage, now)
check(storage.getItem(ACTIVE_RUN_SESSION_KEY) === null, 'a session cannot be persisted without an authenticated owner')

const browserStorage = new MemoryStorage()
const originalWindow = globalThis.window
const originalLocalStorage = globalThis.localStorage
globalThis.window = { localStorage: browserStorage }
globalThis.localStorage = browserStorage
const authPayload = Buffer.from(JSON.stringify({ id: ownerUserId, exp: Math.floor(now / 1000) + 3600 })).toString('base64url')
const ownerToken = `header.${authPayload}.signature`
browserStorage.setItem('forge_token', ownerToken)
check(getAuthenticatedUserId(now) === ownerUserId, 'active-run ownership comes from the current unexpired auth token')
saveActiveRunSession({ phase: 'running', startedAt: now - 10_000 }, ownerUserId, browserStorage, now)
setToken(ownerToken)
check(browserStorage.getItem(ACTIVE_RUN_SESSION_KEY) !== null, 'writing the identical token preserves its active-run session')
const replacementPayload = Buffer.from(JSON.stringify({ id: 'user-owner-b', exp: Math.floor(now / 1000) + 3600 })).toString('base64url')
const replacementToken = `header.${replacementPayload}.signature`
setToken(replacementToken)
check(browserStorage.getItem('forge_token') === replacementToken, 'a different auth token replaces the previous token')
check(browserStorage.getItem(ACTIVE_RUN_SESSION_KEY) === null, 'replacing a different token clears the previous account active-run session')
saveActiveRunSession({ phase: 'running', startedAt: now - 10_000 }, 'user-owner-b', browserStorage, now)
clearToken()
check(browserStorage.getItem('forge_token') === null, 'auth clear removes the token')
check(browserStorage.getItem(ACTIVE_RUN_SESSION_KEY) === null, 'auth clear also removes the active-run session')
if (originalWindow === undefined) delete globalThis.window
else globalThis.window = originalWindow
if (originalLocalStorage === undefined) delete globalThis.localStorage
else globalThis.localStorage = originalLocalStorage

console.log('\n== UI wiring ==')
const layout = read('frontend/src/components/Layout.jsx')
const activeRun = read('frontend/src/pages/ActiveRun.jsx')
const detail = read('frontend/src/components/RunDetailModal.jsx')
const history = read('frontend/src/pages/History.jsx')
const logRun = read('frontend/src/pages/LogRun.jsx')
const treadmillRun = read('frontend/src/pages/TreadmillRun.jsx')
const runsRoute = read('backend/src/routes/runs.js')
check(/isImmersive\s*\?\s*\([\s\S]*?<main[\s\S]*?:\s*\([\s\S]*?<PullToRefresh>/.test(layout), 'immersive workout routes bypass destructive pull-to-refresh')
check(/saveActiveRunSession/.test(activeRun) && /loadActiveRunSession/.test(activeRun) && /clearActiveRunSession/.test(activeRun), 'ActiveRun persists, restores, and clears its session')
check(activeRun.includes('Your iPhone records the route. Keep your watch running too — Forged Hybrid will combine the data after sync.'), 'the one Start Run action explains phone route recording and later watch enrichment')
check(!activeRun.includes('Record route: On') && !activeRun.includes('Record route: Off'), 'ActiveRun no longer exposes a competing route-only mode')
check(activeRun.includes('loc.accuracy') && activeRun.includes('pos.coords.accuracy'), 'native and web GPS forward horizontal accuracy into the route')
check(activeRun.indexOf('const savePromise = saveRun()') < activeRun.indexOf('await clearActiveWatch()', activeRun.indexOf('const savePromise = saveRun()')), 'finish starts the durable save before watcher cleanup')
check(/failed to remove native GPS watcher/.test(activeRun) && /failed to clear web GPS watcher/.test(activeRun), 'watcher cleanup errors are fail-soft and observable')
check(/FollowCurrentLocation/.test(activeRun) && /You are here/.test(activeRun) && /radius=\{15\}/.test(activeRun), 'map follows a prominent yellow current-location marker')
check(/enabled=\{!running \|\| plannedRoutePositions\.length > 0\}/.test(activeRun), 'ad-hoc runs follow the athlete without refitting the whole route on every GPS fix')
check(/Delete this \{isRun \? 'run' : 'activity'\}/.test(detail) && /onDelete=\{\(\) =>/.test(history), 'run detail exposes the confirmed delete flow')
check(/Active calories/.test(detail) && /Garmin calories/.test(detail) && /Review or match watch zones/.test(detail), 'watch calorie provenance and zone calibration are explicit')
check(/keeps an imported activity hidden from future syncs/.test(history), 'delete confirmation explains the permanent import tombstone behavior')
check(/savedHrZones/.test(activeRun) && /profile\/hr-zones/.test(activeRun), 'live-run zones use the same saved watch profile as History')
check(logRun.includes('disablePlanMatch: true') && treadmillRun.includes("disablePlanMatch ? { plan_session_id: null }"), 'an extra indoor run explicitly opts out of scheduled-plan matching')
check(runsRoute.includes('planMatchExplicitlyDisabled') && runsRoute.includes('explicitNoPlanMatchSnapshot()') && runsRoute.includes('JSON.stringify(storedPlannedSession || {})'), 'the run API durably records an explicit null plan link instead of silently rematching it')

console.log('\n== HealthKit source truth ==')
const swift = read('frontend/ios/App/App/ForgeHealthPlugin.swift')
const healthService = read('frontend/src/services/HealthService.js')
check(/workout\.statistics\(for: type\)/.test(swift), 'native import prefers statistics owned by the workout')
check(/predicateForObjects\(from: workout\)/.test(swift) && /workout\.sourceRevision\.source/.test(swift), 'heart-rate samples are scoped to the workout with a same-source fallback')
check(/timeWeightedAverage/.test(swift), 'sparse fallback samples use time weighting instead of an unweighted mean')
check(/metricsSchemaVersion": 5/.test(swift) && /REQUIRED_WORKOUT_IMPORT_VERSION = 5/.test(healthService), 'the next native build triggers one full re-import with corrected summaries')
check(/workoutUpgradeAvailable[\s\S]*workoutHistoryUpgradeRequired/.test(healthService), 'old TestFlight shells cannot prematurely mark the v5 import complete')

console.log(`\n${passed} passed, ${failed} failed`)
if (failed) process.exit(1)
