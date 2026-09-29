'use strict';
// Real authenticated route handlers and current SQLite DDL; provider boundary is synthetic.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {sqliteFixture,seed,raw,snapshot}=require('./backgroundRunPersistence.smoke');
process.env.JWT_SECRET='synthetic-background-route-only';
process.env.DATABASE_URL='postgresql://invalid@127.0.0.1:1/no_external_database';
function encrypted(token){const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',crypto.createHash('sha256').update(process.env.JWT_SECRET).digest(),iv);const value=Buffer.concat([cipher.update(JSON.stringify({token})),cipher.final()]);return JSON.stringify({v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),content:value.toString('base64')});}
async function main(){
  const f=await sqliteFixture();let server;const realFetch=global.fetch;
  try{
    await seed(f);
    const dbPath=require.resolve('../src/db');
    require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{dbGet:f.tx.get,dbAll:f.tx.all,dbRun:f.tx.run,withPlanningInputMutation:f.mutate,withUserMutation:f.mutate,runWithUserContext:(_id,next)=>next()}};
    await f.tx.run("UPDATE strava_tokens SET access_token=?,refresh_token=?,expires_at=4102444800 WHERE user_id='a'",[encrypted('synthetic-access'),encrypted('synthetic-refresh')]);
    let activities=[raw(900,{routeCoords:[{lat:1,lon:1},{lat:1.01,lon:1.01}]})],held;
    global.fetch=async(url,options)=>{
      assert.match(String(url),/^https:\/\/www\.strava\.com\/api\/v3\/athlete\/activities\?/,'no unapproved external call');
      if(held)await held;
      return {ok:true,status:200,json:async()=>activities.map(activity=>({...activity,routeCoords:[{lat:1,lon:1},{lat:1.01,lon:1.01}]}))};
    };
    const express=require('express'),jwt=require('jsonwebtoken'),app=express();app.use(express.json());
    app.use('/strava',require('../src/routes/strava'));app.use('/runs',require('../src/routes/runs'));app.use('/import',require('../src/routes/import'));
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    async function request(method,url,owner='a',payload){
      const response=await realFetch(`http://127.0.0.1:${server.address().port}${url}`,{method,headers:{'Content-Type':'application/json',...(owner?{Authorization:`Bearer ${jwt.sign({id:owner},process.env.JWT_SECRET)}`}:{})},...(payload?{body:JSON.stringify(payload)}:{})});
      return {status:response.status,body:await response.json()};
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
    const reconnectSnapshot=await snapshot(f.tx);release();assert.equal((await pending).status,500);assert.deepEqual(await snapshot(f.tx),reconnectSnapshot);
    assert.notEqual(prior.connection_generation,'replacement');
    activities=[raw(900),raw(901)];
    const afterReconnect=await request('POST','/strava/sync');assert.equal(afterReconnect.status,200);assert.deepEqual(afterReconnect.body,{imported:0,enriched:0,total:2});
    assert.equal(await f.tx.get("SELECT id FROM runs WHERE id='strava_a_900'"),undefined,'new authenticated generation cannot resurrect user-deleted aliases');
    console.log('BACKGROUND RUN ROUTES OK: authenticated sync/replay/owned delete/all aliases/reconnect fence');
  }finally{global.fetch=realFetch;if(server)await new Promise(resolve=>server.close(resolve));f.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
