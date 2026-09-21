// Actual SQLite recording -> accepted-source auth -> shared snapshot -> route.
const assert = require('node:assert/strict');
const { createDb } = require('./helpers/adaptiveShadowDb');
const fixture = createDb(), { db, tx, hooks } = fixture;
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fixture.exports };
const RealDate = Date, DATE = '2026-09-20', NOW = `${DATE}T12:00:00Z`;
global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return RealDate.parse(NOW); } };
const shadow = require('../src/lib/adaptiveCoachingShadow');
const realPrepare = shadow.prepare, realCompute = shadow.compute;
let prepared, result, computations = 0;
shadow.prepare = a => { prepared = realPrepare(a); return prepared; };
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
  return { owner,accepted,set,bodies,req };
}

// Synthetic accepted history; physical actuals are independently measured.
async function armyFixture({ completeCoverage = false } = {}) {
 const f = await setup('55555555-5555-4555-8555-000000000001','ESTABLISHED',4,4);
 for (const input of f.bodies) await plans.recordActivityMeasurement(f.owner,input);
 const pages=Array.from({length:4},(_,week)=>Array.from({length:6},(_,day)=>{
  const date=addDays(DATE,-34+week*7+day);
  return {activityId:10000+week*10+day,startTimeGMT:date+'T08:00:00',startTimeLocal:date+'T08:00:00',activityType:{typeKey:'running'},distance:day===1?9200:day===2?5300:5000,duration:day===1?4000:day===2?2300:2200};
 })).flat();
 await require('../src/db/migrate').ensureProviderImportReceipts(sql=>db.exec(sql),'sqlite');
 assert.equal((await require('../src/lib/providerImportCoverage').sync({userId:f.owner,client:{getActivities:async offset=>offset===0?pages:[]},ingest:require('../src/routes/watchSync').ingestActivity,toPayload:require('../src/routes/garmin')._coverageTest.toIngestPayload,mutation:fixture.exports.withPlanningInputMutation,now:NOW})).status,'COMPLETE');
 // UNKNOWN coverage is deliberate; the complete-coverage negative is tested separately.
 if (!completeCoverage) db.prepare('DELETE FROM provider_import_receipts WHERE user_id=?').run(f.owner);
 db.prepare("UPDATE users SET timezone='America/New_York' WHERE id=?").run(f.owner);
 db.exec('ALTER TABLE race_events ADD COLUMN elevation_gain_ft REAL');
 db.exec('ALTER TABLE race_events ADD COLUMN terrain TEXT');
 db.prepare(`INSERT INTO race_events(id,user_id,race_name,race_date,event_local_date,event_timezone,distance_miles,goal_time_seconds,event_kind,location,elevation_gain_ft,terrain) VALUES ('army',?,'Army 10-Miler','2026-10-11','2026-10-11','America/New_York',10,5400,'run_race','Washington, DC',190,'road')`).run(f.owner);
 f.req = {...f.req,planning_timezone:'America/New_York',timezone_offset_minutes:240,race_ids:['army'],target:{...f.req.target,trainingDays:['Tue','Thu','Sat','Sun'],strengthGoal:'maintain',equipment:['barbell','dumbbell','rack','bench','cable','machines']}};
 return f;
}
const snapshot = () => Object.fromEntries(['users','runs','lifts','workout_sessions','workout_sets','race_events','training_plans','user_plans','activity_measured_receipts','plan_generation_candidates','planning_pipeline_artifacts'].map(t=>[t,db.prepare('SELECT * FROM '+t+' ORDER BY id').all()]));
function close() { global.Date=RealDate; shadow.prepare=realPrepare; shadow.compute=realCompute; db.close(); }
module.exports={armyFixture,db,tx,hooks,plans,options,DATE,NOW,snapshot,close,observed:()=>({prepared,result})};

