// Dual A-race plan regression smoke.
// Run: node backend/test/dualRacePlan.smoke.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const concurrent = require('../src/lib/concurrentPlan');
const hyrox = require('../src/lib/hyroxPlan');
const { aggregateWeeklyStress } = require('../src/lib/goalBackwardLoad');
const { buildGoalBackwardPlanningDecision } = require('../src/lib/goalBackwardDecisionEngine');
const {
  MAX_GOAL_BACKWARD_SEARCH_FRONTIER,
  MAX_GOAL_BACKWARD_SEARCH_NODES,
  buildGoalBackwardCandidateSkeleton,
  enumerateGoalBackwardCandidates,
} = require('../src/lib/racePlanCandidateEngine');
const { targetRef: goalBackwardTargetRef } = require('../src/lib/betaPlanRollout');
const candidateLifecycle = require('../src/lib/planCandidateLifecycle');
const { canonicalRoadContributorFamily } = require('../src/lib/canonicalWorkout');
const { buildDecisionArtifactDiagnosticBundle } = require('../src/lib/racePlanDiagnostics');
const adaptation = require('../src/lib/adaptationEngine');
const planSchema = require('../src/lib/planSchema');
const { resolveActivePlanForDate } = require('../src/lib/planAssignmentLifecycle');
const { motivationalRunName } = require('../../shared/runDisplayName.mjs');

const HYROX_EQUIPMENT = ['ski_erg', 'row_erg', 'sled_push', 'sled_pull', 'wall_ball_target', 'sandbag', 'farmers_carry', 'treadmill'];

function checkTimePrescriptionDistanceAuthority() {
  const decision = {
    decision_id: 'decision-time-distance-authority',
    decision_hash: 'f'.repeat(64),
    phase: 'FOUNDATION',
    primary_goal_id: 'goal-road',
    training_age_class: 'ESTABLISHED',
    role_multiset: [{ requirement_id: 'easy-primary', any_of: ['easy_run'], role: 'PRIMARY_KEY' }],
    active_goals: [{ goal_id: 'goal-road', priority: 'A' }],
    evidence_used: [{ evidence_id: 'snapshot-time-distance', purpose: 'CURRENT_PLANNING_SNAPSHOT' }],
  };
  const legacyMaterial = [{
    id: 'time-easy', kind: 'run', workout_family: 'easy_run', prescription_basis: 'time',
    duration_min: 60, distance_miles: 6, distance_is_estimate: true,
  }];
  const withoutObservedPace = buildGoalBackwardCandidateSkeleton({
    decision,
    legacy_road_candidate_material: legacyMaterial,
    validate: false,
  });
  assert.equal(withoutObservedPace.sessions[0].distance_m, null,
    'an estimated time-based distance remains unknown without observed pace evidence');
  const unboundAuthorityClaim = buildGoalBackwardCandidateSkeleton({
    decision,
    legacy_road_candidate_material: [{
      ...legacyMaterial[0],
      canonical_prescribed_distance_m: 16093,
    }],
    validate: false,
  });
  assert.equal(unboundAuthorityClaim.sessions[0].distance_m, null,
    'a material-authored canonical distance without the closed server derivation is not authoritative');
  const withObservedPace = buildGoalBackwardCandidateSkeleton({
    decision,
    legacy_road_candidate_material: legacyMaterial,
    hybrid_running_projection_pace_s_per_mile: 600,
    validate: false,
  });
  assert.equal(
    withObservedPace.sessions[0].distance_m,
    Math.floor(Math.min(6, (60 * 60) / (600 * 1.1)) * 1609.344),
    'time-based dose uses the conservative 110-percent observed-pace bound and never the faster display estimate',
  );
  assert.equal(
    withObservedPace.candidate_material[0].source_session.canonical_distance_derivation,
    'observed_pace_conservative_110_percent_v1',
  );
  const buildEstimatedTimeCandidate = (durationMin, distanceMiles) => buildGoalBackwardCandidateSkeleton({
    decision,
    legacy_road_candidate_material: [{
      ...legacyMaterial[0], duration_min: durationMin, distance_miles: distanceMiles,
    }],
    hybrid_running_projection_pace_s_per_mile: 600,
    validate: false,
  });
  const oneMeterDurationMin = 1 / ((60 / (600 * 1.1)) * 1609.344);
  const subMeterFixtures = [
    { durationMin: 0.001, distanceMiles: 6 },
    { durationMin: 0.05, distanceMiles: 0.0001 },
    { durationMin: oneMeterDurationMin - 1e-10, distanceMiles: 6 },
  ];
  for (const fixture of subMeterFixtures) {
    const candidate = buildEstimatedTimeCandidate(fixture.durationMin, fixture.distanceMiles);
    assert.equal(candidate.sessions[0].distance_m, null,
      'a positive sub-meter estimate remains unknown instead of becoming authoritative zero meters');
    assert.equal(candidate.candidate_material[0].distance_m, null);
    assert.equal(Object.hasOwn(
      candidate.candidate_material[0].source_session, 'canonical_prescribed_distance_m',
    ), false, 'a rounded-zero estimate has no canonical distance authority');
    assert.equal(Object.hasOwn(
      candidate.candidate_material[0].source_session, 'canonical_distance_derivation',
    ), false, 'a rounded-zero estimate has no canonical derivation stamp');
  }
  const oneMeterBoundary = buildEstimatedTimeCandidate(oneMeterDurationMin, 6);
  assert.equal(oneMeterBoundary.sessions[0].distance_m, 1,
    'the exact first whole-meter boundary remains a valid conservative prescription');
  assert.equal(
    oneMeterBoundary.candidate_material[0].source_session.canonical_distance_derivation,
    'observed_pace_conservative_110_percent_v1',
  );
  const normalOneMinute = buildEstimatedTimeCandidate(1, 6);
  assert.equal(normalOneMinute.sessions[0].distance_m, 146,
    'a normal one-minute time prescription remains 146 conservative meters');
  assert.equal(
    normalOneMinute.candidate_material[0].source_session.canonical_distance_derivation,
    'observed_pace_conservative_110_percent_v1',
  );
  let coercionHookCalls = 0;
  const coercionObject = {};
  Object.defineProperty(coercionObject, Symbol.toPrimitive, {
    enumerable: false,
    get() {
      coercionHookCalls += 1;
      return () => 600;
    },
  });
  const coercionProxy = new Proxy({}, {
    get(_target, property) {
      if ([Symbol.toPrimitive, 'valueOf', 'toString'].includes(property)) coercionHookCalls += 1;
      return property === Symbol.toPrimitive ? () => 600 : undefined;
    },
  });
  const hostilePaceDistances = ['600', [600], true, coercionObject, coercionProxy].map((pace) => {
    const candidate = buildGoalBackwardCandidateSkeleton({
      decision,
      legacy_road_candidate_material: legacyMaterial,
      hybrid_running_projection_pace_s_per_mile: pace,
      validate: false,
    });
    return candidate.sessions[0].distance_m;
  });
  assert.deepEqual(hostilePaceDistances, [null, null, null, null, null],
    'observed pace authority accepts only a primitive finite number');
  const hostileMaterialDistances = [
    { duration_min: '60', distance_miles: 6 },
    { duration_min: 60, distance_miles: [6] },
    { duration_min: coercionObject, distance_miles: 6 },
  ].map((hostile) => {
    try {
      const candidate = buildGoalBackwardCandidateSkeleton({
        decision,
        legacy_road_candidate_material: [{ ...legacyMaterial[0], ...hostile }],
        hybrid_running_projection_pace_s_per_mile: 600,
        validate: false,
      });
      return candidate.sessions[0].distance_m;
    } catch (_error) {
      return null;
    }
  });
  assert.deepEqual(hostileMaterialDistances, [null, null, null],
    'duration and distance material accept only primitive finite numbers');
  assert.equal(coercionHookCalls, 0, 'numeric validation never invokes object coercion hooks');
  for (const pace of [180, 2400]) {
    assert.ok(buildGoalBackwardCandidateSkeleton({
      decision,
      legacy_road_candidate_material: legacyMaterial,
      hybrid_running_projection_pace_s_per_mile: pace,
      validate: false,
    }).sessions[0].distance_m > 0, `${pace} s/mi remains inside the closed observed-pace boundary`);
  }
  for (const pace of [179.999, 2400.001, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(buildGoalBackwardCandidateSkeleton({
      decision,
      legacy_road_candidate_material: legacyMaterial,
      hybrid_running_projection_pace_s_per_mile: pace,
      validate: false,
    }).sessions[0].distance_m, null, `${pace} cannot authorize a canonical time-derived distance`);
  }
}

function checkC1ProjectionAggregationBoundary() {
  const decision = {
    decision_id: 'decision-c1-projection-boundary',
    decision_hash: 'a'.repeat(64),
    phase: 'DEVELOPMENT',
    primary_goal_id: 'goal-c1-projection-boundary',
    training_age_class: 'ESTABLISHED',
    minimum_weekly_demand: { running_m: 8000, required_exposure_count: 0 },
    role_multiset: [
      { requirement_id: 'support-1', any_of: ['easy_run'], role: 'SUPPORTING' },
      { requirement_id: 'support-2', any_of: ['easy_run'], role: 'SUPPORTING' },
    ],
    evidence_used: [],
    active_goals: [],
  };
  const skeleton = buildGoalBackwardCandidateSkeleton({
    decision,
    hybrid_running_projection_pace_s_per_mile: 550,
    legacy_road_candidate_material: [
      { id: 'compromised-large', workout_family: 'hyrox_compromised', distance_m: 6000, duration_min: 56 },
      { id: 'compromised-token', workout_family: 'hyrox_compromised', distance_m: 2000, duration_min: 30 },
    ],
  });
  const projected = skeleton.sessions.filter((session) => (
    session.material_source === 'CURRENT_HYBRID_RUNNING_COMPONENT'
  ));
  assert.equal(projected.length, 1, 'compromised running components aggregate into at most one support');
  assert.equal(projected[0].distance_m, 8000);
  assert.equal(projected[0].duration_min, 46,
    'the skeleton duration matches the aggregate running-only prescription');
  assert.deepEqual(projected[0].projection_source_material_ids, [
    'compromised-large', 'compromised-token',
  ]);
}

function checkC1BoundedCandidateSearch() {
  const availableDates = Array.from({ length: 7 }, (_, index) => (
    `2026-08-${String(index + 17).padStart(2, '0')}`
  ));
  const roles = Array.from({ length: 6 }, (_, index) => ({
    requirement_id: `bounded-role-${index + 1}`,
    any_of: ['manual_recovery', 'mobility'],
    role: index < 2 ? 'PRIMARY_KEY' : 'SUPPORTING',
  }));
  const decision = {
    decision_id: 'decision-c1-search-boundary',
    decision_hash: 'b'.repeat(64),
    phase: 'DEVELOPMENT',
    primary_goal_id: 'goal-c1-search-boundary',
    training_age_class: 'ESTABLISHED',
    role_multiset: roles,
    due_exposure_ledger: { due_roles: roles, unplaceable_requirement_ids: [] },
    evidence_used: [],
    active_goals: [],
  };
  const started = process.hrtime.bigint();
  const result = enumerateGoalBackwardCandidates({
    decision,
    available_local_dates: availableDates,
    maximum_session_count: roles.length,
    materialize_canonical: false,
    validation_options: {
      available_local_dates: availableDates,
      available_days_count: availableDates.length,
      training_age_class: 'ESTABLISHED',
      safety_action: 'NORMAL',
    },
  });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(result.search_diagnostics, 'bounded enumeration exposes deterministic diagnostics');
  assert.equal(result.search_diagnostics.search_complete, false);
  assert.equal(result.search_diagnostics.frontier_limit, MAX_GOAL_BACKWARD_SEARCH_FRONTIER);
  assert.equal(result.search_diagnostics.node_limit, MAX_GOAL_BACKWARD_SEARCH_NODES);
  assert.ok(result.search_diagnostics.expanded_node_count <= MAX_GOAL_BACKWARD_SEARCH_NODES);
  assert.ok(result.search_diagnostics.generated_leaf_count <= MAX_GOAL_BACKWARD_SEARCH_FRONTIER);
  assert.equal(
    result.truncation_reason,
    `CANDIDATE_SEARCH_FRONTIER_TRUNCATED_${MAX_GOAL_BACKWARD_SEARCH_FRONTIER}`,
  );
  assert.ok(elapsedMs < 2000, `bounded synthetic enumeration took ${elapsedMs.toFixed(1)}ms`);
  const replay = enumerateGoalBackwardCandidates({
    decision,
    available_local_dates: availableDates,
    maximum_session_count: roles.length,
    materialize_canonical: false,
    validation_options: {
      available_local_dates: availableDates,
      available_days_count: availableDates.length,
      training_age_class: 'ESTABLISHED',
      safety_action: 'NORMAL',
    },
  });
  assert.deepEqual(replay.search_diagnostics, result.search_diagnostics);
  assert.deepEqual(replay.candidates.map((candidate) => candidate.candidate_hash),
    result.candidates.map((candidate) => candidate.candidate_hash));

  const insufficientDates = availableDates.slice(0, 5);
  const impossible = enumerateGoalBackwardCandidates({
    decision,
    available_local_dates: insufficientDates,
    maximum_session_count: roles.length,
    materialize_canonical: false,
    validation_options: {
      available_local_dates: insufficientDates,
      available_days_count: insufficientDates.length,
      training_age_class: 'ESTABLISHED',
      safety_action: 'NORMAL',
    },
  });
  assert.equal(impossible.selected_candidate, null);
  assert.equal(impossible.candidates.length, 0);
  assert.equal(impossible.search_diagnostics.expanded_node_count, 0);
  assert.equal(impossible.truncation_reason, 'CANDIDATE_ROLE_COUNT_EXCEEDS_AVAILABLE_DAYS');
}

function checkC1BoundedMaterialBindings() {
  const decision = {
    decision_id: 'decision-c1-binding-boundary',
    decision_hash: 'a'.repeat(64),
    timezone: 'America/New_York',
    athlete_state_revision: 4,
    evidence_snapshot_id: 'snapshot-c1-binding-boundary',
    evidence_used: [{ evidence_id: 'evidence-c1-binding-boundary', purpose: 'CURRENT_PLANNING_SNAPSHOT' }],
    active_goals: [{
      goal_id: 'goal-c1-binding-boundary', race_id: 'race-c1-binding-boundary', source_revision: 3,
      event_local_date: '2026-09-06', event_state: 'SCHEDULED', priority: 'A',
    }],
    lock_revision: 0,
    edit_revision: 0,
    constraint_fingerprint: `sha256:${'b'.repeat(64)}`,
    safety_state: { action: 'NORMAL', scope: [] },
    policy_versions: {
      planning_policy_version: 'goal-backward-planning-policy-v1',
      event_policy_registry_version: 1,
      stress_taxonomy_version: 1,
    },
    event_policy_id: 'hyrox_doubles_v1',
  };
  const changes = Array.from({ length: 40 }, (_, index) => ({
    code: 'SESSION_DURATION_CHANGED',
    session_id: `session-c1-${String(index + 1).padStart(2, '0')}`,
    reason_code: 'MATERIAL_CHANGE_REVIEW_REQUIRED',
    review_required: true,
    decisive_evidence_ids: Array.from({ length: 4 }, (__, evidenceIndex) => (
      `evidence-${index + 1}-${evidenceIndex + 1}-${'x'.repeat(120)}`
    )),
    baseline_plan_revision: 2,
    candidate_plan_revision: 3,
    baseline_session_revision: 1,
    candidate_session_revision: 2,
    baseline_session_content_hash: `sha256:${String(index).padStart(64, '0')}`,
    candidate_session_content_hash: `sha256:${String(index + 1).padStart(64, '0')}`,
    decision_id: decision.decision_id,
    candidate_hash: `sha256:${'c'.repeat(64)}`,
    canonical_session_set_hash: `sha256:${'d'.repeat(64)}`,
  }));
  const input = {
    decision,
    decisionArtifact: {
      id: 'artifact-c1-binding-boundary', revision: 1, content_hash: `sha256:${'e'.repeat(64)}`,
    },
    selectedCandidate: {
      candidate_hash: `sha256:${'c'.repeat(64)}`,
      material_change: {
        material_change: true,
        preview_required: true,
        review_required: true,
        review_contract_complete: true,
        baseline_source: 'active_applied_plan',
        baseline_plan_revision: 2,
        candidate_plan_revision: 3,
        reason_codes: ['MATERIAL_CHANGE_REVIEW_REQUIRED'],
        changes,
      },
    },
    currentCandidateHash: `sha256:${'c'.repeat(64)}`,
  };
  const first = candidateLifecycle.buildGoalBackwardShadowBindings(input);
  const second = candidateLifecycle.buildGoalBackwardShadowBindings(input);
  assert.deepEqual(second, first, 'oversized material bindings compact deterministically');
  assert.ok(Buffer.byteLength(JSON.stringify(first.material_change_json), 'utf8') <= 16 * 1024);
  assert.equal(first.material_change_json.change_count, 40);
  assert.equal(first.material_change_json.changes_truncated, true);
  assert.match(first.material_change_json.changes_hash, /^sha256:[a-f0-9]{64}$/);
  assert.ok(first.material_change_json.changes.length > 0);
  assert.ok(first.material_change_json.changes.length < changes.length);
  assert.equal(first.material_change_json.apply_bindings.decision_hash, decision.decision_hash);
  assert.equal(first.material_change_json.apply_bindings.decision_artifact.artifact_id, input.decisionArtifact.id);

  const unknownFieldReceipt = candidateLifecycle.buildGoalBackwardShadowBindings({
    ...input,
    selectedCandidate: {
      ...input.selectedCandidate,
      material_change: {
        ...input.selectedCandidate.material_change,
        changes: [{
          ...changes[0],
          diagnostic_blob: 'not-persisted-'.repeat(1500),
        }],
      },
    },
  }).material_change_json;
  assert.equal(unknownFieldReceipt.changes.length, 1);
  assert.equal(unknownFieldReceipt.changes[0].source_fields_truncated, true);
  assert.equal(unknownFieldReceipt.changes_truncated, true,
    'dropped non-contract change fields cannot be reported as a complete change receipt');
}

function checkExplicitEventLifecycleAndOrderedPromotion() {
  const racesRouter = require('../src/routes/races');
  const transition = racesRouter._test.transitionRaceEventLifecycle;
  const normalizeRaceEvent = racesRouter._test.normalizeRaceEvent;
  const athleteId = 'ordered-transition-athlete';
  const raceA = {
    id: 'race-a', user_id: athleteId, race_name: 'A race', race_date: '2026-08-02',
    event_local_date: '2026-08-02', status: 'upcoming', event_config_json: '{}',
  };
  const malformedLegacy = normalizeRaceEvent({
    race_name: 'Invalid legacy status', race_date: '2026-10-11', distance_miles: 10,
    status: 'garbage', event_kind: 'run_race', event_config_json: {},
  });
  assert.equal(malformedLegacy.valid, false, 'an explicit malformed legacy status remains rejected');
  assert.throws(
    () => transition(raceA, { status: 'garbage' }),
    (error) => error?.code === 'EVENT_STATE_INVALID',
    'a malformed legacy status cannot be converted into UNKNOWN/upcoming during PATCH',
  );
  const semanticNoOp = transition(raceA, {
    status: 'upcoming', event_local_date: raceA.event_local_date,
  });
  assert.equal(semanticNoOp.changed, false);
  assert.equal(semanticNoOp.event_revision, 1);
  assert.equal(semanticNoOp.goal_revision, 1);
  const postponed = transition(raceA, { event_state: 'POSTPONED', event_local_date: '2026-09-06' });
  assert.equal(postponed.event_state, 'POSTPONED');
  assert.equal(postponed.event_local_date, '2026-09-06');
  assert.equal(postponed.goal_revision, 2);
  assert.equal(postponed.event_revision, 2);

  const completed = transition({ ...raceA, ...postponed }, {
    event_state: 'COMPLETED', race_result: { finish_time_s: 3600 },
  });
  assert.equal(completed.event_state, 'COMPLETED');
  assert.equal(completed.transition_exit_met, false);
  const exited = transition({ ...raceA, ...completed }, { transition_exit_met: true });
  assert.equal(exited.event_state, 'COMPLETED');
  assert.equal(exited.transition_exit_met, true);
  assert.equal(exited.goal_revision, completed.goal_revision + 1);

  const base = {
    athlete_id: athleteId,
    planning_date_local: '2026-08-03',
    timezone: 'America/New_York',
    athlete_state: {
      athlete_state_revision: 1, evidence_snapshot_id: 'snapshot-ordered', training_age_class: 'ESTABLISHED',
      consistency_state: 'CONSISTENT', consistent_weeks: 8, recovery_state: 'NORMAL', safety_action: 'NORMAL',
      recent_normal_running: { status: 'ESTABLISHED', median_distance_m: 30000 },
      available_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Sat'],
    },
    goals: [
      {
        goal_id: 'goal-a', race_id: 'race-a', athlete_id: athleteId, priority: 'A',
        event_kind: 'ROAD_SHORT', event_local_date: completed.event_local_date,
        event_state: completed.event_state, transition_exit_met: false, source_revision: completed.goal_revision,
      },
      {
        goal_id: 'goal-b', race_id: 'race-b', athlete_id: athleteId, priority: 'B',
        event_kind: 'ROAD_ENDURANCE', event_local_date: '2026-10-11', event_state: 'SCHEDULED', source_revision: 1,
      },
    ],
    races: [{ race_id: 'race-a', athlete_id: athleteId }, { race_id: 'race-b', athlete_id: athleteId }],
  };
  const postRace = buildGoalBackwardPlanningDecision(base);
  assert.equal(postRace.phase, 'POST_RACE_TRANSITION');
  assert.equal(postRace.primary_goal_id, 'goal-a');
  assert.deepEqual(postRace.active_goals.map((goal) => goal.goal_id), ['goal-a', 'goal-b']);

  const promoted = buildGoalBackwardPlanningDecision({
    ...base,
    goals: [{ ...base.goals[0], transition_exit_met: true, source_revision: exited.goal_revision }, base.goals[1]],
  });
  assert.equal(promoted.primary_goal_id, 'goal-b');
  assert.equal(promoted.promotion.promoted_from_goal_id, 'goal-a');
  assert.equal(promoted.promotion.promoted_to_goal_id, 'goal-b');
  assert.deepEqual(promoted.active_goals.map((goal) => goal.goal_id), ['goal-a', 'goal-b'], 'promotion preserves the full ordered race list');
}

async function checkRacePatchNoOpBoundary() {
  const dbModulePath = require.resolve('../src/db');
  const racesRoutePath = require.resolve('../src/routes/races');
  const originalDb = require.cache[dbModulePath];
  const originalRacesRoute = require.cache[racesRoutePath];
  const ownerId = 'race-noop-owner';
  const race = {
    id: 'race-noop', user_id: ownerId, race_name: 'No-op Race', race_date: '2026-10-11',
    event_local_date: '2026-10-11', distance_miles: 10, status: 'upcoming',
    event_kind: 'run_race', event_config_json: '{}',
  };
  let raceWrites = 0;
  let revisionIncrements = 0;
  const tx = {
    get: async (sql, params) => (
      sql.includes('FROM race_events WHERE id=? AND user_id=?')
        && params[0] === race.id && params[1] === ownerId ? { ...race } : null
    ),
    run: async () => { raceWrites += 1; return { changes: 1 }; },
  };
  require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: {
      dbGet: async () => null,
      dbAll: async () => [],
      withPlanningInputMutation: async (_userId, callback) => {
        const result = await callback(tx);
        if (result && Object.prototype.hasOwnProperty.call(result, 'marker')) return result.value;
        revisionIncrements += 1;
        return result;
      },
    },
    children: [],
    paths: [],
  };
  delete require.cache[racesRoutePath];
  try {
    const racesRouter = require('../src/routes/races');
    const patchRace = routeHandler(racesRouter, '/:id', 'patch');
    const requestBase = { user: { id: ownerId }, params: { id: race.id }, query: {}, headers: {} };
    const noOp = await invoke(patchRace, {
      ...requestBase,
      body: {
        status: 'upcoming', event_local_date: race.event_local_date,
        event_config_json: {},
      },
    });
    assert.equal(noOp.statusCode, 200, JSON.stringify(noOp.payload));
    assert.equal(raceWrites, 0, 'a non-empty semantic no-op performs no race writes');
    assert.equal(revisionIncrements, 0, 'a non-empty semantic no-op does not advance planning input revision');

    const invalid = await invoke(patchRace, { ...requestBase, body: { status: 'garbage' } });
    assert.equal(invalid.statusCode, 400, JSON.stringify(invalid.payload));
    assert.equal(raceWrites, 0, 'an invalid legacy status performs no race writes');
    assert.equal(revisionIncrements, 0, 'an invalid legacy status does not advance planning input revision');
  } finally {
    delete require.cache[racesRoutePath];
    if (originalRacesRoute) require.cache[racesRoutePath] = originalRacesRoute;
    if (originalDb) require.cache[dbModulePath] = originalDb;
    else delete require.cache[dbModulePath];
  }
}

function bryanPlannedSplit() {
  return {
    ski_erg: { athlete: { distance_m: 600 }, partner: { distance_m: 400 } },
    sled_push: { athlete: { distance_m: 30 }, partner: { distance_m: 20 } },
    sled_pull: { athlete: { distance_m: 30 }, partner: { distance_m: 20 } },
    burpee_broad_jump: { athlete: { distance_m: 48 }, partner: { distance_m: 32 } },
    row: { athlete: { distance_m: 600 }, partner: { distance_m: 400 } },
    farmers_carry: { athlete: { distance_m: 120 }, partner: { distance_m: 80 } },
    sandbag_lunge: { athlete: { distance_m: 60 }, partner: { distance_m: 40 } },
    wall_ball: { athlete: { repetitions: 60 }, partner: { repetitions: 40 } },
  };
}

function checkBryanGoalBackwardWitnessIntegration() {
  const state = hyrox.buildHyroxEventState({
    athlete_id: 'bryan-synthetic', format: 'doubles', registered_division: 'men',
    ruleset_id: 'hyrox-global', ruleset_version: '2026-2027',
    planned_station_split: bryanPlannedSplit(),
  });
  const witness = hyrox.buildBryanPeakWeekWitness({ hyrox_event_state: state });
  assert.equal(witness.weekly_running_miles, 19);
  assert.equal(witness.weekly_running_m, 30578);
  assert.equal(witness.minimum_weekly_running_m, 30416);
  assert.deepEqual(witness.weekly_stress_vector, [13, 12, 10, 5, 5, 9, 10, 7]);
  assert.equal(witness.validation.valid, true, JSON.stringify(witness.validation.violations));
}

function checkPartialClusterShadowIntegration(plansRouter) {
  const previousMode = process.env.FORGE_GOAL_BACKWARD_V24_MODE;
  process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'on';
  try {
    const planningDate = '2026-08-03';
    const eventDate = '2026-09-14';
    const trainingDays = ['Mon', 'Tue', 'Thu', 'Fri', 'Sun'];
    const medianVector = [11, 10, 7, 2, 2, 6, 7, 3];
    const modalityHistory = Object.fromEntries([
      'aerobic', 'running_impact', 'lower_body_muscular', 'upper_body_muscular',
      'grip', 'neuromuscular', 'metabolic', 'event_specific_fatigue',
    ].map((dimension, index) => [dimension, Array(6).fill(medianVector[index])]));
    const built = { plan: hyrox.generateHyroxPlan({
      planningLocalDate: planningDate,
      athlete: {
        id: 'cluster-route-athlete', weeklyMilesCurrent: 21, runDaysPerWeek: 4,
        training_age_class: 'ESTABLISHED',
      },
      currentLoad: { weeklyMiles: 21 },
      event: {
        raceId: 'cluster-route-race', eventLocalDate: eventDate,
        eventTimezone: 'America/New_York', format: 'individual_open', category: 'men', rulesVersion: '2026-2027',
      },
      equipment: HYROX_EQUIPMENT,
      availableDays: trainingDays,
    }) };
    const state = {
      inputHash: `sha256:${'1'.repeat(64)}`,
      planningInputRevision: 1,
      active: null,
      activePlan: null,
      races: [{
        id: 'cluster-route-race', user_id: 'cluster-route-athlete', race_date: eventDate,
        event_local_date: eventDate, event_kind: 'hyrox', event_format: 'individual_open',
        distance_miles: 4.97, goal_time_seconds: 3600,
      }],
      target: { trainingDays, hyroxEvent: { format: 'individual_open' } },
      context: {
        profile: { training_age_class: 'ESTABLISHED', timezone: 'America/New_York' },
        history: {
          recentRunCount: 24, weeklyMileageBaseline: 21,
          modalityHistory, previousTwoWeeksPassed: true,
        },
        recovery: { state: 'normal' },
        safety: {},
      },
    };
    const result = plansRouter._test.computeGoalBackwardShadowDiagnostics({
      userId: 'cluster-route-athlete',
      planningDateLocal: planningDate,
      built,
      state,
    });
    assert.equal(built.plan.hyroxPolicy.partialRaceOrderCluster.valid, true);
    assert.equal(result.decision.mandatory_hyrox_cluster, true);
    assert.ok(result.selected_candidate, 'the route materializes and selects a valid mandatory cluster-week candidate');
    assert.equal(result.selected_candidate.validation.valid, true);
    const selectedStress = aggregateWeeklyStress(result.selected_candidate.sessions).weekly_dimension_sum;
    assert.equal(selectedStress.every((value, index) => (
      value <= [16, 14, 12, 6, 6, 10, 12, 10][index]
    )), true);
    assert.ok(result.selected_candidate.validation.reason_codes.includes('PHASE_SPECIFIC_OVERLOAD'));
    const partial = result.selected_candidate.sessions.find((session) => (
      session.workout_family === 'hyrox_partial_simulation'
    ));
    assert.equal(hyrox.validatePartialRaceOrderCluster(partial, {
      training_age_class: 'ESTABLISHED',
    }).valid, true);
    const runningMeters = result.selected_candidate.sessions.reduce((sum, session) => {
      if (session.workout_family === 'hyrox_partial_simulation') return sum + session.running_distance_m;
      return ['easy_run', 'long_aerobic'].includes(session.workout_family)
        ? sum + Number(session.derived_totals?.distance_m || 0) : sum;
    }, 0);
    assert.ok(runningMeters >= result.decision.minimum_weekly_demand.running_m);

    const unauthorized = plansRouter._test.computeGoalBackwardShadowDiagnostics({
      userId: 'cluster-route-athlete', planningDateLocal: planningDate, built,
      state: {
        ...state,
        context: {
          ...state.context,
          history: { ...state.context.history, previousTwoWeeksPassed: false },
        },
      },
    });
    assert.equal(unauthorized.selected_candidate, null, 'normal ceilings reject unauthorized cluster overload');
    assert.ok(unauthorized.candidates.some((candidate) => (
      candidate.validation.violations.some((violation) => violation.code === 'CROSS_MODAL_FATIGUE_LIMIT')
    )));
  } finally {
    if (previousMode === undefined) delete process.env.FORGE_GOAL_BACKWARD_V24_MODE;
    else process.env.FORGE_GOAL_BACKWARD_V24_MODE = previousMode;
  }
}

