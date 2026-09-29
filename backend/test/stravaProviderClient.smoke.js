'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const {sqliteFixture,seed}=require('./backgroundRunPersistence.smoke');
const {createStravaProviderClient,BODY_BYTES}=require('../src/services/stravaProviderClient');
async function main(){
  const f=await sqliteFixture();await seed(f);
  let clock=Date.parse('2026-09-29T12:00:01Z'),network=0,inTransaction=false,reply=()=>new Response('[]'),requests=[];
  const tx={...f.tx,get:async(s,p)=>s.includes(" AS now")?{now:new Date(clock).toISOString()}:f.tx.get(s,p)};
  const transaction=async(fn,options)=>{assert.equal(options.skipContextUserGuard,true);assert.equal(inTransaction,false);inTransaction=true;f.exec('BEGIN');
    try{const value=await fn(tx);f.exec('COMMIT');return value;}catch(e){f.exec('ROLLBACK');throw e;}finally{inTransaction=false;}};
  const client=createStravaProviderClient({withTransaction:transaction,dialect:'sqlite',fetchImpl:async(url,options)=>{
    assert.equal(inTransaction,false,'no control transaction during provider IO');network++;requests.push({url,options});return reply(url,options);
  }});
  const request=(op='activities',input={accessToken:'synthetic'},options)=>client.request(op,input,{waitForSpacing:false,...options});
  async function reset(){await f.tx.run("UPDATE background_sync_control SET paused=0,next_allowed_at=?,quarter_start=?,quarter_used=0,day_start=?,day_used=0 WHERE id='strava'",[new Date(clock).toISOString(),new Date(Math.floor(clock/900000)*900000).toISOString(),new Date(Math.floor(clock/86400000)*86400000).toISOString()]);}
  try{
    await reset();await request();assert.equal(network,1);
    await assert.rejects(()=>request(),{code:'STRAVA_QUOTA_UNAVAILABLE'});assert.equal(network,1);
    clock+=1000;await request();assert.equal(network,2);
    assert.equal(requests[0].options.redirect,'error');assert.equal(requests[0].options.headers.Authorization,'Bearer synthetic');assert.ok(!requests[0].url.includes('synthetic'));
    await reset();await f.tx.run("UPDATE background_sync_control SET quarter_used=60 WHERE id='strava'");await assert.rejects(()=>request(),{code:'STRAVA_QUOTA_UNAVAILABLE'});
    clock+=900000;await request();assert.equal((await f.tx.get("SELECT quarter_used FROM background_sync_control")).quarter_used,1);
    await f.tx.run("UPDATE background_sync_control SET day_used=600 WHERE id='strava'");clock+=1000;await assert.rejects(()=>request(),{code:'STRAVA_QUOTA_UNAVAILABLE'});
    clock=Math.floor(clock/86400000)*86400000+86400000+1;await request();assert.equal((await f.tx.get("SELECT day_used FROM background_sync_control")).day_used,1);
    for(const [operation,input] of [['token',{clientId:'s',clientSecret:'s',code:'s'}],['activities',{accessToken:'s'}],['activity',{accessToken:'s',activityId:12}],['streams',{accessToken:'s',activityId:12}],['athlete',{accessToken:'s'}]]){
      await reset();reply=()=>new Response(operation==='activities'?'[]':'{}');const before=network;await request(operation,input);assert.equal(network,before+1);assert.equal((await f.tx.get('SELECT quarter_used FROM background_sync_control')).quarter_used,1);
    }
    await reset();reply=()=>new Response('[]',{headers:{'X-RateLimit-Limit':'100,1000','X-RateLimit-Usage':'59,599'}});await request();clock+=1000;
    reply=()=>new Response('[]',{headers:{'X-RateLimit-Limit':'100,1000','X-RateLimit-Usage':'1,1'}});await request();assert.equal((await f.tx.get('SELECT day_used FROM background_sync_control')).day_used,600,'stale headers cannot refund');
    clock+=1000;await assert.rejects(()=>request(),{code:'STRAVA_QUOTA_UNAVAILABLE'});
    await reset();reply=()=>new Response('[]',{headers:{'X-RateLimit-Limit':'10,100','X-RateLimit-Usage':'1,1'}});await request();clock+=86400000;
    await assert.rejects(()=>request(),{code:'STRAVA_PROVIDER_PAUSED'});assert.equal((await f.tx.get('SELECT paused FROM background_sync_control')).paused,1,'lower grant cannot be forgotten at UTC rollover');
    for(const headers of [{'X-RateLimit-Limit':'nonsense'},{'Retry-After':'-1'},{'Retry-After':'999999999'},{'X-RateLimit-Usage':'false,false'}]){
      await reset();reply=()=>new Response('[]',{headers});await request();clock+=1000;await assert.rejects(()=>request(),{code:'STRAVA_QUOTA_UNAVAILABLE'});
    }
    await reset();reply=()=>new Response('{}',{status:429,headers:{'Retry-After':'120'}});await assert.rejects(()=>request(),{status:429});clock+=1000;await assert.rejects(()=>request(),{code:'STRAVA_QUOTA_UNAVAILABLE'});
    for(const body of ['{}','null','"bad"','[','[null]','[false]',JSON.stringify(Array(21).fill({}))]){
      await reset();reply=()=>new Response(body);await assert.rejects(()=>request(),{code:'STRAVA_RESPONSE_INVALID'});
    }
    await reset();reply=()=>new Response(' '.repeat(BODY_BYTES+1));await assert.rejects(()=>request(),{code:'STRAVA_RESPONSE_TOO_LARGE'});
    await reset();reply=()=>{throw new Error('synthetic transport unavailable');};await assert.rejects(()=>request());assert.equal((await f.tx.get('SELECT quarter_used FROM background_sync_control')).quarter_used,1,'uncertain transport not refunded');
    await reset();let entered,release;const seen=new Promise(r=>entered=r),held=new Promise(r=>release=r);reply=async()=>{entered();return held;};
    const abort=new AbortController(),pending=request('activities',{accessToken:'s'},{signal:abort.signal});await seen;abort.abort();await assert.rejects(()=>pending,{code:'STRAVA_REQUEST_ABORTED'});release(new Response('[]'));
    await new Promise(r=>setImmediate(r));assert.equal(inTransaction,false);
    await reset();let first=true;const oldSeen=new Promise(r=>entered=r),oldHeld=new Promise(r=>release=r);
    reply=async()=>{if(first){first=false;entered();return oldHeld;}return new Response('[]');};
    const oldResponse=request();await oldSeen;clock+=86400000;await reset();await request();
    release(new Response('[]',{headers:{'X-RateLimit-Limit':'100,1000','X-RateLimit-Usage':'99,999'}}));await oldResponse;
    assert.equal((await f.tx.get('SELECT quarter_used FROM background_sync_control')).quarter_used,1,'old-window usage never contaminates successor counters');
    assert.equal((await f.tx.get('SELECT day_used FROM background_sync_control')).day_used,1);
    await reset();first=true;const staleSeen=new Promise(r=>entered=r),staleHeld=new Promise(r=>release=r);
    reply=async()=>{if(first){first=false;entered();return staleHeld;}return new Response('[]',{headers:{'X-RateLimit-Limit':'10,100','X-RateLimit-Usage':'1,1'}});};
    const stale=request();await staleSeen;clock+=1000;await request();clock+=86400000;
    release(new Response('[]',{headers:{'X-RateLimit-Limit':'100,1000','X-RateLimit-Usage':'0,0'}}));await stale;
    await assert.rejects(()=>request(),{code:'STRAVA_PROVIDER_PAUSED'});
    assert.equal((await f.tx.get('SELECT paused FROM background_sync_control')).paused,1,'late larger-grant response cannot unpause a smaller grant');
    // Real database time, no clock jumps or reservation resets between calls.
    clock=Date.now();await reset();const times=[],reservationTimes=[];let reservationAttempts=0;
    const sequential=createStravaProviderClient({dialect:'sqlite',withTransaction:async fn=>{
      reservationAttempts++;
      f.exec('BEGIN');try{const value=await fn(f.tx);f.exec('COMMIT');return value;}catch(e){f.exec('ROLLBACK');throw e;}
    },fetchImpl:async(_url,options)=>{times.push(Date.now());reservationTimes.push(Date.parse((await f.tx.get('SELECT next_allowed_at FROM background_sync_control')).next_allowed_at)-1000);return new Response(options.method==='POST'?'{}':_url.includes('/athlete/activities')?'[]':'{}');}});
    const realTimer=global.setTimeout;let earlyRemaining=0,earlyWakes=0;
    try {
      global.setTimeout=(fn,ms,...args)=>{
        if(ms>0&&ms<=1000&&earlyRemaining>0){earlyRemaining--;earlyWakes++;return realTimer(fn,0,...args);}
        return realTimer(fn,ms,...args);
      };
      await sequential.request('token',{clientId:'s',clientSecret:'s',refreshToken:'s'});
      earlyRemaining=3;await sequential.request('activities',{accessToken:'s'});
      earlyRemaining=3;await sequential.request('activity',{accessToken:'s',activityId:12});
    } finally {global.setTimeout=realTimer;}
    assert.equal(earlyWakes,6,'actual module handles repeatedly premature spacing wakeups');
    assert.equal(reservationAttempts,5,'early timer wakes do not add database reservation retries');
    assert.equal(times.length,3);assert.ok(times[1]-times[0]>=990&&times[2]-times[1]>=990,'reservation timestamps enforce at least one second (allow network invocation scheduling jitter)');
    assert.ok(reservationTimes[1]-reservationTimes[0]>=1000&&reservationTimes[2]-reservationTimes[1]>=1000,'persisted reservation times have no sub-second tolerance');
    assert.equal((await f.tx.get('SELECT quarter_used FROM background_sync_control')).quarter_used,3);
    const waitAbort=new AbortController(),beforeAbort=times.length;
    const waiting=sequential.request('activities',{accessToken:'s'},{signal:waitAbort.signal});setTimeout(()=>waitAbort.abort(),20);
    await assert.rejects(()=>waiting,{code:'STRAVA_REQUEST_ABORTED'});assert.equal(times.length,beforeAbort,'spacing cancellation does not issue a provider call');
    const attemptsBefore=reservationAttempts;
    const competing=sequential.request('activities',{accessToken:'s'});
    await new Promise(resolve=>realTimer(resolve,20));
    await f.tx.run('UPDATE background_sync_control SET next_allowed_at=?',[new Date(Date.now()+2000).toISOString()]);
    await assert.rejects(()=>competing,{code:'STRAVA_QUOTA_UNAVAILABLE'});
    assert.equal(reservationAttempts-attemptsBefore,2,'changed not-before after waiting fails after exactly one re-reservation');
    assert.equal(times.length,beforeAbort,'contention never leaks another provider request');
    clock=Date.now();
    await reset();let cancelled=false;reply=()=>new Response(new ReadableStream({cancel(){cancelled=true;}}));
    const began=Date.now();await assert.rejects(()=>request(),{code:'STRAVA_REQUEST_TIMEOUT'});assert.ok(Date.now()-began>=19500&&Date.now()-began<24000);assert.equal(cancelled,true,'20s deadline cancels hanging body reader, not just response headers');
    console.log('STRAVA PROVIDER CLIENT OK: actual SQLite quota/UTC/no-refund/all request classes/headers/persistent lower-grant pause/body/cancellation; no provider IO');
  }finally{f.close();}
}
async function postgres(){
  const {Pool}=require('pg'),schema=require('../src/db/backgroundSyncSchema'),url=new URL('postgresql://forge_background_test@127.0.0.1:55449/forge_background_test');
  const admin=new Pool({connectionString:url.href}),name='forge_b1cr_'+crypto.randomBytes(8).toString('hex');let pool,created=false;
  try{
    assert.deepEqual((await admin.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0],{db:'forge_background_test',role:'forge_background_test',port:55449});
    await admin.query(`CREATE DATABASE "${name}"`);created=true;url.pathname='/'+name;pool=new Pool({connectionString:url.href});
    const base=fs.readFileSync(path.join(__dirname,'../src/db/schema.pg.sql'),'utf8');
    for(const table of ['users','runs','strava_tokens','push_subscriptions','user_notifications'])await pool.query(base.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))[0]);
    await pool.query("INSERT INTO users(id,name,email,password_hash) VALUES('a','synthetic','a@example.invalid','s')");await schema.migrateBackgroundSyncPostgres(pool);
    const transaction=async(fn,options)=>{assert.deepEqual(options,{skipContextUserGuard:true});const c=await pool.connect();const q=(s,p=[])=>{let i=0;return c.query(s.replace(/\?/g,()=>`$${++i}`),p);};
      try{await c.query('BEGIN');const r=await fn({get:async(s,p)=>(await q(s,p)).rows[0],run:async(s,p)=>({changes:(await q(s,p)).rowCount})});await c.query('COMMIT');return r;}
      catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
    let release,entered;const seen=new Promise(r=>entered=r),held=new Promise(r=>release=r);
    const first=createStravaProviderClient({withTransaction:transaction,fetchImpl:async()=>{entered();await held;return new Response('[]');}});
    const second=createStravaProviderClient({withTransaction:transaction,fetchImpl:async()=>{throw Error('must not reach second provider');}});
    const owner=await pool.connect();try{
      await owner.query('BEGIN');await owner.query("SELECT id FROM users WHERE id='a' FOR UPDATE");
      const pending=first.request('activities',{accessToken:'synthetic'});await seen;
      await assert.rejects(()=>second.request('activities',{accessToken:'synthetic'},{waitForSpacing:false}),{code:'STRAVA_QUOTA_UNAVAILABLE'});
      assert.equal((await pool.query('SELECT quarter_used FROM background_sync_control')).rows[0].quarter_used,1);
      release();await pending;await owner.query('ROLLBACK');
    }finally{await owner.query('ROLLBACK');owner.release();}
    // Actual control contention rejects quickly; no owner lock is ever acquired.
    const blocker=await pool.connect();try{
      await blocker.query('BEGIN');await blocker.query("SELECT id FROM background_sync_control WHERE id='strava' FOR UPDATE");
      const began=Date.now();await assert.rejects(()=>second.request('activities',{accessToken:'s'}),{code:'55P03'});assert.ok(Date.now()-began<1000);
    }finally{await blocker.query('ROLLBACK');blocker.release();}
    console.log('PASS PostgreSQL separate clients: one global reservation/no network lock/held owner independence/control lock deadline');
  }finally{if(pool)await pool.end();if(created){await admin.query(`DROP DATABASE "${name}"`);console.log('Removed owned child '+name);}await admin.end();}
}
(async()=>{await main();if(process.argv.includes('--postgres'))await postgres();})().catch(e=>{console.error(e);process.exitCode=1;});
