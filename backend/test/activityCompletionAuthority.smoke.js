const assert = require('node:assert/strict');
const { buildCompletionSummaryForAdaptation } = require('../src/routes/plans')._test;
const { createMissedOutcome, outcomeKey } = require('../src/lib/missedSessionOutcome');
const run = {id:'run-1',session_id:'run-1',kind:'run',type:'easy',workout_family:'easy_run',derived_totals:{duration_s:1200}};
const lift = {id:'lift-1',session_id:'lift-1',kind:'lift',type:'strength'};
const plan = {schemaVersion:2,programContract:{timezone:'America/New_York'},weeks:[{days:[{date:'2026-09-09',sessions:[run,lift]}]}]};
const row = {id:'plan',plan_id:'plan',user_plan_id:'assignment',plan_version:1};
async function summary(progress={}, runs=[], lifts=[]) {
  return buildCompletionSummaryForAdaptation('own',plan,{row:{...row,progress_json:progress}},'2026-09-10',{
    get:async()=>null,
    all:async sql=>/FROM runs/.test(sql)?runs:/FROM lifts/.test(sql)?lifts:[],
  });
}
async function main() {
  const unknown = await summary();
  assert.equal(unknown.planned,2); assert.equal(unknown.missedWorkouts,0);
  assert.equal(unknown.unconfirmedWorkouts,2); assert.equal(unknown.adherenceRate,null);
  const adHoc = await summary({},[{id:'manual',date:'2026-09-09',distance_miles:2,duration_seconds:1200,
    planned_session_json:{schemaVersion:1,planMatchMode:'explicit_none'}}],[{id:'sets',date:'2026-09-09',sets:3,reps:8}]);
  assert.equal(adHoc.completed,0); assert.equal(adHoc.missedWorkouts,0);
  assert.equal(adHoc.unconfirmedWorkouts,2,'Unlinked activity is not completion or a missed confession');
  assert.notEqual(adHoc.activityEvidenceHash,unknown.activityEvidenceHash);
  const record = createMissedOutcome({ownerId:'own',active:row,session:{sessionId:'run-1',contentHash:'hash',date:'2026-09-09'},
    planningDate:'2026-09-10',timezone:'America/New_York',reason:'no_time'});
  const confirmed = await summary({missedSessionOutcomes:{[outcomeKey('2026-09-09','run-1')]:record}});
  assert.equal(confirmed.missedRuns,1); assert.equal(confirmed.missedLifts,0);
  assert.equal(confirmed.unconfirmedWorkouts,1); assert.equal(confirmed.adherenceRate,0);
  const explicit = await summary({completedSessionIds:['lift-1']});
  assert.equal(explicit.completed,1); assert.equal(explicit.missedWorkouts,0);
  const foreign = await summary({missedSessionOutcomes:{[outcomeKey('2026-09-09','run-1')]:{...record,user_id:'foreign'}}});
  assert.equal(foreign.missedWorkouts,0);
  console.log('activity completion vs confirmed missed vs unknown smoke: PASS');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
