import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')
const servicePath = path.join(repoRoot, 'frontend/src/services/SmartStartMotionService.js')

assert.ok(fs.existsSync(servicePath), 'Smart Start motion classifier/service is implemented')

const {
  candidateFingerprint,
  classifyMissedRun,
  createSmartStartMotionService,
  isCandidateSuppressed,
  suppressCandidate,
  toManualLogRunPrefill,
} = await import(pathToFileURL(servicePath).href)

let passed = 1
const check = (condition, message) => {
  assert.ok(condition, message)
  passed += 1
}

const startDate = '2026-08-20T10:00:00.000Z'
const endDate = '2026-08-20T10:32:00.000Z'
const pedometer = {
  startDate,
  endDate,
  steps: 5_120,
  distanceMeters: 5_180,
  averageActivePaceSecondsPerMeter: 0.37,
  cadenceStepsPerSecond: 2.67,
}

const plausibleHistory = {
  activitySegments: [{ startDate, endDate, activity: 'running', running: true, walking: false, automotive: false, confidence: 'high' }],
  pedometerSummaries: [pedometer],
}

const walking = classifyMissedRun({
  activitySegments: [{ startDate, endDate, activity: 'walking', running: false, walking: true, automotive: false, confidence: 'high' }],
  pedometerSummaries: [pedometer],
})
check(walking === null, 'ordinary walking is rejected even with run-like pedometer totals')

const automotive = classifyMissedRun({
  activitySegments: [{ startDate, endDate, activity: 'automotive', running: true, walking: false, automotive: true, confidence: 'high' }],
  pedometerSummaries: [pedometer],
})
check(automotive === null, 'automotive activity is rejected even when a running flag is also present')

const unclassified = classifyMissedRun({
  activitySegments: [{ startDate, endDate, activity: 'unknown', running: false, walking: false, automotive: false, confidence: 'medium' }],
  pedometerSummaries: [pedometer],
})
check(unclassified === null, 'pedometer evidence without a running classification is rejected')

const tooShort = classifyMissedRun({
  activitySegments: [{ startDate, endDate: '2026-08-20T10:04:00.000Z', activity: 'running', running: true, automotive: false }],
  pedometerSummaries: [{ ...pedometer, endDate: '2026-08-20T10:04:00.000Z', steps: 900, distanceMeters: 900 }],
})
check(tooShort === null, 'too-short running intervals are rejected')

const invalid = classifyMissedRun({
  activitySegments: plausibleHistory.activitySegments,
  pedometerSummaries: [{ ...pedometer, distanceMeters: Number.POSITIVE_INFINITY }],
})
check(invalid === null, 'non-finite pedometer evidence is rejected')

const weakEvidence = classifyMissedRun({
  activitySegments: plausibleHistory.activitySegments,
  pedometerSummaries: [{ ...pedometer, steps: 120, distanceMeters: 160 }],
})
check(weakEvidence === null, 'a running label without plausible pedometer evidence is rejected')

const candidate = classifyMissedRun(plausibleHistory)
check(candidate?.startDate === startDate && candidate?.endDate === endDate, 'a plausible classified run becomes a normalized candidate')
check(candidate?.steps === 5_120 && candidate?.distanceMeters === 5_180 && candidate?.durationSeconds === 1_920, 'accepted candidate retains measured summary evidence')
check(candidate?.counting === false && candidate?.route === null && candidate?.routeStatus === 'missing', 'a recovered candidate is non-counting and has no fabricated route')
check(!('coordinates' in candidate) && /GPS had not started/i.test(candidate?.routeMessage || ''), 'route truth explains why geometry is unavailable')

const memoryStorage = new Map()
const storage = {
  getItem: (key) => memoryStorage.get(key) ?? null,
  setItem: (key, value) => memoryStorage.set(key, String(value)),
}
check(!isCandidateSuppressed(candidate, storage), 'a new candidate is not suppressed')
suppressCandidate(candidate, storage)
check(isCandidateSuppressed(candidate, storage), 'dismissing suppresses the exact deterministic candidate')
check(!isCandidateSuppressed({ ...candidate, endDate: '2026-08-20T10:33:00.000Z' }, storage), 'a different candidate is not hidden by exact suppression')
check(candidateFingerprint(candidate) === candidate.id, 'candidate identity is deterministic from normalized evidence')

const prefill = toManualLogRunPrefill(candidate)
assert.deepEqual(prefill, {
  date: '2026-08-20',
  distanceMeters: 5_180,
  durationSeconds: 1_920,
})
passed += 1
check(!('route' in prefill) && !('coordinates' in prefill) && !('counting' in prefill), 'Add hands only supported summary fields to manual Log Run')

const unavailableService = createSmartStartMotionService({
  capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', isPluginAvailable: () => false },
  plugin: {},
  storage,
})
const unavailable = await unavailableService.findRecentCandidate({ now: new Date('2026-08-20T12:00:00.000Z') })
check(unavailable.ok === false && unavailable.reason === 'plugin_unavailable', 'an older native shell without the plugin fails soft')
check(unavailableService.isEnabled() === false, 'Smart Start preference defaults OFF')
unavailableService.setEnabled(true)
check(unavailableService.isEnabled() === true, 'the opt-in preference is stored only in injected local storage')

