#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

const app = read('backend/src/app.js');
const route = read('backend/src/routes/invitePreview.js');
const community = read('frontend/src/pages/Community.jsx');

const inviteMountIndex = app.indexOf("app.use('/invite', require('./routes/invitePreview'))");
const inviteAssetIndex = app.indexOf("app.use('/assets', express.static(path.join(__dirname, '../../frontend/public/assets')))");
const staticIndex = app.indexOf('app.use(express.static(dist))');
const fallbackIndex = app.indexOf("app.get('*'");
assert.ok(inviteMountIndex >= 0, 'invite preview route is mounted');
assert.ok(inviteAssetIndex >= 0, 'invite card assets are mounted');
assert.ok(inviteMountIndex < staticIndex, 'invite preview route is mounted before static assets');
assert.ok(inviteAssetIndex < staticIndex, 'invite card assets are mounted before frontend dist fallback');
assert.ok(inviteMountIndex < fallbackIndex, 'invite preview route is mounted before SPA fallback');

for (const tag of [
  'og:title',
  'og:description',
  'og:image',
  'og:url',
  'og:type',
  'twitter:card',
  'twitter:title',
  'twitter:description',
  'twitter:image',
  'summary_large_image',
]) {
  assert.ok(route.includes(tag), `invite preview HTML includes ${tag}`);
}

assert.ok(route.includes('normalizeFriendHandle(req.params.handle)'), 'invite route normalizes handles');
assert.ok(route.includes('friend_discoverable = 1'), 'invite route only personalizes discoverable handles');
assert.ok(route.includes('SELECT name, friend_handle') && !route.includes('email'), 'invite route does not select email');
assert.ok(route.includes('escapeHtml('), 'invite route escapes interpolated HTML');
assert.ok(route.includes("'/community'") && route.includes("url.searchParams.set('handle', handle)"), 'invite route redirects to the add-friend deep link');
assert.ok(route.includes("'/icon-512.png'") || route.includes("'/assets/invite-card.png'"), 'invite route uses a stable public image URL');
assert.ok(fs.existsSync(path.join(repoRoot, 'frontend/public/assets/invite-card.png')), 'invite card image exists in public assets');

assert.ok(community.includes("new URL(`/invite/${encodeURIComponent(normalized)}`, window.location.origin)"), 'frontend share action builds /invite/{handle}');
assert.ok(community.includes("searchParams.get('handle')"), 'frontend consumes add-friend handle deep links');

console.log('Invite preview smoke passed');
