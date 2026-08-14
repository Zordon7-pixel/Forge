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

function runningMiles(week) {
  return Number(week.days.flatMap((day) => day.sessions)
    .filter((session) => session.kind === 'run' || session.includesRun === true)
    .reduce((sum, session) => sum + Number(session.distance_miles || 0), 0)
    .toFixed(1));
}

function assertHyroxRouteSafety(plan, planningDate, eventDate, label) {
  const entries = plan.weeks.flatMap((week) => week.days.flatMap((day) => (
    day.sessions.map((session) => ({ date: day.date, session }))
  )));
  assert.equal(entries.every(({ date }) => date >= planningDate), true, `${label}: no past sessions`);
  const races = entries.filter(({ session }) => session.sessionType === 'hyrox_race');
  assert.equal(races.length, 1, `${label}: exactly one race session`);
  assert.equal(races[0].date, eventDate, `${label}: exact race date`);
  const hardDates = [...new Set(entries.filter(({ session }) => session.hardLowerBody).map(({ date }) => date))].sort();
  for (const start of hardDates) {
    const rollingWindow = new Set(Array.from({ length: 7 }, (_, index) => engine.addDays(start, index)));
    assert.ok(hardDates.filter((date) => rollingWindow.has(date)).length <= 2, `${label}: rolling hard-lower-body cap`);
  }
  const protectedDates = new Set(Array.from({ length: 7 }, (_, index) => engine.addDays(eventDate, -index)));
  for (const { date, session } of entries) {
    if (!protectedDates.has(date) || session.sessionType === 'hyrox_race') continue;
    assert.equal(session.sessionType === 'hyrox_compromised', false, `${label}: no protected-window compromised session`);
    assert.equal(Boolean(session.heavyStationWork), false, `${label}: no protected-window heavy station`);
    assert.equal(['hard', 'long'].includes(session.runningStress), false, `${label}: no protected-window hard/long run`);
  }
}

function boundedMileageRows(weeklyMiles, recentMultiplier = 1) {
  const rows = [];
  for (let week = 0; week < 8; week += 1) {
    for (const offset of [1, 3, 6]) {
      rows.push({
        date: engine.addDays('2026-08-13', -(week * 7 + offset)),
        distance_miles: weeklyMiles / 3 * (week < 2 ? recentMultiplier : 1),
        duration_seconds: 3600,
      });
    }
  }
  return rows;
}

