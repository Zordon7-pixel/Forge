import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildLiveActivityStart, buildLiveActivityUpdate, liveActivityTargetLabel } from '../src/lib/liveActivityState.js'
import { normalizeForgedDeepLink } from '../src/lib/nativeDeepLink.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
let passed = 0
const check = (condition, message) => {
  assert.ok(condition, message)
  passed += 1
}

const start = buildLiveActivityStart({
  clientRunId: 'run-123',
  startedAt: 1_700_000_000_000,
  units: 'metric',
  runType: 'recovery',
  workoutTarget: { pace: '9:00/mi', zone: 'Zone 2' },
})
check(start.unit === 'km' && start.title === 'Recovery run', 'start payload respects run type and units')
check(start.targetLabel === '9:00/mi · Zone 2', 'planned target stays concise')
check(liveActivityTargetLabel({ pace: 'x'.repeat(80), zone: 'Zone 2' }).length <= 24, 'planned target is bounded')

const fresh = buildLiveActivityUpdate({
  startedAt: 1_700_000_000_000,
  elapsed: 600,
  distanceMiles: 1,
  units: 'metric',
  liveHr: 151,
  hrLastUpdated: 1_700_000_010_000,
  hrZone: { key: 'Z3', color: '#F97316' },
  mapMyRun: true,
  gpsStarted: true,
  gpsAvailable: true,
  currentAccuracy: 6.4,
  now: 1_700_000_020_000,
})
check(fresh.distance === 1.609 && fresh.paceSecPerUnit === 373, 'metric distance and measured average pace are derived from recorded values')
check(fresh.heartRate === 151 && fresh.hrFresh && fresh.hrZoneKey === 'Z3', 'fresh HR and its measured zone are included')
check(fresh.gpsState === 'tracking' && fresh.gpsAccuracyMeters === 6, 'GPS status and accuracy are explicit')

const stale = buildLiveActivityUpdate({ liveHr: 151, hrLastUpdated: 1, hrZone: { key: 'Z5', color: '#FFF6DC' }, mapMyRun: false, now: 100_000 })
check(stale.heartRate === 0 && !stale.hrFresh && stale.hrZoneKey === '', 'stale HR never appears as live')
check(stale.distance === -1 && stale.gpsState === 'off', 'route-off mode does not invent measured distance')

check(normalizeForgedDeepLink('forgedhybrid://run/active') === '/run/active', 'widget deep link resolves to the active run')
check(normalizeForgedDeepLink('forgedhybrid://history') === null && normalizeForgedDeepLink('https://example.com/run/active') === null, 'unapproved deep links fail closed')

const activeRun = read('frontend/src/pages/ActiveRun.jsx')
const appViewController = read('frontend/ios/App/App/AppViewController.swift')
const appInfo = read('frontend/ios/App/App/Info.plist')
const project = read('frontend/ios/App/App.xcodeproj/project.pbxproj')
const widget = read('frontend/ios/App/ForgeRunActivity/ForgeRunLiveActivity.swift')
check(activeRun.includes('LiveActivityService.start') && activeRun.includes('LiveActivityService.end'), 'ActiveRun owns the Live Activity lifecycle')
check(activeRun.includes('LIVE_ACTIVITY_UPDATE_INTERVAL_MS'), 'ActiveRun throttles bridge updates')
check(appViewController.includes('ForgeLiveActivityPlugin()'), 'native plugin is registered with Capacitor')
check(appInfo.includes('<key>NSSupportsLiveActivities</key>') && appInfo.includes('<string>forgedhybrid</string>'), 'app declares Live Activities and its deep-link scheme')
check(project.includes('ForgeRunActivity.appex') && project.includes('Embed App Extensions'), 'widget extension is embedded in the app target')
check(widget.includes('widgetURL(URL(string: "forgedhybrid://run/active"))'), 'Live Activity taps reopen the active run')
check(widget.includes('Text(timerInterval:'), 'elapsed time is rendered by ActivityKit without per-second bridge traffic')

console.log(`LIVE ACTIVITY SMOKE OK (${passed})`)
