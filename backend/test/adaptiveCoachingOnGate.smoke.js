// Focused real-SQL ON generation/apply/export gate. No network or model calls.
const assert = require('node:assert/strict');
const { createDb } = require('./helpers/adaptiveShadowDb');
const { targetRef } = require('../src/lib/betaPlanRollout');
const fixture = createDb();
const { db } = fixture;
const sqlGet = fixture.tx.get;
fixture.tx.get = (sql, params) => sqlGet(sql.replace(/FOR UPDATE OF (?:up|tp)/g, 'FOR UPDATE'), params);
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fixture.exports };
const RealDate = Date;
let NOW = '2026-09-14T12:00:00Z';
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return RealDate.parse(NOW); }
};
const plans = require('../src/routes/plans')._test;
const OWNER = '11111111-1111-4111-8111-111111111111';
const request = { planning_date_local: '2026-09-14', planning_timezone: 'UTC', timezone_offset_minutes: 0,
  target: { runDaysPerWeek: 2, liftDaysPerWeek: 0, trainingDays: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'] } };
const telemetry = [];
const options = (mode, cohortRefs = [targetRef(OWNER)]) => ({ goalBackwardDependencies: {
  mode, audience: 'cohort', cohortRefs, telemetrySink: row => telemetry.push(row),
} });
async function main() {
  db.prepare(`INSERT INTO users(id,name,email,password_hash,timezone,training_age_class,planning_input_revision)
    VALUES (?,'Synthetic','preview@example.invalid','','UTC','BEGINNER',1)`).run(OWNER);
  db.prepare(`INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds)
    VALUES ('observed',?,'2026-09-12','easy',4,3600)`).run(OWNER);
  db.prepare(`INSERT INTO daily_checkins(id,user_id,checkin_date,feeling,time_available)
    VALUES ('ready',?,'2026-09-14',4,60)`).run(OWNER);
  const on = await plans.previewPlanForUser(OWNER, request, options('on'));
  assert.equal(on.surfaceManifest.status, 'preview');
  assert.equal(on.surfaceManifest.feature_mode, 'on');
  assert.equal(on.surfaceManifest.apply_disabled, false);
  assert.equal(on.surfaceManifest.surface_capability, 'EXECUTABLE');
  assert.equal(plans.publicCandidatePayload(on).requires_apply, true);
  assert.equal(plans.publicCandidatePayload(on).generation_source, 'adaptive-joint-solver-v1');
  const { buildFitWorkoutRepresentation } = await import('../../frontend/src/services/fit/encodeWorkoutFit.js');
  const sessionId = on.surfaceManifest.sessions.find(s => s.kind === 'run').session_id;
  assert.throws(() => buildFitWorkoutRepresentation({ surfaceManifest: on.surfaceManifest, sessionId, exportRevision: 1 }),
    e => e.code === 'CANONICAL_MANIFEST_NOT_ACCEPTED');
  const body = { ...on.applyBindings, candidate_hash: on.candidateHash, choice: 'train_for_target', planning_date_local: request.planning_date_local };
  for (const deps of [options('off'), options('preview'), options('on', [])]) {
    assert.equal((await plans.applyPlanCandidate(OWNER, on.id, body, deps)).code, 'GOAL_BACKWARD_MODE_UNAVAILABLE');
  }
  assert.equal((await plans.applyPlanCandidate('22222222-2222-4222-8222-222222222222', on.id, body, options('on'))).code, 'CANDIDATE_NOT_FOUND');
  const originalArtifact = db.prepare("SELECT * FROM planning_pipeline_artifacts WHERE plan_generation_candidate_id=? AND artifact_kind='surface_manifest'").get(on.id);
  db.prepare('UPDATE planning_pipeline_artifacts SET payload_json=? WHERE id=?').run('{}', originalArtifact.id);
  assert.equal((await plans.applyPlanCandidate(OWNER, on.id, body, options('on'))).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_plans').get().n, 0);
  db.prepare('UPDATE planning_pipeline_artifacts SET payload_json=? WHERE id=?').run(originalArtifact.payload_json, originalArtifact.id);
  const applied = await plans.applyPlanCandidate(OWNER, on.id, body, options('on'));
  assert.equal(applied.status, 200, JSON.stringify(applied));
  const active = await fixture.tx.get('SELECT up.*, up.id AS user_plan_id, tp.plan_json FROM user_plans up JOIN training_plans tp ON tp.id=up.plan_id WHERE up.user_id=? AND up.status=?', [OWNER, 'active']);
  const manifest = await plans.canonicalSurfaceManifestForActive(OWNER, active, fixture.tx.get);
  assert.equal(manifest.status, 'accepted');
  assert.ok(buildFitWorkoutRepresentation({ surfaceManifest: manifest, sessionId, exportRevision: 1 }));
  assert.equal((await plans.applyPlanCandidate(OWNER, on.id, body, options('on'))).replay, true);
  NOW = '2026-09-21T12:00:00Z';
  db.prepare("UPDATE daily_checkins SET checkin_date='2026-09-21' WHERE user_id=?").run(OWNER);
  db.prepare("UPDATE runs SET date='2026-09-19' WHERE user_id=?").run(OWNER);
  const successorRequest = { ...request, planning_date_local: '2026-09-21' };
  const successor = await plans.previewPlanForUser(OWNER, successorRequest, options('on'));
  assert.equal(successor.plan.plan_revision, 2);
  const replaced = await plans.applyPlanCandidate(OWNER, successor.id, { ...successor.applyBindings,
    candidate_hash: successor.candidateHash, choice: 'train_for_target', planning_date_local: '2026-09-21' }, options('on'));
  assert.equal(replaced.status, 200, JSON.stringify(replaced));
  const successorActive = await fixture.tx.get('SELECT up.*, up.id AS user_plan_id, tp.plan_json FROM user_plans up JOIN training_plans tp ON tp.id=up.plan_id WHERE up.user_id=? AND up.status=?', [OWNER, 'active']);
  const successorManifest = await plans.canonicalSurfaceManifestForActive(OWNER, successorActive, fixture.tx.get);
  assert.equal(successorManifest.status, 'accepted');
  assert.equal(successorManifest.identity.plan_revision, 2);
  console.log('ok - adaptive ON generation, owner/mode guards, apply, accepted manifest and FIT authority');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  global.Date = RealDate; db.close();
});
