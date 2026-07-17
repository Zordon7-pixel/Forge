#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { monthBounds, rankFriendMileage } = require('../src/lib/friendLeaderboard');

assert.deepStrictEqual(monthBounds('2026-07'), {
  key: '2026-07',
  start: '2026-07-01',
  endExclusive: '2026-08-01',
  label: 'July 2026',
});
assert.deepStrictEqual(monthBounds('2026-12'), {
  key: '2026-12',
  start: '2026-12-01',
  endExclusive: '2027-01-01',
  label: 'December 2026',
});
assert.strictEqual(monthBounds('2026-13'), null);
assert.strictEqual(monthBounds(), null);

const ranked = rankFriendMileage([
  { user_id: 'viewer', name: 'Bryan', friend_handle: 'bryan', miles: '12.004', run_count: '3' },
  { user_id: 'friend-b', name: 'Taylor', friend_handle: 'taylor', miles: 18.5, run_count: 4 },
  { user_id: 'friend-a', name: 'Alex', friend_handle: null, miles: 18.5, run_count: 2 },
  { user_id: 'friend-c', name: 'Zero', friend_handle: null, miles: null, run_count: 0 },
], 'viewer');

assert.deepStrictEqual(ranked.map((row) => row.rank), [1, 1, 3, 4]);
assert.strictEqual(ranked[2].is_self, true);
assert.strictEqual(ranked[2].miles, 12);
assert.strictEqual(ranked[0].user.name, 'Alex');
assert.strictEqual(Object.hasOwn(ranked[0], 'user_id'), false);

const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/socialFriends.js'), 'utf8');
assert.ok(routeSource.includes("router.get('/friends/leaderboard'"));
assert.ok(routeSource.includes("router.get('/friends/leaderboard', leaderboardLimiter"));
assert.ok(routeSource.includes("f.status = 'accepted'"));
assert.ok(routeSource.includes('FROM user_blocks b'));
assert.ok(routeSource.includes("runActivitySql('r')"));
assert.ok(routeSource.includes('r.date >= ? AND r.date < ?'));
assert.ok(routeSource.includes('r.distance_miles BETWEEN 0.01 AND 500'));

const communitySource = fs.readFileSync(path.join(__dirname, '../../frontend/src/pages/Community.jsx'), 'utf8');
assert.ok(communitySource.includes("selectTab('leaderboard')"));
assert.ok(communitySource.includes('<FriendLeaderboard />'));

console.log('Friends monthly mileage leaderboard scope, month, tie, privacy, and UI smoke passed');
