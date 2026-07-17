#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  CONTACT_SUGGESTION_TTL_MS,
  MAX_CONTACT_EMAILS,
  createContactSuggestionToken,
  normalizeContactEmails,
  parseContactSuggestionToken,
} = require('../src/lib/friendship');

assert.deepStrictEqual(
  normalizeContactEmails([' Friend@Example.com ', 'friend@example.com', 'bad', '', null]),
  ['friend@example.com']
);
assert.strictEqual(normalizeContactEmails(new Array(MAX_CONTACT_EMAILS + 1).fill('a@example.com')), null);
assert.strictEqual(normalizeContactEmails('a@example.com'), null);

const tokenNow = Date.UTC(2026, 6, 17, 12);
const opaqueToken = createContactSuggestionToken('viewer-id', 'target-id', 'test-secret', tokenNow);
assert.strictEqual(opaqueToken.includes('viewer-id'), false);
assert.strictEqual(opaqueToken.includes('target-id'), false);
assert.deepStrictEqual(parseContactSuggestionToken(opaqueToken, 'test-secret', tokenNow), {
  viewer: 'viewer-id',
  target: 'target-id',
});
assert.strictEqual(parseContactSuggestionToken(`${opaqueToken}x`, 'test-secret', tokenNow), null);
assert.strictEqual(parseContactSuggestionToken(opaqueToken, 'wrong-secret', tokenNow), null);
assert.strictEqual(parseContactSuggestionToken(opaqueToken, 'test-secret', tokenNow + CONTACT_SUGGESTION_TTL_MS), null);

const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/socialFriends.js'), 'utf8');
assert.ok(routeSource.includes("router.put('/contact-discovery-profile'"));
assert.ok(routeSource.includes("router.post('/contact-suggestions'"));
assert.ok(routeSource.includes("router.post('/contact-suggestions/request'"));
assert.ok(routeSource.includes('u.contact_discoverable = 1'));
assert.ok(routeSource.includes('u.email = ANY(?::text[])'));
assert.ok(routeSource.includes('FROM user_blocks b'));
assert.ok(routeSource.includes('createContactSuggestionToken(req.user.id, row.id'));
assert.ok(routeSource.includes('payload.viewer !== req.user.id'));
assert.ok(routeSource.includes("SELECT id FROM users WHERE id = ? AND contact_discoverable = 1 FOR UPDATE"));
assert.strictEqual(routeSource.includes('user: { name: row.name || \'Athlete\', email:'), false);

for (const relativePath of ['../src/db/index.js', '../src/db/migrate.js', '../src/db/schema.pg.sql']) {
  const source = fs.readFileSync(path.join(__dirname, relativePath), 'utf8');
  assert.ok(source.includes('contact_discoverable'));
}

const swiftSource = fs.readFileSync(path.join(__dirname, '../../frontend/ios/App/App/ForgeContactsPlugin.swift'), 'utf8');
assert.ok(swiftSource.includes('CNContactEmailAddressesKey'));
assert.ok(swiftSource.includes('requestAccess(for: .contacts)'));
assert.strictEqual(swiftSource.includes('CNContactPhoneNumbersKey'), false);
assert.strictEqual(swiftSource.includes('CNContactGivenNameKey'), false);

const communitySource = fs.readFileSync(path.join(__dirname, '../../frontend/src/pages/Community.jsx'), 'utf8');
assert.ok(communitySource.includes("readPermittedContactEmails"));
assert.ok(communitySource.includes("api.post('/social/contact-suggestions', { emails })"));
assert.ok(communitySource.includes("api.post('/social/contact-suggestions/request'"));

console.log('Contact suggestion consent, normalization, opaque request, migration, native-minimization, and UI smoke passed');
