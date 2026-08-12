const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const {
  buildCompletedWorkoutHistory,
  sameSubstantiveWorkout,
  selectDistinctRecommendation,
  workoutsWithinRecoveryWindow,
} = require('../src/lib/workoutRecommendationHistory');
const {
  resolvePlanDayForDate,
  trainingContextFromResolvedDay,
} = require('../src/lib/dailyExecution');

const now = new Date('2026-08-12T12:00:00.000Z');

const completedSessions = [
  {
    id: 'completed-yesterday',
    started_at: '2026-08-11T17:00:00.000Z',
    ended_at: '2026-08-11T18:00:00.000Z',
    muscle_groups: '["legs","core"]',
  },
  {
    id: 'unfinished-today',
    started_at: '2026-08-12T10:00:00.000Z',
    ended_at: null,
    muscle_groups: '["chest"]',
  },
];
const completedNames = [
  'Trap Bar Deadlift',
  'Rear-Foot-Elevated Split Squat',
  'Romanian Deadlift',
  'Low Box Jump',
  'Standing Calf Raise',
  'Pallof Press',
];
const sets = [
  ...completedNames.map((exercise_name, index) => ({
    session_id: 'completed-yesterday',
    exercise_name,
    muscle_group: index === completedNames.length - 1 ? 'core' : 'legs',
    set_number: 1,
  })),
  { session_id: 'unfinished-today', exercise_name: 'Bench Press', muscle_group: 'chest', set_number: 1 },
];

const history = buildCompletedWorkoutHistory(completedSessions, sets);
assert.equal(history.length, 1, 'only completed workouts belong in recommendation history');
assert.equal(history[0].id, 'completed-yesterday');
assert.deepEqual(history[0].exercises.map((exercise) => exercise.name), completedNames);

const renamedRepeat = {
  workoutName: 'A Totally Different Display Name',
  target: 'Athletic Strength',
  warmup: ['Easy movement'],
  main: completedNames.slice().reverse().map((name) => ({
    name,
    sets: 3,
    reps: '6-8',
    rest: '90s',
    focus: 'Strength',
    cue: 'Move well.',
  })),
  recovery: ['Easy walk'],
};

assert.equal(
  sameSubstantiveWorkout(renamedRepeat, history[0]),
  true,
  'stable exercise content, not display text, should identify an exact repeat',
);

const alternative = selectDistinctRecommendation({
  recommendation: renamedRepeat,
  recentCompletedWorkouts: history,
  todayRun: { type: 'tempo', target_zone: 'Zone 3', distance_miles: 5 },
  now,
});
assert.notStrictEqual(alternative, renamedRepeat, 'yesterday\'s completed workout should be excluded');
assert.equal(sameSubstantiveWorkout(alternative, history[0]), false, 'an alternative workout should be selected');
assert.doesNotMatch(String(alternative.target), /lower body|legs/i, 'a scheduled quality run should not receive a heavy lower-body alternative');
assert.doesNotMatch(
  alternative.main.map((item) => item.name).join(' '),
  /barbell|dumbbell|kettlebell|cable|machine|bench|box|band|pulldown|landmine/i,
  'the deterministic fallback must not invent unsupported equipment',
);

const unsupportedModelAlternative = {
  ...renamedRepeat,
  workoutName: 'Personalized Gym Alternative',
  target: 'Upper Body',
  main: renamedRepeat.main.map((item, index) => ({
    ...item,
    name: ['Dumbbell Row', 'Cable Pulldown', 'Machine Press', 'Landmine Press', 'Box Push-Up', 'Band Face Pull'][index],
  })),
};
const limitedEquipmentAlternative = selectDistinctRecommendation({
  recommendation: renamedRepeat,
  recommendations: [renamedRepeat, unsupportedModelAlternative],
  recentCompletedWorkouts: history,
  todayRun: { type: 'tempo' },
  availableEquipment: ['bodyweight'],
  now,
});
assert.doesNotMatch(
  limitedEquipmentAlternative.main.map((item) => item.name).join(' '),
  /dumbbell|cable|machine|landmine|box|band/i,
  'a model alternative requiring unavailable equipment must be rejected deterministically',
);

