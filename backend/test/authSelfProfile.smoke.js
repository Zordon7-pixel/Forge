// Real auth middleware/route and SQL against disposable in-memory SQLite only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const express = require('express');
const fixture = require('./helpers/adaptiveShadowDb').createDb({ syntheticProfileFields: false });
const { db } = fixture;
// The shared planner fixture omits profile columns added by application startup.
const startup = fs.readFileSync(path.join(__dirname, '../src/db/index.js'), 'utf8');
const columns = new Set(db.prepare('PRAGMA table_info(users)').all().map(column => column.name));
for (const match of startup.matchAll(/['"](ALTER TABLE users ADD COLUMN IF NOT EXISTS (\w+) [^\n]+)['"],?$/gm)) {
  if (!columns.has(match[2])) {
    db.exec(match[1].replace('ADD COLUMN IF NOT EXISTS', 'ADD COLUMN'));
    columns.add(match[2]);
  }
}
const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.pg.sql'), 'utf8');
db.exec(schema.match(/CREATE TABLE IF NOT EXISTS user_consents \([\s\S]*?\n\);/)[0]);
fixture.exports.runWithUserContext = (_id, next) => next();
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fixture.exports };
process.env.JWT_SECRET = 'synthetic-self-profile-test-only';
const app = express();
app.use('/api/auth', require('../src/routes/auth'));

const users = [
  { id: 'hidden-owner', handle: 'hidden_runner', discoverable: 0 },
  { id: 'visible-owner', handle: 'visible_lifter', discoverable: 1 },
  { id: 'unset-owner', handle: null, discoverable: 0 },
];
for (const user of users) {
  db.prepare(`INSERT INTO users (id, name, email, password_hash, friend_handle, friend_discoverable)
    VALUES (?, 'Synthetic', ?, '', ?, ?)`).run(
    user.id, `${user.id}@example.invalid`, user.handle, user.discoverable
  );
}
const snapshot = () => db.prepare('SELECT * FROM users ORDER BY id').all();
const before = snapshot();
let server;

async function main() {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/auth/me`;
  async function request(userId, query = '') {
    const headers = userId ? {
      Authorization: `Bearer ${jwt.sign({ id: userId, friend_handle: 'stale_claim' }, process.env.JWT_SECRET)}`,
    } : {};
    const response = await fetch(base + query, { headers });
    return { status: response.status, data: await response.json() };
  }

  for (const user of users) {
    // User-supplied selectors must never override the signed-in identity.
    const other = users.find(candidate => candidate.id !== user.id && candidate.handle);
    const result = await request(user.id, `?id=${other.id}&user_id=${other.id}&friend_handle=${other.handle}`);
    assert.equal(result.status, 200);
    assert.deepEqual(Object.keys(result.data), ['user']);
    assert.equal(result.data.user.id, user.id);
    assert.ok(Object.hasOwn(result.data.user, 'friend_handle'), 'unset handles must not be omitted');
    assert.equal(result.data.user.friend_handle, user.handle);
    if (user.handle !== null) assert.equal(typeof result.data.user.friend_handle, 'string');
    const serialized = JSON.stringify(result.data);
    for (const foreign of users.filter(candidate => candidate.id !== user.id && candidate.handle)) {
      assert.equal(serialized.includes(foreign.handle), false, 'no other user handle anywhere in the response');
    }
    assert.equal(serialized.includes('stale_claim'), false, 'handle comes from the database, not JWT claims');
    console.log(`PASS self profile: ${user.id}, own handle only`);
  }

  for (const userId of [null, 'deleted-owner']) {
    const result = await request(userId);
    assert.equal(result.status, 401);
    assert.deepEqual(Object.keys(result.data), ['error']);
    for (const user of users.filter(candidate => candidate.handle)) {
      assert.equal(JSON.stringify(result.data).includes(user.handle), false);
    }
    console.log(`PASS self profile: ${userId || 'unauthenticated'} rejected without handles`);
  }
  assert.ok(fixture.calls.every(call => call.method === 'get'), 'self profile must perform reads only');
  assert.deepEqual(snapshot(), before, 'handles and discoverability must remain unchanged');
  console.log('PASS self profile: read-only, discoverability unchanged');
  console.log('AUTH SELF PROFILE SMOKE OK (6 cases)');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (server) server.close();
  db.close();
});
