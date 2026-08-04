import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  buildRunComparison,
  formatPlannedPaceTarget,
  normalizeRunSplits,
  parsePlannedRun,
  parseRunRoute,
  parseZoneTimeline,
  resolveRunHeartRateZone,
  targetZoneNumber,
  targetZoneNumbers,
} from '../src/lib/runRecap.js'

let passed = 0
function check(condition, message) {
  assert.ok(condition, message)
  passed += 1
}

console.log('\n== planned versus recorded truth ==')
const planned = parsePlannedRun(JSON.stringify({
  sessionId: 'session-1',
  title: 'Easy aerobic run',
  distanceMiles: 3,
  durationMinutes: 30,
  paceTarget: '10:00/mi',
  targetZone: 'Zone 2',
}))
check(planned?.sessionId === 'session-1', 'stored plan snapshot parses')
check(parsePlannedRun('{}') === null, 'empty plan snapshot remains absent')
check(targetZoneNumber('Z4 threshold') === 4, 'target zone parser accepts compact labels')
check(JSON.stringify(targetZoneNumbers('Zone 1-2')) === JSON.stringify([1, 2]), 'target zone parser preserves multi-zone prescriptions')
check(formatPlannedPaceTarget('10:00/mi', 'metric') === '6:13/km', 'single pace targets convert for metric comparison')
check(formatPlannedPaceTarget('10:00-10:45/mi', 'metric') === '6:13-6:41/km', 'pace ranges convert for metric comparison')
check(formatPlannedPaceTarget('Conversational effort', 'metric') === 'Conversational effort', 'effort-language targets remain unchanged')

const comparison = buildRunComparison({
  distance_miles: 3.1,
  duration_seconds: 1860,
  planned_session_json: planned,
  heart_rate_zones: { z1: 120, z2: 1320, z3: 300, z4: 60, z5: 0 },
})
check(comparison.hasPlan, 'comparison recognizes stored prescription')
check(comparison.plannedDistanceMiles === 3, 'planned distance remains immutable truth')
check(comparison.actualDistanceMiles === 3.1, 'recorded distance remains actual truth')
check(Math.round(comparison.actualPaceSeconds) === 600, 'actual pace derives from recorded time and distance')
check(Math.round(comparison.zoneAdherencePct) === 73, 'zone adherence uses complete calibrated timeline')
check(comparison.adherenceScore >= 85 && comparison.adherenceLabel === 'On plan', 'available objective targets produce an on-plan score')
check(comparison.adherenceComponents.map((item) => item.key).join(',') === 'distance,pace,zone', 'duration is not double-counted when distance is prescribed')

const rangeComparison = buildRunComparison({
  distance_miles: 2,
  duration_seconds: 1200,
  planned_session_json: { targetZone: 'Zone 1-2' },
  heart_rate_zones: { z1: 120, z2: 900, z3: 180, z4: 0, z5: 0 },
})
check(Math.round(rangeComparison.zoneAdherencePct) === 85, 'multi-zone adherence sums the full prescribed range')

const legacy = buildRunComparison({ distance_miles: 2, duration_seconds: 1200, planned_session_json: '{}' })
check(!legacy.hasPlan && legacy.planned === null, 'legacy run never fabricates a plan target')

const partialTimeline = parseZoneTimeline({ z2: 100 }, 1200)
check(!partialTimeline.trusted, 'sparse heart-rate timeline is not trusted')
const partial = buildRunComparison({
  distance_miles: 2,
  duration_seconds: 1200,
  planned_session_json: { targetZone: 'Zone 2' },
  heart_rate_zones: { z2: 100 },
})
check(partial.zoneAdherencePct === null, 'sparse timeline never claims zone adherence')
check(partial.adherenceScore === null, 'a zone-only target with sparse coverage never fabricates adherence')

const dominantZone = resolveRunHeartRateZone({
  duration_seconds: 1200,
  avg_hr: 129,
  heart_rate_zones: { z1: 120, z2: 180, z3: 780, z4: 60, z5: 0 },
}, [
  { minBpm: 96 },
  { minBpm: 117 },
  { minBpm: 137 },
  { minBpm: 156 },
  { minBpm: 176 },
])
check(dominantZone?.zone === 3 && dominantZone.source === 'timeline', 'trusted heart-rate timeline wins over average-HR classification')
check(Math.round(dominantZone?.dominantPct || 0) === 68, 'dominant-zone percentage explains the recorded evidence')

console.log('\n== splits and route normalization ==')
const splits = normalizeRunSplits(JSON.stringify([
  { label: 'Mile 1', distance_miles: 1, duration_seconds: 590 },
  { mile: 2, pace: '9:40/mi' },
  0.25,
  { ignored: true },
]))
check(splits.length === 3, 'valid object and manual-lap splits survive')
check(Math.round(splits[0].paceSeconds) === 590, 'split pace derives from distance and duration')
check(splits[1].paceSeconds === 580, 'formatted pace split parses')
check(splits[2].distanceMiles === 0.25 && splits[2].paceSeconds === null, 'ambiguous numeric treadmill lap remains distance-only')
check(normalizeRunSplits('{bad json').length === 0, 'malformed split JSON fails closed')

const route = parseRunRoute(JSON.stringify([
  { lat: 38.9, lon: -77.0, time: '2026-07-14T12:00:00Z' },
  [38.91, -76.99],
  { lat: 200, lon: 1 },
]))
check(route.length === 2, 'valid recorded route points render and invalid coordinates drop')
check(parseRunRoute('not-json').length === 0, 'malformed route JSON fails closed')

console.log('\n== route wiring and ownership ==')
const appSource = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const activeRunSource = fs.readFileSync(new URL('../src/pages/ActiveRun.jsx', import.meta.url), 'utf8')
const logRunSource = fs.readFileSync(new URL('../src/pages/LogRun.jsx', import.meta.url), 'utf8')
const recapSource = fs.readFileSync(new URL('../src/pages/RunRecap.jsx', import.meta.url), 'utf8')
const runsRouteSource = fs.readFileSync(new URL('../../backend/src/routes/runs.js', import.meta.url), 'utf8')
check(appSource.includes('path="/run/recap/:id"'), 'authenticated app route exposes the dedicated recap')
check(activeRunSource.includes('saveRunCompletionHandoff({') && activeRunSource.includes('exitActiveRun(completionNavigation.destination'), 'tracked runs persist then replace-navigate to the saved recap')
check(logRunSource.includes('navigate(completion.destination, { replace: true })'), 'manual runs continue directly to the provenance-aware saved recap')
check(recapSource.includes('api.get(`/runs/${encodeURIComponent(id)}`)'), 'recap fetches the exact run instead of a capped history page')
const historySource = fs.readFileSync(new URL('../src/pages/History.jsx', import.meta.url), 'utf8')
check(historySource.includes('api.get(`/runs/${encodeURIComponent(run.id)}`)'), 'History enriches an imported run before opening its comparison')
check(/SELECT \* FROM runs WHERE id=\? AND user_id=\?/.test(runsRouteSource), 'run detail lookup is owner scoped')

console.log(`\nPASSED: ${passed}  FAILED: 0`)
console.log('PHASE 1 RUN RECAP SMOKE OK')
