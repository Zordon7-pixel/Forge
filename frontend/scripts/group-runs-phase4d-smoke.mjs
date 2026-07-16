import assert from 'node:assert/strict'
import {
  groupRunCompatibility,
  groupRunWarmupState,
  planRunSnapshot,
  upcomingGroupRun,
} from '../src/lib/groupRuns.js'

const now = Date.parse('2026-07-15T12:00:00.000Z')
const scheduledRun = {
  title: 'Easy aerobic run',
  type: 'easy',
  distance_miles: 4,
  target_zone: 'Zone 2',
}
const matchingGroupRun = {
  id: 'group-run-1',
  title: 'River easy run',
  starts_at: '2026-07-15T18:00:00.000Z',
  status: 'scheduled',
  duration_minutes: 50,
  run_type: 'easy',
  goal_mode: 'distance',
  target_distance_miles: 4.5,
  target_zone: 'Zone 2',
  pace_note: 'Conversational',
  meetup_area: 'River park',
  membership: { status: 'going' },
  route: {
    surface: 'trail',
    coordinates: [[38.9, -76.9], [38.91, -76.91]],
  },
}

assert.deepEqual(planRunSnapshot(scheduledRun), {
  run_type: 'easy',
  goal_mode: 'distance',
  target_distance_miles: 4,
  target_duration_minutes: null,
  pace_note: '',
  target_zone: 'Zone 2',
  workout_structure: '',
})

assert.equal(
  groupRunCompatibility(matchingGroupRun, { run: scheduledRun }).state,
  'match',
  'a group run within 20% of the plan distance should match',
)
assert.equal(
  groupRunCompatibility({ ...matchingGroupRun, target_distance_miles: 7 }, { run: scheduledRun }).state,
  'different',
  'a materially longer group run must not be presented as plan-compatible',
)

const selected = upcomingGroupRun([
  { ...matchingGroupRun, id: 'declined', membership: { status: 'declined' } },
  { ...matchingGroupRun, id: 'tomorrow', starts_at: '2026-07-16T08:00:00.000Z' },
  matchingGroupRun,
], now)
assert.equal(selected.id, matchingGroupRun.id, 'Today should show the nearest joined run only')

const warmupState = groupRunWarmupState(matchingGroupRun)
assert.equal(warmupState.startAfterWarmup, true)
assert.equal(warmupState.plannedRoute, matchingGroupRun.route)
assert.equal(warmupState.scheduledRun.id, 'group-run-group-run-1')
assert.equal('health' in warmupState, false, 'social run launch must not expose health evidence')
assert.equal('readiness' in warmupState, false, 'social run launch must not expose check-in evidence')

console.log('Phase 4D group-run frontend smoke OK')
