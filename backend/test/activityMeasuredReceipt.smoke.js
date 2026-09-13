// Actual SQLite recording -> accepted-source auth -> shared snapshot -> route.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createDb } = require('./helpers/adaptiveShadowDb');
const fixture = createDb(), { db, tx, hooks } = fixture;
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fixture.exports };
const RealDate = Date, DATE = '2026-09-14', NOW = `${DATE}T12:00:00Z`;
global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return RealDate.parse(NOW); } };
const shadow = require('../src/lib/adaptiveCoachingShadow');
const realPrepare = shadow.prepare, realCompute = shadow.compute;
let prepared, result;
shadow.prepare = a => { prepared = realPrepare(a); return prepared; };
shadow.compute = p => { result = realCompute(p); return result; };
const plans = require('../src/routes/plans')._test;
const receipts = require('../src/lib/activityMeasuredReceipt');
const { addDays, canonicalHash } = require('../src/lib/racePlanPolicy');
const { materializeCanonicalSessionSet } = require('../src/lib/canonicalWorkout');
const { buildAdaptiveWorkoutMaterial } = require('../src/lib/adaptiveCoachingWorkouts');
const { buildStrengthExercises } = require('../src/lib/strengthPrescription');
const options = mode => ({ goalBackwardDependencies: { mode, audience: 'all', telemetrySink: () => {} } });
const request = (run,lift) => ({ planning_date_local: DATE, planning_timezone: 'UTC', timezone_offset_minutes: 0,
  target: { runDaysPerWeek: run,liftDaysPerWeek: lift,liftingEnabled: true, maxSessionMinutes: 180,
    trainingDays: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],liftEligibleWeekdays: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'] } });
function acceptedMaterial(owner) {
  const decision = { decision_id: `accepted-${owner}`, decision_hash: canonicalHash(owner), phase: 'DEVELOPMENT', active_goals: [] };
  const definitions = [ ['threshold_run', '2026-09-06',2400,1200], ['long_aerobic','2026-09-05',4200,null],
    ['strength_full_body','2026-09-07',null,null] ];
  const materials = definitions.map(([family,date,seconds,work], i) => {
    const exercises = i === 2 ? ['Upper body','Lower body'].flatMap(focus => buildStrengthExercises({ focus,
      equipment: ['dumbbells','bench'], mode: 'hybrid_build' }).slice(0,2)).map(e => ({ ...e, sets: 6 })) : undefined;
    return buildAdaptiveWorkoutMaterial({ selection_id: `accepted-${owner}-${i}`,workout_family: family,objective_ids:['prior-objective'],
      duration_s:seconds,distance_m:seconds ? seconds*2.3 : null,quality_work_s:work,exercises,
      reason_codes:['WEEKLY_OBJECTIVE_REQUIRED'],dose_basis:{ policy_id:'adaptive-observed-dose-v1',authority:'OBSERVED_COMPLETED_WEEK_STRENGTH',source_evidence_ids:['prior-history'] } }, decision, '2026-09-07T00:00:00Z');
  });
  const set = materializeCanonicalSessionSet({ decision, candidate: { candidate_id:`prior-${owner}`,candidate_material: materials,
    sessions: definitions.map(([family,date],i) => ({ session_id:`accepted-${owner}-${i}`,candidate_material_id:materials[i].material_id,
      workout_family:family,role:i===2?'SUPPORTING':'PRIMARY_KEY',scheduled_local_date:date,scheduled_start_at:`${date}T06:00:00Z` })) },
    planning_instant:'2026-09-07T00:00:00Z',timezone:'UTC' });
  return { canonical_session_set:set,candidate_hash:set.candidate_hash,sessions:set.sessions };
}
function body(owner, set, index, physicalId) {
  const s = set.sessions[index];
  return { version:receipts.VERSION,activity_kind:s.kind,activity_id:physicalId,plan_id:set.plan_id,plan_revision:set.plan_revision,
    session_id:s.session_id,session_revision:s.session_revision,session_hash:s.content_hash,expected_revision:0,
    completeness:'COMPLETE',work_intervals:index===0?[{start_offset_s:600,end_offset_s:1740}]:index===1?[{start_offset_s:300,end_offset_s:3700}]:[] };
}
async function setup(owner, age, run, lift) {
  db.prepare(`INSERT INTO users(id,name,email,password_hash,timezone,training_age_class,planning_input_revision) VALUES (?,?,?,'','UTC',?,1)`)
    .run(owner,'Synthetic',`${owner}@example.invalid`,age);
  db.prepare('INSERT INTO daily_checkins(id,user_id,checkin_date,feeling,time_available,created_at) VALUES (?,?,?,?,?,?)')
    .run(`ready-${owner}`,owner,DATE,4,180,NOW);
  for (let i=0;i<28;i++) db.prepare(`INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds,created_at) VALUES (?,?,?,'easy',6,3600,?)`)
    .run(`run-${owner}-${i}`,owner,addDays(DATE,-1-i),`${addDays(DATE,-1-i)}T12:00:00Z`);
  const req = request(run,lift);
  if (age === 'DEVELOPING') {
    db.prepare(`INSERT INTO race_events(id,user_id,race_name,race_date,event_local_date,event_timezone,distance_miles,goal_time_seconds,event_kind)
      VALUES (?,?,'Synthetic road goal','2026-11-23','2026-11-23','UTC',6.2,3600,'run_race')`).run(`race-${owner}`,owner);
    req.race_ids=[`race-${owner}`];
  }
  const off = await plans.previewPlanForUser(owner,req,options('off'));
  const material = acceptedMaterial(owner);
  const accepted = require('./helpers/adaptiveAcceptedFixture').acceptedFixture(db,owner,off.id,material);
  const set = material.canonical_session_set;
  // Fixed measured numbers are independently recorded, not copied from targets.
  for (const [i,seconds,miles] of [[0,2300,3.3],[1,4000,5.7]]) {
    const s = set.sessions[i];
    db.prepare(`UPDATE runs SET date=?,duration_seconds=?,distance_miles=?,created_at=?,plan_session_id=?,planned_session_json=? WHERE id=? AND user_id=?`)
      .run(i===0?'2026-09-12':'2026-09-10',seconds,miles,i===0?'2026-09-12T12:00:00Z':'2026-09-10T12:00:00Z',s.session_id,
        JSON.stringify({matchSource:'explicit_owned_session',sessionId:s.session_id,planId:set.plan_id,date:s.scheduled_local_date,kind:'run',content_hash:s.content_hash}),`run-${owner}-${i}`,owner);
  }
  db.prepare(`INSERT INTO workout_sessions(id,user_id,started_at,ended_at,total_seconds,created_at) VALUES (?,?,'2026-09-11T10:00:00Z','2026-09-11T11:30:00Z',4500,'2026-09-11T11:30:00Z')`)
    .run(`physical-lift-${owner}`,owner);
  // Existing per-set recorder storage, separate from the canonical exercise graph.
  for (const exercise of ['Bench press','Row','Squat','Deadlift']) for (let n=1;n<=6;n++) db.prepare(`INSERT INTO workout_sets(id,user_id,session_id,exercise_name,set_number,reps,weight_lbs,logged_at) VALUES (?,?,?,?,?,8,100,'2026-09-11T10:30:00Z')`)
    .run(`${owner}-${exercise}-${n}`,owner,`physical-lift-${owner}`,exercise,n);
  const bodies = [body(owner,set,0,`run-${owner}-0`),body(owner,set,1,`run-${owner}-1`),body(owner,set,2,`physical-lift-${owner}`)];
  return { owner,accepted,set,bodies,req };
}
async function main() {
  // Exercise the actual additive SQLite migration twice, without PG functions.
  const migration = require('../src/db/migrate').ensureActivityMeasuredReceipts;
  const sqlite = new (require('node:sqlite').DatabaseSync)(':memory:');
  sqlite.exec('CREATE TABLE users(id TEXT PRIMARY KEY)');
  await migration(sql=>sqlite.exec(sql),'sqlite'); await migration(sql=>sqlite.exec(sql),'sqlite');
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM activity_measured_receipts').get().n,0);
  assert.throws(()=>sqlite.prepare(`INSERT INTO activity_measured_receipts(id,user_id,activity_kind,activity_id,plan_id,session_id,revision,payload_json,content_hash)
    VALUES ('invalid','owner','swim','physical','plan','canonical',1,'{}','hash')`).run());
  sqlite.close();
  const pgStatements=[];await migration(sql=>pgStatements.push(sql),'postgres');
  assert.ok(pgStatements[0].includes('pg_column_size(payload_json)'));
  const pgSchema=fs.readFileSync(require.resolve('../src/db/schema.pg.sql'),'utf8');
  assert.ok(pgSchema.includes(pgStatements[0]));
  const a = await setup('22222222-2222-4222-8222-000000000001','DEVELOPING',3,2);
  const b = await setup('22222222-2222-4222-8222-000000000002','ESTABLISHED',6,4);
  for (const f of [a,b]) {
    for (const input of f.bodies) await plans.recordActivityMeasurement(f.owner,input);
    const assignmentsBefore = db.prepare('SELECT * FROM user_plans WHERE user_id=?').all(f.owner);
    const off = await plans.previewPlanForUser(f.owner,f.req,options('off'));
    await plans.previewPlanForUser(f.owner,f.req,options('shadow')).then(r => {
      assert.deepEqual(r.plan,off.plan); assert.equal(r.candidateHash,off.candidateHash);
    });
    assert.deepEqual(db.prepare('SELECT * FROM user_plans WHERE user_id=?').all(f.owner),assignmentsBefore);
    assert.equal(prepared.foundation.athlete_state.adaptive_foundation.completion_pairs.length,3);
    const pairs = prepared.foundation.athlete_state.adaptive_foundation.completion_pairs;
    assert.equal(pairs.find(p=>p.prescribed_session.workout_family==='threshold_run').observation.observed_work_duration_s,1140);
    assert.equal(pairs.find(p=>p.prescribed_session.kind==='lift').observation.observed_duration_s,4500);
    assert.equal(prepared.foundation.artifacts[0].payload_json.physical_sources.measured_receipts.rows.length,3);
    assert.ok(result.selected_candidate, 'real measured source route produces a validated schedule');
    assert.equal(result.strength_dose_receipt.pool_authority,'OBSERVED_TOTAL_SET_CAP_FUTURE_DISTRIBUTION');
    assert.equal(result.strength_dose_receipt.pool_sets,24);
    assert.ok(result.selected_candidate.sessions.filter(s=>s.kind==='lift').every(s=>s.derived_totals.sets>=4));
    // These are source-supported measurements, NOT a claim of the still-missing
    // protected developing3/2 or established6/4 schedule acceptance.
    assert.equal(prepared.foundation.artifacts[0].payload_json.provider_coverage_intervals.length,0);
    console.log(JSON.stringify({requested_class:f===a?'developing3/2':'established6/4',selected_runs:result.selected_candidate.sessions.filter(s=>s.kind==='run').length,selected_lifts:result.selected_candidate.sessions.filter(s=>s.kind==='lift').length,phase:result.decision.phase,
      families:result.selected_candidate?.sessions.map(s=>[s.workout_family,s.derived_totals.sets,s.derived_totals.duration_s]),
      strength:result.strength_dose_receipt,source_support:prepared.source_support}));
  }
  const input = a.bodies[0];
  for (const bad of [{...input,expected_revision:0},{...input,expected_revision:1,session_hash:'f'.repeat(64)},
    {...input,expected_revision:1,plan_revision:2},{...input,expected_revision:1,session_revision:2},
    {...input,expected_revision:1,activity_id:b.bodies[0].activity_id},
    {...input,expected_revision:1,work_intervals:[{start_offset_s:0,end_offset_s:9999}]},
    {...input,expected_revision:1,work_intervals:[{start_offset_s:0,end_offset_s:100},{start_offset_s:90,end_offset_s:200}]},
    {...input,expected_revision:1,target_met:true}]) await assert.rejects(plans.recordActivityMeasurement(a.owner,bad));
  let touches=0; const touch=()=>{touches++;throw Error('hostile');};
  for (const bad of [new Proxy({}, {get:touch,ownKeys:touch,getPrototypeOf:touch,getOwnPropertyDescriptor:touch}),
    Object.defineProperty({},'version',{enumerable:true,get:touch}),{...input,work_intervals:[{toJSON:touch,toString:touch,[Symbol.toPrimitive]:touch}]}]) {
    await assert.rejects(plans.recordActivityMeasurement(a.owner,bad));
  }
  assert.equal(touches,0);
  // A complete activity without measured WORK intervals cannot prove protected
  // long execution. Aggregate duration remains a separate observed quantity.
  await plans.recordActivityMeasurement(a.owner,{...a.bodies[1],expected_revision:1,work_intervals:[]});
  await plans.previewPlanForUser(a.owner,a.req,options('shadow'));
  const aggregateLong=prepared.foundation.athlete_state.adaptive_foundation.completion_pairs.find(p=>p.prescribed_session.workout_family==='long_aerobic');
  assert.equal(aggregateLong.observation.quality_state,'PARTIAL');assert.equal(aggregateLong.observation.observed_work_duration_s,null);
  await plans.recordActivityMeasurement(a.owner,{...a.bodies[1],expected_revision:2});
  // Partial correction supersedes success; empty intervals never imply zero work.
  await plans.recordActivityMeasurement(a.owner,{...input,expected_revision:1,completeness:'PARTIAL',work_intervals:[]});
  await plans.previewPlanForUser(a.owner,a.req,options('shadow'));
  const partial = prepared.foundation.athlete_state.adaptive_foundation.completion_pairs.find(p=>p.prescribed_session.session_id===input.session_id);
  assert.equal(partial.observation.quality_state,'PARTIAL'); assert.equal(partial.observation.observed_work_duration_s,null);
  await plans.recordActivityMeasurement(a.owner,{...input,expected_revision:2});
  // A second physical run cannot claim the same accepted canonical session.
  await assert.rejects(plans.recordActivityMeasurement(a.owner,{...input,activity_id:`run-${a.owner}-3`,expected_revision:0}));
  const readPairs = async () => {
    await plans.previewPlanForUser(a.owner,a.req,options('shadow'));
    return prepared.foundation.athlete_state.adaptive_foundation.completion_pairs;
  };
  // Latest physical edits are withheld until explicitly remeasured; no aggregate
  // fallback can revive the formerly measured successful session.
  for (const sql of [
    `UPDATE runs SET duration_seconds=2299 WHERE id='${input.activity_id}'`,
    `UPDATE runs SET created_at='2026-09-15T12:00:00Z' WHERE id='${input.activity_id}'`,
    `UPDATE runs SET planned_session_json='{"content_hash":"wrong"}' WHERE id='${input.activity_id}'`,
    `UPDATE workout_sets SET reps=NULL WHERE id='${a.owner}-Bench press-1'`,
    `UPDATE workout_sets SET set_number=2 WHERE id='${a.owner}-Bench press-1'`,
    `UPDATE workout_sets SET logged_at='2026-09-15T12:00:00Z' WHERE id='${a.owner}-Bench press-1'`,
    `DELETE FROM workout_sets WHERE session_id='physical-lift-${a.owner}'`,
  ]) {
    // Savepoint only wraps acquisition; generation owns its own transaction.
    db.exec('SAVEPOINT measurement_negative'); db.exec(sql);
    const source = await require('../src/lib/adaptiveCoachingSources').loadMeasuredSources({tx,userId:a.owner,planningDateISO:DATE,observationInstant:NOW});
    assert.equal(source.sourceFailed,false);
    const kind = sql.includes('workout_sets') ? 'lift' : 'run';
    const physicalId = kind==='lift' ? a.bodies[2].activity_id : input.activity_id;
    assert.ok(!source.receipt.measured_receipts.usable.some(e=>e.row.activity_id===physicalId));
    const bad = {...(kind==='lift'?a.bodies[2]:input),expected_revision:kind==='lift'?1:3};
    if (!sql.includes('duration_seconds=2299')) await assert.rejects(receipts.record({tx,userId:a.owner,input:bad,accepted:a.set,now:NOW}));
    db.exec('ROLLBACK TO measurement_negative'); db.exec('RELEASE measurement_negative');
  }
  // Failed and partial strength successors remain in the shared evidence with
  // unknown sets; they cannot recover the older complete dose.
  await plans.recordActivityMeasurement(a.owner,{...a.bodies[2],expected_revision:1,completeness:'FAILED'});
  const failedLift = (await readPairs()).find(p=>p.prescribed_session.kind==='lift');
  assert.equal(failedLift.observation.quality_state,'PARTIAL');
  const rawLift = prepared.foundation.artifacts[0].payload_json.evidence.find(e=>e.evidence_id===failedLift.observation.evidence_id);
  assert.equal(rawLift.value.sets,null); assert.equal(rawLift.quality_state,'PARTIAL');
  await plans.recordActivityMeasurement(a.owner,{...a.bodies[2],expected_revision:2});
  const originalGet=tx.get;
  const hostileSource={artifact_payload_json:new Proxy({}, {get:touch,ownKeys:touch,getPrototypeOf:touch,getOwnPropertyDescriptor:touch})};
  tx.get=async(sql,params)=>sql.includes('SELECT canonical.id AS artifact_id')?hostileSource:originalGet(sql,params);
  await assert.rejects(plans.recordActivityMeasurement(a.owner,{...input,expected_revision:3}));
  tx.get=originalGet; assert.equal(touches,0);
  // SQL source failure is optional-SHADOW failure and cannot change user plan/hash.
  const plain=await plans.previewPlanForUser(a.owner,a.req,options('off'));
  hooks.before=(method,sql)=>{if(method==='all'&&sql.includes('FROM activity_measured_receipts'))throw Error('synthetic SQL failure');};
  const unavailable=await plans.previewPlanForUser(a.owner,a.req,options('shadow'));hooks.before=null;
  assert.deepEqual(unavailable.plan,plain.plan);assert.equal(unavailable.candidateHash,plain.candidateHash);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM planning_pipeline_artifacts WHERE plan_generation_candidate_id=?').get(unavailable.id).n,0);
  // Every measured revision is captured by the generation stale reread.
  let n=0; hooks.beforeTransaction=()=>{ if(++n===2) db.prepare('UPDATE activity_measured_receipts SET created_at=? WHERE user_id=? AND revision=1').run('2026-09-14T11:00:00Z',a.owner); };
  await assert.rejects(plans.previewPlanForUser(a.owner,a.req,options('shadow')),e=>e.code==='CANDIDATE_STALE'); hooks.beforeTransaction=null;
  const before = db.prepare('SELECT COUNT(*) n FROM activity_measured_receipts').get().n;
  hooks.before=(method,sql)=>{if(method==='all'&&sql.includes('FROM activity_measured_receipts'))throw Error('non-SHADOW acquired measurements');};
  for (const mode of ['off','preview','on']) await plans.previewPlanForUser(b.owner,b.req,options(mode));
  hooks.before=null;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM activity_measured_receipts').get().n,before);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM planning_pipeline_artifacts WHERE artifact_kind='surface_manifest'").get().n,0);
  // Distinct recent activities remain bounded; revisions do not consume activity capacity.
  db.exec('SAVEPOINT receipt_overflow');
  for(let i=0;i<513;i++) db.prepare(`INSERT INTO activity_measured_receipts(id,user_id,activity_kind,activity_id,plan_id,session_id,revision,payload_json,content_hash,created_at)
    VALUES (?,?,'run',?,'overflow-plan','overflow-session',1,'{}','invalid',?)`).run(`overflow-${i}`,a.owner,`overflow-physical-${i}`,NOW);
  const overflow=await require('../src/lib/adaptiveCoachingSources').loadMeasuredSources({tx,userId:a.owner,planningDateISO:DATE,observationInstant:NOW});
  assert.equal(overflow.reason_code,'SOURCE_OVERFLOW');
  db.exec('ROLLBACK TO receipt_overflow');db.exec('RELEASE receipt_overflow');
  // Real server pagination + existing watchSync ingestion, entirely synthetic pages.
  const coverage = require('../src/lib/providerImportCoverage');
  const ingest = require('../src/routes/watchSync').ingestActivity;
  const toPayload = require('../src/routes/garmin')._coverageTest.toIngestPayload;
  const migrationCoverage = require('../src/db/migrate').ensureProviderImportReceipts;
  await migrationCoverage(sql=>db.exec(sql),'sqlite'); await migrationCoverage(sql=>db.exec(sql),'sqlite');
  const generated=[]; await migrationCoverage(sql=>generated.push(sql),'postgres');
  assert.ok(pgSchema.includes(generated[0]));
  for (const f of [a,b]) {
    const pages = Array.from({length:28},(_,i)=>({ activityId:10000+i,
      startTimeGMT:`${addDays(DATE,-i-1)}T08:00:00`, startTimeLocal:`${addDays(DATE,-i-1)}T08:00:00`,
      activityType:{typeKey:'running'},activityName:'Synthetic measured running',distance:4800,duration:2100 }));
    const offsets=[];
    const runImport = client => coverage.sync({userId:f.owner,client,ingest,toPayload,mutation:fixture.exports.withPlanningInputMutation,now:NOW});
    const terminal=await runImport({getActivities:async(offset,size)=>{ offsets.push([offset,size]); return offset===0?pages:[]; }});
    assert.equal(terminal.status,'COMPLETE'); assert.deepEqual(offsets,[[0,200],[200,200]]);
    assert.equal(terminal.synced,28);
    assert.equal(coverage.merge([{source_system:'garmin',status:'complete'}],[{health_source:'apple_health'}]).find(r=>r.source_system==='apple_health').status,'unknown');
    const duplicate=await runImport({getActivities:async offset=>offset===0?pages:[]});
    assert.equal(duplicate.status,'COMPLETE');
    const loaded=await coverage.load({tx,userId:f.owner,observationInstant:NOW});
    assert.equal(loaded.coverage[0].status,'complete'); assert.equal(loaded.bindings.length,28);
    // JSONB object and timestamp string readback, as configured by db/index.js.
    const driverTx={...tx,get:async(sql,args)=>{const row=await tx.get(sql,args);return row?.payload_json?{...row,payload_json:JSON.parse(row.payload_json),created_at:'2026-09-14 12:00:00+00'}:row;}};
    assert.equal((await coverage.load({tx:driverTx,userId:f.owner,observationInstant:NOW})).coverage[0].status,'complete');
    const off=await plans.previewPlanForUser(f.owner,f.req,options('off'));
    const shadowResult=await plans.previewPlanForUser(f.owner,f.req,options('shadow'));
    assert.deepEqual(shadowResult.plan,off.plan); assert.equal(shadowResult.candidateHash,off.candidateHash);
    assert.equal(prepared.foundation.artifacts[0].payload_json.physical_sources.provider_imports.rows.length,1);
    assert.equal(prepared.foundation.athlete_state.consistent_weeks,4);
    assert.equal(prepared.foundation.athlete_state.recent_normal_running.status,'ESTABLISHED');
    assert.equal(prepared.foundation.artifacts[0].payload_json.provider_coverage_intervals[0].complete,true);
    console.log(JSON.stringify({coverage_after:f===a?'developing3/2':'established6/4',phase:result.decision.phase,
      consistent_weeks:prepared.foundation.athlete_state.consistent_weeks,recent_normal:prepared.foundation.athlete_state.recent_normal_running,
      families:result.selected_candidate?.sessions.map(s=>[s.workout_family,s.derived_totals.sets,s.derived_totals.duration_s]),
      status:result.status, applicable:result.applicable, search:result.search, deferred:result.deferred_objectives, selection:result.session_selection, strength:result.strength_dose_receipt}));
    if (f===a) {
      let transactions=0; hooks.beforeTransaction=()=>{ if(++transactions===2) db.prepare(`UPDATE provider_import_receipts SET created_at=? WHERE id=? AND user_id=?`).run('2026-09-14T11:00:00Z',loaded.rows[0].id,f.owner); };
      await assert.rejects(plans.previewPlanForUser(f.owner,f.req,options('shadow')),e=>e.code==='CANDIDATE_STALE');
      hooks.beforeTransaction=null;
    }
    // Stale physical import bindings and latest failed interval suppress completeness.
    db.exec('SAVEPOINT imported_drift');
    db.prepare('UPDATE runs SET distance_miles=distance_miles+1 WHERE id=? AND user_id=?').run(loaded.bindings[0].record_id,f.owner);
    assert.equal((await coverage.load({tx,userId:f.owner,observationInstant:NOW})).coverage[0].status,'partial');
    db.exec('ROLLBACK TO imported_drift');db.exec('RELEASE imported_drift');
    assert.equal((await coverage.load({tx,userId:f.owner,observationInstant:'2026-09-17T12:00:00Z'})).coverage[0].status,'partial');
    assert.equal((await coverage.load({tx,userId:f.owner,observationInstant:NOW,timezone:'America/New_York'})).coverage[0].status,'partial');
    const failed=await runImport({getActivities:async()=>{throw new Error('synthetic provider failure');}});
    assert.equal(failed.status,'FAILED'); assert.equal((await coverage.load({tx,userId:f.owner,observationInstant:NOW})).coverage[0].status,'failed');
    const repeated=await runImport({getActivities:async()=>pages});
    assert.equal(repeated.status,'PARTIAL');
    let touches=0;const hostile=new Proxy({}, {get(){touches++;throw new Error('opaque');},ownKeys(){touches++;throw new Error('opaque');}});
    assert.equal((await runImport({getActivities:async()=>[hostile]})).status,'PARTIAL'); assert.equal(touches,0);
  }
  // Four weeks x four substantive 24-set workouts exceed the old 256-set cap.
  db.exec('SAVEPOINT measured_matrix');
  for (let i=0;i<16;i++) {
    const id=`matrix-work-${i}`,date=addDays(DATE,-i-1);
    db.prepare('INSERT INTO workout_sessions(id,user_id,started_at,ended_at,total_seconds,created_at) VALUES (?,?,?,?,?,?)').run(id,b.owner,`${date}T08:00:00Z`,`${date}T09:00:00Z`,3600,`${date}T09:00:00Z`);
    for(let j=0;j<24;j++) db.prepare('INSERT INTO workout_sets(id,user_id,session_id,exercise_name,set_number,reps,weight_lbs,logged_at) VALUES (?,?,?,?,?,?,?,?)').run(`${id}-${j}`,b.owner,id,'Measured exercise',j+1,8,50,`${date}T08:30:00Z`);
  }
  const matrix=await require('../src/lib/adaptiveCoachingSources').loadMeasuredSources({tx,userId:b.owner,planningDateISO:DATE,observationInstant:NOW});
  assert.equal(matrix.sourceFailed,false);assert.ok(matrix.receipt.workout_sets.length>=384);
  db.exec('ROLLBACK TO measured_matrix');db.exec('RELEASE measured_matrix');
  // Lifetime revisions no longer consume a fixed 64-row quota.
  for(let revision=1;revision<70;revision++) await plans.recordActivityMeasurement(b.owner,{...b.bodies[0],expected_revision:revision});
  const history=await receipts.load({tx,userId:b.owner,observationInstant:NOW});
  assert.equal(history.chain_receipts.find(r=>r.activity_id===b.bodies[0].activity_id).revisions,70);
  assert.ok(history.usable.some(r=>r.row.revision===70));
  console.log('ok - recorder/authenticated source, SQL migration, measured routes, revision correction, stale snapshot, owner/hash/revision/interval/hostile boundaries');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{global.Date=RealDate;shadow.prepare=realPrepare;shadow.compute=realCompute;db.close();});