let browserPluginCalls = 0
const browserService = createSmartStartMotionService({
  capacitor: { isNativePlatform: () => false, getPlatform: () => 'web', isPluginAvailable: () => false },
  plugin: { getStatus: async () => { browserPluginCalls += 1 } },
  storage,
})
const browserResult = await browserService.findRecentCandidate({ now: new Date('2026-08-20T12:00:00.000Z') })
check(browserResult.reason === 'plugin_unavailable' && browserPluginCalls === 0, 'ordinary browser/PWA use never invokes the native bridge')

let deniedQueryCount = 0
const deniedService = createSmartStartMotionService({
  capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', isPluginAvailable: () => true },
  plugin: {
    getStatus: async () => ({ available: true, authorization: 'denied' }),
    queryHistory: async () => { deniedQueryCount += 1; throw new Error('must not query denied history') },
  },
  storage,
})
const denied = await deniedService.findRecentCandidate({ now: new Date('2026-08-20T12:00:00.000Z') })
check(denied.ok === false && denied.reason === 'denied' && deniedQueryCount === 0, 'denied Motion access fails soft without querying history or affecting manual Start')

let boundedQuery = null
const boundedService = createSmartStartMotionService({
  capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios', isPluginAvailable: () => true },
  plugin: {
    getStatus: async () => ({ available: true, authorization: 'authorized' }),
    queryHistory: async (query) => { boundedQuery = query; return { activitySegments: [], pedometerSummaries: [] } },
  },
  storage,
})
await boundedService.findRecentCandidate({ now: new Date('2026-08-20T12:00:00.000Z'), recoveryWindowMs: 30 * 24 * 60 * 60 * 1000 })
check(Date.parse(boundedQuery.endDate) - Date.parse(boundedQuery.startDate) === 7 * 24 * 60 * 60 * 1000, 'web service also clamps requested history to seven days')

const serviceSource = read('frontend/src/services/SmartStartMotionService.js')
const appSource = read('frontend/src/App.jsx')
const settingsSource = read('frontend/src/pages/Settings.jsx')
const logRunSource = read('frontend/src/pages/LogRun.jsx')
const pluginSource = read('frontend/ios/App/App/ForgeMotionPlugin.swift')
const appViewController = read('frontend/ios/App/App/AppViewController.swift')
const infoPlist = read('frontend/ios/App/App/Info.plist')
const project = read('frontend/ios/App/App.xcodeproj/project.pbxproj')
const appJson = JSON.parse(read('frontend/app.json')).expo

check(/isPluginAvailable\('ForgeMotion'\)/.test(serviceSource), 'web service checks native plugin presence before every bridge path')
check(/requestAuthorization/.test(settingsSource) && /probable run/i.test(settingsSource) && /battery/i.test(settingsSource), 'Settings owns the explicit opt-in with privacy and battery copy')
check(/Missed-start detection requires Forged Hybrid build 20 on a supported iPhone\. Manual Start Run still works\./.test(settingsSource) && !/Missed-start detection requires Forged Hybrid build 21\b/.test(settingsSource), 'Settings names Smart Start build 20 and contains no stale build 21 requirement')
check(appSource.includes('It looks like you ran. Add or match this workout?'), 'the app shell presents the approved recovery prompt')
check(/toManualLogRunPrefill\(candidate\)/.test(appSource) && /smartStartPrefill/.test(logRunSource), 'Add routes summary prefill into the existing manual Log Run flow')
check(!/api\.(post|put|patch)\(['"`]\/runs/.test(appSource), 'the app-shell candidate never creates a run directly')
check(pluginSource.includes('CMMotionActivityManager') && pluginSource.includes('CMPedometer'), 'native bridge uses Core Motion activity and pedometer history')
check(pluginSource.includes('CMPedometer.isDistanceAvailable()'), 'native availability fails honestly when measured pedometer distance is unsupported')
check(pluginSource.includes('maximumHistoryInterval') && pluginSource.includes('7 * 24 * 60 * 60'), 'native history is bounded to seven days')
check(appViewController.includes('registerPluginInstance(ForgeMotionPlugin())'), 'ForgeMotion is registered with Capacitor')
check(/<key>NSMotionUsageDescription<\/key>\s*<string>[^<]*probable runs[^<]*missed Start[^<]*<\/string>/i.test(infoPlist), 'Info.plist explains probable-run detection and missed-Start recovery')
check((project.match(/ForgeMotionPlugin\.swift in Sources/g) || []).length >= 2, 'ForgeMotion has a file reference and app-target Sources membership')

const expectedBuild = process.env.FORGE_EXPECTED_SMART_START_BUILD || '20'
const projectBuilds = new Set([...project.matchAll(/CURRENT_PROJECT_VERSION = ([0-9]+);/g)].map((match) => match[1]))
check(projectBuilds.size === 1 && projectBuilds.has(expectedBuild) && appJson.ios.buildNumber === expectedBuild, `all native targets and app.json use build ${expectedBuild}`)
check(appJson.ios.infoPlist.NSMotionUsageDescription === 'Forged Hybrid uses Motion & Fitness history to detect probable runs and help recover a workout when you missed Start. Motion data is checked only after you opt in.', 'EAS metadata carries the exact Motion purpose string')

console.log(`SMART START MOTION SMOKE OK (${passed})`)
