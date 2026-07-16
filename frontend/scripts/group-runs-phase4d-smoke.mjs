import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { planSessionIdFromState } from '../src/lib/dailyExecutionCore.js'
import {
  canRestoreGroupRunNavigation,
  groupRunCompatibility,
  groupRunIdFromNavigationState,
  groupRunNavigationProvenance,
  groupRunWarmupState,
  isGroupRunNavigationState,
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
assert.equal(warmupState.source, 'group_run', 'group-run source should survive the warm-up handoff')
assert.equal(warmupState.groupRunId, matchingGroupRun.id, 'groupRunId should survive the warm-up handoff')
assert.equal(warmupState.planSessionId, null, 'group runs must carry an explicit null plan session id')
assert.equal(planSessionIdFromState(warmupState), null, 'explicit planSessionId:null must win over the synthetic scheduled-run id')
assert.equal('health' in warmupState, false, 'social run launch must not expose health evidence')
assert.equal('readiness' in warmupState, false, 'social run launch must not expose check-in evidence')

const redactedProvenance = groupRunNavigationProvenance(warmupState)
assert.deepEqual(redactedProvenance, {
  source: 'group_run',
  groupRunId: matchingGroupRun.id,
  planSessionId: null,
}, 'pending authorization should retain provenance without private route state')
assert.equal('plannedRoute' in redactedProvenance, false, 'pending authorization must not expose exact route coordinates')
assert.equal(groupRunIdFromNavigationState({ scheduledRun: warmupState.scheduledRun }), matchingGroupRun.id, 'legacy synthetic group-run state should migrate to explicit provenance')
assert.equal(isGroupRunNavigationState({ source: 'group_run', plannedRoute: matchingGroupRun.route }), true, 'malformed group-run provenance must still be recognized and fail closed')

assert.equal(canRestoreGroupRunNavigation(matchingGroupRun, matchingGroupRun.id, now), true, 'a current going member may restore private navigation')
assert.equal(canRestoreGroupRunNavigation({ ...matchingGroupRun, membership: { status: 'invited' } }, matchingGroupRun.id, now), false, 'an invitation alone cannot restore private navigation')
assert.equal(canRestoreGroupRunNavigation({ ...matchingGroupRun, status: 'cancelled' }, matchingGroupRun.id, now), false, 'a cancelled group run cannot restore private navigation')
assert.equal(canRestoreGroupRunNavigation(matchingGroupRun, matchingGroupRun.id, Date.parse('2026-07-15T21:00:00.000Z')), false, 'expired private navigation cannot be restored')
assert.equal(canRestoreGroupRunNavigation(matchingGroupRun, 'another-group-run', now), false, 'the detail response must match the requested group run')

const activeRunSource = readFileSync(new URL('../src/pages/ActiveRun.jsx', import.meta.url), 'utf8')
assert.match(activeRunSource, /api\.get\(`\/group-runs\/\$\{encodeURIComponent\(groupRunId\)\}`\)/, 'ActiveRun must reauthorize through group-run detail')
assert.match(activeRunSource, /if \(!canRestoreGroupRunNavigation\(groupRun, groupRunId\)\)/, 'ActiveRun must validate membership, cancellation, and expiry before authorizing state')
const authorizationGateIndex = activeRunSource.indexOf("if (groupRunAuthorization === 'authorized')")
const routeNormalizationIndex = activeRunSource.indexOf('normalizePlannedRoute(navigationState.plannedRoute)')
assert.ok(
  authorizationGateIndex >= 0 && routeNormalizationIndex >= 0 && authorizationGateIndex < routeNormalizationIndex,
  'the authorization gate must be established before planned route normalization',
)

console.log('Phase 4D group-run frontend smoke OK')
