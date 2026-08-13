import assert from 'node:assert/strict'
import { combineRecentActivity, workoutActivityTitle } from '../src/lib/recentActivity.js'

const items = combineRecentActivity({
  runs: [{ id: 'run-1', date: '2026-08-10', distance_miles: 3.1 }],
  lifts: [{ id: 'lift-1', date: '2026-08-09', exercise_name: 'Bench press' }],
  workouts: [
    { id: 'active', started_at: '2026-08-12T10:00:00.000Z', ended_at: null },
    { id: 'workout-1', started_at: '2026-08-11T10:00:00.000Z', ended_at: '2026-08-11T10:45:00.000Z', notes: 'Lower-body strength' },
  ],
  otherActivities: [{ id: 'other-1', synced_at: '2026-08-08T10:00:00.000Z' }],
})

assert.deepEqual(items.map((item) => `${item._type}:${item.id}`), [
  'workout:workout-1',
  'run:run-1',
  'lift:lift-1',
  'other:other-1',
], 'completed workout sessions appear in chronological Recent Activity order alongside every legacy source')
assert.ok(!items.some((item) => item.id === 'active'), 'unfinished workout sessions never appear as completed Recent Activity')
assert.equal(workoutActivityTitle({ notes: 'Shoulder felt off', muscle_groups: ['Chest'] }), 'Chest', 'private free-text notes never replace the workout title')
assert.equal(workoutActivityTitle({ muscle_groups: ['Glutes', 'Hamstrings'] }), 'Glutes, Hamstrings', 'muscle groups title a workout when no saved name exists')
assert.equal(workoutActivityTitle({}), 'Strength workout', 'a completed workout without optional metadata still has a truthful title')

const balanced = combineRecentActivity({
  runs: [1, 2, 3, 4].map((id) => ({ id: `run-${id}`, date: '2026-08-12' })),
  workouts: [{ id: 'workout-2', started_at: '2026-08-12T06:00:00.000Z', ended_at: '2026-08-12T06:45:00.000Z' }],
})
assert.ok(balanced.some((item) => item.id === 'workout-2'), 'same-day runs cannot crowd a completed workout out of the four-card feed')

assert.doesNotThrow(() => combineRecentActivity({ runs: null, lifts: null, workouts: null, otherActivities: null }), 'malformed nullable source arrays fail soft')
assert.deepEqual(combineRecentActivity({ runs: [{ id: 'invalid-date', date: 'not-a-date' }] }), [{ id: 'invalid-date', date: 'not-a-date', _type: 'run' }], 'invalid timestamps sink safely without dropping truthful activity')

console.log('RECENT ACTIVITY SMOKE OK (8)')
