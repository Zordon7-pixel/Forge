#!/usr/bin/env node

const assert = require('assert');

const API_BASE = process.env.FORGE_API_BASE || 'http://127.0.0.1:4002/api';
const allowProduction = process.env.ALLOW_PRODUCTION_QA === 'true';
const apiHostname = new URL(API_BASE).hostname;
const localHosts = new Set(['127.0.0.1', 'localhost', '0.0.0.0', '::1']);
if (!localHosts.has(apiHostname) && !allowProduction) {
  throw new Error('Set ALLOW_PRODUCTION_QA=true to create disposable accounts against a non-local API.');
}

const password = 'Phase4d-QA-2026!';
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const accounts = [
  { name: 'QA Relay', email: `qa-relay-${suffix}@example.com`, handle: `relay.${suffix}`.slice(0, 24) },
  { name: 'QA Tempo', email: `qa-tempo-${suffix}@example.com`, handle: `tempo.${suffix}`.slice(0, 24) },
  { name: 'QA Trail', email: `qa-trail-${suffix}@example.com`, handle: `trail.${suffix}`.slice(0, 24) },
];
const checks = [];

function assertNoUserIds(value, location = 'payload') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!['user_id', 'owner_id', 'friend_id', 'subject_user_id', 'reporter_id'].includes(key), `${location} exposed ${key}`);
    if (key === 'user' && child && typeof child === 'object') {
      assert.strictEqual('id' in child, false, `${location}.user exposed id`);
    }
    assertNoUserIds(child, `${location}.${key}`);
  }
}

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
    throw new Error(`${method} ${path} returned ${response.status}: ${text.slice(0, 400)}`);
  }
  if (path.startsWith('/group-runs') && payload && typeof payload === 'object') {
    assertNoUserIds(payload, `${method} ${path}`);
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

async function befriend(requester, addressee) {
  await request('/social/friend-requests', {
    token: requester.token,
    method: 'POST',
    body: { handle: addressee.handle },
    expected: [200, 201],
  });
  const incoming = await request('/social/friends', { token: addressee.token });
  const requestRow = incoming.payload.incoming.find((item) => item.user.id === requester.id);
  assert.ok(requestRow?.id, `Missing incoming request for ${addressee.name}`);
  await request(`/social/friendships/${requestRow.id}`, {
    token: addressee.token,
    method: 'PATCH',
    body: { action: 'accept' },
  });
}

function futureIso(hoursAhead) {
  return new Date(Date.now() + hoursAhead * 60 * 60 * 1000).toISOString();
}

function groupRunPayload(title, startsAt, friendIds = []) {
  return {
    title,
    starts_at: startsAt,
    timezone: 'America/New_York',
    duration_minutes: 60,
    run_type: 'easy',
    goal_mode: 'distance',
    target_distance_miles: 4.5,
    pace_note: 'Conversational pace',
    target_zone: 'Zone 2',
    workout_structure: 'Easy out and back with regroup points.',
    meetup_area: 'North Creek Park',
    meetup_details: 'Meet by the west trailhead map.',
    notes: 'Disposable Phase 4D QA event.',
    route: {
      id: `qa-route-${suffix}`,
      surface: 'trail',
      distanceMiles: 4.5,
      coordinates: [[38.9, -76.9], [38.91, -76.91], [38.92, -76.92]],
    },
    participant_limit: 3,
    friend_ids: friendIds,
  };
}

(async () => {
  try {
    for (const account of accounts) {
      const registered = await request('/auth/register', {
        method: 'POST',
        body: {
          name: account.name,
          email: account.email,
          password,
          accepted_waiver_version: '2026-07-07',
        },
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
    pass('three disposable accounts registered');

    await befriend(accounts[0], accounts[1]);
    await befriend(accounts[0], accounts[2]);
    await befriend(accounts[1], accounts[2]);
    pass('all three friendship pairs accepted');

    const created = await request('/group-runs', {
      token: accounts[0].token,
      method: 'POST',
      body: groupRunPayload(`Phase 4D Matrix ${suffix}`, futureIso(4), [accounts[1].id]),
      expected: [201],
    });
    const groupRunId = created.payload.group_run_id;
    await request(`/group-runs/${groupRunId}/invite`, {
      token: accounts[0].token,
      method: 'POST',
      body: { friend_id: accounts[2].id },
      expected: [201],
    });

    for (const invitee of accounts.slice(1)) {
      const list = await request('/group-runs', { token: invitee.token });
      const invitation = list.payload.group_runs.find((run) => run.id === groupRunId);
      assert.strictEqual(invitation.membership.status, 'invited');
      assert.strictEqual(invitation.meetup_area, 'North Creek Park');
      assert.strictEqual('meetup_details' in invitation, false);
      assert.strictEqual('route' in invitation, false);

      const detail = await request(`/group-runs/${groupRunId}`, { token: invitee.token });
      assert.strictEqual(detail.payload.group_run.workout_structure.includes('Easy out and back'), true);
      assert.strictEqual('meetup_details' in detail.payload.group_run, false);
      assert.strictEqual('route' in detail.payload.group_run, false);
    }
    pass('atomic and standalone invitations expose broad details only');

    for (const invitee of accounts.slice(1)) {
      await request(`/group-runs/${groupRunId}/membership`, {
        token: invitee.token,
        method: 'PATCH',
        body: { action: 'join' },
      });
    }
    const joinedDetail = await request(`/group-runs/${groupRunId}`, { token: accounts[1].token });
    assert.strictEqual(joinedDetail.payload.group_run.meetup_details, 'Meet by the west trailhead map.');
    assert.strictEqual(joinedDetail.payload.group_run.route.coordinates.length, 3);
    assert.strictEqual(joinedDetail.payload.group_run.target_distance_miles, 4.5);
    pass('joined members receive exact meetup and private static route');

    const ownerDetail = await request(`/group-runs/${groupRunId}`, { token: accounts[0].token });
    assert.strictEqual(ownerDetail.payload.members.length, 3);
    const tempoMember = ownerDetail.payload.members.find((member) => member.user?.name === accounts[1].name);
    const trailMember = ownerDetail.payload.members.find((member) => member.user?.name === accounts[2].name);
    assert.ok(tempoMember?.owner_action?.membership_id);
    assert.ok(trailMember?.owner_action?.membership_id);
    assert.ok(ownerDetail.payload.members.every((member) => !member.user?.id));
    pass('member roster uses name-only identities and opaque owner actions');

    await request(`/group-runs/${groupRunId}`, {
      token: accounts[0].token,
      method: 'PATCH',
      body: { action: 'remove_member', membership_id: trailMember.owner_action.membership_id },
    });
    await request(`/group-runs/${groupRunId}`, { token: accounts[2].token, expected: [404] });
    await request(`/group-runs/${groupRunId}/invite`, {
      token: accounts[0].token,
      method: 'POST',
      body: { friend_id: accounts[2].id },
      expected: [201],
    });
    await request(`/group-runs/${groupRunId}/membership`, {
      token: accounts[2].token,
      method: 'PATCH',
      body: { action: 'join' },
    });
    pass('owner removal uses an opaque membership id and supports guarded reinvite');

    await request(`/group-runs/${groupRunId}/membership`, {
      token: accounts[1].token,
      method: 'PATCH',
      body: { action: 'mute', muted: true },
    });
    await request(`/group-runs/${groupRunId}/report`, {
      token: accounts[1].token,
      method: 'POST',
      body: { category: 'other', note: 'Disposable Phase 4D moderation test.' },
      expected: [201],
    });
    pass('membership mute and activity-scoped report accepted');

    await request(`/group-runs/${groupRunId}`, {
      token: accounts[0].token,
      method: 'PATCH',
      body: { action: 'cancel' },
    });
    const cancelled = await request(`/group-runs/${groupRunId}`, { token: accounts[1].token });
    assert.strictEqual(cancelled.payload.group_run.status, 'cancelled');
    assert.strictEqual('meetup_details' in cancelled.payload.group_run, false);
    assert.strictEqual('route' in cancelled.payload.group_run, false);
    pass('cancellation immediately redacts exact logistics and route');

    const blockRun = await request('/group-runs', {
      token: accounts[0].token,
      method: 'POST',
      body: groupRunPayload(`Phase 4D Blocks ${suffix}`, futureIso(5), [accounts[1].id, accounts[2].id]),
      expected: [201],
    });
    const blockRunId = blockRun.payload.group_run_id;
    for (const invitee of accounts.slice(1)) {
      await request(`/group-runs/${blockRunId}/membership`, {
        token: invitee.token,
        method: 'PATCH',
        body: { action: 'join' },
      });
    }

    await request(`/social/blocks/${accounts[2].id}`, {
      token: accounts[1].token,
      method: 'POST',
    });
    await request(`/group-runs/${blockRunId}`, { token: accounts[1].token, expected: [404] });
    await request(`/group-runs/${blockRunId}`, { token: accounts[2].token });

    await request(`/group-runs/${blockRunId}/invite`, {
      token: accounts[0].token,
      method: 'POST',
      body: { friend_id: accounts[1].id },
      expected: [201],
    });
    await request(`/group-runs/${blockRunId}/membership`, {
      token: accounts[1].token,
      method: 'PATCH',
      body: { action: 'join' },
    });
    await request(`/social/blocks/${accounts[0].id}`, {
      token: accounts[1].token,
      method: 'POST',
    });
    await request(`/group-runs/${blockRunId}`, { token: accounts[1].token, expected: [404] });

    await request(`/social/blocks/${accounts[2].id}`, {
      token: accounts[0].token,
      method: 'POST',
    });
    await request(`/group-runs/${blockRunId}`, { token: accounts[2].token, expected: [404] });
    const ownerAfterBlocks = await request(`/group-runs/${blockRunId}`, { token: accounts[0].token });
    assert.strictEqual(ownerAfterBlocks.payload.members.length, 1);
    pass('all three blocking-role revocation rules enforced immediately');

    console.log(`Phase 4D API matrix passed ${checks.length} grouped checks against ${API_BASE}`);
  } finally {
    for (const account of [...accounts].reverse()) await deleteAccount(account);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
