'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),{fork}=require('node:child_process'),{Pool}=require('pg');
const {fixture,hint,job,adapter,settings,barrier}=require('./stravaWorkerPrimitives.smoke');
const {activity,response,prepare,worker}=require('./stravaEventWorker.smoke');
const {snapshot}=require('./backgroundRunPersistence.smoke');
const {createStravaEventWorker}=require('../src/services/stravaEventWorker');
const {createWorkerDatabase}=require('../src/db/backgroundSyncWorker');
const {createStravaEventQueue}=require('../src/services/stravaEventQueue');
const tick=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function scheduler(){
  const f=await fixture('sqlite');let claims=0,closed=false;
  const db={...f.db,transaction:async(fn,options)=>{claims++;return f.db.transaction(fn,options);},close:async()=>{closed=true;await f.db.close();}};
  const w=createStravaEventWorker({database:db,fetchImpl:()=>assert.fail('no job/network'),env:()=>settings});
  try{w.start();w.start();await tick(1150);assert.ok(claims>=3&&claims<=4,'one initial claim/purge and one polling claim, not two loops');await w.close();const saved=claims;await tick(1050);assert.equal(claims,saved);assert.equal(closed,true);}
  finally{await w.close();await f.close();}
  console.log('PASS scheduler single loop, finite interval, idempotent start/close, no poll after stop');
}
async function child(stage,url){
  const u=new URL(url);assert.equal(u.hostname,'127.0.0.1');assert.equal(u.port,'55449');assert.equal(u.username,'forge_background_test');assert.match(u.pathname,/^\/forge_w3_lifecycle_[a-f0-9]{16}$/);
  const pool=new Pool({connectionString:url});assert.deepEqual((await pool.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0],{db:u.pathname.slice(1),role:'forge_background_test',port:55449});await pool.end();
  const original=createWorkerDatabase({connectionString:url});
  const stopped=async()=>{process.send({stage});await new Promise(()=>{});};
  const db={...original,withPlanningMutation:async(userId,fn,options)=>{
    const result=await original.withPlanningMutation(userId,async tx=>{
      const run=tx.run;tx.run=async(s,p)=>{const result=await run(s,p);
        if(stage==='canonical'&&s.startsWith('INSERT INTO runs'))await stopped();
        if(stage==='cas'&&s.startsWith('UPDATE provider_event_jobs SET state='))await stopped();
        return result;};return fn(tx);
    },options);
    if(stage==='commit')await stopped();return result;
  }};
  const w=createStravaEventWorker({database:db,env:()=>settings,fetchImpl:async()=>{
    if(stage==='response')await stopped();return response(activity());
  }});
  await w.runOnce();throw Error('missing crash boundary');
}
async function crashes(f,url){
  for(const stage of ['response','canonical','cas','commit']){
    await f.tx.run('DELETE FROM provider_event_jobs');await hint(f,'9001',1);
    await f.tx.run("UPDATE background_sync_control SET quarter_used=0,day_used=0,next_allowed_at=?",[new Date(Date.now()-1000).toISOString()]);
    const before=await snapshot(f.tx);const childProcess=fork(__filename,['--child',stage,url],{execPath:process.execPath,env:{PATH:process.env.PATH,NODE_PATH:process.env.NODE_PATH,NODE_ENV:'test'},stdio:['ignore','ignore','pipe','ipc']});
    let stderr='';childProcess.stderr.on('data',d=>stderr+=d);const exit=new Promise(resolve=>childProcess.once('exit',(code,signal)=>resolve({code,signal})));let timeout;
    try{
      const marker=await Promise.race([new Promise((resolve,reject)=>{childProcess.once('message',resolve);childProcess.once('exit',()=>reject(Error('child exited before marker '+stderr)));}),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('crash boundary timeout '+stderr)),7000);})]);
      assert.equal(marker.stage,stage);childProcess.kill('SIGKILL');assert.equal((await exit).signal,'SIGKILL');await tick(40);
      const after=await snapshot(f.tx);
      if(stage==='commit'){assert.equal((await job(f,'9001')).state,'DONE');assert.equal(after.runs.length,2);assert.equal(after.activity_notification_events.length,1);assert.equal(Number(after.users.find(x=>x.id==='a').planning_input_revision),1);}
      else{
        for(const table of Object.keys(before).filter(x=>x!=='provider_event_jobs'))assert.deepEqual(after[table],before[table],table);
        const row=await job(f,'9001');assert.equal(row.state,'LEASED');assert.equal(Number(row.attempts),1);assert.ok(row.last_fetch_at);
        await f.tx.run("UPDATE provider_event_jobs SET lease_until=? WHERE object_id='9001'",[new Date(Date.now()-1).toISOString()]);const q=createStravaEventQueue({database:f.db});const reclaimed=await q.claim();assert.equal(reclaimed.length,1);q.close();
      }
      console.log('PASS actual full-orchestrator SIGKILL',stage);
    }finally{clearTimeout(timeout);if(childProcess.exitCode===null&&childProcess.signalCode===null){childProcess.kill('SIGKILL');await exit;}}
  }
}
async function capacity(f,url){
  await f.tx.run('DELETE FROM provider_event_jobs');await hint(f,'9002');await hint(f,'9003');await hint(f,'9004');
  await f.tx.run("UPDATE background_sync_control SET quarter_used=0,day_used=0,next_allowed_at=?",[new Date(Date.now()-1000).toISOString()]);
  let active=0,max=0,calls=0;const release=barrier(),entered=barrier();
  const w=worker(f,async url=>{active++;max=Math.max(max,active);calls++;if(calls===2)entered.resolve();await release.promise;active--;return response(activity({id:new URL(url).pathname.split('/').pop()}));});
  const pending=w.runOnce();await entered.promise;assert.equal(max,2);assert.equal((await f.tx.all("SELECT id FROM provider_event_jobs WHERE state='LEASED'")).length,2);assert.equal((await f.tx.all("SELECT id FROM provider_event_jobs WHERE state='PENDING'")).length,1);release.resolve();const result=await pending;assert.equal(result.length,2);assert.ok(result.every(x=>x.status==='SAVED'));await w.close();
  console.log('PASS actual PG orchestrator active two maximum, third stays durable pending');
}
async function uncertain(f){
  await f.tx.run('DELETE FROM provider_event_jobs');await hint(f,'9900');
  await f.tx.run("UPDATE background_sync_control SET quarter_used=0,day_used=0,next_allowed_at=?",[new Date(Date.now()-1000).toISOString()]);
  const wrapped={connect:async()=>{const client=await f.pool.connect();let canonical=false;return {on:(...a)=>client.on(...a),removeListener:(...a)=>client.removeListener(...a),release:d=>client.release(d),query:async(s,p)=>{const result=await client.query(s,p);if(s.startsWith('INSERT INTO runs'))canonical=true;if(s==='COMMIT'&&canonical)throw Error('synthetic lost actual COMMIT acknowledgement');return result;}};}};
  const db=createWorkerDatabase({pool:wrapped});const w=createStravaEventWorker({database:db,env:()=>settings,fetchImpl:async()=>response(activity({id:'9900'}))});
  try{const result=await w.runOnce();assert.equal(result[0].status,'UNKNOWN');assert.equal((await job(f,'9900')).state,'DONE');assert.ok(await f.tx.get("SELECT id FROM runs WHERE id='strava_a_9900'"));assert.equal((await f.tx.all("SELECT id FROM activity_notification_events WHERE run_id='strava_a_9900'")).length,1);}
  finally{await w.close();}
  console.log('PASS actual PG committed canonical graph with lost acknowledgement remains UNKNOWN, never rescheduled');
}
async function postgres(){
  const base=new URL('postgresql://forge_background_test@127.0.0.1:55449/forge_background_test'),admin=new Pool({connectionString:base.href});const name='forge_w3_lifecycle_'+crypto.randomBytes(8).toString('hex');let created=false,f;
  try{
    assert.deepEqual((await admin.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0],{db:'forge_background_test',role:'forge_background_test',port:55449});await admin.query(`CREATE DATABASE "${name}"`);created=true;base.pathname='/'+name;f=await fixture('postgres',base.href);await prepare(f);await crashes(f,base.href);await uncertain(f);await capacity(f,base.href);
  }finally{if(f)await f.close();if(created){await admin.query(`DROP DATABASE "${name}"`);console.log('Removed owned child',name);}await admin.end();}
}
if(process.argv[2]==='--child')child(process.argv[3],process.argv[4]).catch(error=>{console.error(error);process.exitCode=1;});
else(async()=>{await scheduler();if(process.argv.includes('--postgres'))await postgres();console.log('STRAVA WORKER LIFECYCLE GATE OK — no production activation');})().catch(error=>{console.error(error);process.exitCode=1;});
