#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  dateInTimezone,
  normalizeChallengeInput,
} = require('../src/lib/challengeRules');
const {
  isDeviceRecorded,
  rankChallengeScores,
  scoreChallenge,
} = require('../src/lib/challengeScoring');
const { cleanupOwnedSocialChallenges } = require('../src/lib/challengeOwnership');

const now = new Date('2026-07-15T16:00:00.000Z');
const valid = normalizeChallengeInput({
  name: 'Summer Hybrid',
  description: 'Run and lift together.',
  template_type: 'hybrid_balance',
  duration_days: 14,
  start_date: '2026-07-15',
  timezone: 'America/New_York',
  verification_policy: 'all_activity',
  participant_limit: 12,
  run_target: 20,
  run_unit: 'miles',
  lift_target: 3,
}, now);
assert.ok(valid.value);
assert.strictEqual(valid.value.endDate, '2026-07-28');
assert.ok(normalizeChallengeInput({ ...valid.value, template_type: 'unknown' }, now).error);
assert.ok(normalizeChallengeInput({ ...valid.value, template_type: 'running_distance', duration_days: 9 }, now).error);
assert.ok(normalizeChallengeInput({ ...valid.value, template_type: 'running_distance', duration_days: 7, start_date: '2026-07-14' }, now).error);

assert.strictEqual(dateInTimezone('2026-11-01T03:30:00.000Z', 'America/New_York'), '2026-10-31');
assert.strictEqual(dateInTimezone('2026-11-01T05:30:00.000Z', 'America/New_York'), '2026-11-01');

const challenge = {
  template_type: 'running_distance',
  run_target: 10,
  run_unit: 'miles',
  lift_target: null,
  timezone: 'America/New_York',
  verification_policy: 'all_activity',
  start_date: '2026-07-15',
  end_date: '2026-07-21',
};
const rows = {
  runs: [
    { id: 'device-old', user_id: 'a', date: '2026-07-15', type: 'run', distance_miles: 4.8, duration_seconds: 3000, health_source: 'apple_health', health_source_workout_id: 'health-1', health_start_at: '2026-07-15T11:00:00.000Z' },
    { id: 'device-complete', user_id: 'a', date: '2026-07-15', type: 'run', distance_miles: 5, duration_seconds: 3000, health_source: 'apple_health', health_source_workout_id: 'health-1', health_start_at: '2026-07-15T11:00:00.000Z' },
    { id: 'manual', user_id: 'a', date: '2026-07-16', type: 'easy', distance_miles: 2, duration_seconds: 1200 },
    { id: 'walk', user_id: 'a', date: '2026-07-16', type: 'walk', distance_miles: 8, duration_seconds: 8000, health_source: 'apple_health' },
  ],
  workoutSessions: [],
  lifts: [],
};
const allActivity = scoreChallenge(challenge, rows, 'a');
assert.strictEqual(allActivity.run.value, 7);
assert.strictEqual(allActivity.qualifying_counts.runs, 2);
assert.strictEqual(allActivity.percent, 70);
assert.strictEqual(allActivity.contributions.some((entry) => entry.distance_miles === 8), false);

const deviceOnly = scoreChallenge({ ...challenge, verification_policy: 'device_only' }, rows, 'a');
assert.strictEqual(deviceOnly.run.value, 5);
assert.strictEqual(deviceOnly.qualifying_counts.runs, 1);
assert.strictEqual(isDeviceRecorded({ notes: 'Imported workout' }), false);
assert.strictEqual(isDeviceRecorded({ watch_sync_id: 'watch-1' }), true);

const afterDelete = scoreChallenge(challenge, { ...rows, runs: rows.runs.filter((run) => run.id !== 'manual') }, 'a');
assert.strictEqual(afterDelete.run.value, 5);

