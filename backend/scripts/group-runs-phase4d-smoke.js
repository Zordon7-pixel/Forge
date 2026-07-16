#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  GROUP_RUN_SAFETY_RETENTION_DAYS,
  MAX_ROUTE_COORDINATES,
  normalizeGroupRunInput,
  normalizeRouteJson,
  revokeBlockedGroupRunAccess,
  serializeGroupRun,
} = require('../src/lib/groupRunRules');

const now = new Date('2026-07-15T12:00:00.000Z');
assert.strictEqual(GROUP_RUN_SAFETY_RETENTION_DAYS, 30);
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
assert.ok(normalizeGroupRunInput({ ...validInput, run_type: 'anything-goes' }, { now }).error);
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
const rulesSource = read('src/lib/groupRunRules.js');
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
  "router.post('/:id/members/:membershipId/report', reportLimiter",
  "router.post('/:id/members/:membershipId/block', actionLimiter",
  "router.get('/:id',",
]) assert.ok(routeSource.includes(endpoint));
assert.strictEqual(routeSource.includes('FROM challenges'), false);
assert.strictEqual(routeSource.includes('shared_routes'), false);
assert.ok(routeSource.includes("'activity', ?, ?, 'open'"));
assert.ok(routeSource.includes('WHERE id = ? AND group_run_id = ? AND user_id = ?'));
assert.ok(routeSource.includes("res.set('Cache-Control', 'private, no-store')"));
assert.ok((routeSource.match(/Cache-Control/g) || []).length >= 2);
assert.ok(routeSource.includes('SET meetup_details = NULL, notes = NULL, route_json = NULL'));
assert.ok(routeSource.includes("gr.status = 'cancelled'"));
assert.ok(routeSource.includes('gr.owner_id = ? OR EXISTS'));
assert.ok(routeSource.includes('SELECT gr.id, gr.owner_id'));
assert.ok(routeSource.includes('WHERE id = ? AND owner_id = ?'));
assert.ok(routeSource.includes('FOR UPDATE OF gr SKIP LOCKED'));
assert.ok(routeSource.includes('EXACT_DATA_PURGE_BATCH_SIZE = 250'));
assert.ok(routeSource.includes('EXACT_DATA_PURGE_INTERVAL_MS = 60 * 1000'));
assert.ok(routeSource.includes('if (periodicExactDataPurgeRunning) return'));
assert.ok(routeSource.includes('periodicExactDataPurgeTimer.unref()'));
assert.ok(routeSource.includes("SET status = 'cancelled', cancelled_at = NOW(), meetup_details = NULL"));
assert.ok(routeSource.includes("viewer_member.status = 'invited'"));
assert.ok(routeSource.includes("gr.status = 'scheduled' AND gr.starts_at > NOW()"));
assert.ok(routeSource.includes("current_member.status IN ('invited', 'going')"));
assert.ok(routeSource.includes('safety_action: groupRun.safety_actions_available && !member.is_self'));
assert.ok(routeSource.includes("target_member.id = ? AND target_member.user_id <> ?"));
assert.ok(routeSource.includes("?::integer * INTERVAL '1 day'"));
const organizerReportSource = routeSource.slice(
  routeSource.indexOf("router.post('/:id/report'"),
  routeSource.indexOf("router.post('/:id/members/:membershipId/report'")
);
assert.strictEqual(organizerReportSource.includes("viewer_member.status IN ('invited', 'going')"), false);
assert.strictEqual(organizerReportSource.includes('user_blocks'), false);
assert.ok(schemaSource.includes('CREATE TABLE IF NOT EXISTS group_runs'));
assert.ok(schemaSource.includes('CREATE TABLE IF NOT EXISTS group_run_members'));
assert.ok(schemaSource.includes('jsonb_array_length(route_json->\'coordinates\') BETWEEN 2 AND 800'));
assert.ok(socialSource.includes('revokeBlockedGroupRunAccess'));
assert.ok(rulesSource.includes("gr.status IN ('scheduled', 'completed')"));
assert.ok(rulesSource.includes("SET status = 'removed', left_at = NOW(), removed_at = NOW()"));
assert.ok(rulesSource.includes("SET status = 'left', left_at = NOW(), updated_at = NOW()"));
assert.ok(accountSource.includes("key: 'owned_group_runs'"));
assert.ok(accountSource.includes("key: 'group_run_memberships'"));
assert.ok(appSource.includes("app.use('/api/group-runs'"));

(async () => {
  const writes = [];
  const tx = {
    all: async (sql, params) => {
      assert.ok(sql.includes("gr.status IN ('scheduled', 'completed')"));
      assert.ok(sql.includes("?::integer * INTERVAL '1 day'"));
      assert.deepStrictEqual(params, ['blocker-user', 'blocked-user', GROUP_RUN_SAFETY_RETENTION_DAYS]);
      return [
        {
          group_run_id: 'owner-run',
          owner_id: 'blocker-user',
          blocker_membership_id: 'owner-membership',
          blocked_membership_id: 'blocked-membership',
        },
        {
          group_run_id: 'peer-run',
          owner_id: 'third-user',
          blocker_membership_id: 'blocker-membership',
          blocked_membership_id: 'peer-blocked-membership',
        },
      ];
    },
    run: async (sql, params) => {
      writes.push({ sql, params });
      return { changes: 1 };
    },
  };

  await revokeBlockedGroupRunAccess(tx, 'blocker-user', 'blocked-user');
  assert.strictEqual(writes.length, 2);
  assert.ok(writes[0].sql.includes("SET status = 'removed'"));
  assert.deepStrictEqual(writes[0].params, ['blocked-membership', 'owner-run', 'blocked-user']);
  assert.ok(writes[1].sql.includes("SET status = 'left'"));
  assert.deepStrictEqual(writes[1].params, ['blocker-membership', 'peer-run', 'blocker-user']);

  const { purgeExpiredGroupRunExactData } = require('../src/routes/groupRuns')._test;
  const purgeWrites = [];
  const purgeTx = {
    all: async (sql, params) => {
      assert.ok(sql.includes('SELECT gr.id, gr.owner_id'));
      assert.ok(sql.includes('FOR UPDATE OF gr SKIP LOCKED'));
      assert.deepStrictEqual(params, ['viewer-user', 'viewer-user', 2]);
      return [
        { id: 'expired-run', owner_id: 'owner-one' },
        { id: 'cancelled-run', owner_id: 'owner-two' },
      ];
    },
    run: async (sql, params) => {
      purgeWrites.push({ sql, params });
      return { changes: 1 };
    },
  };
  const purged = await purgeExpiredGroupRunExactData(
    purgeTx,
    { userId: 'viewer-user', batchSize: 2 }
  );
  assert.strictEqual(purged, 2);
  assert.strictEqual(purgeWrites.length, 2);
  for (const write of purgeWrites) {
    assert.ok(write.sql.includes('WHERE id = ? AND owner_id = ?'));
  }
  assert.deepStrictEqual(purgeWrites[0].params, ['expired-run', 'owner-one']);
  assert.deepStrictEqual(purgeWrites[1].params, ['cancelled-run', 'owner-two']);

  console.log('Phase 4D group-run validation, purge, retention, and attendee safety smoke passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
