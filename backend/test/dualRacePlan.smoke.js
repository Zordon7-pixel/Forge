// Dual A-race plan regression smoke.
// Run: node backend/test/dualRacePlan.smoke.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const concurrent = require('../src/lib/concurrentPlan');
const adaptation = require('../src/lib/adaptationEngine');

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

const sessions = plan.weeks.flatMap((week) => week.days.flatMap((day) => (
  day.sessions.map((session) => ({ week, day, session }))
)));
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
assert.match(routeSource, /Use the owned-race planner to build a two-race plan/);
assert.match(routeSource, /SELECT \* FROM race_events WHERE id = \? AND user_id = \?/);
assert.match(routeSource, /Two PR races must be at least 21 days apart for recovery and tapering/);
assert.match(routeSource, /persistConcurrentPlan\(req\.user\.id, evidencePlan/);

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
  };
  const raceRows = new Map();
  let failTransaction = false;
  let transactionCalls = 0;

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
      super(...(args.length ? args : ['2026-08-03T12:00:00.000Z']));
    }
    static now() { return new RealDate('2026-08-03T12:00:00.000Z').getTime(); }
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
    dbAll: async () => [],
    dbRun: async () => ({ changes: 1 }),
    withTransaction: async (fn) => {
      transactionCalls += 1;
      const tx = {
        run: async (sql) => {
          if (failTransaction && sql.includes('INSERT INTO training_plans')) throw new Error('intentional transaction failure');
          return { changes: 1 };
        },
      };
      return fn(tx);
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
    const generateForRaces = routeHandler(plansRouter, '/generate-for-races', 'post');
    const generate = routeHandler(plansRouter, '/generate', 'post');
    const baseRequest = {
      user: { id: ownerId },
      query: {},
      body: {
        race_ids: [],
        target: {
          trainingDays: ['Mon', 'Tue', 'Thu', 'Sat'],
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
      body: { ...baseRequest.body, race_ids: ['yonkers', 'army'] },
    });
    assert.equal(response.statusCode, 201, response.payload?.error || 'a 21-day pair should generate');
    assert.deepEqual(response.payload.plan.plan_data.goals.map((goal) => goal.date), ['2026-09-20', '2026-10-11']);
    assert.equal(transactionCalls, 1, 'the successful rebuild uses one transaction');

    failTransaction = true;
    response = await invoke(generateForRaces, {
      ...baseRequest,
      body: { ...baseRequest.body, race_ids: ['yonkers', 'army'] },
    });
    assert.equal(response.statusCode, 500, 'transaction failure cannot return a successful plan replacement');
  } finally {
    global.Date = RealDate;
    delete require.cache[plansRoutePath];
    if (originalPlansRoute) require.cache[plansRoutePath] = originalPlansRoute;
    if (originalDb) require.cache[dbModulePath] = originalDb;
    else delete require.cache[dbModulePath];
  }
}

checkDedicatedRouteBoundary()
  .then(() => console.log('DUAL RACE PLAN SMOKE OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