for (const scenario of [
  { profileWeeklyMiles: 40, historyWeeklyMiles: 32, recentMultiplier: 1 },
  { profileWeeklyMiles: 20, historyWeeklyMiles: 28, recentMultiplier: 1 },
  { profileWeeklyMiles: 45, historyWeeklyMiles: 36, recentMultiplier: 1.8 },
]) {
  const baseline = engine.estimateWeeklyMileageBaseline(
    boundedMileageRows(scenario.historyWeeklyMiles, scenario.recentMultiplier),
    { planningDateISO: '2026-08-13', profileWeeklyMiles: scenario.profileWeeklyMiles },
  );
  const boundedProfile = Math.min(
    Math.max(scenario.profileWeeklyMiles, baseline.longTermWeeklyMiles * 0.75),
    baseline.longTermWeeklyMiles * 1.25,
  );
  const preparedAnchor = Math.max(baseline.longTermWeeklyMiles, boundedProfile);
  const preparedUpperBound = Math.max(preparedAnchor * 1.25, preparedAnchor + 2);
  assert.equal(baseline.method, 'bounded_recent_history');
  assert.ok(baseline.weeklyMiles >= preparedAnchor - 0.1, 'recent history cannot accidentally collapse below its prepared anchor');
  assert.ok(baseline.weeklyMiles <= preparedUpperBound + 0.1, 'recent history cannot create an unbounded increase');
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

function hybridPartialWeekContext(completedStrengthSessions) {
  const planContext = partialWeekContext({
    todayISO: '2026-07-23',
    frequency: 4,
    trainingDays: ['Mon', 'Tue', 'Thu', 'Sat'],
  });
  return {
    ...planContext,
    profile: {
      ...planContext.profile,
      lift_days_per_week: 2,
    },
    history: {
      ...planContext.history,
      currentWeekStrength: {
        startDate: '2026-07-20',
        count: completedStrengthSessions,
        dates: completedStrengthSessions ? ['2026-07-21'] : [],
        loadPoints: completedStrengthSessions ? 45 : 0,
      },
    },
    target: {
      ...planContext.target,
      planMode: 'hybrid_maintain',
      liftingEnabled: true,
      liftDaysPerWeek: 2,
    },
  };
}

const authoritativeStrengthContext = hybridPartialWeekContext(1);
const authoritativeStrengthPlan = engine.buildConcurrentPlan(authoritativeStrengthContext);
delete authoritativeStrengthPlan.weeks[0].completedStrengthSessionsAtGeneration;
const authoritativeStrengthValidation = engine.validateConcurrentPlan(
  authoritativeStrengthPlan,
  authoritativeStrengthContext,
);
assert.equal(
  authoritativeStrengthValidation.valid,
  true,
  `authoritative current-week strength relaxes the floor without a candidate field: ${authoritativeStrengthValidation.errors.join('; ')}`,
);

const selfRelaxingStrengthContext = hybridPartialWeekContext(0);
const selfRelaxingStrengthPlan = engine.buildConcurrentPlan(selfRelaxingStrengthContext);
selfRelaxingStrengthPlan.weeks[0].completedStrengthSessionsAtGeneration = 99;
for (const day of selfRelaxingStrengthPlan.weeks[0].days) {
  day.sessions = day.sessions.filter((session) => session.kind !== 'lift');
  delete day.orderGuidance;
}
const selfRelaxingStrengthValidation = engine.validateConcurrentPlan(
  selfRelaxingStrengthPlan,
  selfRelaxingStrengthContext,
);
assert.equal(selfRelaxingStrengthValidation.valid, false);
assert.equal(
  selfRelaxingStrengthValidation.errors.some((error) => error.includes('below strength floor')),
  true,
  'candidate-supplied completion fields cannot lower the authoritative strength floor',
);

const mismatchedActivityContext = hybridPartialWeekContext(0);
mismatchedActivityContext.history.acuteRunLoad.currentWeek = {
  startDate: '2026-07-13',
  miles: 12,
  runCount: 3,
  runDates: ['2026-07-20', '2026-07-21'],
  longRunCompleted: true,
};
mismatchedActivityContext.history.currentWeekStrength = {
  startDate: '2026-07-13',
  count: 2,
  dates: ['2026-07-21'],
  loadPoints: 90,
};
const mismatchedActivityPlan = engine.buildConcurrentPlan(mismatchedActivityContext);
const mismatchedReconciliation = mismatchedActivityPlan.inputSummary.currentWeekActivityReconciliation;
assert.deepEqual(mismatchedReconciliation, {
  expectedStartDate: '2026-07-20',
  runSourceStartDate: '2026-07-13',
  strengthSourceStartDate: '2026-07-13',
  runMatch: false,
  strengthMatch: false,
  match: false,
  mismatch: true,
  reason: 'RUN_ACTIVITY_WEEK_START_MISMATCH,STRENGTH_ACTIVITY_WEEK_START_MISMATCH',
  reasons: ['RUN_ACTIVITY_WEEK_START_MISMATCH', 'STRENGTH_ACTIVITY_WEEK_START_MISMATCH'],
});
assert.equal(mismatchedActivityPlan.inputSummary.currentWeekRunLoad, null);
assert.equal(mismatchedActivityPlan.inputSummary.currentWeekStrengthLoad, null);
assert.equal(mismatchedActivityPlan.weeks[0].completedRunsAtGeneration, 0);
assert.equal(mismatchedActivityPlan.weeks[0].completedMilesAtGeneration, 0);
assert.equal(mismatchedActivityPlan.weeks[0].completedStrengthSessionsAtGeneration, 0);
assert.deepEqual(
  mismatchedActivityPlan.weeks[0].currentWeekConstraint.activityReconciliation,
  mismatchedReconciliation,
);
assert.equal(
  mismatchedActivityPlan.weeks[0].days.filter((day) => day.date < mismatchedActivityContext.todayISO)
    .every((day) => day.sessions.length === 0),
  true,
  'mismatched current-week sources fail safe without credit or past sessions',
);
const mismatchedActivityValidation = engine.validateConcurrentPlan(
  mismatchedActivityPlan,
  mismatchedActivityContext,
);
assert.equal(
  mismatchedActivityValidation.valid,
  true,
  `mismatched current-week activity remains a safe valid partial plan: ${mismatchedActivityValidation.errors.join('; ')}`,
);

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
  const today = new Date();
  const todayISO = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowISO = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
  const assignmentProgress = {
    'active-user-plan': { completedSessionIds: ['already-done'] },
    'pending-user-plan': { completedSessionIds: [] },
  };
  const visiblePlan = {
    user_plan_id: 'active-user-plan',
    plan_id: 'active-training-plan',
    id: 'active-training-plan',
    status: 'superseded',
    effective_from: todayISO,
    supersedes_user_plan_id: null,
  };
  const pendingPlan = {
    user_plan_id: 'pending-user-plan',
    plan_id: 'pending-training-plan',
    id: 'pending-training-plan',
    status: 'active',
    effective_from: tomorrowISO,
    supersedes_user_plan_id: 'active-user-plan',
  };
  const tx = {
    get: async (sql, params = []) => {
      if (sql.includes('SELECT run_days_per_week, preferred_workout_days FROM users')) {
        return {
          run_days_per_week: user.run_days_per_week,
          preferred_workout_days: user.preferred_workout_days,
        };
      }
      if (sql.includes('FROM user_plans up')) {
        const assignment = sql.includes('up.id=?') && params[0] === 'active-user-plan'
          ? visiblePlan
          : pendingPlan;
        return {
          ...assignment,
          progress_json: JSON.stringify(assignmentProgress[assignment.user_plan_id]),
        };
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
        assignmentProgress[params[1]] = JSON.parse(params[0]);
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
    withPlanningInputMutation: async (_userId, fn) => fn(tx),
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
    const blankMileage = await invoke(handler, {
      body: { weekly_miles_current: ' ' },
      user: { id: user.id },
    });
    assert.equal(blankMileage.statusCode, 400);
    assert.match(blankMileage.payload.error, /Weekly miles must be between 0 and 300/);

    const invalidMileage = await invoke(handler, {
      body: { weekly_miles_current: 'Infinity' },
      user: { id: user.id },
    });
    assert.equal(invalidMileage.statusCode, 400);
    assert.match(invalidMileage.payload.error, /Weekly miles must be between 0 and 300/);

    const response = await invoke(handler, {
      body: {
        run_days_per_week: 5,
        preferred_workout_days: ['Mon', 'Tue', 'Wed', 'Thu', 'Sat'],
      },
      headers: { 'x-forged-local-date': todayISO },
      user: { id: user.id },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(user.run_days_per_week, 5);
    assert.deepEqual(JSON.parse(user.preferred_workout_days), ['Mon', 'Tue', 'Wed', 'Thu', 'Sat']);
    assert.deepEqual(assignmentProgress['active-user-plan'].completedSessionIds, ['already-done']);
    assert.equal(assignmentProgress['active-user-plan'].planReviewRequired.reason, 'run_frequency_changed');
    assert.equal(assignmentProgress['active-user-plan'].planReviewRequired.previousRunDaysPerWeek, 3);
    assert.equal(assignmentProgress['active-user-plan'].planReviewRequired.requestedRunDaysPerWeek, 5);
    assert.equal(
      assignmentProgress['pending-user-plan'].planReviewRequired.reason,
      'run_frequency_changed',
      'a pending replacement retains the review marker after its effective-date cutover'
    );
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
    workouts: [],
    lifts: [],
    race: null,
  };
  let storedCandidate = null;
  let persistedTrainingPlan = null;

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
      if (sql.includes('FROM plan_generation_candidates WHERE id=? AND user_id=? FOR UPDATE')) {
        return storedCandidate?.id === params[0] && storedCandidate?.user_id === params[1]
          ? { ...storedCandidate }
          : null;
      }
      if (/FROM users WHERE id\s*=\s*\?/.test(sql)) return params[0] === profile.id ? { ...profile } : null;
      if (/FROM race_events WHERE id\s*=\s*\? AND user_id\s*=\s*\?/.test(sql)) {
        return scenario.race?.id === params[0] && profile.id === params[1] ? { ...scenario.race } : null;
      }
      return null;
    },
    dbAll: async (sql) => {
      if (sql.includes('FROM runs')) return scenario.runs.map((run) => ({ ...run }));
      if (sql.includes('FROM workout_sessions')) return scenario.workouts.map((workout) => ({ ...workout }));
      if (sql.includes('FROM lifts')) return scenario.lifts.map((lift) => ({ ...lift }));
      return [];
    },
    dbRun: async (sql, params = []) => {
      if (sql.includes('INSERT INTO plan_generation_candidates')) {
        storedCandidate = {
          id: params[0],
          user_id: params[1],
          status: params[2],
          training_plan_id: params[3],
          user_plan_id: params[4],
          active_plan_version: params[5],
          planning_input_revision: params[6],
          planning_date_local: params[7],
          timezone_offset_minutes: params[8],
          input_hash: params[9],
          candidate_hash: params[10],
          engine_version: params[11],
          policy_version: params[12],
          invariant_version: params[13],
          planning_snapshot_json: params[14],
          candidate_plan_json: params[15],
          generation_trace_json: params[16],
          expires_at: params[17],
        };
      }
      if (sql.includes('INSERT INTO training_plans')) {
        persistedTrainingPlan = {
          id: params[0],
          user_id: params[1],
          week_start: params[2],
          plan_json: params[3],
          plan_data: params[8],
        };
      }
      if (sql.includes("UPDATE plan_generation_candidates\n       SET status='applied'") && storedCandidate) {
        storedCandidate.status = 'applied';
      }
      return { changes: 1 };
    },
  };
  const tx = {
    get: (sql, params = []) => mockDb.dbGet(sql, params),
    all: (sql, params = []) => mockDb.dbAll(sql, params),
    run: (sql, params = []) => mockDb.dbRun(sql, params),
  };
  mockDb.withUserMutation = async (_userId, fn) => fn(tx);
  mockDb.withPlanningInputMutation = async (_userId, fn) => fn(tx);

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
    const applyCandidate = routeHandler(plansRouter, '/candidates/:candidateId/apply', 'post');

    scenario.runs = [runRow('same-day-selected', scenario.todayISO)];
    let response = await invoke(generate, {
      body: { planning_date_local: scenario.todayISO, timezone_offset_minutes: 0, target: { weeks: 4, trainingDays: ['Mon', 'Tue', 'Thu', 'Sat'], runDaysPerWeek: 4, planMode: 'run_only', liftingEnabled: false } },
      query: {},
      user: { id: profile.id },
    });
    assert.equal(response.statusCode, 201, `Monday same-day route must not return HTTP ${response.statusCode}: ${response.payload?.error || ''} ${JSON.stringify(response.payload?.details || [])}`);
    assert.equal(runSessions(response.payload.plan.plan_data.weeks[0]).length, 3);

    scenario.runs = [runRow('same-day-off-day', scenario.todayISO)];
    response = await invoke(generate, {
      body: { planning_date_local: scenario.todayISO, timezone_offset_minutes: 0, target: { weeks: 4, trainingDays: ['Tue', 'Wed', 'Thu', 'Sat'], runDaysPerWeek: 4, planMode: 'run_only', liftingEnabled: false } },
      query: {},
      user: { id: profile.id },
    });
    assert.equal(response.statusCode, 201, `off-day completion route must not return HTTP ${response.statusCode}: ${response.payload?.error || ''}`);
    assert.equal(runSessions(response.payload.plan.plan_data.weeks[0]).length, 3);

    scenario.todayISO = '2026-08-13';
    profile.weekly_miles_current = 40;
    scenario.runs = [];
    scenario.workouts = [];
    scenario.lifts = [];
    const allTrainingDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    response = await invoke(generate, {
      body: {
        planning_date_local: scenario.todayISO,
        timezone_offset_minutes: 0,
        target: {
          weeks: 4,
          trainingDays: allTrainingDays,
          runDaysPerWeek: 4,
          planMode: 'run_only',
          liftingEnabled: false,
        },
      },
      query: {},
      user: { id: profile.id },
    });
    assert.equal(response.statusCode, 201, `zero-activity Thursday plan must not return HTTP ${response.statusCode}: ${response.payload?.error || ''}`);
    const zeroActivityPlan = response.payload.plan.plan_data;
    assert.equal(zeroActivityPlan.weeks[0].startDate, '2026-08-10');
    assert.equal(zeroActivityPlan.weeks[1].startDate, '2026-08-17');
    assert.equal(
      zeroActivityPlan.weeks[0].days.filter((day) => day.date < scenario.todayISO)
        .every((day) => day.sessions.length === 0),
      true,
      'zero-activity Thursday creation never schedules Monday-Wednesday',
    );
    assert.ok(
      zeroActivityPlan.weeks[0].totalMiles <= zeroActivityPlan.weeks[1].totalMiles,
      'zero-activity partial current week does not exceed the next full week',
    );

    const hyroxRace = {
      id: 'current-week-hyrox',
      user_id: profile.id,
      race_name: 'HYROX New York',
      race_date: '2026-10-18',
      distance_miles: 4.97,
      goal_time_seconds: null,
      event_kind: 'hyrox',
      event_local_date: '2026-10-18',
      event_timezone: 'America/New_York',
      event_format: 'individual_open',
      event_category: 'men',
      rules_version: '2026-2027',
      event_config_json: JSON.stringify({ equipment: [] }),
    };
    scenario.race = hyroxRace;
    response = await invoke(generateForRace, {
      params: { raceId: scenario.race.id },
      body: {
        planning_date_local: scenario.todayISO,
        timezone_offset_minutes: 0,
        target: {
          trainingDays: allTrainingDays,
          runDaysPerWeek: 4,
          planMode: 'hyrox_build',
          liftingEnabled: true,
        },
      },
      query: {},
      user: { id: profile.id },
    });
    assert.equal(response.statusCode, 201, `zero-activity HYROX preview must not return HTTP ${response.statusCode}: ${response.payload?.error || ''} ${JSON.stringify(response.payload?.details || [])}`);
    const zeroActivityHyroxPlan = response.payload.plan.plan_data;
    assert.equal(zeroActivityHyroxPlan.weeks[0].startDate, '2026-08-10');
    assert.equal(zeroActivityHyroxPlan.weeks[1].startDate, '2026-08-17');
    assert.equal(zeroActivityHyroxPlan.weeks[0].currentWeekConstraint.completedRunCount, 0);
    assert.equal(zeroActivityHyroxPlan.weeks[0].currentWeekConstraint.completedStrengthSessions, 0);
    assert.ok(
      runningMiles(zeroActivityHyroxPlan.weeks[0]) <= runningMiles(zeroActivityHyroxPlan.weeks[1]),
      'zero-activity HYROX partial load does not exceed the next full week',
    );
    assert.equal(
      zeroActivityHyroxPlan.weeks[0].days.filter((day) => day.date < scenario.todayISO)
        .every((day) => day.sessions.length === 0),
      true,
    );
    const zeroPreviewDates = zeroActivityHyroxPlan.weeks.map((week) => (
      week.days.map((day) => ({ date: day.date, sessionIds: day.sessions.map((session) => session.id) }))
    ));
    const zeroApplyResponse = await invoke(applyCandidate, {
      params: { candidateId: response.payload.candidate_id },
      body: {
        candidate_hash: response.payload.candidate_hash,
        choice: 'train_for_target',
        planning_date_local: scenario.todayISO,
        timezone_offset_minutes: 0,
      },
      query: {},
      user: { id: profile.id },
    });
    assert.equal(zeroApplyResponse.statusCode, 200, `zero-activity HYROX apply must not return HTTP ${zeroApplyResponse.statusCode}: ${zeroApplyResponse.payload?.error || ''}`);
    assert.equal(persistedTrainingPlan.week_start, '2026-08-10');
    assert.deepEqual(
      JSON.parse(persistedTrainingPlan.plan_data).weeks.map((week) => (
        week.days.map((day) => ({ date: day.date, sessionIds: day.sessions.map((session) => session.id) }))
      )),
      zeroPreviewDates,
      'zero-activity HYROX apply preserves preview dates and session identities',
    );

    scenario.race = null;
    scenario.runs = [runRow('completed-current-week-run', '2026-08-11')];
    scenario.runs[0].distance_miles = 6;
    scenario.workouts = [];
    scenario.lifts = Array.from({ length: 6 }, (_, index) => ({
      id: `legacy-exercise-${index + 1}`,
      date: '2026-08-12',
      workout_duration_seconds: null,
    }));
    const completedActivityTarget = {
      weeks: 4,
      trainingDays: allTrainingDays,
      runDaysPerWeek: 3,
      liftDaysPerWeek: 2,
      planMode: 'hybrid_maintain',
      liftingEnabled: true,
    };
    response = await invoke(generate, {
      body: {
        planning_date_local: scenario.todayISO,
        timezone_offset_minutes: 0,
        target: completedActivityTarget,
      },
      query: {},
      user: { id: profile.id },
    });
    assert.equal(response.statusCode, 201, `legacy strength dedupe route must not return HTTP ${response.statusCode}: ${response.payload?.error || ''}`);
    assert.equal(response.payload.plan.plan_data.weeks[0].completedStrengthSessionsAtGeneration, 1);
    assert.deepEqual(
      response.payload.plan.plan_data.inputSummary.currentWeekStrengthLoad.provenance,
      {
        dedupePolicy: 'workout_session_else_calendar_date',
        workoutSessionRows: 0,
        legacyLiftRows: 6,
        completedStrengthExposures: 1,
        sources: ['lifts'],
      },
      'six legacy exercise rows on one date are one completed strength exposure',
    );

    scenario.workouts = [{
      id: 'completed-current-week-workout',
      started_at: '2026-08-12T17:00:00.000Z',
      ended_at: '2026-08-12T17:45:00.000Z',
      total_seconds: 2700,
    }];
    scenario.lifts = [{
      id: 'same-date-imported-lift',
      date: '2026-08-12',
      workout_duration_seconds: 2700,
    }];
    response = await invoke(generate, {
      body: {
        planning_date_local: scenario.todayISO,
        timezone_offset_minutes: 0,
        target: completedActivityTarget,
      },
      query: {},
      user: { id: profile.id },
    });
    assert.equal(response.statusCode, 201, `Thursday current-week route must not return HTTP ${response.statusCode}: ${response.payload?.error || ''} ${JSON.stringify(response.payload?.details || [])}`);
    const currentWeekPlan = response.payload.plan.plan_data;
    assert.equal(currentWeekPlan.weeks[0].startDate, '2026-08-10');
    assert.equal(currentWeekPlan.weeks[1].startDate, '2026-08-17');
    assert.equal(
      currentWeekPlan.weeks[0].days.filter((day) => day.date < scenario.todayISO)
        .every((day) => day.sessions.length === 0),
      true,
      'the new plan must not replace completed Monday-Wednesday history',
    );
    assert.equal(currentWeekPlan.weeks[0].completedRunsAtGeneration, 1);
    assert.equal(currentWeekPlan.weeks[0].completedStrengthSessionsAtGeneration, 1);
    assert.deepEqual(
      currentWeekPlan.inputSummary.currentWeekStrengthLoad.provenance,
      {
        dedupePolicy: 'workout_session_else_calendar_date',
        workoutSessionRows: 1,
        legacyLiftRows: 1,
        completedStrengthExposures: 1,
        sources: ['lifts', 'workout_sessions'],
      },
      'same-date workout and imported lift remain one completed strength exposure',
    );
    assert.ok(
      currentWeekPlan.weeks[0].days.flatMap((day) => day.sessions)
        .filter((session) => session.kind === 'run').length <= 2,
      'the completed run reduces the remaining run quota',
    );
    assert.ok(
      currentWeekPlan.weeks[0].days.flatMap((day) => day.sessions)
        .filter((session) => session.kind === 'lift').length <= 1,
      'the completed workout reduces the remaining lift quota',
    );
    assert.ok(
      currentWeekPlan.weeks[0].totalMiles < currentWeekPlan.weeks[1].totalMiles,
      'current-week completed mileage bounds the remaining scheduled mileage',
    );

    scenario.race = hyroxRace;
    response = await invoke(generateForRace, {
      params: { raceId: scenario.race.id },
      body: {
        planning_date_local: scenario.todayISO,
        timezone_offset_minutes: 0,
        target: {
          trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
          runDaysPerWeek: 3,
          planMode: 'hyrox_build',
          liftingEnabled: true,
        },
      },
      query: {},
      user: { id: profile.id },
    });
    assert.equal(response.statusCode, 201, `Thursday HYROX preview must not return HTTP ${response.statusCode}: ${response.payload?.error || ''} ${JSON.stringify(response.payload?.details || [])}`);
    const hyroxPlan = response.payload.plan.plan_data;
    assert.equal(hyroxPlan.weeks[0].startDate, '2026-08-10');
    assert.equal(hyroxPlan.weeks[1].startDate, '2026-08-17');
    assert.equal(hyroxPlan.weeks[0].currentWeekConstraint.completedRunCount, 1);
    assert.equal(hyroxPlan.weeks[0].currentWeekConstraint.completedStrengthSessions, 1);
    assert.equal(hyroxPlan.inputSummary.currentWeekStrengthLoad.provenance.completedStrengthExposures, 1);
    assert.equal(
      hyroxPlan.inputSummary.weeklyMileageBaseline,
      currentWeekPlan.inputSummary.weeklyMileageBaseline,
      'the HYROX route consumes the same prepared recent-history baseline as the non-HYROX planner',
    );
    assert.notEqual(
      hyroxPlan.inputSummary.weeklyMileageBaseline,
      profile.weekly_miles_current,
      'route-prepared recent history remains authoritative over contradictory profile mileage',
    );
    assert.equal(
      hyroxPlan.weeks[0].days.filter((day) => day.date < scenario.todayISO)
        .every((day) => day.sessions.length === 0),
      true,
      'HYROX preview keeps recorded current-week history immutable',
    );
    const previewDates = hyroxPlan.weeks.map((week) => (
      week.days.map((day) => ({ date: day.date, sessionIds: day.sessions.map((session) => session.id) }))
    ));
    const applyResponse = await invoke(applyCandidate, {
      params: { candidateId: response.payload.candidate_id },
      body: {
        candidate_hash: response.payload.candidate_hash,
        choice: 'train_for_target',
        planning_date_local: scenario.todayISO,
        timezone_offset_minutes: 0,
      },
      query: {},
      user: { id: profile.id },
    });
    assert.equal(applyResponse.statusCode, 200, `HYROX apply must not return HTTP ${applyResponse.statusCode}: ${applyResponse.payload?.error || ''}`);
    assert.equal(persistedTrainingPlan.week_start, '2026-08-10');
    const appliedPlan = JSON.parse(persistedTrainingPlan.plan_data);
    assert.deepEqual(
      appliedPlan.weeks.map((week) => (
        week.days.map((day) => ({ date: day.date, sessionIds: day.sessions.map((session) => session.id) }))
      )),
      previewDates,
      'HYROX apply persists the exact preview dates and sessions',
    );

    scenario.runs = [];
    scenario.workouts = [];
    scenario.lifts = [];
    const consecutiveSchedules = [
      ['Mon', 'Tue', 'Wed'],
      ['Tue', 'Wed', 'Thu'],
      ['Wed', 'Thu', 'Fri'],
      ['Fri', 'Sat', 'Sun'],
      ['Sat', 'Sun', 'Mon'],
    ];
    const representativeEventDates = ['2026-08-31', '2026-09-20', '2026-10-10'];
    for (const trainingDays of consecutiveSchedules) {
      for (const eventLocalDate of representativeEventDates) {
        scenario.race = {
          ...hyroxRace,
          race_date: eventLocalDate,
          event_local_date: eventLocalDate,
        };
        response = await invoke(generateForRace, {
          params: { raceId: scenario.race.id },
          body: {
            planning_date_local: scenario.todayISO,
            timezone_offset_minutes: 0,
            target: {
              trainingDays,
              runDaysPerWeek: 3,
              planMode: 'hyrox_build',
              liftingEnabled: true,
            },
          },
          query: {},
          user: { id: profile.id },
        });
        assert.equal(
          response.statusCode,
          201,
          `${trainingDays.join('/')}/${eventLocalDate} must not return HTTP ${response.statusCode}: ${response.payload?.error || ''} ${JSON.stringify(response.payload?.details || [])}`,
        );
      }
    }

    const routePlanningDates = Array.from({ length: 7 }, (_, index) => engine.addDays('2026-08-10', index));
    const routeEventDates = [
      '2026-09-04',
      ...Array.from({ length: 7 }, (_, index) => engine.addDays('2026-10-19', index)),
    ];
    const routeSchedules = [
      { trainingDays: allTrainingDays, runDaysPerWeek: 4 },
      { trainingDays: ['Tue', 'Thu', 'Sat', 'Sun'], runDaysPerWeek: 4 },
      { trainingDays: ['Fri', 'Sat', 'Sun'], runDaysPerWeek: 3 },
    ];
    for (const planningDate of routePlanningDates) {
      scenario.todayISO = planningDate;
      for (const eventLocalDate of routeEventDates) {
        scenario.race = {
          ...hyroxRace,
          race_date: eventLocalDate,
          event_local_date: eventLocalDate,
        };
        for (const weeklyMilesCurrent of [20, 40, 45]) {
          profile.weekly_miles_current = weeklyMilesCurrent;
          for (const { trainingDays, runDaysPerWeek } of routeSchedules) {
            response = await invoke(generateForRace, {
              params: { raceId: scenario.race.id },
              body: {
                planning_date_local: planningDate,
                timezone_offset_minutes: 0,
                target: {
                  trainingDays,
                  runDaysPerWeek,
                  planMode: 'hyrox_build',
                  liftingEnabled: true,
                },
              },
              query: {},
              user: { id: profile.id },
            });
            const label = `${planningDate}/${eventLocalDate}/${weeklyMilesCurrent}/${trainingDays.join('/')}`;
            assert.equal(
              response.statusCode,
              201,
              `${label} must not return HTTP ${response.statusCode}: ${response.payload?.error || ''} ${JSON.stringify(response.payload?.details || [])}`,
            );
            const routePlan = response.payload.plan.plan_data;
            assert.equal(routePlan.weeks[0].startDate, '2026-08-10', `${label}: Monday anchor`);
            assert.equal(routePlan.weeks[1].startDate, '2026-08-17', `${label}: Week 2 next Monday`);
            assertHyroxRouteSafety(routePlan, planningDate, eventLocalDate, label);
          }
        }
      }
    }
    scenario.todayISO = '2026-08-13';
    profile.weekly_miles_current = 40;

    scenario.runs = [0, 1, 2, 3, 4].map((index) => runRow(`quota-met-${index}`, scenario.todayISO));
    scenario.workouts = [];
    scenario.lifts = [];
    scenario.race = null;
    response = await invoke(generate, {
      body: { planning_date_local: scenario.todayISO, timezone_offset_minutes: 0, target: { weeks: 4, trainingDays: ['Mon', 'Tue', 'Thu', 'Sat'], runDaysPerWeek: 4, planMode: 'run_only', liftingEnabled: false } },
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
      body: { planning_date_local: scenario.todayISO, timezone_offset_minutes: 0, target: { trainingDays: ['Tue', 'Thu', 'Sat', 'Sun'], runDaysPerWeek: 4, planMode: 'run_only', liftingEnabled: false } },
      query: {},
      user: { id: profile.id },
    });
    assert.equal(response.statusCode, 201, `late-week race route must not return HTTP ${response.statusCode}: ${response.payload?.error || ''}`);
    assert.deepEqual(runSessions(response.payload.plan.plan_data.weeks[0]).map(({ day }) => day), ['Sat', 'Sun']);

    scenario.runs = [0, 1, 2, 3].map((index) => runRow(`race-week-quota-met-${index}`, scenario.todayISO));
    response = await invoke(generateForRace, {
      params: { raceId: scenario.race.id },
      body: { planning_date_local: scenario.todayISO, timezone_offset_minutes: 0, target: { trainingDays: ['Tue', 'Thu', 'Sat', 'Sun'], runDaysPerWeek: 4, planMode: 'run_only', liftingEnabled: false } },
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
