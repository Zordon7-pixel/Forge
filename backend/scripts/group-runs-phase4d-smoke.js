#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  MAX_ROUTE_COORDINATES,
  normalizeGroupRunInput,
  normalizeRouteJson,
  serializeGroupRun,
} = require('../src/lib/groupRunRules');

const now = new Date('2026-07-15T12:00:00.000Z');
const validInput = {
  title: 'Creek trail meetup',
  starts_at: '2026-07-15T18:00:00.000Z',
  timezone: 'America/New_York',
  duration_minutes: 60,
  run_type: 'easy',
  goal_mode: 'distance',
  target_distance_miles: 4.5,
  pace_note: 'Conversational pace',
  target_zone: 'Zone 2',
  workout_structure: 'Easy out and back with regroup points.',
  meetup_area: 'North Creek Park',
  meetup_details: 'By the west trailhead map.',
  notes: 'Bring water.',
  route: {
    id: 'route-1',
    surface: 'trail',
    distanceMiles: 4.48,
    coordinates: [[38.9, -76.9, 20], { lat: 38.91, lng: -76.91 }],
    elevationProfile: [{ distanceMiles: 1, elevationFeet: 100 }],
    liveLocation: { lat: 38.9, lon: -76.9 },
  },
  participant_limit: 12,
};

const normalized = normalizeGroupRunInput(validInput, { now });
assert.ok(normalized.value);
assert.strictEqual(normalized.value.distanceTargetMiles, 4.5);
assert.deepStrictEqual(normalized.value.routeJson.coordinates, [[38.9, -76.9], [38.91, -76.91]]);
assert.strictEqual(normalized.value.routeJson.surface, 'trail');
assert.strictEqual('elevationProfile' in normalized.value.routeJson, false);
assert.strictEqual('liveLocation' in normalized.value.routeJson, false);

assert.ok(normalizeGroupRunInput({ ...validInput, duration_minutes: 9 }, { now }).error);
assert.ok(normalizeGroupRunInput({ ...validInput, duration_minutes: 481 }, { now }).error);
assert.ok(normalizeGroupRunInput({ ...validInput, participant_limit: 26 }, { now }).error);
assert.ok(normalizeGroupRunInput({ ...validInput, starts_at: '2026-07-15T11:59:00.000Z' }, { now }).error);
assert.ok(normalizeGroupRunInput({ ...validInput, goal_mode: 'open', target_distance_miles: 4 }, { now }).error);
const timeGoal = normalizeGroupRunInput({
  ...validInput,
  goal_mode: 'time',
  target_distance_miles: null,
  target_duration_minutes: 45,
}, { now });
assert.strictEqual(timeGoal.value.timeTargetMinutes, 45);
assert.ok(normalizeRouteJson({ coordinates: [[null, -76.9], [38.91, -76.91]] }).error);
assert.ok(normalizeRouteJson({
  coordinates: Array.from({ length: MAX_ROUTE_COORDINATES + 1 }, (_, index) => [38.9, -76.9 + index / 100000]),
}).error);

const groupRunRow = {
  id: 'group-run-1',
  title: 'Creek trail meetup',
  starts_at: '2026-07-15T18:00:00.000Z',
  timezone: 'America/New_York',
  duration_minutes: 60,
  run_type: 'easy',
  goal_mode: 'distance',
  target_distance_miles: 4.5,
  target_duration_minutes: null,
  pace_note: 'Conversational pace',
  target_zone: 'Zone 2',
  workout_structure: 'Easy out and back.',
  meetup_area: 'North Creek Park',
  meetup_details: 'By the west trailhead map.',
  notes: 'Bring water.',
  route_json: normalized.value.routeJson,
  participant_limit: 12,
  participant_count: 2,
  reserved_count: 3,
  status: 'scheduled',
  owner_name: 'Organizer',
  membership_status: 'invited',
  muted: 0,
  viewer_is_owner: false,
  created_at: '2026-07-15T12:00:00.000Z',
  updated_at: '2026-07-15T12:00:00.000Z',
};

