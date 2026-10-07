// Self-contained synthetic real-SQLite fixture: genuine route preview/apply/history.
// Initial prior acceptance is explicit setup; every replacement uses the real route.
const assert = require('node:assert/strict');
const { createDb } = require('./helpers/adaptiveShadowDb');
const fixture = createDb(), { db, tx, hooks } = fixture;
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fixture.exports };
const RealDate = Date; let DATE = '2026-09-20', NOW = `${DATE}T12:00:00Z`;
global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return RealDate.parse(NOW); } };
const shadow = require('../src/lib/adaptiveCoachingShadow');
const realPrepare = shadow.prepare, realCompute = shadow.compute;
let prepared, prepareInput, result, computations = 0;
shadow.prepare = a => { prepareInput = a; prepared = realPrepare(a); return prepared; };
shadow.compute = p => { computations++; result = realCompute(p); return result; };
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
  const definitions = [ ['threshold_run', '2026-09-12',2400,1200], ['long_aerobic','2026-09-11',4200,null],
    ['strength_full_body','2026-09-13',null,null] ];
  const materials = definitions.map(([family,date,seconds,work], i) => {
    const exercises = i === 2 ? ['Upper body','Lower body'].flatMap(focus => buildStrengthExercises({ focus,
      equipment: ['dumbbells','bench'], mode: 'hybrid_build' }).slice(0,2)).map(e => ({ ...e, sets: 6 })) : undefined;
    return buildAdaptiveWorkoutMaterial({ selection_id: `accepted-${owner}-${i}`,workout_family: family,objective_ids:['prior-objective'],
      duration_s:seconds,distance_m:seconds ? seconds*2.3 : null,quality_work_s:work,exercises,
      reason_codes:['WEEKLY_OBJECTIVE_REQUIRED'],dose_basis:{ policy_id:'adaptive-observed-dose-v1',authority:'OBSERVED_COMPLETED_WEEK_STRENGTH',source_evidence_ids:['prior-history'] } }, decision, '2026-09-13T00:00:00Z');
  });
  const set = materializeCanonicalSessionSet({ decision, candidate: { candidate_id:`prior-${owner}`,candidate_material: materials,
    sessions: definitions.map(([family,date],i) => ({ session_id:`accepted-${owner}-${i}`,candidate_material_id:materials[i].material_id,
      workout_family:family,role:i===2?'SUPPORTING':'PRIMARY_KEY',scheduled_local_date:date,scheduled_start_at:`${date}T06:00:00Z` })) },
    planning_instant:'2026-09-13T00:00:00Z',timezone:'UTC' });
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
  for (let i=0;i<2;i++) db.prepare(`INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds,created_at) VALUES (?,?,?,'easy',6,3600,?)`)
    .run(`run-${owner}-${i}`,owner,addDays(DATE,-1-i),`${addDays(DATE,-1-i)}T12:00:00Z`);
  const req = request(run,lift);
  if (age === 'DEVELOPING') {
    db.prepare(`INSERT INTO race_events(id,user_id,race_name,race_date,event_local_date,event_timezone,distance_miles,goal_time_seconds,event_kind)
      VALUES (?,?,'Synthetic road goal','2026-11-29','2026-11-29','UTC',6.2,3600,'run_race')`).run(`race-${owner}`,owner);
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
      .run(i===0?'2026-09-18':'2026-09-16',seconds,miles,i===0?'2026-09-18T12:00:00Z':'2026-09-16T12:00:00Z',s.session_id,
        JSON.stringify({matchSource:'explicit_owned_session',sessionId:s.session_id,planId:set.plan_id,date:s.scheduled_local_date,kind:'run',content_hash:s.content_hash}),`run-${owner}-${i}`,owner);
  }
  db.prepare(`INSERT INTO workout_sessions(id,user_id,started_at,ended_at,total_seconds,created_at) VALUES (?,?,'2026-09-17T10:00:00Z','2026-09-17T11:30:00Z',4500,'2026-09-17T11:30:00Z')`)
    .run(`physical-lift-${owner}`,owner);
  // Existing per-set recorder storage, separate from the canonical exercise graph.
  for (const exercise of ['Bench press','Row','Squat','Deadlift']) for (let n=1;n<=6;n++) db.prepare(`INSERT INTO workout_sets(id,user_id,session_id,exercise_name,set_number,reps,weight_lbs,logged_at) VALUES (?,?,?,?,?,8,100,'2026-09-17T10:30:00Z')`)
    .run(`${owner}-${exercise}-${n}`,owner,`physical-lift-${owner}`,exercise,n);
  const bodies = [body(owner,set,0,`run-${owner}-0`),body(owner,set,1,`run-${owner}-1`),body(owner,set,2,`physical-lift-${owner}`)];
  return { owner,accepted,set,bodies,req,baseCandidateId:off.id };
}
const history = require('../src/lib/adaptiveAcceptedHistory');
const TABLES = ['users','runs','lifts','workout_sessions','workout_sets','daily_checkins','training_plans','user_plans',
  'activity_measured_receipts','plan_generation_candidates','planning_pipeline_artifacts'];
