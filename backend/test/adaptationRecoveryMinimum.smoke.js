// Forge minimum-effective recovery-session policy regression.
// Run: node backend/test/adaptationRecoveryMinimum.smoke.js

const assert = require('node:assert/strict');
const adaptation = require('../src/lib/adaptationEngine');
const racesRouter = require('../src/routes/races');

const persistedHyroxConfig = racesRouter._test.normalizeRaceEvent({
  race_name: 'Fixture HYROX',
  event_kind: 'hyrox',
  event_local_date: '2026-09-06',
  event_timezone: 'America/New_York',
  event_format: 'doubles',
  event_category: 'men',
  rules_version: '2026-2027',
  event_config_json: {
    schemaVersion: 1,
    equipment: ['ski_erg'],
    runningPriority: 'maintain',
    runDaysPerWeek: 4,
    trainingDays: ['Mon', 'Wed', 'Fri', 'Sun'],
  },
});
assert.equal(persistedHyroxConfig.valid, true, persistedHyroxConfig.error);
assert.deepEqual(JSON.parse(persistedHyroxConfig.value.event_config_json), {
  schemaVersion: 1,
  equipment: ['ski_erg'],
  runningPriority: 'maintain',
  runDaysPerWeek: 4,
  trainingDays: ['Mon', 'Wed', 'Fri', 'Sun'],
}, 'the owner-scoped event retains only supported editable HYROX config');

const invalidHyroxConfig = racesRouter._test.normalizeRaceEvent({
  race_name: 'Fixture HYROX',
  event_kind: 'hyrox',
  event_local_date: '2026-09-06',
  event_timezone: 'America/New_York',
  event_format: 'doubles',
  event_category: 'men',
  rules_version: '2026-2027',
  event_config_json: { runDaysPerWeek: 4, trainingDays: ['Tue', 'Thu'] },
});
assert.equal(invalidHyroxConfig.valid, false);
assert.match(invalidHyroxConfig.error, /four run days|at least 4 training weekdays/i, 'unsupported availability explains why it failed and what to change');

function sourcePlan({ duration = 16, miles = 1.1, prescriptionBasis } = {}) {
  const session = {
    id: 'today-quality',
    kind: 'run',
    type: 'quality',
    workout_type: 'run',
    title: 'Quality run',
    intensity: 'Hard',
    target_zone: 'Zone 4',
  };
  if (duration !== null) session.duration_min = duration;
  if (miles !== null) session.distance_miles = miles;
  if (prescriptionBasis) session.prescription_basis = prescriptionBasis;
  return {
    schemaVersion: 2,
    planMode: 'run_only',
    weeks: [{ week: 1, phase: 'build', days: [{ day: 'Thu', date: '2026-08-13', sessions: [session] }] }],
  };
}

function proposal({ plan = sourcePlan(), completion, checkin, goalBackwardV24 } = {}) {
  return adaptation.buildAdaptationProposal({
    plan,
    planningDateISO: '2026-08-13',
    planVersion: 'recovery-minimum-v1',
    completion,
    checkin,
    goalBackwardV24,
  });
}

function firstChange(result) {
  assert.equal(result.status, 'proposal');
  assert.ok(result.changes[0]?.after, 'the fixture must produce a reviewed adaptation change');
  return result.changes[0].after;
}

function assertExplicitAlternative(session, expectedDriver) {
  assert.equal(session.kind, 'rest');
  assert.equal(session.type, 'rest');
  assert.equal(session.workout_type, 'rest');
  assert.equal(session.title, 'Rest, easy walking, or mobility');
  assert.equal(session.distance_miles, 0, 'the alternative never masquerades as a token run');
  assert.match(session.description, expectedDriver);
  assert.match(session.steps.join(' '), /stop.*pain|pain.*stop|soreness.*normal movement/i, 'pain and soreness stop guidance remains explicit');

  const policy = session.recovery_alternative;
  assert.equal(policy.policy, 'minimum_effective_recovery_session_v1');
  assert.equal(policy.minimum_run_minutes, 20);
  assert.equal(policy.minimum_run_miles, 1.5);
  assert.equal(policy.activity_health_minimum_claimed, false, 'the product floor is not misrepresented as a health-benefit threshold');
  assert.match(policy.safety_rationale, /token run|intended recovery session/i);
  assert.deepEqual(policy.options.map((option) => option.type), ['rest', 'walking', 'mobility']);

  const rest = policy.options[0];
  assert.equal(rest.duration_minutes, 0);
  assert.match(rest.intensity, /rest|no exercise/i);
  assert.match(rest.safety_rationale, /tired|sore|unwell|normal movement/i);

  const walking = policy.options[1];
  assert.deepEqual(walking.duration_range_minutes, [20, 30]);
  assert.match(walking.intensity, /very easy|conversational/i);
  assert.match(walking.safety_rationale, /stop|comfortable/i);

  const mobility = policy.options[2];
  assert.deepEqual(mobility.duration_range_minutes, [5, 10]);
  assert.match(mobility.intensity, /gentle|comfortable/i);
  assert.match(mobility.safety_rationale, /pain|comfortable/i);
}

