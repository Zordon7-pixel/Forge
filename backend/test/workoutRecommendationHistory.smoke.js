const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const {
  buildCompletedWorkoutHistory,
  sameSubstantiveWorkout,
  selectDistinctRecommendation,
} = require('../src/lib/workoutRecommendationHistory');

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
});
assert.notStrictEqual(alternative, renamedRepeat, 'yesterday\'s completed workout should be excluded');
assert.equal(sameSubstantiveWorkout(alternative, history[0]), false, 'an alternative workout should be selected');
assert.doesNotMatch(String(alternative.target), /lower body|legs/i, 'a scheduled quality run should not receive a heavy lower-body alternative');

const novelRecommendation = { ...renamedRepeat, main: [{ ...renamedRepeat.main[0], name: 'Novel Exercise' }] };
assert.strictEqual(
  selectDistinctRecommendation({ recommendation: novelRecommendation, recentCompletedWorkouts: [], todayRun: null }),
  novelRecommendation,
  'no recent completed history should preserve the prior recommendation behavior',
);

const routeSource = readFileSync(path.join(__dirname, '../src/routes/ai.js'), 'utf8');
assert.match(routeSource, /workout_sessions WHERE user_id=\? AND ended_at IS NOT NULL/);
assert.match(routeSource, /FROM workout_sets wset[\s\S]*session\.ended_at IS NOT NULL/);
assert.match(routeSource, /buildCompletedWorkoutHistory\(recentSessions, recentSets\)/);
assert.match(routeSource, /todayRun: todayTraining\?\.run \|\| null/);

const serviceSource = readFileSync(path.join(__dirname, '../src/services/ai.js'), 'utf8');
assert.match(serviceSource, /model: 'frequent'/, 'the qualitative recommendation should stay on the frequent provider tier');
assert.match(serviceSource, /Recent completed workouts with exercise content/);
assert.match(serviceSource, /Today's scheduled training/);

console.log('workout recommendation history smoke passed');
