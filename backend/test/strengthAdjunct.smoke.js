const assert = require('node:assert/strict');
const { EQUIPMENT, adjustStrengthForEquipment } = require('../src/lib/strengthAdjunct');

const fullGymSession = {
  id: 'strength-1',
  kind: 'lift',
  main: [
    { name: 'Barbell back squat', sets: 3, reps: 5 },
    { name: 'Dumbbell bench press', sets: 3, reps: 8 },
    { name: 'Lat pulldown', sets: 3, reps: 10 },
  ],
};
const fullGym = adjustStrengthForEquipment(fullGymSession, Object.values(EQUIPMENT));
assert.deepEqual(fullGym, fullGymSession);
assert.notStrictEqual(fullGym, fullGymSession);
assert.equal(Object.hasOwn(fullGym, 'adjustedForGear'), false);

const bodyweightOnly = adjustStrengthForEquipment(fullGymSession, []);
assert.equal(bodyweightOnly.adjustedForGear, true);
assert.equal(bodyweightOnly.gearAdjustmentNote, 'Adjusted for your gear.');
assert.equal(bodyweightOnly.substitutedMovements.length, fullGymSession.main.length);
assert.deepEqual(bodyweightOnly.main.map((movement) => movement.name), [
  'Tempo bodyweight squat',
  'Push-up',
  'Prone lat pulldown',
]);

const partialSession = {
  id: 'strength-2',
  kind: 'lift',
  exercises: [
    { name: 'Barbell back squat', sets: 3, reps: 5 },
    { name: 'Dumbbell bench press', sets: 3, reps: 8 },
    { name: 'Seated cable row', sets: 3, reps: 10 },
  ],
};
const partial = adjustStrengthForEquipment(partialSession, ['dumbbell', 'bench']);
assert.deepEqual(partial.exercises.map((movement) => movement.name), [
  'Goblet squat',
  'Dumbbell bench press',
  'One-arm dumbbell row',
]);
assert.deepEqual(partial.substitutedMovements.map((movement) => movement.from), [
  'Barbell back squat',
  'Seated cable row',
]);
assert.equal(partialSession.exercises[0].name, 'Barbell back squat');

console.log('strengthAdjunct smoke passed');
