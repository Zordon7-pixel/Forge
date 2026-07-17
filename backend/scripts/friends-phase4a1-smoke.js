#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const route = read('backend/src/routes/socialFriends.js');
const db = read('backend/src/db/index.js');
const schema = read('backend/src/db/schema.pg.sql');
const community = read('frontend/src/pages/Community.jsx');
const locale = read('frontend/src/locales/en.json');
const { normalizeFriendHandle } = require('../src/lib/friendship');

assert.ok(route.includes("router.put('/friend-discovery-profile'"));
assert.ok(route.includes("router.post('/friend-search'"));
assert.ok(route.includes("router.post('/friend-requests'"));
assert.ok(route.includes('LOWER(u.friend_handle) = LOWER(?)'));
assert.ok(route.includes('u.friend_discoverable = 1'));
assert.ok(!/friend_handle[^\n]*ILIKE|ILIKE[^\n]*friend_handle/i.test(route));
assert.ok(route.includes('(b.blocker_id = ? AND b.blocked_id = u.id)'));
assert.ok(route.includes('(b.blocker_id = u.id AND b.blocked_id = ?)'));
const handleSearchStart = route.indexOf("router.post('/friend-search'");
const handleRequestStart = route.indexOf("router.post('/friend-requests'", handleSearchStart);
const handleSearchRoute = route.slice(handleSearchStart, handleRequestStart);
assert.ok(!handleSearchRoute.includes('u.email'));
assert.ok(/SET friend_handle = \?, friend_discoverable = \?[\s\S]*WHERE id = \?/.test(route));

for (const source of [db, schema]) {
  assert.ok(source.includes('friend_handle TEXT'));
  assert.ok(source.includes('friend_discoverable INTEGER DEFAULT 0'));
  assert.ok(source.includes('idx_users_friend_handle_lower'));
}

assert.ok(community.includes("api.post('/social/friend-search'"));
assert.ok(community.includes("api.post('/social/friend-requests'"));
assert.ok(community.includes("api.put('/social/friend-discovery-profile'"));
assert.ok(locale.includes('"exactSearch": "Exact handle search"'));
assert.ok(locale.includes('"searchCaseHint": "Capitalization does not matter.'));
assert.strictEqual(normalizeFriendHandle('Kreeplife'), 'kreeplife');
assert.strictEqual(normalizeFriendHandle('kreeplife'), 'kreeplife');
assert.strictEqual(normalizeFriendHandle('@KREEPLIFE'), 'kreeplife');

console.log('Phase 4A.1 exact-handle discovery smoke passed');
