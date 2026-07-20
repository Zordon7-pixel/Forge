const assert = require('assert');
const {
  calculateEffortFromZones,
  hasTrustedPerceivedEffort,
  resolveRunEffort,
  withCalculatedEffort,
} = require('../src/lib/runEffort');
const { summarizeRecentRunLoad } = require('../src/lib/recentRunLoad');

const recoveryRunZones = { z1: 24, z2: 309, z3: 1171, z4: 15, z5: 0 };
const calculated = calculateEffortFromZones({
  zoneSeconds: recoveryRunZones,
  durationSeconds: 1531,
});
assert.strictEqual(calculated.score, 4, 'reliable mostly-aerobic zone data produces a moderate calculated effort');
assert(calculated.coveragePct > 99, 'coverage is derived from the workout timeline when not supplied');
assert(calculated.zoneLoad > 70, 'zone-weighted training load is retained alongside the 1-10 display score');

assert.strictEqual(calculateEffortFromZones({
  zoneSeconds: { z1: 30, z2: 120, z3: 0, z4: 0, z5: 0 },
  durationSeconds: 1200,
}), null, 'sparse heart-rate coverage never produces a calculated effort');
assert.strictEqual(calculateEffortFromZones({
  zoneSeconds: { z1: 30, z2: 270, z3: 0, z4: 0, z5: 0 },
  durationSeconds: 1200,
  coveragePct: 100,
}), null, 'a source-reported percentage cannot inflate coverage beyond the actual timeline');
assert.strictEqual(calculateEffortFromZones({
  zoneSeconds: '{malformed',
  durationSeconds: 1200,
  coveragePct: 100,
}), null, 'malformed zone JSON is rejected without throwing');

const importedRun = {
  type: 'easy',
  watch_mode: 'import',
  notes: 'Imported workout',
  duration_seconds: 1531,
  perceived_effort: 5,
  heart_rate_zones: JSON.stringify(recoveryRunZones),
  workout_metrics_json: JSON.stringify({ hr_sample_coverage_pct: 99.2 }),
};
assert.strictEqual(hasTrustedPerceivedEffort(importedRun), false, 'legacy imported placeholder effort is not treated as athlete-rated RPE');
assert.strictEqual(resolveRunEffort(importedRun).source, 'calculated_hr_zones', 'reliable zone data replaces an untrusted import placeholder');

const athleteRatedRun = {
  ...importedRun,
  perceived_effort: 7,
  workout_metrics_json: JSON.stringify({ hr_sample_coverage_pct: 99.2, workout_effort_user_rated: 1 }),
};
assert.deepStrictEqual(resolveRunEffort(athleteRatedRun), { score: 7, source: 'user_rated' }, 'athlete-rated RPE always takes precedence');

const enriched = withCalculatedEffort(importedRun);
assert.strictEqual(enriched.calculated_effort, 4);
assert.strictEqual(enriched.effective_effort, 4);
assert.strictEqual(enriched.effort_source, 'calculated_hr_zones');
assert.strictEqual(enriched.calculated_effort_method, 'hr_zones_duration_v1');

assert.strictEqual(resolveRunEffort({ ...importedRun, type: 'walk' }).score, null, 'walks never receive a running-effort score');

const hardImportedRun = {
  type: 'tempo',
  date: '2026-07-19',
  distance_miles: 5,
  duration_seconds: 3600,
  watch_mode: 'import',
  notes: 'Imported workout',
  heart_rate_zones: JSON.stringify({ z1: 0, z2: 0, z3: 1800, z4: 1800, z5: 0 }),
  workout_metrics_json: JSON.stringify({ hr_sample_coverage_pct: 100 }),
  health_source: 'apple_health',
};
const load = summarizeRecentRunLoad([hardImportedRun], {
  todayISO: '2026-07-19',
  weeklyBaseline: 15,
  recoveryState: 'normal',
});
assert.strictEqual(load.latestRun.effectiveEffort, 7, 'adaptive planning receives the calculated score');
assert.strictEqual(load.latestRun.perceivedEffort, null, 'adaptive planning does not relabel calculated effort as RPE');
assert.strictEqual(load.latestRun.isHard, true, 'reliable calculated effort can protect the next hard session');
assert(load.protection.reason.includes('calculated effort 7/10'), 'protection explains calculated-effort provenance');

console.log('Run effort smoke passed');
