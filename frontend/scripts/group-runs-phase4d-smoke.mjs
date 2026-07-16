import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { planSessionIdFromState } from '../src/lib/dailyExecutionCore.js'
import {
  canRestoreGroupRunNavigation,
  groupRunCompatibility,
  groupRunCountdown,
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
  pace_target: 'Conversational',
  structure: ['20 minutes easy with relaxed form'],
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
  workout_structure: '20 minutes easy with relaxed form',
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
  pace_note: 'Conversational',
  target_zone: 'Zone 2',
  workout_structure: '20 minutes easy with relaxed form',
})

assert.equal(
  groupRunCompatibility(matchingGroupRun, { run: scheduledRun }).state,
  'match',
  'a group run within 20% of the plan distance should match',
)
assert.equal(
  groupRunCompatibility({ ...matchingGroupRun, workout_structure: '' }, { run: scheduledRun }).state,
  'partial',
  'missing prescribed detail must not be presented as a categorical match',
)
assert.equal(
  groupRunCompatibility({ ...matchingGroupRun, target_distance_miles: 7 }, { run: scheduledRun }).state,
  'different',
  'a materially longer group run must not be presented as plan-compatible',
)
assert.equal(
  groupRunCompatibility({ ...matchingGroupRun, run_type: 'intervals' }, { run: scheduledRun }).state,
  'different',
  'matching distance alone must not hide a different run type',
)
assert.equal(
  groupRunCompatibility({ ...matchingGroupRun, target_zone: 'Zone 4' }, { run: scheduledRun }).state,
  'different',
  'explicitly different zones must not be presented as compatible',
)
assert.deepEqual(
  groupRunCompatibility(matchingGroupRun, { run: null }),
  { state: 'none', labelKey: 'groupRuns.noScheduledRun' },
  'a rest day must not be mislabeled as a successful compatibility check',
)
assert.equal(groupRunCountdown({ ...matchingGroupRun, status: 'cancelled' }, now), 'Cancelled')
assert.equal(groupRunCountdown({ ...matchingGroupRun, status: 'completed' }, now), 'Completed')

const selected = upcomingGroupRun([
  { ...matchingGroupRun, id: 'declined', membership: { status: 'declined' } },
  { ...matchingGroupRun, id: 'muted', membership: { status: 'going', muted: true } },
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
assert.match(activeRunSource, /setInterval\(verifyAccess, 60_000\)/, 'ActiveRun must periodically revalidate private group-run access')
assert.match(activeRunSource, /visibilitychange/, 'ActiveRun must revalidate private group-run access when the app becomes visible')
assert.match(activeRunSource, /hidePrivateNavigation\(\)/, 'ActiveRun must fail closed when private access cannot be verified')
const authorizationGateIndex = activeRunSource.indexOf("if (groupRunAuthorization === 'authorized')")
const routeNormalizationIndex = activeRunSource.indexOf('normalizePlannedRoute(navigationState.plannedRoute)')
assert.ok(
  authorizationGateIndex >= 0 && routeNormalizationIndex >= 0 && authorizationGateIndex < routeNormalizationIndex,
  'the authorization gate must be established before planned route normalization',
)

const panelSource = readFileSync(new URL('../src/components/GroupRunPanel.jsx', import.meta.url), 'utf8')
assert.match(panelSource, /detailRefreshRequestRef\.current !== refreshRequestId/, 'overlapping detail refreshes must not let an older private response win')
assert.match(panelSource, /detailRefreshRequestRef\.current !== detailRequestId/, 'an older detail-open response must not overwrite a newer privacy refresh')
assert.match(panelSource, /detailIdRef\.current !== groupRunId/, 'background detail refreshes must not overwrite a different or closed run')
assert.match(panelSource, /onClick=\{\(\) => openReport\(\)\}/, 'invitees and joined non-owners must have a group-run report action')
assert.match(panelSource, /state: groupRunNavigationProvenance\(groupRunWarmupState\(detail\.group_run\)\)/, 'group-run navigation must write provenance only to browser history')

const warmupSource = readFileSync(new URL('../src/pages/Warmup.jsx', import.meta.url), 'utf8')
assert.match(warmupSource, /navigate\('\/run\/active', \{ replace: true, state: groupRunNavigationProvenance\(nextState\) \}\)/, 'Warmup must replace its history entry with provenance-only group-run state')

console.log('Phase 4D group-run frontend smoke OK')