const physicalTables = ['runs','lifts','workout_sessions','workout_sets','activity_measured_receipts'];
const snapshot = (tables = TABLES) => Object.fromEntries(tables.map(t => [t, db.prepare(`SELECT * FROM ${t} ORDER BY id`).all()]));
const pairsOf = () => prepared.foundation.athlete_state.adaptive_foundation.completion_pairs;
const bodyFor = c => ({ ...c.applyBindings, candidate_hash:c.candidateHash, choice:'train_for_target', planning_date_local:DATE });
const insert = (table,row) => db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`).run(...Object.values(row));
const passed = [];
async function isolated(label, fn) {
  const saved=snapshot();
  try { await fn(); passed.push(label); } finally { restoreSnapshot(saved); }
}
function restoreSnapshot(saved) {
  db.exec('PRAGMA foreign_keys=OFF');
  for(const table of [...TABLES].reverse()) db.prepare(`DELETE FROM ${table}`).run();
  for(const table of TABLES) for(const row of saved[table]) insert(table,row);
  db.exec('PRAGMA foreign_keys=ON');
}
async function acquire(owner) {
  const measured = await receipts.load({tx,userId:owner,observationInstant:NOW});
  return { measured, historical:await history.loadHistoricalEvidence({tx,userId:owner,receipts:measured,observationInstant:NOW}) };
}
function editJson(table, column, id, owner, mutate, rehash = false) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id=? AND user_id=?`).get(id,owner);
  const value = JSON.parse(row[column]); mutate(value);
  db.prepare(`UPDATE ${table} SET ${column}=?${rehash?',content_hash=?':''} WHERE id=? AND user_id=?`)
    .run(JSON.stringify(value),...(rehash?[`${table==='planning_pipeline_artifacts'?'sha256:':''}${canonicalHash(value)}`]:[]),id,owner);
}
async function main() {
  const f = await setup('55555555-5555-4555-8555-000000000001','ESTABLISHED',4,4);
  const foreign = '55555555-5555-4555-8555-000000000002';
  db.prepare("INSERT INTO users(id,name,email,password_hash) VALUES (?,'Synthetic','foreign@example.invalid','')").run(foreign);
  for (const b of f.bodies) await plans.recordActivityMeasurement(f.owner,b);
  // Independently observed running volume; no provider coverage claim or network.
  for (let week=0;week<4;week++) for (let day=0;day<6;day++) {
    const date=addDays(DATE,-34+week*7+day);
    db.prepare(`INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds,created_at) VALUES (?,?,?,'easy',?,?,?)`)
      .run(`volume-${week}-${day}`,f.owner,date,(day===1?9200:day===2?5300:5000)/1609.344,day===1?4000:day===2?2300:2200,`${date}T12:00:00Z`);
  }
  const req = {...f.req,target:{...f.req.target,trainingDays:['Tue','Thu','Sat','Sun'],strengthGoal:'maintain',equipment:['barbell','dumbbell','rack','bench','cable','machines']}};
  const on = await plans.previewPlanForUser(f.owner,req,options('on'));
  assert.equal(on.surfaceManifest.sessions.filter(s=>s.kind==='run').length,4);
  assert.equal(on.surfaceManifest.sessions.filter(s=>s.kind==='lift').length,4);
  assert.equal(pairsOf().length,3);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM planning_pipeline_artifacts WHERE plan_generation_candidate_id=? AND user_id=?').get(on.id,f.owner).n,7);
  const again=await plans.previewPlanForUser(f.owner,req,{...options('on'),store:false});
  assert.equal(again.candidateHash,on.candidateHash); assert.deepEqual(again.plan,on.plan);
  const before=snapshot();
  assert.equal((await plans.applyPlanCandidate(foreign,on.id,bodyFor(on),options('on'))).code,'CANDIDATE_NOT_FOUND');
  assert.deepEqual(snapshot(),before);
  hooks.before=(method,sql)=>{if(method==='run'&&sql.includes('INSERT INTO user_plans')) throw Error('assignment fault');};
  await assert.rejects(plans.applyPlanCandidate(f.owner,on.id,bodyFor(on),options('on')),/assignment fault/);
  hooks.before=null; assert.deepEqual(snapshot(),before);
  assert.equal((await plans.applyPlanCandidate(f.owner,on.id,bodyFor(on),options('on'))).status,200);
  assert.deepEqual(snapshot(physicalTables),Object.fromEntries(physicalTables.map(t=>[t,before[t]])));
  const after=snapshot(), replayCalls=fixture.calls.length;
  assert.equal(db.prepare("SELECT COUNT(*) n FROM user_plans WHERE user_id=? AND status='active'").get(f.owner).n,1);
  assert.equal((await plans.applyPlanCandidate(f.owner,on.id,bodyFor(on),options('on'))).replay,true);
  assert.deepEqual(snapshot(),after);
  assert.equal(fixture.calls.slice(replayCalls).filter(c=>c.method==='run').length,0);
  let immediateReason=null;
  try { await plans.previewPlanForUser(f.owner,req,{...options('on'),store:false}); }
  catch(e) { assert.equal(e.code,'GOAL_BACKWARD_GENERATION_FAILED'); immediateReason=e.details?.reason_code; }
  assert.equal(pairsOf().length,3); assert.equal(prepared.source_support.source_limited,false);
  const firstBinding=prepared.observed_binding, firstPairs=pairsOf();
  try { await plans.previewPlanForUser(f.owner,req,{...options('on'),store:false}); } catch(e) { assert.equal(e.code,'GOAL_BACKWARD_GENERATION_FAILED'); }
  assert.equal(prepared.observed_binding,firstBinding); assert.deepEqual(pairsOf(),firstPairs);
  const active=db.prepare("SELECT * FROM user_plans WHERE user_id=? AND status='active'").get(f.owner);
  assert.notEqual(active.plan_id,on.plan.plan_id);
  const activeRow={...active,user_plan_id:active.id,plan_json:JSON.stringify(on.plan)};
  assert.equal((await plans.canonicalSurfaceManifestForActive(f.owner,activeRow,tx.get)).status,'accepted');
  assert.ok(prepareInput.accepted.sessions.every(s=>!f.set.sessions.some(old=>old.session_id===s.session_id)));
  assert.ok(prepared.availability.occupied_sessions.every(s=>prepareInput.accepted.sessions.some(a=>a.session_id===s.session_id)));
  await assert.rejects(plans.recordActivityMeasurement(f.owner,{...f.bodies[2],expected_revision:1}),e=>e.code==='ACTIVITY_MEASUREMENT_INVALID');
  passed.push('weekly 4+4 / immediate retained three pairs / determinism / rollback / replay / active authority');

  // Observe a genuine applied session, whose canonical ID differs from storage.
  DATE='2026-09-28'; NOW=`${DATE}T12:00:00Z`;
  const lift=on.surfaceManifest.sessions.find(s=>s.kind==='lift');
  db.prepare(`INSERT INTO workout_sessions(id,user_id,started_at,ended_at,total_seconds,created_at)
    VALUES ('genuine-lift',?,'2026-09-27T10:00:00Z','2026-09-27T11:00:00Z',3000,'2026-09-27T11:00:00Z')`).run(f.owner);
  for(let i=1;i<=8;i++) db.prepare(`INSERT INTO workout_sets(id,user_id,session_id,exercise_name,set_number,reps,weight_lbs,logged_at)
    VALUES (?,?,'genuine-lift','Bench press',?,8,100,'2026-09-27T10:30:00Z')`).run(`genuine-${i}`,f.owner,i);
  await plans.recordActivityMeasurement(f.owner,{version:receipts.VERSION,activity_kind:'lift',activity_id:'genuine-lift',
    plan_id:on.plan.plan_id,plan_revision:on.plan.plan_revision,session_id:lift.session_id,session_revision:lift.session_revision,
    session_hash:lift.content_hash,expected_revision:0,completeness:'COMPLETE',work_intervals:[]});
  observeRecentWeek(f.owner,'second');
  const nextReq={...req,planning_date_local:DATE,target:{...req.target,runDaysPerWeek:2,liftDaysPerWeek:2}};
  console.log('history: first replacement verified');
  const second=await plans.previewPlanForUser(f.owner,nextReq,options('on')).catch(e=>{console.error(JSON.stringify({support:prepared.source_support,phase:result?.decision.phase,deferred:result?.deferred_objectives}));throw e;});
  assert.equal(pairsOf().length,4);
  const beforeSecond=snapshot(physicalTables);
  const appliedSecond=await plans.applyPlanCandidate(f.owner,second.id,bodyFor(second),options('on'));
  assert.equal(appliedSecond.status,200,JSON.stringify(appliedSecond));
  assert.equal(db.prepare('SELECT id FROM plan_generation_candidates WHERE id=? AND user_id=?').get(f.baseCandidateId,f.owner),undefined,'expired preview cleanup remains active');
  assert.deepEqual(snapshot(physicalTables),beforeSecond);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM user_plans WHERE user_id=? AND status='active'").get(f.owner).n,1);
  try { await plans.previewPlanForUser(f.owner,nextReq,{...options('on'),store:false}); } catch(e) { assert.equal(e.code,'GOAL_BACKWARD_GENERATION_FAILED'); }
  assert.equal(pairsOf().length,4);
  const source=prepareInput.source;
  console.log('history: second replacement verified');
  const loaded=await acquire(f.owner);
  assert.equal(loaded.historical.sets.length,2);
  const reversed=await history.loadHistoricalEvidence({tx,userId:f.owner,receipts:{...loaded.measured,usable:[...loaded.measured.usable].reverse()},observationInstant:NOW});
  assert.deepEqual(reversed,loaded.historical,'reference order cannot affect history binding');
  assert.equal(receipts.pairs(loaded.measured,null,source.snapshot,loaded.historical).length,4);
  passed.push('two genuine replacements / canonical-storage divergence / four physical pairs');

  const originalId=f.accepted.artifact.id, candidateId=`historical-accepted-candidate-${f.owner}`;
  const mutations = [
    ['artifact owner',()=>db.prepare('UPDATE planning_pipeline_artifacts SET user_id=? WHERE id=? AND user_id=?').run(foreign,originalId,f.owner)],
    ['candidate owner',()=>db.prepare('UPDATE plan_generation_candidates SET user_id=? WHERE id=? AND user_id=?').run(foreign,candidateId,f.owner)],
    ['assignment owner',()=>db.prepare('UPDATE user_plans SET user_id=? WHERE id=? AND user_id=?').run(foreign,f.accepted.assignment,f.owner)],
    ['storage owner',()=>db.prepare('UPDATE training_plans SET user_id=? WHERE id=? AND user_id=?').run(foreign,f.set.plan_id,f.owner)],
    ['missing applied link',()=>db.prepare('UPDATE plan_generation_candidates SET applied_user_plan_id=NULL WHERE id=? AND user_id=?').run(candidateId,f.owner)],
    ['unapplied candidate',()=>db.prepare("UPDATE plan_generation_candidates SET status='preview' WHERE id=? AND user_id=?").run(candidateId,f.owner)],
    ['unsupported assignment',()=>db.prepare("UPDATE user_plans SET status='cleared' WHERE id=? AND user_id=?").run(f.accepted.assignment,f.owner)],
    ['missing artifact',()=>db.prepare('DELETE FROM planning_pipeline_artifacts WHERE id=? AND user_id=?').run(originalId,f.owner)],
    ['artifact payload without hash',()=>editJson('planning_pipeline_artifacts','payload_json',originalId,f.owner,v=>v.decision_id='altered')],
    ['artifact hash',()=>db.prepare("UPDATE planning_pipeline_artifacts SET content_hash=? WHERE id=? AND user_id=?").run('sha256:'+'0'.repeat(64),originalId,f.owner)],
    ['selected hash',()=>db.prepare('UPDATE plan_generation_candidates SET selected_candidate_hash=? WHERE id=? AND user_id=?').run('0'.repeat(64),candidateId,f.owner)],
    ['prescription hash',()=>editJson('plan_generation_candidates','material_change_json',candidateId,f.owner,v=>v.candidate_prescription_hash='0'.repeat(64))],
    ['assignment revision',()=>db.prepare('UPDATE user_plans SET plan_version=99 WHERE id=? AND user_id=?').run(f.accepted.assignment,f.owner)],
    ...['plan_revision','plan_id','content_hash'].map(key=>[`payload ${key}`,()=>editJson('planning_pipeline_artifacts','payload_json',originalId,f.owner,v=>v[key]=key==='plan_revision'?99:'altered',true)]),
    ...['session_revision','content_hash','kind'].map(key=>[`session ${key}`,()=>editJson('planning_pipeline_artifacts','payload_json',originalId,f.owner,v=>v.sessions[0][key]=key==='session_revision'?99:'altered',true)]),
    ['reconstructed bytes',()=>editJson('training_plans','plan_data',f.set.plan_id,f.owner,v=>v.weeks.flatMap(w=>w.days).find(d=>d.sessions.length).sessions[0].title='altered')],
    ['alternate stored bytes',()=>editJson('training_plans','plan_json',f.set.plan_id,f.owner,v=>v.weeks.flatMap(w=>w.days).find(d=>d.sessions.length).sessions[0].title='altered')],
    ['candidate plan bytes',()=>editJson('plan_generation_candidates','candidate_plan_json',candidateId,f.owner,v=>v.weeks.flatMap(w=>w.days).find(d=>d.sessions.length).sessions[0].title='altered')],
    ['storage identity',()=>db.prepare('UPDATE user_plans SET plan_id=? WHERE id=? AND user_id=?').run(active.plan_id,f.accepted.assignment,f.owner)],
    ['ambiguous artifact',()=>{const row=db.prepare('SELECT * FROM planning_pipeline_artifacts WHERE id=?').get(originalId);insert('planning_pipeline_artifacts',{...row,id:'ambiguous-artifact',revision:row.revision+1});}],
    ['metadata bytes overflow',()=>db.prepare('UPDATE plan_generation_candidates SET selected_candidate_hash=? WHERE id=? AND user_id=?').run('x'.repeat(513),candidateId,f.owner)],
    ['payload bytes overflow',()=>db.prepare('UPDATE training_plans SET plan_data=? WHERE id=? AND user_id=?').run(' '.repeat(history.MAX_PAYLOAD_BYTES+1),f.set.plan_id,f.owner)],
  ];
  for(const [label,mutate] of mutations) await isolated(label,async()=>{
    mutate(); const current=await acquire(f.owner);
    assert.ok(!current.historical.sets.some(s=>s.plan_id===f.set.plan_id),label);
    assert.notDeepEqual(current.historical.binding,loaded.historical.binding,label);
  });
  await isolated('rejected match edits and deletes remain bound',async()=>{
    db.prepare('UPDATE planning_pipeline_artifacts SET content_hash=? WHERE id=? AND user_id=?').run('sha256:'+'0'.repeat(64),originalId,f.owner);
    const a=await acquire(f.owner);
    editJson('planning_pipeline_artifacts','payload_json',originalId,f.owner,v=>v.decision_id='different');
    const b=await acquire(f.owner);
    assert.ok(!a.historical.sets.some(s=>s.plan_id===f.set.plan_id));
    assert.ok(!b.historical.sets.some(s=>s.plan_id===f.set.plan_id));
    assert.notDeepEqual(a.historical.binding,b.historical.binding);
    const input=prepareInput;
    const preparedA=realPrepare({...input,historicalEvidence:a.historical});
    assert.equal(shadow.sameObserved(preparedA,input.state,input.source,{accepted:input.accepted,
      acceptedReason:input.acceptedReason,historicalEvidence:b.historical}),false);
    db.prepare('DELETE FROM planning_pipeline_artifacts WHERE id=? AND user_id=?').run(originalId,f.owner);
    const c=await acquire(f.owner); assert.notDeepEqual(b.historical.binding,c.historical.binding);
  });
  await isolated('truncated authentication read fails closed',async()=>{
    hooks.after=(method,sql,rows)=>method==='all'&&sql.includes('FROM plan_generation_candidates candidate')&&sql.includes('LIMIT 2')?[]:rows;
    try { assert.equal((await acquire(f.owner)).historical.sets.length,0); }
    finally { hooks.after=null; }
  });
  console.log('history: authentication negatives verified');
  await negativeEvidence(f,foreign,loaded,source);
  await overflowAndSql(f,loaded);
  await transactionNegatives(f,req,mutations);
  console.log(JSON.stringify({passed,immediateReason}));
}
main().then(()=>console.log('ADAPTIVE ACCEPTED HISTORY SMOKE OK')).catch(e=>{console.error(e);process.exitCode=1;})
  .finally(()=>{global.Date=RealDate;shadow.prepare=realPrepare;shadow.compute=realCompute;db.close();});

