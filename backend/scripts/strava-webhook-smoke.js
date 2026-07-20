const assert = require('node:assert/strict');
const { getWebhookVerifyToken, normalizeWebhookEvent, verifyWebhookToken } = require('../src/lib/stravaWebhook');

const secret = 'smoke-secret';
const token = getWebhookVerifyToken(secret);
assert.equal(token.length, 32);
assert.equal(verifyWebhookToken(token, secret), true);
assert.equal(verifyWebhookToken(`${token}x`, secret), false);
assert.deepEqual(normalizeWebhookEvent({
  object_id: 123,
  owner_id: 456,
  subscription_id: 789,
  object_type: 'activity',
  aspect_type: 'create',
  updates: {},
}), {
  objectId: '123',
  ownerId: '456',
  subscriptionId: '789',
  objectType: 'activity',
  aspectType: 'create',
  updates: {},
});
assert.equal(normalizeWebhookEvent({ object_id: 'not-a-number' }), null);
assert.equal(normalizeWebhookEvent({ object_id: 1, owner_id: 2, subscription_id: 3, object_type: 'activity', aspect_type: 'unknown' }), null);
console.log('Strava webhook smoke OK');
