#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const plansRouter = require('../src/routes/plans');
const racesRouter = require('../src/routes/races');
const { buildRacePlanCandidate } = require('../src/lib/racePlanCandidateEngine');
const { summarizeRecentRunLoad } = require('../src/lib/recentRunLoad');

const OWNER = 'removal-owner';
const OTHER = 'different-owner';

function exactArmyReductionContext() {
  const planningDateLocal = '2026-08-11';
  const historyRows = [{
    id: 'recent-army-distance',
    date: '2026-07-20',
    distance_miles: 10,
    duration_seconds: 7800,
    type: 'long',
    perceived_effort: 5,
    created_at: '2026-07-20T12:00:00.000Z',
  }];
  return {
    planningDateLocal,
    context: {
      todayISO: planningDateLocal,
      profile: {
        weekly_miles_current: 20,
        run_days_per_week: 4,
        lift_days_per_week: 3,
      },
      target: {
        raceId: 'army-2026',
        raceName: 'Army 10-Miler',
        raceDate: '2026-10-11',
        distanceMiles: 10,
        goalType: 'completion',
        goalTimeSeconds: null,
        raceTargets: [{
          raceId: 'army-2026',
          raceName: 'Army 10-Miler',
          raceDate: '2026-10-11',
          distanceMiles: 10,
          goalType: 'completion',
          goalTimeSeconds: null,
        }],
        weeks: 9,
        startDate: '2026-08-10',
        planMode: 'hybrid_maintain',
        trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
        runDaysPerWeek: 4,
      },
      history: {
        weeklyMileageBaseline: 20,
        recentRunCount: 17,
        recentLiftCount: 8,
        acuteRunLoad: summarizeRecentRunLoad(historyRows, {
          todayISO: planningDateLocal,
          weeklyBaseline: 20,
          recoveryState: 'normal',
        }),
        performanceProfile: {
          targetAnchor: {
            equivalentTimeSeconds: 7800,
            equivalentPaceSecondsPerMile: 780,
            date: '2026-07-20',
            kind: 'observed_distance_band',
          },
        },
      },
      recovery: { state: 'normal', available: true, metrics: {} },
    },
  };
}

function assertExactReductionCandidate() {
  const fixture = exactArmyReductionContext();
  const built = buildRacePlanCandidate(fixture.context, {
    planningDateLocal: fixture.planningDateLocal,
    timezoneOffsetMinutes: 240,
  });
  const preFixErrors = [
    { code: 'BRIDGE_WEEK_ELAPSED_SESSION', path: 'weeks[0].days[0]' },
    { code: 'LEGACY_VALIDATION', message: 'weeks[0].days[0] cannot schedule sessions before the current planning date' },
  ];
  if (!built.validation.valid) {
    assert.deepEqual(built.validation.errors, preFixErrors, 'RED must capture the exact production invariant failures');
  }
  assert.equal(
    built.validation.valid,
    true,
    'Army-only replacement must validate; pre-fix errors: ' + JSON.stringify(built.validation.errors),
  );
  assert.deepEqual(built.plan.goals.map((goal) => goal.raceId), ['army-2026']);
  assert.equal(
    built.plan.weeks[0].days
      .filter((day) => day.date < fixture.planningDateLocal)
      .every((day) => day.sessions.length === 0),
    true,
    'the Tuesday bridge never reintroduces work on elapsed Monday',
  );
}

function assertImpactContract() {
  const plan = {
    goals: [
      { kind: 'hyrox', raceId: 'hyrox-race', date: '2026-09-14' },
      { kind: 'run_race', raceId: 'running-race', date: '2026-10-25' },
    ],
  };
  assert.deepEqual(plansRouter._test.raceRemovalImpact(plan, 'hyrox-race'), {
    linked: true,
    remainingRaceIds: ['running-race'],
  });
  assert.deepEqual(plansRouter._test.raceRemovalImpact(plan, 'unlinked-race'), {
    linked: false,
    remainingRaceIds: ['hyrox-race', 'running-race'],
  });
  assert.equal(
    plansRouter._test.candidateEffectiveFrom({ source: 'assigned' }, '2026-08-10', { immediate: true }),
    '2026-08-10',
  );
}

