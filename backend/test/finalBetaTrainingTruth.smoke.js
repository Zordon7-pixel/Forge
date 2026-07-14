// Final friends-and-family beta training-truth smoke.
// Run: node backend/test/finalBetaTrainingTruth.smoke.js

const fs = require('node:fs');
const path = require('node:path');
const { computeZones, zoneForHr } = require('../src/lib/hrZones');
const { buildHealthSignals } = require('../src/lib/healthSignals');
const { hydrateHealthRow } = require('../src/lib/healthSyncMetrics');
const { normalizeWorkoutMetrics } = require('../src/lib/workoutMetrics');
const { analyzeRunHistory } = require('../src/lib/runHistory');
const { summarizeRecentRunLoad, addDays, daysBetween } = require('../src/lib/recentRunLoad');
const concurrent = require('../src/lib/concurrentPlan');

let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) {
    passed += 1;
    return;
  }
  failed += 1;
  console.error(`  FAIL: ${message}`);
}

function section(name) {
  console.log(`\n== ${name} ==`);
}

function sessions(plan) {
  return (plan.weeks || []).flatMap((week) => (week.days || []).flatMap((day) => (
    (day.sessions || []).map((session) => ({ day, session }))
  )));
}

const customMinimums = [96, 117, 137, 156, 176];
const hrProfile = { zone_model: 'custom', custom_zones_json: JSON.stringify(customMinimums) };
const run = {
  date: '2026-07-13',
  type: 'easy',
  watch_activity_type: 'Running',
  distance_miles: 7.31,
  duration_seconds: 5040,
  perceived_effort: 5,
  avg_heart_rate: 150,
  max_heart_rate: 174,
  heart_rate_zones: JSON.stringify({ z1: 31, z2: 171, z3: 2713, z4: 1785, z5: 0 }),
  health_source: 'apple_health',
  created_at: '2026-07-13T18:00:00Z',
};
const walk = {
  date: '2026-07-13',
  type: 'walk',
  watch_activity_type: 'Walking',
  distance_miles: 0.29,
  duration_seconds: 369,
  perceived_effort: 5,
  avg_heart_rate: 129,
  health_source: 'apple_health',
  created_at: '2026-07-13T20:00:00Z',
};

section('watch-calibrated activity truth');
const zones = computeZones({ model: 'custom', customMinimums }).zones;
check(zones.map((zone) => zone.minBpm).join(',') === customMinimums.join(','), 'saved watch boundaries remain exact');
check(zoneForHr(129, hrProfile) === 'Z2', '129 bpm is Zone 2');
check(zoneForHr(150, hrProfile) === 'Z3', '150 bpm is Zone 3');
check(zoneForHr(176, hrProfile) === 'Z5', 'Zone 5 begins at the saved 176 bpm threshold');

const exactHistory = analyzeRunHistory([walk, run], null, {
  now: new Date('2026-07-14T12:00:00Z'),
  hrProfile,
});
check(exactHistory.weeklyVolumeMiles === 7.3, 'walking distance never enters running volume');
check(exactHistory.zoneDistribution.Z3.count === 2713, 'well-covered native zone seconds survive exactly');
check(exactHistory.zoneDistribution.Z5.count === 0, 'a 150 bpm run is not mislabeled as max effort');

const sparseHistory = analyzeRunHistory([{ ...run, heart_rate_zones: JSON.stringify({ z5: 10 }) }], null, {
  now: new Date('2026-07-14T12:00:00Z'),
  hrProfile,
});
check(sparseHistory.zoneDistribution.Z3.count === 1, 'sparse zone samples fall back to calibrated average heart rate');
check(sparseHistory.zoneDistribution.Z5.count === 0, 'sparse Z5 samples cannot override the athlete profile');

section('recent-load and timezone safety');
const acute = summarizeRecentRunLoad([walk, run], {
  todayISO: '2026-07-14',
  weeklyBaseline: 10,
  recoveryState: 'caution',
});
check(acute.available && acute.latestRun.distanceMiles === 7.31, 'the run, not the later walk, anchors acute load');
check(acute.sevenDayMiles === 7.3 && acute.loadRatio === 0.73, 'seven-day run load excludes walks');
check(acute.latestRun.daysSince === 1 && acute.latestRun.isLong, 'yesterday\'s 84-minute run remains an active long-run signal');
check(acute.protection.hardRunsThrough === '2026-07-15', 'hard running is protected for the remaining 48-hour window');
check(acute.protection.lowerBodyThrough === '2026-07-15', 'lower-body lifting is protected for the same caution window');
check(addDays('2026-12-31', 1) === '2027-01-01', 'date-only planning crosses year boundaries without timezone drift');
check(daysBetween('2026-07-14', '2026-07-13') === 1, 'date-only elapsed days are stable across local offsets');

section('health fidelity and stale-data bounds');
const recordedAt = '2026-07-14T11:00:00.000Z';
const healthSignals = buildHealthSignals({
  sleep_hours_last_night: 7.5,
  resting_heart_rate: 55,
  hrv_ms: 62,
  active_minutes_this_week: 92,
  workout_count_this_week: 2,
  synced_at: recordedAt,
  training_metrics_json: {
    metrics_schema_version: 2,
    sleep_end_at: recordedAt,
    resting_heart_rate_recorded_at: recordedAt,
    hrv_recorded_at: recordedAt,
    vo2_max: 49.2,
    vo2_max_recorded_at: recordedAt,
    running_power_watts: 315,
    running_stride_length_m: 0.9,
    running_vertical_oscillation_cm: 8.3,
    running_ground_contact_time_ms: 269,
    running_dynamics_recorded_at: recordedAt,
  },
}, { now: new Date('2026-07-14T12:00:00Z') });
check(healthSignals.available && Number.isFinite(healthSignals.readinessScore), 'fresh recovery inputs produce bounded readiness');
check(healthSignals.metrics.vo2Max === 49.2 && healthSignals.metrics.runningPowerWatts === 315, 'fresh cardio and running dynamics reach the health snapshot');