const strengthRows = {
  runs: [{ id: 'run-hybrid', user_id: 'a', date: '2026-07-15', type: 'run', distance_miles: 10, duration_seconds: 3600 }],
  workoutSessions: [{ id: 'session-1', user_id: 'a', started_at: '2026-07-16T22:00:00.000Z', ended_at: '2026-07-16T23:00:00.000Z' }],
  lifts: [
    { id: 'manual-exercise-1', user_id: 'a', date: '2026-07-17' },
    { id: 'manual-exercise-2', user_id: 'a', date: '2026-07-17' },
    { id: 'device-lift-1', user_id: 'a', date: '2026-07-18', watch_normalized_type: 'imported', workout_duration_seconds: 1800 },
    { id: 'device-lift-2', user_id: 'a', date: '2026-07-18', watch_normalized_type: 'imported', workout_duration_seconds: 2400 },
  ],
};
const strength = scoreChallenge({
  ...challenge,
  template_type: 'strength_consistency',
  run_target: null,
  run_unit: null,
  lift_target: 4,
  lift_unit: 'sessions',
}, strengthRows, 'a');
assert.strictEqual(strength.qualifying_counts.strength_sessions, 4);
assert.strictEqual(strength.percent, 100);

const verifiedStrength = scoreChallenge({
  ...challenge,
  template_type: 'strength_consistency',
  run_target: null,
  run_unit: null,
  lift_target: 3,
  lift_unit: 'sessions',
  verification_policy: 'device_only',
}, strengthRows, 'a');
assert.strictEqual(verifiedStrength.qualifying_counts.strength_sessions, 2);

const hybrid = scoreChallenge({
  ...challenge,
  template_type: 'hybrid_balance',
  run_target: 20,
  run_unit: 'miles',
  lift_target: 2,
  lift_unit: 'sessions',
}, strengthRows, 'a');
assert.strictEqual(hybrid.run.value, 10);
assert.strictEqual(hybrid.lift.value, 4);
assert.strictEqual(hybrid.percent, 50);

const ranked = rankChallengeScores([
  { user_id: 'b', score: 50 },
  { user_id: 'a', score: 80 },
  { user_id: 'c', score: 50 },
]);
assert.deepStrictEqual(ranked.map((entry) => [entry.user_id, entry.rank]), [['a', 1], ['b', 2], ['c', 2]]);

async function ownerCleanupScenario(successor) {
  const calls = [];
  const tx = {
    all: async () => [{ id: 'challenge-1', template_type: 'hybrid_balance' }],
    get: async () => successor,
    run: async (sql, params) => {
      calls.push({ sql, params });
      return { changes: 1 };
    },
  };
  await cleanupOwnedSocialChallenges(tx, 'owner-1');
  return calls;
}

(async () => {
  const soloCalls = await ownerCleanupScenario(null);
  assert.ok(soloCalls.some((call) => /DELETE FROM challenges/.test(call.sql) && call.params.includes('owner-1')));
  const transferCalls = await ownerCleanupScenario({ id: 'membership-2', user_id: 'member-2' });
  assert.ok(transferCalls.some((call) => /SET creator_id = NULL, name = \?, description = NULL/.test(call.sql)));
  assert.ok(transferCalls.some((call) => /SET role = 'owner'/.test(call.sql) && call.params.includes('member-2')));
  assert.ok(transferCalls.some((call) => /DELETE FROM user_challenges/.test(call.sql) && call.params.includes('owner-1')));

  const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/challenges.js'), 'utf8');
  assert.ok(routeSource.includes('router.use(auth)'));
  assert.ok(routeSource.includes("c.kind = 'social'"));
  assert.ok(routeSource.includes("c.visibility IN ('private', 'friends')"));
  assert.ok(routeSource.includes("AND owner_uc.user_id = ?"));
  assert.ok(routeSource.includes("AND target_uc.user_id = ?"));
  assert.strictEqual(routeSource.includes('user: { id: entry.user_id'), false);
  assert.ok(routeSource.includes('is_self: entry.user_id === req.user.id'));

  console.log('Phase 4B challenge rules, scoring, ownership, and isolation smoke passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