async function negativeEvidence(f,foreign,loaded,source) {
  const row=db.prepare("SELECT * FROM activity_measured_receipts WHERE user_id=? AND activity_kind='run' ORDER BY id LIMIT 1").get(f.owner);
  const negatives=[
    ['receipt owner',()=>db.prepare('UPDATE activity_measured_receipts SET user_id=? WHERE id=? AND user_id=?').run(foreign,row.id,f.owner)],
    ['workout owner',()=>db.prepare('UPDATE workout_sessions SET user_id=? WHERE id=? AND user_id=?').run(foreign,f.bodies[2].activity_id,f.owner)],
    ['set owner',()=>db.prepare('UPDATE workout_sets SET user_id=? WHERE id=? AND user_id=?').run(foreign,`${f.owner}-Bench press-1`,f.owner)],
    ['physical owner',()=>db.prepare('UPDATE runs SET user_id=? WHERE id=? AND user_id=?').run(foreign,row.activity_id,f.owner)],
    ['physical edit',()=>db.prepare('UPDATE runs SET duration_seconds=200 WHERE id=? AND user_id=?').run(row.activity_id,f.owner)],
    ['missing physical',()=>db.prepare('DELETE FROM runs WHERE id=? AND user_id=?').run(row.activity_id,f.owner)],
    ['future receipt',()=>db.prepare("UPDATE activity_measured_receipts SET created_at='2027-01-01T00:00:00Z' WHERE id=? AND user_id=?").run(row.id,f.owner)],
    ['future physical',()=>db.prepare("UPDATE runs SET date='2027-01-01' WHERE id=? AND user_id=?").run(row.activity_id,f.owner)],
  ];
  for(const [label,mutate] of negatives) await isolated(label,async()=>{
    mutate(); const current=await acquire(f.owner);
    assert.equal(receipts.pairs(current.measured,null,source.snapshot,current.historical).length,3,label);
  });
  for(const variant of ['FAILED','PARTIAL','STALE']) await isolated(`latest ${variant}`,async()=>{
    const completeness=variant==='STALE'?'COMPLETE':variant;
    const payload=JSON.parse(row.payload_json);
    payload.binding.expected_revision=1; payload.binding.completeness=completeness;
    payload.completeness=completeness; payload.supersedes_receipt_id=row.id;
    if(variant!=='STALE') payload.actual.work_duration_s=null;
    insert('activity_measured_receipts',{...row,id:`successor-${variant}`,revision:2,created_at:variant==='STALE'?'2027-01-01T00:00:00Z':row.created_at,payload_json:JSON.stringify(payload),content_hash:canonicalHash(payload)});
    const current=await acquire(f.owner);
    const pairs=receipts.pairs(current.measured,null,source.snapshot,current.historical);
    assert.equal(pairs.length,variant==='STALE'?3:4);
    if(variant!=='STALE') assert.equal(pairs.find(p=>p.observation.measured_receipt_id===`successor-${variant}`).observation.completed,false);
    assert.ok(!pairs.some(p=>p.observation.measured_receipt_id===row.id),'old success cannot resurrect');
    // Same server source plus changed successors proves aggregate fallback stays suppressed.
    const updated=realPrepare({...prepareInput,source:{...source,snapshot:{...source.snapshot,physical_sources:{...source.snapshot.physical_sources,measured_receipts:current.measured}}},historicalEvidence:current.historical});
    const bound=updated.foundation.athlete_state.adaptive_foundation.completion_pairs.filter(p=>p.prescribed_session.session_id===row.session_id);
    assert.equal(bound.length,variant==='STALE'?0:1);
    if(variant!=='STALE') assert.equal(bound[0].observation.completed,false);
    editJson('activity_measured_receipts','payload_json',row.id,f.owner,v=>v.actual.duration_s=42);
    await assert.rejects(acquire(f.owner),e=>e.code==='ACTIVITY_MEASUREMENT_INVALID');
  });
  await isolated('no observed receipts / no historical strength authority',async()=>{
    db.prepare('DELETE FROM activity_measured_receipts WHERE user_id=?').run(f.owner);
    const empty=await acquire(f.owner); assert.equal(empty.historical.sets.length,0);
    await assert.rejects(plans.previewPlanForUser(f.owner,{...f.req,planning_date_local:DATE},options('on')),
      e=>e.details?.reason_code==='CANONICAL_STRENGTH_LINK_ABSENT');
  });
  const state=prepared.foundation.athlete_state;
  const old=receipts.pairs(loaded.measured,null,source.snapshot,loaded.historical);
  const selection=require('../src/lib/adaptiveCoachingSelection');
  assert.equal(selection.usablePairs({...state,planning_date_local:'2026-10-30',adaptive_foundation:{...state.adaptive_foundation,completion_pairs:old}}).length,0);
  const originalLift=old.find(p=>p.prescribed_session.session_id===f.set.sessions[2].session_id);
  const atAge=age=>selection.usablePairs({...state,planning_date_local:addDays(originalLift.observation.observed_at.slice(0,10),age),
    adaptive_foundation:{...state.adaptive_foundation,completion_pairs:[originalLift]}});
  assert.equal(atAge(28).length,1); assert.equal(atAge(29).length,0); assert.equal(atAge(-1).length,0);
  passed.push('28-day usable-dose boundary unchanged');
  await isolated('true first-time strength blocked',async()=>{
    // Foreign account has no accepted plan, canonical artifact, or receipt.
    await assert.rejects(plans.previewPlanForUser(foreign,{...f.req,planning_date_local:DATE},options('on')),
      e=>e.details?.reason_code==='CANONICAL_STRENGTH_LINK_ABSENT');
    assert.equal(prepareInput.accepted,null); assert.equal(prepareInput.historicalEvidence.sets.length,0);
  });
}
async function overflowAndSql(f,loaded) {
  // Boundary references are constructed from real server-loaded rows, never request input.
  const original=loaded.measured.usable[0];
  const referenced=n=>({...loaded.measured,usable:Array.from({length:n},(_,i)=>({...original,
    payload:{...original.payload,binding:{...original.payload.binding,plan_id:`bounded-${i}`}}}))});
  const sixtyFour=await history.loadHistoricalEvidence({tx,userId:f.owner,receipts:referenced(64),observationInstant:NOW});
  assert.equal(sixtyFour.sourceFailed,false); assert.equal(sixtyFour.binding.references.length,64);
  const sixtyFive=await history.loadHistoricalEvidence({tx,userId:f.owner,receipts:referenced(65),observationInstant:NOW});
  assert.equal(sixtyFive.sourceFailed,true); assert.equal(sixtyFive.sets.length,0);
  passed.push('64 references allowed / 65 rejected');
  await isolated('65 real SQL receipt references fail closed',async()=>{
    db.prepare('DELETE FROM activity_measured_receipts WHERE user_id=?').run(f.owner);
    for(let i=0;i<65;i++) {
      const id=`overflow-${i}`;
      const physicalRow={id,user_id:f.owner,started_at:'2026-09-27T10:00:00Z',ended_at:'2026-09-27T11:00:00Z',
        total_seconds:3000,created_at:'2026-09-27T11:00:00Z'};
      insert('workout_sessions',physicalRow);
      const binding={version:receipts.VERSION,activity_kind:'lift',activity_id:id,plan_id:`bounded-${i}`,plan_revision:1,
        session_id:`bounded-session-${i}`,session_revision:1,session_hash:'a'.repeat(64),expected_revision:0,completeness:'FAILED',work_intervals:[]};
      const payload={version:receipts.VERSION,binding,provenance:'OWNER_SCOPED_MANUAL_RECORDER',completeness:'FAILED',
        physical_hash:canonicalHash({row:physicalRow,sets:[]}),actual:{observed_at:physicalRow.ended_at,duration_s:3000,distance_m:null,work_duration_s:null,sets:null},supersedes_receipt_id:null};
      insert('activity_measured_receipts',{id,user_id:f.owner,activity_kind:'lift',activity_id:id,plan_id:binding.plan_id,
        session_id:binding.session_id,revision:1,payload_json:JSON.stringify(payload),content_hash:canonicalHash(payload),created_at:NOW});
    }
    const current=await acquire(f.owner); assert.equal(current.measured.usable.length,65);
    assert.equal(current.historical.sourceFailed,true); assert.equal(current.historical.sets.length,0);
  });
  await isolated('aggregate read budget',async()=>{
    // Individually bounded text, but its repeated storage representations exceed
    // the conservative aggregate UTF-8 read budget before any payload acquisition.
    const candidateId=`historical-accepted-candidate-${f.owner}`;
    const padding=JSON.stringify({plan_id:f.set.plan_id,padding:'x'.repeat(1500000)});
    db.prepare('UPDATE plan_generation_candidates SET candidate_plan_json=? WHERE id=? AND user_id=?')
      .run(padding,candidateId,f.owner);
    db.prepare('UPDATE training_plans SET plan_data=?,plan_json=? WHERE id=? AND user_id=?').run(padding,padding,f.set.plan_id,f.owner);
    const current=await acquire(f.owner); assert.equal(current.historical.sourceFailed,true); assert.equal(current.historical.sets.length,0);
  });
  // Repository PostgreSQL contract style: JSONB object rows and positional SQL.
  // Execute identical portable SQL in SQLite; this is NOT a PostgreSQL server run.
  const sqlCalls=[];
  const pgShape={all:async(sql,params)=>{
    let n=0; const positional=sql.replace(/\?/g,()=>`$${++n}`);
    assert.equal(n,params.length); sqlCalls.push(positional);
    return (await tx.all(sql,params)).map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>
      [k,k.endsWith('_json')||k==='storage_plan_data' ? (typeof v==='string'?JSON.parse(v):v) : v])));
  }};
  const pg=await history.loadHistoricalEvidence({tx:pgShape,userId:f.owner,receipts:loaded.measured,observationInstant:NOW});
  assert.equal(pg.sourceFailed,false); assert.deepEqual(pg.sets,loaded.historical.sets);
  assert.ok(sqlCalls.every(sql=>sql.includes('candidate.user_id=$')&&sql.includes('storage.user_id=assignment.user_id')));
  assert.ok(sqlCalls.every(sql=>!sql.includes('json_extract')&&!sql.includes('pg_column_size')));
  passed.push('portable SQL / PostgreSQL JSONB shape and placeholder contract');
}
async function transactionNegatives(f,req,mutations) {
  DATE='2026-10-06'; NOW=`${DATE}T12:00:00Z`;
  observeRecentWeek(f.owner,'stale');
  // Separate honest low-frequency replacement request after prior occupancy.
  const request={...req,planning_date_local:DATE,target:{...req.target,runDaysPerWeek:2,liftDaysPerWeek:2}};
  const candidate=await plans.previewPlanForUser(f.owner,request,options('on'));
  const planRevision=db.prepare('SELECT planning_input_revision FROM users WHERE id=?').get(f.owner).planning_input_revision;
  const mutators=[
    ...mutations.filter(([name])=>['artifact hash','missing artifact','selected hash','missing applied link','assignment revision','reconstructed bytes','candidate plan bytes'].includes(name)),
    ['delete historical candidate',()=>db.prepare('DELETE FROM plan_generation_candidates WHERE id=? AND user_id=?').run(`historical-accepted-candidate-${f.owner}`,f.owner)],
    ['delete historical assignment',()=>db.prepare('DELETE FROM user_plans WHERE id=? AND user_id=?').run(f.accepted.assignment,f.owner)],
    ['delete historical plan',()=>db.prepare('DELETE FROM training_plans WHERE id=? AND user_id=?').run(f.set.plan_id,f.owner)],
    ['edit receipt',()=>db.prepare("UPDATE activity_measured_receipts SET created_at='2026-09-21T12:00:00Z' WHERE user_id=? AND activity_kind='run'").run(f.owner)],
    ['delete receipt',()=>db.prepare("DELETE FROM activity_measured_receipts WHERE user_id=? AND activity_kind='lift'").run(f.owner)],
    ['edit workout set',()=>db.prepare('UPDATE workout_sets SET reps=9 WHERE id=? AND user_id=?').run(`${f.owner}-Bench press-1`,f.owner)],
    ['delete workout set',()=>db.prepare('DELETE FROM workout_sets WHERE id=? AND user_id=?').run(`${f.owner}-Bench press-1`,f.owner)],
    ['edit physical',()=>db.prepare('UPDATE runs SET duration_seconds=400 WHERE id=? AND user_id=?').run(f.bodies[0].activity_id,f.owner)],
    ['delete physical',()=>db.prepare('DELETE FROM runs WHERE id=? AND user_id=?').run(f.bodies[0].activity_id,f.owner)],
  ];
  for(const [label,mutate] of mutators) {
    // Hooks execute INSIDE actual route transactions. Restore fixture rows after
    // each test without wrapping the route in an incompatible nested BEGIN.
    const saved=snapshot(); let expected, fired=false, transactions=0;
    const restore=()=>{
      hooks.before=null; hooks.beforeTransaction=null;
      restoreSnapshot(saved);
    };
    const inject=()=>{ if(!fired){fired=true;mutate();expected=snapshot();} };
    try {
      const callStart=fixture.calls.length;
      hooks.beforeTransaction=()=>{transactions++;};
      hooks.before=()=>{if(transactions===2)inject();};
      await assert.rejects(plans.previewPlanForUser(f.owner,request,options('on')),e=>e.code==='CANDIDATE_STALE');
      assert.equal(fixture.calls.slice(callStart).filter(c=>c.method==='run').length,0,`${label}: preview zero write statements`);
      assert.equal(fired,true,label); assert.deepEqual(snapshot(),saved,`${label}: preview rollback including injected mutation`);
    } finally { restore(); }
    fired=false; expected=null;
    try {
      const callStart=fixture.calls.length;
      hooks.before=()=>inject();
      const denied=await plans.applyPlanCandidate(f.owner,candidate.id,bodyFor(candidate),options('on'));
      assert.equal(fired,true,label); assert.equal(denied.status,409,`${label}: ${JSON.stringify(denied)}`);
      assert.equal(fixture.calls.slice(callStart).filter(c=>c.method==='run').length,0,`${label}: apply zero write statements`);
      assert.deepEqual(snapshot(),expected,`${label}: stale apply adds zero writes`);
      assert.equal(db.prepare('SELECT planning_input_revision FROM users WHERE id=?').get(f.owner).planning_input_revision,planRevision);
    } finally { restore(); }
    passed.push(`transaction stale preview/apply: ${label}`);
    console.log(`history: stale transaction verified: ${label}`);
  }
}

function observeRecentWeek(owner,label) {
  for(let day=1;day<=6;day++) {
    const date=addDays(DATE,-day);
    db.prepare(`INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds,created_at) VALUES (?,?,?,'easy',3.2,2200,?)`)
      .run(`${label}-${day}`,owner,date,`${date}T12:00:00Z`);
  }
}
