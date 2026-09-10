// Reuse the existing guarded disposable PostgreSQL + real HTTP program setup.
// The insertion runs after actual preview/apply/reload, before optional lifecycle
// branches. No router/database implementation is mocked or replaced.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
// Clock isolation belongs exclusively to this executable test process. It
// advances with real elapsed time; no production environment/validation bypass.
const SystemDate = Date;
const realStart = SystemDate.now();
let fixtureStart = SystemDate.parse('2026-09-10T16:00:00.000Z');
global.Date = class ActivityFixtureDate extends SystemDate {
  constructor(...args) { super(...(args.length ? args : [fixtureStart + SystemDate.now() - realStart])); }
  static now() { return fixtureStart + SystemDate.now() - realStart; }
  static advanceFixtureDays(days) { fixtureStart += days * 86400000; }
};
const file = path.join(__dirname, 'programPersistence.integration.js');
const marker = "  if (process.env.PROGRAM_TEST_REMOVAL === '1') {";
let source = fs.readFileSync(file, 'utf8');
const routers = "['auth','races','runs','plans','workouts']";
if (!source.includes(routers)) throw new Error('Guarded real-router registration changed');
source = source.replace(routers, "['auth','races','runs','plans','workouts','import','injury']");
if (process.env.PROGRAM_TEST_ACTIVITY_SCENARIO === 'recovery') {
  // Same real API fixture path, with an independently specified 14-mile week
  // and a five-mile weekly long observation (not a rewritten canonical plan).
  source = source.replace("process.env.PROGRAM_TEST_HISTORY === 'endurance' ? 28 : 14", '14')
    .replace("process.env.PROGRAM_TEST_HISTORY === 'endurance' ? long ? 10 : 3", "process.env.PROGRAM_TEST_HISTORY === 'endurance' ? long ? 5 : 1.5");
}
if (source.split(marker).length !== 2) throw new Error('Guarded program harness insertion changed');
source = source.replace(marker, `
  if (process.env.PROGRAM_TEST_ACTIVITY_SCENARIO === 'injury_intensity') {
    const beforeBytes=JSON.stringify(current.data.plan.plan_data);
    const injury=await request('POST','/injury',{date:'2026-09-10',body_part:'shoulder',pain_level:6,
      notes:'Synthetic moderate upper-body injury; no clinical claim.'});
    assert.equal(injury.status,201,JSON.stringify(injury.data));
    const preview=await request('GET','/plans/adaptation/current?date=2026-09-10');
    assert.equal(preview.status,200,JSON.stringify(preview.data));
    const proposed=preview.data.proposal;
    assert.ok(proposed?.changes.length,JSON.stringify(preview.data));
    assert.equal(proposed.activityValidation.strength_withholding_capability.public_partial,'UNAVAILABLE_NO_COMPATIBLE_SET_ONLY_INTENT');
    const lifts=proposed.changes.filter(change=>change.before.kind==='lift');
    assert.ok(lifts.length,'The generated upper-body injury path is genuinely exercised');
    const originalMaxima=lifts.flatMap(change=>change.before.steps.map(step=>step.target.rpe_range.maximum));
    assert.ok(originalMaxima.every(maximum=>maximum>=7),'Original first-week6–7 or ordinary7–8 cannot satisfy injury5–6');
    if(process.env.PROGRAM_TEST_RECOVERY==='LOW') assert.ok(originalMaxima.includes(7));
    else assert.ok(originalMaxima.includes(8));
    for(const change of lifts) {
      assert.equal(change.after.workout_family,'rest'); assert.deepEqual(change.after.steps,[]);
      assert.ok(change.after.strength_withholding.allocations.every(item=>item.retained_sets===0&&item.withheld_sets===item.original_sets));
    }
    const unaccepted=await request('GET','/plans/current');
    assert.equal(JSON.stringify(unaccepted.data.plan.plan_data),beforeBytes,'Injury preview does not write the accepted prescription');
    const body={planning_date:proposed.planningDate,proposal_revision:proposed.revision,
      proposal_plan_version:proposed.planVersion,preview_fingerprint:proposed.previewFingerprint,observation_ticket:proposed.observationTicket};
    const accepted=await request('POST','/plans/adaptation/preview/accept',body);
    assert.equal(accepted.status,200,JSON.stringify(accepted.data));
    const replay=await request('POST','/plans/adaptation/preview/accept',body);
    assert.equal(replay.status,200,JSON.stringify(replay.data)); assert.equal(replay.data.idempotent,true);
    const after=await request('GET','/plans/current'),today=await request('GET','/plans/today?date=2026-09-10');
    assert.equal(after.status,200);assert.equal(after.data.surface_manifest.status,'accepted');
    assert.equal(today.status,200);assert.equal(today.data.surface_manifest.status,'accepted');
    for(const change of lifts) {
      const saved=after.data.surface_manifest.sessions.find(session=>session.session_id===change.sessionId);
      assert.equal(saved.workout_family,'rest');assert.deepEqual(saved.steps,[]);
    }
    const receiptPath='/tmp/'+databaseName+'-injury-intensity-accepted-program.json';
    require('node:fs').writeFileSync(receiptPath,JSON.stringify({parent:current.data,
      preview:{...proposed,observationTicket:undefined},applied:accepted.data,current:after.data,today:today.data}));
    console.log(JSON.stringify({gate:'high-rpe-injury-whole-withholding',status:'PASS',recovery:process.env.PROGRAM_TEST_RECOVERY||'NORMAL',
      originalMaxima,publicPartial:false,receiptPath}));
    return;
  }
  if (process.env.PROGRAM_TEST_ACTIVITY_SCENARIO === 'screenshots') {
    // Only de-identified physical screenshot fields. 2026 is a declared test
    // assumption; no effort, symptoms, zones, baseline, or ingestion is inferred.
    const rows=[{date:'2026-09-08',distance_miles:5.01,duration_seconds:3239,avg_heart_rate:150},
      {date:'2026-09-09',distance_miles:3.51,duration_seconds:2402,avg_heart_rate:149}];
    const ids=[];
    for(const row of rows) {
      const saved=await request('POST','/runs',{...row,type:'run',plan_session_id:null});
      assert.equal(saved.status,201,JSON.stringify(saved.data)); ids.push(saved.data.run.id);
    }
    const observe=async()=>{
      const active=await require('../src/routes/plans')._test.getActivePlanForUser(owner,null,{planningDateLocal:'2026-09-10'});
      return require('../src/routes/plans')._test.buildAdaptationInputs(owner,reloaded,active,'2026-09-10',{strictReads:true});
    };
    const manual=await observe();
    assert.equal(manual.activityPolicyInput.observationArtifact.current_week.known_distance_lower_bound_m,13712);
    assert.equal(manual.activityPolicyInput.observationArtifact.runs.length,2);
    assert.equal(manual.activityPolicyInput.observationArtifact.runs.reduce((sum,row)=>sum+row.duration_s.value,0),5641);
    assert.ok(manual.activityPolicyInput.observationArtifact.runs.every(row=>row.rpe.state==='UNKNOWN' && row.pain.state==='UNKNOWN' && row.energy.state==='UNKNOWN'));
    assert.equal(manual.activityPolicyInput.completedIds.length,0);
    for(const id of ids) assert.equal((await request('DELETE','/runs/'+id)).status,200);
    const deleted=await observe(); assert.equal(deleted.activityPolicyInput.observationArtifact.runs.length,0);
    assert.notEqual(deleted.activitySnapshot.fingerprint,manual.activitySnapshot.fingerprint);
    const imported=rows.map((row,index)=>({...row,type:'running',source:'apple_health',sourceWorkoutId:'synthetic-summary-'+index,
      startDate:index===0?'2026-09-08T13:07:00Z':'2026-09-09T12:24:00Z'}));
    const synced=await request('POST','/import/health',{workouts:imported});
    assert.equal(synced.status,200,JSON.stringify(synced.data)); assert.equal(synced.data.errors.length,0,JSON.stringify(synced.data));
    const firstImport=await observe();
    const replay=await request('POST','/import/health',{workouts:imported});
    assert.equal(replay.status,200); assert.equal(replay.data.errors.length,0);
    const replayed=await observe();
    assert.equal(replayed.activityPolicyInput.observationArtifact.runs.length,2,'Identity-proven replay does not add two more activities');
    assert.equal(replayed.activityPolicyInput.observationArtifact.current_week.known_distance_lower_bound_m,13712);
    assert.equal(replayed.activityPolicyInput.observationArtifact.runs.reduce((sum,row)=>sum+row.duration_s.value,0),5641);
    assert.ok(replayed.activityPolicyInput.observationArtifact.runs.every(row=>row.rpe.state==='UNKNOWN' && row.pain.state==='UNKNOWN' && row.energy.state==='UNKNOWN'));
    assert.equal(replayed.activityPolicyInput.completedIds.length,0);
    if(replayed.activitySnapshot.fingerprint!==firstImport.activitySnapshot.fingerprint) {
      const diagnosticPath='/tmp/'+databaseName+'-import-replay-diagnostic.json';
      require('node:fs').writeFileSync(diagnosticPath,JSON.stringify({first:firstImport,replayed}));
      console.log(JSON.stringify({gate:'import-replay-meaning-diagnostic',diagnosticPath}));
    }
    assert.equal(replayed.activitySnapshot.fingerprint,firstImport.activitySnapshot.fingerprint,'Exact replay does not change the coaching evidence meaning');
    console.log(JSON.stringify({gate:'screenshot-physical-real-http',status:'PASS',assumedYear:2026,distinctActivities:2,
      canonicalMeters:13712,durationSeconds:5641,unknownEffort:true,manualDeleteAndImportReplay:true}));
    return;
  }
  if (process.env.PROGRAM_TEST_ACTIVITY_SCENARIO === 'reconciliation') {
    const planBytes = async () => JSON.stringify(await db.dbGet('SELECT up.id,up.plan_version,tp.plan_json,tp.plan_data FROM user_plans up JOIN training_plans tp ON tp.id=up.plan_id WHERE up.user_id=? AND up.status=?',[owner,'active']));
    const allBytes = async () => JSON.stringify(await db.dbGet('SELECT up.id,up.plan_version,up.progress_json,u.planning_input_revision,tp.plan_json FROM user_plans up JOIN training_plans tp ON tp.id=up.plan_id JOIN users u ON u.id=up.user_id WHERE up.user_id=? AND up.status=?',[owner,'active']));
    const before = await planBytes();
    const url='/plans/reconciliation/current?date=2026-09-10&hour=21&timezone=America%2FNew_York';
    assert.equal((await request('GET',url)).data.reconciliation,null,'No activity does not imply completed paired run');
    const unlinked=await request('POST','/runs',{date:'2026-09-10',type:'easy',distance_miles:1,duration_seconds:600,plan_session_id:null});
    assert.equal(unlinked.status,201,JSON.stringify(unlinked.data));
    assert.equal((await request('GET',url)).data.reconciliation,null,'Explicit unlinked run cannot activate paired-lift reconciliation');
    const day=reloaded.weeks.flatMap(week=>week.days).find(day=>day.date==='2026-09-10');
    const run=day.sessions.find(session=>session.kind==='run'), lift=day.sessions.find(session=>session.kind==='lift');
    assert.ok(run && lift);
    const freshCalendar=await request('GET','/plans/current');
    const access=require('../src/routes/plans')._test.canonicalWorkoutStartAccess(freshCalendar.data.surface_manifest,
      freshCalendar.data.surface_manifest.sessions.find(session=>session.session_id===run.session_id));
    const marked=await request('PUT','/plans/my/progress',{completed_session_id:run.session_id,workout_start_access:access});
    assert.equal(marked.status,200,JSON.stringify(marked.data));
    const preview=await request('GET',url);
    assert.equal(preview.status,200,JSON.stringify(preview.data));
    const prompt=preview.data.reconciliation;
    assert.ok(prompt?.outcomeBinding,JSON.stringify(preview.data));
    const choice={session_date:prompt.sessionDate,lift_session_id:prompt.liftSessionId,response:'life_event',
      current_date:'2026-09-10',timezone:'America/New_York',outcome_binding:prompt.outcomeBinding};
    for (const patch of [{outcome_binding:{...prompt.outcomeBinding,owner_id:'foreign'}},
      {outcome_binding:{...prompt.outcomeBinding,assignment_id:'foreign'}},
      {outcome_binding:{...prompt.outcomeBinding,plan_revision:0}},
      {session_date:'2026-09-09'},{lift_session_id:'foreign'}]) {
      const unchanged=await allBytes();
      assert.equal((await request('POST','/plans/reconciliation/respond',{...choice,...patch})).status,409);
      assert.equal(await allBytes(),unchanged,'Rejected outcome preserves plan, progress and input revision');
    }
    const immutable=await request('PUT','/runs/'+unlinked.data.run.id,{distance_miles:1.1,duration_seconds:660});
    assert.equal(immutable.status,409); assert.equal(immutable.data.code,'EVIDENCE_IMMUTABLE');
    const edited=await request('POST','/runs/'+unlinked.data.run.id+'/evidence-corrections',
      {corrected_distance_m:1770,reason:'Synthetic attributed distance correction'});
    assert.equal(edited.status,201,JSON.stringify(edited.data));
    const staleBytes=await allBytes();
    assert.equal((await request('POST','/plans/reconciliation/respond',choice)).status,409,'Fresh activity invalidates old outcome preview');
    assert.equal(await allBytes(),staleBytes);
    const fresh=await request('GET',url);
    const freshChoice={...choice,outcome_binding:fresh.data.reconciliation.outcomeBinding};
    const saved=await request('POST','/plans/reconciliation/respond',freshChoice);
    assert.equal(saved.status,200,JSON.stringify(saved.data));
    assert.equal(saved.data.outcome,'recorded'); assert.equal(saved.data.plan_changed,false);
    assert.equal(saved.data.adjustment.adjusted,false); assert.ok(saved.data.record.outcomeBinding);
    assert.equal(await planBytes(),before,'No canonical workout is moved or rebuilt');
    const record=await db.dbGet('SELECT progress_json FROM user_plans WHERE user_id=? AND status=?',[owner,'active']);
    const progress=typeof record.progress_json==='string'?JSON.parse(record.progress_json):record.progress_json;
    assert.ok(!progress.completedSessionIds.includes(lift.session_id),'Life event never marks lift completed');
    const exact=await allBytes();
    const replay=await request('POST','/plans/reconciliation/respond',freshChoice);
    assert.equal(replay.status,200); assert.equal(replay.data.idempotent,true);
    assert.deepEqual(replay.data.record,saved.data.record); assert.equal(await allBytes(),exact);
    assert.equal((await request('POST','/plans/reconciliation/respond',{...freshChoice,response:'completed_untracked'})).status,409);
    assert.equal(await allBytes(),exact);
    assert.equal((await request('GET',url)).data.reconciliation,null,'Terminal outcome does not immediately prompt again');
    const after=await request('GET','/plans/current'); assert.equal(after.data.surface_manifest.status,'accepted');
    console.log(JSON.stringify({gate:'canonical-hybrid-outcome-real-http',status:'PASS',frequency,
      explicitOnly:true,acceptedPlanUnchanged:true,readback:true,replay:true,staleActivity:true}));
    return;
  }
  if (process.env.PROGRAM_TEST_ACTIVITY_SCENARIO === 'short_easy') {
    const snapshot = async () => JSON.stringify(await db.dbGet('SELECT up.plan_version,up.progress_json,tp.plan_json,tp.plan_data FROM user_plans up JOIN training_plans tp ON tp.id=up.plan_id WHERE up.user_id=? AND up.status=?',[owner,'active']));
    const before = await snapshot();
    for (let index=0;index<2;index++) {
      const run = await request('POST','/runs',{date:'2026-09-09',type:'easy',distance_miles:1,duration_seconds:600,
        perceived_effort:2,plan_session_id:null});
      assert.equal(run.status,201,JSON.stringify(run.data));
    }
    const assessed = await request('GET','/plans/adaptation/current?date=2026-09-10');
    assert.equal(assessed.status,200,JSON.stringify(assessed.data));
    assert.equal(assessed.data.proposal,null,'Two short easy runs yesterday must not mandate recovery/rest or claim completion');
    assert.equal(await snapshot(),before,'Automatic assessment cannot mutate accepted prescriptions');
    const refreshed = await request('GET','/plans/current');
    assert.equal(refreshed.data.surface_manifest.status,'accepted');
    console.log(JSON.stringify({gate:'two-short-easy-real-http',status:'PASS',frequency,acceptedUnchanged:true}));
    return;
  }
  if (['recovery','duration_only_recovery'].includes(process.env.PROGRAM_TEST_ACTIVITY_SCENARIO)) {
    const durationOnly=process.env.PROGRAM_TEST_ACTIVITY_SCENARIO==='duration_only_recovery';
    // The unknown-history program's Sunday is a legitimate 32-minute,
    // duration-only source. Its 70% recovery remains useful; reducing the
    // opening 20-minute run correctly produces rest below the existing floor.
    const planningDate=durationOnly?'2026-09-13':'2026-09-12';
    Date.advanceFixtureDays(durationOnly?3:2);
    const parentToday = await request('GET','/plans/today?date='+planningDate);
    assert.equal(parentToday.status,200,JSON.stringify(parentToday.data));
    assert.equal(parentToday.data.surface_manifest.status,'accepted');
    const logged = await request('POST','/runs',{date:durationOnly?'2026-09-12':'2026-09-11',type:'run',distance_miles:durationOnly?1:5,
      duration_seconds:durationOnly?600:4200,perceived_effort:8,plan_session_id:null});
    assert.equal(logged.status,201,JSON.stringify(logged.data));
    const impact=await request('GET','/plans/adaptation/run/'+logged.data.run.id+'?date='+planningDate);
    assert.equal(impact.status,200,JSON.stringify(impact.data));
    assert.equal(impact.data.impact.activityValidation.valid,true);
    assert.ok(!impact.data.impact.observationTicket,'Read-only per-run impact cannot supply an accept ticket');
    const afterImpact=await request('GET','/plans/current');
    assert.equal(JSON.stringify(afterImpact.data.plan.plan_data),JSON.stringify(current.data.plan.plan_data),
      'Per-run impact and current coaching assessment cannot write the accepted plan');
    const preview = await request('GET','/plans/adaptation/current?date='+planningDate);
    assert.equal(preview.status,200,JSON.stringify(preview.data));
    const proposed = preview.data.proposal;
    console.log(JSON.stringify({gate:'useful-recovery-preview',status:preview.status,proposal: proposed && {
      validation:proposed.activityValidation,changes:proposed.changes.map(change=>({date:change.date,
        from:change.before.workout_family,to:change.after.workout_family,duration_s:change.after.derived_totals?.duration_s}))}}));
    assert.ok(proposed?.changes.some(change=>(durationOnly || ['long_aerobic','threshold_run','race_rhythm_run','interval_run','assessment'].includes(change.before.workout_family))
      && change.after.workout_family==='recovery_run'
      && change.after.derived_totals.duration_s>=1200
      && (!durationOnly || !change.after.steps.some(step=>step.target?.distance_m!=null))),'A legitimate generated session must produce useful recovery without invented distance');
    const accepted = await request('POST','/plans/adaptation/preview/accept',{planning_date:proposed.planningDate,
      proposal_revision:proposed.revision,proposal_plan_version:proposed.planVersion,
      preview_fingerprint:proposed.previewFingerprint,observation_ticket:proposed.observationTicket});
    assert.equal(accepted.status,200,JSON.stringify(accepted.data));
    const replay = await request('POST','/plans/adaptation/preview/accept',{planning_date:proposed.planningDate,
      proposal_revision:proposed.revision,proposal_plan_version:proposed.planVersion,
      preview_fingerprint:proposed.previewFingerprint,observation_ticket:proposed.observationTicket});
    assert.equal(replay.status,200,JSON.stringify(replay.data));
    assert.equal(replay.data.idempotent,true);
    const settled = await request('GET','/plans/adaptation/current?date='+planningDate);
    assert.equal(settled.status,200,JSON.stringify(settled.data));
    assert.equal(settled.data.proposal,null,'Unchanged accepted recovery does not prompt again');
    const nextCurrent = await request('GET','/plans/current');
    const nextToday = await request('GET','/plans/today?date='+planningDate);
    assert.equal(nextCurrent.status,200,JSON.stringify(nextCurrent.data));
    assert.equal(nextToday.status,200,JSON.stringify(nextToday.data));
    assert.equal(nextCurrent.data.surface_manifest.status,'accepted');
    assert.equal(nextToday.data.surface_manifest.status,'accepted');
    assert.equal(nextToday.data.execution.run.workout_family,'recovery_run');
    if (durationOnly) {
      assert.equal(nextToday.data.execution.lift.workout_family,'strength_upper',
        'Recent running protection does not invent an upper-body withholding rule');
      assert.deepEqual(nextToday.data.execution.lift.steps,parentToday.data.execution.lift.steps,
        'Unaffected upper prescription remains executable and exact');
    } else assert.equal(nextToday.data.execution.lift,null,'Withheld lower lifting is not executable on Today');
    assert.ok(nextCurrent.data.surface_manifest.sessions.some(session=>session.workout_family==='recovery_run' && session.activity_reduction));
    const receiptPath='/tmp/'+databaseName+(durationOnly?'-duration-only-recovery-accepted-program.json':'-useful-recovery-accepted-program.json');
    require('node:fs').writeFileSync(receiptPath,JSON.stringify({parent:current.data,parent_today:parentToday.data,
      preview:{...proposed,observationTicket:undefined},applied:accepted.data,current:nextCurrent.data,today:nextToday.data}));
    console.log(JSON.stringify({gate:'useful-recovery-real-http',status:'PASS',frequency,receiptPath}));
    return;
  }
  {
    const clock = { planning_date_local:'2026-09-10',timezone_offset_minutes:240,planning_timezone:'America/New_York' };
    const query = new URLSearchParams(clock).toString();
    const acceptedBytes = async () => db.dbGet('SELECT up.id,up.plan_version,up.status,up.progress_json,tp.plan_json,tp.plan_data FROM user_plans up JOIN training_plans tp ON tp.id=up.plan_id WHERE up.user_id=? AND up.status=?',[owner,'active']);
    const stablePlan = row => JSON.stringify({id:row.id,version:row.plan_version,status:row.status,plan:row.plan_json,data:row.plan_data});
    const before = await acceptedBytes();
    const old = await request('POST','/runs/missed',{reason:'sick',scheduled_date:'2026-09-09'});
    assert.equal(old.status,400,'Old reason-only request must not falsely claim changes');
    const list = await request('GET','/plans/missed-sessions?'+query);
    assert.equal(list.status,200,JSON.stringify(list.data));
    const selected = list.data.sessions.find(item=>item.kind==='lift' && item.eligible);
    const selectedRun = list.data.sessions.find(item=>item.kind==='run' && item.eligible);
    assert.ok(selected && selectedRun,JSON.stringify(list.data));
    const assertNoLegacyMove = async (label, body, expectedStatus = 409) => {
      const prior = JSON.stringify(await acceptedBytes());
      const revision = await db.dbGet('SELECT planning_input_revision FROM users WHERE id=?',[owner]);
      const move = await request('POST','/plans/reschedule-missed',body);
      assert.equal(move.status,expectedStatus,label+': '+JSON.stringify(move.data));
      if (expectedStatus === 409) {
        assert.equal(move.data.code,'MISSED_MOVE_REQUIRES_REVIEW');
        assert.equal(move.data.outcome,'no_change'); assert.equal(move.data.plan_changed,false);
      }
      assert.equal(JSON.stringify(await acceptedBytes()),prior,label+' preserves the whole accepted plan/progress/revision');
      assert.deepEqual(await db.dbGet('SELECT planning_input_revision FROM users WHERE id=?',[owner]),revision);
    };
    for (const targetDate of ['2026-09-09','2026-09-10','2026-09-11']) {
      await assertNoLegacyMove('local-date/future/race move withheld',{sessionId:selectedRun.sessionId,targetDate});
    }
    await assertNoLegacyMove('outside local-day window rejected',{sessionId:selectedRun.sessionId,targetDate:'2026-10-11'},400);
    const missedBody = {...clock,reason:'sick',scheduled_date:selected.date,session_id:selected.sessionId,
      session_content_hash:selected.contentHash,plan_version:list.data.plan_version,
      plan_id:list.data.plan_id,user_plan_id:list.data.user_plan_id};
    assert.equal((await request('POST','/runs/missed',{...missedBody,plan_version:'stale'})).status,409);
    assert.equal((await request('POST','/runs/missed',{...missedBody,scheduled_date:'2026-09-11'})).status,404);
    assert.equal((await request('POST','/runs/missed',{...missedBody,user_plan_id:'foreign'})).status,409);
    const saved = await request('POST','/runs/missed',missedBody);
    assert.equal(saved.status,200,JSON.stringify(saved.data));
    assert.equal(saved.data.outcome,'recorded'); assert.equal(saved.data.plan_changed,false);
    assert.match(saved.data.message,/Your plan has not changed/);
    assert.equal(stablePlan(await acceptedBytes()),stablePlan(before));
    const savedBytes = JSON.stringify(await acceptedBytes());
    assert.equal((await request('POST','/runs/missed',missedBody)).data.replayed,true);
    assert.equal((await request('POST','/runs/missed',{...missedBody,reason:'weather'})).status,409);
    assert.equal(JSON.stringify(await acceptedBytes()),savedBytes);
    const freshList = await request('GET','/plans/missed-sessions?'+query);
    assert.deepEqual(freshList.data.sessions.find(item=>item.sessionId===selected.sessionId).record,saved.data.record);
    const raw = {date:selectedRun.date,type:'easy',distance_miles:2,duration_seconds:1500,perceived_effort:2};
    const omitted = await request('POST','/runs',raw); assert.equal(omitted.status,201,JSON.stringify(omitted.data));
    assert.equal(JSON.parse(omitted.data.run.planned_session_json).matchSource,'scheduled_date');
    const unlinked = await request('POST','/runs',{...raw,plan_session_id:null}); assert.equal(unlinked.status,201);
    assert.equal(JSON.parse(unlinked.data.run.planned_session_json).planMatchMode,'explicit_none');
    const explicit = await request('POST','/runs',{...raw,plan_session_id:selectedRun.sessionId,
      planned_session:{sessionId:selectedRun.sessionId,date:selectedRun.date,title:'Actual ActiveRun payload without planId'}});
    assert.equal(explicit.status,201,JSON.stringify(explicit.data));
    const snapshot = JSON.parse(explicit.data.run.planned_session_json);
    assert.equal(snapshot.matchSource,'explicit_owned_session'); assert.equal(snapshot.planId,list.data.plan_id);
    assert.equal(snapshot.content_hash,selectedRun.contentHash);
    assert.equal((await request('POST','/runs',{...raw,plan_session_id:'foreign-session'})).status,409);
    const completedList = await request('GET','/plans/missed-sessions?'+query);
    assert.ok(!completedList.data.sessions.some(item=>item.sessionId===selectedRun.sessionId && item.eligible));
    await assertNoLegacyMove('completed and observed load cannot use legacy move',{sessionId:selectedRun.sessionId,targetDate:'2026-09-10'});
    const checkIn = await request('PATCH','/runs/'+explicit.data.run.id+'/check-in',{perceived_effort:9,pain_level:'severe',post_energy:'low'});
    assert.equal(checkIn.status,200,JSON.stringify(checkIn.data));
    const preview = await request('GET','/plans/adaptation/current?date=2026-09-10');
    assert.equal(preview.status,200,JSON.stringify(preview.data)); assert.ok(preview.data.proposal);
    const p = preview.data.proposal;
    assert.equal(p.activityValidation?.version,'activity-aware-adaptation-v1','Real preview must contain the validated canonical successor, not legacy intent');
    assert.equal(p.activityValidation?.valid,true); assert.ok(p.observationTicket);
    const choice = {planning_date:p.planningDate,proposal_revision:p.revision,proposal_plan_version:p.planVersion,preview_fingerprint:p.previewFingerprint,
      ...(p.observationTicket ? {observation_ticket:p.observationTicket} : {})};
    const keep = await request('POST','/plans/adaptation/preview/keep',choice);
    assert.equal(keep.status,200,JSON.stringify(keep.data)); assert.equal(keep.data.status,'kept');
    const afterKeep = await request('GET','/plans/adaptation/current?date=2026-09-10');
    assert.equal(afterKeep.data.proposal,null,'Unchanged keep must not cause another prompt');
    assert.equal((await request('POST','/plans/adaptation/preview/keep',choice)).status,409);
    await request('PATCH','/runs/'+explicit.data.run.id+'/check-in',{perceived_effort:10,pain_level:'severe',post_energy:'low'});
    const changed = await request('GET','/plans/adaptation/current?date=2026-09-10');
    assert.ok(changed.data.proposal,JSON.stringify(changed.data));
    assert.notEqual(changed.data.proposal.previewFingerprint,p.previewFingerprint);
    assert.equal((await request('POST','/plans/adaptation/preview/accept',choice)).status,409,'Changed activity rejects old apply');
    assert.equal(stablePlan(await acceptedBytes()),stablePlan(before),'Record/keep/reject cannot mutate accepted prescriptions');
    if (process.env.PROGRAM_TEST_ACTIVITY_ACCEPT === '1') {
      const next = changed.data.proposal;
      const acceptBody = {planning_date:next.planningDate,proposal_revision:next.revision,proposal_plan_version:next.planVersion,
        preview_fingerprint:next.previewFingerprint,observation_ticket:next.observationTicket};
      const accepted = await request('POST','/plans/adaptation/preview/accept',acceptBody);
      assert.equal(accepted.status,200,JSON.stringify(accepted.data));
      const acceptedOnce = JSON.stringify(await acceptedBytes());
      const replayAccepted = await request('POST','/plans/adaptation/preview/accept',acceptBody);
      assert.equal(replayAccepted.status,200,JSON.stringify(replayAccepted.data));
      assert.equal(replayAccepted.data.idempotent,true);
      assert.equal(JSON.stringify(await acceptedBytes()),acceptedOnce,'Exact accepted replay cannot add a second successor');
      const adaptedCurrent = await request('GET','/plans/current');
      const adaptedToday = await request('GET','/plans/today?date=2026-09-10');
      assert.equal(adaptedCurrent.status,200,JSON.stringify(adaptedCurrent.data));
      assert.equal(adaptedToday.status,200,JSON.stringify(adaptedToday.data));
      assert.equal(adaptedToday.data.surface_manifest.status,'accepted');
      assert.equal(adaptedToday.data.execution.date,'2026-09-10');
      assert.equal(adaptedCurrent.data.surface_manifest.status,'accepted');
      const adapted = adaptedCurrent.data.plan.plan_data;
      assert.equal(adapted.weeks.length,reloaded.weeks.length);
      assert.equal(adapted.plan_revision,reloaded.plan_revision+1);
      assert.deepEqual(adapted.programContract,reloaded.programContract);
      const actualSet = {...adapted.programCanonicalIdentity,sessions:adaptedCurrent.data.surface_manifest.sessions};
      assert.equal(require('../src/lib/canonicalWorkout').validateCanonicalSessionSet(actualSet).valid,true);
      assert.ok(actualSet.sessions.some(session=>session.workout_family==='rest' && session.activity_reduction));
      const nextGet = await request('GET','/plans/adaptation/current?date=2026-09-10');
      assert.equal(nextGet.data.proposal,null,'Accepted unchanged evidence must not immediately reprompt');
      const receiptPath = '/tmp/'+databaseName+'-activity-accepted-program.json';
      require('node:fs').writeFileSync(receiptPath,JSON.stringify({parent:current.data,
        preview:{...next,observationTicket:undefined},applied:accepted.data,current:adaptedCurrent.data,today:adaptedToday.data}));
      console.log(JSON.stringify({gate:'activity-canonical-accept-reload',status:'PASS',frequency,receiptPath}));
      Date.advanceFixtureDays(2);
      const completedAfter = await request('GET','/plans/missed-sessions?'+new URLSearchParams({...clock,planning_date_local:'2026-09-12'}));
      assert.equal(completedAfter.status,200,JSON.stringify(completedAfter.data));
      assert.ok(!completedAfter.data.sessions.some(item=>item.sessionId===selectedRun.sessionId && item.eligible),
        'Original explicit linked completion survives an accepted change elsewhere');
      const laterRun = await request('POST','/runs',{date:'2026-09-12',type:'run',distance_miles:1,duration_seconds:600,
        perceived_effort:9,plan_session_id:null});
      assert.equal(laterRun.status,201,JSON.stringify(laterRun.data));
      assert.equal((await request('PATCH','/runs/'+laterRun.data.run.id+'/check-in',
        {perceived_effort:9,pain_level:'severe',post_energy:'low'})).status,200);
      const secondPreview = await request('GET','/plans/adaptation/current?date=2026-09-12');
      assert.equal(secondPreview.status,200,JSON.stringify(secondPreview.data));
      const second = secondPreview.data.proposal;
      assert.ok(second?.activityValidation?.valid,JSON.stringify(secondPreview.data));
      const secondAccepted = await request('POST','/plans/adaptation/preview/accept',{planning_date:second.planningDate,
        proposal_revision:second.revision,proposal_plan_version:second.planVersion,preview_fingerprint:second.previewFingerprint,
        observation_ticket:second.observationTicket});
      assert.equal(secondAccepted.status,200,JSON.stringify(secondAccepted.data));
      const secondCurrent = await request('GET','/plans/current'), secondToday = await request('GET','/plans/today?date=2026-09-12');
      assert.equal(secondCurrent.status,200,JSON.stringify(secondCurrent.data));
      assert.equal(secondToday.status,200,JSON.stringify(secondToday.data));
      assert.equal(secondToday.data.surface_manifest.status,'accepted');
      assert.equal(secondToday.data.execution.date,'2026-09-12');
      assert.equal(secondCurrent.data.surface_manifest.status,'accepted');
      assert.equal(secondCurrent.data.plan.plan_data.plan_revision,adapted.plan_revision+1);
      assert.equal(secondCurrent.data.plan.plan_data.weeks.length,adapted.weeks.length);
      const secondPath='/tmp/'+databaseName+'-second-activity-accepted-program.json';
      require('node:fs').writeFileSync(secondPath,JSON.stringify({parent:adaptedCurrent.data,
        preview:{...second,observationTicket:undefined},applied:secondAccepted.data,current:secondCurrent.data,today:secondToday.data}));
      console.log(JSON.stringify({gate:'second-activity-canonical-accept-reload',status:'PASS',frequency,receiptPath:secondPath}));
    }
    console.log(JSON.stringify({gate:'activity-missed-real-http',status:'PASS',frequency,missedReadback:true,explicitSourceBoundary:true,keepNoRepeat:true,freshActivityReassessed:true}));
    return;
  }
` + marker);
const loaded = new Module(file, module);
loaded.filename = file;
loaded.paths = Module._nodeModulePaths(path.dirname(file));
loaded._compile(source, file);
