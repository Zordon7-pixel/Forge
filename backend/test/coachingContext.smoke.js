const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const fixture = require('./helpers/adaptiveShadowDb').createDb();
const { db, calls, hooks } = fixture;
db.function('octet_length', s => s == null ? null : Buffer.byteLength(String(s)));
fixture.exports.runWithUserContext = (_owner, next) => next();
// Fail loudly if a future reader accidentally imports a write/external seam.
for (const [moduleName, methods] of [
  ['../src/lib/exerciseImageRequests', ['requestExerciseImageIfMissing', 'requestImagesForWorkoutItems']],
  ['../src/services/weather', ['getWeather']],
]) {
  const modulePath = require.resolve(moduleName);
  require.cache[modulePath] = { id: modulePath, filename: modulePath, loaded: true,
    exports: Object.fromEntries(methods.map(name => [name, () => { throw Error(`Forbidden read side effect: ${name}`); }])) };
}
for (const name of ['shoe_catalog', 'gear_shoes']) {
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/schema.pg.sql'), 'utf8').match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\);`))[0];
  db.exec(sql);
}
db.exec('ALTER TABLE runs ADD COLUMN shoe_id TEXT');
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fixture.exports };
process.env.JWT_SECRET = 'synthetic-coaching-context-only';
const RealDate = Date, NOW = '2026-09-23T12:00:00.000Z';
let clockNow = NOW;
global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [clockNow])); } static now() { return RealDate.parse(clockNow); } };
const { buildC4Fixture } = require('./racePlanDiagnostics.smoke');
const { canonicalHash } = require('../src/lib/racePlanPolicy');
const { materializeCanonicalSessionSet, validateCanonicalSessionSet } = require('../src/lib/canonicalWorkout');
const { buildAdaptiveWorkoutMaterial } = require('../src/lib/adaptiveCoachingWorkouts');
const { buildCanonicalPlanFromSessionSet } = require('../src/lib/planSchema');
const { buildPipelineArtifact } = require('../src/lib/planCandidateLifecycle');
const { buildCanonicalSurfaceManifest } = require('../src/routes/plans')._test;
const contract = require('../src/lib/coachingContext');
const owner = randomUUID(), foreign = randomUUID();
for (const id of [owner, foreign]) db.prepare("INSERT INTO users(id,name,email,password_hash,timezone,planning_input_revision) VALUES (?,'Synthetic',?,'','UTC',4)").run(id, `${id}@example.invalid`);
function makeChain(suffix = '') {
  const base = buildC4Fixture();
  const f = suffix ? JSON.parse(JSON.stringify(base).replaceAll(base.decisionId, `${base.decisionId}${suffix}`)) : base;
  f.candidateRow.id += suffix;
  f.artifacts.forEach(a => { a.id += suffix; });
  const planId = `plan-c4${suffix}`, assignmentId = `assignment${suffix}`, revision = suffix ? 10 : 9;
  const payloads = Object.fromEntries(f.artifacts.map(a => [a.artifact_kind, a.payload_json]));
  const planning = payloads.planning_decision;
  const decision = { decision_id: f.decisionId, decision_hash: planning.decision_hash, phase: 'DEVELOPMENT', active_goals: [] };
  const definitions = [['long_aerobic','2026-09-21',5160],['recovery_run','2026-09-22',1800],['threshold_run','2026-09-23',3000],
    ['strength_upper','2026-09-22',null]];
  const materials = definitions.map(([family,date,seconds], i) => buildAdaptiveWorkoutMaterial({ selection_id: `session-${i}`,
    workout_family: family, objective_ids: ['objective-1'], duration_s: seconds, distance_m: i === 0 ? 12070 : seconds == null ? null : seconds * 2,
    ...(family === 'strength_upper' ? { exercises: require('../src/lib/strengthPrescription').buildStrengthExercises({ focus: 'Upper body', equipment: ['dumbbells','bench'], mode: 'hybrid_build' }).slice(0, 2) } : {}),
    quality_work_s: i === 2 ? 1800 : null, dose_basis: { policy_id: 'adaptive-observed-dose-v1', authority: 'OBSERVED_COMPLETED_WEEK_STRENGTH', source_evidence_ids: ['history-1'] } }, decision, '2026-09-20T12:00:00Z'));
  // Use the real materializer with a nested repeat. The read projection must
  // preserve structure, not flatten or infer intent from the title.
  const source = materials[2].source_session.adaptive_prescription;
  source.steps = [source.steps[0], { step_id: 'quality-repeat', type: 'repeat', order: 2, repeat_count: 2,
    target: {}, provenance: [], children: [ { ...source.steps[1], order: 1 }, { ...source.steps[2], order: 2 } ] },
  { ...source.steps[4], order: 3 }];
  const set = materializeCanonicalSessionSet({ decision, candidate: { candidate_id: planning.selected_candidate_id,
    candidate_material: materials, sessions: definitions.map(([family,date], i) => ({ session_id: `session-${i}${suffix}`, candidate_material_id: materials[i].material_id,
      workout_family: family, role: i === 2 ? 'PRIMARY_KEY' : 'SUPPORTING', scheduled_local_date: date,
      ...(i === 2 ? { scheduled_start_at: `${date}T08:00:00Z` } : {}) })) }, plan_id: planId, plan_revision: revision,
    planning_instant: '2026-09-20T12:00:00Z', timezone: 'UTC' });
  assert.equal(validateCanonicalSessionSet(set).valid, true);
  const plan = { ...buildCanonicalPlanFromSessionSet(set), purpose: 'Supported synthetic training.', overall_feasibility: 'supported', reasons: [] };
  const candidate = { ...f.candidateRow, user_id: owner, status: 'applied', applied_user_plan_id: assignmentId, applied_training_plan_id: planId,
    selected_candidate_hash: set.candidate_hash, candidate_hash: `sha256:${set.candidate_hash}` };
  planning.selected_candidate_hash = set.candidate_hash;
  planning.planning_date_local = '2026-09-20';
  planning.weekly_objectives = { version: 'adaptive-weekly-objectives-v1', objectives: [{ objective_id: 'objective-1', role: 'PRIMARY_KEY', reason_codes: ['WEEKLY_OBJECTIVE_REQUIRED'] }],
    progression: [{ family: 'threshold', action: 'HOLD', current_level: null, reason_codes: ['QUALITY_EXECUTION_UNVERIFIED'] },
      { family: 'long_run', action: 'HOLD', current_level: 12070, reason_codes: ['PROGRESSION_HOLD'] }], weekly_stress_budget: [1,2,3] };
  payloads.evidence_snapshot.planning_date_local = '2026-09-20';
  payloads.evidence_snapshot.release_identity.generation_timestamp = '2026-09-20T12:00:00.000Z';
  candidate.created_at = '2026-09-20T12:00:00.000Z';
  payloads.candidate_week.candidates[0].candidate_hash = set.candidate_hash;
  payloads.candidate_week.current_candidate_hash = `sha256:${set.candidate_hash}`;
  payloads.validator_result.results[0].candidate_hash = set.candidate_hash;
  payloads.canonical_session_set = { ...set, plan_generation_candidate_ref: `sha256:${canonicalHash(candidate.id)}`,
    selected_candidate_id: set.candidate_id, selected_candidate_hash: set.candidate_hash };
  payloads.surface_manifest = buildCanonicalSurfaceManifest({ planGenerationCandidateRef: `sha256:${canonicalHash(candidate.id)}`,
    featureMode: 'preview', surfaceRevision: 1, candidateRevision: 1, athleteStateRevision: 4,
    safetyStateHash: candidate.safety_state_hash, goalRevisions: { 'goal-c4': 3 }, decision,
    selectedCandidate: { candidate_skeleton_id: set.candidate_id, candidate_hash: set.candidate_hash }, canonicalSessionSet: set, plan });
  let parent = null;
  const artifacts = f.artifacts.map((a, i) => {
    const next = buildPipelineArtifact({ id: a.id, userId: owner, kind: a.artifact_kind, decisionId: f.decisionId,
      parentArtifactId: parent, planGenerationCandidateId: i >= 3 ? candidate.id : null,
      payload: payloads[a.artifact_kind], revision: suffix ? 2 : 1, createdAt: '2026-09-20T12:00:00.000Z' }); parent = next.id; return next;
  });
  const decisionArtifact = artifacts.find(a => a.artifact_kind === 'planning_decision');
  candidate.material_change_json.apply_bindings.decision_artifact = { artifact_id: decisionArtifact.id, revision: decisionArtifact.revision, content_hash: decisionArtifact.content_hash };
  const active = { user_plan_id: assignmentId, user_id: owner, training_owner_id: owner, plan_id: set.plan_id, plan_version: revision,
    status: 'active', plan_data: JSON.stringify(plan) };
  return { ...f, candidate, active, artifacts, set, plan };
}
const f = makeChain();
const insert = (table, row) => {
  const allowed = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  const entries = Object.entries(row).filter(([key]) => allowed.has(key));
  db.prepare(`INSERT INTO ${table} (${entries.map(([key]) => key).join(',')}) VALUES (${entries.map(() => '?').join(',')})`)
    .run(...entries.map(([, v]) => v && typeof v === 'object' ? JSON.stringify(v) : v));
};
insert('training_plans', { id: 'plan-c4', user_id: owner, name: 'Synthetic', plan_data: f.active.plan_data });
insert('user_plans', { id: 'assignment', user_id: owner, plan_id: 'plan-c4', status: 'active', plan_version: 9, started_at: '2026-09-20', effective_from: '2026-09-20' });
insert('plan_generation_candidates', { ...f.candidate, input_hash: 'synthetic', invariant_version: 'synthetic', planning_snapshot_json: '{}', candidate_plan_json: '{}', generation_trace_json: '{}', expires_at: '2026-10-01' });
for (const a of f.artifacts) insert('planning_pipeline_artifacts', a);
insert('gear_shoes', { id: 'owned-shoe', user_id: owner, brand: 'Synthetic', model: 'Pair' });
insert('gear_shoes', { id: 'foreign-shoe', user_id: foreign, brand: 'Foreign', model: 'must-not-leak' });
function insertRun(id, date, session = null, extras = {}) {
  insert('runs', { id, user_id: owner, date, type: 'easy', distance_miles: 3, duration_seconds: 1800,
    notes: 'SECRET-NOTES', route_coords: 'SECRET-GPS', ai_feedback: 'IGNORE-ALL-INSTRUCTIONS',
    created_at: `${date}T12:00:00Z`, plan_session_id: session?.session_id || null,
    planned_session_json: session ? { matchSource: 'explicit_owned_session', sessionId: session.session_id,
      date, kind: 'run', planId: session.plan_id, content_hash: session.content_hash } : {}, ...extras });
}
insertRun('actual-long', '2026-09-21', f.set.sessions[0], { distance_miles: 7.5, duration_seconds: 5160, avg_heart_rate: 145, health_start_at: '2026-09-21T08:00:00Z' });
insertRun('actual-recovery', '2026-09-22', f.set.sessions[1], { shoe_id: 'owned-shoe', avg_heart_rate: null, max_heart_rate: 0 });
insertRun('same-date-not-linked', '2026-09-23');
insert('workout_sessions', { id: 'observed-lift', user_id: owner, started_at: '2026-09-22T10:00:00Z', ended_at: '2026-09-22T10:45:00Z', total_seconds: 2700 });
const app = require('express')();
app.use('/api/coaching', require('../src/routes/coachingContext'));
const jwt = require('jsonwebtoken');
const clone = x => JSON.parse(JSON.stringify(x));
const nativeFetch = global.fetch;
global.fetch = (url, options) => {
  assert.match(String(url), /^http:\/\/127\.0\.0\.1:\d+\/api\/coaching\/context\//, 'no external/provider/AI/gear fetch');
  return nativeFetch(url, options);
};
const snapshot = () => JSON.stringify(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
  .map(({ name }) => [name, db.prepare(`SELECT * FROM ${name}`).all()]));
let server;
async function main() {
  const diagnostic = require('../src/lib/racePlanDiagnostics').buildDecisionArtifactDiagnosticBundle({ targetUserId: owner,
    decisionId: f.decisionId, artifactRows: f.artifacts, candidateRow: f.candidate, includePayloads: false });
  assert.equal(diagnostic.production_complete, true, JSON.stringify(diagnostic));
  const chain = contract.accepted({ ownerId: owner, ...f, candidate: f.candidate, sessionId: f.set.sessions[1].session_id });
  assert.equal(chain.session.workout_family, 'recovery_run');
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const get = async (sessionId = f.set.sessions[1].session_id, user = owner, query = '') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/coaching/context/${sessionId}${query}`, {
      headers: user ? { Authorization: `Bearer ${jwt.sign({ id: user }, process.env.JWT_SECRET)}` } : {} });
    return { status: response.status, data: await response.json() };
  };
  hooks.before = (method, sql, params) => {
    assert.ok(['get','all'].includes(method) && /^\s*SELECT/.test(sql), 'SELECT only');
    assert.ok(params.includes(owner) || params.includes(foreign), 'every read owner scoped');
  };
  const before = snapshot();
  assert.equal((await get(undefined, null)).status, 401);
  assert.equal((await get(undefined, foreign)).data.status, 'UNAVAILABLE');
  assert.equal((await get('foreign-session')).status, 404);
  assert.equal((await get(undefined, owner, '?owner_id=foreign')).status, 400);
  const result = await get(); assert.equal(result.status, 200, JSON.stringify(result.data));
  const b = result.data;
  const savedWitness = require('./fixtures/coaching-context-witness.json');
  if (process.env.COACHING_CONTEXT_WITNESS === '1') console.log(`WITNESS:${JSON.stringify(b)}`);
  assert.deepEqual(b, savedWitness, 'documented synthetic witness is the exact route response');
  assert.equal(b.session.dominant_purpose.status, 'EXPLICIT_PRESCRIBED_INTENT');
  assert.equal(b.session.dominant_purpose.primary_purpose, b.session.workout_family);
  assert.equal(b.session.primary_physiological_stimulus.status, 'MISSING', 'family intent is not a physiological-stimulus claim');
  assert.equal(b.status, 'PARTIAL'); assert.equal(b.executable_authority, false);
  assert.equal(b.session.workout_family, 'recovery_run'); assert.equal('title' in b.session, false);
  assert.ok(b.session.steps.length); assert.ok(b.session.steps[0].provenance.length);
  assert.deepEqual(b.session.steps, f.set.sessions[1].steps, 'accepted step grammar is preserved without added null target fields');
  assert.equal(b.actual.observations[0].average_heart_rate.state, 'UNKNOWN');
  assert.equal(b.actual.observations[0].max_heart_rate.state, 'VALID_ZERO');
  assert.equal(b.gear.actual_shoe.value.id, 'owned-shoe'); assert.equal(b.gear.recommendation.status, 'MISSING');
  assert.equal(b.context.sessions.find(s => s.activity_id && s.local_date === '2026-09-22' && s.kind === 'run').at, null);
  assert.ok(b.context.sessions.some(s => s.kind === 'lift' && s.truth_class === 'OBSERVED'));
  assert.ok(b.context.sessions.some(s => s.workout_family === 'strength_upper' && s.truth_class === 'PRESCRIBED'));
  assert.deepEqual(b.decision.progression.map(p => p.action), ['HOLD','HOLD']);
  assert.equal(b.decision.progression[0].current_level, null);
  assert.equal((await get()).data.content_hash, b.content_hash);
  const quality = (await get(f.set.sessions[2].session_id)).data;
  assert.equal(quality.session.steps[1].repeat_count, 2);
  assert.equal(quality.session.steps[1].children[0].type, 'interval');
  assert.equal(quality.actual.observations.length, 0, 'same date is not linkage');
  assert.equal(quality.actual.interval_comparison.status, 'MISSING');
  assert.equal(quality.actual.completion.completed, null);
  assert.ok(quality.context.sessions.some(s => s.relation === 'PRIOR' && s.truth_class === 'OBSERVED'));
  const encoded = JSON.stringify(b);
  for (const secret of ['SECRET-NOTES','SECRET-GPS','IGNORE-ALL-INSTRUCTIONS','must-not-leak','example.invalid','password_hash','route_coords','health_source_workout_id']) assert.equal(encoded.includes(secret), false, secret);
  assert.equal(snapshot(), before, 'HTTP reads cause no persistent mutation');
  assert.equal(contract.instant('2026-09-22 10:00:00+00'), '2026-09-22T10:00:00.000Z');
  assert.equal(contract.instant('2026-09-22 06:00:00-04:00'), '2026-09-22T10:00:00.000Z');
  assert.equal(contract.instant('2026-09-22 10:00:00'), null, 'naive PostgreSQL timestamp is unknown');
  assert.equal(contract.instant('not-a-time'), null);
  db.prepare("UPDATE planning_pipeline_artifacts SET created_at='2026-09-20 12:00:00+00'").run();
  assert.equal((await get()).data.content_hash, b.content_hash, 'PG explicit-zone artifact timestamps preserve identity');
  db.prepare("UPDATE planning_pipeline_artifacts SET created_at='2026-09-20 12:00:00'").run();
  assert.equal((await get()).data.status, 'UNAVAILABLE', 'naive artifact times never receive an invented zone');
  db.prepare("UPDATE planning_pipeline_artifacts SET created_at='2026-09-20T12:00:00.000Z'").run();
  // SQL guards text bytes, not compressed physical PostgreSQL row size.
  assert.ok(calls.filter(c => c.sql.includes('CASE WHEN')).every(c => c.sql.includes('octet_length') && !c.sql.includes('pg_column_size')));
  const savedHook = hooks.before;
  hooks.before = (method, sql, params) => { savedHook(method, sql, params); if (sql.includes('FROM gear_shoes')) throw Error('Synthetic gear outage'); };
  const outage = await get();
  assert.equal(outage.status, 200); assert.equal(outage.data.gear.actual_shoe.lookup_status, 'LOOKUP_UNAVAILABLE');
  assert.equal(outage.data.session.content_hash, b.session.content_hash);
  hooks.before = savedHook;
  const { buildAttributedCorrection } = require('../src/lib/goalBackwardEvidence');
  const correction = buildAttributedCorrection({ id: 'distance-correction', athleteId: owner, rawEvidenceKind: 'run', rawEvidenceRef: 'actual-recovery',
    revision: 1, correctedValue: { field: 'distance_m', value: 3500 }, canonicalUnit: 'm', reason: 'Private correction reason not exported',
    attributedByUserId: owner, createdAt: '2026-09-23T10:00:00Z' });
  insert('planning_evidence_corrections', correction);
  const corrected = (await get()).data;
  assert.equal(corrected.actual.reconciled_totals.distance_m.value, 3500);
  assert.equal(corrected.actual.observations[0].distance_m.value, 3 * 1609.344);
  assert.equal(corrected.actual.correction_provenance.corrections[0].revision, 1);
  assert.equal(corrected.actual.correction_provenance.corrections[0].corrected_canonical_value_json.value, 3500);
  assert.equal(JSON.stringify(corrected).includes('Private correction reason'), false);
  db.prepare("DELETE FROM planning_evidence_corrections WHERE id='distance-correction'").run();
  // Freshness changes are reported, not silently regenerated state.
  db.prepare('UPDATE users SET planning_input_revision=5 WHERE id=?').run(owner);
  assert.equal((await get()).data.athlete.freshness, 'INPUT_REVISION_CHANGED');
  db.prepare('UPDATE users SET planning_input_revision=4 WHERE id=?').run(owner);
  db.prepare("UPDATE runs SET shoe_id='foreign-shoe' WHERE id='actual-recovery'").run();
  assert.equal((await get()).data.gear.actual_shoe.value, null);
  db.prepare("UPDATE runs SET shoe_id='owned-shoe',duration_seconds=NULL WHERE id='actual-recovery'").run();
  assert.notEqual((await get()).data.content_hash, b.content_hash);
  db.prepare("UPDATE runs SET duration_seconds=1800 WHERE id='actual-recovery'").run();
  for (const change of ['status', 'hash', 'foreign', 'corrupt', 'parent', 'plan', 'foreign-plan', 'tampered-plan']) {
    if (change === 'status') db.prepare("UPDATE plan_generation_candidates SET status='preview' WHERE id=?").run(f.candidate.id);
    if (change === 'hash') db.prepare("UPDATE planning_pipeline_artifacts SET content_hash=? WHERE artifact_kind='athlete_state'").run('0'.repeat(64));
    if (change === 'foreign') db.prepare("UPDATE planning_pipeline_artifacts SET user_id=? WHERE artifact_kind='athlete_state'").run(foreign);
    if (change === 'corrupt') db.prepare("UPDATE planning_pipeline_artifacts SET payload_json='{' WHERE artifact_kind='athlete_state'").run();
    if (change === 'parent') db.prepare("UPDATE planning_pipeline_artifacts SET parent_artifact_id='artifact-c4-canonical_session_set' WHERE artifact_kind='athlete_state'").run();
    if (change === 'plan') db.prepare('UPDATE user_plans SET plan_version=10 WHERE id=?').run('assignment');
    if (change === 'foreign-plan') db.prepare("UPDATE training_plans SET user_id=? WHERE id='plan-c4'").run(foreign);
    if (change === 'tampered-plan') {
      const altered = clone(f.plan); altered.weeks[0].days[0].sessions[0].steps[0].target.duration_s += 60;
      db.prepare("UPDATE training_plans SET plan_data=? WHERE id='plan-c4'").run(JSON.stringify(altered));
    }
    assert.equal((await get()).data.status, 'UNAVAILABLE', change);
    db.prepare("UPDATE plan_generation_candidates SET status='applied' WHERE id=?").run(f.candidate.id);
    const original = f.artifacts.find(a => a.artifact_kind === 'athlete_state');
    db.prepare("UPDATE planning_pipeline_artifacts SET user_id=?,content_hash=?,payload_json=?,parent_artifact_id=? WHERE artifact_kind='athlete_state'")
      .run(owner, original.content_hash, JSON.stringify(original.payload_json), original.parent_artifact_id);
    db.prepare('UPDATE user_plans SET plan_version=9 WHERE id=?').run('assignment');
    db.prepare("UPDATE training_plans SET user_id=?,plan_data=? WHERE id='plan-c4'").run(owner, f.active.plan_data);
  }
  db.prepare("UPDATE user_plans SET effective_from='2026-09-24' WHERE id='assignment'").run();
  assert.equal((await get()).data.reason_codes[0], 'FUTURE_ASSIGNMENT_CONTEXT_UNAVAILABLE');
  db.prepare("UPDATE user_plans SET effective_from='2026-09-20' WHERE id='assignment'").run();
  // Actual persisted accepted chains for both the superseded predecessor and
  // future active successor. No test relabels the predecessor ACTIVE to pass.
  db.exec('SAVEPOINT effective_assignment_cases');
  const successor = makeChain('-successor');
  insert('training_plans', { id: successor.active.plan_id, user_id: owner, name: 'Synthetic successor', plan_data: successor.active.plan_data });
  db.prepare("UPDATE user_plans SET status='superseded',lineage_id='lineage-1' WHERE id='assignment'").run();
  insert('user_plans', { id: successor.active.user_plan_id, user_id: owner, plan_id: successor.active.plan_id,
    status: 'active', plan_version: 10, lineage_id: 'lineage-1', supersedes_user_plan_id: 'assignment',
    effective_from: '2026-09-24', started_at: '2026-09-24' });
  insert('plan_generation_candidates', { ...successor.candidate, input_hash: 'synthetic-successor', invariant_version: 'synthetic',
    planning_snapshot_json: '{}', candidate_plan_json: '{}', generation_trace_json: '{}', expires_at: '2026-10-01' });
  for (const artifact of successor.artifacts) insert('planning_pipeline_artifacts', artifact);
  const readUnchanged = async (...args) => { const beforeRead = snapshot(); const result = await get(...args);
    assert.equal(snapshot(), beforeRead, 'effective assignment reads never mutate'); return result; };
  const predecessorRead = await readUnchanged();
  assert.equal(predecessorRead.status, 200, JSON.stringify(predecessorRead.data));
  assert.equal(predecessorRead.data.effective_assignment_read.selected_assignment_status, 'SUPERSEDED');
  assert.equal(predecessorRead.data.effective_assignment_read.depth, 2);
  assert.equal(predecessorRead.data.accepted_identity.plan_id, f.set.plan_id);
  assert.equal((await readUnchanged()).data.content_hash, predecessorRead.data.content_hash);
  assert.equal((await readUnchanged(successor.set.sessions[1].session_id)).status, 404, 'future sessions cannot leak');
  const predicates = require('../src/lib/acceptedSurfaceDiagnostic');
  const predecessorRow = { ...f.active, status: 'superseded', lineage_id: 'lineage-1',
    effective_from: '2026-09-20', started_at: '2026-09-20', supersedes_user_plan_id: null };
  const rootRow = { ...successor.active, lineage_id: 'lineage-1', effective_from: '2026-09-24',
    started_at: '2026-09-24', supersedes_user_plan_id: 'assignment' };
  const readBinding = { version: predicates.EFFECTIVE_READ_VERSION, local_date: '2026-09-23', timezone: 'UTC',
    path: [rootRow, predecessorRow].map(predicates.assignmentReadIdentity) };
  const manifest = f.artifacts.find(a => a.artifact_kind === 'surface_manifest').payload_json;
  const canonical = f.artifacts.find(a => a.artifact_kind === 'canonical_session_set').payload_json;
  const strict = predicates.surfaceManifestAppliedPlanDiagnostic(manifest, f.candidate, predecessorRow, canonical);
  assert.equal(strict.first_failed_predicate, 'ASSIGNMENT_STATUS_ACTIVE', 'shared default stays strictly ACTIVE');
  const optIn = binding => predicates.surfaceManifestAppliedPlanDiagnostic(manifest, f.candidate, predecessorRow, canonical, undefined,
    { effectiveAssignmentRead: binding });
  assert.equal(optIn(readBinding).status_code, 'ACCEPTED');
  assert.equal(optIn(readBinding).statuses.assignment, 'SUPERSEDED');
  for (const invalid of [{ ...readBinding, path: [predecessorRow] }, { ...readBinding, local_date: '2026-09-24' },
    { ...readBinding, path: [{ ...rootRow, user_id: foreign }, predecessorRow] },
    { ...readBinding, path: [rootRow, { ...predecessorRow, plan_id: 'unrelated' }] },
    { ...readBinding, path: [rootRow, { ...predecessorRow, status: 'active' }] }]) {
    assert.equal(optIn(invalid).status_code, 'BLOCKED', 'opt-in cannot bypass proof');
  }
  // The same real instant selects differently on opposite sides of midnight.
  for (const [timezone, instant, expected] of [
    ['America/New_York', '2026-09-24T03:59:59Z', 'plan-c4'],
    ['America/New_York', '2026-09-24T04:00:00Z', 'plan-c4-successor'],
    ['America/New_York', '2026-09-25T04:00:00Z', 'plan-c4-successor'],
    ['Asia/Tokyo', '2026-09-23T14:59:59Z', 'plan-c4'],
    ['Asia/Tokyo', '2026-09-23T15:00:00Z', 'plan-c4-successor'],
  ]) {
    clockNow = instant; db.prepare('UPDATE users SET timezone=? WHERE id=?').run(timezone, owner);
    const expectedSession = expected === 'plan-c4' ? f.set.sessions[1].session_id : successor.set.sessions[1].session_id;
    const boundary = await readUnchanged(expectedSession);
    assert.equal(boundary.status, 200, JSON.stringify(boundary.data));
    assert.equal(boundary.data.accepted_identity.plan_id, expected);
    assert.equal((await readUnchanged(expected === 'plan-c4' ? successor.set.sessions[1].session_id : f.set.sessions[1].session_id)).status, 404);
  }
  clockNow = NOW; db.prepare("UPDATE users SET timezone='UTC' WHERE id=?").run(owner);
  const invalidCases = [
    ['missing predecessor', "UPDATE user_plans SET supersedes_user_plan_id='missing' WHERE id='assignment-successor'", [], 'ASSIGNMENT_LINEAGE_UNAVAILABLE'],
    ['foreign predecessor', "UPDATE user_plans SET user_id=? WHERE id='assignment'", [foreign], 'ASSIGNMENT_LINEAGE_UNAVAILABLE'],
    ['foreign training owner', "UPDATE training_plans SET user_id=? WHERE id='plan-c4'", [foreign], 'ASSIGNMENT_LINEAGE_UNAVAILABLE'],
    ['foreign root training owner', "UPDATE training_plans SET user_id=? WHERE id='plan-c4-successor'", [foreign], 'ASSIGNMENT_LINEAGE_UNAVAILABLE'],
    ['cleared predecessor', "UPDATE user_plans SET status='cleared' WHERE id='assignment'", [], 'ASSIGNMENT_LINEAGE_INVALID'],
    ['unrelated predecessor', "UPDATE user_plans SET lineage_id='unrelated' WHERE id='assignment'", [], 'ASSIGNMENT_LINEAGE_INVALID'],
    ['missing lineage', "UPDATE user_plans SET lineage_id=NULL WHERE id='assignment'", [], 'ASSIGNMENT_LINEAGE_INVALID'],
    ['missing both dates', "UPDATE user_plans SET effective_from=NULL,started_at=NULL WHERE id='assignment'", [], 'ASSIGNMENT_DATE_INVALID'],
    ['nonincreasing version', "UPDATE user_plans SET plan_version=9 WHERE id='assignment-successor'", [], 'ASSIGNMENT_LINEAGE_INVALID'],
    ['invalid date', "UPDATE user_plans SET effective_from='2026-02-30' WHERE id='assignment'", [], 'ASSIGNMENT_DATE_INVALID'],
    ['malformed explicit date', "UPDATE user_plans SET effective_from='tomorrow' WHERE id='assignment-successor'", [], 'ASSIGNMENT_DATE_INVALID'],
    ['cycle', "UPDATE user_plans SET supersedes_user_plan_id='assignment-successor' WHERE id='assignment'", [], 'ASSIGNMENT_LINEAGE_INVALID'],
    ['tampered accepted hash', "UPDATE planning_pipeline_artifacts SET content_hash=? WHERE id=?", ['0'.repeat(64), f.artifacts[1].id], 'CONTEXT_READ_UNAVAILABLE'],
    ['stale accepted revision', "UPDATE user_plans SET plan_version=8 WHERE id='assignment'", [], 'ACCEPTED_CHAIN_STALE'],
    ['candidate no longer accepted', "UPDATE plan_generation_candidates SET status='superseded' WHERE id=?", [f.candidate.id], 'ACCEPTED_CHAIN_UNAVAILABLE'],
    ['ambiguous root', "UPDATE user_plans SET status='active' WHERE id='assignment'", [], 'ASSIGNMENT_AMBIGUOUS'],
  ];
  for (const [name, sql, params, reason] of invalidCases) {
    db.exec('SAVEPOINT invalid_case'); db.prepare(sql).run(...params);
    assert.equal((await readUnchanged()).data.reason_codes[0], reason, name);
    db.exec('ROLLBACK TO invalid_case; RELEASE invalid_case');
  }
  db.exec('SAVEPOINT legacy_date_fallback');
  db.prepare("UPDATE user_plans SET effective_from=NULL,started_at='2026-09-20 12:00:00' WHERE id='assignment'").run();
  assert.equal((await readUnchanged()).status, 200, 'absent effective date uses persisted started-at date, not inferred timezone');
  db.exec('ROLLBACK TO legacy_date_fallback; RELEASE legacy_date_fallback');
  // Multi-hop valid path and reversed dates; irrelevant historical rows cannot
  // replace a missing linked predecessor. Max depth includes the active root.
  db.exec('SAVEPOINT deep_lineage');
  for (let i = 1; i <= 16; i++) {
    insert('training_plans', { id: `future-plan-${i}`, user_id: owner, name: 'Synthetic', plan_data: '{}' });
    insert('user_plans', { id: `future-assignment-${i}`, user_id: owner, plan_id: `future-plan-${i}`,
      status: 'superseded', plan_version: 10 + i, lineage_id: 'lineage-1', effective_from: `2026-10-${String(i).padStart(2, '0')}`,
      supersedes_user_plan_id: i === 1 ? 'assignment-successor' : `future-assignment-${i - 1}` });
  }
  db.prepare("UPDATE user_plans SET status='superseded' WHERE id='assignment-successor'").run();
  db.prepare("UPDATE user_plans SET status='active' WHERE id='future-assignment-1'").run();
  assert.equal((await readUnchanged()).data.effective_assignment_read.depth, 3);
  db.prepare("UPDATE user_plans SET effective_from='2026-09-23' WHERE id='future-assignment-1'").run();
  assert.equal((await readUnchanged()).data.status, 'UNAVAILABLE', 'effective root never falls through to old accepted data');
  db.prepare("UPDATE user_plans SET effective_from='2026-09-25' WHERE id='assignment-successor'").run();
  db.prepare("UPDATE user_plans SET effective_from='2026-09-24' WHERE id='future-assignment-1'").run();
  assert.equal((await readUnchanged()).data.reason_codes[0], 'ASSIGNMENT_LINEAGE_INVALID', 'reversed date order');
  db.prepare("UPDATE user_plans SET effective_from='2026-09-24' WHERE id='assignment-successor'").run();
  db.prepare("UPDATE user_plans SET effective_from='2026-10-01' WHERE id='future-assignment-1'").run();
  db.prepare("UPDATE user_plans SET supersedes_user_plan_id='future-assignment-1' WHERE id='future-assignment-1'").run();
  assert.equal((await readUnchanged()).data.reason_codes[0], 'ASSIGNMENT_LINEAGE_INVALID', 'future cycle terminates before depth limit');
  db.prepare("UPDATE user_plans SET supersedes_user_plan_id='assignment-successor' WHERE id='future-assignment-1'").run();
  db.prepare("UPDATE user_plans SET status='superseded' WHERE id='future-assignment-1'").run();
  db.prepare("UPDATE user_plans SET status='active' WHERE id='future-assignment-14'").run();
  assert.equal((await readUnchanged()).data.effective_assignment_read.depth, 16, 'exact maximum depth remains readable');
  db.prepare("UPDATE user_plans SET status='superseded' WHERE id='future-assignment-14'").run();
  db.prepare("UPDATE user_plans SET status='active' WHERE id='future-assignment-16'").run();
  assert.equal((await readUnchanged()).data.reason_codes[0], 'ASSIGNMENT_LINEAGE_BOUNDS');
  db.exec('ROLLBACK TO deep_lineage; RELEASE deep_lineage');
  for (const sql of ["UPDATE user_plans SET effective_from='2026-09-23' WHERE id='assignment-successor'",
    "UPDATE user_plans SET effective_from='2026-09-25' WHERE id='assignment-successor'",
    "UPDATE user_plans SET status='cleared' WHERE id='assignment-successor'",
    "UPDATE user_plans SET lineage_id='changed' WHERE id='assignment-successor'"]) {
    db.exec('SAVEPOINT concurrent_lineage'); let changed = false;
    hooks.after = (_method, readSql, result) => {
      if (!changed && readSql.includes('FROM workout_sessions')) { changed = true; db.prepare(sql).run(); }
      return result;
    };
    assert.equal((await get()).data.status, 'UNAVAILABLE', 'concurrent lifecycle mutation invalidates read');
    hooks.after = null; db.exec('ROLLBACK TO concurrent_lineage; RELEASE concurrent_lineage');
  }
  db.exec('ROLLBACK TO effective_assignment_cases; RELEASE effective_assignment_cases');
  const oldState = { ...f.artifacts.find(a => a.artifact_kind === 'athlete_state'), id: 'unused-state-history', revision: 2 };
  insert('planning_pipeline_artifacts', oldState);
  assert.equal((await get()).status, 200, 'unreferenced history cannot replace the accepted parent chain');
  db.prepare("DELETE FROM planning_pipeline_artifacts WHERE id='unused-state-history'").run();
  db.prepare("UPDATE training_plans SET plan_data=? WHERE id='plan-c4'").run(' '.repeat(contract.LIMITS.payloadBytes + 1));
  assert.equal((await get()).data.reason_codes[0], 'CONTEXT_BOUNDS');
  db.prepare("UPDATE training_plans SET plan_data=? WHERE id='plan-c4'").run(f.active.plan_data);
  const insertOverflow = db.prepare("INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds,created_at) VALUES (?,?,'2026-09-22','easy',1,600,'2026-09-22T12:00:00Z')");
  for (let i = 0; i < 513; i++) insertOverflow.run(`overflow-${i}`, owner);
  assert.equal((await get()).data.reason_codes[0], 'CONTEXT_BOUNDS');
  const deleteOverflow = db.prepare('DELETE FROM runs WHERE id=? AND user_id=?');
  for (let i = 0; i < 513; i++) deleteOverflow.run(`overflow-${i}`, owner);
  const pureInput = { ownerId: owner, chain, candidate: f.candidate, profile: { planning_input_revision: 4 },
    runs: db.prepare('SELECT * FROM runs WHERE user_id=? ORDER BY id').all(owner), corrections: [], lifts: [],
    shoes: db.prepare('SELECT * FROM gear_shoes WHERE user_id=?').all(owner), asOf: NOW };
  const pure = contract.compose(pureInput);
  const calendarChain = clone(chain);
  const planning = calendarChain.byKind.planning_decision.payload_json;
  planning.calendar_windows = [
    { start_date: '2026-09-14', end_date: '2026-09-20', phase: 'FOUNDATION', weekly_objectives: planning.weekly_objectives },
    { start_date: '2026-09-21', end_date: '2026-09-27', phase: 'TAPER_RACE_WEEK', phase_reason_codes: ['TAPER_VOLUME_REDUCTION'],
      weekly_objectives: { ...planning.weekly_objectives, objectives: [{ objective_id: 'later-objective' }],
        progression: [{ family: 'threshold', action: 'HOLD', reason_codes: ['TAPER_VOLUME_REDUCTION'] }] } },
  ];
  const calendarRead = contract.compose({ ...pureInput, chain: calendarChain });
  assert.equal(calendarRead.goal.phase, 'TAPER_RACE_WEEK');
  assert.equal(calendarRead.week.weekly_objectives.objectives[0].objective_id, 'later-objective');
  assert.deepEqual(calendarRead.decision.progression[0].reason_codes, ['TAPER_VOLUME_REDUCTION']);
  assert.equal(calendarRead.week.calendar_window.start_date, '2026-09-21');
  planning.calendar_windows.reverse();
  assert.equal(contract.compose({ ...pureInput, chain: calendarChain }).content_hash, calendarRead.content_hash);
  for (const windows of [[], null, [{ start_date: 'bad', end_date: '2026-09-27' }],
    [planning.calendar_windows[1]], [planning.calendar_windows[0], planning.calendar_windows[0]]]) {
    planning.calendar_windows = windows;
    const unavailable = contract.compose({ ...pureInput, chain: calendarChain });
    assert.equal(unavailable.week.status, 'MISSING');
    assert.equal(unavailable.week.weekly_objectives, null);
    assert.equal(unavailable.goal.phase, null);
    assert.equal(unavailable.decision.status, 'MISSING', 'no first-week progression fallback');
  }
  assert.equal(contract.compose({ ...pureInput, runs: [...pureInput.runs].reverse(), asOf: '2026-09-23T12:00:01Z' }).content_hash, pure.content_hash);
  assert.throws(() => contract.compose({ ...pureInput, runs: Array(513).fill(pureInput.runs[0]) }), /CONTEXT_BOUNDS/);
  assert.throws(() => contract.compose({ ...pureInput, shoes: [{ id: 'foreign', user_id: foreign }] }), /OWNER/);
  const named = clone(chain);
  named.session.title = 'Race intervals invented title';
  assert.equal(contract.compose({ ...pureInput, chain: named }).session.workout_family, 'recovery_run');
  assert.equal(contract.compose({ ...pureInput, chain: named }).content_hash, pure.content_hash);
  const legacyIntent = clone(chain); delete legacyIntent.session.workout_semantics;
  assert.equal(contract.compose({ ...pureInput, chain: legacyIntent }).session.dominant_purpose.status, 'MISSING');
  const forgedIntent = clone(chain); forgedIntent.session.workout_semantics.source.prescribed_steps_hash = 'forged';
  assert.equal(contract.compose({ ...pureInput, chain: forgedIntent }).session.dominant_purpose.status, 'MISSING');
  const repeatChain = clone(chain);
  const work = repeatChain.session.steps.find(s => s.type === 'run');
  repeatChain.session.steps = [{ step_id: 'repeat', type: 'repeat', order: 1, repeat_count: 4,
    target: {}, provenance: [], children: [work] }];
  const projected = contract.compose({ ...pureInput, chain: repeatChain });
  assert.equal(projected.session.steps[0].repeat_count, 4);
  assert.deepEqual(projected.session.steps[0].children[0].target.rpe_range, { minimum: work.target.rpe_range.minimum,
    maximum: work.target.rpe_range.maximum });
  const unknown = clone(pureInput);
  unknown.runs.find(r => r.id === 'actual-recovery').duration_seconds = null;
  unknown.runs.find(r => r.id === 'actual-recovery').distance_miles = null;
  const noDose = contract.compose(unknown);
  assert.notEqual(noDose.actual.completion.outcome, 'ON_TARGET');
  const malformed = clone(pureInput);
  malformed.runs.find(r => r.id === 'actual-recovery').avg_heart_rate = -1;
  assert.equal(contract.compose(malformed).actual.observations[0].average_heart_rate.state, 'INVALID');
  const manyContext = clone(chain);
  manyContext.set.sessions.push(...Array.from({ length: 70 }, (_, i) => ({ ...manyContext.session, session_id: `context-${i}` })));
  const boundedContext = contract.compose({ ...pureInput, chain: manyContext });
  assert.equal(boundedContext.context.truncated, true);
  assert.equal(boundedContext.context.sessions.length, contract.LIMITS.context);
  const qualityChain = contract.accepted({ ownerId: owner, ...f, candidate: f.candidate, sessionId: f.set.sessions[2].session_id });
  const boundaryRuns = [{ id: 'within-72h', date: '2026-09-20', health_start_at: '2026-09-20T08:00:00Z', duration_seconds: 600 },
    { id: 'outside-72h', date: '2026-09-20', health_start_at: '2026-09-20T07:59:00Z', duration_seconds: 610 }]
    .map(r => ({ ...r, user_id: owner, type: 'easy', distance_miles: 1, created_at: r.health_start_at }));
  const boundaries = contract.compose({ ...pureInput, chain: qualityChain, runs: boundaryRuns }).context;
  assert.ok(boundaries.sessions.some(s => s.at === '2026-09-20T08:00:00.000Z'));
  assert.equal(boundaries.sessions.some(s => s.at === '2026-09-20T07:59:00.000Z'), false);
  // Existing recorder receipts allow exact accepted-session attribution when
  // an actual run happened on another date; manual offsets remain dose-only.
  hooks.before = null;
  const qs = f.set.sessions[2];
  insertRun('measured-quality', '2026-09-22', null, { duration_seconds: 3120, distance_miles: 4, shoe_id: 'owned-shoe' });
  const measured = require('../src/lib/activityMeasuredReceipt');
  await assert.rejects(measured.load({ userId: owner, observationInstant: NOW,
    sessionScope: { plan_id: f.set.plan_id, session_id: qs.session_id }, tx: { all: async (sql, params) => {
      assert.ok(params.includes(owner));
      if (sql.includes('GROUP BY')) return [{ activity_kind: 'run', activity_id: 'synthetic-overflow' }];
      assert.match(sql, /LIMIT 65/); assert.match(sql, /octet_length/);
      return Array(65).fill({});
    } } }), error => error.code === 'SOURCE_OVERFLOW');
  const binding = { version: measured.VERSION, activity_kind: 'run', activity_id: 'measured-quality', plan_id: f.set.plan_id,
    plan_revision: f.set.plan_revision, session_id: qs.session_id, session_revision: qs.session_revision, session_hash: qs.content_hash,
    expected_revision: 0, completeness: 'COMPLETE', work_intervals: [{ start_offset_s: 600, end_offset_s: 2400 }] };
  await measured.record({ tx: fixture.tx, userId: owner, input: binding, accepted: f.set, now: NOW });
  hooks.before = savedHook;
  const measuredRead = (await get(qs.session_id)).data;
  assert.equal(measuredRead.actual.measured_receipt.status, 'VALIDATED');
  assert.equal(measuredRead.actual.measured_receipt.observed_at, null, 'recorder noon never becomes an observed start');
  assert.equal(measuredRead.actual.completion.completed, null, 'offsets are not successful interval intensity');
  assert.equal(measuredRead.gear.actual_shoe.value.id, 'owned-shoe');
  hooks.before = null;
  await measured.record({ tx: fixture.tx, userId: owner, input: { ...binding, expected_revision: 1, completeness: 'PARTIAL' }, accepted: f.set, now: NOW });
  hooks.before = savedHook;
  const partialReceipt = (await get(qs.session_id)).data;
  assert.equal(partialReceipt.actual.measured_receipt.measured_receipt_revision, 2);
  assert.equal(partialReceipt.actual.measured_receipt.quality_state, 'PARTIAL');
  assert.notEqual(partialReceipt.actual.completion.outcome, 'ON_TARGET');
  assert.equal((await get(qs.session_id)).data.content_hash, partialReceipt.content_hash, 'receipt replay stable');
  const savedMeasured = db.prepare('SELECT payload_json,content_hash FROM activity_measured_receipts ORDER BY revision DESC LIMIT 1').get();
  db.prepare("UPDATE activity_measured_receipts SET payload_json='{}' WHERE revision=2").run();
  const corruptReceipt = (await get(qs.session_id)).data;
  assert.equal(corruptReceipt.actual.measured_receipt.status, 'MISSING');
  assert.equal(corruptReceipt.actual.completion.completed, null);
  db.prepare('UPDATE activity_measured_receipts SET payload_json=?,content_hash=? WHERE revision=2').run(savedMeasured.payload_json, savedMeasured.content_hash);
  // A concurrent gear correction cannot hide behind unchanged physiological revision.
  let shoeChanged = false;
  hooks.after = (_method, sql, result) => {
    if (!shoeChanged && sql.includes('FROM gear_shoes')) { shoeChanged = true;
      db.prepare("UPDATE runs SET shoe_id='foreign-shoe' WHERE id='actual-recovery'").run();
      db.prepare("UPDATE gear_shoes SET model='Changed physical pair profile' WHERE id='owned-shoe'").run(); }
    return result;
  };
  assert.equal((await get()).data.reason_codes[0], 'CONTEXT_CHANGED_DURING_READ');
  hooks.after = null;
  db.prepare("UPDATE runs SET shoe_id='owned-shoe' WHERE id='actual-recovery'").run();
  db.prepare("UPDATE gear_shoes SET model='Pair' WHERE id='owned-shoe'").run();
  // A read-time revision change cannot publish a mixed authority bundle.
  let changed = false;
  hooks.after = (_method, sql, result) => {
    if (!changed && sql.includes('FROM workout_sessions')) { changed = true; db.prepare('UPDATE users SET planning_input_revision=6 WHERE id=?').run(owner); }
    return result;
  };
  assert.equal((await get()).data.reason_codes[0], 'CONTEXT_CHANGED_DURING_READ');
  hooks.after = null;
  console.log(JSON.stringify({ test: 'coaching-context', status: 'PASS', authenticated_sqlite: true, writes_during_reads: 0,
    accepted_session: b.session.session_id, content_hash: b.content_hash, query_count: calls.length, limitations: ['No PostgreSQL isolation proof', 'No rich interval comparator or shoe matcher'] }));
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { server?.close(); db.close(); global.Date = RealDate; global.fetch = nativeFetch; });
