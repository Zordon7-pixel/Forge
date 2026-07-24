import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  ACTIVE_RUN_MAP_LAYOUT_KEY,
  activeRunBackDecision,
  activeRunMapCommand,
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
assert.match(activeRunSource, /role="group"[\s\S]*aria-label="Live map view"/)
assert.match(activeRunSource, /aria-pressed=\{selected\}/)
assert.match(activeRunSource, /minHeight: 44/)
assert.match(activeRunSource, /data-testid="finish-run"/)
assert.match(activeRunSource, /Map hidden for Stats view · GPS recording and run metrics continue\./)
assert.match(activeRunSource, /addListener\('backButton'/, 'native/system back uses the same Active Run guard')
assert.match(activeRunSource, /window\.addEventListener\('popstate'/, 'browser back uses the Active Run guard')
assert.match(activeRunSource, /activeRunMapCommand\(mapLayout/, 'the rendered map consumes the executable layout policy')

console.log('ACTIVE RUN CONTROLS SMOKE OK')
