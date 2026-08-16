// Dual A-race plan regression smoke.
// Run: node backend/test/dualRacePlan.smoke.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const concurrent = require('../src/lib/concurrentPlan');
const hyrox = require('../src/lib/hyroxPlan');
const { aggregateWeeklyStress } = require('../src/lib/goalBackwardLoad');
const { buildGoalBackwardPlanningDecision } = require('../src/lib/goalBackwardDecisionEngine');
const { targetRef: goalBackwardTargetRef } = require('../src/lib/betaPlanRollout');
const candidateLifecycle = require('../src/lib/planCandidateLifecycle');
const adaptation = require('../src/lib/adaptationEngine');
const planSchema = require('../src/lib/planSchema');
const { motivationalRunName } = require('../../shared/runDisplayName.mjs');

const HYROX_EQUIPMENT = ['ski_erg', 'row_erg', 'sled_push', 'sled_pull', 'wall_ball_target', 'sandbag', 'farmers_carry', 'treadmill'];

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
assert.equal(Number.isFinite(corruptBaselinePlan.inputSummary.weeklyMileageBaseline), true);

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
    assert.equal(Number.isFinite(response.payload.plan.plan_data.inputSummary.weeklyMileageBaseline), true);
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
  const originalDb = require.cache[dbModulePath];
  const originalPlansRoute = require.cache[plansRoutePath];
  const RealDate = global.Date;
  const previousMode = process.env.FORGE_GOAL_BACKWARD_V24_MODE;
  process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'shadow';
  const ownerId = 'hyrox-army-owner';
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

  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : ['2026-08-14T16:00:00.000Z']));
    }
    static now() { return new RealDate('2026-08-14T16:00:00.000Z').getTime(); }
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
    if (sql.includes('SELECT * FROM training_plans WHERE user_id')) return null;
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
    return { changes: 1 };
  }

  const tx = { get, all, run: runStatement };
  const mockDb = {
    dbGet: get,
    dbAll: all,
    dbRun: runStatement,
    withUserMutation: async (_userId, fn) => fn(tx),
    withPlanningInputMutation: async (_userId, fn) => {
      const result = await fn(tx);
      return result && Object.prototype.hasOwnProperty.call(result, 'marker')
        && Object.prototype.hasOwnProperty.call(result, 'value')
        ? result.value
        : result;
    },
  };

  require.cache[dbModulePath] = {
    id: dbModulePath, filename: dbModulePath, loaded: true, exports: mockDb, children: [], paths: [],
  };
  global.Date = FixedDate;
  delete require.cache[plansRoutePath];

  try {
    const plansRouter = require('../src/routes/plans');
    const preview = routeHandler(plansRouter, '/generate-for-races', 'post');
    const apply = routeHandler(plansRouter, '/candidates/:candidateId/apply', 'post');
    const reject = routeHandler(plansRouter, '/candidates/:candidateId/reject', 'post');
    const readMyPlan = routeHandler(plansRouter, '/my', 'get');
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
    ))));

    profile.training_age_class = 'ESTABLISHED';
    const originalRecentMiles = recentRuns.map((run) => run.distance_miles);
    [2, 3, 2, 4, 2].forEach((miles, index) => { recentRuns[index].distance_miles = miles; });
    let moderateResult = null;
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
    assert.ok(moderateResult?.selected_candidate,
      'realistic two-to-four-mile runs retain an eligible bounded candidate');
    assert.equal(moderateResult.selected_candidate.validation.validator_results.find((entry) => (
      entry.validator === 'cross_modal_ceiling'
    )).valid, true);
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

    let authorizedResult = null;
    const authorizedPreview = await plansRouter._test.previewPlanForUser(ownerId, {
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
        inspectDecision: (result) => { authorizedResult = result; },
      },
    });
    assert.equal(authorizedResult.decision.training_age_class, 'ESTABLISHED');
    assert.ok(authorizedResult.selected_candidate, 'realistic established mileage produces an eligible bounded candidate');
    assert.ok(authorizedResult.candidates.length <= 64);
    const runningFamilies = new Set([
      'recovery_run', 'easy_run', 'long_aerobic', 'steady_run', 'threshold_run',
      'interval_run', 'race_rhythm_run', 'assessment', 'race',
    ]);
    const selectedRunningMeters = authorizedResult.selected_candidate.sessions.reduce((sum, session) => (
      sum + (runningFamilies.has(session.workout_family) ? Number(session.derived_totals?.distance_m || 0) : 0)
    ), 0);
    assert.equal(selectedRunningMeters, 14690);
    assert.ok(selectedRunningMeters >= authorizedResult.decision.minimum_weekly_demand.running_m,
      'selected candidate satisfies the full realistic-volume weekly running floor');
    assert.equal(authorizedResult.selected_candidate.validation.validator_results.find((entry) => (
      entry.validator === 'cross_modal_ceiling'
    )).valid, true);
    const selectedRunningPrimary = authorizedResult.selected_candidate.skeleton_sessions.find((session) => (
      session.requirement_id === 'hyrox_running_support'
    ));
    assert.equal(selectedRunningPrimary.workout_family, 'long_aerobic');
    assert.equal(selectedRunningPrimary.material_source_workout_family, 'long_aerobic',
      'the exact long-run source remains attached to the running primary requirement');
    const selectedSupports = authorizedResult.selected_candidate.sessions
      .filter((session) => session.role === 'SUPPORTING')
      .map((session) => ({ family: session.workout_family, supports: session.supports_requirement_id }));
    assert.ok(selectedSupports.length >= 2);
    assert.ok(selectedSupports.every((entry) => (
      entry.family === 'easy_run' && entry.supports === 'hyrox_running_support'
    )), 'running support maps to the exact running primary requirement');
    const projectedRunningSupport = authorizedResult.selected_candidate.skeleton_sessions.find((session) => (
      session.material_source === 'CURRENT_HYBRID_RUNNING_COMPONENT'
        && session.material_source_workout_family === 'hyrox_compromised'
        && session.workout_family === 'easy_run'
        && session.supports_requirement_id === 'hyrox_running_support'
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
    assert.equal(currentAssignment().id, activePlanBeforeForcedFailure, 'preview cannot mutate the active plan');

    const previewResponse = await invoke(preview, {
      ...requestBase,
      body: {
        ...requestClock,
        race_ids: ['hyrox', 'army'],
        target: { trainingDays: ['Tue', 'Thu', 'Sat', 'Sun'], runDaysPerWeek: 4, liftingEnabled: false },
      },
    });
    assert.equal(previewResponse.statusCode, 201, JSON.stringify(previewResponse.payload));
    assert.equal(candidates.get(previewResponse.payload.candidate_id).feature_mode, 'shadow',
      'the route regression applies a legacy/current-engine candidate with attached shadow diagnostics');
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
    assert.equal(shadowCandidateReceipt.authoritative_engine, 'current');
    assert.ok(shadowCandidateReceipt.candidates.length > 1);
    assert.ok(shadowCandidateReceipt.candidates.some((candidate) => candidate.valid === true));
    assert.ok(shadowCandidateReceipt.candidates.every((candidate) => typeof candidate.valid === 'boolean'));
    const shadowSurfaceReceipt = JSON.parse(shadowArtifacts.find((artifact) => (
      artifact.artifact_kind === 'surface_manifest'
    )).payload_json);
    assert.equal(shadowSurfaceReceipt.feature_mode, 'shadow');
    assert.equal(shadowSurfaceReceipt.v24_surface_enabled, false);
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
    assert.notEqual(immediate.payload.user_plan.id, 'assignment-hyrox', 'the predecessor is not returned on the accepted local date');

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
      body: { candidate_hash: rejectedPreview.payload.candidate_hash, reason_code: 'ADAPTATION_REJECTED' },
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
  } finally {
    global.Date = RealDate;
    if (previousMode === undefined) delete process.env.FORGE_GOAL_BACKWARD_V24_MODE;
    else process.env.FORGE_GOAL_BACKWARD_V24_MODE = previousMode;
    delete require.cache[plansRoutePath];
    if (originalPlansRoute) require.cache[plansRoutePath] = originalPlansRoute;
    if (originalDb) require.cache[dbModulePath] = originalDb;
    else delete require.cache[dbModulePath];
  }
}

checkBryanGoalBackwardWitnessIntegration();
checkC1BoundedMaterialBindings();
checkExplicitEventLifecycleAndOrderedPromotion();

checkRacePatchNoOpBoundary()
  .then(checkDedicatedRouteBoundary)
  .then(checkHyroxCandidateImmediateAdoption)
  .then(() => console.log('DUAL RACE PLAN SMOKE OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
