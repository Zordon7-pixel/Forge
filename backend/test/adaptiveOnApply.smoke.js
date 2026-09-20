// Phase 3 witnesses use real route functions, solver and in-memory SQL.
// Synthetic source rows are explicit test setup, never production evidence.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDb } = require('./helpers/adaptiveShadowDb');
const fixture = createDb();
const { db, hooks } = fixture;
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fixture.exports };
const RealDate = Date, NOW = '2026-09-14T12:00:00Z';
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return RealDate.parse(NOW); }
};
const plans = require('../src/routes/plans')._test;
const { targetRef } = require('../src/lib/betaPlanRollout');
const OWNER = '11111111-1111-4111-8111-111111111111';
const request = { planning_date_local: '2026-09-14', planning_timezone: 'UTC', timezone_offset_minutes: 0,
  target: { runDaysPerWeek: 2, liftDaysPerWeek: 0, trainingDays: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'] } };
const options = (mode, cohortRefs = [targetRef(OWNER)]) => ({ goalBackwardDependencies: {
  mode, audience: 'cohort', cohortRefs, telemetrySink: () => {},
} });
const bodyFor = candidate => ({ ...candidate.applyBindings, candidate_hash: candidate.candidateHash,
  choice: 'train_for_target', planning_date_local: request.planning_date_local });
const snapshot = () => Object.fromEntries(['users','runs','training_plans','user_plans','plan_generation_candidates','planning_pipeline_artifacts']
  .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
async function main() {
  db.prepare(`INSERT INTO users(id,name,email,password_hash,timezone,training_age_class,planning_input_revision)
    VALUES (?,'Synthetic','on-witness@example.invalid','','UTC','BEGINNER',1)`).run(OWNER);
  db.prepare(`INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds)
    VALUES ('observed',?,'2026-09-12','easy',4,3600)`).run(OWNER);
  db.prepare(`INSERT INTO daily_checkins(id,user_id,checkin_date,feeling,time_available)
    VALUES ('ready',?,'2026-09-14',4,60)`).run(OWNER);
  const report = { schema_version: 1, fixture_kind: 'synthetic-real-sql-route', completed: false, witnesses: {} };
  const off = await plans.previewPlanForUser(OWNER, request, options('off'));
  const excluded = await plans.previewPlanForUser(OWNER, request, options('on', []));
  assert.deepEqual(excluded.plan, off.plan);
  assert.equal(excluded.candidateHash, off.candidateHash);
  assert.equal(excluded.surfaceManifest, undefined);
  const preview = await plans.previewPlanForUser(OWNER, request, options('preview'));
  for (const mode of ['off','shadow','preview','on']) {
    const before = snapshot();
    const denied = await plans.applyPlanCandidate(OWNER, preview.id, bodyFor(preview), options(mode));
    assert.equal(denied.code, 'GOAL_BACKWARD_PREVIEW_APPLY_DISABLED');
    assert.deepEqual(snapshot(), before, 'preview denial has zero writes');
  }
  report.witnesses['ON-C'] = { pass: true, code: 'GOAL_BACKWARD_PREVIEW_APPLY_DISABLED', runtime_modes_tested: ['off','shadow','preview','on'], zero_writes: true };
  const on = await plans.previewPlanForUser(OWNER, request, options('on'));
  const publicOn = plans.publicCandidatePayload(on);
  assert.equal(publicOn.generation_source, 'adaptive-joint-solver-v1');
  assert.equal(publicOn.requires_apply, true);
  assert.equal(on.surfaceManifest.feature_mode, 'on');
  assert.equal(on.surfaceManifest.status, 'preview');
  assert.equal(on.surfaceManifest.surface_capability, 'EXECUTABLE');
  assert.equal(on.surfaceManifest.apply_disabled, false);
  const row = db.prepare('SELECT * FROM plan_generation_candidates WHERE id=? AND user_id=?').get(on.id, OWNER);
  assert.equal(row.feature_mode, 'on');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM planning_pipeline_artifacts WHERE plan_generation_candidate_id=?').get(on.id).n, 7);
  report.witnesses['ON-A'] = { pass: true, engine: publicOn.generation_source, feature_mode: row.feature_mode,
    candidate_hash: on.candidateHash, artifact_count: 7, surface_status: on.surfaceManifest.status, apply_disabled: false };
  const { buildFitWorkoutRepresentation } = await import('../../frontend/src/services/fit/encodeWorkoutFit.js');
  const sessionId = on.surfaceManifest.sessions.find(s => s.kind === 'run').session_id;
  assert.throws(() => buildFitWorkoutRepresentation({ surfaceManifest: on.surfaceManifest, sessionId, exportRevision: 1 }), e => e.code === 'CANONICAL_MANIFEST_NOT_ACCEPTED');
  const { adaptivePreviewSessions } = await import('../../frontend/src/lib/adaptivePreviewView.js');
  assert.equal(adaptivePreviewSessions(publicOn, Date.now()).length, 7, 'actual public ON payload renders the seven-day review');
  const body = bodyFor(on);
  for (const deps of [options('off'),options('shadow'),options('preview'),options('on',[]),options('on',[OWNER])]) {
    const before = snapshot();
    assert.equal((await plans.applyPlanCandidate(OWNER, on.id, body, deps)).code, 'GOAL_BACKWARD_MODE_UNAVAILABLE');
    assert.deepEqual(snapshot(), before, 'runtime/audience denial has zero writes');
  }
  const beforeOwner = snapshot();
  assert.equal((await plans.applyPlanCandidate('22222222-2222-4222-8222-222222222222', on.id, body, options('on'))).code, 'CANDIDATE_NOT_FOUND');
  assert.deepEqual(snapshot(), beforeOwner);
  report.witnesses['ON-D'] = { pass: true, code: 'GOAL_BACKWARD_MODE_UNAVAILABLE', owner_code: 'CANDIDATE_NOT_FOUND',
    excluded_generation_matches_off: true, denied_modes: ['off','shadow','preview'], denied_cohorts: ['empty','raw-id'], zero_writes: true };
  // Apply must reproduce and recheck inputs, not merely trust a writable ON marker.
  const beforeStale = snapshot();
  const stale = await plans.applyPlanCandidate(OWNER, on.id, { ...body, athlete_state_revision: body.athlete_state_revision + 1 }, options('on'));
  assert.equal(stale.status, 409);
  assert.deepEqual(snapshot(), beforeStale);
  // Failure at the actual assignment write must roll back all mutations.
  hooks.before = (method, sql) => { if (method === 'run' && sql.includes('INSERT INTO user_plans')) throw new Error('synthetic assignment fault'); };
  await assert.rejects(plans.applyPlanCandidate(OWNER, on.id, body, options('on')), /synthetic assignment fault/);
  hooks.before = null;
  assert.deepEqual(snapshot(), beforeStale);
  const applied = await plans.applyPlanCandidate(OWNER, on.id, body, options('on'));
  assert.equal(applied.status, 200, JSON.stringify(applied));
  const active = await fixture.tx.get(`SELECT up.*,up.id AS user_plan_id,tp.plan_json FROM user_plans up
    JOIN training_plans tp ON tp.id=up.plan_id WHERE up.user_id=? AND up.status='active'`, [OWNER]);
  const stored = db.prepare('SELECT * FROM plan_generation_candidates WHERE id=? AND user_id=?').get(on.id, OWNER);
  assert.equal(stored.status, 'applied');
  assert.equal(stored.applied_user_plan_id, active.id);
  assert.equal(stored.applied_training_plan_id, active.plan_id);
  assert.deepEqual(JSON.parse(active.plan_json), on.plan);
  const manifest = await plans.canonicalSurfaceManifestForActive(OWNER, active, fixture.tx.get);
  assert.equal(manifest.status, 'accepted');
  assert.equal(manifest.feature_mode, 'on');
  assert.equal(manifest.authoritative_engine, 'adaptive-joint-solver-v1');
  assert.deepEqual(manifest.sessions, on.surfaceManifest.sessions);
  assert.ok(buildFitWorkoutRepresentation({ surfaceManifest: manifest, sessionId, exportRevision: manifest.export_revision }));
  const afterApply = snapshot();
  assert.equal((await plans.applyPlanCandidate(OWNER, on.id, body, options('on'))).replay, true);
  assert.deepEqual(snapshot(), afterApply, 'replay cannot duplicate assignment/artifacts or increment inputs');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM user_plans WHERE user_id=? AND status='active'").get(OWNER).n, 1);
  report.witnesses['ON-B'] = { pass: true, apply_status: applied.status, candidate_hash: stored.candidate_hash,
    active_assignment_count: 1, bound_assignment: true, canonical_plan_equal: true, accepted_surface_status: manifest.status,
    export_revision: manifest.export_revision, fit_export_verified: true, preaccept_export_blocked: true, replay_zero_writes: true };
  report.additional_guards = { stale_envelope_code: stale.code, assignment_fault_rollback: true, public_review_session_count: 7 };
  assert.deepEqual(Object.keys(report.witnesses).sort(), ['ON-A','ON-B','ON-C','ON-D']);
  report.completed = true;
  if (process.env.FORGE_PHASE3_WITNESS_DIR) {
    const dir = path.resolve(process.env.FORGE_PHASE3_WITNESS_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'witnesses.json'), JSON.stringify(report, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'public-on.json'), JSON.stringify(publicOn, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { global.Date = RealDate; db.close(); });
