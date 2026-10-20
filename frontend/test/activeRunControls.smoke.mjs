import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import * as policy from '../src/lib/runReadiness.js'
import { createPhoneGpsWatcher } from '../src/lib/phoneGpsWatcher.js'
import { saveActiveRunSession, loadActiveRunSession } from '../src/lib/activeRunSession.js'
import { buildRunCompletionSnapshot, saveRunCompletionHandoff, loadRunCompletionHandoff } from '../src/lib/runCompletionHandoff.js'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ACTIVE_RUN_MAP_LAYOUT_KEY,
  activeRunBackDecision,
  activeRunMapCommand,
  activeRunMapViewDecision,
  activeRunNearViewEdge,
  createActiveRunMapPolicy,
  activeRunReturnTargetFromLocation,
  loadActiveRunMapLayout,
  normalizeMapPosition,
  resolveActiveRunReturnTarget,
  saveActiveRunMapLayout,
  shouldProtectActiveRunNavigation,
  validMapPositions,
  withActiveRunReturnTarget,
} from '../src/lib/activeRunControls.js'

class MemoryStorage {
  constructor() {
    this.values = new Map()
  }

  getItem(key) {
    return this.values.get(key) ?? null
  }

  setItem(key, value) {
    this.values.set(key, String(value))
  }
}

console.log('== Active Run deterministic navigation ==')
const runTodayState = withActiveRunReturnTarget({ countdown: 3 }, '/log-run?tab=today')
assert.equal(runTodayState.activeRunReturnTo, '/log-run?tab=today', 'Run Today origin must survive warm-up handoff')
assert.equal(
  activeRunReturnTargetFromLocation('/log-run', '?tab=manual&intent=rest-day'),
  '/log-run?tab=manual',
  'returning from the Run Today sheet clears its overlay trigger while preserving the safe tab',
)
assert.equal(resolveActiveRunReturnTarget(runTodayState.activeRunReturnTo), '/log-run?tab=today')
assert.equal(resolveActiveRunReturnTarget(undefined), '/log-run', 'deep links without history use the safe Run Today fallback')
assert.equal(resolveActiveRunReturnTarget('https://evil.example/steal'), '/log-run', 'absolute external targets fail closed')
assert.equal(resolveActiveRunReturnTarget('//evil.example/steal'), '/log-run', 'protocol-relative targets fail closed')
assert.equal(resolveActiveRunReturnTarget('/not-a-forge-launch-surface'), '/log-run', 'arbitrary internal paths fail closed')
assert.equal(resolveActiveRunReturnTarget('/plan?week=4'), '/plan?week=4', 'validated Forge launch surfaces retain useful query state')
assert.equal(shouldProtectActiveRunNavigation({ running: true }), true)
assert.equal(shouldProtectActiveRunNavigation({ paused: true }), true)
assert.equal(shouldProtectActiveRunNavigation({ awaitingManualDistance: true }), true)
assert.equal(shouldProtectActiveRunNavigation({}), false)
assert.deepEqual(activeRunBackDecision({
  returnTarget: runTodayState.activeRunReturnTo,
}), { action: 'navigate', to: '/log-run?tab=today', options: { replace: true } }, 'pre-start Back returns to the exact safe origin')
assert.deepEqual(activeRunBackDecision({
  returnTarget: 'https://evil.example/steal',
}), { action: 'navigate', to: '/log-run', options: { replace: true } }, 'malformed Back state cannot become an open redirect')
const recordingSession = { watcherId: 'canonical-watcher', elapsed: 42, routeCoords: [[38.9, -76.95]] }
const recordingSnapshot = structuredClone(recordingSession)
assert.deepEqual(activeRunBackDecision({
  protectedNavigation: true,
  returnTarget: '/log-run',
}), { action: 'block' }, 'visible/system Back stays on Active Run once recording starts')
assert.deepEqual(recordingSession, recordingSnapshot, 'blocked Back does not stop, reset, or discard the recording session')

console.log('== Active Run map commands ==')
const recorded = [
  [38.9000, -76.9500],
  [999, -76.9510],
  ['38.9020', '-76.9520'],
]
const planned = [
  [38.8990, -76.9490],
  ['bad', -76.9480],
  [38.9030, -76.9530],
]
assert.deepEqual(normalizeMapPosition([91, 10]), null)
assert.deepEqual(validMapPositions(recorded), [[38.9, -76.95], [38.902, -76.952]])

const follow = activeRunMapCommand('follow', { recordedPositions: recorded, plannedPositions: planned })
assert.equal(follow.type, 'follow')
assert.deepEqual(follow.position, [38.902, -76.952], 'Follow uses the newest valid recorded position')

const overview = activeRunMapCommand('overview', { recordedPositions: recorded, plannedPositions: planned })
assert.equal(overview.type, 'fit')
assert.deepEqual(overview.positions, [
  [38.9, -76.95],
  [38.902, -76.952],
  [38.899, -76.949],
  [38.903, -76.953],
], 'Overview fits valid recorded and planned points without fabricating replacements')

