#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

async function runAuthMutationGuardSmoke() {
  const dbModulePath = require.resolve('../src/db');
  const authMiddlewarePath = require.resolve('../src/middleware/auth');
  const originalDbModule = require.cache[dbModulePath];
  const originalAuthMiddleware = require.cache[authMiddlewarePath];
  const originalSecret = process.env.JWT_SECRET;
  const contexts = [];
  let accountExists = true;

  process.env.JWT_SECRET = 'auth-mutation-guard-smoke-secret';
  require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: {
      dbGet: async (sql, params) => {
        assert.equal(sql, 'SELECT id FROM users WHERE id = ?');
        assert.deepEqual(params, ['guard-user']);
        return accountExists ? { id: 'guard-user' } : null;
      },
      runWithUserContext: (userId, fn) => {
        contexts.push(userId);
        return fn();
      },
    },
    children: [],
    paths: [],
  };
  delete require.cache[authMiddlewarePath];

  const token = jwt.sign({ id: 'guard-user' }, process.env.JWT_SECRET);
  const response = () => ({
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  });
  const request = { method: 'POST', headers: { authorization: `Bearer ${token}` } };

  try {
    const auth = require('../src/middleware/auth');
    let nextCalls = 0;
    await auth(request, response(), () => { nextCalls += 1; });
    assert.equal(nextCalls, 1);
    assert.deepEqual(contexts, ['guard-user'], 'authenticated handlers must inherit the user mutation context');

    accountExists = false;
    const staleResponse = response();
    await auth(request, staleResponse, () => { nextCalls += 1; });
    assert.equal(staleResponse.statusCode, 401);
    assert.deepEqual(staleResponse.payload, { error: 'Invalid token' });
    assert.equal(nextCalls, 1, 'a deleted account must not reach the route handler');
  } finally {
    if (originalDbModule) require.cache[dbModulePath] = originalDbModule;
    else delete require.cache[dbModulePath];
    if (originalAuthMiddleware) require.cache[authMiddlewarePath] = originalAuthMiddleware;
    else delete require.cache[authMiddlewarePath];
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
  }

  const { _test } = require('../src/db');
  const queries = [];
  await _test.lockAuthenticatedUser({
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [{ id: 'guard-user' }] };
    },
  }, 'guard-user');
  assert.deepEqual(queries, [{
    sql: 'SELECT id FROM users WHERE id = $1 FOR KEY SHARE',
    params: ['guard-user'],
  }]);

  await assert.rejects(
    _test.lockAuthenticatedUser({ query: async () => ({ rows: [] }) }, 'deleted-user'),
    (err) => err.code === 'AUTH_ACCOUNT_DELETED'
  );

  const multiUserQueries = [];
  const locked = await _test.lockUserRows({
    query: async (sql, params) => {
      multiUserQueries.push({ sql, params });
      return { rows: params.map((id) => ({ id })) };
    },
  }, ['user-b', 'user-a', 'user-b'], { mode: 'update' });
  assert.deepEqual([...locked], ['user-a', 'user-b']);
  assert.deepEqual(multiUserQueries, [{
    sql: 'SELECT id FROM users WHERE id IN ($1, $2) ORDER BY id FOR UPDATE',
    params: ['user-a', 'user-b'],
  }], 'multi-user mutation locks must be canonical and acquired before route writes');

  const root = path.resolve(__dirname, '..');
  const dbSource = fs.readFileSync(path.join(root, 'src/db/index.js'), 'utf8');
  const authSource = fs.readFileSync(path.join(root, 'src/routes/auth.js'), 'utf8');
  const challengeSource = fs.readFileSync(path.join(root, 'src/routes/challenges.js'), 'utf8');
  const groupRunSource = fs.readFileSync(path.join(root, 'src/routes/groupRuns.js'), 'utf8');
  const socialFriendsSource = fs.readFileSync(path.join(root, 'src/routes/socialFriends.js'), 'utf8');
  assert.match(dbSource, /await lockAuthenticatedUser\(client, userId\)/,
    'standalone authenticated dbRun calls must guard the request user');
  assert.match(dbSource, /async function withTransaction\(fn, \{[\s\S]*userIds = \[\],[\s\S]*userLock = 'key_share'/,
    'transactions must support canonical multi-user locking');
  assert.match(dbSource, /return withTransaction\(fn, \{[\s\S]*requireUserIds: \[normalizedUserId\]/,
    'unauthenticated callback writes must require an existing user in the guarded transaction');
  assert.match(authSource, /withUserMutation\(user\.id, \(tx\) => tx\.run\(/,
    'password-reset issuance must reject writes for a concurrently deleted account');
  assert.match(authSource, /const reset = await withUserMutation\(record\.user_id,[\s\S]*password_reset_tokens[\s\S]*FOR UPDATE/,
    'password-reset consumption must lock and consume the token in the guarded user transaction');
  assert.match(authSource, /userLock: 'update', requireUserIds: \[userId\]/,
    'account deletion must acquire its update lock before reading the password row');
  assert.doesNotMatch(authSource, /password_hash FROM users WHERE id = \? FOR UPDATE/,
    'account deletion must not upgrade a pre-existing key-share lock');
  assert.ok((groupRunSource.match(/userIds: \[req\.user\.id,[^\n]+userLock: 'update'/g) || []).length >= 2,
    'group-run create and invite must lock all affected users canonically');
  assert.ok((groupRunSource.match(/skipContextUserGuard: true/g) || []).length >= 3,
    'group-run reports with dynamic subjects must discover then canonically lock both users');
  assert.ok((challengeSource.match(/userIds: \[req\.user\.id[^\n]+userLock: 'update'/g) || []).length >= 2,
    'challenge create and invite must acquire their user locks before domain-row locks');
  assert.match(challengeSource, /lockUsers\(tx, \[req\.user\.id, preview\.owner_user_id\]\)[\s\S]*FOR UPDATE OF c, viewer_uc, owner_uc/,
    'challenge reports must lock reporter and owner before challenge membership rows');
  assert.ok((socialFriendsSource.match(/skipContextUserGuard: true/g) || []).length >= 3,
    'friend operations with dynamically discovered peers must lock both users before any mutation');
  assert.ok((socialFriendsSource.match(/userIds: \[req\.user\.id[^\n]+userLock: 'update'/g) || []).length >= 2,
    'friend operations with known peers must acquire canonical update locks up front');
  assert.match(socialFriendsSource, /userIds: \[req\.user\.id, subjectUserId\], userLock: 'update'/,
    'friendship reports must lock reporter and subject before inserting moderation rows');
  const invitePreviewIndex = socialFriendsSource.indexOf('const preview = await tx.get(\n        `SELECT id, owner_id\n         FROM friend_invites');
  const inviteUserLockIndex = socialFriendsSource.indexOf('lockUsers(tx, [req.user.id, preview.owner_id])');
  const inviteRowLockIndex = socialFriendsSource.indexOf('WHERE id = ? AND owner_id = ? AND token_hash = ?');
  assert.ok(invitePreviewIndex >= 0 && invitePreviewIndex < inviteUserLockIndex && inviteUserLockIndex < inviteRowLockIndex,
    'invite resolution must lock users before locking and consuming the invite row');
  for (const route of ['whoop.js', 'oura.js', 'strava.js']) {
    const source = fs.readFileSync(path.join(root, 'src/routes', route), 'utf8');
    assert.match(source, /withUserMutation\(/, `${route} OAuth callback must reject deleted-account writes`);
  }
}

if (require.main === module) {
  runAuthMutationGuardSmoke()
    .then(() => console.log('Auth mutation guard smoke OK.'))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

module.exports = { runAuthMutationGuardSmoke };
