#!/usr/bin/env node

const assert = require('node:assert/strict');

const {
  CANONICAL_SESSION_ROLES,
  CANONICAL_STEP_TYPES,
  CANONICAL_TARGET_FIELDS,
  CANONICAL_WORKOUT_FAMILIES,
  CANONICAL_WORKOUT_UNITS,
} = require('../src/lib/goalBackwardContracts');
const {
  buildCanonicalSession,
  canonicalWorkoutHash,
  deriveCanonicalTotals,
  validateCanonicalSession,
} = require('../src/lib/canonicalWorkout');
const {
  attachValidatedExplanation,
  validateCanonicalPresentationFloor,
  validateExplanationAgainstCanonicalFacts,
} = require('../src/lib/prescriptionIntegrity');
const planSchema = require('../src/lib/planSchema');

const results = [];

function test(id, description, assertion) {
  assertion();
  results.push(id);
  console.log(`ok - ${id} - ${description}`);
}

function provenance(units = ['m']) {
  return [{
    source_evidence_ids: ['evidence-synthetic-1'],
    derived_athlete_state_field: 'recent_normal_running.median_distance_m',
    policy_id: 'target-policy-v1',
    policy_version: 1,
    confidence: 'HIGH',
    derived_at: '2026-08-14T12:00:00.000Z',
    decision_id: 'decision-synthetic-1',
    canonical_units: units,
  }];
}

function intervalSession(overrides = {}) {
  return {
    session_id: 'session-canonical-1',
    session_revision: 3,
    plan_id: 'plan-synthetic-1',
    plan_revision: 7,
    decision_id: 'decision-synthetic-1',
    goal_ids: ['goal-synthetic-1'],
    phase: 'EVENT_SPECIFIC_DEVELOPMENT',
    role: 'PRIMARY_KEY',
    workout_family: 'interval_run',
    title: 'Intervals',
    purpose_reason_codes: ['EVENT_SPECIFIC_ENTRY'],
    scheduled_local_date: '2026-08-18',
    timezone: 'America/New_York',
    steps: [
      { step_id: 'warmup', type: 'warmup', order: 1, target: { distance_m: 1000, duration_s: 360 }, provenance: provenance(['m', 's']) },
      {
        step_id: 'repeat', type: 'repeat', order: 2, repeat_count: 3, target: {}, provenance: [],
        children: [
          {
            step_id: 'work', type: 'interval', order: 1, workout_family: 'interval_run',
            target: { distance_m: 1000, duration_s: 240, pace_range_s_per_km: { minimum: 235, maximum: 245 }, rpe_range: { minimum: 8, maximum: 8 } },
            provenance: provenance(['m', 's', 's/km', 'rpe']),
          },
          { step_id: 'recover', type: 'recovery', order: 2, target: { distance_m: 400, duration_s: 150 }, provenance: provenance(['m', 's']) },
        ],
      },
      { step_id: 'cooldown', type: 'cooldown', order: 3, target: { distance_m: 1000, duration_s: 360 }, provenance: provenance(['m', 's']) },
    ],
    success_criteria: ['Complete every work interval inside the prescribed range.'],
    adjustment_criteria: ['Switch to effort authority when the environment gate applies.'],
    stop_criteria: ['Stop for pain or a material gait change.'],
    ...overrides,
  };
}

test('CANON-CONTRACT-01', 'session, family, step, capability, and workout-unit unions are closed', () => {
  assert.deepEqual(CANONICAL_SESSION_ROLES, ['PRIMARY_KEY', 'SUPPORTING', 'RECOVERY', 'REST', 'ASSESSMENT']);
  assert.equal(CANONICAL_WORKOUT_FAMILIES.length, 20);
  assert.deepEqual(CANONICAL_STEP_TYPES, [
    'warmup', 'run', 'interval', 'repeat', 'recovery', 'station', 'strength_exercise',
    'transition', 'cooldown', 'mobility', 'manual_instruction',
  ]);
  assert.deepEqual(CANONICAL_WORKOUT_UNITS, ['m', 's', 's/km', 'bpm', 'rpe', 'spm', 'kg', 'count', 'rir', 'ordinal']);
  assert.equal(CANONICAL_TARGET_FIELDS.includes('distance_miles'), false);
  assert.deepEqual(CANONICAL_TARGET_FIELDS.slice(0, 5), ['distance_m', 'duration_s', 'pace_range_s_per_km', 'reference_pace_range_s_per_km', 'heart_rate_range_bpm']);
  for (const values of [CANONICAL_SESSION_ROLES, CANONICAL_WORKOUT_FAMILIES, CANONICAL_STEP_TYPES, CANONICAL_WORKOUT_UNITS, CANONICAL_TARGET_FIELDS]) {
    assert.equal(Object.isFrozen(values), true);
  }
});