function routeHandler(router, routePath, method) {
  const layer = router.stack.find((item) => item.route?.path === routePath && item.route?.methods?.[method]);
  return layer?.route?.stack?.at(-1)?.handle;
}

async function invoke(handler, req) {
  let statusCode = 200;
  let payload = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return this; },
  };
  await handler(req, res);
  return { statusCode, payload };
}

const raceTargets = [
  {
    raceId: 'yonkers-half-2026',
    raceName: 'Yonkers Half Marathon',
    raceDate: '2026-09-20',
    distanceMiles: 13.109,
    goalType: 'pr',
    goalTimeSeconds: 7200,
    source: 'Official Yonkers race page',
    url: 'https://events.elitefeats.com/26yonkers',
    courseProvenance: 'curated',
  },
  {
    raceId: 'army-ten-miler-2026',
    raceName: 'Army Ten-Miler',
    raceDate: '2026-10-11',
    distanceMiles: 10,
    goalType: 'pr',
    goalTimeSeconds: 5220,
    source: 'Official Army Ten-Miler page',
    url: 'https://www.armytenmiler.com/live-race-info/',
    courseProvenance: 'curated',
    elevation_gain_ft: 190,
    max_altitude_ft: 100,
    terrain: 'road',
  },
];

const context = {
  todayISO: '2026-08-03',
  profile: { weekly_miles_current: 16, run_days_per_week: 4, lift_days_per_week: 2 },
  target: {
    ...raceTargets[1],
    raceTargets,
    weeks: 10,
    startDate: '2026-08-03',
    planMode: 'hybrid_maintain',
    trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    runDaysPerWeek: 4,
    liftDaysPerWeek: 2,
  },
  history: {
    weeklyMileageBaseline: 16,
    recentRunCount: 20,
    recentLiftCount: 8,
    acuteRunLoad: { available: false, protection: { active: false } },
  },
  recovery: { state: 'normal', available: true, metrics: {} },
};

const plan = concurrent.buildConcurrentPlan(context);
const validation = concurrent.validateConcurrentPlan(plan, context);
assert.equal(validation.valid, true, validation.errors.join('; '));
assert.equal(plan.schemaVersion, 2);
assert.equal(plan.goals.length, 2);
assert.deepEqual(plan.goals.map((goal) => goal.raceId), raceTargets.map((race) => race.raceId));
assert.deepEqual(plan.goals.map((goal) => goal.priority), ['A', 'A']);
assert.deepEqual(plan.goals.map((goal) => goal.sequence), [1, 2]);
assert.deepEqual(plan.goals.map((goal) => goal.role), ['first_peak', 'final_peak']);
assert.equal(plan.goal.raceId, 'army-ten-miler-2026');
assert.equal(plan.goal.goalTimeSeconds, 5220);
assert.equal(plan.goal.goalPaceSecondsPerMile, 522);
assert.equal(plan.goals[0].course?.elevationGainFt, undefined, 'A1 must not inherit A2 elevation data');
assert.equal(plan.goals[0].course?.terrain, undefined, 'A1 must not inherit A2 terrain data');

const corruptBaselineContext = {
  ...context,
  profile: { ...context.profile, weekly_miles_current: 'Infinity' },
  history: { ...context.history, weeklyMileageBaseline: Number.POSITIVE_INFINITY },
};
const corruptBaseline = concurrent.estimateWeeklyMileageBaseline([
  { date: '2026-07-27', distance_miles: Number.POSITIVE_INFINITY, duration_seconds: 1800 },
], { planningDateISO: '2026-08-03', profileWeeklyMiles: 'Infinity' });
assert.equal(corruptBaseline.weeklyMiles, 0, 'non-finite legacy mileage is discarded at the baseline boundary');
assert.equal(
  concurrent.estimateWeeklyMileageBaseline([], { planningDateISO: '2026-08-03', profileWeeklyMiles: 5000 }).weeklyMiles,
  0,
  'legacy mileage above the profile boundary is discarded',
);
const corruptBaselinePlan = concurrent.buildConcurrentPlan(corruptBaselineContext);
const corruptBaselineValidation = concurrent.validateConcurrentPlan(corruptBaselinePlan, corruptBaselineContext);
assert.equal(corruptBaselineValidation.valid, true, corruptBaselineValidation.errors.join('; '));
assert.equal(
  corruptBaselinePlan.inputSummary.weeklyMileageBaseline,
  null,
  'a corrupt or absent baseline remains unknown in the persisted input summary instead of becoming zero',
);

const sessions = plan.weeks.flatMap((week) => week.days.flatMap((day) => (
  day.sessions.map((session) => ({ week, day, session }))
)));
const generatedRuns = sessions.filter(({ session }) => session.kind === 'run');
const canonicalHill = { kind: 'run', type: 'hill_repeats', title: '8 × 45-sec hill repeats' };
assert.equal(motivationalRunName(canonicalHill), 'Hills Pay the Bills', 'technical hill titles never replace motivational names');
assert.equal(canonicalHill.title, '8 × 45-sec hill repeats', 'motivational naming leaves the technical title unchanged');
assert.equal(generatedRuns.every(({ session }) => String(session.display_name || '').trim()), true, 'every generated run persists a display name');
assert.equal(
  planSchema.daySessions(generatedRuns[0].day)[0].display_name,
  generatedRuns[0].session.display_name,
  'the canonical session adapter preserves the persisted display name',
);
assert.equal(
  sessions.filter(({ session }) => session.kind === 'lift').every(({ session }) => session.display_name === undefined),
  true,
  'strength sessions are excluded from run naming',
);
assert.equal(
  generatedRuns.filter(({ session }) => session.type === 'hills').every(({ session }) => session.display_name === 'Hills Pay the Bills'),
  true,
  'generated hill work uses the owned motivational taxonomy',
);
const races = sessions.filter(({ session }) => session.type === 'race');
assert.equal(races.length, 2);
assert.deepEqual(races.map(({ day }) => day.date), ['2026-09-20', '2026-10-11']);
assert.deepEqual(races.map(({ session }) => session.distance_miles), [13.109, 10]);
assert.deepEqual(races.map(({ session }) => session.goal_pace_seconds_per_mile), [549, 522]);

const yonkersWeek = plan.weeks.findIndex((week) => week.days.some((day) => day.date === '2026-09-20'));
const armyWeek = plan.weeks.findIndex((week) => week.days.some((day) => day.date === '2026-10-11'));
assert.equal(plan.weeks[yonkersWeek - 1].phase, 'taper');
assert.equal(plan.weeks[yonkersWeek].phase, 'race');
assert.equal(plan.weeks[yonkersWeek + 1].phase, 'deload');
assert.equal(plan.weeks[armyWeek - 1].phase, 'taper');
assert.equal(plan.weeks[armyWeek].phase, 'race');

const firstGoalPaceWork = sessions.some(({ day, session }) => (
  day.date < '2026-09-20'
  && session.type !== 'race'
  && session.goal_pace_seconds_per_mile === 549
));
const finalGoalPaceWork = sessions.some(({ day, session }) => (
  day.date > '2026-09-20'
  && day.date < '2026-10-11'
  && session.type !== 'race'
  && session.goal_pace_seconds_per_mile === 522
));
assert.equal(firstGoalPaceWork, true);
assert.equal(finalGoalPaceWork, true);

for (const runDaysPerWeek of [2, 3, 4, 5]) {
  for (const weeklyMileageBaseline of [5, 6, 10, 16]) {
    const matrixContext = {
      ...context,
      profile: {
        ...context.profile,
        weekly_miles_current: weeklyMileageBaseline,
        run_days_per_week: runDaysPerWeek,
      },
      target: {
        ...context.target,
        runDaysPerWeek,
      },
      history: {
        ...context.history,
        weeklyMileageBaseline,
      },
    };
    const matrixPlan = concurrent.buildConcurrentPlan(matrixContext);
    const matrixValidation = concurrent.validateConcurrentPlan(matrixPlan, matrixContext);
    assert.equal(
      matrixValidation.valid,
      true,
      `${runDaysPerWeek} run days / ${weeklyMileageBaseline} baseline: ${matrixValidation.errors.join('; ')}`
    );
    const matrixSessions = matrixPlan.weeks.flatMap((week) => week.days.flatMap((day) => (
      day.sessions.map((session) => ({ date: day.date, session }))
    )));
    for (const race of raceTargets) {
      const targetPace = Math.round(race.goalTimeSeconds / race.distanceMiles);
      assert.equal(matrixSessions.some(({ date, session }) => (
        date < race.raceDate
        && session.type !== 'race'
        && Math.abs(Number(session.goal_pace_seconds_per_mile || 0) - targetPace) <= 1
      )), true, `${race.raceName} target pace is protected for the ${runDaysPerWeek}-day / ${weeklyMileageBaseline}-mile profile`);
    }
    const finalTaperSession = matrixSessions.find(({ date, session }) => (
      date > raceTargets[0].raceDate
      && date < raceTargets[1].raceDate
      && session.goal_pace_seconds_per_mile === 522
    ));
    assert.ok(finalTaperSession, 'the second race retains a target-pace session after the first race');
    assert.equal(finalTaperSession.session.type, 'sharpen', 'the second-race target pace is a real sharpening session');
    assert.ok(Number(finalTaperSession.session.distance_miles) >= 1.5, 'timed taper sharpening receives a viable distance allocation');
    for (const field of ['warmup', 'steps', 'cooldown']) {
      assert.ok(Array.isArray(finalTaperSession.session[field]) && finalTaperSession.session[field].length > 0, `sharpening ${field} is structured`);
    }
    for (const week of matrixPlan.weeks.filter((candidate) => candidate.phase === 'taper')) {
      const taperRuns = week.days.flatMap((day) => day.sessions).filter((session) => session.kind === 'run');
      taperRuns.forEach((session) => {
        const minimumDistance = ['sharpen', 'steady', 'long'].includes(session.type) ? 1.5 : 1;
        assert.ok(
          Number(session.distance_miles) >= minimumDistance,
          `${session.type} must remain credible in the ${runDaysPerWeek}-day / ${weeklyMileageBaseline}-mile taper`
        );
      });
    }
  }
}

const currentWeekTaperTarget = {
  raceId: 'army-current-week-taper',
  raceName: 'Army Ten-Miler',
  raceDate: '2026-08-16',
  distanceMiles: 10,
  goalType: 'pr',
  goalTimeSeconds: 5220,
};

function currentWeekTaperContext(longRunCompleted) {
  return {
    todayISO: '2026-08-05',
    profile: { weekly_miles_current: 8, run_days_per_week: 5, lift_days_per_week: 0 },
    target: {
      ...currentWeekTaperTarget,
      weeks: 2,
      startDate: '2026-08-03',
      planMode: 'run_only',
      trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      runDaysPerWeek: 5,
      liftDaysPerWeek: 0,
    },
    history: {
      weeklyMileageBaseline: 8,
      recentRunCount: 8,
      recentLiftCount: 0,
      performanceProfile: {
        targetAnchor: {
          equivalentTimeSeconds: 5400,
          equivalentPaceSecondsPerMile: 540,
          date: '2026-07-20',
          kind: 'cross_distance_estimate',
        },
      },
      acuteRunLoad: {
        available: true,
        protection: { active: false },
        currentWeek: {
          startDate: '2026-08-03',
          runCount: 1,
          runDates: ['2026-08-03'],
          miles: 1.2,
          longRunCompleted,
        },
        latestRun: {
          date: '2026-08-03',
          distanceMiles: 1.2,
          paceSecondsPerMile: 600,
        },
      },
    },
    recovery: { state: 'normal', available: true, metrics: {} },
  };
}

for (const longRunCompleted of [false, true]) {
  const taperContext = currentWeekTaperContext(longRunCompleted);
  const taperPlan = concurrent.buildConcurrentPlan(taperContext);
  const taperValidation = concurrent.validateConcurrentPlan(taperPlan, taperContext);
  assert.equal(taperValidation.valid, true, taperValidation.errors.join('; '));
  const taperWeek = taperPlan.weeks[0];
  const taperRuns = taperWeek.days.flatMap((day) => day.sessions).filter((session) => session.kind === 'run');
  assert.equal(taperRuns.length, 3, 'the current-week taper trims infeasible run slots');
  assert.equal(taperWeek.currentWeekConstraint.scheduledRunCount, taperRuns.length);
  assert.equal(taperWeek.currentWeekConstraint.totalRunsTowardTarget, 4);
  assert.equal(taperWeek.totalMiles, 4, 'the current-week taper conserves the remaining mileage target');
  assert.ok(taperRuns.some((session) => session.type === 'sharpen' && session.distance_miles >= 1.5));
}

const unstructuredTargetPace = JSON.parse(JSON.stringify(plan));
const unstructuredSession = unstructuredTargetPace.weeks
  .flatMap((week) => week.days)
  .flatMap((day) => day.sessions.map((session) => ({ date: day.date, session })))
  .find(({ date, session }) => (
    date > raceTargets[0].raceDate
    && date < raceTargets[1].raceDate
    && session.goal_pace_seconds_per_mile === 522
  ));
assert.ok(unstructuredSession, 'test fixture includes the second-race sharpening session');
unstructuredSession.session.type = 'easy';
const unstructuredValidation = concurrent.validateConcurrentPlan(unstructuredTargetPace, context);
assert.equal(unstructuredValidation.valid, false, 'goal-pace metadata on an unstructured easy run cannot satisfy the validator');
assert.equal(
  unstructuredValidation.errors.some((error) => error.includes('structured target-pace session before 2026-10-11')),
  true
);

const droppedGoal = JSON.parse(JSON.stringify(plan));
droppedGoal.goals = [droppedGoal.goals[1]];
const droppedValidation = concurrent.validateConcurrentPlan(droppedGoal, context);
assert.equal(droppedValidation.valid, false);
assert.equal(droppedValidation.errors.some((error) => error.includes('goals must preserve exactly 2')), true);

const renamedGoal = JSON.parse(JSON.stringify(plan));
renamedGoal.goals[0].name = 'Changed race';
renamedGoal.goal.course = null;
renamedGoal.goals[1].course = null;
const renamedValidation = concurrent.validateConcurrentPlan(renamedGoal, context);
assert.equal(renamedValidation.valid, false);
assert.equal(renamedValidation.errors.some((error) => /race name|course metadata/.test(error)), true);

for (const gapDays of [0, 7, 14, 20]) {
  const closeTargets = [
    { ...raceTargets[0], raceDate: '2026-08-09' },
    { ...raceTargets[1], raceDate: concurrent.addDays('2026-08-09', gapDays) },
  ];
  assert.throws(
    () => concurrent.normalizedRaceTargets({ raceTargets: closeTargets }),
    /different dates|at least 21 days apart/,
    `race pair ${gapDays} days apart must be rejected`
  );
}
assert.throws(
  () => concurrent.normalizedRaceTargets({ raceTargets: [...raceTargets, { ...raceTargets[1], raceDate: '2026-11-01' }] }),
  /no more than two race goals/
);
assert.throws(
  () => concurrent.normalizedRaceTargets({ raceTargets: [raceTargets[0], { ...raceTargets[1], raceDate: 'not-a-date' }] }),
  /valid raceDate/
);
for (const raceDate of ['2026-02-30', '2026-13-01']) {
  assert.throws(
    () => concurrent.normalizedRaceTargets({ raceTargets: [raceTargets[0], { ...raceTargets[1], raceDate }] }),
    /valid raceDate/,
    `${raceDate} must be rejected as an impossible calendar date`
  );
}

const currentWeekTargets = [
  { ...raceTargets[0], raceDate: '2026-08-09' },
  { ...raceTargets[1], raceDate: '2026-09-06' },
];
const currentWeekContext = {
  ...context,
  target: {
    ...context.target,
    ...currentWeekTargets[1],
    raceTargets: currentWeekTargets,
    weeks: 5,
  },
  history: {
    ...context.history,
    acuteRunLoad: {
      available: true,
      protection: { active: false },
      currentWeek: {
        startDate: '2026-08-03',
        runCount: 4,
        runDates: ['2026-08-03'],
        miles: 16,
        longRunCompleted: true,
      },
    },
  },
};
const currentWeekPlan = concurrent.buildConcurrentPlan(currentWeekContext);
const currentWeekValidation = concurrent.validateConcurrentPlan(currentWeekPlan, currentWeekContext);
assert.equal(currentWeekValidation.valid, true, currentWeekValidation.errors.join('; '));
const currentWeekRace = currentWeekPlan.weeks[0].days
  .flatMap((day) => day.sessions.map((session) => ({ date: day.date, session })))
  .find(({ session }) => session.type === 'race');
assert.equal(currentWeekRace?.date, '2026-08-09');
assert.equal(currentWeekPlan.weeks[0].currentWeekConstraint?.protectedRaceBeyondQuota, true);

function raceSnapshot(candidate, date) {
  for (const week of candidate.weeks) {
    for (const day of week.days) {
      if (day.date !== date) continue;
      const session = day.sessions.find((item) => item.type === 'race');
      return session ? JSON.parse(JSON.stringify(session)) : null;
    }
  }
  return null;
}

const yonkersRace = raceSnapshot(plan, '2026-09-20');
const lowReadiness = adaptation.buildAdaptationProposal({
  plan,
  planningDateISO: '2026-09-20',
  healthSignals: {
    metrics: {
      readinessScore: { value: 35, source: 'apple_health', asOf: '2026-09-20', freshness: 'fresh', suspect: false },
      sleepHoursLastNight: { value: 4.5, source: 'apple_health', asOf: '2026-09-20', freshness: 'fresh', suspect: false },
    },
  },
});
assert.deepEqual(raceSnapshot(lowReadiness.proposedPlan, '2026-09-20'), yonkersRace);

const injuryHold = adaptation.buildAdaptationProposal({
  plan,
  planningDateISO: '2026-09-20',
  injuryState: { active: true, bodyPart: 'calf', painLevel: 'severe', reason: 'severe calf pain' },
});
assert.deepEqual(raceSnapshot(injuryHold.proposedPlan, '2026-09-20'), yonkersRace);

const deletedRaceCandidate = JSON.parse(JSON.stringify(plan));
const raceDay = deletedRaceCandidate.weeks.flatMap((week) => week.days).find((day) => day.date === '2026-09-20');
raceDay.sessions = raceDay.sessions.filter((session) => session.type !== 'race');
const deletedRaceProposal = adaptation.buildAdaptationProposal({
  plan,
  planningDateISO: '2026-09-20',
  candidatePlan: deletedRaceCandidate,
});
assert.equal(deletedRaceProposal.status, 'keep');
assert.match(deletedRaceProposal.reason, /protected race/);

const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/plans.js'), 'utf8');
assert.match(routeSource, /delete safe\.raceTargets/);
assert.match(routeSource, /previewPlanForUser\(req\.user\.id/);
assert.match(routeSource, /plan_generation_candidates/);
assert.match(routeSource, /SELECT \* FROM race_events WHERE id=\? AND user_id=\?/);
assert.match(routeSource, /Two PR races must be at least 21 days apart/);
assert.doesNotMatch(routeSource, /persistConcurrentPlan\(req\.user\.id, evidencePlan/);

async function checkDedicatedRouteBoundary() {
  const dbModulePath = require.resolve('../src/db');
  const plansRoutePath = require.resolve('../src/routes/plans');
  const originalDb = require.cache[dbModulePath];
  const originalPlansRoute = require.cache[plansRoutePath];
  const RealDate = global.Date;
  const ownerId = 'dual-race-owner';
  const profile = {
    id: ownerId,
    weekly_miles_current: 16,
    run_days_per_week: 4,
    lift_days_per_week: 0,
    preferred_workout_days: JSON.stringify(['Mon', 'Tue', 'Thu', 'Sat']),
    goal_type: 'race',
    comeback_mode: 0,
    injury_notes: '',
    training_age_class: 'ESTABLISHED',
    planning_input_revision: 0,
  };
  const raceRows = new Map();
  let recentRunRows = [];
  let failTransaction = false;
  let transactionCalls = 0;
  const committedTransactionStatements = [];

  function raceRow(id, date, owner = ownerId) {
    return {
      id,
      user_id: owner,
      race_name: id === 'yonkers' ? 'Yonkers Half Marathon' : 'Army Ten-Miler',
      race_date: date,
      distance_miles: id === 'yonkers' ? 13.109 : 10,
      goal_time_seconds: id === 'yonkers' ? 7200 : 5220,
    };
  }

  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : ['2026-08-07T12:00:00.000Z']));
    }
    static now() { return new RealDate('2026-08-07T12:00:00.000Z').getTime(); }
  }

  const mockDb = {
    dbGet: async (sql, params = []) => {
      if (sql.includes('FROM users WHERE id = ?')) return params[0] === ownerId ? { ...profile } : null;
      if (sql.includes('FROM race_events WHERE id = ? AND user_id = ?')) {
        const race = raceRows.get(params[0]);
        return race && race.user_id === params[1] ? { ...race } : null;
      }
      return null;
    },
    dbAll: async (sql) => sql.includes('FROM runs') ? recentRunRows.map((run) => ({ ...run })) : [],
    dbRun: async () => ({ changes: 1 }),
    withUserMutation: async (_userId, fn) => {
      transactionCalls += 1;
      const tx = {
        all: async (sql) => sql.includes('FROM runs') ? recentRunRows.map((run) => ({ ...run })) : [],
        get: async (sql, params = []) => {
          if (sql.includes('FROM users WHERE id=?')) return params[0] === ownerId ? { ...profile } : null;
          if (sql.includes('FROM race_events WHERE id=? AND user_id=?')) {
            const race = raceRows.get(params[0]);
            return race && race.user_id === params[1] ? { ...race } : null;
          }
          return null;
        },
        run: async (sql) => {
          committedTransactionStatements.push(sql);
          return { changes: 1 };
        },
      };
      return fn(tx);
    },
    withPlanningInputMutation: async (_userId, fn) => {
      transactionCalls += 1;
      const stagedStatements = [];
      const tx = {
        run: async (sql) => {
          if (failTransaction && sql.includes('INSERT INTO training_plans')) throw new Error('intentional transaction failure');
          stagedStatements.push(sql);
          return { changes: 1 };
        },
      };
      const result = await fn(tx);
      committedTransactionStatements.push(...stagedStatements);
      return result;
    },
  };

  require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: mockDb,
    children: [],
    paths: [],
  };
  global.Date = FixedDate;
  delete require.cache[plansRoutePath];

  try {
    const plansRouter = require('../src/routes/plans');
    checkPartialClusterShadowIntegration(plansRouter);
    const generateForRaces = routeHandler(plansRouter, '/generate-for-races', 'post');
    const generateForRace = routeHandler(plansRouter, '/generate-for-race/:raceId', 'post');
    const generate = routeHandler(plansRouter, '/generate', 'post');
    const planningClock = {
      planning_date_local: '2026-08-07',
      timezone_offset_minutes: 240,
    };
    const baseRequest = {
      user: { id: ownerId },
      query: {},
      body: {
        ...planningClock,
        race_ids: [],
        target: {
          trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
          runDaysPerWeek: 4,
          liftDaysPerWeek: 0,
          planMode: 'run_only',
          liftingEnabled: false,
        },
      },
    };

    for (const malformed of [undefined, [], ['yonkers', ''], [{}], ['yonkers', {}], ['yonkers', 'yonkers'], ['a', 'b', 'c']]) {
      const response = await invoke(generateForRaces, {
        ...baseRequest,
        body: { ...baseRequest.body, race_ids: malformed },
      });
      assert.equal(response.statusCode, 400, `malformed race_ids ${JSON.stringify(malformed)} must return 400`);
    }

    let response = await invoke(generate, {
      ...baseRequest,
      body: { target: { raceTargets: raceTargets.map((race) => ({ ...race, elevation_gain_ft: 9999 })) } },
    });
    assert.equal(response.statusCode, 400, 'generic generation rejects nested multi-race input');

    raceRows.set('foreign', raceRow('foreign', '2026-09-20', 'different-owner'));
    response = await invoke(generateForRaces, {
      ...baseRequest,
      body: { ...baseRequest.body, race_ids: ['foreign'] },
    });
    assert.equal(response.statusCode, 404, 'cross-user race ID returns the uniform not-found response');

    raceRows.set('bad-date', raceRow('bad-date', '2026-02-30'));
    response = await invoke(generateForRaces, {
      ...baseRequest,
      body: { ...baseRequest.body, race_ids: ['bad-date'] },
    });
    assert.equal(response.statusCode, 400, 'stored impossible calendar date is rejected at the route boundary');

    raceRows.set('yonkers', raceRow('yonkers', '2026-09-20'));
    raceRows.set('army-close', raceRow('army-close', '2026-10-10'));
    response = await invoke(generateForRaces, {
      ...baseRequest,
      body: { ...baseRequest.body, race_ids: ['yonkers', 'army-close'] },
    });
    assert.equal(response.statusCode, 400, 'a 20-day pair is rejected at the route boundary');

    raceRows.set('army', raceRow('army', '2026-10-11'));
    response = await invoke(generateForRaces, {
      ...baseRequest,
      body: {
        ...planningClock,
        race_ids: ['yonkers', 'army'],
        target: { trainingDays: ['Mon'], runDaysPerWeek: 2, planMode: 'run_only', liftingEnabled: false },
      },
    });
    assert.equal(response.statusCode, 400, 'an impossible selected frequency is an actionable client error');
    assert.match(response.payload.error, /cannot exceed the number of selected trainingDays/);

    profile.weekly_miles_current = 'Infinity';
    profile.lift_days_per_week = 2;
    const transactionsBeforeSuccessfulPreview = transactionCalls;
    response = await invoke(generateForRaces, {
      ...baseRequest,
      body: {
        ...baseRequest.body,
        race_ids: ['yonkers', 'army'],
        target: {
          ...baseRequest.body.target,
          planMode: 'hybrid_maintain',
          liftingEnabled: true,
          liftDaysPerWeek: 2,
        },
      },
    });
    assert.equal(
      response.statusCode,
      201,
      response.payload ? JSON.stringify(response.payload) : 'a 21-day pair should generate',
    );
    assert.equal(response.payload.requires_apply, true, 'generation returns an explicit candidate preview');
    assert.deepEqual(response.payload.plan.plan_data.goals.map((goal) => goal.date), ['2026-09-20', '2026-10-11']);
    assert.equal(response.payload.plan.plan_data.weeks[0].startDate, '2026-08-03', 'a rebuild starts in the current training week');
    assert.equal(response.payload.plan.plan_data.schedulePreferences.runDaysPerWeek, 4, 'the edited frequency reaches the rebuilt plan');
    const currentWeekRunDates = response.payload.plan.plan_data.weeks[0].days.flatMap((day) => (
      day.sessions.some((session) => session.kind === 'run') ? [day.date] : []
    ));
    assert.deepEqual(currentWeekRunDates, ['2026-08-07', '2026-08-08'], 'a Friday rebuild schedules only today and remaining eligible dates');
    assert.equal(
      response.payload.plan.plan_data.inputSummary.weeklyMileageBaseline,
      null,
      'a corrupt profile value and incomplete activity coverage remain an unknown baseline in the preview',
    );
    assert.equal(
      transactionCalls - transactionsBeforeSuccessfulPreview,
      2,
      'preview reads consistently, then stores only after the revision recheck',
    );
    assert.equal(
      committedTransactionStatements.filter((sql) => /training_plans|user_plans/.test(sql)).length,
      0,
      'preview never writes an active or historical plan',
    );

    // Regression: the production rebuild happens late in the current week, not
    // from an empty Monday. The edited weekdays leave no safe pre-race quality
    // slot before the first of two races; elapsed days must not be backfilled.
    raceRows.set('near-a', raceRow('near-a', '2026-08-10'));
    raceRows.set('near-b', raceRow('near-b', '2026-08-31'));
    recentRunRows = [
      { id: 'prior-1', date: '2026-07-27', distance_miles: 5, duration_seconds: 2700, type: 'easy' },
      { id: 'prior-2', date: '2026-07-30', distance_miles: 5, duration_seconds: 2700, type: 'easy' },
      { id: 'today-run', date: '2026-08-07', distance_miles: 4, duration_seconds: 2100, type: 'easy' },
    ];
    response = await invoke(generateForRaces, {
      ...baseRequest,
      body: {
        ...planningClock,
        race_ids: ['near-a', 'near-b'],
        target: {
          trainingDays: ['Mon', 'Wed', 'Fri'],
          runDaysPerWeek: 3,
          liftDaysPerWeek: 0,
          planMode: 'run_only',
          liftingEnabled: false,
        },
      },
    });
    assert.equal(response.statusCode, 201, response.payload?.error || 'a partial-current-week two-race rebuild should generate');
    assert.equal(response.payload.plan.plan_data.schedulePreferences.runDaysPerWeek, 3);
    assert.deepEqual(response.payload.plan.plan_data.schedulePreferences.trainingDays, ['Mon', 'Wed', 'Fri']);
    assert.deepEqual(
      response.payload.plan.plan_data.weeks[0].days.flatMap((day) => day.sessions.map(() => day.date)),
      [],
      'the rebuild never backfills elapsed edited weekdays or duplicates today\'s completed run',
    );
    assert.equal(response.payload.plan.plan_data.weeks[0].currentWeekConstraint.totalRunsTowardTarget, 1);

    response = await invoke(generateForRace, {
      ...baseRequest,
      params: { raceId: 'near-a' },
      body: {
        ...planningClock,
        target: {
          trainingDays: ['Mon', 'Wed', 'Fri'],
          runDaysPerWeek: 3,
          liftDaysPerWeek: 0,
          planMode: 'run_only',
          liftingEnabled: false,
        },
      },
    });
    assert.equal(response.statusCode, 201, response.payload?.error || 'the same partial-current-week fix applies to a one-race rebuild');
    assert.equal(response.payload.plan.plan_data.schedulePreferences.runDaysPerWeek, 3);

    assert.equal(
      committedTransactionStatements.filter((sql) => sql.includes('INSERT INTO plan_generation_candidates')).length,
      3,
      'each successful preview stores one owner-bound candidate',
    );
  } finally {
    global.Date = RealDate;
    delete require.cache[plansRoutePath];
    if (originalPlansRoute) require.cache[plansRoutePath] = originalPlansRoute;
    if (originalDb) require.cache[dbModulePath] = originalDb;
    else delete require.cache[dbModulePath];
  }
}

