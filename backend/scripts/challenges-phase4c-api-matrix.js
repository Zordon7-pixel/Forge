#!/usr/bin/env node

const assert = require('assert');

const API_BASE = process.env.FORGE_API_BASE || 'http://127.0.0.1:4002/api';
const allowProduction = process.env.ALLOW_PRODUCTION_QA === 'true';
if (/forge-production|forgeathlete\.app/.test(API_BASE) && !allowProduction) {
  throw new Error('Set ALLOW_PRODUCTION_QA=true to create disposable accounts against production.');
}

const password = 'Phase4c-QA-2026!';
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const accounts = [
  { name: 'QA Hammer', email: `qa-hammer-${suffix}@example.com`, handle: `hammer.${suffix}`.slice(0, 24) },
  { name: 'QA Anvil', email: `qa-anvil-${suffix}@example.com`, handle: `anvil.${suffix}`.slice(0, 24) },
  { name: 'QA Ember', email: `qa-ember-${suffix}@example.com`, handle: `ember.${suffix}`.slice(0, 24) },
];
const checks = [];

async function request(path, { token, method = 'GET', body, expected = [200] } = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!expected.includes(response.status)) {
    throw new Error(`${method} ${path} returned ${response.status}: ${text.slice(0, 300)}`);
  }
  return { status: response.status, payload };
}

function pass(label) {
  checks.push(label);
  console.log(`PASS ${label}`);
}

async function deleteAccount(account) {
  if (!account.token) return;
  try {
    await request('/auth/account', {
      token: account.token,
      method: 'DELETE',
      body: { password, confirm: 'DELETE' },
      expected: [200, 401, 404],
    });
  } catch (error) {
    console.error(`Cleanup failed for ${account.email}:`, error.message);
  }
}

(async () => {
  try {
    for (const account of accounts) {
      const registered = await request('/auth/register', {
        method: 'POST',
        body: { name: account.name, email: account.email, password, accepted_waiver_version: '2026-07-07' },
        expected: [201],
      });
      account.token = registered.payload.token;
      account.id = registered.payload.user.id;
      await request('/social/friend-discovery-profile', {
        token: account.token,
        method: 'PUT',
        body: { handle: account.handle, discoverable: true },
      });
    }
    pass('three disposable accounts registered with exact handles');

    for (const friend of accounts.slice(1)) {
      await request('/social/friend-requests', {
        token: accounts[0].token,
        method: 'POST',
        body: { handle: friend.handle },
        expected: [200, 201],
      });
      const incoming = await request('/social/friends', { token: friend.token });
      const requestRow = incoming.payload.incoming.find((item) => item.user.id === accounts[0].id);
      assert.ok(requestRow?.id);
      await request(`/social/friendships/${requestRow.id}`, {
        token: friend.token,
        method: 'PATCH',
        body: { action: 'accept' },
      });
    }
    pass('owner established two accepted friendships');

    const today = new Date();
    today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
    const challengeDate = today.toISOString().slice(0, 10);
    const created = await request('/challenges', {
      token: accounts[0].token,
      method: 'POST',
      body: {
        name: `Phase 4C Matrix ${suffix}`,
        template_type: 'hybrid_balance',
        start_date: challengeDate,
        duration_days: 7,
        run_target: 4,
        run_unit: 'miles',
        lift_target: 1,
        verification_policy: 'all_activity',
        timezone: 'America/New_York',
      },
      expected: [201],
    });
    const challengeId = created.payload.challenge_id;
    const ownerFriends = await request('/social/friends', { token: accounts[0].token });
    for (const friend of accounts.slice(1)) {
      const friendRow = ownerFriends.payload.friends.find((item) => item.user.id === friend.id);
      assert.ok(friendRow?.user?.id);
      await request(`/challenges/${challengeId}/invite`, {
        token: accounts[0].token,
        method: 'POST',
        body: { friend_id: friendRow.user.id },
        expected: [201],
      });
      await request(`/challenges/${challengeId}/membership`, {
        token: friend.token,
        method: 'PATCH',
        body: { action: 'join' },
      });
    }
    pass('friend-only invitations joined a private hybrid challenge');

    for (const athlete of accounts.slice(1)) {
      await request('/runs', {
        token: athlete.token,
        method: 'POST',
        body: {
          date: challengeDate,
          type: 'easy',
          distance_miles: 2,
          duration_seconds: 1200,
          perceived_effort: 4,
          target_zone: 'Z2',
        },
        expected: [201],
      });
    }
    await request('/workouts/strength', {
      token: accounts[1].token,
      method: 'POST',
      body: { name: 'Phase 4C strength', sets: [], completed_at: new Date().toISOString() },
      expected: [201],
    });
    await request('/lifts', {
      token: accounts[2].token,
      method: 'POST',
      body: { date: challengeDate, exercise_name: 'Legacy QA row', sets: 3, reps: 8, weight_lbs: 100 },
      expected: [201],
    });
    pass('canonical strength and ambiguous legacy lift fixtures recorded');

    const board = await request(`/challenges/${challengeId}/leaderboard`, { token: accounts[0].token });
    assert.strictEqual(board.payload.participant_count, 3);
    assert.deepStrictEqual(board.payload.rows.map((row) => row.rank), [1, 2, 2]);
    const anvil = board.payload.rows.find((row) => row.user?.name === accounts[1].name);
    const ember = board.payload.rows.find((row) => row.user?.name === accounts[2].name);
    assert.strictEqual(anvil.progress.qualifying_counts.strength_sessions, 1);
    assert.strictEqual(ember.progress.qualifying_counts.strength_sessions, 0);
    assert.ok(board.payload.rows.every((row) => !row.user?.id));
    assert.ok(board.payload.rows.filter((row) => !row.is_self).every((row) => row.owner_action?.membership_id));
    pass('leaderboard ties, source identity, and user-id privacy verified');

    await request(`/challenges/${challengeId}/report`, {
      token: accounts[1].token,
      method: 'POST',
      body: { category: 'other', note: 'Disposable Phase 4C moderation test.' },
      expected: [201],
    });
    pass('joined member submitted a challenge-scoped moderation report');

    await request(`/challenges/${challengeId}`, {
      token: accounts[0].token,
      method: 'PATCH',
      body: { action: 'remove_member', membership_id: ember.owner_action.membership_id },
    });
    const afterRemoval = await request(`/challenges/${challengeId}/leaderboard`, { token: accounts[0].token });
    assert.strictEqual(afterRemoval.payload.participant_count, 2);
    await request(`/challenges/${challengeId}/leaderboard`, { token: accounts[2].token, expected: [404] });
    pass('owner removal uses opaque membership id and restores nonmember concealment');

    console.log(`Phase 4C API matrix passed ${checks.length} grouped checks against ${API_BASE}`);
  } finally {
    for (const account of [...accounts].reverse()) await deleteAccount(account);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