test('CANON-01', 'repeat totals recurse exactly and reject a divergent stored cache', () => {
  assert.deepEqual(deriveCanonicalTotals(intervalSession().steps), {
    distance_m: 6200,
    duration_s: 1890,
    work_distance_m: 3000,
    work_duration_s: 720,
    repetitions: 3,
    sets: 0,
    station_distance_m: 0,
  });
  const canonical = buildCanonicalSession(intervalSession());
  assert.equal(canonical.derived_totals.distance_m, 6200);
  const mismatch = validateCanonicalSession({
    ...canonical,
    derived_totals: { ...canonical.derived_totals, distance_m: 7000 },
  });
  assert.equal(mismatch.valid, false);
  assert.ok(mismatch.reason_codes.includes('DERIVED_TOTAL_MISMATCH'));
});

test('CANON-SCHEMA-01', 'unknown steps, imperial target fields, and missing numerical provenance fail hard', () => {
  const unknown = validateCanonicalSession({
    ...intervalSession(),
    steps: [{ step_id: 'mystery', type: 'teleport', order: 1, target: {}, provenance: [] }],
  });
  assert.equal(unknown.valid, false);
  assert.ok(unknown.violations.some((entry) => entry.code === 'CANONICAL_SCHEMA_INVALID'));

  const imperial = validateCanonicalSession({
    ...intervalSession(),
    steps: [{ step_id: 'run', type: 'run', order: 1, workout_family: 'interval_run', target: { distance_miles: 1 }, provenance: provenance(['m']) }],
  });
  assert.equal(imperial.valid, false);

  const missingProvenance = validateCanonicalSession({
    ...intervalSession(),
    steps: [{ step_id: 'run', type: 'run', order: 1, workout_family: 'interval_run', target: { distance_m: 1000 }, provenance: [] }],
  });
  assert.equal(missingProvenance.valid, false);
  assert.ok(missingProvenance.violations.some((entry) => entry.code === 'TARGET_PROVENANCE_INVALID'));

  const unsupportedCombination = validateCanonicalSession({
    ...intervalSession(),
    steps: [{ step_id: 'run', type: 'run', order: 1, workout_family: 'interval_run', target: { load_kg: 20 }, provenance: provenance(['kg']) }],
  });
  assert.equal(unsupportedCombination.valid, false);
  assert.ok(unsupportedCombination.violations.some((entry) => entry.reason === 'TARGET_COMBINATION_UNSUPPORTED'));
});

test('CANON-FAMILY-01', 'machine-readable work steps reject a conflicting declared family', () => {
  const result = validateCanonicalSession(intervalSession({ workout_family: 'strength_upper' }));
  assert.equal(result.valid, false);
  assert.ok(result.reason_codes.includes('WORKOUT_FAMILY_UNRESOLVED'));
});

test('CANON-04', 'assessment stress is the element-wise maximum with the event-specific floor', () => {
  const assessment = buildCanonicalSession(intervalSession({
    session_id: 'session-assessment-1',
    role: 'ASSESSMENT',
    workout_family: 'assessment',
    steps: [
      { step_id: 'warmup', type: 'warmup', order: 1, target: { duration_s: 300 }, provenance: provenance(['s']) },
      { step_id: 'threshold', type: 'run', order: 2, workout_family: 'threshold_run', target: { duration_s: 600, rpe_range: { minimum: 7, maximum: 8 } }, provenance: provenance(['s', 'rpe']) },
      { step_id: 'lower', type: 'strength_exercise', order: 3, workout_family: 'strength_lower', target: { sets: 2, repetitions: 5, load_kg: 40 }, provenance: provenance(['count', 'kg']) },
      { step_id: 'cooldown', type: 'cooldown', order: 4, target: { duration_s: 300 }, provenance: provenance(['s']) },
    ],
  }));
  assert.deepEqual(assessment.stress_vector, [3, 3, 4, 1, 1, 3, 3, 2]);
});

test('CANON-IDENTITY-01', 'canonical hashes are deterministic and schema-v2 adapters preserve stable identity', () => {
  const canonical = buildCanonicalSession(intervalSession());
  assert.match(canonical.content_hash, /^[a-f0-9]{64}$/);
  assert.equal(canonical.content_hash, canonicalWorkoutHash({ ...canonical, title: 'Cosmetic rename' }));
  const normalized = planSchema.normalizeSession(canonical);
  assert.equal(normalized.session_id, 'session-canonical-1');
  assert.equal(normalized.id, 'session-canonical-1');
  assert.equal(normalized.kind, 'run');
  assert.equal(normalized.distance_miles, 6200 / 1609.344);
  assert.equal(normalized.canonical_workout_schema_version, 1);
  assert.equal(canonicalWorkoutHash(normalized), canonical.content_hash, 'legacy adapter fields are outside canonical hash authority');
  assert.equal(planSchema.SCHEMA_VERSION, 2);
});