async function assertOwnerScopedDeletion() {
  const calls = [];
  const history = {
    runs: [{ id: 'run-complete' }],
    lifts: [{ id: 'lift-complete' }],
    health: [{ id: 'health-history' }],
    activities: [{ id: 'activity-history' }],
  };
  const before = JSON.stringify(history);
  const tx = {
    async get(sql, params) {
      calls.push({ kind: 'get', sql, params });
      return params[0] === 'race-owned' && params[1] === OWNER
        ? { id: 'race-owned', user_id: OWNER }
        : null;
    },
    async run(sql, params) {
      calls.push({ kind: 'run', sql, params });
      return { changes: params[0] === 'race-owned' && params[1] === OWNER ? 1 : 0 };
    },
  };
  await plansRouter._test.deleteOwnedRaceForCandidate(tx, OWNER, 'race-owned');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.params.includes(OWNER)));
  assert.match(calls[0].sql, /WHERE id=\? AND user_id=\?[\s\S]*FOR UPDATE/i);
  assert.match(calls[1].sql, /DELETE FROM race_events WHERE id=\? AND user_id=\?/i);
  assert.equal(JSON.stringify(history), before);
  await assert.rejects(
    () => plansRouter._test.deleteOwnedRaceForCandidate(tx, OTHER, 'race-owned'),
    (error) => error?.code === 'RACE_NOT_FOUND',
  );
  assert.equal(calls.filter((call) => call.kind === 'run').length, 1);
}

