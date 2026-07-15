#!/usr/bin/env node

const assert = require('assert');
const {
  boundedText,
  canonicalPair,
  createInviteToken,
  hashInviteToken,
  isInviteTokenShape,
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

console.log('Phase 4A friendship helper smoke passed');
