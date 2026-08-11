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
  assert.equal(
    built.validation.valid,
    true,
    'Army-only replacement must validate; errors: ' + JSON.stringify(built.validation.errors),
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

async function run() {
  assertExactReductionCandidate();
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
