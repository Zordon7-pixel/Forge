// Forged Hybrid H12 Apple Health activity-integrity smoke.
// Run: node backend/test/forgedHybridH12.smoke.js

const fs = require('fs');
const path = require('path');
const { computeZones, zoneForHr } = require('../src/lib/hrZones');
const { analyzeRunHistory } = require('../src/lib/runHistory');
const { activityKind, isRunActivity, runActivitySql } = require('../src/lib/runActivity');
const { buildRunImportKeys } = require('../src/lib/runImportKey');
const { normalizeWorkoutMetrics } = require('../src/lib/workoutMetrics');
const autoUpdatePRs = require('../src/services/prAuto');

let passed = 0;
let failed = 0;
function check(condition, message) {
  if (condition) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${message}`); }
}
function section(name) { console.log(`\n== ${name} ==`); }

section('activity classification');
check(activityKind({ type: 'walk', watch_activity_type: 'Walking' }) === 'walk', 'Apple Health walking remains a walk');
check(activityKind({ type: 'easy', watch_activity_type: 'Cycling' }) === 'cycling', 'legacy cycling rows are not treated as runs');
check(activityKind({ type: 'easy' }) === 'run' && isRunActivity({ type: 'tempo' }), 'manual easy/tempo rows remain runs');
check(!isRunActivity({ type: 'swimming' }) && !isRunActivity({ watch_normalized_type: 'walk_outdoor' }), 'cross-training and walks are excluded from run intelligence');
check(autoUpdatePRs.buildRunPrCandidates({ type: 'walk', distance_miles: 5, duration_seconds: 3600 }).length === 0, 'manual walks cannot create running PR candidates');
const tenMileCandidates = autoUpdatePRs.buildRunPrCandidates({ type: 'run', distance_miles: 10.02, duration_seconds: 5700 });
check(tenMileCandidates.some((candidate) => candidate.label === '10 Mile PR'), 'synced Army Ten-Miler-distance runs create a 10-mile PR candidate');
const adjacentDistanceCandidates = autoUpdatePRs.buildRunPrCandidates({ type: 'run', distance_miles: 9.7, duration_seconds: 5700 });
check(adjacentDistanceCandidates.filter((candidate) => /(?:15K|10 Mile) PR/.test(candidate.label)).length === 1, 'one run maps to only its nearest standard race distance');
const activitySql = runActivitySql('r');
check(activitySql.includes("r.watch_activity_type") && activitySql.includes("NOT LIKE '%walk%'") && activitySql.includes("NOT LIKE '%cycl%'"), 'shared SQL guard checks raw and normalized activity types');

section('watch-exact heart-rate zones');
const customMinimums = [96, 117, 137, 156, 176];
const custom = computeZones({ model: 'custom', customMinimums });
check(custom.zones.map((zone) => zone.minBpm).join(',') === customMinimums.join(','), 'custom zone starts are preserved exactly');
const profile = { zone_model: 'custom', custom_zones_json: JSON.stringify(customMinimums) };
check(zoneForHr(129, profile) === 'Z2', '129 bpm maps to watch Zone 2, not maximum effort');
check(zoneForHr(150, profile) === 'Z3', '150 bpm maps to watch Zone 3, not maximum effort');
check(zoneForHr(176, profile) === 'Z5', 'the athlete watch threshold starts Zone 5');

section('run load and sparse heart-rate data');
const now = new Date();
const recentDate = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const history = analyzeRunHistory([
  { date: recentDate, type: 'walk', watch_activity_type: 'Walking', distance_miles: 0.29, duration_seconds: 369, avg_heart_rate: 129 },
  { date: recentDate, type: 'easy', watch_activity_type: 'Running', distance_miles: 7.31, duration_seconds: 5040, avg_heart_rate: 150, heart_rate_zones: JSON.stringify({ z1: 0, z2: 0, z3: 0, z4: 0, z5: 10 }) },
], null, { now, hrProfile: profile });
check(history.available && history.weeklyVolumeMiles === 7.3, 'walk distance is absent from weekly run load');
check(history.zoneDistribution.Z3.count === 1 && history.zoneDistribution.Z5.count === 0, 'sparse imported zone seconds cannot override calibrated average HR');

section('advanced metric validation');
const normalizedMetrics = normalizeWorkoutMetrics({
  runningPowerWatts: 318,
  runningStrideLengthM: 0.9,
  runningVerticalOscillationCm: 8.3,
  runningGroundContactTimeMs: 269,
  groundContactBalanceLeftPct: 48.1,
  groundContactBalanceRightPct: 51.9,
  respiratoryRateAvg: 33,
  respiratoryRateMax: 43,
  performanceCondition: -2,
  source: 'garmin_csv',
});
check(normalizedMetrics.metrics.running_power_watts === 318 && normalizedMetrics.metrics.running_ground_contact_time_ms === 269, 'supported dynamics survive normalization');
check(normalizedMetrics.metrics.ground_contact_balance_left_pct === 48.1 && normalizedMetrics.metrics.performance_condition === -2, 'Garmin-only file metrics survive normalization');
check(normalizeWorkoutMetrics({ runningPowerWatts: 9999 }).droppedFields.includes('running_power_watts'), 'implausible metrics are dropped at the boundary');

section('import and native bridge wiring');
const importRoute = require('../src/routes/import');
const { classifyType, normalizeRouteCoords, normalizeRow, importKeysForItem } = importRoute._test;
check(classifyType('Walking').section === 'activity' && classifyType('Walking').runType === 'walk', 'walking imports enter activity history, not run planning');
check(classifyType('Cycling').runType === 'cycling' && classifyType('Swimming').runType === 'swimming', 'other HealthKit workout types retain their identity');
const walk = normalizeRow({ type: 'Walking', date: recentDate, distanceMiles: 0.29, durationSeconds: 369, avgHeartRate: 129, source: 'apple_health' });
check(walk.runType === 'walk' && walk.perceivedEffort === null, 'imported walking has no invented run type or RPE');
const sparseRun = normalizeRow({ type: 'Running', date: recentDate, durationSeconds: 1531, zoneSeconds: { z1: 0, z2: 30, z3: 90, z4: 60, z5: 210 }, source: 'apple_health' });
check(sparseRun.workoutMetrics.hr_sample_coverage_pct === 25.5, 'import records sparse HealthKit HR coverage instead of presenting it as a full timeline');
const keyedRun = normalizeRow({ id: 'healthkit-workout-1', type: 'Running', startDate: `${recentDate}T12:00:00.000Z`, distanceMiles: 2.173, durationSeconds: 1531, source: 'apple_health' });
const incomingKeys = importKeysForItem(keyedRun);
const legacyDeleteKeys = buildRunImportKeys({ healthSource: 'apple_health', startDate: keyedRun.startDate, type: keyedRun.runType, distanceMiles: keyedRun.distanceMiles, durationSeconds: keyedRun.durationSeconds });
check(incomingKeys.length === 2 && legacyDeleteKeys.some((key) => incomingKeys.includes(key)), 'Apple Health imports retain both a source-id key and a legacy fingerprint tombstone key');
const coords = normalizeRouteCoords([{ lat: 38.9, lon: -77.0, alt: 42, time: '2026-07-12T12:00:00Z' }, { lat: 999, lon: 0 }]);
check(coords.length === 1 && coords[0].alt === 42 && coords[0].time.endsWith('Z'), 'valid HealthKit routes retain coordinate provenance and reject invalid points');

const root = path.join(__dirname, '..', '..');
const swift = fs.readFileSync(path.join(root, 'frontend/ios/App/App/ForgeHealthPlugin.swift'), 'utf8');
const service = fs.readFileSync(path.join(root, 'frontend/src/services/HealthService.js'), 'utf8');
const historySource = fs.readFileSync(path.join(root, 'frontend/src/pages/History.jsx'), 'utf8');
const insightsSource = fs.readFileSync(path.join(root, 'frontend/src/components/InsightsSheet.jsx'), 'utf8');
const runDetailSource = fs.readFileSync(path.join(root, 'frontend/src/components/RunDetailModal.jsx'), 'utf8');
const hrZonesSource = fs.readFileSync(path.join(root, 'frontend/src/pages/HrZones.jsx'), 'utf8');
const runsRouteSource = fs.readFileSync(path.join(root, 'backend/src/routes/runs.js'), 'utf8');
const importRouteSource = fs.readFileSync(path.join(root, 'backend/src/routes/import.js'), 'utf8');
const stravaRouteSource = fs.readFileSync(path.join(root, 'backend/src/routes/strava.js'), 'utf8');
const prAutoSource = fs.readFileSync(path.join(root, 'backend/src/services/prAuto.js'), 'utf8');
check(/HKSeriesType\.workoutRoute\(\)/.test(swift) && /row\["routeCoords"\]\s*=\s*route\.points/.test(swift), 'native bridge requests and serializes HealthKit workout routes');
check(/workout\.statistics\(for: type\)/.test(swift) && /timeWeightedAverage/.test(swift), 'workout-owned HR summary wins over a time-weighted sparse-sample fallback');
check(/predicateForObjects\(from: workout\)/.test(swift) && /workout\.sourceRevision\.source/.test(swift), 'heart-rate samples are scoped to the workout or its source');
check(!/suppliedMaxHR\s*\?\?\s*observedMaxHR/.test(swift), 'an observed workout maximum is never reused as the athlete zone maximum');
check(/call\.getArray\("zoneMinimums"/.test(swift) && /historyOptions\.zoneMinimums\s*=\s*zones\.map/.test(service), 'saved watch boundaries reach native sample bucketing');
check(/REQUIRED_HEALTH_AUTH_VERSION\s*=\s*4/.test(service) && /REQUIRED_WORKOUT_IMPORT_VERSION\s*=\s*5/.test(service), 'workout-effort permission upgrade and corrected workout summaries trigger a v5 full-history refresh once');
check(/workoutUpgradeAvailable[\s\S]*workoutHistoryUpgradeRequired/.test(service), 'an old native shell cannot mark the v5 import complete before the corrected plugin arrives');
check(/let profile\s*=\s*null[\s\S]*profile\s*=\s*data\?\.profile/.test(service), 'native sync keeps the HR profile in scope for its response');
check(/if \(history\.available\)[\s\S]*markWorkoutHistoryUpgraded\(\)[\s\S]*else[\s\S]*markHealthResyncNeeded\(\)/.test(service), 'only a successful full-history read completes the import upgrade');
check(/actualRuns[^\n]*filter\(isRunningActivity\)/.test(historySource), 'History run totals and charts use running activities only');
check(/INSERT INTO run_import_tombstones[\s\S]*ON CONFLICT \(user_id, source_key\) DO NOTHING/.test(runsRouteSource), 'deleting a health import records a user-scoped tombstone before removing the run');
check(/SELECT id FROM run_import_tombstones WHERE user_id=\? AND source_key=\?/.test(importRouteSource), 'future full health syncs honor deleted-run tombstones');
check(/updateImportedRunPrs\(userId, runId\)/.test(importRouteSource), 'Apple Health and file imports update automatic PRs without requiring PR Wall to be opened');
check(/autoUpdatePRs\(req\.user\.id, syncedRun, \{ tx \}\)/.test(stravaRouteSource), 'Strava sync updates automatic PRs in the same user-scoped transaction');
check(/Pace Z\$\{paceZone\.zone\}/.test(historySource) && !/`Zone \$\{paceZone\.zone\}`/.test(historySource), 'pace zones are labeled so they cannot be mistaken for heart-rate zones');
check(/activityLabel\(item\)/.test(insightsSource), 'recent activity cards display the imported workout kind');
check(/T12:00:00/.test(insightsSource) && /T12:00:00/.test(runDetailSource), 'date-only HealthKit workouts render on the local calendar day');
check(/zone\.openEnded/.test(hrZonesSource), 'the custom Zone 5 boundary renders as open-ended');
check(/activityKindChanged[\s\S]*shouldRecomputePrs[\s\S]*\|\| activityKindChanged/.test(runsRouteSource), 'changing a run into a walk recomputes and removes stale run PRs');
check((prAutoSource.match(/UPDATE personal_records[^;]+WHERE id = \? AND user_id = \?/g) || []).length === 2, 'automatic PR updates remain scoped to the authenticated user');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