function assertAtomicRouteSource() {
  const plans = fs.readFileSync(path.join(__dirname, '..', 'src/routes/plans.js'), 'utf8');
  const races = fs.readFileSync(path.join(__dirname, '..', 'src/routes/races.js'), 'utf8');
  assert.match(races, /router\.post\('\/:id\/removal-preview', auth,/);
  assert.match(races, /previewRaceRemovalForUser\(req\.user\.id/);
  assert.match(races, /ACTIVE_PLAN_REBUILD_REQUIRED/);
  assert.match(plans, /operation:\s*'remove_race'/);
  const start = plans.indexOf('async function applyPlanCandidate');
  const end = plans.indexOf('\nfunction defaultPrefillFromProfile', start);
  const apply = plans.slice(start, end);
  assert.match(apply, /withPlanningInputMutation\(userId, async \(tx\)/);
  assert.match(apply, /plan_generation_candidates WHERE id=\? AND user_id=\? FOR UPDATE/);
  assert.match(apply, /UPDATE user_plans SET status='superseded' WHERE id=\? AND user_id=\?/);
  assert.match(apply, /deleteOwnedRaceForCandidate\(tx, userId, request\.remove_race_id\)/);
  assert.match(apply, /UPDATE plan_generation_candidates[\s\S]*WHERE id=\? AND user_id=\? AND status='preview'/);
  assert.doesNotMatch(apply, /(?:DELETE|UPDATE)\s+(?:runs|workout_sessions|workout_sets|health_sync|activities)\b/i);
}

async function assertFailedApplyRollsBackModel() {
  const state = {
    race: { id: 'race-owned', user_id: OWNER },
    activePlan: 'current-plan',
  };
  const before = JSON.parse(JSON.stringify(state));
  async function transaction(work) {
    try {
      return await work();
    } catch (error) {
      state.race = before.race;
      state.activePlan = before.activePlan;
      throw error;
    }
  }
  await assert.rejects(() => transaction(async () => {
    state.activePlan = 'replacement-plan';
    state.race = null;
    throw new Error('candidate finalization failed');
  }), /candidate finalization failed/);
  assert.deepEqual(state, before);
}

function removalRouteFixtureState() {
  const activePlan = {
    schemaVersion: 2,
    planMode: 'hybrid_maintain',
    goals: [
      { kind: 'run_race', raceId: 'yonkers-2026', name: 'Yonkers Half Marathon', date: '2026-09-20', distanceMiles: 13.109 },
      { kind: 'run_race', raceId: 'army-2026', name: 'Army 10-Miler', date: '2026-10-11', distanceMiles: 10 },
    ],
    goal: { kind: 'run_race', raceId: 'army-2026', name: 'Army 10-Miler', date: '2026-10-11', distanceMiles: 10 },
    weeks: [],
  };
  const profile = {
    id: OWNER,
    weekly_miles_current: 20,
    run_days_per_week: 4,
    lift_days_per_week: 3,
    preferred_workout_days: JSON.stringify(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']),
    comeback_mode: 0,
    injury_notes: '',
    planning_input_revision: 0,
  };
  const races = new Map([
    ['yonkers-2026', { id: 'yonkers-2026', user_id: OWNER, race_name: 'Yonkers Half Marathon', race_date: '2026-09-20', distance_miles: 13.109, goal_time_seconds: null, status: 'upcoming', event_kind: 'run_race' }],
    ['army-2026', { id: 'army-2026', user_id: OWNER, race_name: 'Army 10-Miler', race_date: '2026-10-11', distance_miles: 10, goal_time_seconds: null, location: 'Washington, DC', status: 'upcoming', event_kind: 'run_race', elevation_gain_ft: 190, max_altitude_ft: 100, terrain: 'road', source: 'Army Ten-Miler', url: 'https://www.armytenmiler.com/' }],
  ]);
  const plans = new Map([['active-plan', {
    id: 'active-plan', user_id: OWNER, week_start: '2026-08-10',
    plan_data: JSON.stringify(activePlan), plan_json: JSON.stringify(activePlan),
    name: 'Yonkers + Army', type: 'hybrid_maintain', weeks: 9, description: 'Two protected goals.',
  }]]);
  const assignments = new Map([['active-assignment', {
    id: 'active-assignment', user_plan_id: 'active-assignment', user_id: OWNER,
    plan_id: 'active-plan', current_week: 1, started_at: '2026-08-10', status: 'active',
    progress_json: JSON.stringify({ completedSessionIds: [] }), plan_version: 1,
    lineage_id: 'active-assignment', supersedes_user_plan_id: null, effective_from: '2026-08-10',
  }]]);
  const history = {
    runs: [{ id: 'recent-army-distance', date: '2026-07-20', distance_miles: 10, duration_seconds: 7800, type: 'long', perceived_effort: 5, created_at: '2026-07-20T12:00:00.000Z' }],
    lifts: [{ id: 'retained-lift' }],
    health: [{ id: 'retained-health' }],
    checkins: [{ id: 'retained-checkin' }],
  };
  return { profile, races, plans, assignments, candidates: new Map(), history };
}

function activeAssignment(state) {
  return [...state.assignments.values()].find((row) => row.status === 'active') || null;
}

function activeAssignedPlanRow(state) {
  const assignment = activeAssignment(state);
  const plan = assignment && state.plans.get(assignment.plan_id);
  return plan ? { ...assignment, ...plan, id: plan.id, user_plan_id: assignment.id } : null;
}

function fixtureTransaction(state, sqls) {
  return {
    async get(sql, params = []) {
      if (sql.includes('UPDATE users') && sql.includes('planning_input_revision')) {
        state.profile.planning_input_revision += 1;
        return { planning_input_revision: state.profile.planning_input_revision };
      }
      if (sql.includes('FROM users WHERE id=?')) {
        return params[0] === OWNER ? { ...state.profile } : null;
      }
      if (sql.includes('FROM race_events WHERE id=? AND user_id=?')) {
        const race = state.races.get(params[0]);
        return race && race.user_id === params[1] ? { ...race } : null;
      }
      if (sql.includes('FROM plan_generation_candidates WHERE id=? AND user_id=?')) {
        const candidate = state.candidates.get(params[0]);
        return candidate && candidate.user_id === params[1] ? { ...candidate } : null;
      }
      if (sql.includes('FROM user_plans up') && sql.includes('JOIN training_plans tp')) {
        return params[0] === OWNER ? activeAssignedPlanRow(state) : null;
      }
      if (sql.includes('FROM user_plans up') && sql.includes("up.status='active'")) {
        const assignment = activeAssignment(state);
        return assignment && params[0] === OWNER ? { ...assignment, user_plan_id: assignment.id } : null;
      }
      if (sql.includes('FROM training_plans tp') && sql.includes('JOIN user_plans owner_up')) {
        const plan = state.plans.get(params[0]);
        const assignment = state.assignments.get(params[1]);
        return plan && assignment && assignment.user_id === params[2] ? { ...plan } : null;
      }
      if (sql.includes('FROM training_plans') && sql.includes('WHERE user_id')) return null;
      return null;
    },
    async all(sql) {
      if (sql.includes('FROM runs')) return state.history.runs.map((row) => ({ ...row }));
      if (sql.includes('FROM workout_sessions')) return [];
      if (sql.includes('FROM workout_sets')) return [];
      return [];
    },
    async run(sql, params = []) {
      sqls.push(sql);
      return fixtureRun(state, sql, params);
    },
  };
}

function fixtureRun(state, sql, params) {
  if (sql.includes('DELETE FROM plan_generation_candidates')) return { changes: 0 };
  if (sql.includes('INSERT INTO plan_generation_candidates')) {
    state.candidates.set(params[0], {
      id: params[0], user_id: params[1], status: params[2],
      training_plan_id: params[3], user_plan_id: params[4], active_plan_version: params[5],
      planning_input_revision: params[6], planning_date_local: params[7],
      timezone_offset_minutes: params[8], input_hash: params[9], candidate_hash: params[10],
      engine_version: params[11], policy_version: params[12], invariant_version: params[13],
      planning_snapshot_json: params[14], candidate_plan_json: params[15],
      generation_trace_json: params[16], expires_at: params[17],
    });
    return { changes: 1 };
  }
  if (sql.includes("UPDATE user_plans SET status='superseded'")) {
    const assignment = state.assignments.get(params[0]);
    if (!assignment || assignment.user_id !== params[1] || assignment.status !== 'active') return { changes: 0 };
    assignment.status = 'superseded';
    return { changes: 1 };
  }
  if (sql.includes('INSERT INTO training_plans')) {
    state.plans.set(params[0], {
      id: params[0], user_id: params[1], week_start: params[2],
      plan_json: params[3], name: params[4], type: params[5], weeks: params[6],
      description: params[7], plan_data: params[8],
    });
    return { changes: 1 };
  }
  if (sql.includes('INSERT INTO user_plans')) {
    state.assignments.set(params[0], {
      id: params[0], user_plan_id: params[0], user_id: params[1], plan_id: params[2],
      started_at: params[3], current_week: params[4], status: params[5],
      progress_json: params[6], plan_version: params[7], lineage_id: params[8],
      supersedes_user_plan_id: params[9], effective_from: params[10],
    });
    return { changes: 1 };
  }
  if (sql.includes('DELETE FROM race_events WHERE id=? AND user_id=?')) {
    const race = state.races.get(params[0]);
    if (!race || race.user_id !== params[1]) return { changes: 0 };
    state.races.delete(params[0]);
    return { changes: 1 };
  }
  if (sql.includes('UPDATE plan_generation_candidates')) {
    const candidate = state.candidates.get(params[4]);
    if (!candidate || candidate.user_id !== params[5] || candidate.status !== 'preview') return { changes: 0 };
    candidate.status = 'applied';
    candidate.applied_choice = params[0];
    candidate.applied_training_plan_id = params[1];
    candidate.applied_user_plan_id = params[2];
    candidate.replay_result_json = params[3];
    return { changes: 1 };
  }
  if (sql.includes('UPDATE users SET run_days_per_week')) {
    state.profile.run_days_per_week = params[0];
    state.profile.preferred_workout_days = params[1];
    return { changes: params[2] === OWNER ? 1 : 0 };
  }
  throw new Error('Unhandled fixture write');
}

async function withRemovalRouteFixture(work) {
  const dbModulePath = require.resolve('../src/db');
  const plansRoutePath = require.resolve('../src/routes/plans');
  const originalDb = require.cache[dbModulePath];
  const originalPlans = require.cache[plansRoutePath];
  const RealDate = global.Date;
  const harness = { state: removalRouteFixtureState(), transactions: [] };
  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : ['2026-08-11T12:00:00.000Z']));
    }
    static now() {
      return new RealDate('2026-08-11T12:00:00.000Z').getTime();
    }
  }
  const withUserMutation = async (userId, callback) => {
    assert.equal(userId, OWNER);
    const staged = structuredClone(harness.state);
    const sqls = [];
    const result = await callback(fixtureTransaction(staged, sqls));
    harness.state = staged;
    harness.transactions.push(sqls);
    return result;
  };
  const { createPlanningInputMutationRunner } = require('../src/lib/planningRevision');
  const mockDb = {
    dbGet: async (sql, params) => fixtureTransaction(harness.state, []).get(sql, params),
    dbAll: async (sql, params) => fixtureTransaction(harness.state, []).all(sql, params),
    dbRun: async (sql, params) => fixtureRun(harness.state, sql, params),
    withUserMutation,
    withPlanningInputMutation: createPlanningInputMutationRunner(withUserMutation),
  };
  require.cache[dbModulePath] = {
    id: dbModulePath, filename: dbModulePath, loaded: true,
    exports: mockDb, children: [], paths: [],
  };
  global.Date = FixedDate;
  delete require.cache[plansRoutePath];
  try {
    await work(require('../src/routes/plans'), harness);
  } finally {
    global.Date = RealDate;
    delete require.cache[plansRoutePath];
    if (originalPlans) require.cache[plansRoutePath] = originalPlans;
    if (originalDb) require.cache[dbModulePath] = originalDb;
    else delete require.cache[dbModulePath];
  }
}

