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
const fixtureStart = SystemDate.parse('2026-09-10T16:00:00.000Z');
global.Date = class ActivityFixtureDate extends SystemDate {
  constructor(...args) { super(...(args.length ? args : [fixtureStart + SystemDate.now() - realStart])); }
  static now() { return fixtureStart + SystemDate.now() - realStart; }
};
const file = path.join(__dirname, 'programPersistence.integration.js');
const marker = "  if (process.env.PROGRAM_TEST_REMOVAL === '1') {";
let source = fs.readFileSync(file, 'utf8');
if (source.split(marker).length !== 2) throw new Error('Guarded program harness insertion changed');
source = source.replace(marker, `
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
    const checkIn = await request('PATCH','/runs/'+explicit.data.run.id+'/check-in',{perceived_effort:9,pain_level:'severe',post_energy:'low'});
    assert.equal(checkIn.status,200,JSON.stringify(checkIn.data));
    const preview = await request('GET','/plans/adaptation/current?date=2026-09-10');
    assert.equal(preview.status,200,JSON.stringify(preview.data)); assert.ok(preview.data.proposal);
    const p = preview.data.proposal;
    const choice = {planning_date:p.planningDate,proposal_revision:p.revision,proposal_plan_version:p.planVersion,preview_fingerprint:p.previewFingerprint};
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
    console.log(JSON.stringify({gate:'activity-missed-real-http',status:'PASS',frequency,missedReadback:true,explicitSourceBoundary:true,keepNoRepeat:true,freshActivityReassessed:true}));
    return;
  }
` + marker);
const loaded = new Module(file, module);
loaded.filename = file;
loaded.paths = Module._nodeModulePaths(path.dirname(file));
loaded._compile(source, file);