async function main() {
 const f=await armyFixture(), weekly={...f.req,race_ids:[]};
 const on=await plans.previewPlanForUser(f.owner,weekly,options('on'));
 const sessions=on.surfaceManifest.sessions;
 for (const [kind,pool] of [['run',weekly.target.trainingDays],['lift',weekly.target.liftEligibleWeekdays]]) {
  assert.equal(sessions.filter(s=>s.kind===kind).length,4);
  for(const s of sessions.filter(s=>s.kind===kind)) {
   assert.ok(pool.includes(new Intl.DateTimeFormat('en-US',{weekday:'short',timeZone:'UTC'}).format(new Date(s.scheduled_local_date+'T12:00:00Z'))));
   assert.ok(Date.parse(s.scheduled_start_at)>=Date.parse(NOW));
   assert.ok(s.derived_totals.duration_s >= (kind==='run'?1200:600));
   if(kind==='lift') assert.ok(s.derived_totals.sets>=4);
  }
 }
 assert.equal(prepared.source_support.source_limited,false);
 assert.deepEqual(prepared.foundation.athlete_state.adaptive_foundation.capacities,{run:4,lift:4});
 assert.equal(new Set(prepared.availability.lift.map(w=>w.start_at.slice(0,10))).size,7);
 assert.ok(result.selected_candidate.validation.valid);
 assert.equal(on.plan.overall_feasibility,'unvalidated');
 const again=await plans.previewPlanForUser(f.owner,weekly,{...options('on'),store:false});
 assert.equal(again.candidateHash,on.candidateHash); assert.deepEqual(again.plan,on.plan);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM planning_pipeline_artifacts WHERE plan_generation_candidate_id=?').get(on.id).n,7);
 const applyBody={...on.applyBindings,candidate_hash:on.candidateHash,choice:'train_for_target',planning_date_local:DATE};
 const before=snapshot();
 for (const [owner,body,opts,code] of [
  ['55555555-5555-4555-8555-000000000002',applyBody,options('on'),'CANDIDATE_NOT_FOUND'],
  [f.owner,{...applyBody,athlete_state_revision:applyBody.athlete_state_revision+1},options('on'),'ATHLETE_STATE_REVISION_CHANGED'],
  ...['off','shadow','preview'].map(mode=>[f.owner,applyBody,options(mode),'GOAL_BACKWARD_MODE_UNAVAILABLE']),
  [f.owner,applyBody,{goalBackwardDependencies:{mode:'on',audience:'cohort',cohortRefs:[]}},'GOAL_BACKWARD_MODE_UNAVAILABLE'],
 ]) {
  assert.equal((await plans.applyPlanCandidate(owner,on.id,body,opts)).code,code);
  assert.deepEqual(snapshot(),before);
 }
 // Model a pending pre-repair seven-day candidate carrying a later race request.
 // Its authentic weekly artifacts are untouched; it must fail before recomputation.
 const stored=db.prepare('SELECT planning_snapshot_json FROM plan_generation_candidates WHERE id=?').get(on.id).planning_snapshot_json;
 const legacy=JSON.parse(stored);legacy.request.race_ids=['army'];
 db.prepare('UPDATE plan_generation_candidates SET planning_snapshot_json=? WHERE id=? AND user_id=?').run(JSON.stringify(legacy),on.id,f.owner);
 const legacyBefore=snapshot(), computationsBefore=computations;
 assert.equal((await plans.applyPlanCandidate(f.owner,on.id,applyBody,options('on'))).details.reason_code,'CANDIDATE_WINDOW_STALE');
 assert.equal(computations,computationsBefore);assert.deepEqual(snapshot(),legacyBefore);
 assert.equal((await plans.applyPlanCandidate(f.owner,on.id,{...applyBody,athlete_state_revision:99},options('on'))).code,'ATHLETE_STATE_REVISION_CHANGED');
 db.prepare('UPDATE plan_generation_candidates SET planning_snapshot_json=? WHERE id=? AND user_id=?').run(stored,on.id,f.owner);
 // Changed physical actuals invalidate apply; restore exact bytes after the negative.
 const physical=db.prepare('SELECT duration_seconds FROM runs WHERE id=?').get(`run-${f.owner}-0`);
 db.prepare('UPDATE runs SET duration_seconds=2100 WHERE id=? AND user_id=?').run(`run-${f.owner}-0`,f.owner);
 const changed=snapshot();assert.notEqual((await plans.applyPlanCandidate(f.owner,on.id,applyBody,options('on'))).status,200);assert.deepEqual(snapshot(),changed);
 db.prepare('UPDATE runs SET duration_seconds=? WHERE id=? AND user_id=?').run(physical.duration_seconds,`run-${f.owner}-0`,f.owner);
 hooks.before=(method,sql)=>{if(method==='run'&&sql.includes('INSERT INTO user_plans'))throw Error('synthetic assignment fault');};
 await assert.rejects(plans.applyPlanCandidate(f.owner,on.id,applyBody,options('on')),/synthetic assignment fault/);
 hooks.before=null; assert.deepEqual(snapshot(),before);
 const applied=await plans.applyPlanCandidate(f.owner,on.id,applyBody,options('on'));assert.equal(applied.status,200,JSON.stringify(applied));
 const active=await tx.get(`SELECT up.*,up.id AS user_plan_id,tp.plan_json FROM user_plans up JOIN training_plans tp ON tp.id=up.plan_id WHERE up.user_id=? AND up.status='active'`,[f.owner]);
 assert.deepEqual(JSON.parse(active.plan_json),on.plan);
 const manifest=await plans.canonicalSurfaceManifestForActive(f.owner,active,tx.get);
 assert.equal(manifest.status,'accepted');assert.deepEqual(manifest.sessions,sessions);
 assert.equal(db.prepare("SELECT COUNT(*) n FROM user_plans WHERE user_id=? AND status='active'").get(f.owner).n,1);
 const after=snapshot();assert.equal((await plans.applyPlanCandidate(f.owner,on.id,applyBody,options('on'))).replay,true);assert.deepEqual(snapshot(),after);
 // Already-applied replay still precedes the new capability check.
 db.prepare('UPDATE plan_generation_candidates SET planning_snapshot_json=? WHERE id=? AND user_id=?').run(JSON.stringify(legacy),on.id,f.owner);
 const oldApplied=snapshot();
 assert.equal((await plans.applyPlanCandidate(f.owner,on.id,applyBody,options('on'))).replay,true);
 assert.deepEqual(snapshot(),oldApplied);
 db.prepare('UPDATE plan_generation_candidates SET planning_snapshot_json=? WHERE id=? AND user_id=?').run(stored,on.id,f.owner);
 await assert.rejects(plans.previewPlanForUser(f.owner,weekly,options('on')),e=>e.details?.reason_code==='CANONICAL_STRENGTH_LINK_ABSENT');
 assert.deepEqual(snapshot(),after);
 console.log('race availability weekly real 4+4 apply, guards, rollback, replay passed; post-replacement source limitation retained');
}
if(require.main===module) main().catch(e=>{console.error(e);process.exitCode=1;}).finally(close);
