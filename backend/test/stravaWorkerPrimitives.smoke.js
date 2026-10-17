'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {Pool}=require('pg');
const {createWorkerDatabase}=require('../src/db/backgroundSyncWorker');
const {createStravaEventQueue,LIMITS}=require('../src/services/stravaEventQueue');
const {createStravaProviderClient,providerRejection,BODY_BYTES}=require('../src/services/stravaProviderClient');
const {createStravaConnectionService}=require('../src/services/stravaConnectionService');
const {captureStravaConnection,persistStravaActivity}=require('../src/services/stravaPersistence');
const {storeHint}=require('../src/services/stravaEventIntake');
const {planningInputUnchanged}=require('../src/lib/planningRevision');
const migration=require('../src/db/backgroundSyncSchema');
const {seed,raw,snapshot}=require('./backgroundRunPersistence.smoke');
const settings={JWT_SECRET:'synthetic-worker-only',STRAVA_CLIENT_ID:'123',STRAVA_CLIENT_SECRET:'synthetic',STRAVA_REDIRECT_URI:'https://forge.example.invalid/api/strava/callback'};
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const barrier=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:(...args)=>resolve(...args)};};
function baseStatements(){
  const source=fs.readFileSync(path.join(__dirname,'../src/db/index.js'),'utf8'),base=fs.readFileSync(path.join(__dirname,'../src/db/schema.pg.sql'),'utf8');
  return ['users','runs','lifts','personal_records','strava_tokens','push_subscriptions','user_notifications','run_import_tombstones','activity_import_claims','activity_media','shared_routes','community_posts','plan_adjustment_proposals','activity_likes','activity_comments','training_plans','user_plans'].map(table=>{
    const re=new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\s*\\);`),ddl=source.match(re)?.[0]||base.match(re)?.[0];assert.ok(ddl,table);return ddl;
  });
}
const sql=s=>s.replace(/to_char\(NOW\(\), 'YYYY-MM-DD'\)/g,'CURRENT_DATE').replace(/\bNOW\(\)/g,'CURRENT_TIMESTAMP').replace(/\s+FOR UPDATE/g,'').replace(/::text/g,'');
function adapter(client){const query=(s,p=[])=>{let i=0;return client.query(s.replace(/\?/g,()=>`$${++i}`),p);};return {get:async(s,p)=>(await query(s,p)).rows[0]||null,all:async(s,p)=>(await query(s,p)).rows,run:async(s,p)=>({changes:(await query(s,p)).rowCount})};}
async function fixture(dialect,url){
  let native,pool,db,tx;
  if(dialect==='sqlite'){
    native=new DatabaseSync(':memory:');native.function('pg_column_size',value=>Buffer.byteLength(String(value)));
    for(const ddl of baseStatements())native.exec(sql(ddl).replace(/id SERIAL PRIMARY KEY/g,'id INTEGER PRIMARY KEY AUTOINCREMENT').replace(/TIMESTAMPTZ/g,'TEXT'));
    native.exec('PRAGMA foreign_keys=ON');
    tx={};for(const op of ['get','all','run'])tx[op]=async(s,p=[])=>native.prepare(sql(s))[op](...p.map(v=>typeof v==='boolean'?Number(v):v))??null;
    db=createWorkerDatabase({sqlite:native});
  }else{
    pool=new Pool({connectionString:url});for(const ddl of baseStatements())await pool.query(ddl);
    tx=adapter(pool);db=createWorkerDatabase({connectionString:url});
  }
  const f={dialect,native,pool,db,tx,migrate:()=>dialect==='sqlite'?migration.migrateBackgroundSyncSqlite(native):migration.migrateBackgroundSyncPostgres(pool)};
  f.expected=await seed(f);f.queue=createStravaEventQueue({database:db});
  f.close=async()=>{f.queue.close();await db.close();if(pool)await pool.end();if(native)native.close();};return f;
}
async function hint(f,id='9001',time=1){
  return f.db.transaction(tx=>storeHint(tx,{ownerId:'123',objectType:'activity',objectId:id,fingerprint:crypto.createHash('sha256').update(id+':'+time).digest('hex'),eventTime:time,aspectType:'update'}));
}
async function job(f,id){return f.tx.get('SELECT * FROM provider_event_jobs WHERE object_id=?',[id]);}
async function clear(f){f.queue.close();await f.tx.run('DELETE FROM provider_event_jobs');f.queue=createStravaEventQueue({database:f.db});}
async function budget(f){
  const now=Date.now();await f.tx.run("UPDATE background_sync_control SET paused=FALSE,quarter_used=0,day_used=0,next_allowed_at=?,quarter_start=?,day_start=? WHERE id='strava'",[new Date(now-1000).toISOString(),new Date(Math.floor(now/900000)*900000).toISOString(),new Date(Math.floor(now/86400000)*86400000).toISOString()]);
}
async function stateChecks(f){
  await f.db.withOwnerMutation('a',async tx=>{
    assert.equal((await tx('SELECT id FROM users WHERE id=?',['a'])).rowCount,1);
    assert.equal((await tx.run('UPDATE users SET name=name WHERE id=? RETURNING id',['a'])).changes,1);
  });
  await hint(f);const [h]=await f.queue.claim();const e=f.queue.execution(h);
  assert.throws(()=>f.queue.execution({...h}),{code:'STRAVA_JOB_STALE'});
  await assert.rejects(()=>f.db.withOwnerMutation('b',tx=>e.finish(tx)),{code:'STRAVA_WORKER_TRANSACTION_REQUIRED'});
  await assert.rejects(()=>f.db.withOwnerMutation('a',tx=>e.finish(tx)),{code:'STRAVA_JOB_RESULT_UNADMITTED'});
  await e.beforeNetwork({operation:'token',objectId:null});assert.equal(Number((await job(f,'9001')).attempts),1);assert.equal((await job(f,'9001')).last_fetch_at,null);
  await e.beforeNetwork({operation:'activity',objectId:'9001'});await e.beforeNetwork({operation:'streams',objectId:'9001'});
  assert.equal(Number((await job(f,'9001')).attempts),1);assert.ok((await job(f,'9001')).last_fetch_at);
  await assert.rejects(()=>e.beforeNetwork({operation:'activity',objectId:'9001'}),{code:'STRAVA_JOB_OPERATION_INVALID'});
  await assert.rejects(()=>e.beforeNetwork({operation:'streams',objectId:'9002'}),{code:'STRAVA_JOB_OPERATION_INVALID'});
  await hint(f,'9001',2);const before=await job(f,'9001');
  await f.db.withOwnerMutation('a',tx=>e.finish(tx));e.close();
  const dirty=await job(f,'9001');assert.equal(dirty.state,'RETRY');assert.equal(Number(dirty.processed_revision),1);assert.equal(Number(dirty.requested_revision),2);
  assert.equal(new Date(dirty.episode_started_at).getTime(),new Date(before.episode_started_at).getTime());assert.ok(new Date(dirty.available_at)-new Date(dirty.last_fetch_at)>=30000);
  await clear(f);await hint(f);await f.tx.run('UPDATE provider_event_jobs SET attempts=11');
  const [last]=await f.queue.claim(),lastExec=f.queue.execution(last);await lastExec.beforeNetwork({operation:'activity',objectId:'9001'});
  assert.equal(Number((await job(f,'9001')).attempts),12);await f.db.withOwnerMutation('a',tx=>lastExec.finish(tx));lastExec.close();assert.equal((await job(f,'9001')).state,'DONE','attempt12 may finish');
  await clear(f);await hint(f);await f.tx.run('UPDATE provider_event_jobs SET attempts=11');
  const [dirty12]=await f.queue.claim(),dirtyExec=f.queue.execution(dirty12);await dirtyExec.beforeNetwork({operation:'activity',objectId:'9001'});await hint(f,'9001',2);
  await f.db.withOwnerMutation('a',tx=>dirtyExec.finish(tx));dirtyExec.close();assert.equal((await job(f,'9001')).state,'DEAD');assert.equal(Number((await job(f,'9001')).processed_revision),1);
  for(const [attempts,age,reason] of [[12,0,'STRAVA_JOB_ATTEMPTS_EXHAUSTED'],[0,LIMITS.episode,'STRAVA_JOB_EPISODE_EXPIRED'],[11,LIMITS.episode+1,'STRAVA_JOB_EPISODE_EXPIRED']]){
    await clear(f);await hint(f);await f.tx.run('UPDATE provider_event_jobs SET attempts=?,episode_started_at=?',[attempts,new Date(Date.now()-age).toISOString()]);assert.deepEqual(await f.queue.claim(),[]);assert.equal((await job(f,'9001')).last_error_code,reason);
  }
  await clear(f);await hint(f);const [quota]=await f.queue.claim(),quotaExec=f.queue.execution(quota),episode=(await job(f,'9001')).episode_started_at;
  await quotaExec.reschedule('QUOTA',{retryAt:Date.now()+70000});assert.equal(Number((await job(f,'9001')).attempts),0);assert.equal(new Date((await job(f,'9001')).episode_started_at).getTime(),new Date(episode).getTime());
  for(const afterAdmission of [false,true]){
    await clear(f);await hint(f);const [age]=await f.queue.claim(),ageExec=f.queue.execution(age);
    if(afterAdmission)await ageExec.beforeNetwork({operation:'activity',objectId:'9001'});
    await f.tx.run('UPDATE provider_event_jobs SET episode_started_at=?',[new Date(Date.now()-LIMITS.episode).toISOString()]);
    const aged=await job(f,'9001');
    if(afterAdmission)await assert.rejects(()=>f.db.withOwnerMutation('a',tx=>ageExec.finish(tx)),{code:'STRAVA_JOB_EPISODE_EXPIRED'});
    else await assert.rejects(()=>ageExec.beforeNetwork({operation:'activity',objectId:'9001'}),{code:'STRAVA_JOB_EPISODE_EXPIRED'});
    assert.deepEqual(await job(f,'9001'),aged);await ageExec.reschedule('QUOTA');assert.equal((await job(f,'9001')).state,'DEAD');assert.equal(Number((await job(f,'9001')).attempts),afterAdmission?1:0);
  }
  for(const objectId of ['123','999']){
    await clear(f);await f.db.transaction(tx=>storeHint(tx,{ownerId:'123',objectType:'athlete',objectId,fingerprint:'b'.repeat(64),eventTime:1,aspectType:'update'}));
    const [athlete]=await f.queue.claim(),athleteExec=f.queue.execution(athlete);
    if(objectId==='123'){
      await athleteExec.beforeNetwork({operation:'token',objectId:null});assert.equal((await job(f,objectId)).last_fetch_at,null);
      await athleteExec.beforeNetwork({operation:'athlete',objectId:null});assert.ok((await job(f,objectId)).last_fetch_at);
      await assert.rejects(()=>athleteExec.beforeNetwork({operation:'athlete',objectId:null}),{code:'STRAVA_JOB_OPERATION_INVALID'});
    }else await assert.rejects(()=>athleteExec.beforeNetwork({operation:'athlete',objectId:null}),{code:'STRAVA_JOB_OPERATION_INVALID'});
    athleteExec.close();
  }
  await clear(f);for(let i=0;i<12;i++)await hint(f,String(9100+i));assert.equal((await f.queue.claim()).length,2);assert.deepEqual(await f.queue.claim(),[],'process claim capacity2');
  await clear(f);await hint(f);let [reclaim]=await f.queue.claim();await f.tx.run('UPDATE provider_event_jobs SET lease_until=?,attempts=3',[new Date(Date.now()-1).toISOString()]);
  f.queue.close();f.queue=createStravaEventQueue({database:f.db});const [newClaim]=await f.queue.claim();assert.ok(newClaim);assert.equal(Number((await job(f,'9001')).attempts),3);assert.throws(()=>f.queue.execution(reclaim));
  await clear(f);await hint(f);const [cancelled]=await f.queue.claim(),abort=new AbortController(),cancelExec=f.queue.execution(cancelled,{signal:abort.signal});abort.abort();await assert.rejects(()=>cancelExec.beforeNetwork({operation:'activity',objectId:'9001'}));assert.equal(Number((await job(f,'9001')).attempts),0);cancelExec.close();
  const unchanged=await f.tx.get("SELECT planning_input_revision FROM users WHERE id='a'");await f.db.withPlanningMutation('a',()=>planningInputUnchanged('same'));assert.deepEqual(await f.tx.get("SELECT planning_input_revision FROM users WHERE id='a'"),unchanged);
  await assert.rejects(()=>f.db.withOwnerMutation('missing',()=>assert.fail()),{code:'AUTH_ACCOUNT_DELETED'});
  await assert.rejects(()=>f.db.transaction(()=>f.db.transaction(()=>{})),{code:'STRAVA_WORKER_DB_UNAVAILABLE'});
  console.log(`PASS ${f.dialect} private claims, charge/fetch separation,12/no13,72h,dirty-result,quota preservation,reclaim,owner/revision`);
}
async function providerChecks(f){
  await clear(f);await hint(f);let [h]=await f.queue.claim(),e=f.queue.execution(h),calls=0,mode='valid';
  const provider=createStravaProviderClient({withTransaction:f.db.transaction,dialect:f.dialect,fetchImpl:async()=>{calls++;return new Response(mode==='valid'?'{}':mode,{status:mode==='valid'?200:404});}});
  await budget(f);await f.tx.run("UPDATE background_sync_control SET paused=TRUE WHERE id='strava'");await assert.rejects(()=>provider.request('activity',{accessToken:'synthetic',activityId:'9001'},{beforeNetwork:e.beforeNetwork}),{code:'STRAVA_PROVIDER_PAUSED'});assert.equal(calls,0);assert.equal(Number((await job(f,'9001')).attempts),0);
  await budget(f);const admission=async op=>{await f.tx.run("UPDATE background_sync_control SET paused=TRUE WHERE id='strava'");return e.beforeNetwork(op);};
  await assert.rejects(()=>provider.request('activity',{accessToken:'synthetic',activityId:'9001'},{beforeNetwork:admission}),{code:'STRAVA_PROVIDER_PAUSED'});assert.equal(calls,0);assert.equal(Number((await job(f,'9001')).attempts),0);assert.equal(Number((await f.tx.get('SELECT quarter_used FROM background_sync_control')).quarter_used),1);
  await budget(f);const admitted=async op=>{await e.beforeNetwork(op);await f.tx.run("UPDATE background_sync_control SET paused=TRUE WHERE id='strava'");};
  await provider.request('token',{clientId:'s',clientSecret:'s',refreshToken:'s'},{beforeNetwork:admitted});assert.equal(calls,1);assert.equal(Number((await job(f,'9001')).attempts),1);assert.equal((await job(f,'9001')).last_fetch_at,null);
  await assert.rejects(()=>provider.request('activity',{accessToken:'s',activityId:'9001'},{beforeNetwork:e.beforeNetwork}),{code:'STRAVA_PROVIDER_PAUSED'});assert.equal(calls,1);e.close();
  await clear(f);await budget(f);await hint(f);[h]=await f.queue.claim();e=f.queue.execution(h);const times=[];
  const sequential=createStravaProviderClient({withTransaction:f.db.transaction,dialect:f.dialect,fetchImpl:async()=>{times.push(Date.parse((await f.tx.get('SELECT next_allowed_at FROM background_sync_control')).next_allowed_at)-1000);return new Response('{}');}});
  await sequential.request('token',{clientId:'s',clientSecret:'s',refreshToken:'s'},{beforeNetwork:e.beforeNetwork});
  await f.tx.run('UPDATE background_sync_control SET quarter_used=60');
  await assert.rejects(()=>sequential.request('activity',{accessToken:'s',activityId:'9001'},{beforeNetwork:e.beforeNetwork}),{code:'STRAVA_QUOTA_UNAVAILABLE'});
  assert.equal(Number((await job(f,'9001')).attempts),1);assert.equal((await job(f,'9001')).last_fetch_at,null);
  e.close();await clear(f);await budget(f);await hint(f);[h]=await f.queue.claim();e=f.queue.execution(h);times.length=0;
  // Independent fresh sequence: no counter/window edits between requests.
  await sequential.request('token',{clientId:'s',clientSecret:'s',refreshToken:'s'},{beforeNetwork:e.beforeNetwork});
  await sequential.request('activity',{accessToken:'s',activityId:'9001'},{beforeNetwork:e.beforeNetwork});
  await sequential.request('streams',{accessToken:'s',activityId:'9001'},{beforeNetwork:e.beforeNetwork});
  assert.equal(times.length,3);assert.ok(times[1]-times[0]>=1000&&times[2]-times[1]>=1000);assert.equal(Number((await job(f,'9001')).attempts),1);
  await f.tx.run('UPDATE background_sync_control SET quarter_used=60');await assert.rejects(()=>sequential.request('streams',{accessToken:'s',activityId:'9001'},{beforeNetwork:e.beforeNetwork}),{code:'STRAVA_QUOTA_UNAVAILABLE'});
  await f.db.withOwnerMutation('a',tx=>e.finish(tx));assert.equal((await job(f,'9001')).state,'DONE','optional stream quota denial does not discard admitted core');e.close();
  for(const body of ['', '<html>missing</html>','{','null','{}',new Uint8Array([255,254])]){
    await budget(f);const client=createStravaProviderClient({withTransaction:f.db.transaction,dialect:f.dialect,fetchImpl:async()=>new Response(body,{status:404})});
    let rejected;try{await client.request('activity',{accessToken:'s',activityId:'9001'});}catch(error){rejected=error;}
    assert.deepEqual(providerRejection(rejected),{status:404,operation:'activity',objectId:'9001'});assert.equal(providerRejection({...rejected}),null);
  }
  await budget(f);let forged=Object.assign(new Error('404'),{status:404,code:'STRAVA_PROVIDER_REJECTED'});assert.equal(providerRejection(forged),null);
  for(const [status,body] of [[200,'{'],[404,' '.repeat(BODY_BYTES+1)]]){
    await budget(f);const client=createStravaProviderClient({withTransaction:f.db.transaction,dialect:f.dialect,fetchImpl:async()=>new Response(body,{status})});
    await assert.rejects(()=>client.request('activity',{accessToken:'s',activityId:'9001'}),error=>{assert.equal(providerRejection(error),null);return true;});
  }
  await budget(f);const entered=barrier(),release=barrier(),input={accessToken:'s',activityId:'9001'};let metadata,url;
  const capturedClient=createStravaProviderClient({dialect:f.dialect,withTransaction:async(fn,options)=>{const result=await f.db.transaction(fn,options);entered.resolve();await release.promise;return result;},fetchImpl:async value=>{url=value;return new Response('',{status:404});}});
  const captured=capturedClient.request('activity',input,{beforeNetwork:async value=>{metadata=value;}});await entered.promise;input.activityId='9999';release.resolve();
  await assert.rejects(()=>captured,error=>{assert.deepEqual(providerRejection(error),{status:404,operation:'activity',objectId:'9001'});return true;});assert.equal(metadata.objectId,'9001');assert.ok(url.endsWith('/9001'),'URL/admission/rejection share one captured object identity');
  await budget(f);const truncated=createStravaProviderClient({dialect:f.dialect,withTransaction:f.db.transaction,fetchImpl:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));controller.error(Error('synthetic truncated body'));}}),{status:404})});
  await assert.rejects(()=>truncated.request('activity',{accessToken:'s',activityId:'9001'}),error=>{assert.equal(providerRejection(error),null);return true;});
  await budget(f);const bodyStarted=barrier(),abort=new AbortController();let cancelled=false;
  const hanging=createStravaProviderClient({dialect:f.dialect,withTransaction:f.db.transaction,fetchImpl:async()=>{bodyStarted.resolve();return new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:404});}});
  const hangingRequest=hanging.request('activity',{accessToken:'s',activityId:'9001'},{signal:abort.signal});await bodyStarted.promise;await new Promise(resolve=>setImmediate(resolve));abort.abort();await assert.rejects(()=>hangingRequest,error=>{assert.equal(providerRejection(error),null);return true;});assert.equal(cancelled,true);
  await budget(f);const throttled=createStravaProviderClient({dialect:f.dialect,withTransaction:f.db.transaction,fetchImpl:async()=>new Response('',{status:429,headers:{'Retry-After':'120'}})});
  await assert.rejects(()=>throttled.request('activity',{accessToken:'s',activityId:'9001'}),error=>{assert.equal(providerRejection(error).status,429);return true;});assert.ok(Date.parse((await f.tx.get('SELECT next_allowed_at FROM background_sync_control')).next_allowed_at)>Date.now()+119000);
  await budget(f);
  console.log(`PASS ${f.dialect} real shared provider token/detail/streams, pause admission order, branded bounded404 and forged/malformed negatives`);
}
async function atomicChecks(f){
  await clear(f);await hint(f);const [h]=await f.queue.claim(),e=f.queue.execution(h);await e.beforeNetwork({operation:'activity',objectId:'9001'});
  await f.tx.run("INSERT INTO push_subscriptions(id,user_id,endpoint,keys_p256dh,keys_auth,active) VALUES('worker-target','a','https://synthetic.invalid/worker','s','s',TRUE)");
  const captured=captureStravaConnection('a',await f.tx.get("SELECT * FROM strava_tokens WHERE user_id='a'"));
  const before=await snapshot(f.tx);
  await assert.rejects(()=>f.db.withPlanningMutation('a',async tx=>{
    const persist=f.dialect==='sqlite'?Object.assign(s=>tx(sql(s)),{get:(s,p)=>tx.get(sql(s),p),all:(s,p)=>tx.all(sql(s),p),run:(s,p)=>tx.run(sql(s),p)}):tx;
    await persistStravaActivity(persist,'a',raw(9001),captured);await tx.run("UPDATE provider_event_jobs SET lease_token='stolen' WHERE id=?",[h.id]);await e.finish(tx);
  }),{code:'STRAVA_JOB_STALE'});
  assert.deepEqual(await snapshot(f.tx),before,'actual reconciliation/finalCAS rolls back whole graph and revision');
  await f.db.withPlanningMutation('a',async tx=>{
    const persist=f.dialect==='sqlite'?{get:(s,p)=>tx.get(sql(s),p),all:(s,p)=>tx.all(sql(s),p),run:(s,p)=>tx.run(sql(s),p)}:tx;
    await persistStravaActivity(persist,'a',raw(9001),captured);await e.finish(tx);
  });e.close();assert.equal((await job(f,'9001')).state,'DONE');assert.equal(Number((await f.tx.get("SELECT planning_input_revision FROM users WHERE id='a'")).planning_input_revision),1);
  console.log(`PASS ${f.dialect} actual canonical graph rollback and unchanged planning mutation authority`);
}
async function revocationChecks(f){
  let reply=()=>new Response('{}'),inside=false;
  const provider=createStravaProviderClient({withTransaction:f.db.transaction,dialect:f.dialect,fetchImpl:async()=>{assert.equal(inside,false);return reply();}});
  const owner=(id,fn,options)=>f.db.withOwnerMutation(id,async tx=>{inside=true;try{return await fn(tx);}finally{inside=false;}},options);
  const ordinary=createStravaConnectionService({withUserMutation:owner,provider,env:()=>settings});
  const connect=async()=>{await budget(f);reply=()=>new Response(JSON.stringify({access_token:'synthetic',refresh_token:'synthetic',expires_at:Math.floor(Date.now()/1000)+3600,athlete:{id:123}}));await ordinary.callback(ordinary.verify(await ordinary.start('a')),'synthetic');};
  for(const scenario of ['404','malformed200','foreign200','transport','forged401','stolen','expired','notice-fault','newer-start','revision-change','success401','success403']){
    await clear(f);await connect();await hint(f);const [h]=await f.queue.claim(),e=f.queue.execution(h);
    const service=createStravaConnectionService({withUserMutation:owner,provider:scenario==='forged401'?{request:async()=>{throw Object.assign(new Error('forged'),{status:401,code:'STRAVA_PROVIDER_REJECTED'});}}:provider,
      beforeNetwork:e.beforeNetwork,finalizeVerifiedRevocation:e.finalizeVerifiedRevocation,env:()=>settings});
    // A newer pending OAuth start captured BEFORE dedicated rejection must
    // survive successful remote deauth (retained absence epoch).
    const pending=await ordinary.start('a');let captured=await service.connection('a');
    const baseline=JSON.stringify(await f.tx.all("SELECT * FROM strava_tokens WHERE user_id='a'"));
    const epoch=(await f.tx.get("SELECT epoch FROM strava_connection_fences WHERE user_id='a'")).epoch;
    const revision=(await f.tx.get("SELECT planning_input_revision FROM users WHERE id='a'")).planning_input_revision;
    const notices=Number((await f.tx.get("SELECT count(*) AS n FROM user_notifications WHERE user_id='a'")).n);
    await budget(f);
    reply=async()=>{
      if(scenario==='transport')throw Error('synthetic transport');
      if(scenario==='404')return new Response('',{status:404});
      if(scenario==='malformed200')return new Response('{');
      if(scenario==='foreign200')return new Response('{"id":456}');
      if(scenario==='stolen')await f.tx.run("UPDATE provider_event_jobs SET lease_token='stolen'");
      if(scenario==='expired')await f.tx.run('UPDATE provider_event_jobs SET lease_until=?',[new Date(Date.now()-1).toISOString()]);
      if(scenario==='newer-start')await ordinary.start('a');
      if(scenario==='revision-change')await f.tx.run("UPDATE strava_tokens SET token_revision=token_revision+1 WHERE user_id='a'");
      if(scenario==='notice-fault'){
        if(f.dialect==='sqlite')f.native.exec("CREATE TRIGGER reject_notice BEFORE INSERT ON user_notifications BEGIN SELECT RAISE(ABORT,'synthetic notice fault'); END");
        else await f.pool.query("CREATE FUNCTION reject_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic notice fault'; END $$; CREATE TRIGGER reject_notice BEFORE INSERT ON user_notifications FOR EACH ROW EXECUTE FUNCTION reject_notice()");
      }
      return new Response('',{status:scenario==='success403'?403:401});
    };
    if(scenario.startsWith('success')){
      assert.equal(await service.verifyRevocation(captured,{signal:e.signal}),true);
      assert.equal(await f.tx.get("SELECT * FROM strava_tokens WHERE user_id='a'"),null);
      assert.equal(await job(f,'9001'),null,'credential trigger cascades completed job in same commit');
      assert.equal((await f.tx.get("SELECT epoch FROM strava_connection_fences WHERE user_id='a'")).epoch,epoch);
      assert.equal(Number((await f.tx.get("SELECT count(*) AS n FROM user_notifications WHERE user_id='a'")).n),notices+1);
      await assert.rejects(()=>service.verifyRevocation(captured,{signal:e.signal}));
      assert.ok(ordinary.verify(pending));
    }else{
      await assert.rejects(()=>service.verifyRevocation(captured,{signal:e.signal}));
      const row=await f.tx.get("SELECT * FROM strava_tokens WHERE user_id='a'");assert.ok(row,'negative cannot delete credentials');
      if(scenario!=='revision-change')assert.equal(JSON.stringify([row]),baseline);
      assert.ok(await job(f,'9001'),'failed finalization did not cascade job');
      assert.equal(Number((await f.tx.get("SELECT count(*) AS n FROM user_notifications WHERE user_id='a'")).n),notices);
    }
    assert.equal((await f.tx.get("SELECT planning_input_revision FROM users WHERE id='a'")).planning_input_revision,revision);
    if(scenario==='notice-fault'){
      if(f.dialect==='sqlite')f.native.exec('DROP TRIGGER reject_notice');
      else await f.pool.query('DROP TRIGGER reject_notice ON user_notifications; DROP FUNCTION reject_notice()');
    }e.close();
  }
  console.log(`PASS ${f.dialect} real branded revocation, owner→binding→job→cascade atomicity, stale/expiry/revision/fence/notification negatives`);
}
async function run(f){try{await stateChecks(f);await providerChecks(f);await atomicChecks(f);await revocationChecks(f);}finally{await f.close();}}
async function postgres(){
  const url=new URL('postgresql://forge_background_test@127.0.0.1:55449/forge_background_test'),admin=new Pool({connectionString:url.href}),name='forge_w2_'+crypto.randomBytes(8).toString('hex');let created=false;
  try{assert.deepEqual((await admin.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0],{db:'forge_background_test',role:'forge_background_test',port:55449});await admin.query(`CREATE DATABASE "${name}"`);created=true;url.pathname='/'+name;await run(await fixture('postgres',url.href));}
  finally{if(created){await admin.query(`DROP DATABASE "${name}"`);console.log('Removed owned child',name);}await admin.end();}
}
module.exports={fixture,baseStatements,adapter,hint,job,clear,budget,settings,barrier,sql};
if(require.main===module)(async()=>{await run(await fixture('sqlite'));if(process.argv.includes('--postgres'))await postgres();console.log('STRAVA WORKER PRIMITIVES GATE OK; no orchestration or activation');})().catch(error=>{console.error(error);process.exitCode=1;});
