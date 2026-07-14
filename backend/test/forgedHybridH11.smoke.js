// Forged Hybrid H11 Apple Health training-intelligence smoke.
// Run: node backend/test/forgedHybridH11.smoke.js

const concurrentPlan = require('../src/lib/concurrentPlan');
const fs = require('fs');
const path = require('path');
const { buildHealthSignals } = require('../src/lib/healthSignals');
const {
  hydrateHealthRow,
  normalizeTrainingMetrics,
  parseTrainingMetrics,
} = require('../src/lib/healthSyncMetrics');

let passed = 0;
let failed = 0;
function check(condition, message) {
  if (condition) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${message}`); }
}
function section(name) { console.log(`\n== ${name} ==`); }

section('extended metric boundary validation');
const recordedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
const normalized = normalizeTrainingMetrics({
  metrics_schema_version: 2,
  sleep_deep_hours: 1.4,
  sleep_hours_7d_baseline: 7.2,
  hrv_ms_baseline: 58,
  vo2_max: 51.7,
  running_power_watts: 318,
  running_speed_mps: 3.71,
  running_stride_length_m: 1.19,
  running_vertical_oscillation_cm: 8.4,
  running_ground_contact_time_ms: 244,
  running_dynamics_recorded_at: recordedAt,
});
check(!normalized.error && normalized.metrics.metrics_schema_version === 2, 'valid native v2 payload is accepted');
check(normalized.metrics.vo2_max === 51.7 && normalized.metrics.running_power_watts === 318, 'cardio and running-form values survive normalization');
check(normalizeTrainingMetrics({ running_speed_mps: 99 }).error?.includes('between'), 'implausible running speed is rejected at the API boundary');
check(normalizeTrainingMetrics({ vo2_max_recorded_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() }).error?.includes('future'), 'future metric timestamps are rejected');
check(!normalizeTrainingMetrics({}).metrics.metrics_schema_version, 'legacy bridge payload cannot claim expanded coverage');

const healthServiceSource = fs.readFileSync(path.join(__dirname, '../../frontend/src/services/HealthService.js'), 'utf8');
check(
  /metrics_schema_version:\s*hasExpandedNativeAuthorization\(\)\s*\?\s*metrics\.metricsSchemaVersion\s*:\s*1/.test(healthServiceSource),
  'frontend cannot claim expanded schema coverage before the added HealthKit permissions are approved'
);

const parsed = parseTrainingMetrics(JSON.stringify({ ...normalized.metrics, blood_pressure: 'do-not-store' }));
check(parsed.vo2_max === 51.7 && parsed.blood_pressure === undefined, 'hydration keeps only the training-metric whitelist');
const hydrated = hydrateHealthRow({ hrv_ms: 49, training_metrics_json: normalized.metrics });
check(hydrated.hrv_ms === 49 && hydrated.sleep_deep_hours === 1.4, 'stored JSON hydrates alongside existing health columns');

section('fresh baseline-aware readiness');
const freshSignals = buildHealthSignals({
  sleep_hours_last_night: 6.3,
  resting_heart_rate: 66,
  hrv_ms: 45,
  active_minutes_this_week: 212,
  workout_count_this_week: 5,
  synced_at: recordedAt,
  training_metrics_json: {
    metrics_schema_version: 2,
    exercise_minutes_this_week: 184,
    sleep_end_at: recordedAt,
    sleep_hours_7d_baseline: 7.4,
    resting_heart_rate_baseline: 58,
    resting_heart_rate_recorded_at: recordedAt,
    hrv_ms_baseline: 60,
    hrv_recorded_at: recordedAt,
    vo2_max: 51.7,
    vo2_max_recorded_at: recordedAt,
  },
});
check(freshSignals.available && freshSignals.recoveryState !== 'strong', 'fresh values below athlete baselines cannot produce a strong recovery state');
check(freshSignals.metrics.sleepHours7dBaseline === 7.4 && freshSignals.metrics.hrvMsBaseline === 60, 'athlete baselines reach readiness output');
check(freshSignals.metrics.vo2Max === 51.7 && freshSignals.metrics.freshness.vo2Max, 'fresh cardio context is exposed without becoming a readiness weight');

const staleAt = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
const staleSignals = buildHealthSignals({
  sleep_hours_last_night: 8,
  resting_heart_rate: 50,
  hrv_ms: 90,
  synced_at: staleAt,
  training_metrics_json: {
    sleep_end_at: staleAt,
    resting_heart_rate_recorded_at: staleAt,
    hrv_recorded_at: staleAt,
  },
});
check(staleSignals.available === false && staleSignals.readinessScore === null, 'stale-only recovery values cannot produce a green readiness score');
check(staleSignals.metrics.freshness.sleep === false && staleSignals.metrics.freshness.hrv === false, 'staleness is explicit in the health snapshot');

const zeroSleepSignals = buildHealthSignals({
  sleep_hours_last_night: 0,
  synced_at: recordedAt,
  training_metrics_json: { sleep_end_at: recordedAt },
});
check(zeroSleepSignals.available === false && zeroSleepSignals.readinessScore === null, 'zero-hour sleep is treated as missing data, not a healthy recovery signal');

section('plan provenance');
const plan = concurrentPlan.buildConcurrentPlan({
  todayISO: '2026-07-13',
  profile: { weekly_miles_current: 15, run_days_per_week: 4, lift_days_per_week: 2 },
  target: { weeks: 4, startDate: '2026-07-13', distanceMiles: 10, planMode: 'hybrid_maintain', trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] },
  history: { weeklyMileageBaseline: 15, recentRunCount: 9, recentLiftCount: 4, adherenceRate: 0.85, missedWorkouts: 0 },
  recovery: {
    state: 'caution',
    available: true,
    dataAvailable: true,
    readinessScore: freshSignals.readinessScore,
    syncedAt: recordedAt,
    metrics: freshSignals.metrics,
  },
  checkin: { date: '2026-07-13', feeling: 3, legs: 2, drive: 2, sleepHours: 6.5, lifeFlags: [] },
});
check(plan.inputSummary.appleHealth?.vo2Max === 51.7, 'fresh cardio context is persisted in plan provenance');
check(plan.inputSummary.appleHealth?.sleepHours7dBaseline === 7.4, 'sleep baseline is persisted with plan inputs');
check(plan.inputSummary.appleHealth?.exerciseMinutesThisWeek === 184, 'fresh Apple Health activity reaches plan provenance');
check(plan.inputSummary.appleHealth?.usedFor?.includes('training-load context'), 'plan explains the bounded role of Apple Health data');

async function routeSmoke() {
  section('authenticated sync route');
  const dbPath = require.resolve('../src/db');
  const routePath = require.resolve('../src/routes/health');
  const originalDb = require.cache[dbPath];
  const originalRoute = require.cache[routePath];
  const calls = [];
  let selectedRow = null;
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    children: [],
    paths: [],
    exports: {
      dbGet: async (sql, params = []) => {
        calls.push({ sql, params: [...params] });
        if (/^\s*SELECT/i.test(sql)) return selectedRow;
        return { synced_at: recordedAt };
      },
    },
  };
  delete require.cache[routePath];

  function handler(method) {
    const router = require(routePath);
    return router.stack.find((layer) => layer.route?.path === '/sync' && layer.route?.methods?.[method])?.route?.stack?.at(-1)?.handle;
  }
  async function invoke(fn, req) {
    let statusCode = 200;
    let payload;
    const res = {
      status(code) { statusCode = code; return this; },
      json(value) { payload = value; return this; },
    };
    await fn(req, res);
    return { statusCode, payload };
  }

  try {
    const post = handler('post');
    const get = handler('get');
    let response = await invoke(post, {
      user: { id: 'h11-user' },
      body: {
        steps_today: 10000,
        sleep_hours_last_night: 7.1,
        metrics_schema_version: 2,
        sleep_hours_7d_baseline: 7.3,
        vo2_max: 51.7,
        vo2_max_recorded_at: recordedAt,
      },
    });
    const insert = calls.at(-1);
    const storedMetrics = JSON.parse(insert.params[13]);
    check(response.statusCode === 200 && response.payload?.ok, 'valid expanded sync returns 200');
    check(insert.params[0] === 'h11-user' && /ON CONFLICT \(user_id\)/.test(insert.sql), 'upsert is scoped by the authenticated user conflict key');
    check(storedMetrics.vo2_max === 51.7 && storedMetrics.metrics_schema_version === 2, 'route stores only normalized v2 metrics JSON');

    const callCount = calls.length;
    response = await invoke(post, { user: { id: 'h11-user' }, body: { running_power_watts: 9999 } });
    check(response.statusCode === 400 && calls.length === callCount, 'invalid training metrics fail before any database write');

    selectedRow = {
      hrv_ms: 45,
      avg_heart_rate_last_run: 142,
      training_metrics_json: { metrics_schema_version: 2, vo2_max: 51.7 },
      synced_at: recordedAt,
    };
    response = await invoke(get, { user: { id: 'h11-user' } });
    check(response.statusCode === 200 && response.payload.vo2_max === 51.7, 'GET returns the flattened training metric contract');
    check(response.payload.training_metrics_json === undefined && response.payload.avg_hr_bpm_last_workout === 142, 'GET hides storage detail and preserves backward-compatible aliases');
  } finally {
    if (originalDb) require.cache[dbPath] = originalDb;
    else delete require.cache[dbPath];
    if (originalRoute) require.cache[routePath] = originalRoute;
    else delete require.cache[routePath];
  }
}

routeSmoke().then(() => {
  console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
  if (failed) process.exit(1);
  console.log('H11 SMOKE OK');
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
