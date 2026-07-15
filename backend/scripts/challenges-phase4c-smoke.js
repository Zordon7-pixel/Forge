#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { rankChallengeScores, scoreChallenge } = require('../src/lib/challengeScoring');

const challenge = {
  template_type: 'strength_consistency',
  run_target: null,
  run_unit: null,
  lift_target: 5,
  lift_unit: 'sessions',
  timezone: 'America/New_York',
  verification_policy: 'all_activity',
  start_date: '2026-07-15',
  end_date: '2026-07-21',
};

const rows = {
  runs: [],
  workoutSessions: [
    { id: 'morning', user_id: 'athlete', started_at: '2026-07-16T13:00:00.000Z', ended_at: '2026-07-16T14:00:00.000Z' },
    { id: 'evening', user_id: 'athlete', started_at: '2026-07-16T22:00:00.000Z', ended_at: '2026-07-16T23:00:00.000Z' },
  ],
  lifts: [
    // These ambiguous exercise-summary rows remain in private History but do not earn social credit.
    { id: 'legacy-a', user_id: 'athlete', date: '2026-07-16' },
    { id: 'legacy-b', user_id: 'athlete', date: '2026-07-17' },
    // Distinct trusted imports on the same day are legitimate separate sessions.
    { id: 'device-a', user_id: 'athlete', date: '2026-07-18', watch_normalized_type: 'imported' },
    { id: 'device-b', user_id: 'athlete', date: '2026-07-18', watch_sync_id: 'watch-b' },
  ],
};

const allActivity = scoreChallenge(challenge, rows, 'athlete');
assert.strictEqual(allActivity.qualifying_counts.strength_sessions, 4);
assert.strictEqual(allActivity.percent, 80);
assert.strictEqual(allActivity.contributions.filter((entry) => entry.verification === 'manual').length, 2);
assert.strictEqual(allActivity.contributions.filter((entry) => entry.verification === 'device').length, 2);

const deviceOnly = scoreChallenge({ ...challenge, verification_policy: 'device_only' }, rows, 'athlete');
assert.strictEqual(deviceOnly.qualifying_counts.strength_sessions, 2);
assert.strictEqual(deviceOnly.percent, 40);

const tied = rankChallengeScores([
  { user_id: 'one', score: 80 },
  { user_id: 'two', score: 80 },
  { user_id: 'three', score: 20 },
]);
assert.deepStrictEqual(tied.map((entry) => entry.rank), [1, 1, 3]);

const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/challenges.js'), 'utf8');
assert.ok(routeSource.includes('uc.id AS membership_id'));
assert.ok(routeSource.includes('owner_action: ownerAction'));
assert.ok(routeSource.includes("router.post('/:id/report', reportLimiter"));
assert.ok(routeSource.includes("AND viewer_uc.user_id = ?"));
assert.ok(routeSource.includes('WHERE id = ? AND challenge_id = ? AND user_id = ?'));
assert.strictEqual(routeSource.includes('user: { id: entry.user_id'), false);

const panelSource = fs.readFileSync(path.join(__dirname, '../../frontend/src/components/ChallengePanel.jsx'), 'utf8');
assert.ok(panelSource.includes("api.get(`/challenges/${challengeId}/leaderboard`)"));
assert.ok(panelSource.includes("action: 'remove_member'"));
assert.ok(panelSource.includes("api.post(`/challenges/${detail.challenge.id}/report`"));
assert.ok(panelSource.includes("t('challenges.strengthCreditPolicy')"));

console.log('Phase 4C scoring identity, tie, moderation, privacy, and UI-contract smoke passed');
