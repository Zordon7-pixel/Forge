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
  materializeCanonicalSessionSet,
  validateCanonicalSession,
  validateCanonicalSessionSet,
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

test('CANON-TRUTH-01', 'explanation numbers must be present in canonical facts and cannot mutate prescription', () => {
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

test('CANON-MATERIALIZE-01', 'every selected road/general role becomes a revision-bound canonical and legacy-compatible session', () => {
  const set = materializeCanonicalSessionSet({
    decision: {
      decision_id: 'decision-materialized-1',
      decision_hash: 'd'.repeat(64),
      phase: 'DEVELOPMENT',
      timezone: 'America/New_York',
      plan_revision: 4,
      active_goals: [{ goal_id: 'goal-materialized-1' }],
      evidence_used: ['evidence-materialized-1'],
    },
    candidate: {
      candidate_skeleton_id: 'candidate-materialized-1',
      candidate_hash: 'c'.repeat(64),
      sessions: [
        {
          session_id: 'quality-materialized-1', requirement_id: 'quality', role: 'PRIMARY_KEY',
          workout_family: 'threshold_run', scheduled_local_date: '2026-08-18',
          candidate_material_id: 'quality-material-1',
        },
        {
          session_id: 'easy-materialized-1', requirement_id: 'easy', role: 'SUPPORTING',
          supports_requirement_id: 'quality', workout_family: 'easy_run', scheduled_local_date: '2026-08-20',
          candidate_material_id: 'easy-material-1',
        },
      ],
      candidate_material: [
        {
          material_id: 'quality-material-1',
          source_session: {
            id: 'quality-materialized-1', kind: 'run', workout_id: 'tempo_threshold',
            title: 'Threshold intervals', prescription_basis: 'time', duration_min: 50,
            distance_miles: 6, distance_is_estimate: true,
            quality_prescription: {
              repetitions: 4, work: '5 min threshold',
              recovery: { type: 'easy jog', duration: '2 min' },
            },
            warmup: ['15 min easy running'], cooldown: ['10 min easy running'],
          },
        },
        {
          material_id: 'easy-material-1',
          source_session: {
            id: 'easy-materialized-1', kind: 'run', workout_id: 'easy_aerobic',
            title: 'Easy aerobic run', prescription_basis: 'time', duration_min: 30,
            distance_miles: 3, distance_is_estimate: true,
          },
        },
      ],
    },
    plan_id: 'plan-materialized-1',
    plan_revision: 5,
    session_revision: 2,
    planning_instant: '2026-08-14T12:00:00.000Z',
    training_age_class: 'ESTABLISHED',
  });
  assert.equal(set.canonical_sessions_materialized, true);
  assert.equal(set.sessions.length, 2);
  assert.deepEqual(set.sessions.map((session) => session.role), ['PRIMARY_KEY', 'SUPPORTING']);
  assert.equal(set.sessions.every((session) => session.plan_id === 'plan-materialized-1'), true);
  assert.equal(set.sessions.every((session) => session.plan_revision === 5), true);
  assert.equal(set.sessions.every((session) => session.session_revision === 2), true);
  assert.equal(set.sessions.every((session) => session.decision_id === 'decision-materialized-1'), true);
  assert.equal(set.sessions.every((session) => validateCanonicalSession(session).valid), true);
  assert.equal(set.sessions.every((session) => session.id === session.session_id), true);
  assert.equal(set.sessions.every((session) => Number.isFinite(session.duration_min)), true);
  assert.equal(set.sessions[0].steps.some((step) => step.type === 'repeat'), true);
  assert.equal(set.sessions[0].target_provenance.every((entry) => entry.decision_id === 'decision-materialized-1'), true);
  assert.match(set.content_hash, /^[a-f0-9]{64}$/);
  assert.match(set.candidate_skeleton_hash, /^[a-f0-9]{64}$/);
  assert.equal(validateCanonicalSessionSet(set).valid, true);
  const transplantedCandidate = validateCanonicalSessionSet({ ...set, candidate_hash: '0'.repeat(64) });
  assert.equal(transplantedCandidate.valid, false);
  assert.ok(transplantedCandidate.violations.some((entry) => entry.reason === 'CANDIDATE_HASH_BINDING_MISMATCH'));
});

test('CANON-RACE-01', 'unknown legacy dosage stays unknown while an explicit valid zero remains prescription truth', () => {
  function materializeTruthCase(id, family, sourceSession) {
    return materializeCanonicalSessionSet({
    decision: {
      decision_id: `decision-${id}`, decision_hash: '1'.repeat(64), phase: 'EVENT_SPECIFIC_DEVELOPMENT',
      timezone: 'America/New_York', plan_revision: 1,
      active_goals: [{ goal_id: `goal-${id}`, event_kind: family === 'race' ? 'MARATHON' : 'ROAD_5K' }],
      evidence_used: ['evidence-race-distance'],
    },
    candidate: {
      candidate_skeleton_id: `candidate-${id}`, candidate_hash: '2'.repeat(64),
      sessions: [{
        session_id: `session-${id}`, requirement_id: family, role: 'PRIMARY_KEY', workout_family: family,
        scheduled_local_date: '2026-10-11', candidate_material_id: `material-${id}`,
      }],
      candidate_material: [{
        material_id: `material-${id}`,
        source_session: {
          id: `session-${id}`, kind: 'run', workout_id: family,
          title: family === 'race' ? 'Race' : 'Assessment',
          evidence_refs: ['evidence-race-distance'],
          ...sourceSession,
        },
      }],
    },
    planning_instant: '2026-08-14T12:00:00.000Z',
    }).sessions[0];
  }

  const set = materializeCanonicalSessionSet({
    decision: {
      decision_id: 'decision-distance-race', decision_hash: '1'.repeat(64), phase: 'EVENT_SPECIFIC_DEVELOPMENT',
      timezone: 'America/New_York', plan_revision: 1,
      active_goals: [{ goal_id: 'goal-distance-race', event_kind: 'MARATHON' }],
      evidence_used: ['evidence-race-distance'],
    },
    candidate: {
      candidate_skeleton_id: 'candidate-distance-race', candidate_hash: '2'.repeat(64),
      sessions: [{
        session_id: 'race-distance-only', requirement_id: 'race', role: 'PRIMARY_KEY', workout_family: 'race',
        scheduled_local_date: '2026-10-11', candidate_material_id: 'material-distance-race',
      }],
      candidate_material: [{
        material_id: 'material-distance-race',
        source_session: {
          id: 'race-distance-only', kind: 'run', workout_id: 'race', prescription_basis: 'distance',
          title: 'Marathon', distance_miles: 26.2, distance_is_estimate: false,
          evidence_refs: ['evidence-race-distance'],
        },
      }],
    },
    planning_instant: '2026-08-14T12:00:00.000Z',
  });
  const race = set.sessions[0];
  assert.equal(race.derived_totals.distance_m, Math.round(26.2 * 1609.344));
  assert.equal(race.derived_totals.duration_s, 0);
  assert.equal(race.steps[0].target.duration_s, undefined);
  assert.equal(race.steps[0].target.distance_m, Math.round(26.2 * 1609.344));
  assert.equal(race.duration_min, undefined);

  for (const family of ['race', 'assessment']) {
    for (const [label, duration] of [['omitted', undefined], ['null', null], ['empty', '']]) {
      const source = { prescription_basis: 'distance', distance_miles: family === 'race' ? 26.2 : 1, distance_is_estimate: false };
      if (label !== 'omitted') source.duration_min = duration;
      const session = materializeTruthCase(`${family}-duration-${label}`, family, source);
      assert.equal(Object.hasOwn(session.steps[0].target, 'duration_s'), false);
      assert.equal(Object.hasOwn(session, 'duration_min'), false);
    }
  }

  for (const [label, distance] of [['omitted', undefined], ['null', null], ['empty', '']]) {
    const source = { prescription_basis: 'time', duration_min: 30, distance_is_estimate: false };
    if (label !== 'omitted') source.distance_miles = distance;
    const session = materializeTruthCase(`easy-distance-${label}`, 'easy_run', source);
    assert.equal(Object.hasOwn(session.steps[0].target, 'distance_m'), false);
    assert.equal(Object.hasOwn(session, 'distance_miles'), false);
  }

  const zeroDistance = materializeTruthCase('easy-distance-zero', 'easy_run', {
    prescription_basis: 'time', duration_min: 30, distance_miles: 0, distance_is_estimate: false,
  });
  assert.equal(zeroDistance.steps[0].target.distance_m, 0);
  assert.equal(zeroDistance.distance_miles, 0);

  const zeroDuration = materializeTruthCase('race-duration-zero', 'race', {
    prescription_basis: 'distance', distance_miles: 1, distance_is_estimate: false, duration_min: 0,
  });
  assert.equal(zeroDuration.steps[0].target.duration_s, 0);
  assert.equal(zeroDuration.duration_min, 0);
});

test('CANON-WEEK-01', 'session-set validation rejects divergent totals, duplicate identities, and revision bindings', () => {
  const first = buildCanonicalSession(intervalSession());
  const invalid = validateCanonicalSessionSet({
    canonical_workout_schema_version: 1,
    plan_id: first.plan_id,
    plan_revision: first.plan_revision,
    decision_id: first.decision_id,
    decision_hash: 'e'.repeat(64),
    candidate_id: 'candidate-invalid-set',
    candidate_hash: 'f'.repeat(64),
    sessions: [first, { ...first, plan_revision: first.plan_revision + 1 }],
    derived_totals: { ...first.derived_totals },
    content_hash: '0'.repeat(64),
  });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.reason_codes.includes('CANONICAL_SESSION_SET_INVALID'));
  assert.ok(invalid.violations.some((entry) => entry.reason === 'DUPLICATE_SESSION_ID'));
  assert.ok(invalid.violations.some((entry) => entry.reason === 'PLAN_REVISION_MISMATCH'));
  assert.ok(invalid.violations.some((entry) => entry.reason === 'SESSION_SET_TOTAL_MISMATCH'));
});

test('CANON-LEGACY-01', 'a canonical session-set plan remains readable through current schema-v2 adapters', () => {
  const canonical = buildCanonicalSession(intervalSession());
  const plan = planSchema.buildCanonicalPlanFromSessionSet({
    canonical_workout_schema_version: 1,
    plan_id: canonical.plan_id,
    plan_revision: canonical.plan_revision,
    decision_id: canonical.decision_id,
    decision_hash: 'a'.repeat(64),
    candidate_id: 'candidate-canonical-plan',
    candidate_hash: 'b'.repeat(64),
    sessions: [canonical],
    derived_totals: canonical.derived_totals,
    content_hash: 'c'.repeat(64),
  });
  assert.equal(plan.schemaVersion, 2);
  assert.equal(plan.weeks[0].days[0].sessions[0].session_id, canonical.session_id);
  assert.equal(planSchema.daySessions(plan.weeks[0].days[0])[0].distance_miles, 6200 / 1609.344);
  const legacy = { weeks: [{ days: [{ id: 'legacy-run', date: '2026-08-18', type: 'easy', distance_miles: 3 }] }] };
  assert.strictEqual(planSchema.buildCanonicalPlanFromSessionSet(null, { currentPlan: legacy }), legacy);
});

async function runCrossSurfaceAcceptance() {
  const [calendarModule, dailyModule, fitModule] = await Promise.all([
    import('../../frontend/src/lib/planCalendar.js'),
    import('../../frontend/src/lib/dailyExecutionCore.js'),
    import('../../frontend/src/services/fit/encodeWorkoutFit.js'),
  ]);
  const canonical = buildCanonicalSession(intervalSession({
    session_id: 'session-surface-equality',
    workout_family: 'easy_run',
    title: 'Four mile canonical run',
    steps: [{
      step_id: 'four-mile-run', type: 'run', order: 1, workout_family: 'easy_run',
      target: { distance_m: 6437 }, provenance: provenance(['m']),
    }],
    safety_scope: [],
    executability: 'EXECUTABLE',
  }));
  const purpose = 'Preserve exact canonical surface truth.';
  const identity = {
    decision_id: canonical.decision_id,
    decision_hash: 'd'.repeat(64),
    candidate_id: 'candidate-surface-equality',
    candidate_revision: 2,
    candidate_hash: 'a'.repeat(64),
    plan_id: canonical.plan_id,
    plan_revision: canonical.plan_revision,
    canonical_session_set_hash: 'b'.repeat(64),
    athlete_state_revision: 5,
    safety_state_hash: `sha256:${'e'.repeat(64)}`,
    goal_revisions: { 'goal-synthetic-1': 3 },
  };
  const planData = {
    schemaVersion: 2,
    canonical_workout_schema_version: 1,
    plan_id: canonical.plan_id,
    plan_revision: canonical.plan_revision,
    decision_id: canonical.decision_id,
    decision_hash: identity.decision_hash,
    selected_candidate_id: identity.candidate_id,
    selected_candidate_hash: identity.candidate_hash,
    canonical_session_set_hash: identity.canonical_session_set_hash,
    planMode: 'run_only',
    overall_feasibility: 'supported',
    reasons: ['GOAL_EXPOSURES_SUPPORTED'],
    weeks: [{
      week: 1,
      startDate: canonical.scheduled_local_date,
      phase: canonical.phase,
      purpose,
      days: [{ date: canonical.scheduled_local_date, day: 'Tue', sessions: [canonical] }],
    }],
  };
  const manifest = {
    schema_version: 'goal_backward_surface_manifest_v1',
    surface_revision: 3,
    feature_mode: 'on',
    v24_surface_enabled: true,
    status: 'accepted',
    identity,
    purpose,
    feasibility: { status: 'supported', reason_codes: ['GOAL_EXPOSURES_SUPPORTED'] },
    safety: { action: 'NORMAL', scope: [], reason_codes: [] },
    weeks: [{ week: 1, start_date: canonical.scheduled_local_date, phase: canonical.phase, purpose }],
    sessions: [canonical],
  };
  const plan = { id: canonical.plan_id, weeks: 1, plan_data: planData };
  const userPlan = { id: 'assignment-surface-equality', plan_version: canonical.plan_revision, progress: { completedSessionIds: [] } };
  const surface = dailyModule.validateSurfaceManifest({ plan, userPlan, manifest });
  assert.equal(surface.status, 'accepted');
  const calendar = calendarModule.buildCalendarModel(plan, userPlan, {
    surfaceManifest: manifest,
    now: new Date(`${canonical.scheduled_local_date}T12:00:00.000Z`),
  });
  const displayed = calendar.getWeek(0).days.flatMap((day) => day.sessions)[0];
  const execution = dailyModule.normalizeExecution({
    plan,
    user_plan: userPlan,
    surface_manifest: manifest,
    execution: {
      hasPlan: true,
      hasDay: true,
      isRest: false,
      date: canonical.scheduled_local_date,
      sessions: [canonical],
      run: canonical,
    },
  });
  const watch = fitModule.buildAcceptedCanonicalWorkout({
    surfaceManifest: manifest,
    sessionId: canonical.session_id,
    exportRevision: 2,
  });
  const fit = fitModule.buildFitWorkoutRepresentation({
    surfaceManifest: manifest,
    sessionId: canonical.session_id,
    exportRevision: 2,
  });

  test('CANON-02', 'UI 4.00 miles and FIT metric distance remain within the two-metre tolerance', () => {
    const fitDistanceM = fit.canonical_steps[0].target.distance_m;
    assert.equal(displayed.distanceMiles.toFixed(2), '4.00');
    assert.ok(Math.abs(displayed.distanceMiles * 1609.344 - fitDistanceM) <= 2);
    assert.equal(fitDistanceM, canonical.derived_totals.distance_m);
  });

  test('CANON-03', 'UI, Watch, and FIT retain the same accepted identity and revisions', () => {
    assert.deepEqual({
      session_id: displayed.id,
      session_revision: displayed.sessionRevision,
      plan_id: canonical.plan_id,
      plan_revision: displayed.planRevision,
      surface_revision: manifest.surface_revision,
      content_hash: displayed.contentHash,
    }, {
      session_id: watch.identity.session_id,
      session_revision: watch.identity.session_revision,
      plan_id: watch.identity.plan_id,
      plan_revision: watch.identity.plan_revision,
      surface_revision: watch.identity.surface_revision,
      content_hash: watch.identity.content_hash,
    });
    assert.deepEqual(fit.identity, watch.identity);
  });

  test('CANON-05', 'UI, calendar, daily execution, Watch, and FIT use exact canonical content', () => {
    assert.deepEqual(displayed.steps, canonical.steps);
    assert.deepEqual(displayed.targetProvenance, canonical.target_provenance);
    assert.deepEqual(displayed.purposeReasonCodes, canonical.purpose_reason_codes);
    assert.deepEqual(displayed.adjustmentCriteria, canonical.adjustment_criteria);
    assert.deepEqual(displayed.stopCriteria, canonical.stop_criteria);
    assert.deepEqual(displayed.safetyScope, canonical.safety_scope);
    assert.equal(displayed.executability, canonical.executability);
    assert.deepEqual(displayed.capability, canonical.capability);
    assert.deepEqual(execution.sessions[0].steps, canonical.steps);
    assert.deepEqual(execution.sessions[0].target_provenance, canonical.target_provenance);
    assert.deepEqual(watch.steps, canonical.steps);
    assert.deepEqual(watch.target_provenance, canonical.target_provenance);
    assert.deepEqual(watch.capability, canonical.capability);
    assert.deepEqual(fit.canonical_steps, canonical.steps);
    assert.deepEqual(fit.target_provenance, canonical.target_provenance);
    assert.deepEqual(fit.capability, canonical.capability);
  });

  const ownedAcceptanceIds = ['FLOOR-01', 'CANON-01', 'CANON-02', 'CANON-03', 'CANON-04', 'CANON-05', 'FIT-01'];
  assert.equal(new Set(results).size, results.length, 'fixture IDs must remain unique');
  assert.deepEqual(results.filter((id) => ownedAcceptanceIds.includes(id)).sort(), [...ownedAcceptanceIds].sort(),
    'all seven canonical-owned acceptance rows must report exactly once');
  console.log(`GOAL-BACKWARD CANONICAL SMOKE OK (${results.length} checks)`);
}

runCrossSurfaceAcceptance().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