async function checkHyroxCandidateImmediateAdoption() {
  const dbModulePath = require.resolve('../src/db');
  const plansRoutePath = require.resolve('../src/routes/plans');
  const racesRoutePath = require.resolve('../src/routes/races');
  const originalDb = require.cache[dbModulePath];
  const originalPlansRoute = require.cache[plansRoutePath];
  const originalRacesRoute = require.cache[racesRoutePath];
  const RealDate = global.Date;
  const originalGenerateHyroxPlan = hyrox.generateHyroxPlan;
  const previousMode = process.env.FORGE_GOAL_BACKWARD_V24_MODE;
  const previousAudience = process.env.FORGE_GOAL_BACKWARD_V24_AUDIENCE;
  process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'shadow';
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const planningDate = '2026-08-14';
  const profile = {
    id: ownerId,
    weekly_miles_current: 16,
    run_days_per_week: 4,
    lift_days_per_week: 0,
    preferred_workout_days: JSON.stringify(['Tue', 'Thu', 'Sat', 'Sun']),
    goal_type: 'race',
    comeback_mode: 0,
    injury_notes: '',
    planning_input_revision: 0,
  };
  const raceRows = new Map([
    ['hyrox', {
      id: 'hyrox',
      user_id: ownerId,
      race_name: 'HYROX New York',
      race_date: '2026-09-06',
      event_local_date: '2026-09-06',
      event_timezone: 'America/New_York',
      event_kind: 'hyrox',
      event_format: 'doubles',
      event_category: 'men',
      event_revision: 3,
      goal_revision: 4,
      rules_version: '2026-2027',
      event_config_json: JSON.stringify({
        equipment: HYROX_EQUIPMENT,
        hyroxPerformanceBudget: { target_total_time_s: 3660, source: 'stored-event-evidence' },
      }),
      distance_miles: 4.97,
      goal_time_seconds: 3600,
    }],
    ['army', {
      id: 'army',
      user_id: ownerId,
      race_name: 'Army Ten-Miler',
      race_date: '2026-10-11',
      event_local_date: '2026-10-11',
      event_timezone: 'America/New_York',
      event_kind: 'run_race',
      event_revision: 2,
      goal_revision: 3,
      distance_miles: 10,
      goal_time_seconds: 5220,
    }],
  ]);
  const recentRuns = [
    { id: 'run-1', date: '2026-07-27', distance_miles: 4, duration_seconds: 2200, type: 'easy', created_at: '2026-07-27T12:00:00Z' },
    { id: 'run-2', date: '2026-07-30', distance_miles: 5, duration_seconds: 2700, type: 'easy', created_at: '2026-07-30T12:00:00Z' },
    { id: 'run-3', date: '2026-08-04', distance_miles: 4, duration_seconds: 2200, type: 'easy', created_at: '2026-08-04T12:00:00Z' },
    { id: 'run-4', date: '2026-08-08', distance_miles: 6, duration_seconds: 3300, type: 'long', created_at: '2026-08-08T12:00:00Z' },
    { id: 'completed-today', date: planningDate, distance_miles: 3, duration_seconds: 1650, type: 'easy', created_at: '2026-08-14T11:00:00Z' },
  ];
  const initialPlan = hyrox.generateHyroxPlan({
    planningLocalDate: planningDate,
    athlete: { weeklyMilesCurrent: 16, runDaysPerWeek: 4, readiness: 'normal' },
    currentLoad: {
      weeklyMiles: 16,
      recentRunLoad: {
        currentWeek: {
          startDate: '2026-08-10',
          miles: 3,
          runCount: 1,
          runDates: [planningDate],
          longRunCompleted: false,
        },
      },
    },
    event: {
      raceId: 'hyrox',
      name: 'HYROX New York',
      eventLocalDate: '2026-09-06',
      eventTimezone: 'America/New_York',
      format: 'doubles',
      category: 'men',
      rulesVersion: '2026-2027',
    },
    equipment: HYROX_EQUIPMENT,
    availableDays: ['Tue', 'Thu', 'Sat', 'Sun'],
  });
  const trainingPlans = new Map([['training-hyrox', {
    id: 'training-hyrox',
    user_id: ownerId,
    week_start: initialPlan.weeks[0].startDate,
    plan_json: JSON.stringify(initialPlan),
    plan_data: JSON.stringify(initialPlan),
    name: 'HYROX New York',
    type: 'hyrox_build',
    weeks: initialPlan.weeks.length,
    description: 'Initial HYROX plan',
  }]]);
  const userPlans = new Map([['assignment-hyrox', {
    id: 'assignment-hyrox',
    user_id: ownerId,
    plan_id: 'training-hyrox',
    started_at: '2026-08-10',
    current_week: 1,
    status: 'active',
    progress_json: JSON.stringify({ completedSessionIds: ['completed-today'] }),
    plan_version: 1,
    lineage_id: 'lineage-hyrox-army',
    supersedes_user_plan_id: null,
    effective_from: '2026-08-10',
    created_at: '2026-08-10T00:00:00Z',
  }]]);
  const candidates = new Map();
  const planningArtifacts = new Map();
  const rejectionRows = [];
  let transactionWriteCount = 0;
  let failResetRaceDelete = false;
  let fixedNowIso = '2026-08-14T16:00:00.000Z';
  let databaseJsonShape = 'serialized';

  function databaseJsonValue(value) {
    return databaseJsonShape === 'postgres' && typeof value === 'string'
      ? JSON.parse(value) : value;
  }

  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [fixedNowIso]));
    }
    static now() { return new RealDate(fixedNowIso).getTime(); }
  }

  function joinedAssignment(assignment) {
    if (!assignment) return null;
    const planRow = trainingPlans.get(assignment.plan_id);
    return planRow ? {
      ...assignment,
      ...planRow,
      user_plan_id: assignment.id,
      plan_id: assignment.plan_id,
      current_week: assignment.current_week,
      started_at: assignment.started_at,
      status: assignment.status,
      progress_json: assignment.progress_json,
      plan_version: assignment.plan_version,
      lineage_id: assignment.lineage_id,
      supersedes_user_plan_id: assignment.supersedes_user_plan_id,
      effective_from: assignment.effective_from,
    } : null;
  }

  function currentAssignment() {
    return [...userPlans.values()]
      .filter((row) => row.user_id === ownerId && row.status === 'active')
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))[0] || null;
  }

  async function get(sql, params = []) {
    if (sql.includes('FROM users WHERE id=?') || sql.includes('FROM users WHERE id = ?')) {
      return params[0] === ownerId ? { ...profile } : null;
    }
    if (sql.includes('FROM race_events WHERE id=? AND user_id=?') || sql.includes('FROM race_events WHERE id = ? AND user_id = ?')) {
      const race = raceRows.get(params[0]);
      return race && race.user_id === params[1] ? { ...race } : null;
    }
    if (sql.includes('FROM plan_generation_candidates WHERE id=? AND user_id=?')) {
      const row = candidates.get(params[0]);
      return row && row.user_id === params[1] ? { ...row } : null;
    }
    if (sql.includes('SELECT id, plan_id, plan_version') && sql.includes("status='cleared'")) {
      const cleared = [...userPlans.values()]
        .filter((row) => row.user_id === params[0] && row.status === 'cleared')
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))[0];
      return cleared ? { ...cleared } : null;
    }
    if (sql.includes('JOIN planning_pipeline_artifacts canonical')
      && sql.includes("canonical.artifact_kind='canonical_session_set'")) {
      const candidate = [...candidates.values()].reverse().find((row) => (
        row.user_id === params[0]
        && row.applied_user_plan_id === params[1]
        && row.status === 'applied'
      ));
      const artifact = candidate && [...planningArtifacts.values()].find((row) => (
        row.user_id === params[0]
        && row.plan_generation_candidate_id === candidate.id
        && row.artifact_kind === 'canonical_session_set'
      ));
      if (!candidate || !artifact) return null;
      const assignment = userPlans.get(candidate.applied_user_plan_id);
      if (!assignment || assignment.status !== 'active') return null;
      return {
        artifact_id: artifact.id,
        artifact_user_id: artifact.user_id,
        artifact_kind: artifact.artifact_kind,
        artifact_decision_id: artifact.decision_id,
        artifact_candidate_id: artifact.plan_generation_candidate_id,
        artifact_schema_version: artifact.schema_version,
        artifact_policy_version: artifact.policy_version,
        artifact_revision: artifact.revision,
        artifact_content_hash: artifact.content_hash,
        artifact_payload_json: databaseJsonValue(artifact.payload_json),
        candidate_id: candidate.id,
        candidate_decision_id: candidate.decision_id,
        candidate_selected_hash: candidate.selected_candidate_hash,
        candidate_material_change_json: databaseJsonValue(candidate.material_change_json),
        candidate_applied_user_plan_id: candidate.applied_user_plan_id,
        candidate_status: candidate.status,
        assignment_id: assignment.id,
        assignment_user_id: assignment.user_id,
        assignment_plan_id: assignment.plan_id,
        assignment_plan_revision: assignment.plan_version,
        assignment_status: assignment.status,
      };
    }
    if (sql.includes('FROM planning_pipeline_artifacts') && sql.includes("artifact_kind='planning_decision'")) {
      const artifact = planningArtifacts.get(params[0]);
      return artifact && artifact.user_id === params[1] && artifact.decision_id === params[2]
        ? { ...artifact } : null;
    }
    if (sql.includes("up.status='active'") || sql.includes("up.status = 'active'")) {
      const assignment = currentAssignment();
      if (!assignment) return null;
      return sql.includes('JOIN training_plans')
        ? joinedAssignment(assignment)
        : { ...assignment, user_plan_id: assignment.id };
    }
    if (sql.includes('FROM user_plans up') && sql.includes('WHERE up.id=? AND up.user_id=?')) {
      const assignment = userPlans.get(params[0]);
      if (!assignment || assignment.user_id !== params[1]) return null;
      return sql.includes('JOIN training_plans')
        ? joinedAssignment(assignment)
        : { ...assignment, user_plan_id: assignment.id };
    }
    if (sql.includes('FROM training_plans tp') && sql.includes('owner_up.id=?')) {
      const planRow = trainingPlans.get(params[0]);
      const assignment = userPlans.get(params[1]);
      return planRow && assignment?.user_id === params[2] && assignment.plan_id === planRow.id
        ? { ...planRow }
        : null;
    }
    if (sql.includes('SELECT * FROM health_sync') || sql.includes('FROM injury_logs') || sql.includes('FROM daily_checkins')) return null;
    if (sql.includes('SELECT MAX(date) AS last_date FROM runs')) {
      return { last_date: recentRuns.map((run) => run.date).sort().at(-1) || null };
    }
    if (sql.includes('SELECT MAX(date) AS last_date FROM lifts') || sql.includes('MAX(substr(started_at')) return { last_date: null };
    if (sql.includes('SELECT max_hr') || sql.includes('SELECT max_heart_rate')) return { ...profile };
    if (sql.includes('FROM training_plans') && sql.includes('WHERE user_id')) {
      if (sql.includes('NOT EXISTS') && [...userPlans.values()].some((row) => (
        row.user_id === params[1] && row.status === 'cleared'
      ))) return null;
      const plan = [...trainingPlans.values()]
        .filter((row) => row.user_id === params[0])
        .sort((left, right) => String(right.created_at || '').localeCompare(String(left.created_at || '')))[0];
      return plan ? { ...plan } : null;
    }
    return null;
  }

  async function all(sql, params = []) {
    if (sql.includes('FROM runs')) return recentRuns.map((run) => ({ ...run }));
    if (sql.includes('FROM plan_candidate_rejections')) {
      return rejectionRows.filter((row) => row.user_id === params[0]
        && row.evidence_fingerprint === params[1]
        && row.constraint_fingerprint === params[2]
        && row.policy_fingerprint === params[3]).map((row) => ({ ...row }));
    }
    if (sql.includes('FROM user_plans up') && sql.includes('up.lineage_id=?')) {
      return [...userPlans.values()]
        .filter((row) => row.lineage_id === 'lineage-hyrox-army' && row.id !== currentAssignment()?.id)
        .map((row) => ({ ...row, ...trainingPlans.get(row.plan_id) }));
    }
    return [];
  }

  async function runStatement(sql, params = []) {
    transactionWriteCount += 1;
    if (sql.includes('INSERT INTO plan_generation_candidates')) {
      candidates.set(params[0], {
        id: params[0], user_id: params[1], status: params[2], training_plan_id: params[3],
        user_plan_id: params[4], active_plan_version: params[5], planning_input_revision: params[6],
        planning_date_local: params[7], timezone_offset_minutes: params[8], input_hash: params[9],
        candidate_hash: params[10], engine_version: params[11], policy_version: params[12],
        invariant_version: params[13], planning_snapshot_json: params[14], candidate_plan_json: params[15],
        generation_trace_json: params[16], expires_at: params[17],
        ...(params.length > 18 ? {
          decision_id: params[18], candidate_revision: params[19], athlete_state_revision: params[20],
          safety_state_hash: params[21], goal_revisions_json: params[22], lock_revision: params[23],
          edit_revision: params[24], surface_revision: params[25], export_revision: params[26],
          feature_mode: params[27], selected_candidate_hash: params[28], material_change_json: params[29],
        } : {}),
      });
      return { changes: 1 };
    }
    if (sql.includes('INSERT INTO planning_pipeline_artifacts')) {
      planningArtifacts.set(params[0], {
        id: params[0], user_id: params[1], artifact_kind: params[2], decision_id: params[3],
        parent_artifact_id: params[4], plan_generation_candidate_id: params[5],
        schema_version: params[6], policy_version: params[7], revision: params[8],
        content_hash: params[9], payload_json: params[10], created_at: params[11],
      });
      return { changes: 1 };
    }
    if (sql.includes('INSERT INTO plan_candidate_rejections')) {
      const duplicate = rejectionRows.some((row) => row.user_id === params[1]
        && row.candidate_hash === params[2]
        && row.evidence_fingerprint === params[6]
        && row.constraint_fingerprint === params[7]
        && row.policy_fingerprint === params[8]);
      if (duplicate) return { changes: 0 };
      rejectionRows.push({
        id: params[0], user_id: params[1], candidate_hash: params[2], decision_id: params[3],
        decision_hash: params[4], reason_code: params[5], evidence_fingerprint: params[6],
        constraint_fingerprint: params[7], policy_fingerprint: params[8], created_at: params[9],
      });
      return { changes: 1 };
    }
    if (sql.includes("UPDATE user_plans SET status='superseded'") && sql.includes('WHERE user_id=?')) {
      let changes = 0;
      for (const assignment of userPlans.values()) {
        if (assignment.user_id === params[0] && assignment.status === 'active') {
          assignment.status = 'superseded';
          changes += 1;
        }
      }
      return { changes };
    }
    if (sql.includes("UPDATE user_plans SET status='superseded'")) {
      const assignment = userPlans.get(params[0]);
      if (!assignment || assignment.user_id !== params[1] || assignment.status !== 'active') return { changes: 0 };
      assignment.status = 'superseded';
      return { changes: 1 };
    }
    if (sql.includes('INSERT INTO training_plans')) {
      trainingPlans.set(params[0], {
        id: params[0], user_id: params[1], week_start: params[2], plan_json: params[3],
        name: params[4], type: params[5], weeks: params[6], description: params[7], plan_data: params[8],
        created_at: `2026-08-14T16:00:${String(trainingPlans.size).padStart(2, '0')}.000Z`,
      });
      return { changes: 1 };
    }
    if (sql.includes('INSERT INTO user_plans')) {
      userPlans.set(params[0], {
        id: params[0], user_id: params[1], plan_id: params[2], started_at: params[3],
        current_week: params[4], status: params[5], progress_json: params[6], plan_version: params[7],
        lineage_id: params[8], supersedes_user_plan_id: params[9], effective_from: params[10],
        created_at: '2026-08-14T16:00:01.000Z',
      });
      return { changes: 1 };
    }
    if (sql.includes("SET status='applied'")) {
      const row = candidates.get(params[4]);
      if (!row || row.user_id !== params[5] || row.status !== 'preview') return { changes: 0 };
      Object.assign(row, {
        status: 'applied', applied_choice: params[0], applied_training_plan_id: params[1],
        applied_user_plan_id: params[2], replay_result_json: params[3], applied_at: '2026-08-14T16:00:02.000Z',
      });
      return { changes: 1 };
    }
    if (sql.includes("UPDATE plan_generation_candidates") && sql.includes("SET status='superseded'")
      && sql.includes('WHERE user_id=?')) {
      let changes = 0;
      for (const row of candidates.values()) {
        if (row.user_id === params[0] && row.status === 'preview') {
          row.status = 'superseded';
          changes += 1;
        }
      }
      return { changes };
    }
    if (sql.includes("SET status='superseded'")) {
      const row = candidates.get(params[0]);
      if (!row || row.user_id !== params[1] || row.status !== 'preview') return { changes: 0 };
      row.status = 'superseded';
      return { changes: 1 };
    }
    if (sql.includes('UPDATE users SET run_days_per_week=')) {
      profile.run_days_per_week = params[0];
      profile.preferred_workout_days = params[1];
      return { changes: 1 };
    }
    if (sql.includes('DELETE FROM race_events WHERE id=? AND user_id=?')) {
      if (failResetRaceDelete) throw new Error('injected reset deletion failure');
      const race = raceRows.get(params[0]);
      if (!race || race.user_id !== params[1]) return { changes: 0 };
      raceRows.delete(params[0]);
      return { changes: 1 };
    }
    return { changes: 1 };
  }

  const tx = { get, all, run: runStatement };
  const mockDb = {
    dbGet: get,
    dbAll: all,
    dbRun: runStatement,
    withUserMutation: async (_userId, fn) => fn(tx),
    withPlanningInputMutation: async (_userId, fn) => {
      const rollbackSnapshot = {
        races: new Map([...raceRows.entries()].map(([key, value]) => [key, JSON.parse(JSON.stringify(value))])),
        plans: new Map([...trainingPlans.entries()].map(([key, value]) => [key, JSON.parse(JSON.stringify(value))])),
        assignments: new Map([...userPlans.entries()].map(([key, value]) => [key, JSON.parse(JSON.stringify(value))])),
        candidates: new Map([...candidates.entries()].map(([key, value]) => [key, JSON.parse(JSON.stringify(value))])),
        artifacts: new Map([...planningArtifacts.entries()].map(([key, value]) => [key, JSON.parse(JSON.stringify(value))])),
      };
      try {
        const result = await fn(tx);
        return result && Object.prototype.hasOwnProperty.call(result, 'marker')
          && Object.prototype.hasOwnProperty.call(result, 'value')
          ? result.value
          : result;
      } catch (error) {
        for (const [target, source] of [
          [raceRows, rollbackSnapshot.races],
          [trainingPlans, rollbackSnapshot.plans],
          [userPlans, rollbackSnapshot.assignments],
          [candidates, rollbackSnapshot.candidates],
          [planningArtifacts, rollbackSnapshot.artifacts],
        ]) {
          target.clear();
          for (const [key, value] of source.entries()) target.set(key, value);
        }
        throw error;
      }
    },
  };

  require.cache[dbModulePath] = {
    id: dbModulePath, filename: dbModulePath, loaded: true, exports: mockDb, children: [], paths: [],
  };
  global.Date = FixedDate;
  delete require.cache[plansRoutePath];
  delete require.cache[racesRoutePath];

  try {
    const plansRouter = require('../src/routes/plans');
    const racesRouter = require('../src/routes/races');
    const carryForwardProbe = plansRouter._test.goalBackwardRemovalCarryForwardMaterial({
      request: { operation: 'remove_race', remove_race_id: 'yonkers' },
      races: [{ id: 'army' }],
    }, {
      canonical_workout_schema_version: 1,
      canonical_session_set_hash: 'a'.repeat(64),
      selected_candidate_hash: 'b'.repeat(64),
      weeks: [{ days: [{ date: planningDate, sessions: [
        { session_id: 'shared-easy', type: 'easy', goal_ids: ['goal-yonkers', 'goal-army'] },
        { session_id: 'shared-long', type: 'long', goal_ids: ['goal-army'] },
        { session_id: 'removed-only', type: 'easy', goal_ids: ['goal-yonkers'] },
        { session_id: 'race-specific', type: 'threshold', goal_ids: ['goal-yonkers', 'goal-army'] },
        { session_id: 'stale-binding', type: 'easy', goal_ids: ['goal-army', 'goal-ghost'] },
      ] }] }],
    }, [planningDate]);
    assert.deepEqual(carryForwardProbe.map((session) => session.session_id), ['shared-easy', 'shared-long'],
      'only canonical aerobic material explicitly shared with retained goals can cross removal');
    assert.deepEqual(plansRouter._test.goalBackwardRemovalCarryForwardMaterial({
      request: { operation: 'remove_race', remove_race_id: 'yonkers' },
      races: [{ id: 'army' }],
    }, { weeks: [] }, [planningDate]), [], 'legacy or identity-free active plans cannot authorize carry-forward');
    assert.deepEqual(plansRouter._test.canonicalCarryGoalIds({
      goal_ids: ['goal-army', 'goal-hyrox'],
      goalIds: ['goal-hyrox', 'goal-army'],
    }), ['goal-army', 'goal-hyrox'], 'canonical goal-id aliases are independently normalized');
    for (const hostileGoalBindings of [
      { goalIds: ['goal-army'] },
      { goal_ids: ['goal-army'], goalIds: ['goal-hyrox'] },
      { goal_ids: ['goal-army', 'goal-army'] },
      { goal_ids: [' goal-army'] },
      { goal_ids: [new String('goal-army')] },
    ]) {
      assert.equal(plansRouter._test.canonicalCarryGoalIds(hostileGoalBindings), null,
        'missing, conflicting, duplicate, non-primitive, and malformed bindings fail closed');
    }
    const validCarryState = {
      request: { operation: 'remove_race', remove_race_id: 'yonkers' },
      races: [{ id: 'army' }],
    };
    const validCarryPlan = {
      canonical_workout_schema_version: 1,
      canonical_session_set_hash: 'a'.repeat(64),
      selected_candidate_hash: 'b'.repeat(64),
      weeks: [{ days: [{ date: planningDate, sessions: [
        { session_id: 'shared-easy', type: 'easy', goal_ids: ['goal-yonkers', 'goal-army'] },
      ] }] }],
    };
    const mutateCarryPlan = (mutate) => {
      const plan = JSON.parse(JSON.stringify(validCarryPlan));
      mutate(plan);
      return plan;
    };
    const hostileCarryPlans = [
      ['string schema', mutateCarryPlan((plan) => { plan.canonical_workout_schema_version = '1'; })],
      ['array schema', mutateCarryPlan((plan) => { plan.canonical_workout_schema_version = [1]; })],
      ['object session-set hash', mutateCarryPlan((plan) => { plan.canonical_session_set_hash = { value: 'a'.repeat(64) }; })],
      ['invalid session-set hash', mutateCarryPlan((plan) => { plan.canonical_session_set_hash = 'not-a-hash'; })],
      ['object candidate hash', mutateCarryPlan((plan) => { plan.selected_candidate_hash = { value: 'b'.repeat(64) }; })],
      ['invalid candidate hash', mutateCarryPlan((plan) => { plan.selected_candidate_hash = 'not-a-hash'; })],
      ['object session id', mutateCarryPlan((plan) => { plan.weeks[0].days[0].sessions[0].session_id = {}; })],
      ['array session id', mutateCarryPlan((plan) => { plan.weeks[0].days[0].sessions[0].session_id = ['shared-easy']; })],
      ['object fallback id', mutateCarryPlan((plan) => {
        delete plan.weeks[0].days[0].sessions[0].session_id;
        plan.weeks[0].days[0].sessions[0].id = {};
      })],
      ['array workout type', mutateCarryPlan((plan) => { plan.weeks[0].days[0].sessions[0].type = ['easy']; })],
      ['array local date', mutateCarryPlan((plan) => { plan.weeks[0].days[0].date = [planningDate]; })],
    ];
    for (const [label, hostilePlan] of hostileCarryPlans) {
      assert.deepEqual(
        plansRouter._test.goalBackwardRemovalCarryForwardMaterial(validCarryState, hostilePlan, [planningDate]),
        [],
        `${label} cannot authorize canonical removal carry-forward`,
      );
    }
    const requiredDoseBoundary = plansRouter._test.goalBackwardRequiredRunningDoseReceipt;
    const boundaryHooks = { getter: 0, proxy: 0 };
    const accessorContainer = {};
    Object.defineProperty(accessorContainer, 'minimum_weekly_demand_m', {
      enumerable: true,
      get() { boundaryHooks.getter += 1; return 13; },
    });
    const inheritedContainer = Object.create({ minimum_weekly_demand_m: 13 });
    const proxiedContainer = new Proxy({ minimum_weekly_demand_m: 13 }, {
      get() { boundaryHooks.proxy += 1; return 13; },
      getOwnPropertyDescriptor() { boundaryHooks.proxy += 1; return undefined; },
      getPrototypeOf() { boundaryHooks.proxy += 1; return Object.prototype; },
      has() { boundaryHooks.proxy += 1; return true; },
      ownKeys() { boundaryHooks.proxy += 1; return ['minimum_weekly_demand_m']; },
    });
    const revocableContainer = Proxy.revocable({ minimum_weekly_demand_m: 13 }, {});
    revocableContainer.revoke();
    const symbolContainer = { minimum_weekly_demand_m: 13, [Symbol('hostile')]: 5 };
    const nullPrototypeContainer = Object.assign(Object.create(null), { minimum_weekly_demand_m: 13 });
    for (const hostileContainer of [
      { minimum_weekly_demand_m: 13 },
      accessorContainer,
      inheritedContainer,
      proxiedContainer,
      revocableContainer.proxy,
      { minimum_weekly_demand_m: 13, unexpected: true },
      symbolContainer,
      nullPrototypeContainer,
      Object.assign([], { minimum_weekly_demand_m: 13 }),
      null,
      '13',
    ]) {
      const closedReceipt = requiredDoseBoundary(hostileContainer);
      assert.equal(closedReceipt.valid, false);
      assert.deepEqual(closedReceipt.reason_codes, [
        'REQUIRED_RUNNING_DOSE_INVALID',
        'REQUIRED_RUNNING_DOSE_INPUT_UNTRUSTED',
      ]);
    }
    assert.deepEqual(boundaryHooks, { getter: 0, proxy: 0 },
      'the closed helper boundary executes no getters or Proxy traps');

    const fractionalRequiredDose = plansRouter._test
      .goalBackwardRequiredRunningDoseReceiptFromServerValuesForTest(
        22852.685, null, null, 'NOT_APPLICABLE', null,
      );
    assert.deepEqual({ ...fractionalRequiredDose, receipt_hash: undefined }, {
      schema_version: 1,
      valid: true,
      integralization_method: 'CEIL_TO_WHOLE_METER',
      raw_required_running_m: 22852.685,
      required_running_m: 22853,
      source_fields: ['minimum_weekly_demand_m'],
      removal_active_plan_state: 'NOT_APPLICABLE',
      removal_active_plan_reason: null,
      reason_codes: ['REQUIRED_RUNNING_DOSE_CEILED'],
      receipt_hash: undefined,
    });
    assert.match(fractionalRequiredDose.receipt_hash, /^sha256:[a-f0-9]{64}$/);
    const exactRequiredDose = plansRouter._test
      .goalBackwardRequiredRunningDoseReceiptFromServerValuesForTest(
        22853, null, null, 'NOT_APPLICABLE', null,
      );
    assert.equal(exactRequiredDose.required_running_m, 22853);
    assert.deepEqual(exactRequiredDose.reason_codes, []);
    for (const invalidValue of ['22852.685', [22852.685], NaN, -1, Number.MAX_SAFE_INTEGER + 1]) {
      const invalidRequiredDose = plansRouter._test
        .goalBackwardRequiredRunningDoseReceiptFromServerValuesForTest(
          null, null, invalidValue, 'KNOWN', null,
        );
      assert.equal(invalidRequiredDose.valid, false);
      assert.equal(invalidRequiredDose.raw_required_running_m, null);
      assert.equal(invalidRequiredDose.required_running_m, null);
      assert.deepEqual(invalidRequiredDose.reason_codes, ['REQUIRED_RUNNING_DOSE_INVALID']);
      assert.match(invalidRequiredDose.receipt_hash, /^sha256:[a-f0-9]{64}$/);
    }
    const unknownActiveRemovalDose = plansRouter._test
      .goalBackwardRequiredRunningDoseReceiptFromServerValuesForTest(
        1000, 1000, null, 'UNKNOWN', 'RUNNING_DISTANCE_MALFORMED',
      );
    assert.equal(unknownActiveRemovalDose.valid, false);
    assert.equal(unknownActiveRemovalDose.required_running_m, null);
    assert.ok(unknownActiveRemovalDose.reason_codes.includes('REQUIRED_RUNNING_DOSE_INVALID'));
    assert.ok(unknownActiveRemovalDose.reason_codes.includes('REMOVAL_ACTIVE_PLAN_RUNNING_DISTANCE_MALFORMED'));
    const preview = routeHandler(plansRouter, '/generate-for-races', 'post');
    const apply = routeHandler(plansRouter, '/candidates/:candidateId/apply', 'post');
    const reject = routeHandler(plansRouter, '/candidates/:candidateId/reject', 'post');
    const readMyPlan = routeHandler(plansRouter, '/my', 'get');
    const previewRaceRemoval = routeHandler(racesRouter, '/:id/removal-preview', 'post');
    const applyRaceRemoval = routeHandler(racesRouter, '/:id/removal-apply', 'post');
    const resetRaceRemoval = routeHandler(racesRouter, '/:id/removal-reset', 'post');
    const deleteRace = routeHandler(racesRouter, '/:id', 'delete');
    const requestClock = {
      planning_date_local: planningDate,
      timezone_offset_minutes: 240,
    };
    const requestBase = {
      user: { id: ownerId },
      query: { date: planningDate },
      headers: { 'x-forged-local-date': planningDate, 'x-forged-timezone-offset-minutes': '240' },
      get(name) { return this.headers[String(name).toLowerCase()]; },
    };
    const eligibilityTelemetry = [];
    const currentCandidateCountBeforeIneligible = candidates.size;
    const ineligibleGoalBackward = await plansRouter._test.previewPlanForUser(ownerId, {
      ...requestClock,
      race_ids: [],
      target: { trainingDays: ['Tue', 'Thu', 'Sat', 'Sun'], runDaysPerWeek: 4, liftingEnabled: false },
    }, {
      store: false,
      goalBackwardDependencies: {
        mode: 'preview',
        cohortRefs: [goalBackwardTargetRef(ownerId)],
        alertEntries: [],
        telemetrySink: (entry) => eligibilityTelemetry.push(entry),
      },
    });
    assert.equal(ineligibleGoalBackward.plan.goal_backward_engine_version, undefined,
      'a zero-goal request safely remains on the current engine');
    assert.equal(candidates.size, currentCandidateCountBeforeIneligible,
      'a read-only zero-goal compatibility probe persists no candidate');
    assert.equal(eligibilityTelemetry.length, 1, 'an authorized but ineligible v2.4 request is auditable');
    assert.deepEqual(eligibilityTelemetry[0].reason_counts, {
      EVIDENCE_MISSING: { pass: 0, fail: 1 },
    });
    assert.equal(eligibilityTelemetry[0].event_type, 'mode_resolution');
    assert.equal(eligibilityTelemetry[0].mode, 'preview');
    assert.equal(eligibilityTelemetry[0].outcome, 'candidate_rejected');
    assert.equal(eligibilityTelemetry[0].surface_capability, 'BLOCKED');
    const candidateCountBeforeForcedFailure = candidates.size;
    const artifactCountBeforeForcedFailure = planningArtifacts.size;
    const activePlanBeforeForcedFailure = currentAssignment().id;
    await assert.rejects(
      () => plansRouter._test.previewPlanForUser(ownerId, {
        ...requestClock,
        race_ids: ['hyrox', 'army'],
        target: { trainingDays: ['Tue', 'Thu', 'Sat', 'Sun'], runDaysPerWeek: 4, liftingEnabled: false },
      }, {
        goalBackwardDependencies: {
          mode: 'preview',
          cohortRefs: [goalBackwardTargetRef(ownerId)],
          alertEntries: [],
          enumerateCandidates: () => { throw new Error('synthetic forced v2.4 construction failure'); },
        },
      }),
      (error) => error?.code === 'GOAL_BACKWARD_GENERATION_FAILED' && error?.status === 409,
      'an authorized v2.4 construction failure must fail closed before legacy candidate persistence',
    );
    assert.equal(candidates.size, candidateCountBeforeForcedFailure, 'v2.4 failure persists no legacy candidate');
    assert.equal(planningArtifacts.size, artifactCountBeforeForcedFailure, 'v2.4 failure persists no partial artifacts');
    assert.equal(currentAssignment().id, activePlanBeforeForcedFailure, 'v2.4 failure changes no active plan');

    const candidateCountBeforeArtifactFailure = candidates.size;
    const artifactCountBeforeArtifactFailure = planningArtifacts.size;
    await assert.rejects(
      () => plansRouter._test.previewPlanForUser(ownerId, {
        ...requestClock,
        race_ids: ['hyrox', 'army'],
        target: {
          trainingDays: ['Mon', 'Tue', 'Thu', 'Sat', 'Sun'],
          runDaysPerWeek: 4,
          liftingEnabled: false,
        },
      }, {
        goalBackwardDependencies: {
          mode: 'on',
          cohortRefs: [goalBackwardTargetRef(ownerId)],
          alertEntries: [],
          buildArtifacts: () => { throw new Error('synthetic forced v2.4 artifact failure'); },
        },
      }),
      (error) => error?.code === 'GOAL_BACKWARD_GENERATION_FAILED' && error?.status === 409,
      'an authorized v2.4 artifact failure must fail closed before legacy candidate persistence',
    );
    assert.equal(candidates.size, candidateCountBeforeArtifactFailure, 'artifact failure persists no legacy candidate');
    assert.equal(planningArtifacts.size, artifactCountBeforeArtifactFailure, 'artifact failure persists no partial artifacts');
    assert.equal(currentAssignment().id, activePlanBeforeForcedFailure, 'artifact failure changes no active plan');

    profile.training_age_class = 'BEGINNER';
    let beginnerResult = null;
    await assert.rejects(
      () => plansRouter._test.previewPlanForUser(ownerId, {
        ...requestClock,
        race_ids: ['hyrox', 'army'],
        target: {
          trainingDays: ['Mon', 'Tue', 'Thu', 'Sat', 'Sun'],
          runDaysPerWeek: 4,
          liftingEnabled: false,
        },
      }, {
        goalBackwardDependencies: {
          mode: 'preview',
          cohortRefs: [goalBackwardTargetRef(ownerId)],
          alertEntries: [],
          inspectDecision: (result) => { beginnerResult = result; },
        },
      }),
      (error) => error?.code === 'GOAL_BACKWARD_GENERATION_FAILED' && error?.status === 409,
      'realistic volume that exceeds the explicit beginner cross-modal fallback must fail closed',
    );
    assert.equal(beginnerResult?.decision.training_age_class, 'BEGINNER');
    assert.equal(beginnerResult?.selected_candidate, null);
    assert.ok(beginnerResult?.candidates.some((candidate) => candidate.validation.violations.some((violation) => (
      violation.code === 'CROSS_MODAL_FATIGUE_LIMIT'
        || (violation.code === 'REQUIRED_EXPOSURE_UNPLACEABLE'
          && ['WEEKLY_RUNNING_FLOOR', 'WEEKLY_RUNNING_DISTANCE_UNKNOWN'].includes(violation.reason))
    ))), 'incomplete interval evidence fails closed with the bounded load reason the validator can actually prove');
    assert.ok(beginnerResult.candidates.every((candidate) => candidate.validation.violations.every((violation) => (
      violation.code !== 'BELOW_PRESENTATION_FLOOR_EXCEPTION'
    ))), 'incomplete evidence never manufactures a token workout to satisfy the floor');

    profile.training_age_class = 'ESTABLISHED';
    const originalRecentMiles = recentRuns.map((run) => run.distance_miles);
    [2, 3, 2, 4, 2].forEach((miles, index) => { recentRuns[index].distance_miles = miles; });
    let moderateResult = null;
    let moderateError = null;
    try {
      await plansRouter._test.previewPlanForUser(ownerId, {
        ...requestClock,
        race_ids: ['hyrox', 'army'],
        target: {
          trainingDays: ['Mon', 'Tue', 'Thu', 'Sat', 'Sun'],
          runDaysPerWeek: 4,
          liftingEnabled: false,
        },
      }, {
        store: false,
        goalBackwardDependencies: {
          mode: 'preview',
          cohortRefs: [goalBackwardTargetRef(ownerId)],
          alertEntries: [],
          inspectDecision: (result) => { moderateResult = result; },
        },
      });
    } catch (error) {
      moderateError = error;
    }
    assert.equal(moderateError, null, JSON.stringify({
      roles: moderateResult?.decision?.role_multiset,
      sessions: moderateResult?.candidates?.[0]?.sessions,
      violations: moderateResult?.candidates?.map((candidate) => candidate.validation.violations),
    }));
    assert.ok(moderateResult?.selected_candidate,
      'realistic two-to-four-mile runs retain an eligible bounded candidate');
    assert.equal(moderateResult.selected_candidate.validation.validator_results.find((entry) => (
      entry.validator === 'cross_modal_ceiling'
    )).valid, true);
    originalRecentMiles.forEach((miles, index) => { recentRuns[index].distance_miles = miles; });

    for (const mileageVector of [[6, 7, 6, 8, 4], [8, 9, 8, 12, 6]]) {
      mileageVector.forEach((miles, index) => { recentRuns[index].distance_miles = miles; });
      let sweepResult = null;
      let sweepError = null;
      try {
        await plansRouter._test.previewPlanForUser(ownerId, {
          ...requestClock,
          race_ids: ['hyrox', 'army'],
          target: {
            trainingDays: ['Mon', 'Tue', 'Thu', 'Sat', 'Sun'],
            runDaysPerWeek: 4,
            liftingEnabled: false,
          },
        }, {
          store: false,
          goalBackwardDependencies: {
            mode: 'preview',
            cohortRefs: [goalBackwardTargetRef(ownerId)],
            alertEntries: [],
            inspectDecision: (result) => { sweepResult = result; },
          },
        });
      } catch (error) {
        sweepError = error;
      }
      assert.equal(sweepError?.code, 'GOAL_BACKWARD_GENERATION_FAILED',
        `${mileageVector.join('/')} must fail closed when the current constructor cannot meet the running floor`);
      assert.equal(sweepResult?.selected_candidate, null);
      assert.ok(sweepResult?.candidates.length > 0);
      assert.ok(sweepResult.candidates.every((candidate) => (
        !candidate.validation.violations.some((violation) => (
          violation.code === 'BELOW_PRESENTATION_FLOOR_EXCEPTION'
        )) || candidate.validation.violations.some((violation) => (
          violation.code !== 'BELOW_PRESENTATION_FLOOR_EXCEPTION'
        ))
      )), `${mileageVector.join('/')} must not fail solely because of a token projected run: ${JSON.stringify(sweepResult.candidates.map((candidate) => candidate.validation.violations))}`);
      assert.ok(sweepResult.candidates.some((candidate) => candidate.validation.violations.some((violation) => (
        violation.reason === 'WEEKLY_RUNNING_FLOOR'
          || violation.reason === 'WEEKLY_RUNNING_DISTANCE_UNKNOWN'
      ))), `${mileageVector.join('/')} preserves the honest unmet-running-demand reason`);
      assert.ok(sweepResult.search_diagnostics.expanded_node_count <= MAX_GOAL_BACKWARD_SEARCH_NODES);
      assert.ok(sweepResult.search_diagnostics.generated_leaf_count <= MAX_GOAL_BACKWARD_SEARCH_FRONTIER);
      assert.ok(sweepResult.search_diagnostics.role_count <= sweepResult.search_diagnostics.available_day_count);
    }
    originalRecentMiles.forEach((miles, index) => { recentRuns[index].distance_miles = miles; });

    const originalLatestDuration = recentRuns.at(-1).duration_seconds;
    recentRuns.at(-1).duration_seconds = 0;
    let missingProjectionEvidenceResult = null;
    await assert.rejects(
      () => plansRouter._test.previewPlanForUser(ownerId, {
        ...requestClock,
        race_ids: ['hyrox', 'army'],
        target: {
          trainingDays: ['Mon', 'Tue', 'Thu', 'Sat', 'Sun'],
          runDaysPerWeek: 4,
          liftingEnabled: false,
        },
      }, {
        store: false,
        goalBackwardDependencies: {
          mode: 'preview',
          cohortRefs: [goalBackwardTargetRef(ownerId)],
          alertEntries: [],
          inspectDecision: (result) => { missingProjectionEvidenceResult = result; },
        },
      }),
      (error) => error?.code === 'GOAL_BACKWARD_GENERATION_FAILED' && error?.status === 409,
      'hybrid running cannot be projected without current pace evidence',
    );
    assert.equal(missingProjectionEvidenceResult?.selected_candidate, null);
    assert.ok(missingProjectionEvidenceResult?.candidates.some((candidate) => (
      candidate.validation.violations.some((violation) => (
        violation.reason === 'WEEKLY_RUNNING_FLOOR' || violation.reason === 'WEEKLY_RUNNING_DISTANCE_UNKNOWN'
      ))
    )));
    recentRuns.at(-1).duration_seconds = originalLatestDuration;

    const productionShapeClock = {
      planning_date_local: '2026-08-19',
      timezone_offset_minutes: 240,
    };
    const priorFixedNowIso = fixedNowIso;
    const productionShapeRunHistory = recentRuns.map((run) => ({
      distance_miles: run.distance_miles,
      duration_seconds: run.duration_seconds,
    }));
    recentRuns.forEach((run) => {
      run.distance_miles = 1;
      run.duration_seconds = 600;
    });
    fixedNowIso = '2026-08-19T16:00:00.000Z';
    let threeDayProductionShape = null;
    let threeDayProductionShapeError = null;
    let remainingArmyProductionShape = null;
    let remainingArmyProductionShapeError = null;
    try {
      await plansRouter._test.previewPlanForUser(ownerId, {
        ...productionShapeClock,
        race_ids: ['hyrox', 'army'],
        target: {
          trainingDays: ['Wed', 'Fri', 'Sun'],
          runDaysPerWeek: 3,
          liftDaysPerWeek: 0,
          liftingEnabled: false,
        },
      }, {
        store: false,
        goalBackwardDependencies: {
          mode: 'preview',
          cohortRefs: [goalBackwardTargetRef(ownerId)],
          alertEntries: [],
          inspectDecision: (result) => { threeDayProductionShape = result; },
        },
      });
      await plansRouter._test.previewPlanForUser(ownerId, {
        ...productionShapeClock,
        race_ids: ['army'],
        target: {
          trainingDays: ['Wed', 'Fri', 'Sun'],
          runDaysPerWeek: 3,
          liftDaysPerWeek: 0,
          liftingEnabled: false,
        },
      }, {
        store: false,
        goalBackwardDependencies: {
          mode: 'preview',
          cohortRefs: [goalBackwardTargetRef(ownerId)],
          alertEntries: [],
          inspectDecision: (result) => { remainingArmyProductionShape = result; },
        },
      });
    } catch (error) {
      if (!threeDayProductionShape?.selected_candidate) threeDayProductionShapeError = error;
      else remainingArmyProductionShapeError = error;
    } finally {
      fixedNowIso = priorFixedNowIso;
      productionShapeRunHistory.forEach((history, index) => {
        recentRuns[index].distance_miles = history.distance_miles;
        recentRuns[index].duration_seconds = history.duration_seconds;
      });
    }
    assert.equal(threeDayProductionShapeError, null, JSON.stringify({
      error: threeDayProductionShapeError && {
        code: threeDayProductionShapeError.code,
        message: threeDayProductionShapeError.message,
      },
      search: threeDayProductionShape?.search_diagnostics,
      roles: threeDayProductionShape?.decision?.role_multiset,
      skeletons: threeDayProductionShape?.candidates?.map((candidate) => (
        candidate.skeleton_sessions
      )),
      violations: threeDayProductionShape?.candidates?.map((candidate) => (
        candidate.validation.violations
      )),
    }));
    assert.ok(threeDayProductionShape?.selected_candidate,
      'the 2026-08-19 three-day synthetic HYROX plus road preview selects a hard-valid candidate');
    assert.equal(threeDayProductionShape.selected_candidate.validation.valid, true);
    assert.equal(remainingArmyProductionShapeError, null, JSON.stringify({
      error: remainingArmyProductionShapeError && {
        code: remainingArmyProductionShapeError.code,
        message: remainingArmyProductionShapeError.message,
      },
      search: remainingArmyProductionShape?.search_diagnostics,
      roles: remainingArmyProductionShape?.decision?.role_multiset,
      sessions: remainingArmyProductionShape?.candidates?.[0]?.sessions,
      violations: remainingArmyProductionShape?.candidates?.map((candidate) => (
        candidate.validation.violations
      )),
    }));
    assert.ok(remainingArmyProductionShape?.selected_candidate,
      'the 2026-08-19 three-day remaining-Army preview selects a hard-valid candidate');
    const remainingArmyFoundationSession = remainingArmyProductionShape.selected_candidate.sessions[0];
    assert.equal(remainingArmyFoundationSession.workout_family, 'recovery_run');
    assert.equal(remainingArmyFoundationSession.title, 'Recovery run');
    assert.ok(remainingArmyFoundationSession.derived_totals.duration_s >= 20 * 60);
    assert.equal(
      remainingArmyFoundationSession.purpose_reason_codes.includes('BELOW_PRESENTATION_FLOOR_EXCEPTION'),
      false,
    );
    assert.equal(remainingArmyFoundationSession.beginner_or_rehab_protocol_id, undefined);

    let authorizedResult = null;
    let authorizedPreview = null;
    let authorizedError = null;
    try {
      authorizedPreview = await plansRouter._test.previewPlanForUser(ownerId, {
        ...requestClock,
        race_ids: ['hyrox', 'army'],
        target: {
          trainingDays: ['Mon', 'Tue', 'Thu', 'Sat', 'Sun'],
          runDaysPerWeek: 4,
          liftingEnabled: false,
        },
      }, {
        goalBackwardDependencies: {
          mode: 'preview',
          cohortRefs: [goalBackwardTargetRef(ownerId)],
          alertEntries: [],
          sourceRevision: 'd4169340b99469895372dd45ef6505c4e25d049e',
          deploymentRevision: 'd4169340b99469895372dd45ef6505c4e25d049e',
          inspectDecision: (result) => { authorizedResult = result; },
        },
      });
    } catch (error) {
      authorizedError = error;
    }
    assert.equal(authorizedError, null, JSON.stringify({
      error: authorizedError && { code: authorizedError.code, message: authorizedError.message },
      diagnostics: authorizedResult?.search_diagnostics,
      violations: authorizedResult?.candidates.map((candidate) => candidate.validation.violations),
    }));
    assert.ok(plansRouter._test.applicableGoalBackwardPlan(authorizedPreview.plan, authorizedResult),
      'the exact one-to-one current/decision goal binding remains applicable');
    const bindingMutationCases = [
      {
        label: 'duplicate plan goal',
        mutate(plan) { plan.goals[1] = { ...plan.goals[0] }; },
      },
      {
        label: 'blank plan race id',
        mutate(plan) { plan.goals[0].raceId = ''; },
      },
      {
        label: 'contradictory plan race aliases',
        mutate(plan) { plan.goals[0].race_id = 'race-other'; },
      },
      {
        label: 'mismatched optional goal id',
        mutate(plan) { plan.goals[0].goal_id = 'goal-other'; },
      },
      {
        label: 'mismatched optional owner',
        mutate(plan) { plan.goal_feasibilities[0].athlete_id = '22222222-2222-4222-8222-222222222222'; },
      },
      {
        label: 'mismatched optional event revision',
        mutate(plan) { plan.goal_feasibilities[0].event_revision = 999; },
      },
      {
        label: 'duplicate plan feasibility',
        mutate(plan) { plan.goal_feasibilities[1] = { ...plan.goal_feasibilities[0] }; },
      },
      {
        label: 'contradictory feasibility race aliases',
        mutate(plan) { plan.goal_feasibilities[0].raceId = 'race-other'; },
      },
      {
        label: 'unknown current feasibility status',
        mutate(plan) { plan.goal_feasibilities[0].feasibility = 'hostile'; },
      },
      {
        label: 'duplicate decision feasibility',
        mutate(_plan, result) { result.decision.goal_feasibilities[1] = { ...result.decision.goal_feasibilities[0] }; },
      },
      {
        label: 'unsupported decision feasibility',
        mutate(_plan, result) { result.decision.goal_feasibilities[0].status = 'not_currently_supported'; },
      },
      {
        label: 'cross-owner active goal',
        mutate(_plan, result) {
          result.decision.active_goals[1].athlete_id = '22222222-2222-4222-8222-222222222222';
        },
      },
      {
        label: 'foreign owner active goal set',
        mutate(_plan, result) {
          result.decision.active_goals.forEach((goal) => {
            goal.athlete_id = '22222222-2222-4222-8222-222222222222';
          });
        },
      },
    ];
    for (const mutation of bindingMutationCases) {
      const plan = JSON.parse(JSON.stringify(authorizedPreview.plan));
      const result = JSON.parse(JSON.stringify(authorizedResult));
      mutation.mutate(plan, result);
      assert.equal(plansRouter._test.applicableGoalBackwardPlan(plan, result), null,
        `${mutation.label} fails the closed feasibility binding`);
    }
    assert.equal(authorizedResult.decision.training_age_class, 'ESTABLISHED');
    assert.ok(authorizedResult.selected_candidate, 'realistic established mileage produces an eligible bounded candidate');
    assert.ok(authorizedResult.candidates.length <= 64);
    assert.ok(authorizedResult.search_diagnostics.expanded_node_count <= MAX_GOAL_BACKWARD_SEARCH_NODES);
    assert.ok(authorizedResult.search_diagnostics.generated_leaf_count <= MAX_GOAL_BACKWARD_SEARCH_FRONTIER);
    assert.equal(
      authorizedResult.decision.candidate_enumeration.expanded_node_count,
      authorizedResult.search_diagnostics.expanded_node_count,
    );
    const runningFamilies = new Set([
      'recovery_run', 'easy_run', 'long_aerobic', 'steady_run', 'threshold_run',
      'interval_run', 'race_rhythm_run', 'assessment', 'race',
    ]);
    const canonicalPlanRunningMeters = (plan) => (plan?.weeks || [])
      .flatMap((week) => week.days || [])
      .flatMap((day) => day.sessions || [])
      .reduce((sum, session) => (
        sum + (runningFamilies.has(session.workout_family)
          ? Number(session.derived_totals?.distance_m || 0) : 0)
      ), 0);
    const selectedRunningMeters = authorizedResult.selected_candidate.sessions.reduce((sum, session) => (
      sum + (runningFamilies.has(session.workout_family) ? Number(session.derived_totals?.distance_m || 0) : 0)
    ), 0);
    assert.ok(selectedRunningMeters >= 13815,
      'the exact 4/5/4/6/3 history stays above the 13,815m incident regression floor');
    assert.equal(selectedRunningMeters, 14690);
    assert.ok(selectedRunningMeters >= authorizedResult.decision.minimum_weekly_demand.running_m,
      'selected candidate satisfies the full realistic-volume weekly running floor');
    assert.equal(authorizedResult.selected_candidate.validation.validator_results.find((entry) => (
      entry.validator === 'cross_modal_ceiling'
    )).valid, true);
    const authorizedMaterialDose = authorizedResult.selected_candidate.validation.validator_results.find((entry) => (
      entry.validator === 'material_dose'
    ));
    assert.equal(authorizedMaterialDose.valid, true);
    assert.equal(authorizedMaterialDose.receipt.reduction_authorization, null,
      'realistic history needs no synthetic BLOCK scope to retain material running dose');
    const selectedRunningPrimary = authorizedResult.selected_candidate.skeleton_sessions.find((session) => (
      session.role === 'PRIMARY_KEY' && runningFamilies.has(session.workout_family)
    ));
    assert.ok(selectedRunningPrimary, 'the selected candidate retains a materialized running primary');
    assert.equal(selectedRunningPrimary.workout_family, selectedRunningPrimary.material_source_workout_family,
      'the exact running source remains attached to the running primary requirement');
    const selectedSupports = authorizedResult.selected_candidate.sessions
      .filter((session) => session.role === 'SUPPORTING')
      .map((session) => ({ family: session.workout_family, supports: session.supports_requirement_id }));
    assert.ok(selectedSupports.length >= 2);
    assert.ok(selectedSupports.every((entry) => (
      runningFamilies.has(entry.family) && entry.supports === selectedRunningPrimary.requirement_id
    )), 'running support maps to the exact running primary requirement');
    const projectedRunningSupport = authorizedResult.selected_candidate.skeleton_sessions.find((session) => (
      session.material_source === 'CURRENT_HYBRID_RUNNING_COMPONENT'
        && session.material_source_workout_family === 'hyrox_compromised'
        && session.workout_family === 'easy_run'
        && session.supports_requirement_id === selectedRunningPrimary.requirement_id
    ));
    assert.ok(projectedRunningSupport,
      'a hybrid source contributes only its bounded running component to the canonical candidate');
    const projectedCanonicalRun = authorizedResult.selected_candidate.sessions.find((session) => (
      session.session_id === projectedRunningSupport.session_id
    ));
    assert.equal(projectedCanonicalRun.title, 'Easy aerobic run',
      'the projected session is presented as its canonical running-only purpose');
    assert.equal(projectedCanonicalRun.derived_totals.duration_s, 35 * 60,
      'the running-only duration is derived from current run evidence, not the hybrid session total');
    assert.equal(projectedRunningSupport.duration_min, 35,
      'the skeleton and canonical running-only durations remain consistent');

    let onResult = null;
    await plansRouter._test.previewPlanForUser(ownerId, {
      ...requestClock,
      race_ids: ['hyrox', 'army'],
      target: {
        trainingDays: ['Mon', 'Tue', 'Thu', 'Sat', 'Sun'],
        runDaysPerWeek: 4,
        liftingEnabled: false,
      },
    }, {
      store: false,
      goalBackwardDependencies: {
        mode: 'on',
        cohortRefs: [goalBackwardTargetRef(ownerId)],
        alertEntries: [],
        inspectDecision: (result) => { onResult = result; },
      },
    });
    assert.ok(onResult?.selected_candidate, 'on mode uses the same bounded candidate search');
    assert.ok(onResult.search_diagnostics.expanded_node_count <= MAX_GOAL_BACKWARD_SEARCH_NODES);
    assert.ok(onResult.search_diagnostics.generated_leaf_count <= MAX_GOAL_BACKWARD_SEARCH_FRONTIER);
    const authorizedRow = candidates.get(authorizedPreview.id);
    assert.equal(authorizedRow.feature_mode, 'preview');
    assert.equal(authorizedRow.engine_version, 'goal-backward-coaching-v2.4');
    assert.ok(authorizedRow.decision_id);
    assert.ok(Number(authorizedRow.athlete_state_revision) >= 1);
    assert.ok(Number(authorizedRow.candidate_revision) >= 1);
    assert.match(authorizedRow.candidate_hash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(authorizedRow.selected_candidate_hash, authorizedRow.candidate_hash);
    assert.deepEqual(JSON.parse(authorizedRow.goal_revisions_json), {
      'goal-army': 3,
      'goal-hyrox': 4,
    });
    const materialReview = JSON.parse(authorizedRow.material_change_json);
    assert.ok(Array.isArray(materialReview.reason_codes));
    assert.ok(materialReview.apply_bindings?.decision_artifact?.artifact_id);
    const authorizedArtifacts = [...planningArtifacts.values()]
      .filter((artifact) => artifact.plan_generation_candidate_id === authorizedPreview.id);
    assert.deepEqual(authorizedArtifacts.map((artifact) => artifact.artifact_kind).sort(), [
      'candidate_week', 'canonical_session_set', 'surface_manifest', 'validator_result',
    ]);
    const authorizedDecisionArtifacts = [...planningArtifacts.values()]
      .filter((artifact) => artifact.decision_id === authorizedRow.decision_id);
    assert.deepEqual(authorizedDecisionArtifacts.map((artifact) => artifact.artifact_kind).sort(), [
      'athlete_state', 'candidate_week', 'canonical_session_set', 'evidence_snapshot',
      'planning_decision', 'surface_manifest', 'validator_result',
    ]);
    const evidenceArtifact = authorizedDecisionArtifacts.find((artifact) => (
      artifact.artifact_kind === 'evidence_snapshot'
    ));
    assert.equal(
      JSON.parse(evidenceArtifact.payload_json).source_revision,
      'd4169340b99469895372dd45ef6505c4e25d049e',
    );
    const validatorArtifact = authorizedDecisionArtifacts.find((artifact) => (
      artifact.artifact_kind === 'validator_result'
    ));
    assert.equal(JSON.parse(validatorArtifact.payload_json).material_review.review_contract_complete, true);
    const canonicalArtifact = authorizedDecisionArtifacts.find((artifact) => (
      artifact.artifact_kind === 'canonical_session_set'
    ));
    const canonicalPayload = JSON.parse(canonicalArtifact.payload_json);
    assert.equal(
      canonicalPayload.selected_candidate_hash.replace(/^sha256:/, ''),
      authorizedRow.selected_candidate_hash.replace(/^sha256:/, ''),
    );
    assert.equal(canonicalPayload.canonical_sessions_materialized, true);
    assert.ok(canonicalPayload.content_hash);
    assert.ok(authorizedPreview.surfaceManifest?.identity?.canonical_session_set_hash);
    const productionDiagnostic = buildDecisionArtifactDiagnosticBundle({
      targetUserId: ownerId,
      decisionId: authorizedRow.decision_id,
      artifactRows: authorizedDecisionArtifacts,
      candidateRow: authorizedRow,
    });
    assert.equal(productionDiagnostic.production_complete, true,
      JSON.stringify(productionDiagnostic.reason_codes));
    assert.equal(productionDiagnostic.stages.length, 11);
    assert.equal(productionDiagnostic.canonical_binding.verified, true);
    assert.equal(productionDiagnostic.release_identity.revisions_match, true);
    assert.equal(currentAssignment().id, activePlanBeforeForcedFailure, 'preview cannot mutate the active plan');

    process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'on';
    process.env.FORGE_GOAL_BACKWARD_V24_AUDIENCE = 'all';
    const malformedFeasibilityResults = [];
    for (const malformed of [
      {
        label: 'empty',
        mutate(plan) { plan.goal_feasibilities = []; },
      },
      {
        label: 'ghost',
        mutate(plan) {
          plan.goal_feasibilities.push({
            race_id: 'R_GHOST', race_name: 'Ghost race', feasibility: 'unsafe',
            reasons: ['UNBOUND_HOSTILE_ROW'],
          });
        },
      },
    ]) {
      hyrox.generateHyroxPlan = (...args) => {
        const plan = JSON.parse(JSON.stringify(originalGenerateHyroxPlan(...args)));
        malformed.mutate(plan);
        return plan;
      };
      const candidateCountBefore = candidates.size;
      const artifactCountBefore = planningArtifacts.size;
      const activeBefore = currentAssignment().id;
      const result = await invoke(preview, {
        ...requestBase,
        body: {
          ...requestClock,
          race_ids: ['hyrox', 'army'],
          target: { trainingDays: ['Tue', 'Thu', 'Sat', 'Sun'], runDaysPerWeek: 4, liftingEnabled: false },
        },
      });
      malformedFeasibilityResults.push({
        label: malformed.label,
        statusCode: result.statusCode,
        code: result.payload?.code,
        candidateWrites: candidates.size - candidateCountBefore,
        artifactWrites: planningArtifacts.size - artifactCountBefore,
        activePlanChanged: currentAssignment().id !== activeBefore,
      });
    }
    hyrox.generateHyroxPlan = originalGenerateHyroxPlan;
    assert.deepEqual(malformedFeasibilityResults, [
      {
        label: 'empty', statusCode: 409, code: 'GOAL_BACKWARD_GENERATION_FAILED',
        candidateWrites: 0, artifactWrites: 0, activePlanChanged: false,
      },
      {
        label: 'ghost', statusCode: 409, code: 'GOAL_BACKWARD_GENERATION_FAILED',
        candidateWrites: 0, artifactWrites: 0, activePlanChanged: false,
      },
    ], 'public on/all rejects malformed feasibility coverage before candidate or artifact persistence');
    const previewResponse = await invoke(preview, {
      ...requestBase,
      body: {
        ...requestClock,
        race_ids: ['hyrox', 'army'],
        target: { trainingDays: ['Tue', 'Thu', 'Sat', 'Sun'], runDaysPerWeek: 4, liftingEnabled: false },
      },
    });
    assert.equal(previewResponse.statusCode, 201, JSON.stringify(previewResponse.payload));
    assert.equal(candidates.get(previewResponse.payload.candidate_id).feature_mode, 'on',
      'the public route persists the selected v2.4 candidate in on/all mode');
    assert.equal(previewResponse.payload.plan.plan_data.overall_feasibility, 'stretch',
      'unvalidated goal performance remains a truthful stretch plan, never a supported claim');
    assert.deepEqual(
      previewResponse.payload.plan.plan_data.goal_feasibilities.map((entry) => entry.feasibility),
      ['unvalidated', 'unvalidated'],
      'the executable plan-level verdict does not erase goal-level assessment requirements',
    );
    const historicalCollapsedDoseM = Math.round(6.7 * 1609.344);
    assert.ok(canonicalPlanRunningMeters(previewResponse.payload.plan.plan_data) > historicalCollapsedDoseM,
      'public on/all never surfaces the historical 6.7-mile collapse for the established HYROX plus road fixture');
    const shadowRow = candidates.get(previewResponse.payload.candidate_id);
    const shadowArtifacts = [...planningArtifacts.values()]
      .filter((artifact) => artifact.decision_id === shadowRow.decision_id);
    assert.deepEqual(shadowArtifacts.map((artifact) => artifact.artifact_kind).sort(), [
      'athlete_state', 'candidate_week', 'canonical_session_set', 'evidence_snapshot',
      'planning_decision', 'surface_manifest', 'validator_result',
    ]);
    const shadowCandidateReceipt = JSON.parse(shadowArtifacts.find((artifact) => (
      artifact.artifact_kind === 'candidate_week'
    )).payload_json);
    assert.equal(shadowCandidateReceipt.authoritative_engine, 'goal-backward-coaching-v2.4');
    assert.ok(shadowCandidateReceipt.candidates.length > 1);
    assert.ok(shadowCandidateReceipt.candidates.some((candidate) => candidate.valid === true));
    assert.ok(shadowCandidateReceipt.candidates.every((candidate) => typeof candidate.valid === 'boolean'));
    const shadowDecisionReceipt = JSON.parse(shadowArtifacts.find((artifact) => (
      artifact.artifact_kind === 'planning_decision'
    )).payload_json);
    assert.ok(shadowDecisionReceipt.candidate_enumeration.expanded_node_count <= MAX_GOAL_BACKWARD_SEARCH_NODES);
    assert.ok(shadowDecisionReceipt.candidate_enumeration.generated_leaf_count <= MAX_GOAL_BACKWARD_SEARCH_FRONTIER);
    const shadowSurfaceReceipt = JSON.parse(shadowArtifacts.find((artifact) => (
      artifact.artifact_kind === 'surface_manifest'
    )).payload_json);
    assert.equal(shadowSurfaceReceipt.feature_mode, 'on');
    assert.equal(shadowSurfaceReceipt.v24_surface_enabled, true);
    assert.equal(previewResponse.payload.effective_from, planningDate);
    assert.deepEqual(previewResponse.payload.plan.plan_data.goals.map((goal) => goal.raceId), ['hyrox', 'army']);
    const retainedHyroxGoal = previewResponse.payload.plan.plan_data.goals[0];
    assert.equal(retainedHyroxGoal.division, 'doubles');
    assert.equal(retainedHyroxGoal.category, 'men');
    assert.equal(retainedHyroxGoal.eventLocalDate, '2026-09-06');
    assert.equal(retainedHyroxGoal.goalType, 'performance');
    assert.equal(retainedHyroxGoal.goalTimeSeconds, 3600);
    assert.equal(JSON.parse(candidates.get(previewResponse.payload.candidate_id).planning_snapshot_json)
      .context.target.hyroxEvent.hyroxPerformanceBudget.target_total_time_s, 3600,
      'an explicit owned-race target overrides older stored performance-budget evidence');
    const retainedArmyGoal = previewResponse.payload.plan.plan_data.goals[1];
    assert.equal(retainedArmyGoal.goalType, 'pr');
    assert.equal(retainedArmyGoal.goalTimeSeconds, 5220);
    assert.equal(retainedArmyGoal.goalPaceSecondsPerMile, 522);
    assert.equal(retainedArmyGoal.goalPaceLabel, '8:42/mi');

    const applyBody = {
      ...requestClock,
      choice: 'train_for_target',
      candidate_hash: previewResponse.payload.candidate_hash,
      ...previewResponse.payload.apply_bindings,
    };
    const applyResponse = await invoke(apply, {
      ...requestBase,
      params: { candidateId: previewResponse.payload.candidate_id },
      body: applyBody,
    });
    assert.equal(applyResponse.statusCode, 200, JSON.stringify(applyResponse.payload));
    assert.equal(applyResponse.payload.effective_from, planningDate);

    const immediate = await invoke(readMyPlan, { ...requestBase, body: {} });
    assert.equal(immediate.statusCode, 200, JSON.stringify(immediate.payload));
    assert.equal(immediate.payload.user_plan.id, applyResponse.payload.user_plan_id);
    assert.equal(immediate.payload.user_plan.effective_from, planningDate);
    assert.deepEqual(immediate.payload.plan.plan_data.goals.map((goal) => goal.raceId), ['hyrox', 'army']);
    assert.equal(immediate.payload.plan.plan_data.goals[0].division, 'doubles');
    assert.equal(immediate.payload.plan.plan_data.goals[0].goalTimeSeconds, 3600);
    assert.equal(
      canonicalPlanRunningMeters(immediate.payload.plan.plan_data),
      canonicalPlanRunningMeters(previewResponse.payload.plan.plan_data),
      'the authoritative applied plan retains the exact reviewed running dose',
    );
    assert.notEqual(immediate.payload.user_plan.id, 'assignment-hyrox', 'the predecessor is not returned on the accepted local date');

    const clone = (value) => JSON.parse(JSON.stringify(value));
    const cloneMap = (map) => new Map([...map.entries()].map(([key, value]) => [key, clone(value)]));
    const restoreMap = (target, snapshot) => {
      target.clear();
      for (const [key, value] of snapshot.entries()) target.set(key, clone(value));
    };
    const removalBaseline = {
      profile: clone(profile),
      races: cloneMap(raceRows),
      plans: cloneMap(trainingPlans),
      assignments: cloneMap(userPlans),
      candidates: cloneMap(candidates),
      artifacts: cloneMap(planningArtifacts),
      rejections: clone(rejectionRows),
    };
    const restoreRemovalBaseline = () => {
      Object.keys(profile).forEach((key) => delete profile[key]);
      Object.assign(profile, clone(removalBaseline.profile));
      restoreMap(raceRows, removalBaseline.races);
      restoreMap(trainingPlans, removalBaseline.plans);
      restoreMap(userPlans, removalBaseline.assignments);
      restoreMap(candidates, removalBaseline.candidates);
      restoreMap(planningArtifacts, removalBaseline.artifacts);
      rejectionRows.splice(0, rejectionRows.length, ...clone(removalBaseline.rejections));
    };
    const mutationState = () => JSON.stringify({
      races: [...raceRows.entries()].sort(([left], [right]) => left.localeCompare(right)),
      plans: [...trainingPlans.entries()].sort(([left], [right]) => left.localeCompare(right)),
      assignments: [...userPlans.entries()].sort(([left], [right]) => left.localeCompare(right)),
      candidates: [...candidates.entries()].sort(([left], [right]) => left.localeCompare(right)),
      artifacts: [...planningArtifacts.entries()].sort(([left], [right]) => left.localeCompare(right)),
    });
    const previewRemoval = async ({ raceId = 'army', clock = requestClock } = {}) => {
      const result = await invoke(previewRaceRemoval, {
        ...requestBase,
        params: { id: raceId },
        body: clock,
      });
      assert.equal(result.statusCode, 201, JSON.stringify(result.payload));
      return result;
    };
    const applyRemoval = (previewResult, {
      raceId = 'army', userId = ownerId, clock = requestClock,
    } = {}) => (
      invoke(applyRaceRemoval, {
        ...requestBase,
        user: { id: userId },
        params: { id: raceId },
        body: {
          ...clock,
          candidate_id: previewResult.payload.candidate_id,
          candidate_hash: previewResult.payload.candidate_hash,
          choice: 'train_for_target',
          ...previewResult.payload.apply_bindings,
        },
      })
    );

    const removalRunHistory = recentRuns.map((run) => ({
      distance_miles: run.distance_miles,
      duration_seconds: run.duration_seconds,
    }));
    const removalPriorFixedNowIso = fixedNowIso;
    try {
      recentRuns.forEach((run) => {
        run.distance_miles = 1;
        run.duration_seconds = 600;
      });
      fixedNowIso = '2026-08-19T16:00:00.000Z';
      const remainingArmyPreview = await previewRemoval({
        raceId: 'hyrox',
        clock: productionShapeClock,
      });
      assert.deepEqual(remainingArmyPreview.payload.plan.plan_data.goals.map((goal) => goal.raceId), ['army']);
      const remainingArmyApply = await applyRemoval(remainingArmyPreview, {
        raceId: 'hyrox',
        clock: productionShapeClock,
      });
      assert.equal(remainingArmyApply.statusCode, 200, JSON.stringify(remainingArmyApply.payload));
      assert.equal(raceRows.has('hyrox'), false,
        'the production-shaped removal transaction deletes HYROX after the Army rebuild validates');
      assert.equal(raceRows.has('army'), true, 'the remaining Army race is preserved');
      assert.deepEqual(
        JSON.parse(trainingPlans.get(currentAssignment().plan_id).plan_json)
          .goals.map((goal) => goal.raceId),
        ['army'],
      );
    } finally {
      fixedNowIso = removalPriorFixedNowIso;
      removalRunHistory.forEach((history, index) => {
        recentRuns[index].distance_miles = history.distance_miles;
        recentRuns[index].duration_seconds = history.duration_seconds;
      });
      restoreRemovalBaseline();
    }

    let removalPreview = await previewRemoval();
    currentAssignment().plan_version += 1;
    let beforeRejectedApply = mutationState();
    let rejectedRemoval = await applyRemoval(removalPreview);
    assert.equal(rejectedRemoval.statusCode, 409, JSON.stringify(rejectedRemoval.payload));
    assert.equal(rejectedRemoval.payload.code, 'ACTIVE_PLAN_REVISION_CHANGED');
    assert.equal(mutationState(), beforeRejectedApply,
      'an active-plan revision rejection writes no candidate, artifact, assignment, plan, or race state');
    currentAssignment().plan_version -= 1;

    removalPreview = await previewRemoval();
    raceRows.get('hyrox').goal_revision += 1;
    beforeRejectedApply = mutationState();
    rejectedRemoval = await applyRemoval(removalPreview);
    assert.equal(rejectedRemoval.statusCode, 409, JSON.stringify(rejectedRemoval.payload));
    assert.equal(rejectedRemoval.payload.code, 'RACE_REVISION_CHANGED');
    assert.equal(mutationState(), beforeRejectedApply,
      'a race-revision rejection writes no candidate, artifact, assignment, plan, or race state');
    raceRows.get('hyrox').goal_revision -= 1;

    removalPreview = await previewRemoval();
    beforeRejectedApply = mutationState();
    rejectedRemoval = await applyRemoval(removalPreview, { raceId: 'hyrox' });
    assert.equal(rejectedRemoval.statusCode, 409, JSON.stringify(rejectedRemoval.payload));
    assert.equal(rejectedRemoval.payload.code, 'CANDIDATE_RACE_MISMATCH');
    assert.equal(mutationState(), beforeRejectedApply,
      'a candidate transplanted to another race writes no candidate, artifact, assignment, plan, or race state');

    const foreignOwner = '22222222-2222-4222-8222-222222222222';
    beforeRejectedApply = mutationState();
    rejectedRemoval = await applyRemoval(removalPreview, { userId: foreignOwner });
    assert.equal(rejectedRemoval.statusCode, 404, JSON.stringify(rejectedRemoval.payload));
    assert.equal(rejectedRemoval.payload.code, 'CANDIDATE_NOT_FOUND');
    assert.equal(mutationState(), beforeRejectedApply,
      'a candidate transplanted to another owner writes no candidate, artifact, assignment, plan, or race state');

    removalPreview = await previewRemoval();
    const artifactCountBeforeRemoval = planningArtifacts.size;
    const removalApply = await applyRemoval(removalPreview);
    assert.equal(removalApply.statusCode, 200, JSON.stringify(removalApply.payload));
    assert.equal(candidates.get(removalPreview.payload.candidate_id).status, 'applied');
    assert.equal(raceRows.has('army'), false, 'the exact owned race is removed in the successful transaction');
    assert.equal(currentAssignment().id, removalApply.payload.user_plan_id,
      'the replacement assignment is authoritative immediately');
    assert.equal(planningArtifacts.size, artifactCountBeforeRemoval,
      'apply reuses the preview artifacts without rewriting them');
    const afterFirstRemovalApply = mutationState();
    const removalReplay = await applyRemoval(removalPreview);
    assert.equal(removalReplay.statusCode, 200, JSON.stringify(removalReplay.payload));
    assert.equal(removalReplay.payload.replay, true);
    assert.equal(mutationState(), afterFirstRemovalApply,
      'double apply replays the receipt without a second candidate, artifact, assignment, plan, or race write');

    restoreRemovalBaseline();

    const combinedPlan = immediate.payload.plan.plan_data;
    assert.equal(combinedPlan.inputSummary.currentWeekRunLoad.runCount, 1);
    assert.deepEqual(combinedPlan.inputSummary.currentWeekRunLoad.runDates, [planningDate]);
    assert.equal(
      combinedPlan.weeks[0].days
        .flatMap((day) => day.sessions.map((session) => ({ date: day.date, session })))
        .filter(({ date, session }) => date === planningDate && (session.kind === 'run' || session.includesRun)).length,
      0,
      'the completed current-week run is represented once as history and never duplicated in the replacement',
    );
    assert.deepEqual(
      JSON.parse(userPlans.get('assignment-hyrox').progress_json).completedSessionIds,
      ['completed-today'],
      'predecessor completion history remains intact',
    );

    const assignmentCount = userPlans.size;
    const replay = await invoke(apply, {
      ...requestBase,
      params: { candidateId: previewResponse.payload.candidate_id },
      body: applyBody,
    });
    assert.equal(replay.statusCode, 200);
    assert.equal(replay.payload.replay, true, JSON.stringify(replay.payload));
    assert.equal(replay.payload.user_plan_id, applyResponse.payload.user_plan_id);
    assert.equal(replay.payload.effective_from, planningDate);
    assert.equal(userPlans.size, assignmentCount, 'candidate replay cannot create a duplicate assignment');

    raceRows.set('hyrox', {
      ...raceRows.get('hyrox'),
      goal_time_seconds: null,
      event_config_json: JSON.stringify({
        equipment: HYROX_EQUIPMENT,
        hyroxPerformanceBudget: { target_total_time_s: 3660, source: 'stored-event-evidence' },
      }),
    });
    const nullTargetPreview = await invoke(preview, {
      ...requestBase,
      body: {
        ...requestClock,
        race_ids: ['hyrox', 'army'],
        target: { trainingDays: ['Tue', 'Thu', 'Sat', 'Sun'], runDaysPerWeek: 4, liftingEnabled: false },
      },
    });
    assert.equal(nullTargetPreview.statusCode, 201, JSON.stringify(nullTargetPreview.payload));
    assert.equal(nullTargetPreview.payload.plan.plan_data.goals[0].goalType, 'completion');
    assert.equal(nullTargetPreview.payload.plan.plan_data.goals[0].goalTimeSeconds, null,
      'stored budget evidence is not promoted into an explicit athlete race target');
    assert.equal(JSON.parse(candidates.get(nullTargetPreview.payload.candidate_id).planning_snapshot_json)
      .context.target.hyroxEvent.hyroxPerformanceBudget.target_total_time_s, 3660,
      'a null race target does not discard existing stored performance-budget evidence');
    raceRows.set('hyrox', {
      ...raceRows.get('hyrox'),
      goal_time_seconds: 3600,
    });

    const rejectedPreview = await invoke(preview, {
      ...requestBase,
      body: {
        ...requestClock,
        race_ids: ['hyrox', 'army'],
        target: { trainingDays: ['Tue', 'Thu', 'Sat', 'Sun'], runDaysPerWeek: 4, liftingEnabled: false },
      },
    });
    assert.equal(rejectedPreview.statusCode, 201, JSON.stringify(rejectedPreview.payload));
    const activeBeforeReject = currentAssignment().id;
    const rejectionResponse = await invoke(reject, {
      ...requestBase,
      params: { candidateId: rejectedPreview.payload.candidate_id },
      body: {
        candidate_hash: rejectedPreview.payload.candidate_hash,
        reason_code: 'ADAPTATION_REJECTED',
        ...rejectedPreview.payload.apply_bindings,
      },
    });
    assert.equal(rejectionResponse.statusCode, 200, JSON.stringify(rejectionResponse.payload));
    assert.equal(rejectionResponse.payload.active_plan_unchanged, true);
    assert.equal(currentAssignment().id, activeBeforeReject, 'rejection performs zero plan writes');
    assert.equal(rejectionRows.length, 1);

    const suppressedPreview = await invoke(preview, {
      ...requestBase,
      body: {
        ...requestClock,
        race_ids: ['hyrox', 'army'],
        target: { trainingDays: ['Tue', 'Thu', 'Sat', 'Sun'], runDaysPerWeek: 4, liftingEnabled: false },
      },
    });
    assert.equal(suppressedPreview.statusCode, 409, JSON.stringify(suppressedPreview.payload));
    assert.equal(suppressedPreview.payload.code, 'IDENTICAL_REJECTED_CANDIDATE_SUPPRESSED');
    assert.equal(currentAssignment().id, activeBeforeReject, 'suppression performs zero plan writes');

    raceRows.set('yonkers', {
      id: 'yonkers', user_id: ownerId, race_name: 'Yonkers Half Marathon',
      race_date: '2026-09-20', event_local_date: '2026-09-20',
      event_timezone: 'America/New_York', event_kind: 'run_race',
      event_revision: 2, goal_revision: 3, distance_miles: 13.109,
      goal_time_seconds: 7200,
    });
    for (let index = 0; index < 24; index += 1) {
      const day = new RealDate(`2026-06-22T12:00:00.000Z`);
      day.setUTCDate(day.getUTCDate() + (index * 2));
      recentRuns.push({
        id: `established-${index + 1}`,
        date: day.toISOString().slice(0, 10),
        distance_miles: [4, 5, 4, 6, 3][index % 5],
        duration_seconds: [2200, 2700, 2200, 3300, 1650][index % 5],
        type: index % 5 === 3 ? 'long' : 'easy',
        created_at: day.toISOString(),
      });
    }
    fixedNowIso = '2026-08-17T16:00:00.000Z';
    const roadClock = { planning_date_local: '2026-08-17', timezone_offset_minutes: 240 };
    const roadRequestBase = {
      ...requestBase,
      query: { date: roadClock.planning_date_local },
      headers: {
        'x-forged-local-date': roadClock.planning_date_local,
        'x-forged-timezone-offset-minutes': '240',
      },
    };
    let roadInspection = null;
    let roadInspectionError = null;
    try {
      await plansRouter._test.previewPlanForUser(ownerId, {
        ...roadClock,
        race_ids: ['yonkers', 'army'],
        target: {
          trainingDays: ['Mon', 'Tue', 'Thu', 'Sat', 'Sun'],
          runDaysPerWeek: 4,
          liftingEnabled: false,
        },
      }, {
        store: false,
        goalBackwardDependencies: {
          mode: 'on',
          cohortRefs: [goalBackwardTargetRef(ownerId)],
          alertEntries: [],
          inspectDecision: (result) => { roadInspection = result; },
        },
      });
    } catch (error) {
      roadInspectionError = error;
    }
    assert.equal(roadInspectionError, null, JSON.stringify({
      error: roadInspectionError && { code: roadInspectionError.code, message: roadInspectionError.message },
      phase: roadInspection?.decision?.phase,
      search: roadInspection?.search_diagnostics,
      roles: roadInspection?.decision?.role_multiset,
      material: roadInspection?.candidates?.[0]?.candidate_material?.map((entry) => ({
        id: entry.material_id,
        family: entry.workout_family,
        date: entry.legacy_scheduled_local_date,
        duration: entry.duration_min,
        meters: entry.distance_m,
        miles: entry.distance_miles,
      })),
      failedValidators: roadInspection?.candidates?.[0]?.validation?.validator_results
        ?.filter((entry) => entry.valid === false)
        .map((entry) => ({ validator: entry.validator, violations: entry.violations })),
      sessions: roadInspection?.candidates?.[0]?.sessions,
      violations: roadInspection?.candidates?.map((candidate) => candidate.validation.violations),
    }));
    assert.ok(roadInspection?.selected_candidate);
    const roadSelected = roadInspection.selected_candidate;
    const roadSelectedRunningDoseM = roadSelected.sessions.reduce((sum, session) => (
      sum + (['recovery_run', 'easy_run', 'long_aerobic', 'steady_run', 'threshold_run',
        'interval_run', 'race_rhythm_run', 'assessment', 'race'].includes(session.workout_family)
        ? Number(session.derived_totals?.distance_m || 0) : 0)
    ), 0);
    assert.equal(roadSelectedRunningDoseM, 23990,
      'the Monday route keeps the exact canonical four-session dose instead of stopping on inflated display miles');
    assert.deepEqual(roadInspection.decision.role_multiset.filter((role) => role.role === 'SUPPORTING')
      .map((role) => role.candidate_material_id), [
      'h3-w1-sun-run', 'h3-w1-tue-run', 'h3-w1-sat-run',
    ], 'each supporting role is bound to the exact server-selected source material');
    assert.deepEqual(roadSelected.skeleton_sessions.map((session) => session.candidate_material_id), [
      'h3-w1-thu-run', 'h3-w1-sun-run', 'h3-w1-tue-run', 'h3-w1-sat-run',
    ], 'enumeration cannot substitute a shorter compatible session after the dose decision');
    const roadAssessment = roadSelected.sessions.find((session) => session.workout_family === 'assessment');
    const assessmentContributor = canonicalRoadContributorFamily('assessment');
    assert.deepEqual(roadAssessment?.contributing_work_families, [assessmentContributor]);
    assert.deepEqual(roadAssessment?.steps.map((step) => step.workout_family), [assessmentContributor]);
    const roadMaterialDose = roadSelected.validation.validator_results.find((entry) => (
      entry.validator === 'material_dose'
    ));
    assert.equal(roadMaterialDose.valid, true);
    assert.equal(roadMaterialDose.receipt.candidate_running_m, 23990);
    const observedLowerBoundComparator = roadMaterialDose.receipt.comparators.find((entry) => (
      entry.source === 'OBSERVED_LOWER_BOUND'
    ));
    assert.equal(observedLowerBoundComparator.baseline_running_m, 25267);
    assert.equal(observedLowerBoundComparator.delta_m, -1277);
    assert.equal(observedLowerBoundComparator.delta_percentage, -5.05);
    assert.equal(observedLowerBoundComparator.material_reduction, false);
    assert.equal(roadSelected.validation.validator_results.find((entry) => (
      entry.validator === 'presentation_floor'
    )).valid, true);
    const roadPreview = await invoke(preview, {
      ...roadRequestBase,
      body: {
        ...roadClock,
        race_ids: ['yonkers', 'army'],
        target: {
          trainingDays: ['Mon', 'Tue', 'Thu', 'Sat', 'Sun'],
          runDaysPerWeek: 4,
          liftingEnabled: false,
        },
      },
    });
    assert.equal(roadPreview.statusCode, 201, JSON.stringify(roadPreview.payload));
    assert.ok(['supported', 'stretch'].includes(roadPreview.payload.plan.plan_data.overall_feasibility));
    assert.ok(roadPreview.payload.plan.plan_data.goal_feasibilities.every((entry) => (
      entry.feasibility === 'unvalidated'
        && entry.legacy_feasibility === 'unsafe'
        && entry.reasons.includes('ASSESSMENT_REQUIRED')
        && entry.legacy_reasons.every((reason) => entry.reasons.includes(reason))
    )), 'v2.4 stretch truth retains the exact bound legacy goal risks without treating them as support');
    const roadApplyBody = {
      ...roadClock,
      choice: 'train_for_target',
      candidate_hash: roadPreview.payload.candidate_hash,
      ...roadPreview.payload.apply_bindings,
    };
    const roadApply = await invoke(apply, {
      ...roadRequestBase,
      params: { candidateId: roadPreview.payload.candidate_id },
      body: roadApplyBody,
    });
    assert.equal(roadApply.statusCode, 200, JSON.stringify(roadApply.payload));
    const roadCurrent = await invoke(readMyPlan, { ...roadRequestBase, body: {} });
    assert.equal(roadCurrent.statusCode, 200, JSON.stringify(roadCurrent.payload));
    assert.deepEqual(roadCurrent.payload.plan.plan_data.goals.map((goal) => goal.raceId), ['yonkers', 'army']);
    assert.equal(roadCurrent.payload.plan.plan_data.goals.some((goal) => goal.raceId === 'hyrox'), false,
      'the authoritative road-only replacement contains no stale HYROX goal');
    const roadReplay = await invoke(apply, {
      ...roadRequestBase,
      params: { candidateId: roadPreview.payload.candidate_id },
      body: roadApplyBody,
    });
    assert.equal(roadReplay.statusCode, 200, JSON.stringify(roadReplay.payload));
    assert.equal(roadReplay.payload.replay, true);

    const roadCurrentSessions = (roadCurrent.payload.plan.plan_data.weeks || []).flatMap((week) => (
      (week.days || []).flatMap((day) => day.sessions || [])
    ));
    const roadCurrentRunningDoseM = roadCurrentSessions.reduce((sum, session) => (
      sum + Number(session.running_distance_m ?? session.distance_m
        ?? session.derived_totals?.distance_m ?? 0)
    ), 0);
    assert.ok(roadCurrentRunningDoseM > 0);
    assert.ok(roadCurrentSessions.some((session) => (
      Array.isArray(session.goal_ids) && session.goal_ids.includes('goal-yonkers')
    )), 'the active canonical calendar contains an explicit Yonkers session binding');

    const noRaceGoalPlan = concurrent.buildConcurrentPlan({
      todayISO: roadClock.planning_date_local,
      profile: {
        weekly_miles_current: 12,
        run_days_per_week: 3,
        lift_days_per_week: 0,
        preferred_workout_days: ['Mon', 'Wed', 'Sat'],
      },
      target: {
        weeks: 4,
        startDate: roadClock.planning_date_local,
        planMode: 'run_only',
        trainingDays: ['Mon', 'Wed', 'Sat'],
        runDaysPerWeek: 3,
        liftingEnabled: false,
      },
      history: {
        weeklyMileageBaseline: 12,
        recentRunCount: 6,
        acuteRunLoad: { available: false, protection: { active: false } },
      },
      recovery: { state: 'normal', available: false },
    });
    assert.equal(noRaceGoalPlan.goal.kind, 'training_block');
    assert.equal(noRaceGoalPlan.goal.raceId, null);
    assert.equal(noRaceGoalPlan.goals, undefined,
      'the deterministic generator emits a singular, intentionally race-less training goal');
    const unrelatedBlockRace = {
      id: 'unrelated-block-race', user_id: ownerId, race_name: 'Unrelated Road Race',
      race_date: '2026-11-15', event_local_date: '2026-11-15',
      event_timezone: 'America/New_York', event_kind: 'run_race',
      event_revision: 1, goal_revision: 1, distance_miles: 10,
      goal_time_seconds: null,
    };
    assert.deepEqual(
      plansRouter._test.raceRemovalImpact(noRaceGoalPlan, unrelatedBlockRace.id),
      { linked: false, remainingRaceIds: [] },
      'the exported removal authority directly classifies a generated race-less goal as unrelated',
    );
    const noRaceGoalAssignment = currentAssignment();
    assert.ok(noRaceGoalAssignment?.id,
      'the route exercise starts with an active assignment rather than a vacuous no-plan state');
    const noRaceGoalPlanRow = trainingPlans.get(noRaceGoalAssignment.plan_id);
    assert.ok(noRaceGoalPlanRow,
      'the active assignment resolves to the persisted plan row replaced by the generated fixture');
    const priorNoRaceGoalPlanData = noRaceGoalPlanRow.plan_data;
    const priorNoRaceGoalPlanJson = noRaceGoalPlanRow.plan_json;
    noRaceGoalPlanRow.plan_data = JSON.stringify(noRaceGoalPlan);
    noRaceGoalPlanRow.plan_json = noRaceGoalPlanRow.plan_data;
    assert.equal(currentAssignment().id, noRaceGoalAssignment.id);
    assert.equal(currentAssignment().plan_id, noRaceGoalPlanRow.id);
    assert.equal(trainingPlans.get(currentAssignment().plan_id).plan_data,
      JSON.stringify(noRaceGoalPlan),
      'the exported preview and DELETE read the installed generated plan through the active assignment');
    raceRows.set(unrelatedBlockRace.id, unrelatedBlockRace);
    const noRacePreviewState = {
      candidates: candidates.size,
      artifacts: planningArtifacts.size,
      plans: trainingPlans.size,
      assignments: userPlans.size,
    };
    const noRaceGoalPreview = await invoke(previewRaceRemoval, {
      ...roadRequestBase,
      params: { id: unrelatedBlockRace.id },
      body: { ...roadClock },
    });
    assert.equal(noRaceGoalPreview.statusCode, 200, JSON.stringify(noRaceGoalPreview.payload));
    assert.deepEqual(noRaceGoalPreview.payload, {
      requires_apply: false,
      impact: 'direct_remove',
      race: { id: unrelatedBlockRace.id, name: unrelatedBlockRace.race_name },
    }, 'a generated training-block goal carries no race linkage');
    assert.deepEqual({
      candidates: candidates.size,
      artifacts: planningArtifacts.size,
      plans: trainingPlans.size,
      assignments: userPlans.size,
    }, noRacePreviewState, 'unrelated removal preview performs zero plan writes');
    const noRaceGoalDelete = await invoke(deleteRace, {
      ...roadRequestBase,
      params: { id: unrelatedBlockRace.id },
      body: {},
    });
    assert.equal(noRaceGoalDelete.statusCode, 200, JSON.stringify(noRaceGoalDelete.payload));
    assert.equal(raceRows.has(unrelatedBlockRace.id), false,
      'the unrelated owned race is deleted without rewriting the training block');

    const absentRaceBindingPlan = JSON.parse(JSON.stringify(noRaceGoalPlan));
    delete absentRaceBindingPlan.goal.raceId;
    noRaceGoalPlanRow.plan_data = JSON.stringify(absentRaceBindingPlan);
    noRaceGoalPlanRow.plan_json = noRaceGoalPlanRow.plan_data;
    raceRows.set(unrelatedBlockRace.id, unrelatedBlockRace);
    const absentRaceBindingPreview = await invoke(previewRaceRemoval, {
      ...roadRequestBase,
      params: { id: unrelatedBlockRace.id },
      body: { ...roadClock },
    });
    assert.equal(absentRaceBindingPreview.statusCode, 200,
      JSON.stringify(absentRaceBindingPreview.payload));
    assert.equal(absentRaceBindingPreview.payload.requires_apply, false);
    const absentRaceBindingDelete = await invoke(deleteRace, {
      ...roadRequestBase,
      params: { id: unrelatedBlockRace.id },
      body: {},
    });
    assert.equal(absentRaceBindingDelete.statusCode, 200,
      JSON.stringify(absentRaceBindingDelete.payload));
    assert.equal(raceRows.has(unrelatedBlockRace.id), false,
      'an absent race binding has the same benign training-goal semantics as explicit null');

    const sessionBoundNoRaceGoalPlan = JSON.parse(JSON.stringify(noRaceGoalPlan));
    const sessionBoundNoRaceGoalSession = sessionBoundNoRaceGoalPlan.weeks
      .flatMap((week) => week.days)
      .flatMap((day) => day.sessions)
      .find(Boolean);
    sessionBoundNoRaceGoalSession.goal_ids = [`goal-${unrelatedBlockRace.id}`];
    noRaceGoalPlanRow.plan_data = JSON.stringify(sessionBoundNoRaceGoalPlan);
    noRaceGoalPlanRow.plan_json = noRaceGoalPlanRow.plan_data;
    raceRows.set(unrelatedBlockRace.id, unrelatedBlockRace);
    const sessionBoundDelete = await invoke(deleteRace, {
      ...roadRequestBase,
      params: { id: unrelatedBlockRace.id },
      body: {},
    });
    assert.equal(sessionBoundDelete.statusCode, 409, JSON.stringify(sessionBoundDelete.payload));
    assert.equal(sessionBoundDelete.payload.code, 'ACTIVE_PLAN_REBUILD_REQUIRED');
    assert.equal(raceRows.has(unrelatedBlockRace.id), true,
      'a canonical session binding remains fail-closed even when the goal itself has no race');
    raceRows.delete(unrelatedBlockRace.id);
    noRaceGoalPlanRow.plan_data = priorNoRaceGoalPlanData;
    noRaceGoalPlanRow.plan_json = priorNoRaceGoalPlanJson;

    const malformedGoalPlanRow = trainingPlans.get(currentAssignment().plan_id);
    const validGoalPlanData = malformedGoalPlanRow.plan_data;
    const validGoalPlanJson = malformedGoalPlanRow.plan_json;
    const malformedGoalShapes = [
      ['null goal entry', [null]],
      ['numeric race id', [{ raceId: 42 }]],
      ['blank race id', [{ raceId: '' }]],
      ['primitive goal entry', ['yonkers']],
      ['array goal entry', [['yonkers']]],
    ];
    for (const [label, goals] of malformedGoalShapes) {
      const malformedGoalPlan = JSON.parse(validGoalPlanData);
      malformedGoalPlan.goals = goals;
      malformedGoalPlanRow.plan_data = JSON.stringify(malformedGoalPlan);
      malformedGoalPlanRow.plan_json = malformedGoalPlanRow.plan_data;
      const before = {
        candidates: candidates.size,
        artifacts: planningArtifacts.size,
        plans: trainingPlans.size,
        assignments: userPlans.size,
        rejections: rejectionRows.length,
        activeAssignment: currentAssignment().id,
        races: raceRows.size,
        raceOwned: raceRows.has('yonkers'),
        planData: malformedGoalPlanRow.plan_data,
      };
      const malformedPreview = await invoke(previewRaceRemoval, {
        ...roadRequestBase,
        params: { id: 'yonkers' },
        body: { ...roadClock },
      });
      assert.equal(malformedPreview.statusCode, 409, label);
      assert.equal(malformedPreview.payload.code, 'GOAL_BACKWARD_GENERATION_FAILED', label);
      const malformedDelete = await invoke(deleteRace, {
        ...roadRequestBase,
        params: { id: 'yonkers' },
        body: {},
      });
      assert.equal(malformedDelete.statusCode, 409, label);
      assert.equal(malformedDelete.payload.code, 'ACTIVE_PLAN_LINKAGE_UNVERIFIED', label);
      assert.deepEqual({
        candidates: candidates.size,
        artifacts: planningArtifacts.size,
        plans: trainingPlans.size,
        assignments: userPlans.size,
        rejections: rejectionRows.length,
        activeAssignment: currentAssignment().id,
        races: raceRows.size,
        raceOwned: raceRows.has('yonkers'),
        planUnchanged: malformedGoalPlanRow.plan_data === before.planData,
        stillBound: JSON.parse(malformedGoalPlanRow.plan_data).weeks
          .flatMap((week) => (week?.days || []))
          .flatMap((day) => (day?.sessions || []))
          .some((session) => Array.isArray(session?.goal_ids)
            && session.goal_ids.includes('goal-yonkers')),
      }, {
        candidates: before.candidates,
        artifacts: before.artifacts,
        plans: before.plans,
        assignments: before.assignments,
        rejections: before.rejections,
        activeAssignment: before.activeAssignment,
        races: before.races,
        raceOwned: true,
        planUnchanged: true,
        stillBound: true,
      }, `${label} cannot delete or orphan the bound race`);
      malformedGoalPlanRow.plan_data = validGoalPlanData;
      malformedGoalPlanRow.plan_json = validGoalPlanJson;
    }

    const findBoundSession = (plan) => (plan.weeks || [])
      .flatMap((week) => week.days || [])
      .flatMap((day) => day.sessions || [])
      .find((session) => Array.isArray(session.goal_ids) && session.goal_ids.length > 0);
    const configureDayOwnBinding = (plan, alias, bindingRaceId, bindingFirst = false) => {
      const armyGoal = plan.goals.find((entry) => entry?.raceId === 'army');
      assert.ok(armyGoal, 'the day-binding fixture retains its Army peer goal');
      const normalizedArmyGoal = JSON.parse(JSON.stringify(armyGoal));
      delete normalizedArmyGoal.race_id;
      plan.goals = [normalizedArmyGoal];
      delete plan.goal;
      for (const session of (plan.weeks || [])
        .flatMap((week) => week.days || [])
        .flatMap((day) => day.sessions || [])) {
        session.goal_ids = ['goal-army'];
        delete session.goalIds;
        delete session.goalRaceId;
        delete session.goal_race_id;
      }
      const week = plan.weeks.find((entry) => Array.isArray(entry?.days)
        && entry.days.some((day) => Array.isArray(day?.sessions) && day.sessions.length > 0));
      const dayIndex = week.days.findIndex((day) => Array.isArray(day?.sessions)
        && day.sessions.length > 0);
      const day = { ...week.days[dayIndex] };
      delete day.goal_ids;
      delete day.goalIds;
      delete day.goalRaceId;
      delete day.goal_race_id;
      const value = alias === 'goal_ids' || alias === 'goalIds'
        ? [`goal-${bindingRaceId}`] : bindingRaceId;
      week.days[dayIndex] = bindingFirst
        ? { [alias]: value, ...day }
        : { ...day, [alias]: value };
      return week.days[dayIndex];
    };
    const dayOwnAliasConflictShapes = ['goal_ids', 'goalIds', 'goalRaceId', 'goal_race_id']
      .flatMap((alias) => [true, false].map((bindingFirst) => ([
        `day-own ${alias} conflict (${bindingFirst ? 'binding-first' : 'sessions-first'})`,
        (plan) => configureDayOwnBinding(plan, alias, 'yonkers', bindingFirst),
      ])));
    const aliasConflictShapes = [
      ['goal raceId/race_id conflict', (plan) => {
        const goal = plan.goals.find((entry) => entry?.raceId === 'yonkers') || plan.goals[0];
        goal.race_id = goal.raceId === 'yonkers' ? 'army' : 'yonkers';
      }],
      ['goals/goal container conflict', (plan) => {
        plan.goal = { kind: 'race', raceId: 'hidden-conflicting-race' };
      }],
      ['session goalRaceId/goal_race_id conflict', (plan) => {
        const session = findBoundSession(plan);
        session.goalRaceId = 'yonkers';
        session.goal_race_id = 'army';
      }],
      ['session goal_ids/goalIds conflict', (plan) => {
        const session = findBoundSession(plan);
        session.goal_ids = ['goal-yonkers'];
        session.goalIds = ['goal-army'];
      }],
      ['week days/sessions container conflict', (plan) => {
        const week = plan.weeks.find((entry) => Array.isArray(entry?.days));
        week.sessions = [{ session_id: 'hidden-week-binding', goal_ids: ['goal-hidden-race'] }];
      }],
      ...dayOwnAliasConflictShapes,
    ];
    for (const [label, mutate] of aliasConflictShapes) {
      const conflictingPlan = JSON.parse(validGoalPlanData);
      mutate(conflictingPlan);
      malformedGoalPlanRow.plan_data = JSON.stringify(conflictingPlan);
      malformedGoalPlanRow.plan_json = malformedGoalPlanRow.plan_data;
      const before = {
        candidates: candidates.size,
        artifacts: planningArtifacts.size,
        plans: trainingPlans.size,
        assignments: userPlans.size,
        rejections: rejectionRows.length,
        activeAssignment: currentAssignment().id,
        races: raceRows.size,
        raceOwned: raceRows.has('yonkers'),
        planData: malformedGoalPlanRow.plan_data,
      };
      const conflictingPreview = await invoke(previewRaceRemoval, {
        ...roadRequestBase,
        params: { id: 'yonkers' },
        body: { ...roadClock },
      });
      assert.equal(conflictingPreview.statusCode, 409, label);
      assert.equal(conflictingPreview.payload.code, 'GOAL_BACKWARD_GENERATION_FAILED', label);
      const conflictingDelete = await invoke(deleteRace, {
        ...roadRequestBase,
        params: { id: 'yonkers' },
        body: {},
      });
      assert.equal(conflictingDelete.statusCode, 409, label);
      assert.equal(conflictingDelete.payload.code, 'ACTIVE_PLAN_LINKAGE_UNVERIFIED', label);
      assert.deepEqual({
        candidates: candidates.size,
        artifacts: planningArtifacts.size,
        plans: trainingPlans.size,
        assignments: userPlans.size,
        rejections: rejectionRows.length,
        activeAssignment: currentAssignment().id,
        races: raceRows.size,
        raceOwned: raceRows.has('yonkers'),
        planUnchanged: malformedGoalPlanRow.plan_data === before.planData,
      }, {
        candidates: before.candidates,
        artifacts: before.artifacts,
        plans: before.plans,
        assignments: before.assignments,
        rejections: before.rejections,
        activeAssignment: before.activeAssignment,
        races: before.races,
        raceOwned: true,
        planUnchanged: true,
      }, `${label} cannot hide the target binding or mutate removal state`);
      malformedGoalPlanRow.plan_data = validGoalPlanData;
      malformedGoalPlanRow.plan_json = validGoalPlanJson;
    }

    const aliasBindingValue = (alias, raceIds, encoding) => (
      alias === 'goal_ids' || alias === 'goalIds'
        ? raceIds.map((id) => ` ${encoding === 'canonical' ? `goal-${id}` : id} `)
        : ` ${encoding === 'canonical' ? `goal-${raceIds[0]}` : raceIds[0]} `
    );
    const configureSemanticDayAgreement = (
      plan, dayAlias, nestedAlias, dayEncoding, nestedEncoding, bindingFirst,
      raceIds = ['yonkers'],
    ) => {
      delete plan.canonical_workout_schema_version;
      delete plan.canonical_session_set_hash;
      delete plan.selected_candidate_hash;
      const week = plan.weeks.find((entry) => Array.isArray(entry?.days)
        && entry.days.some((day) => Array.isArray(day?.sessions) && day.sessions.length > 0));
      const dayIndex = week.days.findIndex((day) => Array.isArray(day?.sessions)
        && day.sessions.length > 0);
      const originalDay = week.days[dayIndex];
      const day = { ...originalDay };
      for (const alias of ['goal_ids', 'goalIds', 'goalRaceId', 'goal_race_id']) {
        delete day[alias];
      }
      const sessions = day.sessions.map((session) => {
        const normalized = { ...session };
        for (const alias of ['goal_ids', 'goalIds', 'goalRaceId', 'goal_race_id']) {
          delete normalized[alias];
        }
        return normalized;
      });
      const nestedSession = {
        ...sessions[0],
        [nestedAlias]: aliasBindingValue(nestedAlias, raceIds, nestedEncoding),
      };
      sessions[0] = bindingFirst
        ? {
          [nestedAlias]: aliasBindingValue(nestedAlias, raceIds, nestedEncoding),
          ...sessions[0],
        }
        : nestedSession;
      day.sessions = sessions;
      week.days[dayIndex] = bindingFirst
        ? { [dayAlias]: aliasBindingValue(dayAlias, raceIds, dayEncoding), ...day }
        : { ...day, [dayAlias]: aliasBindingValue(dayAlias, raceIds, dayEncoding) };
      return week.days[dayIndex];
    };
    const prefixedRaceCases = [
      ['goal-setter', 'raw'],
      ['goal-x', 'canonical'],
    ];
    for (const [prefixedRaceId, encoding] of prefixedRaceCases) {
      const prefixedRace = {
        ...raceRows.get('army'),
        id: prefixedRaceId,
        race_name: `Prefixed ${prefixedRaceId}`,
        race_date: '2026-12-06',
        event_local_date: '2026-12-06',
      };
      raceRows.set(prefixedRaceId, prefixedRace);
      const prefixedRacePlan = JSON.parse(validGoalPlanData);
      configureSemanticDayAgreement(
        prefixedRacePlan, 'goal_ids', 'goalIds', encoding, encoding, true, [prefixedRaceId],
      );
      malformedGoalPlanRow.plan_data = JSON.stringify(prefixedRacePlan);
      malformedGoalPlanRow.plan_json = malformedGoalPlanRow.plan_data;
      const prefixedBefore = {
        assignmentId: currentAssignment().id,
        assignmentPlanId: currentAssignment().plan_id,
        races: raceRows.size,
        owned: raceRows.has(prefixedRaceId),
      };
      const prefixedPreview = await invoke(previewRaceRemoval, {
        ...roadRequestBase,
        params: { id: prefixedRaceId },
        body: { ...roadClock },
      });
      assert.equal(prefixedPreview.statusCode, 201,
        `${prefixedRaceId}: ${JSON.stringify(prefixedPreview.payload)}`);
      assert.equal(prefixedPreview.payload.requires_apply, true, prefixedRaceId);
      const prefixedDelete = await invoke(deleteRace, {
        ...roadRequestBase,
        params: { id: prefixedRaceId },
        body: {},
      });
      assert.equal(prefixedDelete.statusCode, 409,
        `${prefixedRaceId}: ${JSON.stringify(prefixedDelete.payload)}`);
      assert.equal(prefixedDelete.payload.code, 'ACTIVE_PLAN_REBUILD_REQUIRED', prefixedRaceId);
      assert.deepEqual({
        assignmentId: currentAssignment().id,
        assignmentPlanId: currentAssignment().plan_id,
        races: raceRows.size,
        owned: raceRows.has(prefixedRaceId),
      }, prefixedBefore, `${prefixedRaceId} cannot be direct-deleted through prefix collapse`);
      raceRows.delete(prefixedRaceId);
    }

    const ambiguousRaceIds = ['setter', 'goal-setter'];
    for (const [index, ambiguousRaceId] of ambiguousRaceIds.entries()) {
      raceRows.set(ambiguousRaceId, {
        ...raceRows.get(index === 0 ? 'yonkers' : 'army'),
        id: ambiguousRaceId,
        race_name: `Ambiguous ${ambiguousRaceId}`,
      });
    }
    const ambiguousBindingPlan = JSON.parse(validGoalPlanData);
    configureSemanticDayAgreement(
      ambiguousBindingPlan, 'goal_ids', 'goalIds', 'raw', 'raw', true, ['goal-setter'],
    );
    ambiguousBindingPlan.goals = ambiguousBindingPlan.goals.map((goal, index) => ({
      ...goal,
      raceId: ambiguousRaceIds[index],
    }));
    delete ambiguousBindingPlan.goal;
    malformedGoalPlanRow.plan_data = JSON.stringify(ambiguousBindingPlan);
    malformedGoalPlanRow.plan_json = malformedGoalPlanRow.plan_data;
    const ambiguousBefore = {
      candidates: candidates.size,
      artifacts: planningArtifacts.size,
      plans: trainingPlans.size,
      assignments: userPlans.size,
      rejections: rejectionRows.length,
      activeAssignment: currentAssignment().id,
      races: raceRows.size,
      setterOwned: raceRows.has('setter'),
      goalSetterOwned: raceRows.has('goal-setter'),
    };
    const ambiguousPreview = await invoke(previewRaceRemoval, {
      ...roadRequestBase,
      params: { id: 'goal-setter' },
      body: { ...roadClock },
    });
    assert.equal(ambiguousPreview.statusCode, 409, JSON.stringify(ambiguousPreview.payload));
    assert.equal(ambiguousPreview.payload.code, 'GOAL_BACKWARD_GENERATION_FAILED');
    const ambiguousDelete = await invoke(deleteRace, {
      ...roadRequestBase,
      params: { id: 'goal-setter' },
      body: {},
    });
    assert.equal(ambiguousDelete.statusCode, 409, JSON.stringify(ambiguousDelete.payload));
    assert.equal(ambiguousDelete.payload.code, 'ACTIVE_PLAN_LINKAGE_UNVERIFIED');
    assert.deepEqual({
      candidates: candidates.size,
      artifacts: planningArtifacts.size,
      plans: trainingPlans.size,
      assignments: userPlans.size,
      rejections: rejectionRows.length,
      activeAssignment: currentAssignment().id,
      races: raceRows.size,
      setterOwned: raceRows.has('setter'),
      goalSetterOwned: raceRows.has('goal-setter'),
    }, ambiguousBefore, 'an identity matching two distinct known races fails closed with zero writes');
    raceRows.delete('setter');
    raceRows.delete('goal-setter');

    const dayBindingAliases = ['goalRaceId', 'goal_race_id', 'goal_ids', 'goalIds'];
    const nestedBindingAliases = ['goal_ids', 'goalIds', 'goalRaceId', 'goal_race_id'];
    for (const dayAlias of dayBindingAliases) {
      for (const nestedAlias of nestedBindingAliases) {
        for (const dayEncoding of ['canonical', 'raw']) {
          for (const nestedEncoding of ['canonical', 'raw']) {
            for (const bindingFirst of [true, false]) {
              const label = `${dayAlias}:${dayEncoding}/${nestedAlias}:${nestedEncoding} `
                + `semantic agreement (${bindingFirst ? 'binding-first' : 'sessions-first'})`;
              const semanticallyAgreeingPlan = JSON.parse(validGoalPlanData);
              configureSemanticDayAgreement(
                semanticallyAgreeingPlan, dayAlias, nestedAlias,
                dayEncoding, nestedEncoding, bindingFirst,
              );
              malformedGoalPlanRow.plan_data = JSON.stringify(semanticallyAgreeingPlan);
              malformedGoalPlanRow.plan_json = malformedGoalPlanRow.plan_data;
              const before = {
                assignmentId: currentAssignment().id,
                assignmentPlanId: currentAssignment().plan_id,
                races: raceRows.size,
                yonkersOwned: raceRows.has('yonkers'),
              };
              const agreeingPreview = await invoke(previewRaceRemoval, {
                ...roadRequestBase,
                params: { id: 'yonkers' },
                body: { ...roadClock },
              });
              assert.equal(agreeingPreview.statusCode, 201,
                `${label}: ${JSON.stringify(agreeingPreview.payload)}`);
              assert.equal(agreeingPreview.payload.requires_apply, true, label);
              const agreeingDelete = await invoke(deleteRace, {
                ...roadRequestBase,
                params: { id: 'yonkers' },
                body: {},
              });
              assert.equal(agreeingDelete.statusCode, 409,
                `${label}: ${JSON.stringify(agreeingDelete.payload)}`);
              assert.equal(agreeingDelete.payload.code, 'ACTIVE_PLAN_REBUILD_REQUIRED', label);
              assert.deepEqual({
                assignmentId: currentAssignment().id,
                assignmentPlanId: currentAssignment().plan_id,
                races: raceRows.size,
                yonkersOwned: raceRows.has('yonkers'),
                activePlanUnchanged: malformedGoalPlanRow.plan_data
                  === JSON.stringify(semanticallyAgreeingPlan),
              }, {
                ...before,
                activePlanUnchanged: true,
              }, `${label} preserves the active assignment and target race until apply`);
            }
          }
        }
      }
    }

    for (const bindingFirst of [true, false]) {
      const multiPeerAgreementPlan = JSON.parse(validGoalPlanData);
      configureSemanticDayAgreement(
        multiPeerAgreementPlan, 'goal_ids', 'goalIds', 'canonical', 'raw',
        bindingFirst, ['yonkers', 'army'],
      );
      assert.deepEqual(
        plansRouter._test.raceRemovalImpact(multiPeerAgreementPlan, 'yonkers'),
        { linked: true, remainingRaceIds: ['army'] },
        `multiple semantic peers agree with ${bindingFirst ? 'binding-first' : 'sessions-first'} order`,
      );
      malformedGoalPlanRow.plan_data = JSON.stringify(multiPeerAgreementPlan);
      malformedGoalPlanRow.plan_json = malformedGoalPlanRow.plan_data;
      const multiPeerPreview = await invoke(previewRaceRemoval, {
        ...roadRequestBase,
        params: { id: 'yonkers' },
        body: { ...roadClock },
      });
      assert.equal(multiPeerPreview.statusCode, 201, JSON.stringify(multiPeerPreview.payload));
      const multiPeerDelete = await invoke(deleteRace, {
        ...roadRequestBase,
        params: { id: 'yonkers' },
        body: {},
      });
      assert.equal(multiPeerDelete.statusCode, 409, JSON.stringify(multiPeerDelete.payload));
      assert.equal(multiPeerDelete.payload.code, 'ACTIVE_PLAN_REBUILD_REQUIRED');
      assert.equal(raceRows.has('yonkers'), true);
    }
    malformedGoalPlanRow.plan_data = validGoalPlanData;
    malformedGoalPlanRow.plan_json = validGoalPlanJson;

    const agreeingAliasPlan = JSON.parse(validGoalPlanData);
    const agreeingGoal = agreeingAliasPlan.goals.find((entry) => entry?.raceId === 'yonkers')
      || agreeingAliasPlan.goals[0];
    agreeingGoal.race_id = agreeingGoal.raceId;
    agreeingAliasPlan.goal = JSON.parse(JSON.stringify(agreeingGoal));
    const agreeingSession = findBoundSession(agreeingAliasPlan);
    agreeingSession.goalRaceId = 'yonkers';
    agreeingSession.goal_race_id = 'yonkers';
    agreeingSession.goalIds = [...agreeingSession.goal_ids];
    const agreeingWeek = agreeingAliasPlan.weeks.find((entry) => Array.isArray(entry?.days));
    agreeingWeek.sessions = agreeingWeek.days.flatMap((day) => day.sessions || [])
      .map((session) => JSON.parse(JSON.stringify(session)));
    assert.deepEqual(
      plansRouter._test.raceRemovalImpact(agreeingAliasPlan, 'yonkers'),
      { linked: true, remainingRaceIds: ['army'] },
      'simultaneously supplied aliases and containers remain valid when their bindings agree',
    );
    malformedGoalPlanRow.plan_data = JSON.stringify(agreeingAliasPlan);
    malformedGoalPlanRow.plan_json = malformedGoalPlanRow.plan_data;
    const agreeingAliasDelete = await invoke(deleteRace, {
      ...roadRequestBase,
      params: { id: 'yonkers' },
      body: {},
    });
    assert.equal(agreeingAliasDelete.statusCode, 409, JSON.stringify(agreeingAliasDelete.payload));
    assert.equal(agreeingAliasDelete.payload.code, 'ACTIVE_PLAN_REBUILD_REQUIRED');
    assert.equal(raceRows.has('yonkers'), true);

    const agreeingDayOwnPlan = JSON.parse(validGoalPlanData);
    configureDayOwnBinding(agreeingDayOwnPlan, 'goal_ids', 'army', true);
    assert.deepEqual(
      plansRouter._test.raceRemovalImpact(agreeingDayOwnPlan, 'army'),
      { linked: true, remainingRaceIds: [] },
      'matching day-own and nested-session bindings remain linked regardless of key order',
    );
    malformedGoalPlanRow.plan_data = JSON.stringify(agreeingDayOwnPlan);
    malformedGoalPlanRow.plan_json = malformedGoalPlanRow.plan_data;
    const agreeingDayOwnDelete = await invoke(deleteRace, {
      ...roadRequestBase,
      params: { id: 'army' },
      body: {},
    });
    assert.equal(agreeingDayOwnDelete.statusCode, 409,
      JSON.stringify(agreeingDayOwnDelete.payload));
    assert.equal(agreeingDayOwnDelete.payload.code, 'ACTIVE_PLAN_REBUILD_REQUIRED');
    assert.equal(raceRows.has('army'), true);

    const singleDayOwnPlan = JSON.parse(validGoalPlanData);
    const singleDay = configureDayOwnBinding(singleDayOwnPlan, 'goalRaceId', 'yonkers', false);
    delete singleDay.sessions;
    assert.deepEqual(
      plansRouter._test.raceRemovalImpact(singleDayOwnPlan, 'yonkers'),
      { linked: true, remainingRaceIds: ['army'] },
      'a day-own binding without a nested sessions container retains its existing authority',
    );
    malformedGoalPlanRow.plan_data = JSON.stringify(singleDayOwnPlan);
    malformedGoalPlanRow.plan_json = malformedGoalPlanRow.plan_data;
    const singleDayOwnDelete = await invoke(deleteRace, {
      ...roadRequestBase,
      params: { id: 'yonkers' },
      body: {},
    });
    assert.equal(singleDayOwnDelete.statusCode, 409,
      JSON.stringify(singleDayOwnDelete.payload));
    assert.equal(singleDayOwnDelete.payload.code, 'ACTIVE_PLAN_REBUILD_REQUIRED');
    assert.equal(raceRows.has('yonkers'), true);

    const ordinarySingleAliasPlan = JSON.parse(validGoalPlanData);
    assert.deepEqual(
      plansRouter._test.raceRemovalImpact(ordinarySingleAliasPlan, 'yonkers'),
      { linked: true, remainingRaceIds: ['army'] },
      'ordinary single-alias canonical plans retain their existing linked classification',
    );
    malformedGoalPlanRow.plan_data = validGoalPlanData;
    malformedGoalPlanRow.plan_json = validGoalPlanJson;

    const legacyRemovalBaseline = {
      profile: clone(profile),
      races: cloneMap(raceRows),
      plans: cloneMap(trainingPlans),
      assignments: cloneMap(userPlans),
      candidates: cloneMap(candidates),
      artifacts: cloneMap(planningArtifacts),
      rejections: clone(rejectionRows),
    };
    try {
      const legacyRoadPlanRow = trainingPlans.get(currentAssignment().plan_id);
      const legacyRoadPlan = JSON.parse(legacyRoadPlanRow.plan_data);
      delete legacyRoadPlan.canonical_workout_schema_version;
      delete legacyRoadPlan.canonical_session_set_hash;
      delete legacyRoadPlan.selected_candidate_hash;
      const legacyRunningSessions = (legacyRoadPlan.weeks || []).flatMap((week) => (
        (week.days || []).flatMap((day) => (day.sessions || []).filter((session) => (
          ['recovery_run', 'easy_run', 'long_aerobic', 'steady_run', 'threshold_run',
            'interval_run', 'race_rhythm_run', 'assessment', 'race'].includes(session.workout_family)
        )))
      ));
      assert.ok(legacyRunningSessions.length > 1);
      const legacyTargetRunningM = 22852.685;
      let allocatedLegacyM = 0;
      legacyRunningSessions.forEach((session, index) => {
        const originalM = Number(session.running_distance_m ?? session.distance_m
          ?? session.derived_totals?.distance_m ?? 0);
        const scaledM = index === legacyRunningSessions.length - 1
          ? legacyTargetRunningM - allocatedLegacyM
          : Math.round(((originalM / roadCurrentRunningDoseM) * legacyTargetRunningM) * 1000) / 1000;
        allocatedLegacyM += scaledM;
        session.distance_miles = scaledM / 1609.344;
        delete session.running_distance_m;
        delete session.distance_m;
        delete session.distanceMeters;
        if (session.derived_totals) {
          delete session.derived_totals.distance_m;
          delete session.derived_totals.work_distance_m;
        }
      });
      legacyRoadPlanRow.plan_data = JSON.stringify(legacyRoadPlan);
      legacyRoadPlanRow.plan_json = legacyRoadPlanRow.plan_data;

      let legacyInspection = null;
      const legacyReadOnly = await plansRouter._test.previewPlanForUser(ownerId, {
        ...roadClock,
        operation: 'remove_race',
        remove_race_id: 'yonkers',
        race_ids: ['army'],
      }, {
        store: false,
        goalBackwardDependencies: {
          mode: 'on',
          cohortRefs: [goalBackwardTargetRef(ownerId)],
          alertEntries: [],
          inspectDecision: (result) => { legacyInspection = result; },
        },
      });
      assert.ok(legacyReadOnly.plan);
      assert.equal(legacyInspection.required_running_dose_receipt.raw_required_running_m,
        legacyTargetRunningM);
      assert.equal(legacyInspection.required_running_dose_receipt.required_running_m, 22853);
      assert.deepEqual(legacyInspection.required_running_dose_receipt.reason_codes,
        ['REQUIRED_RUNNING_DOSE_CEILED']);

      const malformedDistanceHooks = { coercion: 0, getter: 0, proxy: 0 };
      const hostileProxy = (value) => new Proxy(value, {
        get(target, key, receiver) {
          malformedDistanceHooks.proxy += 1;
          return Reflect.get(target, key, receiver);
        },
        getOwnPropertyDescriptor(target, key) {
          malformedDistanceHooks.proxy += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
        getPrototypeOf(target) {
          malformedDistanceHooks.proxy += 1;
          return Reflect.getPrototypeOf(target);
        },
        ownKeys(target) {
          malformedDistanceHooks.proxy += 1;
          return Reflect.ownKeys(target);
        },
      });
      const hostileAccessor = (target, field, value) => {
        delete target[field];
        Object.defineProperty(target, field, {
          enumerable: true,
          get() { malformedDistanceHooks.getter += 1; return value; },
        });
        return target;
      };
      class HostileRemovalContainer {}
      class HostileRemovalList extends Array {}
      const hostileAccessorList = (values) => {
        const list = [...values];
        const first = list[0];
        Object.defineProperty(list, '0', {
          configurable: true, enumerable: true,
          get() { malformedDistanceHooks.getter += 1; return first; },
        });
        return list;
      };
      const hostileInheritedList = (values) => {
        const list = [...values];
        Object.setPrototypeOf(list, Object.create(Array.prototype));
        return list;
      };
      const hostileClassList = (values) => {
        const list = new HostileRemovalList();
        list.push(...values);
        return list;
      };
      const legacyRun = (plan) => (plan.weeks || []).flatMap((week) => (
        (week.days || []).flatMap((day) => day.sessions || [])
      )).find((session) => typeof session.distance_miles === 'number');
      const assertInvalidLegacyRemoval = async (label, malformedLegacyPlan) => {
        legacyRoadPlanRow.plan_data = malformedLegacyPlan;
        legacyRoadPlanRow.plan_json = malformedLegacyPlan;
        const stateBeforeMalformedLegacyRemoval = {
          candidates: candidates.size,
          artifacts: planningArtifacts.size,
          plans: trainingPlans.size,
          assignments: userPlans.size,
          activeAssignment: currentAssignment().id,
          activePlanRow: trainingPlans.get(currentAssignment().plan_id),
          activePlanData: trainingPlans.get(currentAssignment().plan_id).plan_data,
          yonkersOwned: raceRows.has('yonkers'),
        };
        let malformedLegacyError = null;
        try {
          await plansRouter._test.previewRaceRemovalForUser(ownerId, 'yonkers', { ...roadClock });
        } catch (error) {
          malformedLegacyError = error;
        }
        assert.equal(malformedLegacyError?.code, 'GOAL_BACKWARD_GENERATION_FAILED', label);
        assert.equal(malformedLegacyError?.details?.reason_code, 'REQUIRED_RUNNING_DOSE_INVALID', label);
        assert.deepEqual({
          candidates: candidates.size,
          artifacts: planningArtifacts.size,
          plans: trainingPlans.size,
          assignments: userPlans.size,
          activeAssignment: currentAssignment().id,
          activePlanRowUnchanged:
            trainingPlans.get(currentAssignment().plan_id) === stateBeforeMalformedLegacyRemoval.activePlanRow,
          activePlanDataUnchanged:
            trainingPlans.get(currentAssignment().plan_id).plan_data
              === stateBeforeMalformedLegacyRemoval.activePlanData,
          yonkersOwned: raceRows.has('yonkers'),
        }, {
          candidates: stateBeforeMalformedLegacyRemoval.candidates,
          artifacts: stateBeforeMalformedLegacyRemoval.artifacts,
          plans: stateBeforeMalformedLegacyRemoval.plans,
          assignments: stateBeforeMalformedLegacyRemoval.assignments,
          activeAssignment: stateBeforeMalformedLegacyRemoval.activeAssignment,
          activePlanRowUnchanged: true,
          activePlanDataUnchanged: true,
          yonkersOwned: stateBeforeMalformedLegacyRemoval.yonkersOwned,
        }, `${label} writes no candidate, artifact, plan, assignment, or race state`);
      };

      raceRows.set('unrelated', {
        id: 'unrelated', user_id: ownerId, race_name: 'Unrelated road race',
        race_date: '2026-12-06', event_local_date: '2026-12-06',
        event_timezone: 'America/New_York', event_kind: 'run_race',
        event_revision: 1, goal_revision: 1, distance_miles: 6.2,
        goal_time_seconds: 3300,
      });
      const unrelatedTimeOnlyPlan = JSON.parse(JSON.stringify(legacyRoadPlan));
      (unrelatedTimeOnlyPlan.weeks || []).forEach((week) => {
        (week.days || []).forEach((day) => {
          (day.sessions || []).forEach((session) => {
            if (!['recovery_run', 'easy_run', 'long_aerobic', 'steady_run', 'threshold_run',
              'interval_run', 'race_rhythm_run', 'assessment', 'race']
              .includes(session.workout_family)) return;
            session.distance_miles = null;
            delete session.running_distance_m;
            delete session.distance_m;
            delete session.distanceMeters;
            if (session.derived_totals) {
              delete session.derived_totals.distance_m;
              delete session.derived_totals.work_distance_m;
            }
          });
        });
      });
      legacyRoadPlanRow.plan_data = JSON.stringify(unrelatedTimeOnlyPlan);
      legacyRoadPlanRow.plan_json = legacyRoadPlanRow.plan_data;
      const unrelatedRemovalBefore = {
        candidates: candidates.size,
        artifacts: planningArtifacts.size,
        plans: trainingPlans.size,
        assignments: userPlans.size,
        raceOwned: raceRows.has('unrelated'),
      };
      const unrelatedRemoval = await plansRouter._test.previewRaceRemovalForUser(
        ownerId, 'unrelated', { ...roadClock },
      );
      assert.deepEqual(unrelatedRemoval, {
        requires_apply: false,
        impact: 'direct_remove',
        race: { id: 'unrelated', name: 'Unrelated road race' },
      }, 'an unrelated direct removal does not require running-dose evidence for a rebuild');
      assert.deepEqual({
        candidates: candidates.size,
        artifacts: planningArtifacts.size,
        plans: trainingPlans.size,
        assignments: userPlans.size,
        raceOwned: raceRows.has('unrelated'),
      }, unrelatedRemovalBefore, 'direct-remove preview writes no candidate, artifact, plan, assignment, or race');
      raceRows.delete('unrelated');
      legacyRoadPlanRow.plan_data = JSON.stringify(legacyRoadPlan);
      legacyRoadPlanRow.plan_json = legacyRoadPlanRow.plan_data;

      const malformedDistanceValues = [
        ['string', () => '5'],
        ['array', () => [5]],
        ['boxed', () => new Number(5)], // eslint-disable-line no-new-wrappers
        ['coercive', () => ({
          valueOf() { malformedDistanceHooks.coercion += 1; return 5; },
          toString() { malformedDistanceHooks.coercion += 1; return '5'; },
        })],
        ['proxy', () => hostileProxy({ value: 5 })],
        ['object', () => ({ value: 5 })],
        ['nan', () => NaN],
        ['negative', () => -1],
      ];
      for (const [label, makeValue] of malformedDistanceValues) {
        const malformedLegacyPlan = JSON.parse(JSON.stringify(legacyRoadPlan));
        legacyRun(malformedLegacyPlan).distance_miles = makeValue();
        await assertInvalidLegacyRemoval(`distance ${label}`, malformedLegacyPlan);
      }
      const hostilePlanMutations = [
        ['derived accessor', (plan) => {
          const run = legacyRun(plan);
          delete run.distance_miles;
          run.derived_totals = hostileAccessor({}, 'distance_m', 8046.72);
        }],
        ['derived inherited', (plan) => {
          const run = legacyRun(plan);
          delete run.distance_miles;
          run.derived_totals = Object.create({ distance_m: 8046.72 });
        }],
        ['derived class', (plan) => {
          const run = legacyRun(plan);
          delete run.distance_miles;
          run.derived_totals = Object.assign(new HostileRemovalContainer(), { distance_m: 8046.72 });
        }],
        ['derived proxy', (plan) => {
          const run = legacyRun(plan);
          delete run.distance_miles;
          run.derived_totals = hostileProxy({ distance_m: 8046.72 });
        }],
        ['session accessor', (plan) => hostileAccessor(legacyRun(plan), 'distance_miles', 5)],
        ['session inherited', (plan) => {
          const day = plan.weeks[0].days.find((entry) => (entry.sessions || []).includes(legacyRun(plan)));
          const index = day.sessions.indexOf(legacyRun(plan));
          const run = day.sessions[index];
          delete run.distance_miles;
          day.sessions[index] = Object.assign(Object.create({ distance_miles: 5 }), run);
        }],
        ['session class', (plan) => {
          const day = plan.weeks[0].days.find((entry) => (entry.sessions || []).includes(legacyRun(plan)));
          const index = day.sessions.indexOf(legacyRun(plan));
          day.sessions[index] = Object.assign(new HostileRemovalContainer(), day.sessions[index]);
        }],
        ['session proxy', (plan) => {
          const day = plan.weeks[0].days.find((entry) => (entry.sessions || []).includes(legacyRun(plan)));
          const index = day.sessions.indexOf(legacyRun(plan));
          day.sessions[index] = hostileProxy(day.sessions[index]);
        }],
        ['root goals accessor', (plan) => hostileAccessor(plan, 'goals', plan.goals)],
        ['goals proxy', (plan) => { plan.goals = hostileProxy(plan.goals); }],
        ['goal proxy', (plan) => { plan.goals[0] = hostileProxy(plan.goals[0]); }],
        ['root singular goal accessor', (plan) => {
          const goal = plan.goals[0];
          delete plan.goals;
          hostileAccessor(plan, 'goal', goal);
        }],
        ['singular goal proxy', (plan) => {
          const goal = plan.goals[0];
          delete plan.goals;
          plan.goal = hostileProxy(goal);
        }],
        ['unstable goals accessor', (plan) => {
          const goals = plan.goals;
          delete plan.goals;
          Object.defineProperty(plan, 'goals', {
            enumerable: true,
            get() {
              malformedDistanceHooks.getter += 1;
              return malformedDistanceHooks.getter % 2 ? goals : [];
            },
          });
        }],
        ['root weeks accessor', (plan) => hostileAccessor(plan, 'weeks', plan.weeks)],
        ['root inherited weeks', (plan) => {
          const weeks = plan.weeks;
          delete plan.weeks;
          Object.setPrototypeOf(plan, { weeks });
        }],
        ['root class', (plan) => Object.setPrototypeOf(plan, HostileRemovalContainer.prototype)],
        ['weeks proxy', (plan) => { plan.weeks = hostileProxy(plan.weeks); }],
        ['weeks accessor index', (plan) => { plan.weeks = hostileAccessorList(plan.weeks); }],
        ['weeks inherited list', (plan) => { plan.weeks = hostileInheritedList(plan.weeks); }],
        ['weeks class list', (plan) => { plan.weeks = hostileClassList(plan.weeks); }],
        ['week proxy', (plan) => { plan.weeks[0] = hostileProxy(plan.weeks[0]); }],
        ['week days accessor', (plan) => hostileAccessor(plan.weeks[0], 'days', plan.weeks[0].days)],
        ['week inherited days', (plan) => {
          const days = plan.weeks[0].days;
          delete plan.weeks[0].days;
          Object.setPrototypeOf(plan.weeks[0], { days });
        }],
        ['week class', (plan) => Object.setPrototypeOf(plan.weeks[0], HostileRemovalContainer.prototype)],
        ['days proxy', (plan) => { plan.weeks[0].days = hostileProxy(plan.weeks[0].days); }],
        ['days accessor index', (plan) => {
          plan.weeks[0].days = hostileAccessorList(plan.weeks[0].days);
        }],
        ['days inherited list', (plan) => {
          plan.weeks[0].days = hostileInheritedList(plan.weeks[0].days);
        }],
        ['days class list', (plan) => {
          plan.weeks[0].days = hostileClassList(plan.weeks[0].days);
        }],
        ['day proxy', (plan) => { plan.weeks[0].days[0] = hostileProxy(plan.weeks[0].days[0]); }],
        ['day sessions accessor', (plan) => hostileAccessor(
          plan.weeks[0].days[0], 'sessions', plan.weeks[0].days[0].sessions,
        )],
        ['day inherited sessions', (plan) => {
          const sessions = plan.weeks[0].days[0].sessions;
          delete plan.weeks[0].days[0].sessions;
          Object.setPrototypeOf(plan.weeks[0].days[0], { sessions });
        }],
        ['day class', (plan) => Object.setPrototypeOf(
          plan.weeks[0].days[0], HostileRemovalContainer.prototype,
        )],
        ['sessions proxy', (plan) => {
          plan.weeks[0].days[0].sessions = hostileProxy(plan.weeks[0].days[0].sessions);
        }],
        ['sessions accessor index', (plan) => {
          plan.weeks[0].days[0].sessions = hostileAccessorList(plan.weeks[0].days[0].sessions);
        }],
        ['sessions inherited list', (plan) => {
          plan.weeks[0].days[0].sessions = hostileInheritedList(plan.weeks[0].days[0].sessions);
        }],
        ['sessions class list', (plan) => {
          plan.weeks[0].days[0].sessions = hostileClassList(plan.weeks[0].days[0].sessions);
        }],
      ];
      for (const [label, mutate] of hostilePlanMutations) {
        const malformedLegacyPlan = JSON.parse(JSON.stringify(legacyRoadPlan));
        mutate(malformedLegacyPlan);
        await assertInvalidLegacyRemoval(label, malformedLegacyPlan);
      }
      const pollutedLegacyPlan = JSON.parse(JSON.stringify(legacyRoadPlan));
      const pollutedLegacyRun = legacyRun(pollutedLegacyPlan);
      delete pollutedLegacyRun.distance_miles;
      pollutedLegacyRun.derived_totals = {};
      const pollutedDistanceDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'distance_m');
      Object.defineProperty(Object.prototype, 'distance_m', {
        configurable: true, enumerable: true, value: { value: 8046.72 }, writable: true,
      });
      try {
        await assertInvalidLegacyRemoval('Object.prototype distance pollution', pollutedLegacyPlan);
      } finally {
        if (pollutedDistanceDescriptor) {
          Object.defineProperty(Object.prototype, 'distance_m', pollutedDistanceDescriptor);
        } else {
          delete Object.prototype.distance_m;
        }
      }
      assert.deepEqual(malformedDistanceHooks, { coercion: 0, getter: 0, proxy: 0 },
        'the removal route never executes persisted evidence hooks');

      const aliasRun = legacyRun(legacyRoadPlan);
      const aliasDistanceMiles = aliasRun.distance_miles;
      aliasRun.workoutFamily = aliasRun.workout_family;
      aliasRun.workout_family = null;
      aliasRun.distanceMiles = aliasDistanceMiles;
      aliasRun.distance_miles = null;
      aliasRun.scheduled_local_date = null;
      const benignDay = legacyRoadPlan.weeks[0].days[0];
      benignDay.sessions.push({
        session_id: 'benign-non-running-null-family',
        scheduled_local_date: benignDay.date,
        workout_family: null,
        duration_min: 20,
      }, {
        session_id: 'benign-running-no-distance-authority',
        scheduled_local_date: benignDay.date,
        workout_family: 'easy_run',
        duration_min: 15,
      });
      legacyRoadPlan.weeks[0].days.push({
        date: '2026-08-23',
        sessions: null,
      });
      legacyRoadPlan.weeks.unshift(null);
      legacyRoadPlan.weeks[1].days.unshift(null);
      legacyRoadPlanRow.plan_data = JSON.stringify(legacyRoadPlan);
      legacyRoadPlanRow.plan_json = legacyRoadPlanRow.plan_data;

      const legacyRemovalPreview = await invoke(previewRaceRemoval, {
        ...roadRequestBase,
        params: { id: 'yonkers' },
        body: { ...roadClock },
      });
      assert.equal(legacyRemovalPreview.statusCode, 201, JSON.stringify(legacyRemovalPreview.payload));
      assert.equal(raceRows.has('yonkers'), true);
      const legacyRemovalApplyBody = {
        ...roadClock,
        candidate_id: legacyRemovalPreview.payload.candidate_id,
        candidate_hash: legacyRemovalPreview.payload.candidate_hash,
        choice: 'train_for_target',
        ...legacyRemovalPreview.payload.apply_bindings,
      };
      const legacyRemovalApply = await invoke(applyRaceRemoval, {
        ...roadRequestBase,
        params: { id: 'yonkers' },
        body: legacyRemovalApplyBody,
      });
      assert.equal(legacyRemovalApply.statusCode, 200, JSON.stringify(legacyRemovalApply.payload));
      assert.equal(raceRows.has('yonkers'), false);
      const legacyRemovalCurrent = await invoke(readMyPlan, { ...roadRequestBase, body: {} });
      assert.deepEqual(legacyRemovalCurrent.payload.plan.plan_data.goals.map((goal) => goal.raceId), ['army']);
      const legacyRemovalReplay = await invoke(applyRaceRemoval, {
        ...roadRequestBase,
        params: { id: 'yonkers' },
        body: legacyRemovalApplyBody,
      });
      assert.equal(legacyRemovalReplay.statusCode, 200, JSON.stringify(legacyRemovalReplay.payload));
      assert.equal(legacyRemovalReplay.payload.replay, true);
    } finally {
      Object.keys(profile).forEach((key) => delete profile[key]);
      Object.assign(profile, clone(legacyRemovalBaseline.profile));
      restoreMap(raceRows, legacyRemovalBaseline.races);
      restoreMap(trainingPlans, legacyRemovalBaseline.plans);
      restoreMap(userPlans, legacyRemovalBaseline.assignments);
      restoreMap(candidates, legacyRemovalBaseline.candidates);
      restoreMap(planningArtifacts, legacyRemovalBaseline.artifacts);
      rejectionRows.splice(0, rejectionRows.length, ...clone(legacyRemovalBaseline.rejections));
    }

    const activeRoadPlanRow = trainingPlans.get(currentAssignment().plan_id);
    const validRoadPlanData = activeRoadPlanRow.plan_data;
    const validRoadPlanJson = activeRoadPlanRow.plan_json;
    const malformedRoadPlan = JSON.parse(validRoadPlanData);
    malformedRoadPlan.canonical_workout_schema_version = '1';
    activeRoadPlanRow.plan_data = JSON.stringify(malformedRoadPlan);
    activeRoadPlanRow.plan_json = activeRoadPlanRow.plan_data;
    const stateBeforeMalformedRemoval = {
      candidates: candidates.size,
      artifacts: planningArtifacts.size,
      plans: trainingPlans.size,
      assignments: userPlans.size,
      activeAssignment: currentAssignment().id,
      yonkersOwned: raceRows.has('yonkers'),
    };
    const malformedRemovalPreview = await invoke(previewRaceRemoval, {
      ...roadRequestBase,
      params: { id: 'yonkers' },
      body: { ...roadClock },
    });
    assert.equal(malformedRemovalPreview.statusCode, 409, JSON.stringify(malformedRemovalPreview.payload));
    assert.equal(malformedRemovalPreview.payload.code, 'GOAL_BACKWARD_GENERATION_FAILED');
    assert.deepEqual({
      candidates: candidates.size,
      artifacts: planningArtifacts.size,
      plans: trainingPlans.size,
      assignments: userPlans.size,
      activeAssignment: currentAssignment().id,
      yonkersOwned: raceRows.has('yonkers'),
    }, stateBeforeMalformedRemoval,
    'a malformed canonical active plan cannot authorize carry-forward or write removal state');

    const invalidPlanResetBaseline = {
      races: cloneMap(raceRows),
      plans: cloneMap(trainingPlans),
      assignments: cloneMap(userPlans),
      candidates: cloneMap(candidates),
      artifacts: cloneMap(planningArtifacts),
    };
    const restoreInvalidPlanResetBaseline = () => {
      restoreMap(raceRows, invalidPlanResetBaseline.races);
      restoreMap(trainingPlans, invalidPlanResetBaseline.plans);
      restoreMap(userPlans, invalidPlanResetBaseline.assignments);
      restoreMap(candidates, invalidPlanResetBaseline.candidates);
      restoreMap(planningArtifacts, invalidPlanResetBaseline.artifacts);
    };
    const invalidResetBaseline = mutationState();
    const writesBeforeMissingConfirmation = transactionWriteCount;
    const missingResetConfirmation = await invoke(resetRaceRemoval, {
      ...roadRequestBase,
      params: { id: 'yonkers' },
      body: {},
    });
    assert.equal(missingResetConfirmation.statusCode, 400, JSON.stringify(missingResetConfirmation.payload));
    assert.equal(transactionWriteCount, writesBeforeMissingConfirmation,
      'missing reset confirmation enters no write transaction');
    assert.equal(mutationState(), invalidResetBaseline, 'missing reset confirmation writes nothing');
    const wrongResetConfirmation = await invoke(resetRaceRemoval, {
      ...roadRequestBase,
      params: { id: 'yonkers' },
      body: { confirmation: 'clear it' },
    });
    assert.equal(wrongResetConfirmation.statusCode, 400, JSON.stringify(wrongResetConfirmation.payload));
    assert.equal(transactionWriteCount, writesBeforeMissingConfirmation,
      'wrong reset confirmation writes nothing');
    assert.equal(mutationState(), invalidResetBaseline, 'wrong reset confirmation preserves all state');
    const malformedResetConfirmation = await invoke(resetRaceRemoval, {
      ...roadRequestBase,
      params: { id: 'yonkers' },
      body: [],
    });
    assert.equal(malformedResetConfirmation.statusCode, 400,
      JSON.stringify(malformedResetConfirmation.payload));
    assert.equal(transactionWriteCount, writesBeforeMissingConfirmation,
      'malformed reset confirmation writes nothing');
    assert.equal(mutationState(), invalidResetBaseline, 'malformed reset confirmation preserves all state');

    const writesBeforeWrongOwnerReset = transactionWriteCount;
    const wrongOwnerReset = await invoke(resetRaceRemoval, {
      ...roadRequestBase,
      user: { id: foreignOwner },
      params: { id: 'yonkers' },
      body: { confirmation: 'CLEAR_ACTIVE_PLAN_AND_REMOVE_RACE' },
    });
    assert.equal(wrongOwnerReset.statusCode, 404, JSON.stringify(wrongOwnerReset.payload));
    assert.equal(transactionWriteCount, writesBeforeWrongOwnerReset, 'wrong-owner reset performs zero writes');
    assert.equal(mutationState(), invalidResetBaseline, 'wrong-owner reset preserves all owner state');
    const writesBeforeAbsentReset = transactionWriteCount;
    const absentReset = await invoke(resetRaceRemoval, {
      ...roadRequestBase,
      params: { id: 'absent-race' },
      body: { confirmation: 'CLEAR_ACTIVE_PLAN_AND_REMOVE_RACE' },
    });
    assert.equal(absentReset.statusCode, 404, JSON.stringify(absentReset.payload));
    assert.equal(transactionWriteCount, writesBeforeAbsentReset, 'absent owned race reset performs zero writes');
    assert.equal(mutationState(), invalidResetBaseline, 'absent owned race reset preserves all owner state');

    candidates.set('stale-reset-preview', {
      id: 'stale-reset-preview', user_id: ownerId, status: 'preview', candidate_plan_json: '{}',
    });
    candidates.set('foreign-reset-preview', {
      id: 'foreign-reset-preview', user_id: foreignOwner, status: 'preview', candidate_plan_json: '{}',
    });
    const planHistoryBeforeReset = cloneMap(trainingPlans);
    const assignmentHistoryBeforeReset = cloneMap(userPlans);
    const recordedHistory = {
      runs: clone(recentRuns),
      lifts: [{ id: 'lift-history', date: '2026-08-12', completed: true }],
      health: [{ id: 'health-history', resting_hr: 48 }],
      checkins: [{ id: 'checkin-history', readiness: 8 }],
      completedSessions: clone(JSON.parse(currentAssignment().progress_json).completedSessionIds),
    };
    const activeAssignmentBeforeReset = currentAssignment().id;
    const activePlanBeforeReset = currentAssignment().plan_id;
    const successfulReset = await invoke(resetRaceRemoval, {
      ...roadRequestBase,
      params: { id: 'yonkers' },
      body: { confirmation: 'CLEAR_ACTIVE_PLAN_AND_REMOVE_RACE' },
    });
    assert.equal(successfulReset.statusCode, 200, JSON.stringify(successfulReset.payload));
    assert.deepEqual(successfulReset.payload, {
      ok: true,
      race_removed: true,
      active_plan_cleared: true,
      history_preserved: true,
    });
    assert.equal(raceRows.has('yonkers'), false, 'reset deletes only the selected owned race');
    assert.equal(raceRows.has('army'), true, 'reset preserves every other owned race');
    assert.equal(currentAssignment(), null, 'reset leaves no active assignment');
    assert.equal(userPlans.get(activeAssignmentBeforeReset).status, 'superseded');
    assert.deepEqual(
      JSON.parse(userPlans.get(activeAssignmentBeforeReset).progress_json).completedSessionIds,
      recordedHistory.completedSessions,
      'reset preserves completion progress on the superseded assignment',
    );
    const clearMarker = [...userPlans.values()].find((row) => (
      row.user_id === ownerId && row.status === 'cleared'
    ));
    assert.ok(clearMarker, 'reset writes a durable cleared assignment marker');
    assert.equal(clearMarker.supersedes_user_plan_id, activeAssignmentBeforeReset,
      'the clear marker retains lineage to the superseded assignment');
    assert.equal(clearMarker.plan_id, activePlanBeforeReset,
      'the clear marker references the preserved previously active plan');
    for (const [planId, planRow] of planHistoryBeforeReset.entries()) {
      assert.deepEqual(trainingPlans.get(planId), planRow, `reset preserves training plan ${planId}`);
    }
    assert.equal(trainingPlans.size, planHistoryBeforeReset.size,
      'reset creates no synthetic training plan and preserves the full plan history byte-for-byte');
    const legacyResolutionAfterReset = await resolveActivePlanForDate(ownerId, get, {
      planningDateLocal: planningDate,
    });
    assert.equal(legacyResolutionAfterReset, null,
      'the shared active-plan resolver treats a durable clear marker as no active plan');
    const assignmentAfterClearId = 'assignment-after-clear';
    userPlans.set(assignmentAfterClearId, {
      id: assignmentAfterClearId,
      user_id: ownerId,
      plan_id: activePlanBeforeReset,
      started_at: planningDate,
      current_week: 1,
      status: 'active',
      progress_json: JSON.stringify({ completedSessionIds: [] }),
      plan_version: Number(clearMarker.plan_version) + 1,
      lineage_id: clearMarker.lineage_id,
      supersedes_user_plan_id: clearMarker.id,
      effective_from: planningDate,
      created_at: '2026-08-14T16:00:02.000Z',
    });
    const activeResolutionAfterClear = await resolveActivePlanForDate(ownerId, get, {
      planningDateLocal: planningDate,
    });
    assert.equal(activeResolutionAfterClear.source, 'assigned');
    assert.equal(activeResolutionAfterClear.row.user_plan_id, assignmentAfterClearId,
      'a later active assignment takes precedence over an older durable clear marker');
    userPlans.delete(assignmentAfterClearId);
    assert.equal(candidates.get('stale-reset-preview').status, 'superseded',
      'reset invalidates the owner stale preview candidate');
    assert.equal(candidates.get('foreign-reset-preview').status, 'preview',
      'reset does not touch another owner candidate');
    assert.deepEqual(recentRuns, recordedHistory.runs, 'reset preserves recorded run history');
    assert.deepEqual(recordedHistory.lifts, [{ id: 'lift-history', date: '2026-08-12', completed: true }]);
    assert.deepEqual(recordedHistory.health, [{ id: 'health-history', resting_hr: 48 }]);
    assert.deepEqual(recordedHistory.checkins, [{ id: 'checkin-history', readiness: 8 }]);
    const planAfterReset = await invoke(readMyPlan, { ...roadRequestBase, body: {} });
    assert.equal(planAfterReset.statusCode, 200, JSON.stringify(planAfterReset.payload));
    assert.deepEqual(planAfterReset.payload, { plan: null },
      'the cleared marker prevents the preserved legacy training plan from reappearing as active');

    const planHistoryBeforePlanlessReset = cloneMap(trainingPlans);
    const assignmentHistoryBeforePlanlessReset = cloneMap(userPlans);
    const planlessReset = await invoke(resetRaceRemoval, {
      ...roadRequestBase,
      params: { id: 'army' },
      body: { confirmation: 'CLEAR_ACTIVE_PLAN_AND_REMOVE_RACE' },
    });
    assert.equal(planlessReset.statusCode, 200, JSON.stringify(planlessReset.payload));
    assert.deepEqual(planlessReset.payload, {
      ok: true,
      race_removed: true,
      active_plan_cleared: false,
      history_preserved: true,
    }, 'an explicit reset can remove an owned race without falsely claiming it cleared a plan');
    assert.equal(raceRows.has('army'), false);
    assert.deepEqual(trainingPlans, planHistoryBeforePlanlessReset,
      'a planless reset preserves every training plan row');
    assert.deepEqual(userPlans, assignmentHistoryBeforePlanlessReset,
      'a planless reset does not add another clear marker');

    restoreInvalidPlanResetBaseline();
    candidates.set('rollback-reset-preview', {
      id: 'rollback-reset-preview', user_id: ownerId, status: 'preview', candidate_plan_json: '{}',
    });
    const beforeFailedReset = mutationState();
    failResetRaceDelete = true;
    const failedReset = await invoke(resetRaceRemoval, {
      ...roadRequestBase,
      params: { id: 'yonkers' },
      body: { confirmation: 'CLEAR_ACTIVE_PLAN_AND_REMOVE_RACE' },
    });
    failResetRaceDelete = false;
    assert.equal(failedReset.statusCode, 500, JSON.stringify(failedReset.payload));
    assert.equal(mutationState(), beforeFailedReset,
      'an injected failure after plan/candidate writes rolls back the entire reset transaction');
    restoreInvalidPlanResetBaseline();
    const restoredActiveRoadPlanRow = trainingPlans.get(currentAssignment().plan_id);
    restoredActiveRoadPlanRow.plan_data = validRoadPlanData;
    restoredActiveRoadPlanRow.plan_json = validRoadPlanJson;

    const candidateCountBeforeRoadRemoval = candidates.size;
    const artifactCountBeforeRoadRemoval = planningArtifacts.size;
    const activeBeforeRoadRemoval = currentAssignment().id;
    const yonkersRemovalPreview = await invoke(previewRaceRemoval, {
      ...roadRequestBase,
      params: { id: 'yonkers' },
      body: { ...roadClock },
    });
    if (yonkersRemovalPreview.statusCode !== 201) {
      assert.equal(currentAssignment().id, activeBeforeRoadRemoval,
        'a rejected removal preview cannot mutate the active assignment');
      assert.equal(candidates.size, candidateCountBeforeRoadRemoval,
        'a rejected removal preview cannot persist a misleading candidate');
      assert.equal(planningArtifacts.size, artifactCountBeforeRoadRemoval,
        'a rejected removal preview cannot persist candidate artifacts');
      assert.equal(raceRows.has('yonkers'), true,
        'a rejected removal preview cannot delete the owned race');
    }
    assert.equal(yonkersRemovalPreview.statusCode, 201, JSON.stringify(yonkersRemovalPreview.payload));
    assert.equal(yonkersRemovalPreview.payload.impact, 'active_plan_rebuild');
    assert.deepEqual(yonkersRemovalPreview.payload.removal, {
      race_id: 'yonkers',
      remaining_race_ids: ['army'],
    });
    assert.equal(currentAssignment().id, activeBeforeRoadRemoval,
      'removal preview cannot mutate the active assignment');
    assert.equal(candidates.size, candidateCountBeforeRoadRemoval + 1,
      'successful removal preview persists exactly one reviewed successor');
    assert.ok(planningArtifacts.size > artifactCountBeforeRoadRemoval,
      'successful removal preview persists its exact goal-backward artifacts');
    const removalPlan = yonkersRemovalPreview.payload.plan.plan_data;
    const removalSessions = (removalPlan.weeks || []).flatMap((week) => (
      (week.days || []).flatMap((day) => day.sessions || [])
    ));
    assert.deepEqual(removalPlan.goals.map((goal) => goal.raceId), ['army']);
    assert.ok(removalSessions.length > 0);
    assert.ok(removalSessions.every((session) => (
      Array.isArray(session.goal_ids)
        && session.goal_ids.length === 1
        && session.goal_ids[0] === 'goal-army'
    )), 'the successor rebinds every retained canonical session to the Army goal alone');
    const removalRunningDoseM = removalSessions.reduce((sum, session) => (
      sum + Number(session.running_distance_m ?? session.distance_m
        ?? session.derived_totals?.distance_m ?? 0)
    ), 0);
    assert.ok(removalRunningDoseM >= roadCurrentRunningDoseM,
      `the successor preserves the exact reviewed applied running dose (${removalRunningDoseM} >= ${roadCurrentRunningDoseM})`);
    assert.equal(raceRows.has('yonkers'), true, 'preview performs zero race writes');

    const roadRemovalApplyBody = {
      ...roadClock,
      candidate_id: yonkersRemovalPreview.payload.candidate_id,
      candidate_hash: yonkersRemovalPreview.payload.candidate_hash,
      choice: 'train_for_target',
      ...yonkersRemovalPreview.payload.apply_bindings,
    };
    const removalApplyResult = await invoke(applyRaceRemoval, {
      ...roadRequestBase,
      params: { id: 'yonkers' },
      body: roadRemovalApplyBody,
    });
    assert.equal(removalApplyResult.statusCode, 200, JSON.stringify(removalApplyResult.payload));
    assert.equal(raceRows.has('yonkers'), false, 'apply atomically removes the exact owned race');
    const removalAssignment = currentAssignment();
    assert.notEqual(removalAssignment.id, activeBeforeRoadRemoval);
    const removalCurrent = await invoke(readMyPlan, { ...roadRequestBase, body: {} });
    assert.equal(removalCurrent.statusCode, 200, JSON.stringify(removalCurrent.payload));
    assert.deepEqual(removalCurrent.payload.plan.plan_data.goals.map((goal) => goal.raceId), ['army']);
    const removedBindingPaths = [];
    const findRemovedBindings = (value, path = 'response') => {
      if (typeof value === 'string' && value.includes('goal-yonkers')) removedBindingPaths.push(path);
      else if (Array.isArray(value)) value.forEach((entry, index) => findRemovedBindings(entry, `${path}[${index}]`));
      else if (value && typeof value === 'object') Object.entries(value).forEach(([key, entry]) => (
        findRemovedBindings(entry, `${path}.${key}`)
      ));
    };
    findRemovedBindings(removalCurrent.payload.plan.plan_data, 'current_plan');
    assert.deepEqual(removedBindingPaths, [],
      'the authoritative successor contains no removed goal binding');

    const roadRemovalReplay = await invoke(applyRaceRemoval, {
      ...roadRequestBase,
      params: { id: 'yonkers' },
      body: roadRemovalApplyBody,
    });
    assert.equal(roadRemovalReplay.statusCode, 200, JSON.stringify(roadRemovalReplay.payload));
    assert.equal(roadRemovalReplay.payload.replay, true);
    assert.equal(currentAssignment().id, removalAssignment.id,
      'idempotent removal replay performs no second assignment write');
    const appliedRemovalCandidate = [...candidates.values()].find((row) => (
      row.applied_user_plan_id === removalAssignment.id && row.status === 'applied'
    ));
    assert.ok(appliedRemovalCandidate);
    assert.match(
      JSON.parse(appliedRemovalCandidate.material_change_json).candidate_prescription_hash,
      /^sha256:[a-f0-9]{64}$/,
      'bounded apply bindings preserve the exact canonical prescription hash instead of dropping it to null',
    );

    const carryForwardBaseline = {
      races: cloneMap(raceRows),
      plans: cloneMap(trainingPlans),
      assignments: cloneMap(userPlans),
      candidates: cloneMap(candidates),
      artifacts: cloneMap(planningArtifacts),
    };
    const restoreCarryForwardBaseline = () => {
      restoreMap(raceRows, carryForwardBaseline.races);
      restoreMap(trainingPlans, carryForwardBaseline.plans);
      restoreMap(userPlans, carryForwardBaseline.assignments);
      restoreMap(candidates, carryForwardBaseline.candidates);
      restoreMap(planningArtifacts, carryForwardBaseline.artifacts);
    };
    const activeCarryRows = () => {
      const assignment = currentAssignment();
      const candidate = [...candidates.values()].find((row) => (
        row.user_id === ownerId
          && row.applied_user_plan_id === assignment?.id
          && row.status === 'applied'
      ));
      const artifact = candidate && [...planningArtifacts.values()].find((row) => (
        row.user_id === ownerId
          && row.plan_generation_candidate_id === candidate.id
          && row.artifact_kind === 'canonical_session_set'
      ));
      return {
        assignment,
        candidate,
        artifact,
        planRow: assignment ? trainingPlans.get(assignment.plan_id) : null,
      };
    };
    const goalExpansionRequest = () => invoke(preview, {
      ...roadRequestBase,
      body: {
        ...roadClock,
        race_ids: ['hyrox', 'army'],
        target: {
          trainingDays: ['Mon', 'Tue', 'Thu', 'Sat', 'Sun'],
          runDaysPerWeek: 4,
          liftDaysPerWeek: 0,
          planMode: 'hyrox_build',
          liftingEnabled: false,
        },
      },
    });
    const serializedCarryPreview = await goalExpansionRequest();
    assert.equal(serializedCarryPreview.statusCode, 201,
      `serialized JSON storage remains supported: ${JSON.stringify(serializedCarryPreview.payload)}`);
    restoreCarryForwardBaseline();
    databaseJsonShape = 'postgres';
    const postgresCarrySource = await get(
      "SELECT joined JSONB source FROM plan_generation_candidates candidate JOIN planning_pipeline_artifacts canonical ON canonical.artifact_kind='canonical_session_set'",
      [ownerId, currentAssignment().id],
    );
    assert.equal(Object.getPrototypeOf(postgresCarrySource.artifact_payload_json), Object.prototype,
      'the route fixture reproduces node-postgres JSONB object rows');
    assert.equal(Object.getPrototypeOf(postgresCarrySource.candidate_material_change_json), Object.prototype,
      'the material-change fixture reproduces node-postgres JSONB object rows');
    const writeCardinality = () => ({
      races: raceRows.size,
      raceIds: [...raceRows.keys()].sort(),
      candidates: candidates.size,
      artifacts: planningArtifacts.size,
      plans: trainingPlans.size,
      assignments: userPlans.size,
      activeAssignmentId: currentAssignment()?.id || null,
    });
    const assertUnauthenticatedCarryRejected = async (label, mutate) => {
      restoreCarryForwardBaseline();
      const rows = activeCarryRows();
      assert.ok(rows.planRow && rows.candidate && rows.artifact, `${label}: canonical source fixture exists`);
      const hooks = { getter: 0, proxy: 0, coercion: 0 };
      mutate(rows, hooks);
      const before = writeCardinality();
      const response = await goalExpansionRequest();
      assert.equal(response.statusCode, 409, `${label}: ${JSON.stringify(response.payload)}`);
      assert.equal(response.payload.code, 'GOAL_BACKWARD_GENERATION_FAILED', label);
      assert.deepEqual(writeCardinality(), before,
        `${label}: failure performs zero candidate, artifact, plan, assignment, or race writes`);
      assert.deepEqual(hooks, { getter: 0, proxy: 0, coercion: 0 },
        `${label}: authentication executes no hostile getter, Proxy, or coercion hook`);
    };
    const mutatePlan = (rows, mutate) => {
      const plan = JSON.parse(rows.planRow.plan_data);
      mutate(plan);
      rows.planRow.plan_data = JSON.stringify(plan);
      rows.planRow.plan_json = rows.planRow.plan_data;
    };
    const mutateCanonicalPayload = (rows, mutate) => {
      const payload = JSON.parse(rows.artifact.payload_json);
      mutate(payload);
      rows.artifact.payload_json = JSON.stringify(payload);
    };
    const carriedSessionFrom = (payload) => payload.sessions.find((session) => (
      ['easy_run', 'recovery_run', 'long_aerobic', 'assessment'].includes(session.workout_family)
        && Array.isArray(session.goal_ids)
        && session.goal_ids.length > 0
        && session.goal_ids.every((goalId) => goalId === 'goal-army')
    ));
    await assertUnauthenticatedCarryRejected('hashless plan identity', (rows) => {
      mutatePlan(rows, (plan) => { delete plan.canonical_session_set_hash; });
    });
    await assertUnauthenticatedCarryRejected('mismatched plan content hash', (rows) => {
      mutatePlan(rows, (plan) => { plan.canonical_session_set_hash = 'c'.repeat(64); });
    });
    await assertUnauthenticatedCarryRejected('hashless artifact wrapper', (rows) => {
      rows.artifact.content_hash = null;
    });
    await assertUnauthenticatedCarryRejected('mismatched artifact wrapper hash', (rows) => {
      rows.artifact.content_hash = `sha256:${'d'.repeat(64)}`;
    });
    await assertUnauthenticatedCarryRejected('session content hash mismatch', (rows) => {
      mutateCanonicalPayload(rows, (payload) => {
        const session = carriedSessionFrom(payload);
        assert.ok(session);
        session.content_hash = 'e'.repeat(64);
      });
      rows.artifact.content_hash = candidateLifecycle.prefixedHash(JSON.parse(rows.artifact.payload_json));
    });
    await assertUnauthenticatedCarryRejected('session-set content hash mismatch', (rows) => {
      mutateCanonicalPayload(rows, (payload) => { payload.content_hash = 'a'.repeat(64); });
      rows.artifact.content_hash = candidateLifecycle.prefixedHash(JSON.parse(rows.artifact.payload_json));
    });
    await assertUnauthenticatedCarryRejected('candidate identity hash mismatch', (rows) => {
      rows.candidate.selected_candidate_hash = `sha256:${'f'.repeat(64)}`;
    });
    await assertUnauthenticatedCarryRejected('prescription content hash mismatch', (rows) => {
      const material = JSON.parse(rows.candidate.material_change_json);
      material.candidate_prescription_hash = `sha256:${'0'.repeat(64)}`;
      rows.candidate.material_change_json = JSON.stringify(material);
    });
    await assertUnauthenticatedCarryRejected('hashless prescription content', (rows) => {
      const material = JSON.parse(rows.candidate.material_change_json);
      material.candidate_prescription_hash = null;
      rows.candidate.material_change_json = JSON.stringify(material);
    });
    await assertUnauthenticatedCarryRejected('conflicting goal-id aliases', (rows) => {
      mutateCanonicalPayload(rows, (payload) => {
        const session = carriedSessionFrom(payload);
        assert.ok(session);
        session.goalIds = ['goal-hyrox'];
      });
    });
    await assertUnauthenticatedCarryRejected('duplicate canonical goal ids', (rows) => {
      mutateCanonicalPayload(rows, (payload) => {
        const session = carriedSessionFrom(payload);
        assert.ok(session);
        session.goal_ids = ['goal-army', 'goal-army'];
      });
    });
    await assertUnauthenticatedCarryRejected('foreign goal binding', (rows) => {
      mutateCanonicalPayload(rows, (payload) => {
        const session = carriedSessionFrom(payload);
        assert.ok(session);
        session.goal_ids = ['goal-foreign'];
      });
    });
    await assertUnauthenticatedCarryRejected('removed goal binding', (rows) => {
      mutateCanonicalPayload(rows, (payload) => {
        const session = carriedSessionFrom(payload);
        assert.ok(session);
        session.goal_ids = ['goal-yonkers'];
      });
    });
    await assertUnauthenticatedCarryRejected('stale applied candidate linkage', (rows) => {
      rows.candidate.applied_user_plan_id = 'stale-assignment';
    });
    await assertUnauthenticatedCarryRejected('stale independent assignment revision', (rows) => {
      rows.assignment.plan_version += 1;
    });
    await assertUnauthenticatedCarryRejected('accessor artifact payload', (rows, hooks) => {
      const payload = {};
      Object.defineProperty(payload, 'sessions', {
        enumerable: true,
        get() { hooks.getter += 1; return []; },
      });
      rows.artifact.payload_json = payload;
    });
    await assertUnauthenticatedCarryRejected('coercive artifact payload', (rows, hooks) => {
      rows.artifact.payload_json = {
        toString() { hooks.coercion += 1; return '{}'; },
        valueOf() { hooks.coercion += 1; return '{}'; },
      };
    });
    await assertUnauthenticatedCarryRejected('Proxy artifact payload', (rows, hooks) => {
      rows.artifact.payload_json = new Proxy({}, {
        get() { hooks.proxy += 1; return undefined; },
        getOwnPropertyDescriptor() { hooks.proxy += 1; return undefined; },
        getPrototypeOf() { hooks.proxy += 1; return Object.prototype; },
        ownKeys() { hooks.proxy += 1; return []; },
      });
    });
    await assertUnauthenticatedCarryRejected('accessor material-change JSONB', (rows, hooks) => {
      const material = {};
      Object.defineProperty(material, 'candidate_prescription_hash', {
        enumerable: true,
        get() { hooks.getter += 1; return `sha256:${'a'.repeat(64)}`; },
      });
      rows.candidate.material_change_json = material;
    });
    await assertUnauthenticatedCarryRejected('Proxy material-change JSONB', (rows, hooks) => {
      rows.candidate.material_change_json = new Proxy({}, {
        get() { hooks.proxy += 1; return undefined; },
        getOwnPropertyDescriptor() { hooks.proxy += 1; return undefined; },
        getPrototypeOf() { hooks.proxy += 1; return Object.prototype; },
        ownKeys() { hooks.proxy += 1; return []; },
      });
    });
    restoreCarryForwardBaseline();

    const postRemovalState = mutationState();
    const finalHyroxPreview = await goalExpansionRequest();
    if (finalHyroxPreview.statusCode !== 201) {
      assert.equal(mutationState(), postRemovalState,
        'a rejected post-removal HYROX preview writes no candidate, artifact, plan, assignment, or race');
    }
    assert.equal(finalHyroxPreview.statusCode, 201, JSON.stringify(finalHyroxPreview.payload));
    assert.equal(finalHyroxPreview.payload.requires_apply, true);
    assert.deepEqual(finalHyroxPreview.payload.plan.plan_data.goals.map((goal) => goal.raceId), [
      'hyrox', 'army',
    ]);
    assert.equal(finalHyroxPreview.payload.plan.plan_data.goals.some((goal) => (
      goal.raceId === 'yonkers'
    )), false);
    const finalHyroxGoal = finalHyroxPreview.payload.plan.plan_data.goals[0];
    assert.equal(finalHyroxGoal.eventLocalDate, '2026-09-06');
    assert.equal(finalHyroxGoal.division, 'doubles');
    assert.equal(finalHyroxGoal.category, 'men');
    assert.ok(['supported', 'stretch'].includes(
      finalHyroxPreview.payload.plan.plan_data.overall_feasibility,
    ));
    assert.equal(
      canonicalPlanRunningMeters(finalHyroxPreview.payload.plan.plan_data),
      25319,
      'the post-removal goal update preserves the active 23,990m floor and the 25,267m observed lower bound',
    );
    assert.ok(canonicalPlanRunningMeters(finalHyroxPreview.payload.plan.plan_data)
      >= roadCurrentRunningDoseM,
    'the post-removal goal update cannot reduce the exact reviewed active dose');
    assert.ok(canonicalPlanRunningMeters(finalHyroxPreview.payload.plan.plan_data)
      > historicalCollapsedDoseM,
    'the exact post-removal HYROX plus road preview cannot surface the historical collapsed dose');
    const finalPreviewText = JSON.stringify(finalHyroxPreview.payload.plan.plan_data);
    assert.equal(finalPreviewText.includes('goal-yonkers'), false,
      'the final reviewed candidate contains no removed goal binding');
    assert.equal(/reset run/i.test(finalPreviewText), false,
      'the final reviewed candidate cannot reintroduce the historical token Reset Run');

    const finalHyroxApplyBody = {
      ...roadClock,
      choice: 'train_for_target',
      candidate_hash: finalHyroxPreview.payload.candidate_hash,
      ...finalHyroxPreview.payload.apply_bindings,
    };
    const finalHyroxApply = await invoke(apply, {
      ...roadRequestBase,
      params: { candidateId: finalHyroxPreview.payload.candidate_id },
      body: finalHyroxApplyBody,
    });
    assert.equal(finalHyroxApply.statusCode, 200, JSON.stringify(finalHyroxApply.payload));
    const finalHyroxCurrent = await invoke(readMyPlan, { ...roadRequestBase, body: {} });
    assert.equal(finalHyroxCurrent.statusCode, 200, JSON.stringify(finalHyroxCurrent.payload));
    assert.equal(finalHyroxCurrent.payload.user_plan.id, finalHyroxApply.payload.user_plan_id);
    assert.deepEqual(finalHyroxCurrent.payload.plan.plan_data.goals.map((goal) => goal.raceId), [
      'hyrox', 'army',
    ]);
    assert.equal(raceRows.has('yonkers'), false);
    assert.equal(finalHyroxCurrent.payload.plan.plan_data.goals[0].division, 'doubles');
    assert.equal(finalHyroxCurrent.payload.plan.plan_data.goals[0].category, 'men');
    assert.equal(
      canonicalPlanRunningMeters(finalHyroxCurrent.payload.plan.plan_data),
      canonicalPlanRunningMeters(finalHyroxPreview.payload.plan.plan_data),
      'the final authoritative plan retains the exact reviewed post-removal running dose',
    );
    const finalHyroxReplay = await invoke(apply, {
      ...roadRequestBase,
      params: { candidateId: finalHyroxPreview.payload.candidate_id },
      body: finalHyroxApplyBody,
    });
    assert.equal(finalHyroxReplay.statusCode, 200, JSON.stringify(finalHyroxReplay.payload));
    assert.equal(finalHyroxReplay.payload.replay, true);
    assert.equal(currentAssignment().id, finalHyroxApply.payload.user_plan_id,
      'the final candidate replay cannot create a duplicate assignment');
  } finally {
    global.Date = RealDate;
    hyrox.generateHyroxPlan = originalGenerateHyroxPlan;
    if (previousMode === undefined) delete process.env.FORGE_GOAL_BACKWARD_V24_MODE;
    else process.env.FORGE_GOAL_BACKWARD_V24_MODE = previousMode;
    if (previousAudience === undefined) delete process.env.FORGE_GOAL_BACKWARD_V24_AUDIENCE;
    else process.env.FORGE_GOAL_BACKWARD_V24_AUDIENCE = previousAudience;
    delete require.cache[plansRoutePath];
    delete require.cache[racesRoutePath];
    if (originalPlansRoute) require.cache[plansRoutePath] = originalPlansRoute;
    if (originalRacesRoute) require.cache[racesRoutePath] = originalRacesRoute;
    if (originalDb) require.cache[dbModulePath] = originalDb;
    else delete require.cache[dbModulePath];
  }
}

checkBryanGoalBackwardWitnessIntegration();
checkTimePrescriptionDistanceAuthority();
checkC1BoundedMaterialBindings();
checkC1ProjectionAggregationBoundary();
checkC1BoundedCandidateSearch();
checkExplicitEventLifecycleAndOrderedPromotion();

checkRacePatchNoOpBoundary()
  .then(checkDedicatedRouteBoundary)
  .then(checkHyroxCandidateImmediateAdoption)
  .then(() => console.log('DUAL RACE PLAN SMOKE OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
