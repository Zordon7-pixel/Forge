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
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const allowed = new Set(['object_id', 'owner_id', 'subscription_id', 'object_type', 'aspect_type', 'event_time', 'updates']);
  if (Object.keys(body).some(key => !allowed.has(key))) return null;
  const objectId = safeWebhookId(body.object_id);
  const ownerId = safeWebhookId(body.owner_id);
  const subscriptionId = safeWebhookId(body.subscription_id);
  const objectType = body.object_type;
  const aspectType = body.aspect_type;
  if (!objectId || !ownerId || !subscriptionId) return null;
  if (!['activity', 'athlete'].includes(objectType)) return null;
  if (!['create', 'update', 'delete'].includes(aspectType)) return null;
  if (!Number.isSafeInteger(body.event_time) || body.event_time < 0) return null;
  const input = body.updates === undefined ? {} : body.updates;
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 16) return null;
  const updates = Object.create(null);
  for (const key of Object.keys(input).sort()) {
    const value = input[key];
    if (!/^[a-z_]{1,40}$/.test(key) || !['string', 'boolean', 'number'].includes(typeof value)
      || (typeof value === 'number' && !Number.isFinite(value))
      || (typeof value === 'string' && value.length > 512)) return null;
    updates[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(updates)) > 2048) return null;
  const event = { objectId, ownerId, subscriptionId, objectType, aspectType, eventTime: body.event_time, updates };
  return { ...event, fingerprint: crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex') };
}

function safeWebhookId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value)) ? value : null;
}

// Exact method/path only; mount BEFORE the application's general 10MB parser.
function mountStravaWebhookParser(app) {
  app.post('/api/strava/webhook', require('express').json({ limit: '16kb', strict: true, inflate: false }), (error, _req, res, next) => {
    if (!error) return next();
    return res.status(error.status === 413 ? 413 : 400).json({ error: 'Invalid webhook body' });
  });
}

module.exports = { getWebhookVerifyToken, normalizeWebhookEvent, verifyWebhookToken, safeWebhookId, mountStravaWebhookParser };
