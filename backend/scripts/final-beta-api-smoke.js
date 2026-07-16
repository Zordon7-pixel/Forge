#!/usr/bin/env node

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const baseUrl = String(process.env.FORGE_API_BASE || '').replace(/\/$/, '');
const mutationGuard = process.env.FORGE_LIVE_MUTATION_TEST === '1';
const requireEmailGuard = process.env.FORGE_EXPECT_EMAIL_GUARD !== '0';

if (!mutationGuard || !baseUrl) {
  console.error('Refusing to run. Set FORGE_LIVE_MUTATION_TEST=1 and FORGE_API_BASE=https://...');
  process.exit(2);
}

const waiverVersion = '2026-07-07';
const password = `Forge!${randomUUID().replaceAll('-', '').slice(0, 14)}`;
const nonce = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const accounts = [];
const checks = [];

function record(label) {
  checks.push(label);
  console.log(`PASS ${label}`);
}

async function api(method, path, options = {}) {
  const headers = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const raw = await response.text();
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${method} ${path} returned non-JSON (${response.status}): ${raw.slice(0, 160)}; ${err.message}`);
    }
  }

  const expected = Array.isArray(options.expected) ? options.expected : [options.expected ?? 200];
  if (!expected.includes(response.status)) {
    throw new Error(`${method} ${path} expected ${expected.join('/')} but got ${response.status}: ${raw.slice(0, 300)}`);
  }
  return { status: response.status, data, headers: response.headers };
}

async function register(label) {
  const email = `codex-forge-${label}-${nonce}@example.com`;
  const result = await api('POST', '/api/auth/register', {
    expected: 201,
    body: {
      name: `Codex ${label} Synthetic`,
      email,
      password,
      accepted_waiver_version: waiverVersion,
    },
  });
  assert.ok(result.data?.token, `${label} registration must return a token`);
  const account = { label, email, token: result.data.token, deleted: false };
  accounts.push(account);
  return account;
}

async function deleteAccount(account) {
  if (!account?.token || account.deleted) return;
  const result = await api('DELETE', '/api/auth/account', {
    token: account.token,
    expected: 200,
    body: { password, confirm: 'DELETE' },
  });
  assert.equal(result.data?.ok, true);
  account.deleted = true;
}

async function cleanup() {
  for (const account of accounts.reverse()) {
    if (account.deleted) continue;
    try {
      await deleteAccount(account);
      console.log(`CLEANED ${account.label}`);
    } catch (err) {
      console.error(`CLEANUP FAILED ${account.label}:`, err.message);
    }
  }
}

async function main() {
  if (requireEmailGuard) {
    const malformed = await api('POST', '/api/auth/register', {
      expected: 400,
      body: {
        name: 'Codex Invalid Email Synthetic',
        email: `codex-invalid-${nonce}`,
        password,
        accepted_waiver_version: waiverVersion,
      },
    });
    assert.match(String(malformed.data?.error || ''), /valid email/i);
    record('backend rejects malformed registration email');
  }

  const alpha = await register('alpha');
  const bravo = await register('bravo');
  record('two isolated synthetic accounts registered');

  await api('POST', '/api/auth/login', {
    expected: 401,
    body: { email: alpha.email, password: `${password}-wrong` },
  });
  const login = await api('POST', '/api/auth/login', {
    expected: 200,
    body: { email: alpha.email, password },
  });
  assert.ok(login.data?.token);
  alpha.token = login.data.token;
  await api('GET', '/api/runs', { expected: 401 });
  record('login success/failure and no-auth protection');

  await api('PUT', '/api/auth/me/profile', {
    token: alpha.token,
    expected: 400,
    body: { age: 9 },
  });
  const profileUpdate = await api('PUT', '/api/auth/me/profile', {
    token: alpha.token,
    expected: 200,
    body: {
      name: 'Codex Alpha Updated',
      age: 35,
      sex: 'male',
      weight_lbs: 180,
      max_heart_rate: 190,
      weekly_miles_current: 20,
      run_days_per_week: 4,
      lift_days_per_week: 2,
      primary_goal: 'hybrid',
      units: 'imperial',
    },
  });
  assert.equal(profileUpdate.data?.user?.name, 'Codex Alpha Updated');
  const profile = await api('GET', '/api/auth/me', { token: alpha.token });
  assert.equal(profile.data?.user?.age, 35);
  assert.equal(profile.data?.user?.waiver_current, true);
  record('profile validation, update, and readback');

  await api('PUT', '/api/profile/hr-zones', {
    token: alpha.token,
    expected: 400,
    body: { maxHr: 190, restingHr: 55, lthr: null, zoneModel: 'custom', customMinimums: [96, 117, 137] },
  });
  const hrSave = await api('PUT', '/api/profile/hr-zones', {
    token: alpha.token,
    body: { maxHr: 190, restingHr: 55, lthr: null, zoneModel: 'custom', customMinimums: [96, 117, 137, 156, 176] },
  });
  assert.deepEqual(hrSave.data?.profile?.customMinimums, [96, 117, 137, 156, 176]);
  const hrRead = await api('GET', '/api/profile/hr-zones', { token: alpha.token });
  assert.equal(hrRead.data?.profile?.zoneModel, 'custom');
  assert.equal(hrRead.data?.zones?.length, 5);
  record('heart-rate zone validation and round trip');

  await api('POST', '/api/health/sync', {
    token: alpha.token,
    expected: 400,
    body: { steps_today: 250001 },
  });
  const droppedSleep = await api('POST', '/api/health/sync', {
    token: alpha.token,
    body: { sleep_hours_last_night: 17 },
  });
  assert.deepEqual(droppedSleep.data?.droppedFields, ['sleep_hours_last_night']);
  const recordedAt = new Date(Date.now() - 60_000).toISOString();
  await api('POST', '/api/health/sync', {
    token: alpha.token,
    body: {
      steps_today: 12345,
      calories_today: 640,
      avg_heart_rate_last_run: 150,
      total_miles_this_week: 7.31,
      resting_heart_rate: 55,
      hrv_ms: 62,
      sleep_hours_last_night: 7.5,
      active_minutes_this_week: 92,
      workout_count_this_week: 2,
      last_workout_type: 'Running',
      last_workout_duration_seconds: 5040,
      last_workout_calories: 958,
      metrics_schema_version: 2,
      vo2_max: 49.2,
      running_power_watts: 315,
      running_stride_length_m: 0.9,
      running_vertical_oscillation_cm: 8.3,
      running_ground_contact_time_ms: 269,
      running_dynamics_recorded_at: recordedAt,
    },
  });
  const health = await api('GET', '/api/health/sync', { token: alpha.token });
  assert.equal(health.data?.steps_today, 12345);
  assert.equal(Number(health.data?.sleep_hours_last_night), 7.5);
  assert.equal(Number(health.data?.running_power_watts), 315);
  record('health validation, dropped-field signal, and advanced metric round trip');

  const today = new Date().toISOString().slice(0, 10);
  await api('POST', '/api/checkin', {
    token: alpha.token,
    expected: 400,
    body: { date: '07/14/2026', legs: 2, drive: 2, time_available: 60 },
  });
  const checkin = await api('POST', '/api/checkin', {
    token: alpha.token,
    body: { date: today, legs: 2, drive: 3, time_available: 75, life_flags: ['all_good', 'not_allowed'] },
  });
  assert.equal(checkin.data?.ok, true);
  const todayCheckin = await api('GET', `/api/checkin/today?date=${today}`, { token: alpha.token });
  assert.equal(todayCheckin.data?.checkin_date, today);
  assert.deepEqual(JSON.parse(todayCheckin.data?.life_flags || '[]'), ['all_good']);
  record('check-in validation, filtering, and readback');

  const startBase = Date.now() - 2 * 60 * 60 * 1000;
  const importedRows = [
    {
      type: 'Running',
      startDate: new Date(startBase).toISOString(),
      endDate: new Date(startBase + 5040 * 1000).toISOString(),
      distanceMiles: 7.31,
      durationSeconds: 5040,
      avgHeartRate: 150,
      maxHeartRate: 174,
      zoneSeconds: { z1: 31, z2: 171, z3: 2713, z4: 1785, z5: 0 },
      cadenceSpm: 167,
      calories: 958,
      source: 'codex_final_beta_smoke',
    },
    {
      type: 'Walking',
      startDate: new Date(startBase - 24 * 60 * 60 * 1000).toISOString(),
      endDate: new Date(startBase - 24 * 60 * 60 * 1000 + 369 * 1000).toISOString(),
      distanceMiles: 0.29,
      durationSeconds: 369,
      avgHeartRate: 129,
      maxHeartRate: 142,
      source: 'codex_final_beta_smoke',
    },
  ];
  const firstImport = await api('POST', '/api/import/health', { token: alpha.token, body: { workouts: importedRows } });
  assert.equal(firstImport.data?.imported, 2);
  const secondImport = await api('POST', '/api/import/health', { token: alpha.token, body: { workouts: importedRows } });
  assert.equal(secondImport.data?.imported, 0);
  assert.equal(secondImport.data?.skipped, 2);
  const runList = await api('GET', '/api/runs', { token: alpha.token });
  const importedRun = runList.data?.runs?.find((run) => Number(run.distance_miles) === 7.31);
  const importedWalk = runList.data?.runs?.find((run) => Number(run.distance_miles) === 0.29);
  assert.equal(importedRun?.type, 'easy');
  assert.equal(importedWalk?.type, 'walk');
  await api('PUT', `/api/runs/${importedRun.id}`, {
    token: bravo.token,
    expected: 404,
    body: { notes: 'cross-user attempt' },
  });
  const updatedRun = await api('PATCH', `/api/runs/${importedRun.id}`, {
    token: alpha.token,
    body: { notes: 'Synthetic run verified', pain_level: 'none', post_energy: 'high' },
  });
  assert.equal(updatedRun.data?.notes, 'Synthetic run verified');
  record('Apple Health run/walk classification, idempotency, update, and ownership');

  await api('POST', '/api/lifts', {
    token: alpha.token,
    expected: 400,
    body: { date: today, exercise_name: 'Bench Press', sets: 3, reps: 101, weight_lbs: 185 },
  });
  const liftCreate = await api('POST', '/api/lifts', {
    token: alpha.token,
    expected: 201,
    body: { date: today, exercise_name: 'Bench Press', muscle_groups: ['chest'], intensity: 'moderate', sets: 3, reps: 8, weight_lbs: 185 },
  });
  const liftId = liftCreate.data?.id;
  assert.ok(liftId);
  await api('PUT', `/api/lifts/${liftId}`, { token: bravo.token, expected: 404, body: { notes: 'cross-user attempt' } });
  const liftUpdate = await api('PUT', `/api/lifts/${liftId}`, { token: alpha.token, body: { reps: 6, notes: 'Synthetic lift verified' } });
  assert.equal(liftUpdate.data?.reps, 6);
  record('lift validation, create/update, and ownership');

  const sessionStart = await api('POST', '/api/workouts/start', {
    token: alpha.token,
    expected: 201,
    body: { muscle_groups: ['legs'] },
  });
  const sessionId = sessionStart.data?.session?.id;
  assert.ok(sessionId);
  await api('POST', `/api/workouts/${sessionId}/sets`, {
    token: bravo.token,
    expected: 404,
    body: { exercise_name: 'Squat', muscle_group: 'legs', reps: 5, weight_lbs: 225, set_number: 1 },
  });
  await api('POST', `/api/workouts/${sessionId}/sets`, {
    token: alpha.token,
    expected: 201,
    body: { exercise_name: 'Squat', muscle_group: 'legs', reps: 5, weight_lbs: 225, set_number: 1 },
  });
  const sessionSets = await api('GET', `/api/workouts/${sessionId}/sets`, { token: alpha.token });
  assert.equal(sessionSets.data?.sets?.length, 1);
  const sessionEnd = await api('PUT', `/api/workouts/${sessionId}/end`, { token: alpha.token, body: { notes: 'Synthetic session verified' } });
  assert.equal(sessionEnd.data?.ok, true);
  await api('DELETE', `/api/workouts/${sessionId}`, { token: bravo.token, expected: 404 });
  await api('DELETE', `/api/workouts/${sessionId}`, { token: alpha.token });
  record('workout start/set/end/delete and cross-user protection');

  const raceCreate = await api('POST', '/api/races', {
    token: alpha.token,
    expected: 201,
    body: { race_name: 'Codex Synthetic Ten Miler', race_date: '2027-10-11', distance_miles: 10, location: 'Synthetic, VA', goal_time_seconds: 5400 },
  });
  const raceId = raceCreate.data?.race?.id;
  assert.ok(raceId);
  await api('PATCH', `/api/races/${raceId}`, { token: bravo.token, expected: 404, body: { notes: 'cross-user attempt' } });
  const raceUpdate = await api('PATCH', `/api/races/${raceId}`, { token: alpha.token, body: { notes: 'Synthetic race verified' } });
  assert.equal(raceUpdate.data?.race?.notes, 'Synthetic race verified');
  await api('DELETE', `/api/races/${raceId}`, { token: alpha.token });
  record('race create/update/delete and ownership');

  const shoeCreate = await api('POST', '/api/gear/shoes', {
    token: alpha.token,
    expected: 201,
    body: { brand: 'Codex', model: 'Synthetic Trainer', nickname: 'QA Shoe', category: 'daily_trainer' },
  });
  const shoeId = shoeCreate.data?.id;
  assert.ok(shoeId);
  await api('PATCH', `/api/gear/shoes/${shoeId}`, { token: bravo.token, expected: 404, body: { nickname: 'cross-user attempt' } });
  const shoeUpdate = await api('PATCH', `/api/gear/shoes/${shoeId}`, { token: alpha.token, body: { nickname: 'QA Shoe Updated' } });
  assert.equal(shoeUpdate.data?.nickname, 'QA Shoe Updated');
  await api('DELETE', `/api/gear/shoes/${shoeId}`, { token: alpha.token });
  record('gear create/update/delete and ownership');

  const injuryCreate = await api('POST', '/api/injury', {
    token: alpha.token,
    expected: 201,
    body: { body_part: 'left calf', pain_level: 2, notes: 'synthetic test', date: today },
  });
  const injuryId = injuryCreate.data?.injury?.id;
  assert.ok(injuryId);
  await api('PUT', `/api/injury/${injuryId}/clear`, { token: bravo.token, expected: 404 });
  const injuryClear = await api('PUT', `/api/injury/${injuryId}/clear`, { token: alpha.token });
  assert.equal(Number(injuryClear.data?.injury?.cleared), 1);
  record('injury create/clear and ownership');

  await api('POST', '/api/feedback', {
    token: alpha.token,
    expected: 400,
    body: { type: 'feature_request', category: 'AI Coach', page: '/synthetic-final-beta-smoke', message: 'I do not have' },
  });
  const createdFeedback = await api('POST', '/api/feedback', {
    token: alpha.token,
    body: { type: 'bug', severity: 'low', page: '/synthetic-final-beta-smoke', message: `Synthetic feedback ${nonce}` },
  });
  assert.equal(createdFeedback.data?.duplicate, false);
  const duplicateFeedback = await api('POST', '/api/feedback', {
    token: alpha.token,
    body: { type: 'bug', severity: 'low', page: '/synthetic-final-beta-smoke', message: `Synthetic feedback ${nonce}` },
  });
  assert.equal(duplicateFeedback.data?.duplicate, true);
  assert.equal(duplicateFeedback.data?.id, createdFeedback.data?.id);
  const feedback = await api('GET', '/api/feedback', { token: alpha.token });
  const feedbackEntry = feedback.data?.feedback?.find((entry) => entry.message === `Synthetic feedback ${nonce}`);
  assert.ok(feedbackEntry);
  assert.equal(feedbackEntry.status, 'new');
  assert.equal(feedbackEntry.support_note, undefined);
  record('feedback validation, idempotency, safe user-scoped readback');

  const exported = await api('GET', '/api/auth/me/export', { token: alpha.token });
  assert.equal(exported.data?.account?.email, alpha.email);
  assert.equal(exported.data?.account?.password_hash, undefined);
  assert.ok(Array.isArray(exported.data?.runs));
  assert.ok(Array.isArray(exported.data?.lifts));
  record('account export includes user data and excludes password hash');

  await api('DELETE', `/api/runs/${importedRun.id}`, { token: bravo.token, expected: 404 });
  await api('DELETE', `/api/runs/${importedRun.id}`, { token: alpha.token });
  await api('DELETE', `/api/runs/${importedWalk.id}`, { token: alpha.token });
  await api('DELETE', `/api/lifts/${liftId}`, { token: alpha.token });
  record('run/lift deletion and cross-user protection');

  await deleteAccount(bravo);
  await deleteAccount(alpha);
  await api('POST', '/api/auth/login', { expected: 401, body: { email: alpha.email, password } });
  record('account deletion and post-delete login rejection');

  console.log(`FINAL BETA API SMOKE PASSED: ${checks.length} workflow groups`);
}

main()
  .catch(async (err) => {
    console.error('FINAL BETA API SMOKE FAILED:', err.stack || err.message);
    process.exitCode = 1;
  })
  .finally(cleanup);