async function assertExactReductionAppliesAtomically() {
  await withRemovalRouteFixture(async (route, harness) => {
    const clock = { planning_date_local: '2026-08-11', timezone_offset_minutes: 240 };
    harness.state.races.get('army-2026').goal_time_seconds = 3600;
    const unsafePreview = await route._test.previewRaceRemovalForUser(OWNER, 'yonkers-2026', clock);
    assert.equal(unsafePreview.plan.plan_data.overall_feasibility, 'unsafe');
    const beforeUnsafe = {
      active: activeAssignment(harness.state),
      history: harness.state.history,
      races: [...harness.state.races.keys()],
    };
    const unsafe = await route._test.applyPlanCandidate(OWNER, unsafePreview.candidate_id, {
      candidate_hash: unsafePreview.candidate_hash,
      choice: 'train_for_target',
      ...clock,
    });
    assert.equal(unsafe.status, 409);
    assert.equal(unsafe.code, 'CANDIDATE_UNSAFE');
    assert.deepEqual(activeAssignment(harness.state), beforeUnsafe.active);
    assert.deepEqual(harness.state.history, beforeUnsafe.history);
    assert.deepEqual([...harness.state.races.keys()], beforeUnsafe.races);

    harness.state.races.get('army-2026').goal_time_seconds = null;
    const preview = await route._test.previewRaceRemovalForUser(OWNER, 'yonkers-2026', clock);
    assert.equal(preview.requires_apply, true);
    assert.deepEqual(preview.plan.plan_data.goals.map((goal) => goal.raceId), ['army-2026']);
    assert.ok(['supported', 'stretch'].includes(preview.plan.plan_data.overall_feasibility));
    const applied = await route._test.applyPlanCandidate(OWNER, preview.candidate_id, {
      candidate_hash: preview.candidate_hash,
      choice: 'train_for_target',
      ...clock,
    });
    assert.equal(applied.status, 200);
    assert.equal(harness.state.races.has('yonkers-2026'), false);
    assert.equal(harness.state.races.has('army-2026'), true);
    assert.deepEqual(harness.state.history, beforeUnsafe.history);
    const replacement = activeAssignedPlanRow(harness.state);
    assert.deepEqual(JSON.parse(replacement.plan_data).goals.map((goal) => goal.raceId), ['army-2026']);
    const atomicWrite = harness.transactions.find((sqls) => (
      sqls.some((sql) => sql.includes('DELETE FROM race_events'))
    ));
    assert.ok(atomicWrite);
    assert.ok(atomicWrite.some((sql) => sql.includes("UPDATE user_plans SET status='superseded'")));
    assert.ok(atomicWrite.some((sql) => sql.includes('INSERT INTO training_plans')));
    assert.ok(atomicWrite.some((sql) => sql.includes('INSERT INTO user_plans')));
    assert.ok(atomicWrite.some((sql) => sql.includes('UPDATE plan_generation_candidates')));
  });
}

async function run() {
  assertExactReductionCandidate();
  await assertExactReductionAppliesAtomically();
  assertImpactContract();
  await assertOwnerScopedDeletion();
  assertAtomicRouteSource();
  await assertFailedApplyRollsBackModel();
  assert.ok(racesRouter._test);
  console.log('RACE PLAN REMOVAL SMOKE OK');
}

if (require.main === module) run().catch((error) => {
  console.error(error);
  process.exit(1);
});
module.exports = { run };
