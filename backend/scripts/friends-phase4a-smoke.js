#!/usr/bin/env node

const assert = require('assert');
const {
  boundedText,
  canonicalPair,
  createInviteToken,
  hashInviteToken,
  isInviteTokenShape,
  normalizeFriendHandle,
  relationshipState,
} = require('../src/lib/friendship');

const [low, high] = canonicalPair('user-b', 'user-a');
assert.strictEqual(low, 'user-a');
assert.strictEqual(high, 'user-b');
assert.deepStrictEqual(canonicalPair('user-a', 'user-b'), [low, high]);

const first = createInviteToken();
const second = createInviteToken();
assert.ok(isInviteTokenShape(first));
assert.ok(isInviteTokenShape(second));
assert.notStrictEqual(first, second);
assert.strictEqual(hashInviteToken(first).length, 64);
assert.strictEqual(hashInviteToken(first), hashInviteToken(first));
assert.notStrictEqual(hashInviteToken(first), hashInviteToken(second));
assert.strictEqual(isInviteTokenShape('not-a-real-token'), false);

assert.strictEqual(boundedText('  line one\nline two  ', 40), 'line one line two');
assert.strictEqual(boundedText('123456', 4), '1234');

assert.strictEqual(normalizeFriendHandle('@Bryan.Runner'), 'bryan.runner');
assert.strictEqual(normalizeFriendHandle(' hybrid_01 '), 'hybrid_01');
assert.strictEqual(normalizeFriendHandle('ab'), null);
assert.strictEqual(normalizeFriendHandle('has spaces'), null);
assert.strictEqual(normalizeFriendHandle('support'), null);

assert.strictEqual(relationshipState(null, 'user-a'), 'available');
assert.strictEqual(relationshipState({ status: 'removed' }, 'user-a'), 'available');
assert.strictEqual(relationshipState({ status: 'accepted' }, 'user-a'), 'friends');
assert.strictEqual(relationshipState({ status: 'pending', requester_id: 'user-a' }, 'user-a'), 'outgoing');
assert.strictEqual(relationshipState({ status: 'pending', requester_id: 'user-b' }, 'user-a'), 'incoming');

console.log('Phase 4A/4A.1 friendship helper smoke passed');
