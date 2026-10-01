'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {sqliteFixture,seed}=require('./backgroundRunPersistence.smoke');
const fs=require('node:fs'),path=require('node:path');
function baseStatements(){
  const sources=['../src/db/index.js','../src/db/schema.pg.sql'].map(p=>fs.readFileSync(path.join(__dirname,p),'utf8'));
  return ['users','runs','strava_tokens','push_subscriptions','user_notifications'].map(table=>{
    const re=new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\s*\\);`);
    const ddl=sources.map(s=>s.match(re)?.[0]).find(Boolean);assert.ok(ddl,table);return ddl;
  });
}
const migration=require('../src/db/backgroundSyncSchema');
const {createStravaConnectionService}=require('../src/services/stravaConnectionService');
const {createStravaProviderClient}=require('../src/services/stravaProviderClient');
const settings={JWT_SECRET:'synthetic-connection-service',STRAVA_CLIENT_ID:'123',STRAVA_CLIENT_SECRET:'synthetic',STRAVA_REDIRECT_URI:'https://forge.example.invalid/api/strava/callback'};
const barrier=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function check(f,label){
  await seed(f);const {tx}=f;let clock=Date.now(),handler,inside=0,calls=0;
  // Real shared-client negative responses provide the private status brand.
  // Plain mock Error.status is deliberately no longer revocation authority.
  const authentic={},simulatedRejections=new WeakSet();
  const negative=createStravaProviderClient({dialect:label==='SQLite'?'sqlite':'postgres',withTransaction:fn=>f.owner('b',fn),fetchImpl:async()=>new Response('{}',{status:401})});
  for(const op of ['token','athlete']){
    await tx.run("UPDATE background_sync_control SET next_allowed_at='1970-01-01T00:00:00.000Z',quarter_used=0,day_used=0 WHERE id='strava'");
    try{await negative.request(op,op==='token'?{clientId:'123',clientSecret:'synthetic',refreshToken:'synthetic'}:{accessToken:'synthetic'});}catch(e){assert.equal(e.status,401);authentic[op]=e;}
  }
  const withOwner=async(id,fn,options)=>{assert.equal(options.userLock,'update');return f.owner(id,async q=>{inside++;try{return await fn(q);}finally{inside--;}});};
  const provider={request:async(op,input)=>{assert.equal(inside,0,'provider IO outside owner transaction');calls++;try{return await handler(op,input);}catch(e){if(simulatedRejections.has(e))throw authentic[op];throw e;}}};
  const service=createStravaConnectionService({withUserMutation:withOwner,provider,env:()=>settings,now:()=>clock});
  const payload=(id=123)=>({access_token:'synthetic-access-'+calls,refresh_token:'synthetic-refresh-'+calls,expires_at:Math.floor(clock/1000)+3600,athlete:{id,firstname:'Synthetic'}});
  const start=async()=>service.verify(await service.start('a'));
  const snap=async()=>{const x={};for(const table of ['strava_tokens','strava_connection_fences','strava_ingress_bindings','provider_event_jobs','user_notifications'])x[table]=await tx.all(`SELECT * FROM ${table} ORDER BY 1`);x.users=await tx.all('SELECT id,planning_input_revision FROM users ORDER BY id');return JSON.parse(JSON.stringify(x));};
  const connect=async()=>{handler=()=>payload();const proof=await start();await service.callback(proof,'synthetic-code');return proof;};
  const unavailable=()=>{const e=new Error('synthetic authenticated rejection');simulatedRejections.add(e);return e;};
  const plainBefore=await tx.get("SELECT * FROM strava_tokens WHERE user_id='b'");await service.connection('b');
  const encryptedAfter=await tx.get("SELECT * FROM strava_tokens WHERE user_id='b'");assert.equal(encryptedAfter.connection_generation,plainBefore.connection_generation);assert.equal(Number(encryptedAfter.token_revision),Number(plainBefore.token_revision)+1);assert.ok(encryptedAfter.access_token.startsWith('{'));
  await service.disconnect('a');
  const missingConfig=createStravaConnectionService({withUserMutation:withOwner,provider,env:()=>({...settings,JWT_SECRET:''})});
  const empty=await snap();await assert.rejects(()=>missingConfig.start('a'));assert.deepEqual(await snap(),empty);
  // Actual asynchronous exchange: a separate owner transaction succeeds while IO waits.
  let held=barrier(),entered=barrier();handler=async()=>{entered.resolve();return held.promise;};
  const first=await start(),pending=service.callback(first,'synthetic');await entered.promise;await service.disconnect('a');held.resolve(payload());
  await assert.rejects(()=>pending,{code:'STRAVA_CONNECTION_ATTEMPT_STALE'});assert.equal(await tx.get("SELECT * FROM strava_tokens WHERE user_id='a'"),undefined);
  const consumed=await connect();const installed=await snap();assert.equal(installed.strava_tokens.find(r=>r.user_id==='a').token_revision,1);
  const stored=await tx.get("SELECT * FROM strava_tokens WHERE user_id='a'");assert.ok(stored.access_token.startsWith('{'));assert.ok(!stored.access_token.includes('synthetic-access'));
  await assert.rejects(()=>service.callback(consumed,'synthetic'),{code:'STRAVA_CONNECTION_ATTEMPT_STALE'});assert.deepEqual(await snap(),installed,'lost successful response cannot replay consumption');
  const old=await start(),latest=await start();await assert.rejects(()=>service.cancel(old));await service.cancel(latest);assert.equal((await tx.get("SELECT connection_generation FROM strava_tokens WHERE user_id='a'")).connection_generation,stored.connection_generation);
  // Duplicate exchanges: one failure cannot consume the valid sibling attempt.
  const simultaneous=await start();held=barrier();entered=barrier();handler=async(op,input)=>{if(input.code==='bad')throw unavailable();entered.resolve();return held.promise;};
  const good=service.callback(simultaneous,'good');await entered.promise;await assert.rejects(()=>service.callback(simultaneous,'bad'));held.resolve(payload());await good;
  const same=await start();held=barrier();let arrivals=0;entered=barrier();handler=async()=>{if(++arrivals===2)entered.resolve();return held.promise;};
  const one=service.callback(same,'one'),two=service.callback(same,'two');await entered.promise;held.resolve(payload());
  const results=await Promise.allSettled([one,two]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(results.filter(x=>x.status==='rejected').length,1);
  const unique=await start(),beforeConflict=await snap();handler=()=>payload(456);await assert.rejects(()=>service.callback(unique,'other-athlete'));assert.deepEqual(await snap(),beforeConflict,'unique athlete rollback retains epoch/tokens/binding');
  const expired=await start();held=barrier();entered=barrier();handler=async()=>{entered.resolve();return held.promise;};const expiry=service.callback(expired,'late');await entered.promise;clock+=600000;held.resolve(payload());await assert.rejects(()=>expiry,{code:'STRAVA_CONNECTION_ATTEMPT_STALE'});
  const abortedProof=await start();held=barrier();entered=barrier();handler=async()=>{entered.resolve();return held.promise;};const controller=new AbortController();
  const aborted=service.callback(abortedProof,'abort',{signal:controller.signal});await entered.promise;const abortSnapshot=await snap();controller.abort();held.resolve(payload());await assert.rejects(()=>aborted,{code:'STRAVA_REQUEST_ABORTED'});assert.deepEqual(await snap(),abortSnapshot);
  await connect();let current=await service.connection('a');
  const forgedBefore=await snap();handler=()=>{throw Object.assign(new Error('forged status'),{code:'STRAVA_PROVIDER_REJECTED',status:401});};
  await assert.rejects(()=>service.verifyRevocation(current),/forged status/);assert.deepEqual(await snap(),forgedBefore,'unbranded status cannot revoke');
  // Refresh may not resurrect after reconnect/disconnect; success keeps epoch/generation.
  const revision=Number(current.row.token_revision),epoch=current.proof.epoch,generation=current.row.connection_generation;
  handler=()=>payload();current=await service.refresh(current,{force:true});assert.equal(Number(current.row.token_revision),revision+1);assert.equal(current.proof.epoch,epoch);assert.equal(current.row.connection_generation,generation);
  held=barrier();entered=barrier();handler=async()=>{entered.resolve();return held.promise;};const staleRefresh=service.refresh(current,{force:true});await entered.promise;
  await assert.rejects(()=>service.refresh(current,{force:true}),{code:'STRAVA_REFRESH_BUSY'});await service.disconnect('a');held.resolve(payload());await assert.rejects(()=>staleRefresh);assert.equal(await tx.get("SELECT * FROM strava_tokens WHERE user_id='a'"),undefined);
  await connect();current=await service.connection('a');const pendingReconnect=await start();handler=()=>payload();const refreshed=await service.refresh(current,{force:true});assert.equal(refreshed.proof.epoch,pendingReconnect.epoch,'ordinary refresh is not blocked by pending start');
  const before401=await snap();handler=()=>{throw unavailable();};await assert.rejects(()=>service.refresh(refreshed,{force:true}));assert.deepEqual(await snap(),before401,'token401 alone never revokes');
  handler=()=>payload(999);await assert.rejects(()=>service.refresh(refreshed,{force:true}),{code:'STRAVA_ATHLETE_RESPONSE_INVALID'});assert.deepEqual(await snap(),before401,'refresh cannot change athlete identity');
  held=barrier();entered=barrier();handler=async()=>{entered.resolve();return held.promise;};const expiredLease=service.refresh(refreshed,{force:true});await entered.promise;clock+=60001;held.resolve(payload());await assert.rejects(()=>expiredLease,{code:'STRAVA_REFRESH_STALE'});
  assert.equal((await tx.get("SELECT token_revision FROM strava_tokens WHERE user_id='a'")).token_revision,refreshed.row.token_revision);
  // Capture before newer start: authenticated athlete verdict cannot delete it.
  await connect();current=await service.connection('a');held=barrier();entered=barrier();handler=async()=>{entered.resolve();await held.promise;throw unavailable();};
  const oldProof=service.verifyRevocation(current);await entered.promise;await start();const successor=await snap();held.resolve();await assert.rejects(()=>oldProof);assert.deepEqual(await snap(),successor);
  // A refresh revision committed while verification waits also invalidates it.
  await connect();current=await service.connection('a');held=barrier();entered=barrier();handler=async(op)=>{if(op==='token')return payload();entered.resolve();await held.promise;throw unavailable();};
  const oldRevisionProof=service.verifyRevocation(current);await entered.promise;await service.refresh(current,{force:true});const revised=await snap();held.resolve();await assert.rejects(()=>oldRevisionProof);assert.deepEqual(await snap(),revised);
  // Capture AFTER newer start: remove only old credentials, preserve pending epoch.
  await connect();const reconnect=await start();current=await service.connection('a');handler=()=>{throw unavailable();};assert.equal(await service.verifyRevocation(current),true);
  assert.equal((await tx.get("SELECT epoch FROM strava_connection_fences WHERE user_id='a'")).epoch,reconnect.epoch);
  assert.equal((await tx.all("SELECT * FROM user_notifications WHERE user_id='a'")).length,1);
  await assert.rejects(()=>service.verifyRevocation(current));assert.equal((await tx.all("SELECT * FROM user_notifications WHERE user_id='a'")).length,1);
  handler=()=>payload();await service.callback(reconnect,'newer');
  // Reverse final order: callback wins, held provider verdict becomes stale.
  const newer=await start();current=await service.connection('a');held=barrier();entered=barrier();handler=async(op)=>{if(op==='token')return payload();entered.resolve();await held.promise;throw unavailable();};
  const revoke=service.verifyRevocation(current);await entered.promise;await service.callback(newer,'winning');const afterCallback=await snap();held.resolve();await assert.rejects(()=>revoke);assert.deepEqual(await snap(),afterCallback);
  // Explicit local disconnect still invalidates pending auth after remote deletion.
  const cancelled=await start();current=await service.connection('a');handler=()=>{throw unavailable();};await service.verifyRevocation(current);await service.disconnect('a');handler=()=>payload();await assert.rejects(()=>service.callback(cancelled,'stale'));
  // Refreshed proof is derived only by successful CAS, never an arbitrary reread.
  await connect();current=await service.connection('a');await tx.run("UPDATE strava_tokens SET expires_at=0 WHERE user_id='a'");current=await service.connection('a');
  const pendingAfter=await start();handler=op=>op==='token'?payload():(()=>{throw unavailable();})();await assert.rejects(()=>service.verifyRevocation(current),{code:'STRAVA_CONNECTION_STALE'});
  assert.ok(await tx.get("SELECT * FROM strava_tokens WHERE user_id='a'"));assert.equal((await tx.get("SELECT epoch FROM strava_connection_fences WHERE user_id='a'")).epoch,pendingAfter.epoch);
  current=await service.connection('a');handler=()=>{throw unavailable();};await service.verifyRevocation(current);
  // Owner erasure while network waits; no callback recreation or new notice.
  const erased=await start();held=barrier();entered=barrier();handler=async()=>{entered.resolve();return held.promise;};const late=service.callback(erased,'late');await entered.promise;
  await f.owner('a',async q=>{
    await q.run("DELETE FROM strava_tokens WHERE user_id='a'");
    await q.run("DELETE FROM provider_activity_links WHERE user_id='a'");
    await q.run("DELETE FROM runs WHERE user_id='a'");
    await q.run("DELETE FROM users WHERE id='a'");
  });held.resolve(payload());await assert.rejects(()=>late);
  for(const table of ['strava_tokens','strava_connection_fences','strava_ingress_bindings','user_notifications'])assert.equal((await tx.all(`SELECT * FROM ${table} WHERE user_id='a'`)).length,0);
  assert.equal((await tx.get("SELECT planning_input_revision FROM users WHERE id='b'")).planning_input_revision,0);
  console.log(`PASS ${label} network-facing orchestration: real transactions, expiry/ABA/parallel callbacks/cancel/unique rollback/refresh lease/revision/deauth orders/erase; synthetic provider only`);
}
async function sqlite(){const f=await sqliteFixture();let tail=Promise.resolve();f.owner=(id,fn)=>{
  const op=tail.then(async()=>{f.exec('BEGIN IMMEDIATE');try{assert.ok(await f.tx.get('SELECT id FROM users WHERE id=?',[id]));const r=await fn(f.tx);f.exec('COMMIT');return r;}catch(e){f.exec('ROLLBACK');throw e;}});tail=op.catch(()=>{});return op;
};try{await check(f,'SQLite');}finally{f.close();}}
async function postgres(){
  const {Pool}=require('pg'),url=new URL('postgresql://forge_background_test@127.0.0.1:55449/forge_background_test');
  const admin=new Pool({connectionString:url.href}),name='forge_b1cp_'+crypto.randomBytes(8).toString('hex');let pool,created=false;
  const adapter=client=>{const q=(s,p=[])=>{let i=0;return client.query(s.replace(/\?/g,()=>`$${++i}`),p);};return{get:async(s,p)=>(await q(s,p)).rows[0],all:async(s,p)=>(await q(s,p)).rows,run:async(s,p)=>({changes:(await q(s,p)).rowCount})};};
  try{
    assert.deepEqual((await admin.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0],{db:'forge_background_test',role:'forge_background_test',port:55449});
    await admin.query(`CREATE DATABASE "${name}"`);created=true;url.pathname='/'+name;pool=new Pool({connectionString:url.href});
    for(const ddl of baseStatements())await pool.query(ddl);
    const owner=async(id,fn)=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='3s'");const r=await c.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[id]);if(!r.rows.length)throw Error('owner erased');const value=await fn(adapter(c));await c.query('COMMIT');return value;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
    await check({tx:adapter(pool),owner,migrate:()=>migration.migrateBackgroundSyncPostgres(pool)},'PostgreSQL separate clients/barriers');
  }finally{if(pool)await pool.end();if(created){await admin.query(`DROP DATABASE "${name}"`);console.log('Removed owned child '+name);}await admin.end();}
}
(async()=>{await sqlite();if(process.argv.includes('--postgres'))await postgres();console.log('STRAVA CONNECTION SERVICE OK; no durable queue/delivery/live claim');})().catch(e=>{console.error(e);process.exitCode=1;});