test('FIT-01', 'manual and station steps cannot claim fully structured export capability', () => {
  const canonical = buildCanonicalSession(intervalSession({
    session_id: 'session-manual-1',
    workout_family: 'hyrox_station_skill',
    role: 'SUPPORTING',
    steps: [
      { step_id: 'station', type: 'station', order: 1, workout_family: 'hyrox_station_skill', target: { repetitions: 20 }, provenance: provenance(['count']) },
      { step_id: 'instruction', type: 'manual_instruction', order: 2, target: {}, provenance: [] },
    ],
  }));
  assert.equal(canonical.capability.classification, 'MANUAL_COMPONENTS_REQUIRED');
  assert.deepEqual(canonical.capability.manual_step_ids, ['station', 'instruction']);
  const falseClaim = validateCanonicalSession({
    ...canonical,
    capability: { classification: 'FULLY_STRUCTURED', manual_step_ids: [], unsupported_step_ids: [] },
  });
  assert.equal(falseClaim.valid, false);
});

test('TRUTH-01', 'explanation numbers must be present in canonical facts and cannot mutate prescription', () => {
  const canonical = buildCanonicalSession(intervalSession());
  assert.equal(validateExplanationAgainstCanonicalFacts('Complete 3 repeats of 1000 m.', canonical).valid, true);
  const rejected = validateExplanationAgainstCanonicalFacts('Complete 4 repeats of 1000 m.', canonical);
  assert.equal(rejected.valid, false);
  assert.deepEqual(rejected.unexpected_numbers, ['4']);
  assert.throws(() => attachValidatedExplanation(canonical, 'Run 5 repeats.'), (error) => error?.code === 'EXPLANATION_FACT_MISMATCH');
  const explained = attachValidatedExplanation(canonical, 'Complete 3 repeats of 1000 m.');
  assert.equal(canonicalWorkoutHash(explained), canonical.content_hash);
  assert.equal(canonical.steps[1].repeat_count, 3);
});

test('FLOOR-01', 'token runs fail unless a named beginner or rehab exception is explicit', () => {
  const token = buildCanonicalSession(intervalSession({
    session_id: 'session-token-1',
    role: 'RECOVERY',
    workout_family: 'recovery_run',
    steps: [{ step_id: 'run', type: 'run', order: 1, workout_family: 'recovery_run', target: { duration_s: 660 }, provenance: provenance(['s']) }],
  }));
  assert.equal(validateCanonicalPresentationFloor(token, { training_age_class: 'ESTABLISHED' }).valid, false);
  const allowed = {
    ...token,
    purpose_reason_codes: [...token.purpose_reason_codes, 'BELOW_PRESENTATION_FLOOR_EXCEPTION'],
    beginner_or_rehab_protocol_id: 'rehab-return-v1',
  };
  assert.equal(validateCanonicalPresentationFloor(allowed, { training_age_class: 'ESTABLISHED' }).valid, true);
});

test('FLOOR-02', 'easy, long, quality, HYROX, and strength floors use their exact training-class rules', () => {
  assert.equal(validateCanonicalPresentationFloor({
    session_id: 'easy-token', workout_family: 'easy_run', derived_totals: { duration_s: 24 * 60 }, steps: [],
  }, { training_age_class: 'ESTABLISHED' }).valid, false);
  assert.equal(validateCanonicalPresentationFloor({
    session_id: 'easy-beginner', workout_family: 'easy_run', derived_totals: { duration_s: 20 * 60 }, steps: [],
  }, { training_age_class: 'BEGINNER' }).valid, true);
  assert.equal(validateCanonicalPresentationFloor({
    session_id: 'long-token', workout_family: 'long_aerobic', derived_totals: { duration_s: 59 * 60 }, steps: [],
  }, { training_age_class: 'ESTABLISHED', median_ordinary_easy_duration_min: 40 }).valid, false);
  assert.equal(validateCanonicalPresentationFloor({
    session_id: 'quality-token', workout_family: 'threshold_run', derived_totals: { work_duration_s: 7 * 60 },
    steps: [{ type: 'warmup' }, { type: 'run' }, { type: 'cooldown' }],
  }).valid, false);
  assert.equal(validateCanonicalPresentationFloor({
    session_id: 'hyrox-token', workout_family: 'hyrox_compromised', derived_totals: { work_duration_s: 19 * 60 },
    steps: [{ type: 'repeat', repeat_count: 2, children: [{ type: 'run' }, { type: 'station' }] }],
  }).valid, false);
  assert.equal(validateCanonicalPresentationFloor({
    session_id: 'strength-token', workout_family: 'strength_lower',
    steps: [{ type: 'strength_exercise', target: { sets: 2 } }],
  }).valid, false);
});

assert.equal(new Set(results).size, results.length, 'fixture IDs must remain unique');
console.log(`GOAL-BACKWARD CANONICAL SMOKE OK (${results.length} checks)`);
