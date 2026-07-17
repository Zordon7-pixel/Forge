const fs = require('fs');
const path = require('path');
const router = require('express').Router();
const { dbGet } = require('../db');
const { normalizeFriendHandle } = require('../lib/friendship');

const DEFAULT_TITLE = 'Add me on Forged Hybrid';
const DESCRIPTION = "Hybrid training for runners who lift - join me and let's compare progress.";
const FALLBACK_APP_ORIGIN = 'https://forgeathlete.app';
const INVITE_CARD_PUBLIC_PATH = '/assets/invite-card.png';
const INVITE_CARD_SOURCE_PATH = path.resolve(__dirname, '../../../frontend/public/assets/invite-card.png');
const FALLBACK_IMAGE_PUBLIC_PATH = '/icon-512.png';

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function firstNameFrom(fullName) {
  const first = String(fullName || '').trim().split(/\s+/).filter(Boolean)[0] || '';
  return first.slice(0, 40);
}

function parseOrigin(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url.origin;
  } catch {
    return '';
  }
}

function publicOrigin(req) {
  const configured = parseOrigin(process.env.APP_URL || process.env.PUBLIC_APP_URL);
  if (configured) return configured;

  const forwardedHost = String(req.get('x-forwarded-host') || '').split(',')[0].trim();
  const host = forwardedHost || String(req.get('host') || '').split(',')[0].trim();
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'https';
  if (!host || /[\s/\\]/.test(host)) return FALLBACK_APP_ORIGIN;
  return parseOrigin(`${protocol}://${host}`) || FALLBACK_APP_ORIGIN;
}

function absoluteUrl(origin, pathOrUrl) {
  return new URL(pathOrUrl, origin).toString();
}

function inviteImagePath() {
  return fs.existsSync(INVITE_CARD_SOURCE_PATH)
    ? INVITE_CARD_PUBLIC_PATH
    : FALLBACK_IMAGE_PUBLIC_PATH;
}

function deepLinkFor(origin, handle) {
  const url = new URL('/community', origin);
  url.searchParams.set('tab', 'friends');
  if (handle) url.searchParams.set('handle', handle);
  return url.toString();
}

function renderInviteHtml({ title, description, inviteUrl, imageUrl, deepLink }) {
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  const safeInviteUrl = escapeHtml(inviteUrl);
  const safeImageUrl = escapeHtml(imageUrl);
  const safeDeepLink = escapeHtml(deepLink);
  const redirectScriptValue = JSON.stringify(deepLink).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${safeTitle}</title>
    <meta name="description" content="${safeDescription}">
    <meta property="og:title" content="${safeTitle}">
    <meta property="og:description" content="${safeDescription}">
    <meta property="og:image" content="${safeImageUrl}">
    <meta property="og:url" content="${safeInviteUrl}">
    <meta property="og:type" content="website">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${safeTitle}">
    <meta name="twitter:description" content="${safeDescription}">
    <meta name="twitter:image" content="${safeImageUrl}">
    <meta http-equiv="refresh" content="0; url=${safeDeepLink}">
    <link rel="canonical" href="${safeInviteUrl}">
  </head>
  <body>
    <p>Opening Forged Hybrid...</p>
    <script>window.location.replace(${redirectScriptValue});</script>
    <noscript><p><a href="${safeDeepLink}">Open Forged Hybrid</a></p></noscript>
  </body>
</html>`;
}

router.get('/:handle', async (req, res) => {
  const origin = publicOrigin(req);
  const handle = normalizeFriendHandle(req.params.handle);
  let title = DEFAULT_TITLE;

  try {
    if (handle) {
      const inviter = await dbGet(
        `SELECT name, friend_handle
         FROM users
         WHERE LOWER(friend_handle) = ?
           AND friend_discoverable = 1
         LIMIT 1`,
        [handle]
      );
      const firstName = firstNameFrom(inviter?.name);
      if (firstName) title = `${firstName} invited you to Forged Hybrid`;
    }
  } catch (err) {
    console.error('[invite-preview] lookup failed:', err.message);
  }

  const inviteUrl = absoluteUrl(origin, handle ? `/invite/${encodeURIComponent(handle)}` : '/invite/friend');
  const imageUrl = absoluteUrl(origin, inviteImagePath());
  const deepLink = deepLinkFor(origin, handle);

  res
    .status(200)
    .set('Content-Type', 'text/html; charset=utf-8')
    .set('Cache-Control', 'public, max-age=300')
    .send(renderInviteHtml({
      title,
      description: DESCRIPTION,
      inviteUrl,
      imageUrl,
      deepLink,
    }));
});

module.exports = router;