const invitation = serializeGroupRun(groupRunRow, { detail: true, now: new Date('2026-07-15T17:00:00.000Z') });
assert.strictEqual(invitation.meetup_area, 'North Creek Park');
assert.strictEqual(invitation.workout_structure, 'Easy out and back.');
assert.strictEqual('meetup_details' in invitation, false);
assert.strictEqual('route' in invitation, false);
assert.strictEqual('notes' in invitation, false);

const joinedRow = { ...groupRunRow, membership_status: 'going' };
const listItem = serializeGroupRun(joinedRow, { now: new Date('2026-07-15T17:00:00.000Z') });
assert.strictEqual('meetup_details' in listItem, false);
assert.strictEqual('route' in listItem, false);

const joined = serializeGroupRun(joinedRow, { detail: true, now: new Date('2026-07-15T17:00:00.000Z') });
assert.strictEqual(joined.meetup_details, 'By the west trailhead map.');
assert.deepStrictEqual(joined.route.coordinates, [[38.9, -76.9], [38.91, -76.91]]);
assert.strictEqual(joined.organizer.name, 'Organizer');
assert.strictEqual(joined.target_distance_miles, 4.5);

const cancelled = serializeGroupRun(
  { ...joinedRow, status: 'cancelled' },
  { detail: true, now: new Date('2026-07-15T17:00:00.000Z') }
);
assert.strictEqual('meetup_details' in cancelled, false);
assert.strictEqual('route' in cancelled, false);

const expired = serializeGroupRun(joinedRow, { detail: true, now: new Date('2026-07-15T21:00:01.000Z') });
assert.strictEqual('meetup_details' in expired, false);
assert.strictEqual('route' in expired, false);

const backendRoot = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(backendRoot, relativePath), 'utf8');
const routeSource = read('src/routes/groupRuns.js');
const socialSource = read('src/routes/socialFriends.js');
const schemaSource = read('src/db/schema.pg.sql');
const accountSource = read('src/lib/accountDataCoverage.js');
const appSource = read('src/app.js');

assert.ok(routeSource.includes('router.use(auth)'));
for (const endpoint of [
  "router.get('/',",
  "router.post('/', createLimiter",
  "router.post('/:id/invite', inviteLimiter",
  "router.patch('/:id/membership', actionLimiter",
  "router.patch('/:id', actionLimiter",
  "router.post('/:id/report', reportLimiter",
  "router.get('/:id',",
]) assert.ok(routeSource.includes(endpoint));
assert.strictEqual(routeSource.includes('FROM challenges'), false);
assert.strictEqual(routeSource.includes('shared_routes'), false);
assert.ok(routeSource.includes("'activity', ?, ?, 'open'"));
assert.ok(routeSource.includes('WHERE id = ? AND group_run_id = ? AND user_id = ?'));
assert.ok(schemaSource.includes('CREATE TABLE IF NOT EXISTS group_runs'));
assert.ok(schemaSource.includes('CREATE TABLE IF NOT EXISTS group_run_members'));
assert.ok(schemaSource.includes('jsonb_array_length(route_json->\'coordinates\') BETWEEN 2 AND 800'));
assert.ok(socialSource.includes('revokeUpcomingGroupRunAccess'));
assert.ok(socialSource.includes("SET status = 'removed', left_at = NOW(), removed_at = NOW()"));
assert.ok(socialSource.includes("SET status = 'left', left_at = NOW(), updated_at = NOW()"));
assert.ok(accountSource.includes("key: 'owned_group_runs'"));
assert.ok(accountSource.includes("key: 'group_run_memberships'"));
assert.ok(appSource.includes("app.use('/api/group-runs'"));

console.log('Phase 4D group-run validation, route pruning, and privacy redaction smoke passed');
