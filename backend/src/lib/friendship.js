const crypto = require('crypto');

const MAX_FRIENDS = 100;
const MAX_ACTIVE_INVITES = 5;
const MAX_CONTACT_EMAILS = 500;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CONTACT_SUGGESTION_TTL_MS = 15 * 60 * 1000;
const FRIEND_HANDLE_PATTERN = /^[a-z0-9][a-z0-9._]{2,23}$/;
const RESERVED_FRIEND_HANDLES = new Set([
  'admin',
  'forge',
  'forgedhybrid',
  'help',
  'moderator',
  'staff',
  'support',
  'system',
]);

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

function normalizeFriendHandle(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/^@/, '');
  if (!FRIEND_HANDLE_PATTERN.test(normalized) || RESERVED_FRIEND_HANDLES.has(normalized)) return null;
  return normalized;
}

function normalizeContactEmails(values) {
  if (!Array.isArray(values) || values.length > MAX_CONTACT_EMAILS) return null;
  const normalized = values
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
  return [...new Set(normalized)].slice(0, MAX_CONTACT_EMAILS);
}

function contactSuggestionKey(secret) {
  if (!secret) throw new Error('JWT_SECRET is required for contact suggestions');
  return crypto.createHash('sha256')
    .update(`forged-hybrid-contact-suggestion:v1\0${secret}`, 'utf8')
    .digest();
}

function createContactSuggestionToken(viewerId, targetId, secret, now = Date.now()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', contactSuggestionKey(secret), iv);
  const plaintext = Buffer.from(JSON.stringify({
    viewer: String(viewerId),
    target: String(targetId),
    expires_at: now + CONTACT_SUGGESTION_TTL_MS,
  }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${tag.toString('base64url')}`;
}

function parseContactSuggestionToken(token, secret, now = Date.now()) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const [, ivPart, ciphertextPart, tagPart] = parts;
    if (![ivPart, ciphertextPart, tagPart].every((part) => /^[A-Za-z0-9_-]+$/.test(part))) return null;

    const iv = Buffer.from(ivPart, 'base64url');
    const ciphertext = Buffer.from(ciphertextPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');
    if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) return null;

    const decipher = crypto.createDecipheriv('aes-256-gcm', contactSuggestionKey(secret), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = JSON.parse(plaintext.toString('utf8'));
    if (!payload?.viewer || !payload?.target || !Number.isFinite(payload?.expires_at) || payload.expires_at <= now) return null;
    return { viewer: String(payload.viewer), target: String(payload.target) };
  } catch (err) {
    return null;
  }
}

function relationshipState(row, userId) {
  if (!row || !['pending', 'accepted'].includes(row.status)) return 'available';
  if (row.status === 'accepted') return 'friends';
  return row.requester_id === userId ? 'outgoing' : 'incoming';
}

module.exports = {
  FRIEND_HANDLE_PATTERN,
  CONTACT_SUGGESTION_TTL_MS,
  INVITE_TTL_MS,
  MAX_ACTIVE_INVITES,
  MAX_CONTACT_EMAILS,
  MAX_FRIENDS,
  boundedText,
  canonicalPair,
  createContactSuggestionToken,
  createInviteToken,
  hashInviteToken,
  isInviteTokenShape,
  normalizeFriendHandle,
  normalizeContactEmails,
  parseContactSuggestionToken,
  relationshipState,
};
