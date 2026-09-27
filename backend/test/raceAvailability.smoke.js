// Mounted local HTTP handler and real SQLite/solver; synthetic accepted history.
const assert = require('node:assert/strict');
// Race-goal rollback claims must stay within one sentence; active-plan copy is truthful.
const falseRaceGoalRollback = /\brace goal\b[^.!?\r\n]*\b(?:not changed|unchanged|rolled back)\b/i;
for (const boundary of ['. ', '! ', '? ', '\n']) {
 assert.doesNotMatch(`This is not a finding that your race goal is impossible${boundary}Your active plan was not changed.`,falseRaceGoalRollback);
}
for (const copy of ['Your race goal was not changed.', 'Your race goal remains unchanged.', 'Your race goal was rolled back.', 'YOUR RACE GOAL was saved, then rolled back.']) {
 assert.match(copy,falseRaceGoalRollback);
}
const f = require('./raceAvailabilityApply.smoke');
async function main() {
 const {owner,req} = await f.armyFixture({completeCoverage:process.argv.includes('--complete-coverage')});
 async function rejected(body,reason,opts=f.options('on')) {
  const before=f.snapshot();
  await assert.rejects(f.plans.previewPlanForUser(owner,body,opts),e=>{
   assert.equal(e.status,409);assert.equal(e.details.reason_code,reason);
   assert.equal((e.message.match(/Your active plan was not changed\./g)||[]).length,1);return true;
  });
  assert.deepEqual(f.snapshot(),before);
 }
 const firstOwner='66666666-6666-4666-8666-000000000001';
 f.db.prepare("INSERT INTO users(id,name,email,password_hash,timezone) VALUES (?,'First setup','first@example.invalid','','America/New_York')").run(firstOwner);
 f.db.prepare("INSERT INTO race_events(id,user_id,race_name,race_date,event_local_date,distance_miles,event_kind) VALUES ('first-army',?,'Army 10-Miler','2026-10-11','2026-10-11',10,'run_race')").run(firstOwner);
 const firstBefore=f.snapshot();
 await assert.rejects(f.plans.previewPlanForUser(firstOwner,{...req,race_ids:['first-army']},f.options('on')),e=>e.details?.reason_code==='CANONICAL_STRENGTH_LINK_ABSENT');
 assert.deepEqual(f.snapshot(),firstBefore);
 for(const mode of ['on','preview']) await rejected(req,process.argv.includes('--complete-coverage')?'REQUIRED_EXPOSURE_UNPLACEABLE':'MEANINGFUL_DOSE_REQUIRED',f.options(mode));
 await assert.rejects(f.plans.previewPlanForUser(owner,{...req,target:{...req.target,runDaysPerWeek:3}},f.options('on')),e=>{
  assert.equal(e.details.reason_code,process.argv.includes('--complete-coverage')?'REQUIRED_EXPOSURE_UNPLACEABLE':'MEANINGFUL_DOSE_REQUIRED');
  assert.match(e.message,/Your active plan was not changed/);assert.doesNotMatch(e.message,/four runs and four lifts/);return true;
 });
 const weekly={...req,race_ids:[]};
 if(process.argv.includes('--complete-coverage')) {
  // SHADOW retains its original control path and computes the real race solver.
  const off=await f.plans.previewPlanForUser(owner,req,{...f.options('off'),store:false});
  const shadow=await f.plans.previewPlanForUser(owner,req,{...f.options('shadow'),store:false});
  assert.deepEqual(shadow.plan,off.plan);assert.equal(shadow.candidateHash,off.candidateHash);
  const {prepared,result}=f.observed();
  assert.equal(prepared.source_support.source_limited,false);
  assert.equal(result.decision.phase,'DEVELOPMENT');
  const adapter=require('../src/lib/adaptiveCoachingPreview');
  assert.throws(()=>adapter.build({prepared,result}),e=>adapter.publicGenerationFailure(e)?.reason_code==='REQUIRED_EXPOSURE_UNPLACEABLE');
  console.log('complete coverage real SHADOW solver rejection and closed explanation passed');return;
 }
 const receipts=f.db.prepare("SELECT * FROM activity_measured_receipts WHERE user_id=? AND activity_kind='lift'").all(owner);
 f.db.prepare("DELETE FROM activity_measured_receipts WHERE user_id=? AND activity_kind='lift'").run(owner);
 await rejected(req,'CANONICAL_STRENGTH_LINK_ABSENT');
 await rejected(weekly,'CANONICAL_STRENGTH_LINK_ABSENT');
 for(const row of receipts) f.db.prepare('INSERT INTO activity_measured_receipts ('+Object.keys(row).join(',')+') VALUES ('+Object.keys(row).map(()=>'?').join(',')+')').run(...Object.values(row));
 await rejected({...weekly,target:{...weekly.target,maxSessionMinutes:5}},'MEANINGFUL_DOSE_REQUIRED');
 // Existing pool and ownership errors precede capability errors.
 for(const [modality,target] of [['run',{trainingDays:['Tue','Thu']}],['lift',{liftEligibleWeekdays:['Mon','Wed']}]]) {
  await assert.rejects(f.plans.previewPlanForUser(owner,{...req,target:{...req.target,...target}},f.options('on')),e=>{
   assert.equal(e.code,'MODALITY_AVAILABILITY_INSUFFICIENT');assert.equal(e.details.modality,modality);
   assert.equal(e.details.requested,4);assert.equal(e.details.available,2);return true;
  });
 }
 await assert.rejects(f.plans.previewPlanForUser(owner,{...req,race_ids:['foreign']},f.options('on')),e=>e.code==='RACE_NOT_FOUND');
 f.db.prepare("UPDATE race_events SET event_local_date='bad' WHERE id='army' AND user_id=?").run(owner);
 await assert.rejects(f.plans.previewPlanForUser(owner,req,f.options('on')),e=>e.code==='INVALID_RACE_DATE');
 f.db.prepare("UPDATE race_events SET event_local_date='2026-09-27' WHERE id='army' AND user_id=?").run(owner);
 await rejected({...req,target:{...req.target,raceDate:'2026-09-20'}},'MEANINGFUL_DOSE_REQUIRED');
 assert.equal(f.observed().prepared.calendarWindow.end_date,'2026-09-27');
 // +6 uses owned local date even when race_date is later; capability alone is not success.
 f.db.prepare("UPDATE race_events SET event_local_date='2026-09-26' WHERE id='army' AND user_id=?").run(owner);
 const beforeBoundary=f.snapshot();
 try {
  const candidate=await f.plans.previewPlanForUser(owner,req,{...f.options('on'),store:false});
  assert.equal(candidate.surfaceManifest.sessions.filter(s=>s.workout_family==='race' && s.event_identity?.race_id==='army' && s.scheduled_local_date==='2026-09-26').length,1);
 } catch(e) {
  assert.equal(e.code,'GOAL_BACKWARD_GENERATION_FAILED');
  assert.notEqual(e.details.reason_code,'RACE_CALENDAR_HORIZON_UNSUPPORTED');
  assert.ok(['EVENT_EXECUTION_MATERIAL_REQUIRED','REQUIRED_EXPOSURE_UNPLACEABLE','MEANINGFUL_DOSE_REQUIRED','OBSERVED_FAMILY_DOSE_UNAVAILABLE','MEASURED_RUN_WORK_SOURCE_ABSENT'].includes(e.details.reason_code),e.details.reason_code);
 }
 assert.deepEqual(f.snapshot(),beforeBoundary);
 // A selected event that the planner omits must not become a weekly success.
 f.db.prepare("UPDATE race_events SET status='cancelled' WHERE id='army' AND user_id=?").run(owner);
 await rejected(req,'EVENT_EXECUTION_MATERIAL_REQUIRED');
 f.db.prepare("UPDATE race_events SET status='upcoming' WHERE id='army' AND user_id=?").run(owner);
 f.db.prepare("UPDATE race_events SET event_local_date='2026-10-11' WHERE id='army' AND user_id=?").run(owner);
 f.db.prepare(`INSERT INTO race_events(id,user_id,race_name,race_date,event_local_date,event_timezone,distance_miles,event_kind) VALUES ('later',?,'Synthetic later race','2026-11-01','2026-11-02','America/New_York',10,'run_race')`).run(owner);
 await assert.rejects(f.plans.previewPlanForUser(owner,{...req,race_ids:['later','army']},f.options('on')),e=>e.details?.requested_end_date==='2026-11-02');
 // Known server preparation errors are closed explanations, unknown text is never returned.
 for(const code of ['SOURCE_UNAVAILABLE','SOURCE_STALE','SOURCE_CORRUPT','ACCEPTED_SOURCE_UNAVAILABLE','OCCUPANCY_UNAVAILABLE','unknown private text']) {
  const shadow=require('../src/lib/adaptiveCoachingShadow'),real=shadow.prepare;
  shadow.prepare=()=>{throw Object.assign(new Error('private payload'),{code});};
  try {await assert.rejects(f.plans.previewPlanForUser(owner,weekly,f.options('on')),e=>{
   assert.equal(e.details.reason_code,code==='unknown private text'?'CANDIDATE_NOT_SELECTED':code);
   assert.doesNotMatch(e.message,/private/);assert.doesNotMatch(e.message,falseRaceGoalRollback);return true;
  });} finally {shadow.prepare=real;}
 }
 const express=require('express'),app=express();app.use(express.json());
 // Authentication and runtime policy are test injected; handler, loading and solver are real.
 app.post('/api/plans/generate-for-races',(request,response,next)=>{request.user={id:owner};next();},
  async (request,response,next)=>{
   const before=f.snapshot();
   try {
    await f.plans.buildGenerateForRacesHandler((id,body)=>f.plans.previewPlanForUser(id,body,f.options('on')))(request,response);
    assert.deepEqual(f.snapshot(),before,'HTTP preview preserves all fixture rows');
   } catch(error) {next(error);}
  });
 console.log('direct real route: horizon, pools, source/time negatives and boundaries passed');
 const server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));s.once('error',reject);});
 const url=`http://127.0.0.1:${server.address().port}/api/plans/generate-for-races`;
 if(process.argv.includes('--serve')) {
  process.send?.({url,owner});
  await new Promise(resolve=>process.once('message',async message=>{
   if(message==='stop') {server.close(resolve);}
  }));
 } else {
  try {
   for(const source of ['supported','absent']) {
    if(source==='absent') f.db.prepare("DELETE FROM activity_measured_receipts WHERE user_id=? AND activity_kind='lift'").run(owner);
    const before=f.snapshot();
    const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(req)});
    assert.equal(response.status,409);const body=await response.json();
    assert.equal(body.code,'GOAL_BACKWARD_GENERATION_FAILED');
    assert.deepEqual(body.details,{reason_code:source==='supported'?'MEANINGFUL_DOSE_REQUIRED':'CANONICAL_STRENGTH_LINK_ABSENT'});
    assert.match(body.error,source==='supported'?/minimum useful duration/:/completed strength work/);assert.doesNotMatch(body.error,falseRaceGoalRollback);
    assert.equal((body.error.match(/Your active plan was not changed\./g)||[]).length,1);
    assert.deepEqual(f.snapshot(),before);
   }
  } finally {await new Promise(resolve=>server.close(resolve));}
 }
 console.log('race availability real route/HTTP, owned dates, boundaries, source and pool regressions passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(f.close);
