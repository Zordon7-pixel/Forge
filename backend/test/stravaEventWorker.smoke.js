'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Pool}=require('pg');
const {fixture,hint,job,settings,barrier}=require('./stravaWorkerPrimitives.smoke');
const {raw,snapshot}=require('./backgroundRunPersistence.smoke');
const {createStravaEventWorker}=require('../src/services/stravaEventWorker');
const {persistStravaActivity}=require('../src/services/stravaPersistence');
const {retireSavedRun}=require('../src/services/savedRunEvents');
const {createStravaConnectionService}=require('../src/services/stravaConnectionService');
const {storeHint}=require('../src/services/stravaEventIntake');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const activity=(extra={})=>raw('9001',{athlete:{id:123},trainer:true,...extra});
const response=(value,status=200,headers)=>new Response(typeof value==='string'?value:JSON.stringify(value),{status,headers});
async function prepare(f){
  await f.tx.run('UPDATE strava_tokens SET expires_at=? WHERE user_id=?',[Math.floor(Date.now()/1000)+3600,'a']);
  await hint(f);return f;
}
const count=async(f,table)=>Number((await f.tx.get(`SELECT count(*) AS n FROM ${table}`)).n);
function worker(f,fetchImpl,extra={}){return createStravaEventWorker({database:f.db,fetchImpl,env:()=>settings,...extra});}
async function success(f){
  await prepare(f);await f.tx.run("INSERT INTO push_subscriptions(id,user_id,endpoint,keys_p256dh,keys_auth,active) VALUES('target','a','https://synthetic.invalid/a','s','s',TRUE)");
  await f.tx.run("UPDATE strava_tokens SET expires_at=0 WHERE user_id='a'");
  const calls=[],times=[];
  const w=worker(f,async(url)=>{
    calls.push(new URL(url).pathname);times.push(new Date((await f.tx.get("SELECT next_allowed_at FROM background_sync_control WHERE id='strava'")).next_allowed_at).getTime());
    if(url.endsWith('/oauth/token'))return response({access_token:'new-access',refresh_token:'new-refresh',expires_at:Math.floor(Date.now()/1000)+3600});
    if(url.endsWith('/streams?keys=latlng,altitude,time&key_by_type=true')||url.includes('/streams?'))return response({latlng:{data:[[40,-70],[40.001,-70.001]]},time:{data:[0,60]}});
    return response(activity({trainer:false}));
  });
  const result=await w.runOnce();assert.equal(result[0].status,'SAVED');assert.equal(result[0].imported,1);
  assert.equal(calls.length,3);assert.ok(calls[0].endsWith('/oauth/token'));assert.ok(calls[1].endsWith('/9001'));assert.ok(calls[2].endsWith('/9001/streams'));
  assert.ok(times[1]-times[0]>=1000&&times[2]-times[1]>=1000,'each committed reservation preserves strict one-second spacing');
  const j=await job(f,'9001');assert.equal(j.state,'DONE');assert.equal(Number(j.attempts),1);assert.ok(j.last_fetch_at);
  assert.equal(await count(f,'activity_notification_events'),1);assert.equal(await count(f,'notification_deliveries'),1);
  const run=await f.tx.get("SELECT * FROM runs WHERE id='strava_a_9001'");assert.equal(JSON.parse(run.route_coords).length,2);
  await hint(f,'9001',1);assert.deepEqual(await job(f,'9001'),j,'exact callback replay does not reopen');
  await w.runOnce();assert.equal(calls.length,3);
  assert.equal(Number((await f.tx.get("SELECT planning_input_revision FROM users WHERE id='a'")).planning_input_revision),1);
  await w.close();
}
async function optional(f,kind){
  await prepare(f);let calls=0;
  const {performance}=require('node:perf_hooks'),descriptor=Object.getOwnPropertyDescriptor(performance,'now'),clock=performance.now.bind(performance);
  const w=worker(f,async url=>{
    calls++;if(url.includes('/streams?')){if(kind==='error')return response('',500);throw Error('synthetic optional failure');}
    if(kind==='quota')await f.tx.run("UPDATE background_sync_control SET quarter_used=60 WHERE id='strava'");
    if(kind==='pause')await f.tx.run("UPDATE background_sync_control SET paused=TRUE WHERE id='strava'");
    if(kind==='budget')Object.defineProperty(performance,'now',{configurable:true,value:()=>clock()+65000});
    return response(activity({trainer:false}));
  });
  try{assert.equal((await w.runOnce())[0].status,'SAVED');assert.equal((await job(f,'9001')).state,'DONE');assert.equal(calls,kind==='error'?2:1);assert.equal(await count(f,'activity_notification_events'),1);}
  finally{if(descriptor)Object.defineProperty(performance,'now',descriptor);else delete performance.now;await w.close();}
}
async function negative(f,kind){
  await prepare(f);let calls=0;
  const w=worker(f,async()=>{calls++;const changes={id:{id:'9002'},athlete:{athlete:{id:456}},missingAthlete:{athlete:null},missingTime:{start_date:null},missingType:{type:null,sport_type:null},missingMetrics:{distance:null},nonrun:{type:'Ride',sport_type:'Ride'}};
    return response(kind==='malformed'?'not-json':activity(changes[kind]));});
  const result=(await w.runOnce())[0];assert.equal(result.status,kind==='nonrun'?'NO_RUN':'RETRY');assert.equal(calls,1);
  assert.equal(await count(f,'runs'),1);assert.equal(await count(f,'activity_notification_events'),0);
  assert.equal(Number((await f.tx.get("SELECT planning_input_revision FROM users WHERE id='a'")).planning_input_revision),0);await w.close();
}
async function unavailable(f,kind){
  await prepare(f);
  if(kind!=='absent')await f.db.withPlanningMutation('a',tx=>persistStravaActivity(tx,'a',activity(),f.expected));
  if(kind==='deleted')await f.db.withOwnerMutation('a',tx=>retireSavedRun(tx,'a','strava_a_9001'));
  const before=await snapshot(f.tx);let status=404;
  const w=worker(f,async()=>response(status===200?activity():'<not-json>',status));
  assert.equal((await w.runOnce())[0].status,'SOURCE_UNAVAILABLE');const after=await snapshot(f.tx);
  for(const table of ['runs','personal_records','run_save_eligibility','activity_notification_events','notification_deliveries','user_notifications','users'])assert.deepEqual(after[table],before[table],table);
  const link=await f.tx.get("SELECT state FROM provider_activity_links WHERE object_id='9001'");assert.equal(link?.state,kind==='absent'?undefined:kind==='deleted'?'USER_DELETED':'PROVIDER_UNAVAILABLE');
  if(kind==='existing'){
    // Advance only this synthetic completed fixture's due/fetch state, not production clocks.
    await f.tx.run("UPDATE provider_event_jobs SET last_fetch_at=NULL WHERE object_id='9001'");await hint(f,'9001',2);
    status=200;assert.equal((await w.runOnce())[0].status,'SAVED');assert.equal((await f.tx.get("SELECT state FROM provider_activity_links WHERE object_id='9001'")).state,'ACTIVE');
    assert.equal(await count(f,'activity_notification_events'),before.activity_notification_events.length);
  }await w.close();
}
async function failure(f,kind){
  await prepare(f);let calls=0;
  const w=worker(f,async()=>{calls++;if(kind==='forged')throw Object.assign(Error('synthetic'),{status:404,code:'STRAVA_PROVIDER_REJECTED'});if(kind==='network')throw Error('synthetic transport');return response('',429,{'Retry-After':'120'});});
  const result=(await w.runOnce())[0];assert.equal(result.status,'RETRY');assert.equal(await count(f,'runs'),1);assert.equal(await count(f,'strava_tokens'),2);
  assert.equal((await job(f,'9001')).last_error_code,kind==='429'?'STRAVA_JOB_QUOTA':'STRAVA_JOB_TRANSIENT');
  assert.equal(calls,1);await w.close();
}
async function revocation(f,status){
  await prepare(f);await f.tx.run('DELETE FROM provider_event_jobs');
  await f.db.transaction(tx=>storeHint(tx,{ownerId:'123',objectType:'athlete',objectId:'123',fingerprint:'b'.repeat(64),eventTime:1,aspectType:'update'}));
  let calls=0;const w=worker(f,async url=>{calls++;assert.ok(url.endsWith('/athlete'));return response(status===200?{id:123}:'',status);});
  const result=(await w.runOnce())[0];assert.equal(result.status,status===200?'VERIFIED':'REVOKED');assert.equal(calls,1);
  assert.equal(await count(f,'strava_tokens'),status===200?2:1);assert.equal(await count(f,'provider_event_jobs'),status===200?1:0);
  assert.equal(Number((await f.tx.get("SELECT planning_input_revision FROM users WHERE id='a'")).planning_input_revision),0);await w.close();
}
async function activityUnauthorized(f,status){
  await prepare(f);const calls=[];
  const w=worker(f,async url=>{calls.push(new URL(url).pathname);return url.endsWith('/athlete')?response(status===200?{id:123}:'',status):response('',401);});
  const result=(await w.runOnce())[0];assert.equal(result.status,status===200?'RETRY':'REVOKED');assert.equal(calls.length,2);assert.ok(calls[0].endsWith('/9001'));assert.ok(calls[1].endsWith('/athlete'));
  assert.equal(await count(f,'runs'),1);assert.equal(await count(f,'strava_tokens'),status===200?2:1);await w.close();
}
async function firstQuota(f){
  await prepare(f);await f.tx.run("UPDATE background_sync_control SET next_allowed_at=?",[new Date(Date.now()+60000).toISOString()]);
  let calls=0;const w=worker(f,()=>{calls++;assert.fail('quota sends no HTTP');});const result=(await w.runOnce())[0];assert.equal(result.status,'RETRY');assert.equal(result.reason,'QUOTA');assert.equal(calls,0);
  const row=await job(f,'9001');assert.equal(Number(row.attempts),0);assert.equal(row.last_fetch_at,null);await w.close();
}
async function race(f,kind){
  await prepare(f);const entered=barrier(),release=barrier();const w=worker(f,async()=>{entered.resolve();await release.promise;return response(activity());});
  const pending=w.runOnce();await entered.promise;
  if(kind==='lease')await f.tx.run("UPDATE provider_event_jobs SET lease_token='stolen' WHERE object_id='9001'");
  if(kind==='dirty')await hint(f,'9001',2);
  if(kind==='delete')await f.db.withOwnerMutation('a',async tx=>{
    // Follow the real erasure ordering for the source rows present in this
    // deliberately small fixture; users is not an all-table CASCADE shortcut.
    await tx.run("DELETE FROM strava_tokens WHERE user_id='a'");
    await tx.run("DELETE FROM runs WHERE user_id='a'");
    await tx.run("DELETE FROM users WHERE id='a'");
  });
  if(kind==='reconnect'){
    const service=createStravaConnectionService({withUserMutation:f.db.withOwnerMutation,provider:{request:()=>assert.fail()},env:()=>settings});await service.disconnect('a');
    await f.db.withOwnerMutation('a',async tx=>{await tx.run("INSERT INTO strava_tokens(user_id,athlete_id,access_token,refresh_token,connection_generation,token_revision,expires_at) VALUES('a',123,'new','new',?,1,?)",[crypto.randomUUID(),Math.floor(Date.now()/1000)+3600]);await tx.run("INSERT INTO strava_ingress_bindings(id,user_id,athlete_id) SELECT connection_generation,user_id,athlete_id FROM strava_tokens WHERE user_id='a'");});
  }
  const before=await snapshot(f.tx);release.resolve();const result=(await pending)[0];
  if(kind==='dirty'){assert.equal(result.status,'SAVED');const j=await job(f,'9001');assert.equal(j.state,'RETRY');assert.equal(Number(j.processed_revision),1);assert.equal(Number(j.requested_revision),2);}
  else{assert.equal(result.status,'UNKNOWN');const after=await snapshot(f.tx);for(const table of Object.keys(before))assert.deepEqual(after[table],before[table],table);}
  await w.close();
}
async function shutdown(f){
  await prepare(f);const entered=barrier();let aborted=false;
  const w=worker(f,async(_url,{signal})=>{entered.resolve();return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(Error('cancelled'));},{once:true}));});
  const pending=w.runOnce();assert.strictEqual(w.runOnce(),pending,'concurrent cycles coalesce');await entered.promise;
  const began=Date.now();await w.close();assert.ok(Date.now()-began<5000);assert.equal(aborted,true);assert.equal((await pending)[0].status,'UNKNOWN');assert.equal((await job(f,'9001')).state,'LEASED');assert.equal(await count(f,'runs'),1);
  await assert.rejects(()=>w.runOnce(),{code:'STRAVA_WORKER_CLOSED'});assert.throws(()=>w.start(),{code:'STRAVA_WORKER_CLOSED'});await w.close();
}
const cases=[['token-detail-stream-save-replay',success],...['error','quota','pause','budget'].map(k=>['optional-'+k,f=>optional(f,k)]),...['id','athlete','missingAthlete','missingTime','missingType','missingMetrics','malformed','nonrun'].map(k=>['invalid-'+k,f=>negative(f,k)]),...['existing','absent','deleted'].map(k=>['404-'+k,f=>unavailable(f,k)]),...['forged','network','429'].map(k=>['failure-'+k,f=>failure(f,k)]),...[200,401,403].map(k=>['athlete-'+k,f=>revocation(f,k)]),...[200,401].map(k=>['activity-401-athlete-'+k,f=>activityUnauthorized(f,k)]),['first-quota',firstQuota],...['lease','dirty','delete','reconnect'].map(k=>['race-'+k,f=>race(f,k)]),['shutdown',shutdown]];
async function run(dialect){
  const base=new URL('postgresql://forge_background_test@127.0.0.1:55449/forge_background_test');let admin;
  if(dialect==='postgres'){admin=new Pool({connectionString:base.href});assert.deepEqual((await admin.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0],{db:'forge_background_test',role:'forge_background_test',port:55449});}
  try{for(const[name,test]of cases){let f,child;
    try{if(admin){child='forge_w3_'+crypto.randomBytes(8).toString('hex');await admin.query(`CREATE DATABASE "${child}"`);base.pathname='/'+child;}f=await fixture(dialect,base.href);await test(f);console.log('PASS',dialect,name);}
    finally{if(f)await f.close();if(child){await admin.query(`DROP DATABASE "${child}"`);console.log('Removed owned child',child);}}
  }}finally{if(admin)await admin.end();}
}
module.exports={prepare,activity,response,worker,cases};
if(require.main===module)(async()=>{await run('sqlite');if(process.argv.includes('--postgres'))await run('postgres');console.log('STRAVA EVENT WORKER GATE OK — direct synthetic orchestration only');})().catch(error=>{console.error(error);process.exitCode=1;});
