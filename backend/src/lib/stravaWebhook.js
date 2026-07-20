const crypto = require('crypto');

function getWebhookVerifyToken(secret = process.env.JWT_SECRET) {
  return crypto
    .createHmac('sha256', String(secret || ''))
    .update('forged-hybrid-strava-webhook')
    .digest('hex')
    .slice(0, 32);
}

function verifyWebhookToken(value, secret = process.env.JWT_SECRET) {
  const supplied = Buffer.from(String(value || ''));
  const expected = Buffer.from(getWebhookVerifyToken(secret));
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function normalizeWebhookEvent(body = {}) {
  const objectId = String(body.object_id || '').trim();
  const ownerId = String(body.owner_id || '').trim();
  const subscriptionId = String(body.subscription_id || '').trim();
  const objectType = String(body.object_type || '').trim().toLowerCase();
  const aspectType = String(body.aspect_type || '').trim().toLowerCase();
  if (!/^\d{1,30}$/.test(objectId) || !/^\d{1,30}$/.test(ownerId) || !/^\d{1,30}$/.test(subscriptionId)) return null;
  if (!['activity', 'athlete'].includes(objectType)) return null;
  if (!['create', 'update', 'delete'].includes(aspectType)) return null;
  return {
    objectId,
    ownerId,
    subscriptionId,
    objectType,
    aspectType,
    updates: body.updates && typeof body.updates === 'object' && !Array.isArray(body.updates) ? body.updates : {},
  };
}

module.exports = { getWebhookVerifyToken, normalizeWebhookEvent, verifyWebhookToken };