const photographed = proposal({
  completion: { missedWorkouts: 2, missedRuns: 1, freshness: 'recent' },
});
const photographedAlternative = firstChange(photographed);
assertExplicitAlternative(photographedAlternative, /missed-session history/i);
assert.equal(photographedAlternative.recovery_alternative.reduced_run_minutes, 11);
assert.equal(photographedAlternative.recovery_alternative.reduced_run_miles, 0.8);
assert.equal(photographed.proposedPlan.weeks[0].days[0].sessions[0].kind, 'rest', 'the reviewed alternative survives proposal acceptance');

const lowAdherence = firstChange(proposal({
  completion: { adherenceRate: 0.64, missedWorkouts: 0, missedRuns: 0, freshness: 'recent' },
}));
assertExplicitAlternative(lowAdherence, /completion and missed-session history/i);

const missedSessions = firstChange(proposal({
  completion: { adherenceRate: 0.9, missedWorkouts: 2, missedRuns: 0, freshness: 'recent' },
}));
assertExplicitAlternative(missedSessions, /missed-session history/i);

const soreness = firstChange(proposal({
  checkin: { legs: 2, drive: 2, feeling: 3, sleep_hours: 7, time_available: 60, life_flags: ['sore'] },
}));
assertExplicitAlternative(soreness, /sore|soreness|check-in/i);

const timeBelow = firstChange(proposal({
  plan: sourcePlan({ duration: 27, miles: null, prescriptionBasis: 'time' }),
  completion: { missedWorkouts: 2 },
}));
assertExplicitAlternative(timeBelow, /missed-session history/i);
assert.equal(timeBelow.recovery_alternative.reduced_run_minutes, 19, 'the minute immediately below the floor becomes an alternative');

const timeAt = firstChange(proposal({
  plan: sourcePlan({ duration: 28, miles: null, prescriptionBasis: 'time' }),
  completion: { missedWorkouts: 2 },
}));
assert.equal(timeAt.kind, 'run');
assert.equal(timeAt.duration_min, 20, 'the time floor remains a real recovery run');

const timeAbove = firstChange(proposal({
  plan: sourcePlan({ duration: 30, miles: null, prescriptionBasis: 'time' }),
  completion: { missedWorkouts: 2 },
}));
assert.equal(timeAbove.kind, 'run');
assert.equal(timeAbove.duration_min, 21, 'the minute above the floor remains a real recovery run');

const distanceBelow = firstChange(proposal({
  plan: sourcePlan({ duration: null, miles: 2, prescriptionBasis: 'distance' }),
  completion: { missedWorkouts: 2 },
}));
assertExplicitAlternative(distanceBelow, /missed-session history/i);
assert.equal(distanceBelow.recovery_alternative.reduced_run_miles, 1.4, 'the distance step immediately below the floor becomes an alternative');

const distanceAt = firstChange(proposal({
  plan: sourcePlan({ duration: null, miles: 2.1, prescriptionBasis: 'distance' }),
  completion: { missedWorkouts: 2 },
}));
assert.equal(distanceAt.kind, 'run');
assert.equal(distanceAt.distance_miles, 1.5, 'the distance floor remains a real recovery run');

const distanceAbove = firstChange(proposal({
  plan: sourcePlan({ duration: null, miles: 2.3, prescriptionBasis: 'distance' }),
  completion: { missedWorkouts: 2 },
}));
assert.equal(distanceAbove.kind, 'run');
assert.equal(distanceAbove.distance_miles, 1.6, 'the first rounded distance above the floor remains a real recovery run');

const unquantified = firstChange(proposal({
  plan: sourcePlan({ duration: null, miles: null }),
  completion: { missedWorkouts: 2 },
}));
assertExplicitAlternative(unquantified, /missed-session history/i);
assert.equal(unquantified.recovery_alternative.decision_reason, 'dose_unquantified');

const v24Beginner = firstChange(proposal({
  plan: sourcePlan({ duration: 22, miles: null, prescriptionBasis: 'time' }),
  completion: { missedWorkouts: 2 },
  goalBackwardV24: { training_age_class: 'BEGINNER', recent_normal_running_minutes_per_week: 45 },
}));
assert.equal(v24Beginner.kind, 'run');
assert.equal(v24Beginner.duration_min, 15, 'the v2.4 beginner/recent-normal-below-60 floor is 15 minutes');

const v24Established = firstChange(proposal({
  plan: sourcePlan({ duration: 22, miles: null, prescriptionBasis: 'time' }),
  completion: { missedWorkouts: 2 },
  goalBackwardV24: { training_age_class: 'ESTABLISHED', recent_normal_running_minutes_per_week: 120 },
}));
assertExplicitAlternative(v24Established, /missed-session history/i);
assert.equal(v24Established.recovery_alternative.minimum_run_minutes, 20);

for (const result of [photographed, proposal({ completion: { adherenceRate: 0.64 } })]) {
  for (const change of result.changes) {
    if (change.after?.kind !== 'run') continue;
    const minutes = Number(change.after.duration_min);
    const miles = Number(change.after.distance_miles);
    assert.equal(Number.isFinite(minutes) && minutes > 0 && minutes < 20, false, 'no ~10-minute token run leaks through');
    assert.equal(Number.isFinite(miles) && miles > 0 && miles < 1.5, false, 'no ~0.5-mile token run leaks through');
  }
}

console.log('ADAPTATION RECOVERY MINIMUM SMOKE OK');