const activeSession = {
  elapsed: 42,
  distanceMiles: 0.18,
  routeCoords: recorded,
  watcherId: 'canonical-watcher',
}
const sessionSnapshot = structuredClone(activeSession)
assert.deepEqual(activeRunMapCommand('stats', {
  recordedPositions: activeSession.routeCoords,
  plannedPositions: planned,
}), { type: 'hidden', positions: [] })
assert.deepEqual(activeSession, sessionSnapshot, 'Stats is presentation-only and does not reset recording state')

console.log('== Active Run stored preference ==')
const storage = new MemoryStorage()
assert.equal(loadActiveRunMapLayout(storage), 'follow')
assert.equal(saveActiveRunMapLayout('overview', storage), 'overview')
assert.equal(storage.getItem(ACTIVE_RUN_MAP_LAYOUT_KEY), 'overview')
assert.equal(loadActiveRunMapLayout(storage), 'overview')
storage.setItem(ACTIVE_RUN_MAP_LAYOUT_KEY, 'satellite')
assert.equal(loadActiveRunMapLayout(storage), 'follow', 'unknown stored values default safely')
assert.equal(saveActiveRunMapLayout('street', storage), 'follow', 'unsupported values are never persisted')

console.log('== Active Run accessible wiring ==')
const activeRunSource = readFileSync(new URL('../src/pages/ActiveRun.jsx', import.meta.url), 'utf8')
const logRunSource = readFileSync(new URL('../src/pages/LogRun.jsx', import.meta.url), 'utf8')
assert.match(logRunSource, /withActiveRunReturnTarget\([\s\S]*activeRunReturnTo/, 'Run Today writes its exact origin into navigation state')
assert.match(logRunSource, /Outdoor runs check iPhone Location access before the timer starts/, 'the manual-run intent sheet explains when location permission is checked')
assert.match(activeRunSource, /role="group"[\s\S]*aria-label="Live map view"/)
assert.match(activeRunSource, /aria-pressed=\{selected\}/)
assert.match(activeRunSource, /minHeight: 44/)
assert.match(activeRunSource, /data-testid="finish-run"/)
assert.match(activeRunSource, /data-testid=\{pausedRun \? 'resume-run' : 'pause-run'\}/, 'the in-app recorder exposes explicit pause and resume controls')
assert.match(activeRunSource, /data-testid="run-location-preflight"/, 'the Start Run flow displays a location preflight')
assert.match(activeRunSource, /await getWatcher\(\)\.start\(\{ requestPermissions:/, 'the shared watcher receives the once-only permission policy without waiting for a GPS fix')
assert.match(activeRunSource, /Open iPhone Settings/, 'denied native location access has a direct recovery action')
assert.match(activeRunSource, /Map hidden for Stats view · GPS recording and run metrics continue\./)
assert.match(activeRunSource, /addListener\('backButton'/, 'native/system back uses the same Active Run guard')
assert.match(activeRunSource, /window\.addEventListener\('popstate'/, 'browser back uses the Active Run guard')
assert.match(activeRunSource, /activeRunMapCommand\(mapLayout/, 'the rendered map consumes the executable layout policy')
assert.match(logRunSource, /authorizeWorkoutStart/, 'every LogRun live-start path rechecks the server-issued safety manifest')
assert.match(logRunSource, /workoutStartAccess/, 'the run handoff carries the manifest revision and safety hash')
assert.match(logRunSource, /WORKOUT_START_ACCESS_(?:STALE|MISSING|BLOCKED|UNAVAILABLE)/, 'stale or missing run safety state has a visible fail-closed path')


console.log('== Deterministic Follow/Overview camera policy ==')
const north = meters => [meters / 6371000 * 180 / Math.PI, 0]
const followAt = meters => activeRunMapCommand('follow', { recordedPositions: [north(meters)] })
assert.deepEqual(activeRunMapCommand(undefined, { recordedPositions: [north(0)] }), followAt(0))
assert.equal(activeRunMapCommand('follow', { plannedPositions: planned }).type, 'empty', 'planned-only Follow cannot change zoom')
let camera = createActiveRunMapPolicy()
function decide(meters, nowMs, options = {}) {
  const outcome = activeRunMapViewDecision(camera, { command: followAt(meters), nowMs, ...options })
  camera = outcome.state
  return outcome.action
}
assert.equal(decide(0, 0), null, 'initial center establishes the Follow anchor')
assert.equal(decide(14.999, 10), null)
assert.equal(decide(15, 20), null, 'exactly 15 metres is not more than 15 metres')
assert.equal(decide(15.001, 30)?.type, 'pan')
assert.equal(decide(32, 31), null)
assert.equal(decide(48, 2029), null, '1999ms since pan remains throttled')
assert.equal(decide(48, 2030)?.type, 'pan', 'exact 2000ms boundary allows a pan')
assert.equal(decide(64, 4031)?.type, 'pan', 'after boundary also allows a pan')
assert.equal(decide(65, 4032, { nearViewEdge: true }), null, 'edge never bypasses throttle')
assert.equal(decide(65, 6031, { nearViewEdge: true })?.type, 'pan', 'edge can pan under 15m')
assert.equal(decide(66, 8031, { nearViewEdge: null }), null, 'unknown edge is not fabricated')
assert.equal(decide(66, 8032, { nearViewEdge: 'true' }), null)
assert.equal(decide(100, 8033, { followPaused: true, nearViewEdge: true }), null)
assert.equal(decide(65, 6032, { recenterToken: 1 })?.type, 'pan', 'Recenter overrides time and distance')
assert.equal(decide(65, 6032, { recenterToken: 1 }), null, 'Recenter token is consumed once')
assert.equal(decide(100, 8031, { recenterToken: 1 }), null, 'ordinary throttle starts at Recenter')
assert.equal(decide(100, 8032, { recenterToken: 1 })?.type, 'pan')
assert.equal(decide(200, NaN, { recenterToken: 1 }), null, 'invalid clock cannot request camera movement')
assert.equal(decide(200, 100, { recenterToken: 1 }), null, 'clock regression fails safely')
// Haversine longitude scaling at high latitude, not a degree-distance guess.
camera = createActiveRunMapPolicy()
const longitudeStep = meters => [80, meters / 6371000 * 180 / Math.PI]
for (const [meters, expected] of [[0, undefined], [16, undefined], [100, 'pan']]) {
  const outcome = activeRunMapViewDecision(camera, { command: { type: 'follow', position: longitudeStep(meters) }, nowMs: 1000 })
  camera = outcome.state
  assert.equal(outcome.action?.type, expected)
}
// Fixed-cost bounds adapter, including near, outside, malformed and throwing maps.
function bounds(west = -1, east = 1, south = -1, north = 1) {
  return {
    isValid: () => true,
    pad(ratio) { return bounds(west - (east - west) * ratio, east + (east - west) * ratio,
      south - (north - south) * ratio, north + (north - south) * ratio) },
    contains: ([lat, lon]) => lat >= south && lat <= north && lon >= west && lon <= east,
  }
}
for (const [position, expected] of [[[0, 0], false], [[0, .7], false], [[0, .700001], true], [[0, 1.1], true]]) {
  let reads = 0
  assert.equal(activeRunNearViewEdge({ getBounds() { reads++; return bounds() } }, position), expected)
  assert.equal(reads, 1)
}
for (const map of [{}, { getBounds() { throw Error('unavailable') } },
  { getBounds: () => ({ isValid: () => false }) },
  { getBounds: () => ({ isValid: () => true, pad: () => ({ isValid: () => false }) }) },
  { getBounds: () => ({ isValid: () => true, pad: () => ({ isValid: () => true, contains: () => undefined }) }) }]) {
  assert.equal(activeRunNearViewEdge(map, north(0)), null)
}
assert.equal(activeRunNearViewEdge({ getBounds() { throw Error('must not read') } }, [100, 0]), null)

// Execute the actual controller body with dependency-aware hooks and a map spy.
// Every camera method is observed; Follow/Recenter must never mutate zoom.
const controllerSource = activeRunSource.slice(activeRunSource.indexOf('function MapViewController('), activeRunSource.indexOf('export default function ActiveRun('))
assert.match(activeRunSource, /<MapViewController\s+layout=\{mapLayout\}/)
assert.match(activeRunSource, /data-testid="map-recenter"[\s\S]*?setFollowPaused\(false\)[\s\S]*?setRecenterToken\(\(value\) => value \+ 1\)/)
const calls = []
let mapEvents, cameraTime = 0, controllerRef, effectDeps, pendingEffect
let props = { layout: 'follow', command: followAt(0), followPaused: false, recenterToken: 0, reduceMotion: false,
  onFollowPaused() { props.followPaused = true } }
const mapSpy = {
  getBounds: () => bounds(), invalidateSize() {},
  ...Object.fromEntries(['panTo', 'setView', 'fitBounds', 'setZoom', 'zoomIn', 'zoomOut', 'flyTo', 'flyToBounds'].map(name => [name, (...args) => calls.push({ name, args })])),
}
const controllerContext = {
  activeRunMapViewDecision, activeRunNearViewEdge, createActiveRunMapPolicy,
  performance: { now: () => cameraTime },
  useRef(initial) { return controllerRef ||= { current: initial } },
  useMapEvents(events) { mapEvents = events; return mapSpy },
  useEffect(fn, deps) {
    if (!effectDeps || deps.some((value, index) => !Object.is(value, effectDeps[index]))) pendingEffect = fn
    effectDeps = deps
  },
}
vm.runInNewContext(controllerSource, controllerContext)
function renderMap(next = {}, time = cameraTime) {
  props = { ...props, ...next }; cameraTime = time; pendingEffect = null
  controllerContext.MapViewController(props)
  pendingEffect?.()
}
renderMap()
renderMap({ command: followAt(15) }, 100)
assert.equal(calls.length, 0)
renderMap({ command: followAt(16) }, 101)
renderMap({ command: followAt(32) }, 2100)
assert.equal(calls.length, 1)
renderMap({ command: followAt(32) }, 2101)
assert.equal(calls.length, 2)
mapEvents.dragstart(); renderMap({ command: followAt(100) }, 5000)
assert.equal(props.followPaused, true)
assert.equal(calls.length, 2)
renderMap({ followPaused: false, recenterToken: 1 }, 5001)
assert.equal(calls.length, 3)
renderMap({ command: followAt(100) }, 5002)
renderMap({ command: followAt(120) }, 7000)
assert.equal(calls.length, 3)
renderMap({ command: followAt(120) }, 7001)
assert.equal(calls.length, 4)
mapEvents.dragstart(); renderMap({ command: followAt(120) }, 7002)
renderMap({ followPaused: false, recenterToken: 2, reduceMotion: true }, 7003)
assert.equal(calls.length, 5, 'immediate Recenter even during throttle at zero displacement')
renderMap({ command: followAt(120) }, 7004)
assert.equal(calls.length, 5)
assert.ok(calls.every(call => call.name === 'panTo'), 'zero Follow/Recenter setView/fitBounds/zoom calls')
assert.deepEqual(calls.at(-1).args[0], north(120))
assert.equal(calls.at(-1).args[1].animate, false)
assert.equal(calls.at(-1).args[1].duration, 0)

// A narrow synthetic view puts the same accepted fix near, then outside, its
// edge. This exercises adapter -> policy -> real controller, under the throttle.
const latitude = north(120)[0]
mapSpy.getBounds = () => bounds(-.001, .001, latitude - .0018, latitude + .0002)
renderMap({ command: followAt(120) }, 9002)
assert.equal(calls.length, 5)
renderMap({ command: followAt(120) }, 9003)
assert.equal(calls.length, 6)
mapSpy.getBounds = () => bounds(-.001, .001, latitude - .002, latitude - .0001)
renderMap({ command: followAt(120) }, 9004)
assert.equal(calls.length, 6)
renderMap({ command: followAt(120) }, 11003)
assert.equal(calls.length, 7)
assert.ok(calls.every(call => call.name === 'panTo'))
mapSpy.getBounds = () => bounds()

calls.length = 0
const overviewAt = positions => activeRunMapCommand('overview', { recordedPositions: positions })
renderMap({ layout: 'overview', command: overviewAt([]) }, 8000)
renderMap({ command: overviewAt([]) }, 8001)
assert.equal(calls.length, 0, 'empty Overview keeps its one fit pending')
renderMap({ command: overviewAt([north(0)]) }, 8002)
assert.equal(calls.length, 1)
assert.equal(calls[0].name, 'setView')
renderMap({ command: overviewAt([north(0), north(20)]) }, 8003)
renderMap({ command: overviewAt([]), reduceMotion: false }, 8004)
renderMap({ command: overviewAt([north(30)]) }, 8005)
assert.equal(calls.length, 1, 'new fixes/arrays/empty interval cannot refit during Overview')
mapEvents.dragstart()
assert.equal(props.followPaused, false, 'Overview drag is not a Follow pause')
renderMap({ layout: 'follow', command: followAt(120) }, 8006)
renderMap({ layout: 'overview', command: overviewAt([north(0), north(30)]) }, 8007)
assert.equal(calls.length, 2)
assert.equal(calls[1].name, 'fitBounds', 'returning to Overview permits one new fit')
pendingEffect() // React effect replay must not duplicate the activation's fit.
renderMap({ command: overviewAt([north(40), north(50)]) }, 8008)
assert.equal(calls.length, 2)
renderMap({ layout: 'stats', command: activeRunMapCommand('stats') }, 8009)
renderMap({ layout: 'overview', command: overviewAt([north(20)]) }, 8010)
assert.equal(calls.length, 3)
assert.equal(calls[2].name, 'setView')
console.log('PASS actual MapViewController: metre/time boundaries, bounded edge, drag/Recenter, no Follow zoom, one Overview fit per activation')

console.log('ACTIVE RUN CONTROLS SMOKE OK')

// Synthetic bridge/service/component evidence only; never physical iPhone acceptance.
const tick = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
const swift = readFileSync(new URL('../ios/App/App/AppViewController.swift', import.meta.url), 'utf8')
assert.match(swift, /registerPluginInstance\(ForgeRunReadinessPlugin\(\)\)/)
assert.match(swift, /UIApplication\.openSettingsURLString/)
assert.doesNotMatch(swift, /requestAlwaysAuthorization|requestWhenInUseAuthorization|print\(|NSLog/)
for (const method of ['getStatus', 'claimExplainer', 'claimFirstRun', 'openSettings']) assert.ok(swift.includes(`CAPPluginMethod(name: "${method}"`))
// Execute the actual Swift plugin method bodies against tiny typed SDK doubles.
// Only ObjC exposure/access modifiers and dispatch scheduling are adapted for macOS.
const temporary = mkdtempSync(path.join(os.tmpdir(), 'forge-readiness-'))
try {
  const body = swift.slice(swift.indexOf('@objc(ForgeRunReadinessPlugin)'))
    .replace(/@objc\(ForgeRunReadinessPlugin\)|@objc |public /g, '')
    .replaceAll('DispatchQueue.main.async', 'TestQueue.async')
  const stubs = `import Foundation
class CAPPlugin {}
protocol CAPBridgedPlugin {}
struct CAPPluginMethod { init(name: String, returnType: String) {} }
let CAPPluginReturnPromise = "promise"
class CAPPluginCall { var result: [String: Any] = [:]; func resolve(_ value: [String: Any]) { result = value } }
enum TestQueue { static func async(_ work: () -> Void) { work() } }
class UserDefaults {
 static let standard = UserDefaults(); var values: [String: Bool] = [:]
 func bool(forKey key: String) -> Bool { values[key] ?? false }
 func set(_ value: Bool, forKey key: String) { values[key] = value }
}
enum Refresh { case available, denied, restricted }
enum Authorization { case authorizedAlways, authorizedWhenInUse, denied, restricted, notDetermined }
enum Accuracy { case fullAccuracy, reducedAccuracy }
class CLLocationManager {
 static var location: Authorization = .notDetermined
 static var accuracy: Accuracy = .reducedAccuracy
 var authorizationStatus: Authorization { Self.location }
 var accuracyAuthorization: Accuracy { Self.accuracy }
}
class UIApplication {
 static let shared = UIApplication(); static let openSettingsURLString = "app-settings:"
 var backgroundRefreshStatus: Refresh = .denied
 var canOpen = true, opened = true; var destination: String?
 func canOpenURL(_ url: URL) -> Bool { canOpen }
 func open(_ url: URL, options: [String: Any], completion: (Bool) -> Void) { destination = url.absoluteString; completion(opened) }
}
`
  const checks = `
let plugin = ForgeRunReadinessPlugin()
for (state, label) in [(Refresh.available,"available"),(.denied,"denied"),(.restricted,"restricted")] {
 UIApplication.shared.backgroundRefreshStatus = state
 let call = CAPPluginCall(); plugin.getStatus(call)
 assert(call.result["backgroundRefreshStatus"] as? String == label)
}
for (state, label) in [(Authorization.authorizedAlways,"always"),(.authorizedWhenInUse,"while_using"),(.denied,"denied"),(.restricted,"restricted"),(.notDetermined,"not_determined")] {
 CLLocationManager.location = state
 let call = CAPPluginCall(); plugin.getStatus(call)
 assert(call.result["locationAuthorization"] as? String == label)
 assert(call.result["backgroundRefreshStatus"] as? String == "restricted")
}
for (state, label) in [(Accuracy.fullAccuracy,"precise"),(.reducedAccuracy,"reduced")] {
 CLLocationManager.accuracy = state
 let call = CAPPluginCall(); plugin.getStatus(call)
 assert(call.result["accuracyAuthorization"] as? String == label)
}
let first = CAPPluginCall(); plugin.claimExplainer(first); assert(first.result["first"] as? Bool == true)
let settings = CAPPluginCall(); UIApplication.shared.opened = false; plugin.openSettings(settings)
assert(settings.result["opened"] as? Bool == false)
assert(UIApplication.shared.destination == "app-settings:")
let next = CAPPluginCall(); ForgeRunReadinessPlugin().claimExplainer(next); assert(next.result["first"] as? Bool == false)
UIApplication.shared.opened = true; plugin.openSettings(settings); assert(settings.result["opened"] as? Bool == true)
UIApplication.shared.canOpen = false; plugin.openSettings(settings); assert(settings.result["opened"] as? Bool == false)
let start = CAPPluginCall(); plugin.claimFirstRun(start); assert(start.result["first"] as? Bool == true)
ForgeRunReadinessPlugin().claimFirstRun(start); assert(start.result["first"] as? Bool == false)
print("PASS actual Swift method bodies: refresh/location/accuracy mapping, durable claims, app-settings destination (SDK doubles)")
`
  writeFileSync(path.join(temporary, 'main.swift'), stubs + body + checks)
  execFileSync('swiftc', ['-module-cache-path', path.join(temporary, 'cache'), path.join(temporary, 'main.swift'), '-o', path.join(temporary, 'bridge')], { stdio: 'pipe' })
  process.stdout.write(execFileSync(path.join(temporary, 'bridge')))
} finally { rmSync(temporary, { recursive: true, force: true }) }
assert.equal((swift.match(/@unknown default: .* = "unknown"/g) || []).length, 3)

function fixture({ nativeIOS = true, durable = new Set(), timeoutMs = 30 } = {}) {
  let value = { backgroundRefreshStatus: 'denied', locationAuthorization: 'while_using', accuracyAuthorization: 'reduced' }
  let reads = 0, adds = 0, removes = 0, settings = 0
  const listeners = new Set()
  const plugin = {
    async getStatus() { reads++; return value },
    async claimExplainer() { const first = !durable.has('explainer'); durable.add('explainer'); return { first } },
    async claimFirstRun() { const first = !durable.has('run'); durable.add('run'); return { first } },
    async openSettings() { settings++; throw Error('synthetic private native error') },
  }
  const app = { async addListener(name, fn) { assert.equal(name, 'appStateChange'); adds++; listeners.add(fn); return { async remove() { removes++; listeners.delete(fn) } } } }
  const service = policy.createRunReadiness({ nativeIOS, plugin, app, timeoutMs })
  return { service, plugin, app, durable, listeners, get reads() { return reads }, get adds() { return adds }, get removes() { return removes }, get settings() { return settings },
    set(valueNext) { value = valueNext }, foreground(isActive) { for (const fn of listeners) fn({ isActive }) } }
}
const f = fixture()
for (const refresh of ['available', 'denied', 'restricted', 'unknown', 'error', 'unavailable', 'arbitrary']) {
  for (const location of ['always', 'while_using', 'denied', 'restricted', 'not_determined', 'arbitrary']) {
    for (const accuracy of ['precise', 'reduced', 'arbitrary']) {
      f.set({ backgroundRefreshStatus: refresh, locationAuthorization: location, accuracyAuthorization: accuracy, gps_source: 'native_bg' })
      const actual = await f.service.refresh()
      assert.deepEqual(actual, { backgroundRefreshStatus: refresh === 'arbitrary' ? 'unknown' : refresh,
        locationAuthorization: location === 'arbitrary' ? 'unknown' : location, accuracyAuthorization: accuracy === 'arbitrary' ? 'unknown' : accuracy })
      assert.equal(actual.gps_source, undefined)
    }
  }
}
f.plugin.getStatus = async () => { throw Error('private error') }
assert.equal((await f.service.refresh()).backgroundRefreshStatus, 'error')
f.plugin.getStatus = () => new Promise(() => {})
assert.equal((await f.service.prepareStart()).status.backgroundRefreshStatus, 'error', 'hung bridge cannot prevent Start')
const unsupported = fixture({ nativeIOS: false })
assert.equal((await unsupported.service.refresh()).backgroundRefreshStatus, 'unavailable')
assert.equal(unsupported.reads, 0)
const stale = fixture(); let resolveOld
stale.plugin.getStatus = () => new Promise(resolve => { resolveOld = resolve })
const old = stale.service.refresh(); await tick()
stale.plugin.getStatus = async () => ({ backgroundRefreshStatus: 'denied' })
await stale.service.refresh(); resolveOld({ backgroundRefreshStatus: 'available' }); await old
assert.equal(stale.service.snapshot().backgroundRefreshStatus, 'denied')

const lifecycle = fixture()
const stop1 = lifecycle.service.mount(), stop2 = lifecycle.service.mount(); await tick()
assert.equal(lifecycle.adds, 1)
for (const refresh of ['denied', 'available', 'restricted', 'denied']) {
  lifecycle.set({ backgroundRefreshStatus: refresh })
  const before = lifecycle.reads
  lifecycle.foreground(false); lifecycle.foreground(true); lifecycle.foreground(true); await tick()
  assert.equal(lifecycle.reads, before + 1)
  assert.equal(lifecycle.service.snapshot().backgroundRefreshStatus, refresh)
}
stop1(); stop1(); await tick(); assert.equal(lifecycle.removes, 0)
stop2(); await tick(); assert.equal(lifecycle.removes, 1); assert.equal(lifecycle.listeners.size, 0)
let resolveListener, removeLate = 0
const late = fixture()
late.app.addListener = () => new Promise(resolve => { resolveListener = resolve })
const lateStop = late.service.mount(); await tick(); lateStop()
resolveListener({ remove: async () => { removeLate++ } }); await tick(); assert.equal(removeLate, 1)
const failedRemoval = fixture(); let attempts = 0
failedRemoval.app.addListener = async () => { attempts++; return { remove: async () => { throw Error('synthetic') } } }
const cleanup = failedRemoval.service.mount(); await tick(); cleanup(); await tick(); failedRemoval.service.mount(); await tick()
assert.equal(attempts, 1, 'failed removal never duplicates listener')
console.log('PASS readiness: independent closed labels, unsupported/errors/timeouts, stale replies, one listener, foreground OFF/ON, late cleanup')

// Actual JSX, with hook and native SDK doubles. Native storage survives module/relaunch recreation.
const installed = createRequire(process.env.FORGE_TEST_MODULE_ROOT ? `${process.env.FORGE_TEST_MODULE_ROOT}/package.json` : import.meta.url)
const { transformSync } = createRequire(installed.resolve('vite'))('esbuild')
const componentSource = readFileSync(new URL('../src/components/RunReadiness.jsx', import.meta.url), 'utf8')
const compiled = transformSync(componentSource, { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code
function renderExplainer(f) {
  let slots = [], cursor = 0, effects = [], dirty = true, tree, renders = 0
  const hooks = {
    useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial; return [slots[id], value => { slots[id] = value; dirty = true }] },
    useEffect(fn) { const id = cursor++; if (!(id in slots)) { slots[id] = {}; effects.push(() => { slots[id].cleanup = fn() }) } },
  }
  const modules = { react: hooks, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '@capacitor/core': { Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' }, registerPlugin: () => f.plugin }, '@capacitor/app': { App: f.app },
    '../lib/runReadiness': { createRunReadiness: () => f.service } }
  const context = { module: { exports: {} }, require: name => ({ ...modules[name], __esModule: true }) }
  vm.runInNewContext(compiled, context)
  const nodes = () => { const result = []; const walk = n => { if (Array.isArray(n)) return n.forEach(walk); if (!n || typeof n !== 'object') return; result.push(n); walk(n.props?.children) }; walk(tree); return result }
  const text = n => Array.isArray(n) ? n.map(text).join('') : typeof n === 'object' && n ? text(n.props?.children) : String(n ?? '')
  const flush = async () => { for (let i = 0; i < 40; i++) { await Promise.resolve(); if (dirty) { dirty = false; cursor = 0; effects = []; tree = context.module.exports.RunReadinessExplainer(); renders++; for (const effect of effects) effect() } } }
  return { flush, nodes, text: () => text(tree), get shown() { return !!tree }, get renders() { return renders },
    async click(label) { const button = nodes().find(n => n.type === 'button' && text(n) === label); assert.ok(button); await button.props.onClick(); await flush() },
    close() { for (const slot of slots) slot?.cleanup?.() },
  }
}
const first = fixture(), onboarding = renderExplainer(first)
await onboarding.flush(); assert.ok(onboarding.shown); assert.ok(first.durable.has('explainer'))
assert.match(onboarding.text(), /Background App Refresh.*Location Always.*Precise Location/)
assert.equal(onboarding.nodes().filter(n => ['dialog', 'alert'].includes(n.props.role)).length, 0)
await onboarding.click('Open Settings'); assert.equal(first.settings, 1); assert.match(onboarding.text(), /could not open/)
assert.equal(first.service.snapshot().backgroundRefreshStatus, 'denied')
onboarding.close()
const runEntry = renderExplainer(first); await runEntry.flush(); assert.equal(runEntry.shown, false)
const relaunched = fixture({ durable: first.durable }), secondRun = renderExplainer(relaunched)
await secondRun.flush(); assert.equal(secondRun.shown, false)
const release = relaunched.service.mount(); await tick()
for (const status of ['denied', 'available', 'denied']) {
  relaunched.set({ backgroundRefreshStatus: status, locationAuthorization: 'denied', accuracyAuthorization: 'reduced' })
  relaunched.foreground(false); relaunched.foreground(true); await secondRun.flush(); assert.equal(secondRun.shown, false)
  await relaunched.service.prepareStart(); assert.equal(secondRun.shown, false)
}
release(); secondRun.close(); runEntry.close()
const strict = fixture(); let shown = 0
strict.service.presentExplainer(() => { throw Error('unmounted presenter') })()
strict.service.presentExplainer(() => shown++)
strict.service.presentExplainer(() => { throw Error('duplicate presenter') })
await tick(); assert.equal(shown, 1)
const permission = fixture()
permission.set({ locationAuthorization: 'not_determined' })
assert.equal((await permission.service.prepareStart()).requestPermissions, true)
assert.equal((await fixture({ durable: permission.durable }).service.prepareStart()).requestPermissions, false)
assert.equal((await permission.service.prepareStart({ resume: true })).requestPermissions, false)
console.log('PASS actual explainer JSX: combined inline presentation, durable-before-Settings, failed Settings/relaunch/onboarding-to-run/second-run silence, StrictMode claim')

// Actual ActiveRun hooks/save path uses the real service; Phase 2 owns backend POST/GET rounds.
let host = readFileSync(new URL('./activeRunGps.smoke.mjs', import.meta.url), 'utf8')
host = host.slice(0, host.indexOf('for(const native of [false,true])'))
  .replaceAll('import.meta.url', JSON.stringify(new URL('./activeRunGps.smoke.mjs', import.meta.url).href))
  .replace(/from '(\.\.[^']+)'/g, (_, relative) => `from '${new URL(relative, new URL('./activeRunGps.smoke.mjs', import.meta.url)).href}'`)
const { mount } = await import('data:text/javascript;base64,' + Buffer.from(host + '\nexport { mount }').toString('base64'))
const runFixture = fixture()
const memory = { values: new Map(), getItem(k) { return this.values.get(k) }, setItem(k, v) { this.values.set(k, v) }, removeItem(k) { this.values.delete(k) } }
for (const [index, refresh] of ['denied', 'available'].entries()) {
  runFixture.set({ backgroundRefreshStatus: refresh, locationAuthorization: 'denied', accuracyAuthorization: 'reduced' })
  const app = mount({ native: index === 0, readinessService: runFixture.service }); await app.flush()
  const before = runFixture.reads
  await app.clickText('Start Run'); assert.ok(runFixture.reads > before); assert.equal(app.watches, 1)
  assert.match(app.text(), /Location: off.*Precise: off/)
  await app.fix(0); await app.tick(2); await app.fix(6)
  // Save must read again, not just retain the pre-start value or a rendered closure.
  const atSave = index === 0 ? 'restricted' : 'denied'
  runFixture.set({ backgroundRefreshStatus: atSave })
  await app.find('finish-run').props.onClick(); await app.flush()
  assert.equal(app.payload.backgroundRefreshStatus, atSave)
  assert.equal(app.payload.gps_source, index === 0 ? 'native_bg' : 'web_fallback')
  saveActiveRunSession({ phase: 'running', startedAt: 1800000000000, ...app.payload }, 'synthetic', memory, 1800000002000)
  const restored = loadActiveRunSession('synthetic', memory, 1800000002000)
  assert.equal(restored.backgroundRefreshStatus, atSave); assert.equal(restored.gps_source, app.payload.gps_source)
  saveRunCompletionHandoff({ runId: `synthetic-${index}`, queued: true, snapshot: buildRunCompletionSnapshot(app.payload), provenance: 'live_tracked' }, 'synthetic', memory, 1800000002000)
  const handoff = loadRunCompletionHandoff(`synthetic-${index}`, 'synthetic', memory, 1800000002000)
  assert.equal(handoff.snapshot.workout_metrics_json.backgroundRefreshStatus, atSave)
  assert.equal(handoff.snapshot.workout_metrics_json.gps_source, app.payload.gps_source)
  await app.close()
}
// Delayed readiness cannot revive an unmounted recorder or duplicate a save.
const detached = fixture({ timeoutMs: 1000 }); let finishRead
const detachedApp = mount({ readinessService: detached.service }); await detachedApp.flush()
detached.plugin.getStatus = () => new Promise(resolve => { finishRead = resolve })
const starting = detachedApp.clickText('Start Run'); await tick(); await detachedApp.close()
finishRead({ backgroundRefreshStatus: 'available' }); await starting
assert.equal(detachedApp.watches, 0)
const singleSave = fixture({ timeoutMs: 1000 }), savingApp = mount({ readinessService: singleSave.service })
await savingApp.flush(); await savingApp.clickText('Start Run'); await savingApp.fix(0); await savingApp.tick(2); await savingApp.fix(6)
let resolveSaveRead
singleSave.plugin.getStatus = () => new Promise(resolve => { resolveSaveRead = resolve })
const finish = savingApp.find('finish-run').props.onClick
const saves = [finish(), finish()]; await tick(); assert.equal(savingApp.saves, 0)
resolveSaveRead({ backgroundRefreshStatus: 'restricted' }); await Promise.all(saves); await savingApp.flush()
assert.equal(savingApp.saves, 1); assert.equal(savingApp.payload.backgroundRefreshStatus, 'restricted')
await savingApp.close()
let options = [], webStarts = 0, granted = false
const watcher = createPhoneGpsWatcher({ isNative: true, native: { async addWatcher(opts) { options.push(opts); throw Error('synthetic') } },
  web: { watchPosition() { webStarts++; return 1 }, clearWatch() {} }, canFallbackSilently: async () => granted, onFix() {}, onError() {} })
await watcher.start(); await watcher.restart(); assert.equal(webStarts, 0)
granted = true; await watcher.restart(); assert.equal(webStarts, 1); await watcher.stop()
assert.ok(options.every(option => option.requestPermissions === false))
for (const file of ['../src/pages/Onboarding.jsx', '../src/pages/ActiveRun.jsx']) assert.match(readFileSync(new URL(file, import.meta.url), 'utf8'), /<RunReadinessExplainer/)
assert.equal((readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8').match(/<RunReadinessLifecycle/g) || []).length, 1)
console.log('PASS actual ActiveRun: fresh every start/save, two save/reload diagnostics, watcher-only source despite denied authorization, silent fallback, Start available')
