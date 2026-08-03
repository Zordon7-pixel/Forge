// Run-frequency authority regression smoke.
// Run: node backend/test/runFrequencyAuthority.smoke.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../src/lib/concurrentPlan');
const { resolveRunSchedule } = require('../src/lib/runSchedule');

const repoRoot = path.resolve(__dirname, '../..');
const catalogSource = fs.readFileSync(path.join(repoRoot, 'frontend/src/pages/PlanCatalog.jsx'), 'utf8');
const planSource = fs.readFileSync(path.join(repoRoot, 'frontend/src/pages/Plan.jsx'), 'utf8');
assert.match(catalogSource, /const target = \{[\s\S]*trainingDays,[\s\S]*runDaysPerWeek: runCount/);
assert.match(catalogSource, /Math\.min\(6, trainingDays\.length\)/);
assert.match(planSource, /planReviewRequired[\s\S]*Your plan needs a frequency review[\s\S]*The active calendar has not been rewritten[\s\S]*Review and rebuild calendar/);
assert.match(planSource, /currentWeekConstraint[\s\S]*Your first week is partial[\s\S]*currentWeekConstraint\.explanation/);

const PROFILE_WITH_STALE_THREE = {
  weekly_miles_current: 24,
  run_days_per_week: 3,
  lift_days_per_week: 0,
};

function context(runDaysPerWeek, trainingDays) {
  return {
    todayISO: '2026-07-24',
    profile: PROFILE_WITH_STALE_THREE,
    history: {
      weeklyMileageBaseline: 24,
      recentRunCount: 16,
      recentLiftCount: 0,
      adherenceRate: 0.9,
      missedWorkouts: 0,
    },
    recovery: { state: 'normal' },
    target: {
      weeks: 8,
      startDate: '2026-07-27',
      distanceMiles: 10,
      planMode: 'run_only',
      liftingEnabled: false,
      runDaysPerWeek,
      trainingDays,
      runDaysSource: 'target',
      trainingDaysSource: 'target',
    },
  };
}

function runSessions(week) {
  return week.days.flatMap((day) => day.sessions.map((session) => ({ day: day.day, session })))
    .filter(({ session }) => session.kind === 'run');
}

function routeHandler(router, path, method) {
  const layer = router.stack.find((item) => item.route?.path === path && item.route?.methods?.[method]);
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

for (const frequency of [4, 5, 6]) {
  const selectedDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].slice(0, frequency);
  const planContext = context(frequency, selectedDays);
  const plan = engine.buildConcurrentPlan(planContext);
  const validation = engine.validateConcurrentPlan(plan, planContext);

  assert.equal(validation.valid, true, `${frequency}-day plan validates: ${validation.errors.join('; ')}`);
  assert.equal(plan.schedulePreferences.runDaysPerWeek, frequency);
  assert.deepEqual(plan.schedulePreferences.trainingDays, selectedDays);
  for (const week of plan.weeks.filter((entry) => !['taper', 'race'].includes(entry.phase))) {
    const runs = runSessions(week);
    assert.equal(runs.length, frequency, `week ${week.week} preserves ${frequency} runs`);
    assert.equal(runs.every(({ day }) => selectedDays.includes(day)), true, `week ${week.week} uses selected weekdays only`);
  }
}

function partialWeekContext({ todayISO, frequency, trainingDays, runCount = 0, runDates = [] }) {
  const weekStart = engine.mondayFor(todayISO);
  const planContext = context(frequency, trainingDays);
  return {
    ...planContext,
    todayISO,
    history: {
      ...planContext.history,
      acuteRunLoad: {
        available: runCount > 0,
        latestRun: null,
        currentWeek: {
          startDate: weekStart,
          miles: runCount * 3,
          runCount,
          runDates,
          longRunCompleted: false,
          longestRun: null,
        },
        protection: { active: false },
      },
    },
    target: {
      ...planContext.target,
      startDate: weekStart,
    },
  };
}

function assertValidPartialWeek(planContext, label) {
  const plan = engine.buildConcurrentPlan(planContext);
  const validation = engine.validateConcurrentPlan(plan, planContext);
  assert.equal(validation.valid, true, `${label} validates without exact-count rejection: ${validation.errors.join('; ')}`);
  return plan;
}

const mondayAfterRunContext = partialWeekContext({
  todayISO: '2026-07-20',
  frequency: 4,
  trainingDays: ['Mon', 'Tue', 'Thu', 'Sat'],
  runCount: 1,
  runDates: ['2026-07-20'],
});
const mondayAfterRunPlan = assertValidPartialWeek(mondayAfterRunContext, 'Monday generation after a same-day run');
assert.equal(runSessions(mondayAfterRunPlan.weeks[0]).length, 3);
assert.equal(runSessions(mondayAfterRunPlan.weeks[0]).some(({ day }) => day === 'Mon'), false);
assert.equal(mondayAfterRunPlan.weeks[0].completedRunsAtGeneration, 1);
assert.equal(mondayAfterRunPlan.weeks[0].currentWeekConstraint.remainingRunQuota, 3);
assert.equal(mondayAfterRunPlan.weeks[0].currentWeekConstraint.totalRunsTowardTarget, 4);

const offDayRunContext = partialWeekContext({
  todayISO: '2026-07-21',
  frequency: 4,
  trainingDays: ['Wed', 'Thu', 'Sat', 'Sun'],
  runCount: 1,
  runDates: ['2026-07-20'],
});
const offDayRunPlan = assertValidPartialWeek(offDayRunContext, 'off-day completed run');
assert.equal(runSessions(offDayRunPlan.weeks[0]).length, 3);
assert.equal(runSessions(offDayRunPlan.weeks[0]).every(({ day }) => offDayRunContext.target.trainingDays.includes(day)), true);
assert.equal(offDayRunPlan.weeks[0].currentWeekConstraint.completedRunsAppliedToQuota, 1);

const quotaAlreadyMetContext = partialWeekContext({
  todayISO: '2026-07-22',
  frequency: 4,
  trainingDays: ['Wed', 'Thu', 'Sat', 'Sun'],
  runCount: 5,
  runDates: ['2026-07-20', '2026-07-21', '2026-07-22'],
});
const quotaAlreadyMetPlan = assertValidPartialWeek(quotaAlreadyMetContext, 'completed runs already above target');
assert.equal(runSessions(quotaAlreadyMetPlan.weeks[0]).length, 0);
assert.equal(quotaAlreadyMetPlan.weeks[0].completedRunsAtGeneration, 5);
assert.equal(quotaAlreadyMetPlan.weeks[0].currentWeekConstraint.completedRunsAppliedToQuota, 4);
assert.equal(quotaAlreadyMetPlan.weeks[0].currentWeekConstraint.remainingRunQuota, 0);
assert.equal(quotaAlreadyMetPlan.weeks[0].currentWeekConstraint.totalRunsTowardTarget, 4);

const lateWeekContext = partialWeekContext({
  todayISO: '2026-07-24',
  frequency: 4,
  trainingDays: ['Tue', 'Thu', 'Sat', 'Sun'],
});
const lateWeekPlan = assertValidPartialWeek(lateWeekContext, 'late-week generation with too few selected days remaining');
assert.deepEqual(runSessions(lateWeekPlan.weeks[0]).map(({ day }) => day), ['Sat', 'Sun']);
assert.equal(lateWeekPlan.weeks[0].currentWeekConstraint.remainingRunQuota, 4);
assert.equal(lateWeekPlan.weeks[0].currentWeekConstraint.scheduledRunCount, 2);
assert.equal(lateWeekPlan.weeks[0].currentWeekConstraint.totalRunsTowardTarget, 2);
assert.match(lateWeekPlan.weeks[0].currentWeekConstraint.explanation, /full 4-day selected frequency starts next week/);
assert.equal(runSessions(lateWeekPlan.weeks[1]).length, 4);
const pastDayCandidate = JSON.parse(JSON.stringify(lateWeekPlan));
const pastTuesday = pastDayCandidate.weeks[0].days.find((day) => day.day === 'Tue');
const futureSaturday = pastDayCandidate.weeks[0].days.find((day) => day.day === 'Sat');
pastTuesday.sessions.push(futureSaturday.sessions.find((session) => session.kind === 'run'));
futureSaturday.sessions = futureSaturday.sessions.filter((session) => session.kind !== 'run');
const pastDayValidation = engine.validateConcurrentPlan(pastDayCandidate, lateWeekContext);
assert.equal(pastDayValidation.valid, false);
assert.equal(pastDayValidation.errors.some((error) => error.includes('past or on an already completed date')), true);

const fiveDayContext = context(5, ['Mon', 'Tue', 'Wed', 'Thu', 'Sat']);
const invalidCountPlan = engine.buildConcurrentPlan(fiveDayContext);
const firstNonTaper = invalidCountPlan.weeks.find((week) => !['taper', 'race'].includes(week.phase));
const runDay = firstNonTaper.days.find((day) => day.sessions.some((session) => session.kind === 'run'));
runDay.sessions = runDay.sessions.filter((session) => session.kind !== 'run');
const invalidCount = engine.validateConcurrentPlan(invalidCountPlan, fiveDayContext);
assert.equal(invalidCount.valid, false);
assert.equal(invalidCount.errors.some((error) => error.includes('exactly 5 weekly runs')), true);

const invalidWeekdayPlan = engine.buildConcurrentPlan(fiveDayContext);
const invalidWeek = invalidWeekdayPlan.weeks[0];
const sourceDay = invalidWeek.days.find((day) => day.sessions.some((session) => session.kind === 'run'));
const outsideDay = invalidWeek.days.find((day) => day.day === 'Fri');
outsideDay.sessions.push(sourceDay.sessions.find((session) => session.kind === 'run'));
sourceDay.sessions = sourceDay.sessions.filter((session) => session.kind !== 'run');
const invalidWeekday = engine.validateConcurrentPlan(invalidWeekdayPlan, fiveDayContext);
assert.equal(invalidWeekday.valid, false);
assert.equal(invalidWeekday.errors.some((error) => error.includes('outside the selected trainingDays')), true);

const partialSelection = resolveRunSchedule(
  PROFILE_WITH_STALE_THREE,
  { trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
  { requireCompleteSelection: true }
);
assert.equal(partialSelection.valid, false);
assert.equal(partialSelection.code, 'INCOMPLETE_RUN_SCHEDULE');

const legacy = resolveRunSchedule({}, {}, { requireCompleteSelection: true });
assert.equal(legacy.valid, true);
assert.equal(legacy.runDaysPerWeek, 3);
assert.equal(legacy.runDaysSource, 'legacy_default');
const savedSelection = resolveRunSchedule({
  run_days_per_week: 5,
  preferred_workout_days: JSON.stringify(['Mon', 'Tue', 'Wed', 'Thu', 'Sat']),
});
assert.equal(savedSelection.runDaysPerWeek, 5);
assert.deepEqual(savedSelection.trainingDays, ['Mon', 'Tue', 'Wed', 'Thu', 'Sat']);
assert.equal(savedSelection.trainingDaysSource, 'profile');

async function checkProfileReviewMarker() {
  const dbModulePath = require.resolve('../src/db');
  const authRoutePath = require.resolve('../src/routes/auth');
  const authMiddlewarePath = require.resolve('../src/middleware/auth');
  const originalDb = require.cache[dbModulePath];
  const originalAuthRoute = require.cache[authRoutePath];
  const originalAuthMiddleware = require.cache[authMiddlewarePath];
  const originalJwtSecret = process.env.JWT_SECRET;
  const user = {
    id: 'frequency-owner',
    name: 'Frequency Test',
    email: 'frequency@example.test',
    onboarded: 1,
    coach_personality: 'mentor',
    run_days_per_week: 3,
    lift_days_per_week: 0,
    preferred_workout_days: JSON.stringify(['Tue', 'Thu', 'Sat']),
  };
  let progress = { completedSessionIds: ['already-done'] };
  const tx = {
    get: async (sql) => {
      if (sql.includes('SELECT run_days_per_week, preferred_workout_days FROM users')) {
        return {
          run_days_per_week: user.run_days_per_week,
          preferred_workout_days: user.preferred_workout_days,
        };
      }
      if (sql.includes('SELECT id, progress_json FROM user_plans')) {
        return { id: 'active-user-plan', progress_json: JSON.stringify(progress) };
      }
      if (sql.includes('SELECT id, name, email, onboarded')) return { ...user };
      return null;
    },
    run: async (sql, params) => {
      if (sql.includes('UPDATE users SET')) {
        user.run_days_per_week = params[8] ?? user.run_days_per_week;
        user.preferred_workout_days = params[14] ?? user.preferred_workout_days;
        return { changes: 1 };
      }
      if (sql.includes('UPDATE user_plans SET progress_json')) {
        progress = JSON.parse(params[0]);
        return { changes: 1 };
      }
      return { changes: 1 };
    },
  };
  const mockDb = {
    dbGet: async () => ({ ...user }),
    dbAll: async () => [],
    dbRun: async () => ({ changes: 1 }),
    withTransaction: async (fn) => fn(tx),
    withUserMutation: async (_userId, fn) => fn(tx),
    runWithUserContext: async (_userId, fn) => fn(),
  };

  require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: mockDb,
    children: [],
    paths: [],
  };
  delete require.cache[authMiddlewarePath];
  delete require.cache[authRoutePath];
  process.env.JWT_SECRET = 'run-frequency-test-secret';

  try {
    const authRouter = require('../src/routes/auth');
    const handler = routeHandler(authRouter, '/me/profile', 'put');
    const response = await invoke(handler, {
      body: {
        run_days_per_week: 5,
        preferred_workout_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Sat'],
      },
      user: { id: user.id },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(user.run_days_per_week, 5);
    assert.deepEqual(JSON.parse(user.preferred_workout_days), ['Mon', 'Tue', 'Wed', 'Thu', 'Sat']);
    assert.deepEqual(progress.completedSessionIds, ['already-done']);
    assert.equal(progress.planReviewRequired.reason, 'run_frequency_changed');
    assert.equal(progress.planReviewRequired.previousRunDaysPerWeek, 3);
    assert.equal(progress.planReviewRequired.requestedRunDaysPerWeek, 5);
  } finally {
    delete require.cache[authRoutePath];
    delete require.cache[authMiddlewarePath];
    if (originalAuthRoute) require.cache[authRoutePath] = originalAuthRoute;
    if (originalAuthMiddleware) require.cache[authMiddlewarePath] = originalAuthMiddleware;
    if (originalDb) require.cache[dbModulePath] = originalDb;
    else delete require.cache[dbModulePath];
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalJwtSecret;
  }
}

async function checkPartialWeekRoutesDoNotReject() {
  const dbModulePath = require.resolve('../src/db');
  const plansRoutePath = require.resolve('../src/routes/plans');
  const originalDb = require.cache[dbModulePath];
  const originalPlansRoute = require.cache[plansRoutePath];
  const RealDate = global.Date;
  const profile = {
    id: 'partial-week-owner',
    name: 'Partial Week Test',
    weekly_miles_current: 24,
    run_days_per_week: 4,
    lift_days_per_week: 0,
    goal_type: 'fitness',
    comeback_mode: 0,
    injury_notes: '',
  };
  const scenario = {
    todayISO: '2026-07-20',
    runs: [],
    race: null,
  };

  function runRow(id, date) {
    return {
      id,
      date,
      type: 'easy',
      watch_activity_type: 'Running',
      watch_normalized_type: 'running',
      distance_miles: 3,
      duration_seconds: 1800,
      perceived_effort: 4,
      avg_heart_rate: 140,
      pace_avg: 600,
      health_source: 'forged_hybrid',
      created_at: `${date}T12:00:00.000Z`,
    };
  }

  class FixedDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [`${scenario.todayISO}T12:00:00.000Z`]));
    }

    static now() {
      return new RealDate(`${scenario.todayISO}T12:00:00.000Z`).getTime();
    }
  }

  const mockDb = {
    dbGet: async (sql, params = []) => {
      if (sql.includes('FROM users WHERE id = ?')) return params[0] === profile.id ? { ...profile } : null;
      if (sql.includes('FROM race_events WHERE id = ? AND user_id = ?')) {
        return scenario.race?.id === params[0] && profile.id === params[1] ? { ...scenario.race } : null;
      }
      return null;
    },
    dbAll: async (sql) => {
      if (sql.includes('FROM runs')) return scenario.runs.map((run) => ({ ...run }));
      return [];
    },
    dbRun: async () => ({ changes: 1 }),
    withTransaction: async (fn) => fn({ run: async () => ({ changes: 1 }) }),
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
    const generate = routeHandler(plansRouter, '/generate', 'post');
    const generateForRace = routeHandler(plansRouter, '/generate-for-race/:raceId', 'post');

    scenario.runs = [runRow('same-day-selected', scenario.todayISO)];
    let response = await invoke(generate, {
      body: { target: { weeks: 4, trainingDays: ['Mon', 'Tue', 'Thu', 'Sat'], runDaysPerWeek: 4, planMode: 'run_only', liftingEnabled: false } },
      query: {},
      user: { id: profile.id },
    });
    assert.equal(response.statusCode, 201, `Monday same-day route must not return HTTP ${response.statusCode}: ${response.payload?.error || ''}`);
    assert.equal(runSessions(response.payload.plan.plan_data.weeks[0]).length, 3);

    scenario.runs = [runRow('same-day-off-day', scenario.todayISO)];
    response = await invoke(generate, {
      body: { target: { weeks: 4, trainingDays: ['Tue', 'Wed', 'Thu', 'Sat'], runDaysPerWeek: 4, planMode: 'run_only', liftingEnabled: false } },
      query: {},
      user: { id: profile.id },
    });
    assert.equal(response.statusCode, 201, `off-day completion route must not return HTTP ${response.statusCode}: ${response.payload?.error || ''}`);
    assert.equal(runSessions(response.payload.plan.plan_data.weeks[0]).length, 3);

    scenario.runs = [0, 1, 2, 3, 4].map((index) => runRow(`quota-met-${index}`, scenario.todayISO));
    response = await invoke(generate, {
      body: { target: { weeks: 4, trainingDays: ['Mon', 'Tue', 'Thu', 'Sat'], runDaysPerWeek: 4, planMode: 'run_only', liftingEnabled: false } },
      query: {},
      user: { id: profile.id },
    });
    assert.equal(response.statusCode, 201, `completed quota route must not return HTTP ${response.statusCode}: ${response.payload?.error || ''}`);
    assert.equal(runSessions(response.payload.plan.plan_data.weeks[0]).length, 0);

    scenario.todayISO = '2026-07-24';
    scenario.runs = [];
    scenario.race = {
      id: 'partial-week-race',
      user_id: profile.id,
      race_name: 'Current-week race',
      race_date: '2026-07-26',
      distance_miles: 10,
      goal_time_seconds: null,
    };
    response = await invoke(generateForRace, {
      params: { raceId: scenario.race.id },
      body: { target: { trainingDays: ['Tue', 'Thu', 'Sat', 'Sun'], runDaysPerWeek: 4, planMode: 'run_only', liftingEnabled: false } },
      query: {},
      user: { id: profile.id },
    });
    assert.equal(response.statusCode, 201, `late-week race route must not return HTTP ${response.statusCode}: ${response.payload?.error || ''}`);
    assert.deepEqual(runSessions(response.payload.plan.plan_data.weeks[0]).map(({ day }) => day), ['Sat', 'Sun']);

    scenario.runs = [0, 1, 2, 3].map((index) => runRow(`race-week-quota-met-${index}`, scenario.todayISO));
    response = await invoke(generateForRace, {
      params: { raceId: scenario.race.id },
      body: { target: { trainingDays: ['Tue', 'Thu', 'Sat', 'Sun'], runDaysPerWeek: 4, planMode: 'run_only', liftingEnabled: false } },
      query: {},
      user: { id: profile.id },
    });
    assert.equal(response.statusCode, 201, `race-week completed quota must not return HTTP ${response.statusCode}: ${response.payload?.error || ''}`);
    const protectedRaceSessions = runSessions(response.payload.plan.plan_data.weeks[0]);
    assert.equal(protectedRaceSessions.length, 1);
    assert.equal(protectedRaceSessions[0].day, 'Sun');
    assert.equal(protectedRaceSessions[0].session.type, 'race');
    assert.equal(response.payload.plan.plan_data.weeks[0].currentWeekConstraint.protectedRaceBeyondQuota, true);
  } finally {
    global.Date = RealDate;
    delete require.cache[plansRoutePath];
    if (originalPlansRoute) require.cache[plansRoutePath] = originalPlansRoute;
    if (originalDb) require.cache[dbModulePath] = originalDb;
    else delete require.cache[dbModulePath];
  }
}

checkProfileReviewMarker()
  .then(checkPartialWeekRoutesDoNotReject)
  .then(() => console.log('RUN FREQUENCY AUTHORITY SMOKE OK'))
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
