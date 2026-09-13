const assert = require('node:assert/strict');
const { createDb } = require('./helpers/adaptiveShadowDb');
const shadow = require('../src/lib/adaptiveCoachingShadow');
const { addDays } = require('../src/lib/racePlanPolicy');
let DATE = '2026-09-14';
let NOW = `${DATE}T12:00:00Z`;
const OWNER = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const RealDate = Date;
class FixedDate extends RealDate { constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return RealDate.parse(NOW); } }
global.Date = FixedDate;
const dbPath = require.resolve('../src/db');
const fixture = createDb();
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fixture.exports };
const realPrepare = shadow.prepare;
const realCompute = shadow.compute;
let lastPrepared, lastPreparedContext, adaptiveComputations = 0;
shadow.prepare = args => { lastPrepared = null; lastPreparedContext = args.state.context; lastPrepared = realPrepare(args); return lastPrepared; };
shadow.compute = prepared => { adaptiveComputations++; assert.equal(prepared, lastPrepared); return realCompute(prepared); };
const engine = require('../src/lib/racePlanCandidateEngine');
const realLegacy = engine.buildRacePlanCandidate;
engine.buildRacePlanCandidate = (context, options) => {
  assert.equal(context, lastPreparedContext, 'foundation precedes legacy generation on the same input');
  assert.equal(Object.isFrozen(context), true);
  if (lastPrepared) assert.equal(Object.isFrozen(lastPrepared.foundation.athlete_state), true);
  return realLegacy(context, options);
};
const plans = require('../src/routes/plans')._test;
const { db, tx, hooks } = fixture;
async function main() {
  for (const id of [OWNER, OTHER]) db.prepare(`INSERT INTO users(id,name,email,password_hash,timezone,training_age_class,
    run_days_per_week,lift_days_per_week,preferred_workout_days,planning_input_revision) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, 'Synthetic', `${id}@example.invalid`, '', 'UTC', 'BEGINNER', 2, 0,
      JSON.stringify(['Mon','Tue','Wed','Thu','Fri','Sat','Sun']), 1);
  db.prepare('INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds) VALUES (?,?,?,?,?,?)')
    .run('observed', OWNER, addDays(DATE, -2), 'easy', 4, 3600);
  db.prepare('INSERT INTO daily_checkins(id,user_id,checkin_date,feeling,time_available) VALUES (?,?,?,?,?)')
    .run('ready', OWNER, DATE, 4, 60);
  const { canonicalizeRunLoadInput } = require('../src/lib/goalBackwardEvidence');
  const loadInput = { athleteId: OWNER, timezone: 'UTC', planningInstant: `${DATE}T23:59:59.999Z`,
    planningDateLocal: DATE, runs: db.prepare('SELECT * FROM runs WHERE user_id=?').all(OWNER) };
  let captured;
  const unchangedLoad = canonicalizeRunLoadInput({ ...loadInput, captureSnapshot: s => { captured = s; },
    snapshotEvidence: { checkIns: db.prepare('SELECT * FROM daily_checkins WHERE user_id=?').all(OWNER) } });
  assert.deepEqual(unchangedLoad, canonicalizeRunLoadInput(loadInput), 'capturing a canonical foundation does not change legacy load hashes');
  assert.equal(captured.source_row_counts.check_ins, 1);
  const request = { planning_date_local: DATE, timezone_offset_minutes: 0, planning_timezone: 'UTC',
    target: { runDaysPerWeek: 2, liftDaysPerWeek: 0, trainingDays: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'] } };
  const diagnostics = [];
  const options = mode => ({ goalBackwardDependencies: { mode, audience: 'all', telemetrySink: () => {}, adaptiveDiagnosticSink: d => diagnostics.push(d) } });
  const off = await plans.previewPlanForUser(OWNER, request, options('off'));
  assert.equal(adaptiveComputations, 0);
  const response = await plans.previewPlanForUser(OWNER, request, options('shadow'));
  assert.equal(adaptiveComputations, 1);
  assert.deepEqual(response.plan, off.plan);
  assert.equal(response.candidateHash, off.candidateHash);
  assert.equal(response.surfaceManifest, undefined);
  assert.equal(response.applyBindings, undefined);
  const row = await tx.get('SELECT * FROM plan_generation_candidates WHERE id=? AND user_id=?', [response.id, OWNER]);
  assert.equal(row.feature_mode, 'shadow', JSON.stringify(diagnostics));
  const receiptRows = await tx.all('SELECT * FROM planning_pipeline_artifacts WHERE plan_generation_candidate_id=?', [response.id]);
  const week = JSON.parse(receiptRows.find(r => r.artifact_kind === 'candidate_week').payload_json);
  const binding = Object.fromEntries(['input_hash', 'planning_input_revision', 'lock_revision', 'edit_revision', 'constraint_fingerprint'].map(k => [k, week.shadow_relation[k]]));
  const receipt = await shadow.readback({ tx, userId: OWNER, candidateId: response.id, binding });
  assert.equal(receipt.artifacts.length, 6);
  assert.equal(receipt.artifacts[2].payload_json.athlete_state_hash, receipt.artifacts[1].payload_json.athlete_state_hash);
  assert.equal(receipt.artifacts[1].payload_json.evidence_snapshot_id, receipt.artifacts[0].payload_json.evidence_snapshot_id);
  assert.ok(week.rest_days.length);
  assert.equal(receipt.artifacts[1].payload_json.recovery_state, 'READY');
  assert.equal(receipt.artifacts[1].payload_json.time_constraints[DATE].available_minutes, 60);
  assert.equal(week.comparison.adaptive.stress.observed_stress_vector, null);
  assert.equal(week.comparison.legacy.objective_coverage, null);
  await assert.rejects(shadow.readback({ tx, userId: OTHER, candidateId: response.id, binding }), /READBACK_INVALID/);
  db.prepare('INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds) VALUES (?,?,?,?,?,?)')
    .run('foreign-observed', OTHER, addDays(DATE, -2), 'easy', 99, 24000);
  db.prepare(`INSERT INTO planning_constraints(id,user_id,constraint_kind,date_local,revision,active,attributed_by_user_id,attributed_payload_json)
    VALUES (?,?,?,?,?,?,?,?)`).run('foreign-constraint', OTHER, 'day_lock', DATE, 1, 0, OTHER, '{}');
  const repeat = await plans.previewPlanForUser(OWNER, request, options('shadow'));
  const repeatRows = await tx.all('SELECT * FROM planning_pipeline_artifacts WHERE plan_generation_candidate_id=?', [repeat.id]);
  assert.equal(repeatRows.length, 6);
  const repeatWeek = JSON.parse(repeatRows.find(r => r.artifact_kind === 'candidate_week').payload_json);
  assert.deepEqual(repeatWeek.comparison, week.comparison);
  assert.equal(repeatWeek.shadow_relation.athlete_state_hash, week.shadow_relation.athlete_state_hash);
  const before = db.prepare('SELECT COUNT(*) n FROM plan_generation_candidates').get().n;
  const artifactsBefore = db.prepare('SELECT COUNT(*) n FROM planning_pipeline_artifacts').get().n;
  await plans.previewPlanForUser(OWNER, request, { ...options('shadow'), store: false });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM plan_generation_candidates').get().n, before);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM planning_pipeline_artifacts').get().n, artifactsBefore);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_plans').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM training_plans').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM planning_pipeline_artifacts WHERE artifact_kind='surface_manifest'").get().n, 0);
  const totalRows = table => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  for (const mode of ['off', 'shadow ', 'preview', 'on']) {
    const startCount = totalRows('planning_pipeline_artifacts');
    const plain = await plans.previewPlanForUser(OWNER, { ...request, goalBackwardDependencies: { mode: 'shadow', audience: 'all' } }, options(mode));
    assert.deepEqual(plain.plan, off.plan);
    assert.equal(totalRows('planning_pipeline_artifacts'), startCount);
  }
  const injected = await plans.previewPlanForUser(OWNER, { ...request, mode: 'shadow',
    goalBackwardDependencies: { mode: 'shadow', audience: 'all' } });
  assert.equal((await tx.get('SELECT feature_mode FROM plan_generation_candidates WHERE id=?', [injected.id])).feature_mode, null);
  db.prepare(`INSERT INTO race_events(id,user_id,race_name,race_date,distance_miles,event_local_date,event_timezone)
    VALUES (?,?,?,?,?,?,?)`).run('owned-road', OTHER, 'Synthetic road event', '2026-10-18', 3.1, '2026-10-18', 'UTC');
  for (const mode of ['preview', 'on']) {
    let oldInvocations = 0;
    const adaptiveBefore = adaptiveComputations;
    try {
      await plans.previewPlanForUser(OTHER, { ...request, race_ids: ['owned-road'] }, { store: false,
        goalBackwardDependencies: { ...options(mode).goalBackwardDependencies, inspectInput: () => { oldInvocations++; } } });
    } catch (error) { assert.equal(error.code, 'GOAL_BACKWARD_GENERATION_FAILED'); }
    assert.ok(oldInvocations > 0, 'existing goal-backed preview/on computation retained');
    assert.equal(adaptiveComputations, adaptiveBefore);
  }
  // Failure after several real inserts must roll back the whole adaptive chain.
  const failCount = totalRows('planning_pipeline_artifacts');
  hooks.before = (method, sql, params) => { if (method === 'run' && sql.includes('INSERT INTO planning_pipeline_artifacts')
    && params[2] === 'validator_result') throw new Error('private-observation-canary@example.invalid'); };
  const fallback = await plans.previewPlanForUser(OWNER, request, options('shadow'));
  hooks.before = null;
  assert.equal(totalRows('planning_pipeline_artifacts'), failCount);
  assert.equal((await tx.get('SELECT feature_mode FROM plan_generation_candidates WHERE id=?', [fallback.id])).feature_mode, null);
  assert.deepEqual(fallback.plan, off.plan);
  assert.equal(diagnostics.at(-1).reason_code, 'PERSISTENCE_FAILED');
  assert.equal(JSON.stringify(diagnostics).includes('private-observation'), false);
  const storedBeforeFailure = totalRows('planning_pipeline_artifacts');
  hooks.before = (method, sql) => { if (method === 'all' && sql.includes('FROM planning_evidence_corrections')) throw new Error('private-source-failure'); };
  const sourceFailure = await plans.previewPlanForUser(OWNER, request, options('shadow'));
  hooks.before = null;
  assert.deepEqual(sourceFailure.plan, off.plan);
  assert.equal(totalRows('planning_pipeline_artifacts'), storedBeforeFailure);
  assert.equal(diagnostics.at(-1).reason_code, 'SOURCE_UNAVAILABLE');
  assert.equal(JSON.stringify(shadow.diagnosticSnapshot()).includes('private-source'), false);
  // A late revision change fails before candidate/artifact writes, including pruning.
  let transactions = 0;
  const staleCandidates = totalRows('plan_generation_candidates');
  hooks.beforeTransaction = () => { if (++transactions === 2) db.prepare('UPDATE users SET planning_input_revision=2 WHERE id=?').run(OWNER); };
  await assert.rejects(plans.previewPlanForUser(OWNER, request, options('shadow')), e => e.code === 'CANDIDATE_STALE');
  hooks.beforeTransaction = null;
  assert.equal(totalRows('plan_generation_candidates'), staleCandidates);
  await assert.rejects(shadow.readback({ tx, userId: OWNER, candidateId: response.id, binding }), /STALE_INPUT/);
  db.prepare('UPDATE users SET planning_input_revision=1 WHERE id=?').run(OWNER);
  let linkTransactions = 0;
  hooks.beforeTransaction = () => { if (++linkTransactions === 2) db.prepare('UPDATE runs SET planned_session_json=? WHERE id=? AND user_id=?')
    .run('{"matchSource":"unlinked"}', 'observed', OWNER); };
  const linkCandidates = totalRows('plan_generation_candidates');
  await assert.rejects(plans.previewPlanForUser(OWNER, request, options('shadow')), e => e.code === 'CANDIDATE_STALE');
  hooks.beforeTransaction = null;
  assert.equal(totalRows('plan_generation_candidates'), linkCandidates);
  db.prepare('UPDATE runs SET planned_session_json=? WHERE id=? AND user_id=?').run('{}', 'observed', OWNER);
  // Revisioned constraint deactivation also invalidates the captured readback.
  db.prepare(`INSERT INTO planning_constraints(id,user_id,constraint_kind,date_local,revision,active,attributed_by_user_id,attributed_payload_json)
    VALUES (?,?,?,?,?,?,?,?)`).run('constraint', OWNER, 'day_lock', DATE, 1, 0, OWNER, '{}');
  await assert.rejects(shadow.readback({ tx, userId: OWNER, candidateId: response.id, binding }), /STALE_INPUT/);
  db.prepare('DELETE FROM planning_constraints WHERE id=? AND user_id=?').run('constraint', OWNER);
  const artifact = receiptRows[0];
  db.prepare('UPDATE planning_pipeline_artifacts SET payload_json=? WHERE id=? AND user_id=?').run('{}', artifact.id, OWNER);
  await assert.rejects(shadow.readback({ tx, userId: OWNER, candidateId: response.id, binding }), /READBACK_INVALID/);
  db.prepare('UPDATE planning_pipeline_artifacts SET payload_json=? WHERE id=? AND user_id=?').run(artifact.payload_json, artifact.id, OWNER);
  const rejected = await plans.rejectPlanCandidate(OWNER, response.id, { candidate_hash: response.candidateHash });
  assert.equal(rejected.status, 200);
  assert.equal((await plans.rejectPlanCandidate(OTHER, repeat.id, { candidate_hash: repeat.candidateHash })).status, 404);
  const rejectedCount = totalRows('planning_pipeline_artifacts');
  await assert.rejects(plans.previewPlanForUser(OWNER, request, options('shadow')),
    error => error.code === 'IDENTICAL_REJECTED_CANDIDATE_SUPPRESSED');
  assert.equal(totalRows('planning_pipeline_artifacts'), rejectedCount);
  assert.equal(diagnostics.at(-1).reason_code, 'REJECTED_CANDIDATE');

  const applyBody = { candidate_hash: repeat.candidateHash, choice: 'train_for_target',
    planning_date_local: DATE, timezone_offset_minutes: 0 };
  const applied = await plans.applyPlanCandidate(OWNER, repeat.id, applyBody);
  assert.equal(applied.status, 200);
  const saved = db.prepare('SELECT plan_data FROM training_plans WHERE id=? AND user_id=?').get(applied.payload.plan_id, OWNER);
  assert.deepEqual(JSON.parse(saved.plan_data), off.plan);
  const replayApply = await plans.applyPlanCandidate(OWNER, repeat.id, applyBody);
  assert.deepEqual(replayApply.payload, applied.payload);
  assert.equal(totalRows('user_plans'), 1);
  // Existing legacy assignment has no accepted canonical source: foundation still
  // precedes legacy, while adaptive computation defers without changing assignment.
  const liveBefore = db.prepare('SELECT * FROM user_plans WHERE user_id=?').all(OWNER);
  const noCanonical = await plans.previewPlanForUser(OWNER, request, options('shadow'));
  assert.ok(noCanonical.plan);
  assert.equal(diagnostics.at(-1).reason_code, 'ACCEPTED_SOURCE_UNAVAILABLE');
  assert.deepEqual(db.prepare('SELECT * FROM user_plans WHERE user_id=?').all(OWNER), liveBefore);
  const historical = require('./helpers/adaptiveAcceptedFixture').acceptedFixture(db, OWNER, off.id);
  db.prepare('UPDATE runs SET avg_heart_rate=?,workout_metrics_json=? WHERE id=? AND user_id=?')
    .run(148, JSON.stringify({ hr_sample_coverage_pct: 96 }), 'linked-actual', OWNER);
  const acceptedBefore = db.prepare('SELECT * FROM user_plans WHERE user_id=?').all(OWNER);
  await plans.previewPlanForUser(OWNER, request, options('shadow'));
  const pairs = lastPrepared.foundation.athlete_state.adaptive_foundation.completion_pairs;
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].observation.completed, true);
  assert.equal(pairs[0].observation.observed_duration_s, historical.actualDuration);
  assert.notEqual(pairs[0].observation.observed_duration_s, historical.run.derived_totals.duration_s);
  assert.equal(pairs[0].observation.observed_work_duration_s, null);
  assert.equal(pairs[0].observation.observed_avg_heart_rate_bpm, 148);
  assert.equal(pairs[0].observation.heart_rate_resolution.quality_state, 'COMPLETE');
  assert.deepEqual(db.prepare('SELECT * FROM user_plans WHERE user_id=?').all(OWNER), acceptedBefore);
  db.prepare('UPDATE runs SET planned_session_json=? WHERE id=? AND user_id=?').run(
    JSON.stringify({ matchSource: 'explicit_owned_session', content_hash: 'f'.repeat(64) }), 'linked-actual', OWNER);
  await plans.previewPlanForUser(OWNER, request, options('shadow'));
  assert.equal(lastPrepared.foundation.athlete_state.adaptive_foundation.completion_pairs.length, 0);
  console.log('ok - authenticated accepted canonical history, measured completion pair, mismatched link withheld');
  console.log('ok - legacy SHADOW apply/replay preserved; missing accepted canonical source defers');
  console.log('ok - stale, constraints, body flag bypass, rollback, corrupt readback and owner-scoped rejection');
  // Real owner-scoped SQL inputs, no mocked coaching outcomes. Phone-local
  // dates include UTC+14 and both 23/25-hour America/New_York transitions.
  for (const [date, zone, offset, now] of [
    ['2026-09-14', 'Pacific/Kiritimati', -840, '2026-09-14T00:00:00Z'],
    ['2026-03-08', 'America/New_York', 240, '2026-03-08T12:00:00Z'],
    ['2026-11-01', 'America/New_York', 300, '2026-11-01T12:00:00Z'],
  ]) {
    DATE = date; NOW = now;
    db.prepare('DELETE FROM runs WHERE user_id=?').run(OTHER);
    db.prepare('INSERT INTO daily_checkins(id,user_id,checkin_date,feeling,time_available) VALUES (?,?,?,?,?)')
      .run(`clock-ready-${date}`, OTHER, date, 4, 120);
    db.prepare('INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds) VALUES (?,?,?,?,?,?)')
      .run(`clock-${date}`, OTHER, addDays(date, -2), 'easy', 4, 3600);
    const clockRequest = { ...request, planning_date_local: date, planning_timezone: zone, timezone_offset_minutes: offset };
    const legacy = await plans.previewPlanForUser(OTHER, clockRequest, { ...options('off'), store: false });
    const adaptive = await plans.previewPlanForUser(OTHER, clockRequest, options('shadow'));
    assert.equal(adaptive.candidateHash, legacy.candidateHash, 'clock upgrade retains legacy candidate identity');
    assert.equal(lastPrepared.foundation.athlete_state.planning_date_local, date);
    assert.equal(lastPrepared.foundation.artifacts[0].created_at, new RealDate(now).toISOString());
    assert.ok(lastPrepared.availability.run.some(w => w.start_at.slice(0, 10)), 'clock has real placements');
    for (const w of lastPrepared.availability.run) {
      assert.equal(require('../src/lib/adaptiveCoachingValidation').localDate(w.start_at, zone),
        require('../src/lib/adaptiveCoachingValidation').localDate(Date.parse(w.end_at) - 1, zone));
      assert.ok(Date.parse(w.end_at) - Date.parse(w.start_at) <= 86400000);
      assert.ok(Date.parse(w.start_at) >= Date.parse(now));
    }
    const stages = await tx.all('SELECT * FROM planning_pipeline_artifacts WHERE plan_generation_candidate_id=?', [adaptive.id]);
    assert.equal(stages.length, 6, JSON.stringify({ date, diagnostic: diagnostics.at(-1), week: JSON.parse(stages.find(r => r.artifact_kind === 'candidate_week')?.payload_json || '{}') }));
    assert.ok(JSON.parse(stages.find(r => r.artifact_kind === 'canonical_session_set').payload_json).sessions.some(s => s.kind === 'run'));
  }
  DATE = '2026-09-14'; NOW = `${DATE}T12:00:00Z`;
  db.prepare('UPDATE users SET training_age_class=? WHERE id=?').run('ESTABLISHED', OTHER);
  db.prepare('DELETE FROM runs WHERE user_id=?').run(OTHER);
  for (let i = 1; i <= 28; i++) db.prepare('INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds) VALUES (?,?,?,?,?,?)')
    .run(`stack-history-${i}`, OTHER, addDays(DATE, -i), 'easy', 6, 3600);
  db.prepare('UPDATE daily_checkins SET feeling=?,time_available=? WHERE user_id=? AND checkin_date=?').run(4, 180, OTHER, DATE);
  const stacked = await plans.previewPlanForUser(OTHER, { ...request, target: { ...request.target,
    runDaysPerWeek: 6, liftDaysPerWeek: 1, liftingEnabled: true,
    liftEligibleWeekdays: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'] } }, options('shadow'));
  const stackRows = await tx.all('SELECT * FROM planning_pipeline_artifacts WHERE plan_generation_candidate_id=?', [stacked.id]);
  const stackState = JSON.parse(stackRows.find(r => r.artifact_kind === 'athlete_state').payload_json);
  assert.equal(stackState.recent_normal_running.status, 'INSUFFICIENT');
  assert.equal(stackState.recent_normal_running.median_duration_s, null);
  const stackDecision = JSON.parse(stackRows.find(r => r.artifact_kind === 'planning_decision').payload_json);
  assert.equal(stackDecision.weekly_objectives.dose_policy.forward_lower_bound_seed.coverage_state, 'UNKNOWN');
  const stackSessions = JSON.parse(stackRows.find(r => r.artifact_kind === 'canonical_session_set').payload_json).sessions;
  assert.equal(stackSessions.filter(s => s.kind === 'run').length, 6);
  assert.equal(stackSessions.filter(s => s.kind === 'lift').length, 1);
  const pair = stackSessions.filter(s => s.workout_family !== 'rest').find(s =>
    stackSessions.some(t => t.session_id !== s.session_id && t.kind !== s.kind && t.scheduled_local_date === s.scheduled_local_date));
  assert.ok(pair, 'six running days plus meaningful strength require a genuine same-day stack and a rest date');
  const sameDay = stackSessions.filter(s => s.scheduled_local_date === pair.scheduled_local_date)
    .sort((a,b) => a.scheduled_start_at.localeCompare(b.scheduled_start_at));
  assert.ok(Date.parse(sameDay[1].scheduled_start_at) - Date.parse(sameDay[0].scheduled_start_at)
    - sameDay[0].derived_totals.duration_s * 1000 >= 6 * 3600000);
  assert.ok(stackSessions.some(s => s.workout_family === 'rest' && s.purpose_reason_codes.length));
  db.prepare(`INSERT INTO race_events(id,user_id,race_name,race_date,distance_miles,event_local_date,event_timezone)
    VALUES (?,?,?,?,?,?,?)`).run('clock-owned-event', OTHER, 'Synthetic owned road', '2026-09-19', 5000 / 1609.344, '2026-09-19', 'UTC');
  const eventPreview = await plans.previewPlanForUser(OTHER, { ...request, race_ids: ['clock-owned-event'],
    event_material: [{ distance_m: 999999 }], target: { ...request.target, runDaysPerWeek: 2 } }, options('shadow'));
  const eventRows = await tx.all('SELECT * FROM planning_pipeline_artifacts WHERE plan_generation_candidate_id=?', [eventPreview.id]);
  assert.equal(eventRows.length, 6, JSON.stringify(diagnostics.at(-1)));
  const eventSessions = JSON.parse(eventRows.find(r => r.artifact_kind === 'canonical_session_set').payload_json).sessions;
  const ownedEvent = eventSessions.find(s => s.workout_family === 'race');
  assert.ok(ownedEvent);
  assert.equal(ownedEvent.event_identity.race_id, 'clock-owned-event');
  assert.equal(ownedEvent.scheduled_local_date, '2026-09-19');
  assert.equal(ownedEvent.derived_totals.work_distance_m, 5000);
  assert.ok(ownedEvent.steps.every(s => !s.target?.pace_range_s_per_km));
  console.log('ok - real SQL server-owned road event ignores body event material; reconciled observed HR preserved');
  console.log('ok - real SQL phone clock UTC+14/DST, legacy hashes, unknown-coverage forward cap and six-run same-day hybrid stack');
  console.log('ok - real route SHADOW, six persisted stages, replay, shared hashes, scopes, no exposure or assignments');
}
main().catch(error => { console.error(error.code || error.name, error.message, error.stack.split('\n').filter(line => line.trim().startsWith('at ')).join('\n')); process.exitCode = 1; }).finally(() => { global.Date = RealDate; shadow.prepare = realPrepare; shadow.compute = realCompute; engine.buildRacePlanCandidate = realLegacy; db.close(); });
