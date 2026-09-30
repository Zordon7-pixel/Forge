'use strict';
// Real authenticated route handlers and current SQLite DDL; provider boundary is synthetic.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {sqliteFixture,seed,raw,snapshot}=require('./backgroundRunPersistence.smoke');
process.env.JWT_SECRET='synthetic-background-route-only';
process.env.STRAVA_CLIENT_ID='123';process.env.STRAVA_CLIENT_SECRET='synthetic-only';process.env.STRAVA_REDIRECT_URI='https://forge.example.invalid/callback';
process.env.DATABASE_URL='postgresql://invalid@127.0.0.1:1/no_external_database';
function encrypted(token){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',crypto.createHash('sha256').update(process.env.JWT_SECRET).digest(),iv);const value=Buffer.concat([cipher.update(JSON.stringify({token})),cipher.final()]);return JSON.stringify({v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),content:value.toString('base64')});}
async function main(){
  const f=await sqliteFixture();let server;const realFetch=global.fetch;
  try{
    await seed(f);
    const dbPath=require.resolve('../src/db');
    let quotaClock=null;
    const transaction=async fn=>{f.exec('BEGIN IMMEDIATE');try{const result=await fn({...f.tx,run:(sql,p)=>sql.startsWith('SET LOCAL ')?{changes:0}:f.tx.run(sql,p),get:(sql,p)=>sql==='SELECT clock_timestamp() AS now'&&quotaClock
      ?{now:new Date(quotaClock.wall+(quotaClock.mono===null?0:performance.now()-quotaClock.mono)).toISOString()}
      :f.tx.get(sql.replace('clock_timestamp()',"strftime('%Y-%m-%dT%H:%M:%fZ','now')"),p)});f.exec('COMMIT');return result;}catch(e){f.exec('ROLLBACK');throw e;}};
    const owner=(id,fn,options)=>{assert.equal(options.userLock,'update');return transaction(async tx=>{assert.ok(await tx.get('SELECT id FROM users WHERE id=?',[id]));return fn(tx);});};
    require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{dbGet:f.tx.get,dbAll:f.tx.all,dbRun:f.tx.run,withPlanningInputMutation:f.mutate,withUserMutation:owner,withTransaction:transaction,runWithUserContext:(_id,next)=>next()}};
    await f.tx.run("UPDATE strava_tokens SET access_token=?,refresh_token=?,expires_at=4102444800 WHERE user_id='a'",[encrypted('synthetic-access'),encrypted('synthetic-refresh')]);
    let activities=[raw(900,{routeCoords:[{lat:1,lon:1},{lat:1.01,lon:1.01}]})],held,includeRoute=true,tokenPayload,streamOk=false;const providerTimes=[];
    global.fetch=async(url,options)=>{
      if(quotaClock&&quotaClock.mono===null)quotaClock.mono=performance.now();
      providerTimes.push({url:String(url),at:Date.now(),budget:quotaClock?{...await f.tx.get("SELECT observed_quarter_cap,observed_day_cap,quarter_used,day_used,quarter_start,day_start,paused FROM background_sync_control WHERE id='strava'")}:null});
      if(String(url)==='https://www.strava.com/oauth/token')return new Response(JSON.stringify(tokenPayload));
      if(/\/activities\/\d+\/streams\?/.test(String(url)))return new Response(JSON.stringify(streamOk?{latlng:{data:[[1,1],[1.01,1.01]]}}:{}),{status:streamOk?200:503});
      assert.match(String(url),/^https:\/\/www\.strava\.com\/api\/v3\/athlete\/activities\?/,'no unapproved external call');
      if(held)await held;
      return new Response(JSON.stringify(activities.map(activity=>({...activity,...(includeRoute?{routeCoords:[{lat:1,lon:1},{lat:1.01,lon:1.01}]}:{})}))));
    };
    const express=require('express'),jwt=require('jsonwebtoken'),app=express();app.use(express.json());
    app.use('/strava',require('../src/routes/strava'));app.use('/runs',require('../src/routes/runs'));app.use('/import',require('../src/routes/import'));
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    async function request(method,url,owner='a',payload){
      // Independent sequential import witnesses start with available quota.
      // Provider spacing/capacity is exercised without resets in its own gate.
      if(url==='/strava/sync'||url.startsWith('/strava/callback'))await f.tx.run("UPDATE background_sync_control SET next_allowed_at='2020-01-01T00:00:00Z' WHERE id='strava'");
      const response=await realFetch(`http://127.0.0.1:${server.address().port}${url}`,{method,headers:{'Content-Type':'application/json',...(owner?{Authorization:`Bearer ${jwt.sign({id:owner},process.env.JWT_SECRET)}`}:{})},...(payload?{body:JSON.stringify(payload)}:{})});
      return {status:response.status,body:response.headers.get('content-type')?.includes('application/json')?await response.json():await response.text(),headers:response.headers};
    }
    assert.equal((await request('POST','/strava/sync',null)).status,401);
    const saved=await request('POST','/strava/sync');assert.equal(saved.status,200);assert.deepEqual(saved.body,{imported:1,enriched:0,total:1});
    const repeat=await request('POST','/strava/sync');assert.equal(repeat.status,200);assert.deepEqual(repeat.body,{imported:0,enriched:0,total:1});
    assert.equal((await f.tx.all('SELECT * FROM activity_notification_events')).length,1);
    assert.equal((await f.tx.all('SELECT * FROM user_notifications')).length,1,'no postcommit legacy alert');
    const notices=(await f.tx.all('SELECT * FROM activity_notification_events')).length;
    for(const source of ['apple_health','strava','manual']){
      const response=await request('POST','/import/health','a',{workouts:[{source,sourceWorkoutId:`untrusted-${source}`,type:'running',date:'2020-04-01',startDate:'2020-04-01T12:00:00Z',distanceMiles:2,durationSeconds:1200,eligible:true,providerType:'Run'}]});
      assert.equal(response.status,200);assert.deepEqual(response.body.errors,[]);assert.equal(response.body.imported+response.body.skipped,1);
      assert.equal((await f.tx.all('SELECT * FROM activity_notification_events')).length,notices,'client source/eligible fields never grant provider trust');
    }
    const start=new Date().toISOString(),apple={source:'apple_health',sourceWorkoutId:'apple-linked',type:'running',date:start.slice(0,10),startDate:start,distanceMiles:10,durationSeconds:3600};
    const appleSaved=await request('POST','/import/health','a',{workouts:[apple]});assert.deepEqual(appleSaved.body.errors,[]);
    const appleRun=await f.tx.get("SELECT * FROM runs WHERE health_source_workout_id='apple-linked'");assert.ok(appleRun);
    activities=[raw(930,{distance:16093.44,moving_time:3600,elapsed_time:3600,start_date:start})];
    assert.equal((await request('POST','/strava/sync')).body.imported,0,'trusted Strava attaches to Apple-first canonical row');
    const appleEvent=await f.tx.get('SELECT * FROM activity_notification_events WHERE run_id=?',[appleRun.id]);assert.ok(appleEvent);
    await f.tx.run("INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds,health_source,health_start_at,shoe_id,perceived_effort,notes) VALUES('forge-late','a',?,'easy',10,3600,'forged_hybrid',?,'explicit-shoe',4,'athlete note')",[start.slice(0,10),start]);
    const merged=await request('POST','/import/health','a',{workouts:[apple]});assert.deepEqual(merged.body.errors,[]);
    assert.equal(await f.tx.get('SELECT id FROM runs WHERE id=?',[appleRun.id]),undefined,'real import consolidation removes duplicate');
    assert.equal((await f.tx.get("SELECT run_id FROM provider_activity_links WHERE object_id='930'")).run_id,'forge-late');
    assert.equal((await f.tx.get('SELECT run_id FROM activity_notification_events WHERE id=?',[appleEvent.id])).run_id,'forge-late');
    const kept=await f.tx.get("SELECT shoe_id,perceived_effort,notes FROM runs WHERE id='forge-late'");assert.equal(kept.shoe_id,'explicit-shoe');assert.equal(kept.perceived_effort,4);assert.match(kept.notes,/athlete note/);
    activities=[raw(900)];
    const before=await snapshot(f.tx);assert.equal((await request('DELETE','/runs/strava_a_900','b')).status,404);assert.deepEqual(await snapshot(f.tx),before);
    await f.tx.run("INSERT INTO provider_activity_links(user_id,provider,object_id,run_id,state) VALUES('a','strava','901','strava_a_900','ACTIVE')");
    assert.equal((await request('DELETE','/runs/strava_a_900')).status,200);
    assert.ok((await f.tx.all("SELECT * FROM provider_activity_links WHERE object_id IN ('900','901')")).every(row=>row.state==='USER_DELETED' && row.run_id===null));
    activities=[raw(900),raw(901)];assert.deepEqual((await request('POST','/strava/sync')).body,{imported:0,enriched:0,total:2});
    assert.equal(await f.tx.get("SELECT id FROM runs WHERE id='strava_a_900'"),undefined);
    // Provider response started under one generation may not commit after reconnect.
    let release,entered;held=new Promise(resolve=>{release=resolve;});const seen=new Promise(resolve=>{entered=resolve;});
    const priorFetch=global.fetch;global.fetch=async(...args)=>{entered();return priorFetch(...args);};activities=[raw(902)];
    const pending=request('POST','/strava/sync');await seen;
    const prior=await f.tx.get("SELECT * FROM strava_tokens WHERE user_id='a'");
    await f.tx.run("UPDATE strava_tokens SET connection_generation='replacement' WHERE user_id='a'");
    await f.tx.run("INSERT INTO strava_ingress_bindings(id,user_id,athlete_id) VALUES('replacement','a','123')");
    const reconnectSnapshot=await snapshot(f.tx);release();assert.equal((await pending).status,503);assert.deepEqual(await snapshot(f.tx),reconnectSnapshot);
    assert.notEqual(prior.connection_generation,'replacement');
    activities=[raw(900),raw(901)];
    const afterReconnect=await request('POST','/strava/sync');assert.equal(afterReconnect.status,200);assert.deepEqual(afterReconnect.body,{imported:0,enriched:0,total:2});
    assert.equal(await f.tx.get("SELECT id FROM runs WHERE id='strava_a_900'"),undefined,'new authenticated generation cannot resurrect user-deleted aliases');
    held=null;includeRoute=false;activities=[raw(940)];
    const optional=await request('POST','/strava/sync');assert.equal(optional.status,200);assert.equal(optional.body.imported,1,'optional stream provider failure cannot discard valid core run');
    tokenPayload={access_token:'synthetic-refreshed',refresh_token:'synthetic-refresh',expires_at:Math.floor(Date.now()/1000)+3600,athlete:{id:123}};
    await f.tx.run("UPDATE strava_tokens SET expires_at=1 WHERE user_id='a'");
    // Independent fresh reduced-budget witness: do not reset between token,
    // list and streams; every real request must consume the same stored caps.
    await f.tx.run("UPDATE background_sync_control SET observed_quarter_cap=10,observed_day_cap=100,quarter_used=0,day_used=0 WHERE id='strava'");
    activities=[raw(941)];streamOk=true;const sequenceStart=providerTimes.length;
    const realTimer=global.setTimeout;let earlyWakes=0,sequential;
    try {
      // Freeze the initial DB instant immediately before UTC midnight, then
      // advance with monotonic elapsed time from the first provider boundary.
      // No counter reset occurs between requests; real SQLite transactions run.
      quotaClock={wall:Math.floor(Date.now()/86400000)*86400000-500,mono:null};
      global.setTimeout=(fn,ms,...args)=>{
        if(ms>100&&ms<=1000&&earlyWakes<4){earlyWakes++;return realTimer(fn,0,...args);}
        return realTimer(fn,ms,...args);
      };
      sequential=await request('POST','/strava/sync');
    } finally {global.setTimeout=realTimer;quotaClock=null;}
    assert.equal(earlyWakes,4,'real HTTP sequence includes deliberately early spacing wakeups');
    assert.equal(sequential.status,200);assert.deepEqual(sequential.body,{imported:1,enriched:0,total:1});
    const sequence=providerTimes.slice(sequenceStart);assert.equal(sequence.length,3);assert.match(sequence[0].url,/oauth\/token$/);assert.match(sequence[1].url,/athlete\/activities/);assert.match(sequence[2].url,/\/streams\?/);
    assert.ok(sequence[1].at-sequence[0].at>=990&&sequence[2].at-sequence[1].at>=990,'expired-token manual sync actually reserves token/list/streams separately with one-second spacing');
    assert.ok(await f.tx.get("SELECT id FROM runs WHERE id='strava_a_941'"),'normal multi-request path saves valid core');
    for(let i=0;i<sequence.length;i++){
      const budget=sequence[i].budget,prior=sequence[i-1]?.budget;
      assert.equal(budget.observed_quarter_cap,10);assert.equal(budget.observed_day_cap,100);assert.equal(budget.paused,0);
      for(const period of ['quarter','day'])assert.equal(budget[`${period}_used`],prior&&prior[`${period}_start`]===budget[`${period}_start`]?prior[`${period}_used`]+1:1,'each provider call consumes exactly one reservation in its own UTC window');
    }
    assert.notEqual(sequence[0].budget.quarter_start,sequence[1].budget.quarter_start,'real route crosses quarter boundary');
    assert.notEqual(sequence[0].budget.day_start,sequence[1].budget.day_start,'real route crosses day boundary');
    const reducedBudget=await f.tx.get("SELECT observed_quarter_cap,observed_day_cap,quarter_used,day_used,quarter_start,day_start,paused FROM background_sync_control WHERE id='strava'");
    assert.deepEqual({...reducedBudget},sequence[2].budget,'postcommit core save preserves final reduced budget without refunds or global pause');
    const revisionBefore=(await f.tx.get("SELECT planning_input_revision FROM users WHERE id='a'")).planning_input_revision;
    const authStart=await request('GET','/strava/auth?format=json');assert.equal(authStart.status,200);assert.equal(authStart.headers.get('cache-control'),'no-store');
    const state=new URL(authStart.body.url).searchParams.get('state');assert.ok(state);
    tokenPayload={access_token:'synthetic-http-access',refresh_token:'synthetic-http-refresh',expires_at:Math.floor(Date.now()/1000)+3600,athlete:{id:123,firstname:'Synthetic'}};
    const callback=await request('GET',`/strava/callback?state=${encodeURIComponent(state)}&code=synthetic`,null);assert.equal(callback.status,200);assert.match(callback.body,/Strava Connected/);
    const row=await f.tx.get("SELECT * FROM strava_tokens WHERE user_id='a'");assert.equal(row.token_revision,1);assert.notEqual(row.connection_generation,'replacement');assert.ok(row.access_token.startsWith('{'));assert.equal(row.refresh_lease_token,null);
    assert.ok(await f.tx.get('SELECT id FROM strava_ingress_bindings WHERE id=?',[row.connection_generation]));
    assert.equal((await request('GET',`/strava/callback?state=${encodeURIComponent(state)}&code=replay`,null)).status,409);
    assert.equal((await request('GET','/strava/auth?format=json',null)).status,401);
    const badReturnBefore=await f.tx.get("SELECT epoch FROM strava_connection_fences WHERE user_id='a'");
    assert.equal((await request('GET','/strava/auth?format=json&deeplink=invalid')).status,400);assert.deepEqual(await f.tx.get("SELECT epoch FROM strava_connection_fences WHERE user_id='a'"),badReturnBefore);
    const pendingStart=await request('GET','/strava/auth?format=json'),cancelState=new URL(pendingStart.body.url).searchParams.get('state');
    assert.equal((await request('GET',`/strava/callback?state=${encodeURIComponent(cancelState)}&error=access_denied`,null)).status,400);
    assert.equal((await f.tx.get("SELECT connection_generation FROM strava_tokens WHERE user_id='a'")).connection_generation,row.connection_generation);
    assert.equal((await request('DELETE','/strava/disconnect')).status,200);assert.equal(await f.tx.get("SELECT * FROM strava_tokens WHERE user_id='a'"),undefined);assert.ok(await f.tx.get("SELECT epoch FROM strava_connection_fences WHERE user_id='a'"));
    assert.equal((await f.tx.get("SELECT planning_input_revision FROM users WHERE id='a'")).planning_input_revision,revisionBefore,'OAuth/cancel/disconnect never mutate physiological revision');
    assert.equal((await request('POST','/strava/sync')).status,400);
    console.log('PASS actual authenticated OAuth route/state/callback/consumed replay/cancel/disconnect/no physiology; optional enrichment cannot block core save');
    console.log('BACKGROUND RUN ROUTES OK: authenticated sync/replay/owned delete/all aliases/reconnect fence');
  }finally{global.fetch=realFetch;if(server)await new Promise(resolve=>server.close(resolve));f.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
