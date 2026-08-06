const assert = require('node:assert/strict');
const engine = require('../src/lib/concurrentPlan');

const context = {
  todayISO: '2026-08-06',
  profile: {
    weekly_miles_current: 22,
    run_days_per_week: 4,
    lift_days_per_week: 2,
  },
  target: {
    raceDate: '2026-10-11',
    raceName: 'Army Ten-Miler',
    distanceMiles: 10,
    goalTimeSeconds: 5400,
    weeks: 10,
    startDate: '2026-08-03',
    trainingDays: ['Mon', 'Thu', 'Sat', 'Sun'],
    runDaysPerWeek: 4,
    runDaysSource: 'target',
    trainingDaysSource: 'target',
    planMode: 'hybrid_maintain',
    liftingEnabled: true,
    liftDaysPerWeek: 2,
    strengthGoal: 'maintain',
  },
  history: {
    weeklyMileageBaseline: 22,
    recentRunCount: 8,
    recentLiftCount: 4,
    performanceProfile: {},
    acuteRunLoad: {},
  },
  recovery: { state: 'green' },
};
const plan = engine.buildConcurrentPlan(context);

assert.equal(plan.schedulePreferences.runDaysPerWeek, 4);
assert.deepEqual(plan.schedulePreferences.trainingDays, ['Mon', 'Thu', 'Sat', 'Sun']);

const representativeWeek = plan.weeks.find((week) => ['base', 'build'].includes(week.phase) && !week.currentWeekConstraint);
assert(representativeWeek, 'a full representative week must exist');
const sessions = representativeWeek.days.flatMap((day) => day.sessions || []);
const runs = sessions.filter((session) => session.kind === 'run');
const lifts = sessions.filter((session) => session.kind === 'lift');

assert.equal(runs.length, 4, 'four selected run days must produce four weekly runs');
assert.equal(runs.some((session) => ['benchmark', 'quality', 'hills', 'threshold', 'race_pace'].includes(session.type)), true, 'the week must contain controlled quality work');
assert.equal(runs.some((session) => session.type === 'easy'), true, 'the week must contain an easy run');
assert.equal(runs.some((session) => session.type === 'steady'), true, 'the week must contain a steady aerobic run');
assert.equal(runs.some((session) => session.type === 'long'), true, 'the week must contain a long run');
assert.equal(runs.every((session) => Array.isArray(session.warmup) && session.warmup.length > 0), true, 'every run must explain its warm-up');
assert.equal(runs.every((session) => Array.isArray(session.steps) && session.steps.length > 0), true, 'every run must explain its structure');
assert.equal(runs.every((session) => Array.isArray(session.cooldown) && session.cooldown.length > 0), true, 'every run must explain its cool-down');
assert.equal(runs.every((session) => String(session.description || '').trim().length > 0), true, 'every run must explain its purpose');
assert.equal(lifts.length, 2, 'hybrid maintenance must preserve two weekly lifts');
assert.equal(lifts.every((session) => Array.isArray(session.main) && session.main.length > 0), true, 'strength sessions must contain exercises');
assert.equal(lifts.every((session) => session.main.every((exercise) => exercise.sets && exercise.reps && exercise.rest)), true, 'each strength exercise must include sets, reps, and rest');
assert.equal(engine.validateConcurrentPlan(plan, context).valid, true, 'the informative plan must remain schema-valid');

console.log('PLAN INFORMATION DEPTH SMOKE OK (16 assertions)');