const sixWeekOldHistory = [{
  ...history[0],
  startedAt: '2026-07-01T17:00:00.000Z',
  endedAt: '2026-07-01T18:00:00.000Z',
}];
assert.equal(workoutsWithinRecoveryWindow(history, now).length, 1, 'yesterday is inside the immediate recovery window');
assert.equal(workoutsWithinRecoveryWindow(sixWeekOldHistory, now).length, 0, 'history older than 72 hours is outside repeat exclusion');
assert.strictEqual(
  selectDistinctRecommendation({ recommendation: renamedRepeat, recentCompletedWorkouts: sixWeekOldHistory, now }),
  renamedRepeat,
  'an exact workout older than 72 hours is allowed again',
);

const novelRecommendation = { ...renamedRepeat, main: [{ ...renamedRepeat.main[0], name: 'Novel Exercise' }] };
assert.strictEqual(
  selectDistinctRecommendation({ recommendation: novelRecommendation, recentCompletedWorkouts: [], todayRun: null }),
  novelRecommendation,
  'no recent completed history should preserve the prior recommendation behavior',
);
assert.strictEqual(
  selectDistinctRecommendation({ recommendation: novelRecommendation, recentCompletedWorkouts: null, todayRun: null }),
  novelRecommendation,
  'null history should be treated as empty history',
);

const overriddenPlan = {
  schemaVersion: 2,
  weeks: [{
    week: 1,
    phase: 'build',
    days: [{
      id: 'day-1',
      day: 'Wed',
      date: '2026-08-12',
      sessions: [{
        id: 'run-1',
        kind: 'run',
        type: 'recovery',
        workout_type: 'recovery',
        title: 'Recovery run',
        target_zone: 'Zone 1-2',
        steps: ['6 x 2 min hard hill repeats'],
      }],
    }],
  }],
};
const checkinPatch = {
  type: 'recovery',
  workout_type: 'recovery',
  title: 'Recovery session',
  target_zone: 'Zone 1-2',
  steps: ['Stay in Zone 1-2'],
  checkin_override: { action: 'recovery_swap', label: 'Swapped to recovery from daily check-in' },
};
const resolvedToday = resolvePlanDayForDate({
  plan: overriddenPlan,
  dateISO: '2026-08-12',
  patch: checkinPatch,
});
const aiTodayContext = trainingContextFromResolvedDay(resolvedToday, '2026-08-12');
assert.equal(aiTodayContext.run.type, 'recovery', 'AI context sees the check-in-swapped recovery truth');
assert.deepEqual(aiTodayContext.run.steps, ['Stay in Zone 1-2'], 'the raw hard prescription does not leak through the override');
assert.equal(aiTodayContext.checkinOverride.action, 'recovery_swap');

const repairedToday = resolvePlanDayForDate({ plan: overriddenPlan, dateISO: '2026-08-12' });
assert.deepEqual(
  trainingContextFromResolvedDay(repairedToday, '2026-08-12').run.steps,
  ['Stay in Zone 1-2', 'Keep breathing relaxed', 'Stop if soreness changes your stride'],
  'the same today resolver repairs contradictory recovery prescriptions before AI sees them',
);

const routeSource = readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
assert.match(routeSource, /workout_sessions WHERE user_id=\? AND ended_at IS NOT NULL/);
assert.match(routeSource, /FROM workout_sets wset[\s\S]*session\.ended_at IS NOT NULL/);
assert.match(routeSource, /buildCompletedWorkoutHistory\(recentSessions, recentSets\)/);
assert.match(routeSource, /todayRun: todayTraining\?\.run \|\| null/);
assert.match(routeSource, /resolvePlanDayForDate/);
assert.match(routeSource, /trainingContextFromResolvedDay/);
assert.match(routeSource, /!isPlanningDateAllowed\(req\.query\.date\)/, 'supplied dates use the planning-date boundary contract');
assert.match(routeSource, /normalizeStrengthRecommendation\(selectedRecommendation\)/, 'internal selection metadata is stripped before the response');

const plansRouteSource = readFileSync(path.join(__dirname, '../src/routes/plans.js'), 'utf8');
assert.match(plansRouteSource, /resolvePlanDayForDate/, 'canonical /plans/today and AI share the same day resolver');

const serviceSource = readFileSync(path.join(__dirname, '../src/services/ai.js'), 'utf8');
assert.match(serviceSource, /model: 'frequent'/, 'the qualitative recommendation should stay on the frequent provider tier');
assert.match(serviceSource, /Recent completed workouts with exercise content/);
assert.match(serviceSource, /Today's scheduled training/);

console.log('workout recommendation history smoke passed');