const staleAt = '2026-07-08T12:00:00.000Z';
const staleSignals = buildHealthSignals({
  sleep_hours_last_night: 8,
  resting_heart_rate: 48,
  hrv_ms: 90,
  synced_at: staleAt,
  training_metrics_json: { sleep_end_at: staleAt, resting_heart_rate_recorded_at: staleAt, hrv_recorded_at: staleAt },
}, { now: new Date('2026-07-14T12:00:00Z') });
check(staleSignals.available === false && staleSignals.readinessScore === null, 'stale recovery data cannot create false green readiness');

const missingWorkoutMetrics = normalizeWorkoutMetrics({ source: 'apple_health' });
check(Object.keys(missingWorkoutMetrics.metrics).length === 1 && missingWorkoutMetrics.metrics.metric_source === 'apple_health', 'unavailable advanced workout values remain absent');
const hydrated = hydrateHealthRow({ steps_today: 5000, training_metrics_json: {} });
check(hydrated.running_power_watts === undefined && hydrated.vo2_max === undefined, 'storage hydration never fabricates unavailable fields');

section('adaptive hybrid prescription');
const context = {
  todayISO: '2026-07-14',
  profile: { weekly_miles_current: 10, run_days_per_week: 4, lift_days_per_week: 2 },
  target: {
    weeks: 4,
    startDate: '2026-07-14',
    distanceMiles: 10,
    planMode: 'hybrid_maintain',
    liftingEnabled: true,
    trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    runDaysPerWeek: 4,
    liftDaysPerWeek: 2,
    equipment: ['barbell', 'dumbbell', 'rack', 'bench'],
  },
  history: {
    weeklyMileageBaseline: 10,
    recentRunCount: 1,
    recentLiftCount: 2,
    recentExercises: [],
    adherenceRate: 0.8,
    acuteRunLoad: acute,
  },
  recovery: {
    state: 'caution',
    available: true,
    readinessScore: healthSignals.readinessScore,
    syncedAt: recordedAt,
    metrics: healthSignals.metrics,
  },
  checkin: { date: '2026-07-14', feeling: 3, legs: 2, drive: 2, sleepHours: 7.5, lifeFlags: [] },
};
const plan = concurrent.buildConcurrentPlan(context);
const validation = concurrent.validateConcurrentPlan(plan, context);
const allSessions = sessions(plan);
check(validation.valid, `data-aware plan validates: ${validation.errors.join('; ')}`);
check(!allSessions.some(({ day, session }) => day.date <= '2026-07-15' && concurrent.isHardRun(session)), 'no hard run survives the protected window');
check(!allSessions.some(({ day, session }) => day.date <= '2026-07-15' && session.kind === 'lift' && /lower/i.test(String(session.focus || ''))), 'no lower-body lift conflicts with long-run recovery');
check(allSessions.filter(({ session }) => session.kind === 'lift').length >= 2, 'weekly strength floor is preserved rather than deleted');
check(allSessions.filter(({ session }) => session.kind === 'lift').every(({ session }) => (
  (session.main || []).every((exercise) => exercise.sets && exercise.reps && exercise.rest && exercise.load && exercise.rpe)
)), 'every scheduled lift includes sets, reps, rest, load guidance, and effort');
check(plan.inputSummary.recentRun?.distanceMiles === 7.31, 'plan provenance names the recent run that changed training');
check(plan.inputSummary.appleHealth?.vo2Max === 49.2, 'plan provenance records fresh Apple Health context');
check(plan.inputSummary.checkin?.feeling === 3, 'plan provenance records the user check-in');

section('automatic native sync wiring');
const repoRoot = path.join(__dirname, '..', '..');
const appSource = fs.readFileSync(path.join(repoRoot, 'frontend/src/App.jsx'), 'utf8');
const healthServiceSource = fs.readFileSync(path.join(repoRoot, 'frontend/src/services/HealthService.js'), 'utf8');
check(/if \(!isNativeRuntime\(\)\) return undefined/.test(appSource), 'automatic health sync is native-only');
check(/sync\(\)[\s\S]*setInterval\(\(\) => sync\(\)/.test(appSource), 'native app open starts sync and retains a bounded refresh interval');
check(/visibilityState === 'visible'[\s\S]*sync\(\{ force: true \}\)/.test(appSource), 'returning to the foreground triggers a bounded sync');
check(/appStateChange[\s\S]*isActive[\s\S]*sync\(\{ force: true \}\)/.test(appSource), 'Capacitor active-state changes trigger sync');
check(/await this\.syncToProfile\(result\.metrics\)/.test(healthServiceSource), 'native summary metrics are sent to the authenticated profile');
check(/await this\.getWorkoutHistory\(historyOptions\)/.test(healthServiceSource), 'automatic sync requests workout history');
check(/api\.post\('\/import\/health', \{ workouts \}\)/.test(healthServiceSource), 'automatic sync imports classified workouts through the idempotent endpoint');
check(/markAutoHealthSyncAttempted\(\)/.test(healthServiceSource), 'only the completed sync path records the throttle timestamp');

console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
if (failed) process.exit(1);
console.log('FINAL BETA TRAINING TRUTH SMOKE OK');

