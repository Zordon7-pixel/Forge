// Real SQL acquisition, adaptive candidate authority and preview-only lifecycle.
const assert = require('node:assert/strict');
const { createDb } = require('./helpers/adaptiveShadowDb');
const shadow = require('../src/lib/adaptiveCoachingShadow');
const { targetRef } = require('../src/lib/betaPlanRollout');
const fixture = createDb();
const { db, hooks } = fixture;
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fixture.exports };
const RealDate = Date, NOW = '2026-09-14T12:00:00Z';
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return RealDate.parse(NOW); }
};
const realCompute = shadow.compute;
let computations = 0, result, prepared;
shadow.compute = input => { computations++; prepared = input; result = realCompute(input); return result; };
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
  const off = await plans.previewPlanForUser(OWNER, request, options('off'));
  const exposed = await plans.previewPlanForUser(OWNER, request, options('preview'));
  assert.equal(computations, 1, 'authorized preview invokes the real adaptive engine');
  assert.ok(prepared.foundation && result.selected_candidate, 'real acquired fixture selects canonical work internally');
  assert.ok(result.selected_candidate.sessions.length);
  assert.equal(exposed.surfaceManifest.status, 'preview');
  assert.equal(exposed.surfaceManifest.feature_mode, 'preview');
  assert.equal(exposed.surfaceManifest.v24_surface_enabled, true);
  assert.equal(exposed.surfaceManifest.authoritative_engine, 'adaptive-joint-solver-v1');
  assert.deepEqual(exposed.surfaceManifest.sessions, result.selected_candidate.sessions);
  assert.equal(db.prepare('SELECT feature_mode FROM plan_generation_candidates WHERE id=?').get(exposed.id).feature_mode, 'preview');
  const applied = await plans.applyPlanCandidate(OWNER, exposed.id, { choice: 'train_for_target',
    candidate_hash: exposed.candidateHash, planning_date_local: '2026-09-14' });
  assert.equal(applied.code, 'GOAL_BACKWARD_PREVIEW_APPLY_DISABLED');
  for (const mode of ['off', 'shadow', 'preview', 'on']) {
    const denied = await plans.applyPlanCandidate(OWNER, exposed.id, { choice: 'train_for_target',
      candidate_hash: exposed.candidateHash, planning_date_local: '2026-09-14' }, options(mode));
    assert.equal(denied.code, 'GOAL_BACKWARD_PREVIEW_APPLY_DISABLED', 'mode change cannot promote a stored preview');
  }
  const { buildFitWorkoutRepresentation } = await import('../../frontend/src/services/fit/encodeWorkoutFit.js');
  assert.throws(() => buildFitWorkoutRepresentation({ surfaceManifest: exposed.surfaceManifest,
    sessionId: result.selected_candidate.sessions.find(session => session.kind === 'run').session_id, exportRevision: 1 }),
  error => error.code === 'CANONICAL_MANIFEST_NOT_ACCEPTED');
  const { validateSurfaceManifest } = await import('../../frontend/src/lib/dailyExecutionCore.js');
  assert.ok(exposed.surfaceManifest.sessions.some(session=>session.executability==='EXECUTABLE'), 'canonical capability remains intrinsic');
  const closedSurface = validateSurfaceManifest({plan:{plan_data:exposed.plan},manifest:exposed.surfaceManifest});
  assert.equal(closedSurface.status,'blocked');
  assert.equal(closedSurface.sessionsById.size,0);
  const preview = require('../src/lib/adaptiveCoachingPreview').build({ prepared, result });
  assert.equal(preview.candidateHash, `sha256:${result.selected_candidate.candidate_hash}`);
  assert.deepEqual(preview.plan.weekly_objectives, result.decision.weekly_objectives);
  assert.deepEqual(require('../src/lib/adaptiveCoachingPreview').build({ prepared, result }), preview);
  const nonCohort = await plans.previewPlanForUser(OWNER, request, options('preview', []));
  assert.equal(computations, 1);
  assert.deepEqual(nonCohort.plan, off.plan);
  assert.equal(nonCohort.candidateHash, off.candidateHash);
  for (const cohortRefs of [undefined, 'malformed', [OWNER], []]) {
    const denied = await plans.previewPlanForUser(OWNER, request, { goalBackwardDependencies: {
      mode: 'preview', audience: 'cohort', cohortRefs, telemetrySink: () => {},
    } });
    assert.equal(computations, 1);
    assert.deepEqual(denied.plan, off.plan);
    assert.equal(denied.candidateHash, off.candidateHash);
    assert.equal(denied.surfaceManifest, undefined);
  }
  const publicPreview = await plans.previewPlanForUser(OWNER, request, { store: false,
    goalBackwardDependencies: { mode: 'preview', audience: 'all', telemetrySink: () => {} } });
  assert.equal(publicPreview.candidateHash, exposed.candidateHash, 'existing all resolver supports the same canonical authority');
  assert.equal(computations, 2);
  const response = await plans.previewPlanForUser(OWNER, request, options('shadow'));
  assert.equal(computations, 3);
  assert.deepEqual(response.plan, off.plan);
  assert.equal(response.candidateHash, off.candidateHash);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM planning_pipeline_artifacts WHERE plan_generation_candidate_id=?').get(response.id).n >= 5);
  const adapter = require('../src/lib/adaptiveCoachingPreview');
  assert.equal(adapter.build({prepared,result,planMode:'hybrid_build'}).plan.planMode,'hybrid_build');
  assert.ok(!['VALID','VALID_WITH_TRADEOFFS'].includes(exposed.plan.overall_feasibility));
  const counts = () => ['plan_generation_candidates','planning_pipeline_artifacts','user_plans']
    .map(table=>db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
  const beforeDiagnostic = counts();
  const diagnostic = await plans.previewPlanForUser(OWNER,request,{...options('preview'),store:false});
  assert.ok(diagnostic.diagnostics.snapshot && diagnostic.diagnostics.trace);
  assert.equal(diagnostic.diagnostics.active_plan,null);
  assert.deepEqual(counts(),beforeDiagnostic,'read-only diagnostic writes nothing');
  // PostgreSQL returns JSONB objects and timestamp Dates; SQLite returns strings.
  hooks.after = (method,sql,value) => {
    if (!/SELECT \* FROM (plan_generation_candidates|planning_pipeline_artifacts)/.test(sql)) return value;
    const pg = row => row && Object.fromEntries(Object.entries(row).map(([key,v])=>[key,
      key.endsWith('_json') && typeof v==='string' ? JSON.parse(v) :
        ['created_at','expires_at'].includes(key) && v ? new Date(v) : v]));
    return Array.isArray(value) ? value.map(pg) : pg(value);
  };
  const pg = await plans.previewPlanForUser(OWNER,request,options('preview'));
  hooks.after = null;
  assert.equal(pg.candidateHash,exposed.candidateHash);
  const baseline = counts();
  for (const fault of ['stale','authority','compute','candidate','json','timestamp','incomplete','artifact','persist']) {
    const deps = options('preview'); let loads = 0;
    hooks.before = (method,sql) => {
      if (fault === 'persist' && method==='run' && sql.includes('INSERT INTO planning_pipeline_artifacts')) throw new Error('injected write failure');
    };
    hooks.after = (method,sql,value) => {
      if (method==='get' && sql.includes('FROM users') && ++loads===2) {
        if(fault==='stale') return {...value,planning_input_revision:Number(value.planning_input_revision)+1};
        if(fault==='authority') deps.goalBackwardDependencies.cohortRefs=[];
      }
      if(method==='get' && sql.includes('SELECT * FROM plan_generation_candidates') && value) {
        if(fault==='candidate') return {...value,candidate_hash:'sha256:'+ '0'.repeat(64)};
        if(fault==='json') return {...value,candidate_plan_json:'{}'};
        if(fault==='timestamp') return {...value,expires_at:new Date('2027-01-01')};
      }
      if(method==='all' && sql.includes('SELECT * FROM planning_pipeline_artifacts')) {
        if(fault==='incomplete') return value.slice(1);
        if(fault==='artifact') return value.map((r,i)=>i===0?{...r,payload_json:'{}'}:r);
      }
      return value;
    };
    if(fault==='compute') shadow.compute=()=>{throw new Error('injected computation failure');};
    await assert.rejects(plans.previewPlanForUser(OWNER,request,deps),error=>
      error.code===(['stale','authority'].includes(fault)?'CANDIDATE_STALE':'GOAL_BACKWARD_GENERATION_FAILED'),fault);
    shadow.compute = input => { computations++; prepared=input; result=realCompute(input); return result; };
    hooks.before=null; hooks.after=null;
    assert.deepEqual(counts(),baseline,`${fault}: transaction rolls back all candidate/artifact writes`);
  }
  const foreign = await plans.applyPlanCandidate('22222222-2222-4222-8222-222222222222',exposed.id,{...exposed.applyBindings,candidate_hash:exposed.candidateHash,choice:'train_for_target'});
  assert.equal(foreign.code,'CANDIDATE_NOT_FOUND');
  const bypass = await plans.applyPlanCandidate(OWNER,exposed.id,{...exposed.applyBindings,
    candidate_hash:exposed.candidateHash,feature_mode:'on',apply_disabled:false,v24_surface_enabled:true,choice:'train_for_target'});
  assert.equal(bypass.code,'GOAL_BACKWARD_PREVIEW_APPLY_DISABLED');
  const rejection = await plans.rejectPlanCandidate(OWNER,exposed.id,{...exposed.applyBindings,candidate_hash:exposed.candidateHash});
  assert.equal(rejection.status,200);
  assert.equal((await plans.rejectPlanCandidate(OWNER,exposed.id,{...exposed.applyBindings,candidate_hash:exposed.candidateHash})).replay,true);
  await assert.rejects(plans.previewPlanForUser(OWNER,request,options('preview')),e=>e.code==='IDENTICAL_REJECTED_CANDIDATE_SUPPRESSED');
  const computationsBeforeMissing = computations;
  hooks.before = (method, sql) => {
    if (method === 'all' && sql.includes('FROM daily_checkins')) throw new Error('synthetic missing evidence');
  };
  await assert.rejects(plans.previewPlanForUser(OWNER, request, options('preview')),
    e => e.code === 'GOAL_BACKWARD_GENERATION_FAILED');
  hooks.before = null;
  assert.equal(computations, computationsBeforeMissing, 'missing foundation never invokes compute');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM plan_generation_candidates WHERE feature_mode='preview'").get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM planning_pipeline_artifacts WHERE artifact_kind='surface_manifest'").get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_plans').get().n, 0);
  assert.ok(telemetry.some(row => JSON.stringify(row).includes('BLOCKED')));
  console.log('ok - real adaptive preview authority, seven artifacts, apply denial, missing evidence, cohort isolation, off/shadow parity');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  shadow.compute = realCompute; global.Date = RealDate; db.close();
});
