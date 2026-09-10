const crypto = require('node:crypto');
const { canonicalHash } = require('./racePlanPolicy');
const { validateContext } = require('./activityAdaptationAuthority');
const PURPOSE = 'activity-adaptation-observation-v1';
function mac(encoded, secret) {
  if (typeof secret !== 'string' || !secret) throw new Error('Activity observation signing unavailable');
  return crypto.createHmac('sha256', secret).update(`${PURPOSE}:${encoded}`).digest('hex');
}
function signObservation(context, secret = process.env.JWT_SECRET) {
  if (!validateContext(context)) throw new Error('Activity observation context invalid');
  const encoded = Buffer.from(JSON.stringify({ purpose: PURPOSE, context })).toString('base64url');
  return `${encoded}.${mac(encoded, secret)}`;
}
function verifyObservation(ticket, { ownerId, assignmentId, now = new Date(), secret = process.env.JWT_SECRET } = {}) {
  try {
    const nowMs = new Date(now).getTime();
    if (!Number.isFinite(nowMs)) return null;
    if (typeof ticket !== 'string' || ticket.length > 8192 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(ticket)) return null;
    const [encoded, signature] = ticket.split('.');
    if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(mac(encoded, secret), 'hex'))) return null;
    const envelope = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    const context = envelope.context;
    if (Object.keys(envelope).sort().join('|') !== 'context|purpose' || envelope.purpose !== PURPOSE
      || !validateContext(context) || String(context.owner_id) !== String(ownerId)
      || String(context.assignment_id) !== String(assignmentId)
      || Date.parse(context.observed_at) > nowMs || Date.parse(context.expires_at) <= nowMs) return null;
    return context;
  } catch { return null; }
}
function sameFreshObservation(original, fresh) {
  if (!validateContext(original) || !validateContext(fresh)) return false;
  const withoutClock = context => {
    const { observed_at, expires_at, ...fields } = context;
    return fields;
  };
  return canonicalHash(withoutClock(original)) === canonicalHash(withoutClock(fresh));
}
module.exports = { signObservation, verifyObservation, sameFreshObservation };
