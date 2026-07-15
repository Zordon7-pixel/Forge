const crypto = require('crypto');

const MAX_FRIENDS = 100;
const MAX_ACTIVE_INVITES = 5;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function canonicalPair(firstUserId, secondUserId) {
  const first = String(firstUserId || '');
  const second = String(secondUserId || '');
  return first < second ? [first, second] : [second, first];
}

function createInviteToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashInviteToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function isInviteTokenShape(token) {
  return /^[A-Za-z0-9_-]{40,64}$/.test(String(token || ''));
}

function boundedText(value, maxLength) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, maxLength);
}

module.exports = {
  INVITE_TTL_MS,
  MAX_ACTIVE_INVITES,
  MAX_FRIENDS,
  boundedText,
  canonicalPair,
  createInviteToken,
  hashInviteToken,
  isInviteTokenShape,
};
