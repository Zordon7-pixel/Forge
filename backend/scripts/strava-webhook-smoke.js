const assert = require('node:assert/strict');
const { getWebhookVerifyToken, normalizeWebhookEvent, verifyWebhookToken } = require('../src/lib/stravaWebhook');

const secret = 'smoke-secret';
const token = getWebhookVerifyToken(secret);
assert.equal(token.length, 32);
assert.equal(verifyWebhookToken(token, secret), true);
assert.equal(verifyWebhookToken(`${token}x`, secret), false);
const input = {
  object_id: 123,
  owner_id: 456,
  subscription_id: 789,
  object_type: 'activity',
  aspect_type: 'create',
  event_time: 1770000000,
  updates: {},
};
const normalized = normalizeWebhookEvent(input);
assert.match(normalized.fingerprint, /^[a-f0-9]{64}$/);
assert.deepEqual(normalized, {
  objectId: '123',
  ownerId: '456',
  subscriptionId: '789',
  objectType: 'activity',
  aspectType: 'create',
  eventTime: 1770000000,
  updates: Object.create(null),
  fingerprint: normalized.fingerprint,
});
assert.equal(normalizeWebhookEvent({ ...input, event_time: undefined }), null);
assert.deepEqual(normalizeWebhookEvent(input), normalized);
assert.equal(normalizeWebhookEvent({ ...input, updates: { title: 'Synthetic', private: true } }).fingerprint,
  normalizeWebhookEvent({ ...input, updates: { private: true, title: 'Synthetic' } }).fingerprint);
assert.equal(normalizeWebhookEvent({ object_id: 'not-a-number' }), null);
assert.equal(normalizeWebhookEvent({ object_id: 1, owner_id: 2, subscription_id: 3, object_type: 'activity', aspect_type: 'unknown' }), null);
console.log('Strava webhook smoke OK');
