// Explicit opt-in real HTTP/PostgreSQL gate. It creates and drops ONLY its own
// unique empty database on the coordinator's disposable loopback cluster.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Pool } = require('pg');
const rootUrl = new URL(process.env.DATABASE_URL || 'postgresql://invalid');
assert.equal(rootUrl.hostname, '127.0.0.1', 'Integration gate is loopback-only');
assert.equal(rootUrl.port, '55439', 'Integration gate requires the disposable cluster');
assert.equal(rootUrl.username, 'forge_program_test');
assert.equal(rootUrl.pathname, '/forge_program_test');
assert.equal(rootUrl.search, '', 'No connection parameter overrides');
const databaseName = `forge_program_test_${crypto.randomBytes(6).toString('hex')}`;
const admin = new Pool({ connectionString: rootUrl.toString() });
let server, db, postgres, created = false;

async function main() {
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const childUrl = new URL(rootUrl); childUrl.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = childUrl.toString();
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
  process.env.FORGE_BETA_ACCESS = 'true';
  process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'on';
  process.env.FORGE_GOAL_BACKWARD_V24_AUDIENCE = 'all';
  for (const key of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','GEMINI_API_KEY']) delete process.env[key];
  db = require('../src/db');
  postgres = require('../src/db/postgres');
  await db.initDb();
  await require('../src/db/migrate').runAlwaysMigrations();
  const express = require('express');
  const lifecycle = require('../src/lib/planCandidateLifecycle');
  const persist = lifecycle.persistGoalBackwardDecisionArtifacts;
  lifecycle.persistGoalBackwardDecisionArtifacts = async function (input) {
    if (process.env.PROGRAM_TEST_DETAILS === '1') {
      for (const artifact of input.artifacts) {
        const encoded = JSON.stringify(artifact.payload_json);
        const sized = await input.tx.get('SELECT pg_column_size(?::jsonb) AS bytes', [encoded]);
        console.log(JSON.stringify({ artifact_kind: artifact.artifact_kind, json_bytes: Buffer.byteLength(encoded), jsonb_bytes: sized.bytes }));
      }
    }
    return persist(input);
  };
  const engine = require('../src/lib/racePlanCandidateEngine');
  const construct = engine.buildRacePlanCandidate;
  engine.buildRacePlanCandidate = function (...args) {
    const result = construct(...args);
    if ((!result.validation.valid || args[0]?.target?.raceTargets?.length > 1) && process.env.PROGRAM_TEST_DETAILS === '1') {
      const diagnosticPath = `/tmp/${databaseName}-failed-constructor.json`;
      require('node:fs').writeFileSync(diagnosticPath, JSON.stringify({ context: args[0], options: args[1], result }));
      console.log(JSON.stringify({ gate: 'disposable-constructor-diagnostic', diagnosticPath }));
    }
    return result;
  };
  const enumerate = engine.enumerateGoalBackwardCandidates;
  let lastRejectedWindow;
  const weeklySelections = [];
  engine.enumerateGoalBackwardCandidates = function (...args) {
    const result = enumerate(...args);
    weeklySelections.push({ date: args[0].decision.planning_date_local,
      phase: args[0].decision.phase, source: args[0].legacy_road_candidate_material.map(session => ({
        id: session.id || session.session_id, date: session.date, family: session.workout_family,
        kind: session.kind, duration_min: session.duration_min })),
      selected: result.selected_candidate?.sessions.map(session => ({ date: session.scheduled_local_date, family: session.workout_family })) });
    if (!result.selected_candidate) lastRejectedWindow = {
      date: result.decision.planning_date_local, training_age: result.decision.training_age_class,
      recent_normal: result.decision.recent_normal_running_range_m,
      violations: result.candidates[0]?.validation?.violations,
      sessions: result.candidates[0]?.sessions.map(session => ({ family: session.workout_family,
        date: session.scheduled_local_date, duration_s: session.derived_totals?.duration_s, vector: session.stress_vector })),
      material_dose: result.candidates[0]?.validation?.validator_results?.find(entry => entry.validator === 'material_dose'),
    };
    return result;
  };
  const app = express(); app.use(express.json({ limit: '2mb' }));
  for (const route of ['auth','races','runs','plans','workouts']) app.use(`/api/${route}`, require(`../src/routes/${route}`));
  server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  let token;
  async function request(method, path, body) {
    const started = performance.now();
    const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json',
      'x-forged-local-date': '2026-09-10',
      ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), elapsed_ms: Math.round(performance.now() - started) };
  }
  const registered = await request('POST', '/auth/register', { name: 'Disposable complete-program test',
    email: `${databaseName}@example.invalid`, password: crypto.randomBytes(24).toString('hex'),
    accepted_waiver_version: require('../src/lib/waiverText').WAIVER_VERSION });
  assert.equal(registered.status, 201, JSON.stringify(registered.data)); token = registered.data.token;
  const owner = registered.data.user.id;
  const all = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const frequency = Number(process.env.PROGRAM_TEST_FREQUENCY || 4);
  const liftFrequency = Number(process.env.PROGRAM_TEST_LIFT_FREQUENCY || frequency);
  const planMode = process.env.PROGRAM_TEST_MODE || 'hybrid_maintain';
  assert.ok([3, 4, 7].includes(frequency) && [2, 3, 4, 7].includes(liftFrequency), 'Explicit guarded acceptance frequencies');
  assert.ok(['hybrid_maintain', 'hybrid_build'].includes(planMode));
  const raceDate = process.env.PROGRAM_TEST_HORIZON === '20' ? '2027-01-24' : '2026-10-11';
  const expectedWeeks = process.env.PROGRAM_TEST_HORIZON === '20' ? 20 : 5;
  for (const malformed of [null, true, false, '', 8, 1.5]) {
    const rejected = await request('PUT', '/auth/me/profile', { run_days_per_week: malformed });
    assert.equal(rejected.status, 400, `Invalid run frequency ${JSON.stringify(malformed)}`);
  }
  const seven = await request('PUT', '/auth/me/profile', { run_days_per_week: 7, lift_days_per_week: 7,
    run_eligible_weekdays: all, lift_eligible_weekdays: all });
  assert.equal(seven.status, 200, JSON.stringify(seven.data));
  assert.equal(seven.data.user.run_days_per_week, 7);
  assert.equal(seven.data.user.lift_days_per_week, 7);
  const profile = await request('PUT', '/auth/me/profile', { run_days_per_week: frequency, lift_days_per_week: liftFrequency,
    preferred_workout_days: ['Tue','Thu','Sat','Sun'], run_eligible_weekdays: all, lift_eligible_weekdays: all,
    ...(process.env.PROGRAM_TEST_RECOVERY === 'LOW' ? { comeback_mode: 1 } : {}),
    ...(process.env.PROGRAM_TEST_HISTORY === 'unknown' ? {} : { weekly_miles_current: process.env.PROGRAM_TEST_HISTORY === 'endurance' ? 28 : 14 }) });
  assert.equal(profile.status, 200, JSON.stringify(profile.data));
  const race = await request('POST', '/races', { race_name: 'Disposable Army 10-Miler', race_date: raceDate,
    distance_miles: 10, goal_time_seconds: 5400, event_kind: 'run_race', event_timezone: 'America/New_York' });
  assert.equal(race.status, 201, JSON.stringify(race.data));
  const historyDates = ['none', 'unknown'].includes(process.env.PROGRAM_TEST_HISTORY) ? [] : process.env.PROGRAM_TEST_HISTORY === 'endurance'
    ? Array.from({ length: 28 }, (_, index) => new Date(Date.UTC(2026, 8, 6 - index)).toISOString().slice(0, 10)) : process.env.PROGRAM_TEST_HISTORY === 'established'
    ? Array.from({ length: 24 }, (_, index) => new Date(Date.UTC(2026, 8, 8 - index)).toISOString().slice(0, 10))
    : ['2026-09-01','2026-09-03','2026-09-06'];
  for (const date of historyDates) {
    const long = process.env.PROGRAM_TEST_HISTORY === 'endurance' && new Date(date + 'T12:00:00Z').getUTCDay() === 0;
    const distance = process.env.PROGRAM_TEST_HISTORY === 'endurance' ? long ? 10 : 3 : process.env.PROGRAM_TEST_HISTORY === 'established' ? 2 : 4;
    const run = await request('POST', '/runs', { date, type: long ? 'long' : 'easy', distance_miles: distance, duration_seconds: distance * 840 });
    assert.equal(run.status, 201, JSON.stringify(run.data));
  }
  if (process.env.PROGRAM_TEST_KNOWN_LIFT === '1') {
    const logged = await request('POST', '/workouts/strength', { name: 'Disposable known-load source',
      completed_at: '2026-09-01T12:00:00.000Z', sets: [{ exercise_name: 'Dumbbell bench press',
        muscle_group: 'chest', set_number: 1, reps: 8, weight_lbs: 45 }] });
    assert.equal(logged.status, 201, JSON.stringify(logged.data));
  }
  const generationRequest = {
    planning_date_local: '2026-09-10', timezone_offset_minutes: 240, planning_timezone: 'America/New_York',
    target: { runDaysPerWeek: frequency, liftDaysPerWeek: liftFrequency, liftingEnabled: true, planMode,
      trainingDays: all, runEligibleWeekdays: all, liftEligibleWeekdays: all },
  };
  const previews = process.env.PROGRAM_TEST_DUPLICATE_PREVIEW === '1'
    ? await Promise.all([request('POST', `/plans/generate-for-race/${race.data.race.id}`, generationRequest),
      request('POST', `/plans/generate-for-race/${race.data.race.id}`, generationRequest)])
    : [await request('POST', `/plans/generate-for-race/${race.data.race.id}`, generationRequest)];
  if (process.env.PROGRAM_TEST_APPLY_SECOND_PREVIEW === '1') {
    assert.equal(previews.length, 2, 'Second-preview apply is only a guarded duplicate-preview fixture');
    previews.reverse();
  }
  const generated = previews[0];
  if (previews.length === 2) {
    assert.equal(previews[1].status, 201, JSON.stringify(previews[1].data));
    assert.notEqual(previews[1].data.candidate_id, generated.data.candidate_id);
    assert.notEqual(previews[1].data.surface_manifest.plan_generation_candidate_ref,
      generated.data.surface_manifest.plan_generation_candidate_ref);
  }
  const rows = await db.dbAll('SELECT id, status, candidate_plan_json FROM plan_generation_candidates WHERE user_id=?', [owner]);
  console.log(JSON.stringify({ gate: 'real-http-postgres', generationStatus: generated.status,
    code: generated.data.code || null, error: generated.data.error || null,
    generation_ms: generated.elapsed_ms, details: generated.data.details || null,
    rejected_window: generated.status === 201 ? null : lastRejectedWindow,
    ...(process.env.PROGRAM_TEST_DETAILS === '1' ? { weeklySelections } : {}),
    persistedCandidates: rows.map(row => ({ status: row.status, weeks: row.candidate_plan_json?.weeks?.length })) }));
  assert.equal(generated.status, 201, JSON.stringify(generated.data));
  assert.equal(rows.length, previews.length);
  assert.equal(rows[0].candidate_plan_json.weeks.length, expectedWeeks);
  assert.equal(rows[0].candidate_plan_json.programContract.timezone, 'America/New_York');
  assert.ok(rows[0].candidate_plan_json.weeks.flatMap(week => week.days.flatMap(day => day.sessions))
    .every(session => session.timezone === 'America/New_York'));
  assert.notEqual(rows[0].candidate_plan_json.planMode, 'run_only');
  const fullWeek = rows[0].candidate_plan_json.weeks[1];
  assert.equal(fullWeek.days.flatMap(day => day.sessions).filter(session => session.kind === 'run').length, frequency);
  assert.equal(fullWeek.days.flatMap(day => day.sessions).filter(session => session.kind === 'lift').length, liftFrequency);
  // Preview must not replace an active assignment; apply/manifest assertions are
  // added once this real pipeline produces the complete canonical candidate.
  assert.equal((await db.dbAll('SELECT id FROM user_plans WHERE user_id=?', [owner])).length, 0);
  const applyBody = { planning_date_local: '2026-09-10', timezone_offset_minutes: 240,
    choice: 'train_for_target', candidate_hash: generated.data.candidate_hash, ...generated.data.apply_bindings };
  const stale = await request('POST', `/plans/candidates/${generated.data.candidate_id}/apply`, { ...applyBody, candidate_hash: 'sha256:' + '0'.repeat(64) });
  assert.equal(stale.status, 409, JSON.stringify(stale.data));
  assert.equal((await db.dbAll('SELECT id FROM user_plans WHERE user_id=?', [owner])).length, 0);
  const apply = await request('POST', `/plans/candidates/${generated.data.candidate_id}/apply`, applyBody);
  console.log(JSON.stringify({ gate: 'real-http-apply', status: apply.status, code: apply.data.code,
    apply_ms: apply.elapsed_ms, error: apply.data.error }));
  assert.equal(apply.status, 200, JSON.stringify(apply.data));
  const current = await request('GET', '/plans/current');
  const today = await request('GET', '/plans/today');
  assert.equal(current.status, 200, JSON.stringify(current.data));
  assert.equal(today.status, 200, JSON.stringify(today.data));
  const reloaded = current.data.plan.plan_data;
  if (previews.length === 2) {
    const acceptedBefore = JSON.stringify(await db.dbGet(`SELECT up.id,up.status,up.plan_version,up.progress_json,
      tp.plan_json,tp.plan_data FROM user_plans up JOIN training_plans tp ON tp.id=up.plan_id WHERE up.user_id=? AND up.status='active'`, [owner]));
    const competitor = previews[1].data;
    const competitorApply = await request('POST', `/plans/candidates/${competitor.candidate_id}/apply`, {
      ...competitor.apply_bindings, candidate_hash: competitor.candidate_hash,
      planning_date_local: '2026-09-10', timezone_offset_minutes: 240, choice: 'train_for_target' });
    assert.equal(competitorApply.status, 409, JSON.stringify(competitorApply.data));
    assert.equal(JSON.stringify(await db.dbGet(`SELECT up.id,up.status,up.plan_version,up.progress_json,
      tp.plan_json,tp.plan_data FROM user_plans up JOIN training_plans tp ON tp.id=up.plan_id WHERE up.user_id=? AND up.status='active'`, [owner])), acceptedBefore);
    assert.equal((await request('GET', '/plans/current')).data.surface_manifest.status, 'accepted');
    assert.equal((await request('GET', '/plans/today')).data.surface_manifest.status, 'accepted');
    console.log(JSON.stringify({ gate: 'real-concurrent-preview-identity', status: 'PASS', previews: 2,
      stale_competitor_code: competitorApply.data.code, accepted_content_preserved: true }));
  }
  if (process.env.PROGRAM_TEST_KNOWN_LIFT === '1') {
    let knownLoads = 0;
    for (const session of reloaded.weeks.flatMap(w => w.days.flatMap(d => d.sessions)).filter(s => s.kind === 'lift')) {
      for (const [index, exercise] of session.main.entries()) {
        if (session.steps[index].target.load_kg === undefined) continue;
        assert.match(exercise.load, / lb starting load$/);
        assert.match(exercise.loadSource, /45 lb x 8/);
        assert.match(exercise.progression, / lb /);
        assert.deepEqual(require('../src/lib/strengthDoseAccounting').canonicalStrengthExercise(exercise).target, session.steps[index].target);
        knownLoads++;
      }
    }
    assert.ok(knownLoads > 0, 'Actual logged45lb source remains canonical and unit-consistent after apply/reload');
  }
  assert.equal(reloaded.weeks.length, expectedWeeks);
  assert.equal(current.data.surface_manifest.status, 'accepted');
  assert.equal(reloaded.overall_feasibility, 'unvalidated', 'Easy runs or missing runs do not establish maximal race performance');
  assert.equal(current.data.surface_manifest.feasibility.status, 'unvalidated');
  for (const reason of ['PEAK_DEMAND_UNREACHABLE', 'CHECKPOINT_UNPLACEABLE', 'QUALITY_EXPOSURE_MISSING']) {
    assert.ok(!current.data.surface_manifest.feasibility.reason_codes.includes(reason), 'No legacy template forecast: ' + reason);
  }
  assert.equal(current.data.surface_manifest.identity.canonical_session_set_hash,
    generated.data.surface_manifest.identity.canonical_session_set_hash);
  assert.deepEqual(reloaded.weeks.flatMap(week => week.days.flatMap(day => day.sessions)).map(session => session.content_hash),
    rows[0].candidate_plan_json.weeks.flatMap(week => week.days.flatMap(day => day.sessions)).map(session => session.content_hash));
  const replay = await request('POST', `/plans/candidates/${generated.data.candidate_id}/apply`, applyBody);
  assert.equal(replay.status, 200, JSON.stringify(replay.data));
  assert.equal(replay.data.replay, true);
  assert.equal((await db.dbAll('SELECT id FROM user_plans WHERE user_id=?', [owner])).length, 1);
  const initialReceiptPath = `/tmp/${databaseName}-initial-accepted-program.json`;
  require('node:fs').writeFileSync(initialReceiptPath, JSON.stringify({ preview: generated.data, applied: apply.data,
    current: current.data, today: today.data }));
  console.log(JSON.stringify({ gate: 'initial-accepted-reload', status: 'PASS', initialReceiptPath }));
  if (process.env.PROGRAM_TEST_REMOVAL === '1') {
    const secondary = await request('POST', '/races', { race_name: 'Disposable secondary road race',
      race_date: '2026-09-20', distance_miles: 5, goal_time_seconds: 2700,
      event_kind: 'run_race', event_timezone: 'America/New_York' });
    assert.equal(secondary.status, 201, JSON.stringify(secondary.data));
    const added = await request('POST', '/plans/generate-for-races', { ...generationRequest,
      race_ids: [race.data.race.id, secondary.data.race.id] });
    if (added.status !== 201) {
      console.log(JSON.stringify({ gate: 'expansion-rejected-window', lastRejectedWindow, lastSelection: weeklySelections.at(-1) }));
      if (process.env.PROGRAM_TEST_DETAILS === '1') {
        try { await require('../src/routes/plans')._test.previewPlanForUser(owner, { ...generationRequest,
          race_ids: [race.data.race.id, secondary.data.race.id] }, { store: false, goalBackwardDependencies: {
          inspectInput: input => {
            const inputPath = `/tmp/${databaseName}-expansion-input.json`;
            require('node:fs').writeFileSync(inputPath, JSON.stringify(input, (key, value) => /password|token|secret/i.test(key) ? undefined : value));
            console.log(JSON.stringify({ gate: 'disposable-expansion-input', inputPath }));
          },
          inspectFailure: error => console.log(JSON.stringify({ gate: 'expansion-diagnostic', code: error.code, message: error.message })),
          inspectApplicability: result => console.log(JSON.stringify({ gate: 'expansion-diagnostic', failure: result?.program_failure,
            week: result?.failed_program_week, boundary: result?.program_boundary_diagnostics,
            reconciliation: result?.program_reconciliation?.filter(value => !value.valid) })),
        } }); } catch { /* The registered HTTP response remains the actual gate. */ }
      }
    }
    assert.equal(added.status, 201, 'Goal expansion: ' + JSON.stringify(added.data));
    assert.equal(added.data.plan.plan_data.programContract.timezone, 'America/New_York');
    assert.ok(added.data.surface_manifest.sessions.every(session => session.timezone === 'America/New_York'));
    const addedApply = await request('POST', `/plans/candidates/${added.data.candidate_id}/apply`, {
      ...added.data.apply_bindings, candidate_hash: added.data.candidate_hash,
      planning_date_local: '2026-09-10', timezone_offset_minutes: 240, choice: 'train_for_target' });
    assert.equal(addedApply.status, 200, JSON.stringify(addedApply.data));
    assert.ok(added.elapsed_ms < 90000, 'Expansion preview fits its scoped client deadline');
    assert.ok(addedApply.elapsed_ms < 45000, 'Expansion apply fits its scoped client deadline');
    console.log(JSON.stringify({ gate: 'real-goal-expansion', status: 'PASS',
      preview_ms: added.elapsed_ms, apply_ms: addedApply.elapsed_ms }));
    const expansionCurrent = await request('GET', '/plans/current?planning_date_local=2026-09-10&timezone_offset_minutes=240&planning_timezone=America%2FNew_York');
    const expansionToday = await request('GET', '/plans/today?planning_date_local=2026-09-10&timezone_offset_minutes=240&planning_timezone=America%2FNew_York');
    assert.equal(expansionCurrent.data.surface_manifest.identity.canonical_session_set_hash,
      added.data.surface_manifest.identity.canonical_session_set_hash);
    const expandedPlan = expansionCurrent.data.plan.plan_data;
    const postEventWeek = expandedPlan.weeks.find(week => week.startDate === '2026-09-21');
    assert.equal(postEventWeek.phase, 'deload');
    assert.equal(postEventWeek.roadPhaseAdjustment?.policy, 'RECOVERY_VOLUME_REDUCTION');
    assert.ok(postEventWeek.days.flatMap(day => day.sessions).filter(session => session.kind === 'run')
      .every(session => ['easy_run', 'recovery_run'].includes(session.workout_family)),
    'Planned post-event recovery must not retain the old ordinary long workout');
    for (const week of expandedPlan.weeks) assert.equal(new Set(week.days.flatMap(day => day.sessions)
      .filter(session => session.kind === 'run').map(session => session.scheduled_local_date)).size,
    week.days.flatMap(day => day.sessions).filter(session => session.kind === 'run').length,
    'Retained canonical and regenerated adapter IDs cannot duplicate a modality/date slot');
    const expansionPath = `/tmp/${databaseName}-expanded-program.json`;
    require('node:fs').writeFileSync(expansionPath, JSON.stringify({ preview: added.data, applied: addedApply.data,
      current: expansionCurrent.data, today: expansionToday.data }));
    console.log(JSON.stringify({ gate: 'expanded-accepted-reload', status: 'PASS', expansionPath }));
    const acceptedBytes = async () => JSON.stringify(await db.dbGet(`SELECT up.id,up.status,up.plan_version,up.progress_json,
      tp.plan_json,tp.plan_data FROM user_plans up JOIN training_plans tp ON tp.id=up.plan_id
      WHERE up.user_id=? AND up.status='active'`, [owner]));
    const before = await acceptedBytes();
    const removed = await request('POST', `/races/${secondary.data.race.id}/removal-preview`, generationRequest);
    if (removed.status !== 201 && process.env.PROGRAM_TEST_DETAILS === '1') {
      const diagnostic = require('../src/routes/plans')._test;
      try { await diagnostic.previewPlanForUser(owner,
        diagnostic.raceRemovalCandidateRequest(secondary.data.race.id, [race.data.race.id], generationRequest),
        { store: false, goalBackwardDependencies: {
          inspectFailure: error => console.log(JSON.stringify({ gate: 'removal-diagnostic', code: error.code, message: error.message })),
          inspectApplicability: result => console.log(JSON.stringify({ gate: 'removal-diagnostic',
            failure: result?.program_failure, week: result?.failed_program_week,
            validators: result?.candidates?.[0]?.validation?.validator_results?.filter(value => !value.valid),
            reconciliation: result?.program_reconciliation?.filter(value => !value.valid) })),
        } }); } catch { /* Original registered HTTP response remains the gate result. */ }
    }
    assert.equal(removed.status, 201, 'Removal preview: ' + JSON.stringify(removed.data));
    assert.equal(removed.data.plan.plan_data.programContract.timezone, 'America/New_York');
    assert.ok(removed.data.surface_manifest.sessions.every(session => session.timezone === 'America/New_York'));
    assert.equal(await acceptedBytes(), before, 'Removal preview preserves all accepted content');
    assert.ok(await db.dbGet('SELECT id FROM race_events WHERE id=? AND user_id=?', [secondary.data.race.id, owner]));
    assert.equal(removed.data.plan.plan_data.weeks.length, expectedWeeks);
    const removalBody = { ...removed.data.apply_bindings, candidate_id: removed.data.candidate_id,
      candidate_hash: removed.data.candidate_hash, planning_date_local: '2026-09-10', timezone_offset_minutes: 240,
      choice: 'train_for_target' };
    const removalApply = await request('POST', `/races/${secondary.data.race.id}/removal-apply`, removalBody);
    assert.equal(removalApply.status, 200, JSON.stringify(removalApply.data));
    assert.ok(removed.elapsed_ms < 45000, 'Removal preview fits the actual45s self-service client deadline');
    assert.ok(removalApply.elapsed_ms < 45000, 'Removal apply fits its scoped client deadline');
    const removalCurrent = await request('GET', '/plans/current');
    const removalToday = await request('GET', '/plans/today');
    assert.equal(removalCurrent.status, 200); assert.equal(removalToday.status, 200);
    assert.equal(removalCurrent.data.plan.plan_data.weeks.length, expectedWeeks);
    assert.equal(removalCurrent.data.plan.plan_data.programContract.timezone, 'America/New_York');
    assert.ok(removalCurrent.data.surface_manifest.sessions.every(session => session.timezone === 'America/New_York'));
    assert.deepEqual(removalCurrent.data.plan.plan_data.goals.map(goal => goal.raceId), [race.data.race.id]);
    assert.equal(removalCurrent.data.surface_manifest.identity.canonical_session_set_hash,
      removed.data.surface_manifest.identity.canonical_session_set_hash);
    assert.equal(await db.dbGet('SELECT id FROM race_events WHERE id=? AND user_id=?', [secondary.data.race.id, owner]), null);
    assert.ok(removalCurrent.data.surface_manifest.sessions.every(session => !session.goal_ids.includes(`goal-${secondary.data.race.id}`)));
    const removalPath = `/tmp/${databaseName}-removed-program.json`;
    require('node:fs').writeFileSync(removalPath, JSON.stringify({ preview: removed.data, applied: removalApply.data,
      current: removalCurrent.data, today: removalToday.data }));
    console.log(JSON.stringify({ gate: 'real-goal-expansion-removal', status: 'PASS', removalPath,
      preview_ms: removed.elapsed_ms, apply_ms: removalApply.elapsed_ms }));
  }
  if (process.env.PROGRAM_TEST_REBUILD === '1') {
    const before = await db.dbGet("SELECT id FROM user_plans WHERE user_id=? AND status='active'", [owner]);
    const acceptedBytes = async () => JSON.stringify(await db.dbGet(`SELECT up.id,up.status,up.plan_version,up.progress_json,
      tp.plan_json,tp.plan_data FROM user_plans up JOIN training_plans tp ON tp.id=up.plan_id WHERE up.id=? AND up.user_id=?`, [before.id, owner]));
    let beforeBytes = await acceptedBytes();
    const ownerToken = token;
    const outsider = await request('POST', '/auth/register', { name: 'Disposable ownership negative',
      email: `${databaseName}-other@example.invalid`, password: crypto.randomBytes(24).toString('hex'),
      accepted_waiver_version: require('../src/lib/waiverText').WAIVER_VERSION });
    assert.equal(outsider.status, 201); token = outsider.data.token;
    const wrongOwner = await request('POST', `/plans/candidates/${generated.data.candidate_id}/apply`, applyBody);
    assert.equal(wrongOwner.status, 404); token = ownerToken;
    assert.equal(await acceptedBytes(), beforeBytes);
    const revisionPreview = await request('POST', `/plans/generate-for-race/${race.data.race.id}`, generationRequest);
    assert.equal(revisionPreview.status, 201, JSON.stringify(revisionPreview.data));
    const revisionBefore = (await db.dbGet('SELECT planning_input_revision FROM users WHERE id=?', [owner])).planning_input_revision;
    const changedProfile = await request('PUT', '/auth/me/profile', { run_days_per_week: frequency === 4 ? 3 : 4 });
    assert.equal(changedProfile.status, 200, JSON.stringify(changedProfile.data));
    const restoredProfile = await request('PUT', '/auth/me/profile', { run_days_per_week: frequency });
    assert.equal(restoredProfile.status, 200, JSON.stringify(restoredProfile.data));
    assert.ok((await db.dbGet('SELECT planning_input_revision FROM users WHERE id=?', [owner])).planning_input_revision > revisionBefore);
    const afterProfileBytes = await acceptedBytes();
    const priorAccepted = JSON.parse(beforeBytes), afterProfile = JSON.parse(afterProfileBytes);
    for (const key of ['id', 'status', 'plan_version', 'plan_json', 'plan_data']) assert.deepEqual(afterProfile[key], priorAccepted[key],
      `The explicit profile change must not rewrite accepted ${key}`);
    assert.equal(JSON.parse(afterProfile.progress_json).planReviewRequired.reason, 'run_frequency_changed',
      'The authorized profile write may mark the retained plan for review');
    beforeBytes = afterProfileBytes;
    const staleRevisionApply = await request('POST', `/plans/candidates/${revisionPreview.data.candidate_id}/apply`, {
      ...revisionPreview.data.apply_bindings, candidate_hash: revisionPreview.data.candidate_hash,
      planning_date_local: '2026-09-10', timezone_offset_minutes: 240, choice: 'train_for_target' });
    assert.equal(staleRevisionApply.status, 409, JSON.stringify(staleRevisionApply.data));
    assert.equal(await acceptedBytes(), beforeBytes, 'Restoring preferences does not revive a stale preview or alter accepted content');
    console.log(JSON.stringify({ gate: 'real-database-revision-apply-guard', status: 'PASS', code: staleRevisionApply.data.code,
      active_content_preserved: true }));
    const rebuilt = await request('POST', `/plans/generate-for-race/${race.data.race.id}`, generationRequest);
    assert.equal(rebuilt.status, 201, JSON.stringify(rebuilt.data));
    assert.equal((await db.dbGet("SELECT id FROM user_plans WHERE user_id=? AND status='active'", [owner])).id, before.id);
    assert.equal(await acceptedBytes(), beforeBytes);
    const rebuiltBindings = { ...rebuilt.data.apply_bindings, candidate_hash: rebuilt.data.candidate_hash,
      planning_date_local: '2026-09-10', timezone_offset_minutes: 240, choice: 'train_for_target' };
    const rejected = await request('POST', `/plans/candidates/${rebuilt.data.candidate_id}/reject`, rebuiltBindings);
    assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
    assert.equal(await acceptedBytes(), beforeBytes);
    const suppressed = await request('POST', `/plans/generate-for-race/${race.data.race.id}`, generationRequest);
    assert.equal(suppressed.status, 409, JSON.stringify(suppressed.data));
    assert.equal(suppressed.data.code, 'IDENTICAL_REJECTED_CANDIDATE_SUPPRESSED');
    assert.equal(await acceptedBytes(), beforeBytes);
    // An actual changed preference creates a new intent without deleting the
    // active plan or any account history. Persist and verify through real APIs.
    const changed = structuredClone(generationRequest);
    changed.target.liftDaysPerWeek = frequency === 4 ? 3 : 6;
    const replacement = await request('POST', `/plans/generate-for-race/${race.data.race.id}`, changed);
    assert.equal(replacement.status, 201, 'Changed-intent replacement preview: ' + JSON.stringify(replacement.data));
    assert.equal((await db.dbGet("SELECT id FROM user_plans WHERE user_id=? AND status='active'", [owner])).id, before.id);
    assert.equal(await acceptedBytes(), beforeBytes);
    const replacementApply = await request('POST', `/plans/candidates/${replacement.data.candidate_id}/apply`, {
      ...replacement.data.apply_bindings, candidate_hash: replacement.data.candidate_hash,
      planning_date_local: '2026-09-10', timezone_offset_minutes: 240, choice: 'train_for_target' });
    assert.equal(replacementApply.status, 200, 'Changed-intent replacement apply: ' + JSON.stringify(replacementApply.data));
    const activeRows = await db.dbAll("SELECT id FROM user_plans WHERE user_id=? AND status='active'", [owner]);
    assert.equal(activeRows.length, 1); assert.notEqual(activeRows[0].id, before.id);
    assert.equal((await db.dbGet('SELECT status FROM user_plans WHERE id=?', [before.id])).status, 'superseded');
    const successorCurrent = await request('GET', '/plans/current');
    const successorToday = await request('GET', '/plans/today');
    assert.equal(successorCurrent.status, 200); assert.equal(successorToday.status, 200);
    const successorPlan = successorCurrent.data.plan.plan_data;
    assert.equal(successorPlan.weeks.length, expectedWeeks);
    for (const week of successorPlan.weeks.slice(1).filter(week => !['race', 'taper'].includes(week.phase))) {
      assert.equal(week.days.filter(day => day.sessions.some(session => session.kind === 'run')).length, frequency);
      assert.equal(week.days.filter(day => day.sessions.some(session => session.kind === 'lift')).length, changed.target.liftDaysPerWeek);
    }
    assert.equal(successorCurrent.data.surface_manifest.status, 'accepted');
    assert.equal(successorCurrent.data.surface_manifest.identity.canonical_session_set_hash,
      replacement.data.surface_manifest.identity.canonical_session_set_hash);
    assert.equal((await db.dbGet('SELECT lift_days_per_week FROM users WHERE id=?', [owner])).lift_days_per_week, changed.target.liftDaysPerWeek);
    const successorPath = `/tmp/${databaseName}-successor-program.json`;
    require('node:fs').writeFileSync(successorPath, JSON.stringify({ preview: replacement.data,
      applied: replacementApply.data, current: successorCurrent.data, today: successorToday.data }));
    console.log(JSON.stringify({ gate: 'accepted-successor-reload', status: 'PASS', successorPath }));
    console.log(JSON.stringify({ gate: 'active-rebuild-reject-recovery', status: 'PASS', active_retained_until_apply: true }));
  }
  const contracts = require('../src/lib/goalBackwardContracts');
  const canonical = require('../src/lib/canonicalWorkout');
  const { canonicalHash } = require('../src/lib/racePlanPolicy');
  const artifacts = await db.dbAll('SELECT * FROM planning_pipeline_artifacts WHERE user_id=?', [owner]);
  const stored = artifacts.find(artifact => artifact.artifact_kind === 'canonical_session_set');
  assert.ok(stored);
  // Replay the real additive migration with accepted data already present.
  await require('../src/db/migrate').runAlwaysMigrations();
  assert.equal((await db.dbAll('SELECT id FROM planning_pipeline_artifacts WHERE user_id=?', [owner])).length, artifacts.length);
  const rollback = await db.dbGet(`SELECT COUNT(*) FILTER (WHERE pg_column_size(payload_json) > 262144) AS exceeds_legacy_storage,
    COUNT(*) FILTER (WHERE payload_json->>'program_storage_version'='materialized-program-storage-v1') AS versioned_program_rows,
    COALESCE(MAX(pg_column_size(payload_json)),0) AS maximum_jsonb_bytes,
    COALESCE(MAX(octet_length(payload_json::text)),0) AS maximum_jsonb_text_bytes FROM planning_pipeline_artifacts`);
  assert.ok(Number(rollback.versioned_program_rows) > 0, 'Old-code rollback is prohibited even if new rows happen to fit the legacy byte limit');
  assert.equal((await db.dbAll('SELECT id FROM planning_pipeline_artifacts WHERE user_id=?', [owner])).length, artifacts.length);
  const { plan_generation_candidate_ref, selected_candidate_id, selected_candidate_hash, ...set } = structuredClone(stored.payload_json);
  const boundaryCount = Math.floor((contracts.MAX_PROGRAM_ARTIFACT_BYTES - Buffer.byteLength(JSON.stringify(set)) - 120000) / 4);
  assert.ok(boundaryCount > 0);
  set.sessions[0].stop_criteria = Array(boundaryCount).fill('X');
  set.sessions[0].content_hash = canonical.canonicalWorkoutHash(set.sessions[0]);
  set.session_content_hashes = set.sessions.map(session => ({ session_id: session.session_id, content_hash: session.content_hash }));
  set.content_hash = canonical.canonicalSessionSetHash(set);
  set.candidate_hash = canonicalHash({ candidate_skeleton_hash: set.candidate_skeleton_hash, canonical_session_set_hash: set.content_hash });
  const physicalBoundary = lifecycle.buildPipelineArtifact({ userId: owner, kind: 'canonical_session_set',
    decisionId: set.decision_id, planGenerationCandidateId: generated.data.candidate_id, payload: set });
  const encoded = JSON.stringify(physicalBoundary.payload_json);
  const actualSize = await db.dbGet('SELECT pg_column_size(?::jsonb) AS bytes', [encoded]);
  assert.ok(Buffer.byteLength(encoded) < contracts.MAX_PROGRAM_ARTIFACT_BYTES, 'Physical-only fixture remains below the JSON budget');
  assert.ok(Number(actualSize.bytes) > contracts.MAX_PROGRAM_ARTIFACT_BYTES, 'Actual PostgreSQL representation exceeds the separate physical budget');
  let attemptedWrites = 0;
  await assert.rejects(lifecycle.persistPipelineArtifacts({ artifacts: [physicalBoundary], requireCompleteLinks: false,
    tx: { get: db.dbGet, run: async () => { attemptedWrites += 1; throw new Error('Unexpected write'); } } }),
  error => error.code === 'ARTIFACT_STORAGE_BOUND_EXCEEDED');
  assert.equal(attemptedWrites, 0, 'Physical bound is checked before any artifact write');
  console.log(JSON.stringify({ gate: 'program-storage-boundaries', status: 'PASS', json_bytes: Buffer.byteLength(encoded),
    jsonb_bytes: actualSize.bytes, attempted_writes: attemptedWrites, migration_replay: 'PRESERVED_ACCEPTED_ROWS' }));
  const artifactPath = `/tmp/${databaseName}-accepted-program.json`;
  require('node:fs').writeFileSync(artifactPath, JSON.stringify({ fixture: process.env.PROGRAM_TEST_HISTORY || 'sparse',
    generation_ms: generated.elapsed_ms, apply_ms: apply.elapsed_ms, preview: generated.data,
    applied: apply.data, current: current.data, today: today.data }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ gate: 'complete-program-persisted-reload', status: 'PASS', artifactPath }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (created) {
    if (db) {
      const users = await db.dbAll('SELECT email FROM users');
      assert.ok(users.every(user => [`${databaseName}@example.invalid`, `${databaseName}-other@example.invalid`].includes(user.email)), 'Cleanup refuses any unexpected account');
      await db.pool.end();
    }
    if (postgres) await postgres.close();
    await admin.query(`DROP DATABASE "${databaseName}"`);
    console.log('Disposable integration database removed; no production account or data accessed.');
  }
  await admin.end();
});
