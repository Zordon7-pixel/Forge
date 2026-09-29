'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {randomBytes}=require('node:crypto');
const schema=fs.readFileSync(path.join(__dirname,'../src/db/schema.pg.sql'),'utf8');
const startup=fs.readFileSync(path.join(__dirname,'../src/db/index.js'),'utf8');
function baseStatements(){return ['users','runs','lifts','personal_records','strava_tokens','push_subscriptions','user_notifications','run_import_tombstones','activity_import_claims','activity_media','shared_routes','community_posts','plan_adjustment_proposals','activity_likes','activity_comments','training_plans','user_plans'].map(table=>{
  const pattern=new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\s*\\);`);
  const ddl=startup.match(pattern)?.[0] || schema.match(pattern)?.[0];assert.ok(ddl,`actual schema ${table}`);return ddl;
});}
const migration=require('../src/db/backgroundSyncSchema');
const {captureStravaConnection,persistStravaActivity}=require('../src/services/stravaPersistence');
const events=require('../src/services/savedRunEvents');
const {createPlanningInputMutationRunner}=require('../src/lib/planningRevision');
const tables=['runs','provider_activity_links','run_save_eligibility','user_notifications','activity_notification_events','notification_deliveries','personal_records','run_import_tombstones','provider_event_jobs','activity_import_claims'];
const raw=(id,extra={})=>({id:String(id),type:'Run',sport_type:'Run',start_date:new Date().toISOString(),start_date_local:new Date().toISOString(),distance:5000,moving_time:1800,elapsed_time:1800,name:'Synthetic Run',...extra});
function translate(sql){return sql.replace(/to_char\(NOW\(\), 'YYYY-MM-DD'\)/g,'CURRENT_DATE').replace(/\bNOW\(\)/g,'CURRENT_TIMESTAMP').replace(/\s+FOR UPDATE/g,'').replace(/::text/g,'');}
async function sqliteFixture(){
  const native=new DatabaseSync(':memory:');
  native.function('pg_column_size',value=>Buffer.byteLength(String(value)));
  for(const ddl of baseStatements())native.exec(translate(ddl).replace(/id SERIAL PRIMARY KEY/g,'id INTEGER PRIMARY KEY AUTOINCREMENT').replace(/TIMESTAMPTZ/g,'TEXT'));
  native.exec('PRAGMA foreign_keys=ON');
  const tx={};for(const method of ['get','all','run'])tx[method]=async(sql,params=[])=>native.prepare(translate(sql))[method](...params.map(v=>typeof v==='boolean'?Number(v):v));
  const mutate=createPlanningInputMutationRunner(async(userId,callback)=>{
    native.exec('BEGIN');try{assert.ok(await tx.get('SELECT id FROM users WHERE id=?',[userId]));const result=await callback(tx);native.exec('COMMIT');return result;}catch(e){native.exec('ROLLBACK');throw e;}
  });
  return {tx,mutate,migrate:()=>migration.migrateBackgroundSyncSqlite(native),close:()=>native.close(),exec:sql=>native.exec(sql)};
}
async function seed(f){
  await f.tx.run("INSERT INTO users(id,name,email,password_hash) VALUES('a','A','a@example.invalid','synthetic'),('b','B','b@example.invalid','synthetic')");
  await f.tx.run("INSERT INTO strava_tokens(user_id,athlete_id,access_token,refresh_token) VALUES('a',123,'synthetic','synthetic'),('b',456,'synthetic','synthetic')");
  await f.tx.run("INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds,health_source,health_source_workout_id) VALUES('legacy','a','2020-01-01','easy',3,1800,'strava','1')");
  await f.migrate();
  const expected=captureStravaConnection('a',await f.tx.get("SELECT * FROM strava_tokens WHERE user_id='a'"));
  return expected;
}
async function snapshot(tx){const data={};for(const table of tables)data[table]=await tx.all(`SELECT * FROM ${table} ORDER BY 1`);data.users=await tx.all('SELECT id,planning_input_revision FROM users ORDER BY id');return data;}
async function addRun(tx,id,extra={}){
  await tx.run('INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds,health_source,health_start_at,workout_metrics_json,shoe_id) VALUES(?,?,?,?,?,?,?,?,?,?)',[id,extra.owner||'a',new Date().toISOString().slice(0,10),'easy',extra.distance||3.107,1800,extra.source||'forged_hybrid',extra.start||new Date().toISOString(),JSON.stringify(extra.metrics||{}),null]);
}
async function checks(f,dialect){
  const expected=await seed(f),{tx,mutate}=f;
  const save=(activity)=>mutate('a',q=>persistStravaActivity(q,'a',activity,expected));
  const count=async table=>Number((await tx.get(`SELECT count(*) AS n FROM ${table}`)).n);
  await tx.run("INSERT INTO push_subscriptions(id,user_id,endpoint,keys_p256dh,keys_auth,active,disclosure) VALUES('target','a','https://synthetic.invalid/a','synthetic','synthetic',TRUE,'GENERIC'),('inactive','a','https://synthetic.invalid/inactive','synthetic','synthetic',FALSE,'GENERIC'),('other','b','https://synthetic.invalid/other','synthetic','synthetic',TRUE,'GENERIC')");
  const activity=raw(100),first=await save(activity);
  assert.equal(first.imported,1);assert.equal(await count('activity_notification_events'),1);assert.equal(await count('notification_deliveries'),1);
  const initialEvent=await tx.get("SELECT * FROM activity_notification_events WHERE run_id=?",[first.runId]);
  const before=await snapshot(tx);
  const repeat=await save(activity);assert.equal(repeat.imported,0);assert.equal(repeat.enriched,0);
  assert.equal(await count('activity_notification_events'),1);assert.equal(await count('notification_deliveries'),1);
  assert.deepEqual(await tx.all('SELECT * FROM activity_notification_events'),before.activity_notification_events);
  assert.deepEqual(await tx.get('SELECT * FROM runs WHERE id=?',[first.runId]),before.runs.find(row=>row.id===first.runId),'replay preserves stored measurement bytes');
  await tx.run('UPDATE runs SET distance_miles=4,shoe_id=?,workout_metrics_json=? WHERE id=?',['explicit-athlete-shoe',JSON.stringify({correction:'athlete',unknown:null}),first.runId]);
  const corrected=await tx.get('SELECT * FROM runs WHERE id=?',[first.runId]);await save(activity);
  assert.deepEqual(await tx.get('SELECT * FROM runs WHERE id=?',[first.runId]),corrected,'mapped replay does not discard correction/explicit shoe/unknown metrics');
  await tx.run("INSERT INTO push_subscriptions(id,user_id,endpoint,keys_p256dh,keys_auth,active) VALUES('later','a','https://synthetic.invalid/later','s','s',TRUE)");
  await save(activity);assert.equal(await count('notification_deliveries'),1,'later registration does not backfill');
  await tx.run("UPDATE push_subscriptions SET active=FALSE WHERE user_id='a'");
  await save(raw(101));assert.equal(await count('activity_notification_events'),2);assert.equal(await count('notification_deliveries'),1,'no-target inbox remains');
  const invalidCount=await count('activity_notification_events');
  for(const [id,change] of [[102,{start_date:null}],[103,{start_date:'2020-01-01T00:00:00Z'}],[104,{start_date:'invalid'}],[105,{start_date:'2099-01-01T00:00:00Z'}],[106,{sport_type:'UnsupportedRun'}],[107,{type:'Ride',sport_type:'Ride'}]])await save(raw(id,change));
  assert.equal(await count('activity_notification_events'),invalidCount,'unknown/history/future/type cannot create saved intent');
  await addRun(tx,'unknown-created',{distance:20});await tx.run("UPDATE runs SET created_at=NULL WHERE id='unknown-created'");
  const unknownCreated=await save(raw(108,{distance:32186.88}));assert.equal(unknownCreated.runId,'unknown-created');
  assert.equal((await tx.get("SELECT reason FROM run_save_eligibility WHERE run_id='unknown-created'")).reason,'UNKNOWN_START');
  await save(raw(109,{start_date:new Date().toISOString().slice(0,10)+'T24:00:00Z'}));
  assert.equal(await count('activity_notification_events'),invalidCount,'missing persisted creation and malformed provider clock are not now');
  await save(raw(1));assert.equal((await tx.get("SELECT reason FROM run_save_eligibility WHERE run_id='legacy'")).reason,'LEGACY');
  assert.equal(await count('activity_notification_events'),invalidCount);
  await assert.rejects(()=>mutate('a',q=>persistStravaActivity(q,'a',raw(200),{...expected})),{code:'STRAVA_CONNECTION_STALE'});
  await assert.rejects(()=>mutate('b',q=>persistStravaActivity(q,'b',raw(200),expected)),{code:'STRAVA_CONNECTION_STALE'});
  const storedBefore=await snapshot(tx);
  for(const fragment of ['INSERT INTO provider_activity_links','INSERT INTO run_save_eligibility','INSERT INTO user_notifications','INSERT INTO activity_notification_events','INSERT INTO notification_deliveries']) {
    await tx.run("UPDATE push_subscriptions SET active=TRUE WHERE id='target'");
    const baseline=await snapshot(tx);
    await assert.rejects(()=>mutate('a',q=>persistStravaActivity({...q,run:async(sql,p)=>{const result=await q.run(sql,p);if(sql.includes(fragment))throw new Error('synthetic kill point');return result;}},'a',raw(300),expected)),/synthetic kill point/);
    assert.deepEqual(await snapshot(tx),baseline,`rollback ${fragment}`);
  }
  assert.deepEqual((await snapshot(tx)).runs,storedBefore.runs);
  await tx.run("INSERT INTO provider_event_jobs(id,binding_id,object_type,object_id,last_fingerprint,reported_event_time,last_aspect,state,lease_token,lease_until,leased_revision) VALUES('job',?,'activity','301',?,1,'create','LEASED','current','2099-01-01',1)",[expected.generation,'a'.repeat(64)]);
  const baseline=await snapshot(tx);
  await assert.rejects(()=>mutate('a',async q=>{await persistStravaActivity(q,'a',raw(301),expected);const result=await q.run("UPDATE provider_event_jobs SET state='DONE',processed_revision=leased_revision,lease_token=NULL,lease_until=NULL,leased_revision=NULL WHERE id='job' AND lease_token='stale'");if(result.changes!==1)throw new Error('stale final job lease');}),/stale final job lease/);
  assert.deepEqual(await snapshot(tx),baseline,'future B1c caller final CAS rolls back all save artifacts');
  await save(raw(301));
  await mutate('a',async q=>{await retireAndDelete(q,'a',first.runId);});
  assert.equal((await tx.get("SELECT state FROM provider_activity_links WHERE object_id='100'")).state,'USER_DELETED');
  assert.equal((await save(activity)).runId,null,'deleted record cannot resurrect');
  assert.equal((await tx.get('SELECT state FROM activity_notification_events WHERE id=?',[initialEvent.id])).state,'CANCELLED');
  await mergeChecks(f,expected);
  await matchingOwnershipChecks(f,expected);
  console.log(`PASS ${dialect} transactional save/replay/history/targets/rollback/lease-CAS/owner/deletion/merge`);
}
async function matchingOwnershipChecks(f,expected){
  const {tx,mutate}=f;
  const start=new Date().toISOString();
  const enrichment={start_date:start,start_date_local:start,average_heartrate:151,total_elevation_gain:10,perceived_exertion:5,calories:400,
    routeCoords:[{lat:38.9,lon:-77},{lat:38.901,lon:-77.001}]};
  for(const [index,source] of ['apple_health','forged_hybrid'].entries()){
    const distance=8+index,id=`owned-${source}`,foreign=`foreign-${source}`;
    // Identical foreign/owned clocks, distance and duration must not make the
    // owned match ambiguous or permit either enrichment query to cross owners.
    await addRun(tx,foreign,{owner:'b',source,start,distance,metrics:{private:'foreign'}});
    await addRun(tx,id,{source,start,distance,metrics:{kept:'athlete'}});
    await tx.run('UPDATE runs SET route_coords=NULL,elevation_gain=NULL,perceived_effort=NULL,avg_heart_rate=NULL,calories=0,shoe_id=? WHERE id=? AND user_id=?',['explicit-shoe',id,'a']);
    const foreignBefore=await tx.get('SELECT * FROM runs WHERE id=? AND user_id=?',[foreign,'b']);
    const runUpdates=[];
    const saved=await mutate('a',q=>persistStravaActivity({...q,run:async(sql,params)=>{
      if(/UPDATE runs SET/.test(sql))runUpdates.push({sql,params});
      return q.run(sql,params);
    }},'a',raw(8000+index,{...enrichment,distance:distance*1609.34}),expected));
    assert.equal(saved.runId,id,`${source} matches only the owned canonical row`);
    assert.equal(saved.imported,0);assert.equal(saved.enriched,1);
    assert.equal(runUpdates.length,1);assert.match(runUpdates[0].sql,/WHERE id=\? AND user_id=\?/);
    assert.deepEqual(runUpdates[0].params.slice(-2),[id,'a'],'actual enrichment UPDATE binds canonical id and owner');
    const owned=await tx.get('SELECT * FROM runs WHERE id=? AND user_id=?',[id,'a']);
    assert.equal(owned.avg_heart_rate,151);assert.equal(owned.perceived_effort,5);assert.equal(owned.calories,400);
    assert.equal(owned.shoe_id,'explicit-shoe');assert.equal(JSON.parse(owned.workout_metrics_json).kept,'athlete');
    assert.equal(JSON.parse(owned.route_coords).length,2);
    assert.deepEqual(await tx.get('SELECT * FROM runs WHERE id=? AND user_id=?',[foreign,'b']),foreignBefore,'foreign row bytes unchanged by matching and enrichment');
  }
  for(const [index,source] of ['manual','unsupported_source'].entries()){
    const distance=12+index,id=`excluded-${source}`,foreign=`foreign-excluded-${source}`;
    await addRun(tx,id,{source,start,distance,metrics:{kept:'not canonical health'}});
    await addRun(tx,foreign,{owner:'b',source:'apple_health',start,distance,metrics:{private:'foreign'}});
    const ownedBefore=await tx.get('SELECT * FROM runs WHERE id=? AND user_id=?',[id,'a']);
    const foreignBefore=await tx.get('SELECT * FROM runs WHERE id=? AND user_id=?',[foreign,'b']);
    const activityId=8010+index;
    const saved=await mutate('a',q=>persistStravaActivity(q,'a',raw(activityId,{...enrichment,distance:distance*1609.34}),expected));
    assert.equal(saved.runId,`strava_a_${activityId}`,`${source} is not an inferred canonical enrichment target`);
    assert.equal(saved.imported,1);assert.equal(saved.enriched,0);
    assert.deepEqual(await tx.get('SELECT * FROM runs WHERE id=? AND user_id=?',[id,'a']),ownedBefore,'unsupported owned row remains unchanged');
    assert.deepEqual(await tx.get('SELECT * FROM runs WHERE id=? AND user_id=?',[foreign,'b']),foreignBefore,'foreign supported row remains unchanged');
  }
  console.log('PASS real SQL owner/source matching and enrichment with unchanged foreign rows');
}
async function retireAndDelete(q,owner,id){await events.retireSavedRun(q,owner,id);await q.run('DELETE FROM runs WHERE id=? AND user_id=?',[id,owner]);}
async function mergeChecks(f,expected){
  const {tx,mutate}=f;
  await addRun(tx,'forge-match',{source:'forged_hybrid',metrics:{kept:'athlete'}});
  await tx.run("UPDATE runs SET elevation_gain=0 WHERE id='forge-match'");
  // An exact mapping to a canonical row must be created even when enrichment is empty.
  const incoming=raw(400,{distance:5000,calories:0,average_heartrate:null,total_elevation_gain:null});
  const saved=await mutate('a',q=>persistStravaActivity(q,'a',incoming,expected));
  assert.equal(saved.runId,'forge-match');assert.equal(saved.imported,0);
  assert.equal(saved.enriched,0,'zero-enrichment canonical match still establishes durable provider link');
  assert.equal((await tx.get("SELECT run_id FROM provider_activity_links WHERE object_id='400'")).run_id,'forge-match');
  await addRun(tx,'merge-target',{source:'manual'});
  await mutate('a',async q=>{await events.mergeSavedRunReferences(q,'a','forge-match','merge-target');await q.run("DELETE FROM runs WHERE id='forge-match' AND user_id='a'");});
  assert.equal((await tx.get("SELECT run_id FROM provider_activity_links WHERE object_id='400'")).run_id,'merge-target');
  const transferred=await tx.get("SELECT * FROM activity_notification_events WHERE run_id='merge-target'");assert.ok(transferred);
  await mutate('a',async q=>{await events.mergeSavedRunReferences(q,'a','merge-target','legacy');await q.run("DELETE FROM runs WHERE id='merge-target' AND user_id='a'");});
  assert.equal((await tx.get("SELECT reason FROM run_save_eligibility WHERE run_id='legacy'")).reason,'LEGACY');
  assert.equal((await tx.get('SELECT state FROM activity_notification_events WHERE id=?',[transferred.id])).state,'CANCELLED');
  await assert.rejects(()=>mutate('b',q=>events.retireSavedRun(q,'b','legacy')),{code:'SAVED_RUN_OWNER_MISMATCH'});
  const left=await mutate('a',q=>persistStravaActivity(q,'a',raw(500),expected));
  const right=await mutate('a',q=>persistStravaActivity(q,'a',raw(501),expected));
  const le=await tx.get('SELECT * FROM activity_notification_events WHERE run_id=?',[left.runId]);
  const re=await tx.get('SELECT * FROM activity_notification_events WHERE run_id=?',[right.runId]);
  await tx.run("UPDATE notification_deliveries SET state='ACCEPTED',accepted_at=CURRENT_TIMESTAMP WHERE event_id=?",[le.id]);
  const beforeMerge=await snapshot(tx);
  await assert.rejects(()=>mutate('a',async q=>{await events.mergeSavedRunReferences(q,'a',left.runId,right.runId);await q.run('DELETE FROM runs WHERE id=? AND user_id=?',[left.runId,'a']);throw new Error('merge crash');}),/merge crash/);
  assert.deepEqual(await snapshot(tx),beforeMerge,'merge/repoint/cancellation/run deletion is atomic');
  await mutate('a',async q=>{await events.mergeSavedRunReferences(q,'a',left.runId,right.runId);await q.run('DELETE FROM runs WHERE id=? AND user_id=?',[left.runId,'a']);});
  assert.equal((await events.resolveSavedRunEvent(tx,'a',le.id)).id,re.id);
  assert.ok((await tx.all('SELECT state FROM notification_deliveries WHERE event_id=?',[le.id])).every(row=>row.state==='ACCEPTED'));
  await assert.rejects(()=>events.resolveSavedRunEvent(tx,'b',le.id),{code:'SAVED_RUN_ALIAS_OWNER'});
  const third=await mutate('a',q=>persistStravaActivity(q,'a',raw(502),expected));
  const te=await tx.get('SELECT * FROM activity_notification_events WHERE run_id=?',[third.runId]);
  await mutate('a',async q=>{await events.mergeSavedRunReferences(q,'a',right.runId,third.runId);await q.run('DELETE FROM runs WHERE id=? AND user_id=?',[right.runId,'a']);});
  assert.equal((await tx.get('SELECT merged_into FROM activity_notification_events WHERE id=?',[le.id])).merged_into,te.id,'existing inbound alias flattened');
  assert.equal((await events.resolveSavedRunEvent(tx,'a',le.id)).id,te.id);
  await tx.run("INSERT INTO activity_notification_events(id,user_id,notification_id,state,merged_into) VALUES('depth-one','a',?,'MERGED',?),('depth-two','a',?,'MERGED','depth-one'),('depth-three','a',?,'MERGED','depth-two')",[te.notification_id,te.id,te.notification_id,te.notification_id]);
  assert.equal((await events.resolveSavedRunEvent(tx,'a','depth-two')).id,te.id);
  await assert.rejects(()=>events.resolveSavedRunEvent(tx,'a','depth-three'),{code:'SAVED_RUN_ALIAS_DEPTH'});
  const beforeDelete=await snapshot(tx);
  await assert.rejects(()=>mutate('a',async q=>{await retireAndDelete(q,'a',third.runId);throw new Error('delete crash');}),/delete crash/);
  assert.deepEqual(await snapshot(tx),beforeDelete);
  await assert.rejects(()=>mutate('a',q=>q.run("INSERT INTO provider_activity_links(user_id,provider,object_id,run_id,state) VALUES('b','strava','999',?,'ACTIVE')",[third.runId])),/FOREIGN KEY|foreign key/);
  await mutate('a',async q=>{await q.run("UPDATE activity_notification_events SET state='MERGED',run_id=NULL,merged_into=? WHERE id=?",[le.id,te.id]);});
  await assert.rejects(()=>events.resolveSavedRunEvent(tx,'a',le.id),{code:'SAVED_RUN_ALIAS_CYCLE'});
}
async function postgres(){
  const {Pool}=require('pg');const url=new URL('postgresql://forge_background_test@127.0.0.1:55449/forge_background_test');
  const admin=new Pool({connectionString:url.href}),name=`forge_b1b_${randomBytes(8).toString('hex')}`;let pool,created=false;
  try{
    assert.deepEqual((await admin.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0],{db:'forge_background_test',role:'forge_background_test',port:55449});
    await admin.query(`CREATE DATABASE "${name}"`);created=true;url.pathname='/'+name;pool=new Pool({connectionString:url.href});
    for(const ddl of baseStatements())await pool.query(ddl);
    const adapter=client=>{const query=(sql,p=[])=>{let n=0;return client.query(sql.replace(/\?/g,()=>`$${++n}`),p);};return{get:async(s,p)=>(await query(s,p)).rows[0],all:async(s,p)=>(await query(s,p)).rows,run:async(s,p)=>({changes:(await query(s,p)).rowCount})};};
    const tx=adapter(pool),mutate=createPlanningInputMutationRunner(async(owner,callback)=>{const client=await pool.connect();try{await client.query('BEGIN');assert.ok((await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[owner])).rows[0]);const result=await callback(adapter(client));await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}});
    await checks({tx,mutate,migrate:()=>migration.migrateBackgroundSyncPostgres(pool)},'postgres');
    const expected=captureStravaConnection('a',await tx.get("SELECT * FROM strava_tokens WHERE user_id='a'"));
    let release,entered;const held=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
    const first=mutate('a',async q=>{entered();await held;return persistStravaActivity(q,'a',raw(7000),expected);});
    await started;let secondEntered=false;
    const second=mutate('a',async q=>{secondEntered=true;return persistStravaActivity(q,'a',raw(7000),expected);});
    await new Promise(resolve=>setTimeout(resolve,35));assert.equal(secondEntered,false,'real PG owner UPDATE serializes concurrent save');release();
    const results=await Promise.all([first,second]);assert.equal(results.reduce((n,row)=>n+row.imported,0),1);
    assert.equal(Number((await tx.get("SELECT count(*) AS n FROM activity_notification_events WHERE run_id='strava_a_7000'")).n),1);
    let deletedRelease,deletedEntered;const deleteHeld=new Promise(resolve=>{deletedRelease=resolve;}),deleteStarted=new Promise(resolve=>{deletedEntered=resolve;});
    const deleting=mutate('a',async q=>{await retireAndDelete(q,'a','strava_a_7000');deletedEntered();await deleteHeld;});await deleteStarted;
    const replay=mutate('a',q=>persistStravaActivity(q,'a',raw(7000),expected));deletedRelease();await deleting;assert.equal((await replay).runId,null);
    console.log('PASS postgres real concurrent save/delete serialization and no resurrection');
  }finally{if(pool)await pool.end();if(created){await admin.query(`DROP DATABASE "${name}"`);console.log('Removed owned child',name);}await admin.end();}
}
module.exports={sqliteFixture,seed,raw,snapshot};
if(require.main===module)(async()=>{const f=await sqliteFixture();try{await checks(f,'sqlite');}finally{f.close();}if(process.argv.includes('--postgres'))await postgres();console.log('BACKGROUND RUN PERSISTENCE GATE OK');})().catch(error=>{console.error(error);process.exitCode=1;});
