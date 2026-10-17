'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {fork}=require('node:child_process');
const {Pool}=require('pg');
const {createWorkerDatabase}=require('../src/db/backgroundSyncWorker');
const {createStravaEventQueue}=require('../src/services/stravaEventQueue');
const {createStravaProviderClient,providerRejection}=require('../src/services/stravaProviderClient');
const {captureStravaConnection,persistStravaActivity}=require('../src/services/stravaPersistence');
const {raw,snapshot}=require('./backgroundRunPersistence.smoke');
const {fixture,adapter,hint,job,clear,budget,barrier}=require('./stravaWorkerPrimitives.smoke');
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function wrappedPool(pool,intercept){return {connect:async()=>{
  const c=await pool.connect();return {query:async(s,p)=>intercept(s,p,()=>c.query(s,p)),release:destroy=>c.release(destroy),on:(...a)=>c.on(...a),removeListener:(...a)=>c.removeListener(...a)};
}};}
async function sqliteCancellation(){
  const f=await fixture('sqlite');
  try{
    const gate=barrier(),entered=barrier(),abort=new AbortController();let lateError;
    const pending=f.db.withPlanningMutation('a',async tx=>{await tx.run("UPDATE users SET name='uncommitted' WHERE id='a'");entered.resolve();await gate.promise;try{await tx.run("UPDATE users SET name='must-not-write' WHERE id='a'");}catch(e){lateError=e;throw e;}},{signal:abort.signal});
    await entered.promise;abort.abort();await assert.rejects(()=>pending,{code:'STRAVA_WORKER_DB_UNAVAILABLE'});
    assert.equal((await f.tx.get("SELECT name FROM users WHERE id='a'")).name,'A','cancel rolls back even while the callback has not settled');gate.resolve();await tick(10);
    assert.equal(lateError.code,'STRAVA_WORKER_DB_UNAVAILABLE');assert.equal((await f.tx.get("SELECT name FROM users WHERE id='a'")).name,'A');
    const before=await f.tx.get("SELECT planning_input_revision FROM users WHERE id='a'");assert.equal(Number(before.planning_input_revision),0);
    await f.db.close();await assert.rejects(()=>f.db.transaction(()=>{}));
    console.log('PASS SQLite cancelled continuation cannot write/commit; closed adapter refuses new work (not PG-lock proof)');
  }finally{await f.close();}
}
async function databaseChecks(f,url){
  let blocker=await f.pool.connect();
  try{
    await blocker.query('BEGIN');await blocker.query("SELECT id FROM users WHERE id='a' FOR UPDATE");
    let entered=false;const began=Date.now();await assert.rejects(()=>f.db.withOwnerMutation('a',()=>{entered=true;}),{code:'55P03'});assert.equal(entered,false);assert.ok(Date.now()-began<1000);
    const abort=new AbortController();abort.abort();await assert.rejects(()=>f.db.withOwnerMutation('a',()=>assert.fail(),{signal:abort.signal}));
  }finally{await blocker.query('ROLLBACK');blocker.release();}
  const small=new Pool({connectionString:url,max:2,connectionTimeoutMillis:150});const one=await small.connect(),two=await small.connect();const bounded=createWorkerDatabase({pool:small});
  try{let called=false;const began=Date.now();await assert.rejects(()=>bounded.transaction(()=>{called=true;}));assert.ok(Date.now()-began<1000);assert.equal(called,false);}
  finally{one.release();two.release();await bounded.close();await small.end();}
  let began=Date.now();await assert.rejects(()=>f.db.transaction(tx=>tx.get('SELECT pg_sleep(2)')),{code:'57014'});assert.ok(Date.now()-began>=900&&Date.now()-began<2000);
  await assert.rejects(()=>f.db.transaction(async tx=>{await tick(1200);await tx.get('SELECT 1');}),{code:'STRAVA_WORKER_DB_UNAVAILABLE'});
  began=Date.now();await assert.rejects(()=>f.db.transaction(async tx=>{for(let i=0;i<15;i++){await tx.get('SELECT 1');await tick(450);}}),{code:'STRAVA_WORKER_DB_UNAVAILABLE'});assert.ok(Date.now()-began>=4900&&Date.now()-began<6500);
  const gate=barrier(),entered=barrier(),abort=new AbortController();let late;
  const pending=f.db.withPlanningMutation('a',async tx=>{await tx.run("UPDATE users SET name='rolled-back' WHERE id='a'");entered.resolve();await gate.promise;try{await tx.run("UPDATE users SET name='late' WHERE id='a'");}catch(e){late=e;throw e;}},{signal:abort.signal});
  await entered.promise;abort.abort();await assert.rejects(()=>pending);gate.resolve();await tick(30);assert.ok(late);assert.equal((await f.tx.get("SELECT name FROM users WHERE id='a'")).name,'A');
  const uncertain=createWorkerDatabase({pool:wrappedPool(f.pool,async(s,p,next)=>{const result=await next();if(s==='COMMIT')throw Error('synthetic lost commit acknowledgement');return result;})});
  await assert.rejects(()=>uncertain.withOwnerMutation('a',tx=>tx.run("UPDATE users SET name='durably-committed' WHERE id='a'")),{code:'STRAVA_WORKER_COMMIT_UNCERTAIN'});
  assert.equal((await f.tx.get("SELECT name FROM users WHERE id='a'")).name,'durably-committed');await uncertain.close();await f.tx.run("UPDATE users SET name='A' WHERE id='a'");
  const closing=createWorkerDatabase({connectionString:url}),wait=barrier();const inFlight=closing.transaction(async tx=>{await tx.get('SELECT 1');wait.resolve();await tick(2000);await tx.get('SELECT 1');});await wait.promise;
  const rejection=assert.rejects(()=>inFlight);await closing.close();await rejection;await assert.rejects(()=>closing.transaction(()=>{}));
  console.log('PASS actual PG acquisition/owner lock/statement/idle/whole timeout/abort/late continuation/uncertain COMMIT/owned-pool close');
}
async function queueConcurrency(f,url){
  await clear(f);await budget(f);for(let i=0;i<12;i++)await hint(f,String(9200+i));
  const otherDb=createWorkerDatabase({connectionString:url}),other=createStravaEventQueue({database:otherDb});
  try{
    const [a,b]=await Promise.all([f.queue.claim(),other.claim()]);assert.equal(a.length,2);assert.equal(b.length,2);assert.equal(new Set([...a,...b].map(x=>x.id)).size,4);
    assert.equal((await f.tx.all("SELECT * FROM provider_event_jobs WHERE state='LEASED'")).length,4);
    const blocker=await f.pool.connect();try{
      await blocker.query('BEGIN');await blocker.query("SELECT id FROM provider_event_jobs WHERE state='PENDING' ORDER BY available_at,id LIMIT 1 FOR UPDATE");
      const third=createStravaEventQueue({database:otherDb});const rows=await third.claim();assert.equal(rows.length,2);third.close();
    }finally{await blocker.query('ROLLBACK');blocker.release();}
  }finally{other.close();await otherDb.close();}
  await clear(f);await hint(f);const [h]=await f.queue.claim();const e=f.queue.execution(h);
  // Actual separate-client pause-before-hook linearization.
  const control=await f.pool.connect();await control.query('BEGIN');await control.query("UPDATE background_sync_control SET paused=TRUE WHERE id='strava'");
  const denied=e.beforeNetwork({operation:'activity',objectId:'9001'});await tick(20);await control.query('COMMIT');control.release();await assert.rejects(()=>denied,{code:'STRAVA_PROVIDER_PAUSED'});assert.equal(Number((await job(f,'9001')).attempts),0);e.close();
  await clear(f);await budget(f);await hint(f);
  const locked=barrier(),release=barrier();let capture=true;
  const wrapper=createWorkerDatabase({pool:wrappedPool(f.pool,async(s,p,next)=>{const result=await next();if(capture&&s.includes('SELECT paused FROM background_sync_control')&&s.includes('FOR UPDATE')){capture=false;locked.resolve();await release.promise;}return result;})});
  const q=createStravaEventQueue({database:wrapper});const [qh]=await q.claim(),qe=q.execution(qh);const admitting=qe.beforeNetwork({operation:'token',objectId:null});await locked.promise;
  let pauseFinished=false;const pause=f.pool.query("UPDATE background_sync_control SET paused=TRUE WHERE id='strava'").then(()=>{pauseFinished=true;});await tick(20);assert.equal(pauseFinished,false);release.resolve();await admitting;await pause;
  assert.equal(Number((await job(f,'9001')).attempts),1);assert.equal((await job(f,'9001')).last_fetch_at,null);await assert.rejects(()=>qe.beforeNetwork({operation:'activity',objectId:'9001'}),{code:'STRAVA_PROVIDER_PAUSED'});
  qe.close();q.close();await wrapper.close();
  // Uncertain hook commit consumes durable admission but must send no HTTP.
  await clear(f);await budget(f);await hint(f);const [uh]=await f.queue.claim();f.queue.close();
  await f.tx.run("UPDATE provider_event_jobs SET state='PENDING',lease_token=NULL,lease_until=NULL,leased_revision=NULL");
  let lose=false;const uncertain=createWorkerDatabase({pool:wrappedPool(f.pool,async(s,p,next)=>{const result=await next();if(s==='COMMIT'&&lose)throw Error('synthetic unknown hook commit');return result;})});
  const uq=createStravaEventQueue({database:uncertain}),[u]=await uq.claim(),ue=uq.execution(u);lose=true;let calls=0;
  const provider=createStravaProviderClient({withTransaction:f.db.transaction,fetchImpl:async()=>{calls++;return new Response('{}');}});
  await assert.rejects(()=>provider.request('activity',{accessToken:'s',activityId:'9001'},{beforeNetwork:ue.beforeNetwork}),{code:'STRAVA_WORKER_COMMIT_UNCERTAIN'});assert.equal(calls,0);assert.equal(Number((await job(f,'9001')).attempts),1);assert.ok((await job(f,'9001')).last_fetch_at);assert.equal(Number((await f.tx.get('SELECT quarter_used FROM background_sync_control')).quarter_used),1);
  ue.close();uq.close();await uncertain.close();
  await clear(f);await budget(f);await hint(f,'9999');for(let i=0;i<103;i++){
    // Direct synthetic terminal fixtures avoid intake's intentional100/binding cap.
    await f.tx.run("INSERT INTO provider_event_jobs(id,binding_id,object_type,object_id,last_fingerprint,reported_event_time,last_aspect,state,requested_revision,processed_revision,updated_at) VALUES(?,?,'activity',?,?,1,'update','DONE',1,1,?)",['purge-'+i,f.expected.generation,String(9400+i),'a'.repeat(64),new Date(Date.now()-31*86400000).toISOString()]);
  }
  assert.equal(await f.queue.purge(),100);assert.equal(await f.queue.purge(),3);assert.ok(await job(f,'9999'));
  console.log('PASS actual PG SKIP LOCKED claims, process capacity, job→control pause order, uncertain-admission noHTTP, bounded clean-only purge');
}
async function child(stage,url){
  const parsed=new URL(url);assert.equal(parsed.hostname,'127.0.0.1');assert.equal(parsed.port,'55449');assert.equal(parsed.username,'forge_background_test');assert.match(parsed.pathname,/^\/forge_w2_concurrency_[a-f0-9]{16}$/);
  const pool=new Pool({connectionString:url}),tx=adapter(pool),db=createWorkerDatabase({connectionString:url}),q=createStravaEventQueue({database:db});
  assert.deepEqual((await pool.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0],{db:parsed.pathname.slice(1),role:'forge_background_test',port:55449});
  const [h]=await q.claim(),e=q.execution(h);let http=0;
  const stopped=async()=>{process.send({stage,http});await new Promise(()=>{});};
  if(stage==='claim')await stopped();
  const provider=createStravaProviderClient({withTransaction:db.transaction,fetchImpl:async()=>{http++;return new Response('{}');}});
  if(stage==='reservation')await provider.request('activity',{accessToken:'s',activityId:'9001'},{beforeNetwork:stopped});
  if(stage==='between-token-detail'){await provider.request('token',{clientId:'s',clientSecret:'s',refreshToken:'s'},{beforeNetwork:e.beforeNetwork});await stopped();}
  if(stage==='detail-before-stream'){await provider.request('activity',{accessToken:'s',activityId:'9001'},{beforeNetwork:e.beforeNetwork});await stopped();}
  await e.beforeNetwork({operation:'activity',objectId:'9001'});
  if(stage==='charge')await stopped();
  const capture=captureStravaConnection('a',await tx.get("SELECT * FROM strava_tokens WHERE user_id='a'"));
  await db.withPlanningMutation('a',async query=>{
    await persistStravaActivity(query,'a',raw(9001),capture);
    if(stage==='canonical-before-cas')await stopped();
    await e.finish(query);
    if(stage==='cas-before-commit')await stopped();
  });if(stage==='commit')await stopped();throw Error('unexpected child stage');
}
async function crashChecks(f,url){
  for(const stage of ['claim','reservation','charge','between-token-detail','detail-before-stream','canonical-before-cas','cas-before-commit','commit']){
    await clear(f);await budget(f);await hint(f);
    const baseline=await snapshot(f.tx),childProcess=fork(__filename,['--child',stage,url],{execPath:process.execPath,env:{PATH:process.env.PATH,NODE_PATH:process.env.NODE_PATH,NODE_ENV:'test'},stdio:['ignore','ignore','pipe','ipc']});
    let stderr='';childProcess.stderr.on('data',d=>{stderr+=d;});
    const exit=new Promise(resolve=>childProcess.once('exit',(code,signal)=>resolve({code,signal})));
    let deadline;const marker=await Promise.race([new Promise((resolve,reject)=>{childProcess.once('message',resolve);childProcess.once('error',reject);childProcess.once('exit',()=>reject(Error('child ended early '+stderr)));}),new Promise((_,reject)=>{deadline=setTimeout(()=>{childProcess.kill('SIGKILL');reject(Error('child checkpoint timeout '+stderr));},7000);})]).finally(()=>clearTimeout(deadline));
    assert.equal(marker.stage,stage);childProcess.kill('SIGKILL');assert.equal((await exit).signal,'SIGKILL');await tick(30);
    const after=await snapshot(f.tx),row=await job(f,'9001');
    if(stage==='commit'){assert.equal(row.state,'DONE');assert.equal(after.runs.length,baseline.runs.length+1);assert.equal(Number(after.users.find(r=>r.id==='a').planning_input_revision),1);}
    else{
      assert.equal(row.state,'LEASED');assert.equal(Number(row.attempts),['claim','reservation'].includes(stage)?0:1);
      assert.equal(row.last_fetch_at===null,['claim','reservation','between-token-detail'].includes(stage));
      for(const name of Object.keys(baseline).filter(n=>n!=='provider_event_jobs'))assert.deepEqual(after[name],baseline[name],stage+' atomic rollback '+name);
      await f.tx.run('UPDATE provider_event_jobs SET lease_until=?',[new Date(Date.now()-1).toISOString()]);
      const [recovered]=await f.queue.claim();assert.ok(recovered,'expired killed lease recoverable');
    }
    console.log('PASS real child SIGKILL boundary',stage);
  }
}
async function postgres(){
  const url=new URL('postgresql://forge_background_test@127.0.0.1:55449/forge_background_test'),admin=new Pool({connectionString:url.href}),name='forge_w2_concurrency_'+crypto.randomBytes(8).toString('hex');let created=false,f;
  try{assert.deepEqual((await admin.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0],{db:'forge_background_test',role:'forge_background_test',port:55449});await admin.query(`CREATE DATABASE "${name}"`);created=true;url.pathname='/'+name;f=await fixture('postgres',url.href);await databaseChecks(f,url.href);await queueConcurrency(f,url.href);await crashChecks(f,url.href);}
  finally{if(f)await f.close();if(created){await admin.query(`DROP DATABASE "${name}"`);console.log('Removed owned child',name);}await admin.end();}
}
if(process.argv[2]==='--child')child(process.argv[3],process.argv[4]).catch(e=>{console.error(e);process.exitCode=1;});
else(async()=>{await sqliteCancellation();if(process.argv.includes('--postgres'))await postgres();console.log('STRAVA WORKER CONCURRENCY GATE OK; W3 orchestration remains absent');})().catch(e=>{console.error(e);process.exitCode=1;});
