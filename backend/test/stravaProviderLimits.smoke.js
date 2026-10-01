'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const schema=require('../src/db/backgroundSyncSchema');
const {createStravaProviderClient}=require('../src/services/stravaProviderClient');
const fields=['observed_quarter_cap','observed_day_cap','provider_limits_epoch'];
const base=fs.readFileSync(path.join(__dirname,'../src/db/schema.pg.sql'),'utf8');
function baseSql(dialect){const sql=['users','runs','strava_tokens','push_subscriptions','user_notifications'].map(table=>base.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))[0]).join('\n');
 return dialect==='sqlite'?sql.replace(/id SERIAL PRIMARY KEY/g,'id INTEGER PRIMARY KEY AUTOINCREMENT').replace(/TIMESTAMPTZ/g,'TEXT').replace(/NOW\(\)/g,'CURRENT_TIMESTAMP'):sql;}
function sqlite(){const native=new DatabaseSync(':memory:');native.exec('PRAGMA foreign_keys=ON');native.exec(baseSql('sqlite'));
 const db={exec:s=>native.exec(s),get:(s,p=[])=>native.prepare(s).get(...p),all:(s,p=[])=>native.prepare(s).all(...p),run:(s,p=[])=>native.prepare(s).run(...p.map(v=>typeof v==='boolean'?Number(v):v))};
 return {dialect:'sqlite',native,db,migrate:()=>schema.migrateBackgroundSyncSqlite(native),transaction:async fn=>{native.exec('BEGIN IMMEDIATE');try{const r=await fn(db);native.exec('COMMIT');return r;}catch(e){native.exec('ROLLBACK');throw e;}},close:()=>native.close()};}
const value=row=>JSON.parse(JSON.stringify(row));
async function stripLimits(f){for(const name of fields)await f.db.exec(`ALTER TABLE background_sync_control DROP COLUMN ${name}`);await f.db.run('DELETE FROM schema_migrations WHERE version=?',[schema.LIMITS_MIGRATION_VERSION]);}
async function state(f){return value(await f.db.get('SELECT * FROM background_sync_control'));}
async function migrationChecks(f){
 await f.migrate();let row=await state(f);assert.equal(row.observed_quarter_cap,null);assert.equal(row.observed_day_cap,null);assert.equal(Number(row.provider_limits_epoch),1);
 await stripLimits(f);await f.db.run("UPDATE background_sync_control SET paused=TRUE,quarter_used=21,day_used=85,next_allowed_at='2099-01-01T00:00:00Z'");
 const before=await state(f),allBefore=await f.db.all('SELECT * FROM schema_migrations ORDER BY version');
 await f.migrate();row=await state(f);for(const key of fields)delete row[key];assert.deepEqual(row,before,'actual prior schema upgrade preserves all old control bytes');
 assert.equal((await f.db.all('SELECT * FROM schema_migrations')).length,allBefore.length+1);
 const full=await state(f);await f.migrate();assert.deepEqual(await state(f),full,'rerun does not clear ambiguous global pause or bootstrap again');
 for(const [field,invalid] of [['observed_quarter_cap',0],['observed_quarter_cap',61],['observed_day_cap',601],['provider_limits_epoch',0],['provider_limits_epoch',9000000000000001],['provider_limits_epoch',null],['observed_day_cap','bad']])await assert.rejects(async()=>f.db.run(`UPDATE background_sync_control SET ${field}=?`,[invalid]));
 if(f.dialect==='sqlite')for(const v of [1.25,Buffer.from('2')])await assert.rejects(async()=>f.db.run('UPDATE background_sync_control SET observed_quarter_cap=?',[v]));
 await f.db.run('UPDATE background_sync_control SET provider_limits_epoch=9000000000000000');
 await assert.rejects(async()=>f.db.run('UPDATE background_sync_control SET provider_limits_epoch=provider_limits_epoch+1'));
 if(f.dialect==='sqlite')assert.equal((await f.db.get('PRAGMA foreign_keys')).foreign_keys,1);
 console.log(`PASS ${f.dialect} actual legacy/fresh/rerun/pause/bytes/nullable caps/epoch bounds`);
}
async function malformedSchemas(make){
 for(const mode of ['unrecorded','partial','missing','default','type','check','epoch-default','fault']){
  const f=await make();try{await f.migrate();
   if(mode==='unrecorded')await f.db.run('DELETE FROM schema_migrations WHERE version=?',[schema.LIMITS_MIGRATION_VERSION]);
   else if(mode==='partial'){await stripLimits(f);await f.db.exec('ALTER TABLE background_sync_control ADD COLUMN observed_quarter_cap INTEGER');}
   else if(mode==='missing')await f.db.exec('ALTER TABLE background_sync_control DROP COLUMN observed_day_cap');
   else if(mode==='epoch-default'){
    await f.db.exec('ALTER TABLE background_sync_control DROP COLUMN provider_limits_epoch');
    await f.db.exec('ALTER TABLE background_sync_control ADD COLUMN provider_limits_epoch INTEGER NOT NULL DEFAULT 2 CONSTRAINT bg_provider_limits_epoch CHECK(provider_limits_epoch BETWEEN 1 AND 9000000000000000)');
   }else if(mode==='fault'){
    await stripLimits(f);const before=await state(f),fail=new Error('synthetic additive limit failure');
    if(f.dialect==='sqlite'){
     const wrapped={function:(...args)=>f.native.function(...args),get isTransaction(){return f.native.isTransaction;},prepare:s=>f.native.prepare(s),exec:s=>{if(s.includes('ADD COLUMN observed_day_cap'))throw fail;return f.native.exec(s);}};
     await assert.rejects(()=>schema.migrateBackgroundSyncSqlite(wrapped),e=>e===fail);
     assert.equal(f.native.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
    }else{
     const pool={connect:async()=>{const c=await f.pool.connect();return {query:(s,p)=>s.includes('ADD COLUMN observed_day_cap')?Promise.reject(fail):c.query(s,p),release:()=>c.release()};}};
     await assert.rejects(()=>schema.migrateBackgroundSyncPostgres(pool),e=>e===fail);
    }
    assert.deepEqual(await state(f),before);assert.equal(await f.db.get('SELECT version FROM schema_migrations WHERE version=?',[schema.LIMITS_MIGRATION_VERSION]),undefined);
    await f.migrate();continue;
   }else{
    await f.db.exec('ALTER TABLE background_sync_control DROP COLUMN observed_quarter_cap');
    const spec=mode==='default'?'INTEGER DEFAULT 60 CONSTRAINT bg_provider_quarter_cap CHECK(observed_quarter_cap BETWEEN 1 AND 60)':mode==='type'?'TEXT CONSTRAINT bg_provider_quarter_cap CHECK(observed_quarter_cap IS NULL)': 'INTEGER CONSTRAINT bg_provider_quarter_cap CHECK(observed_quarter_cap BETWEEN 1 AND 600)';
    await f.db.exec('ALTER TABLE background_sync_control ADD COLUMN observed_quarter_cap '+spec);
   }
   await assert.rejects(f.migrate,e=>e.code?.startsWith('BACKGROUND_SCHEMA_PROVIDER_LIMITS'),mode);
   if(f.dialect==='sqlite')assert.equal((await f.db.get('PRAGMA foreign_keys')).foreign_keys,1);
  }finally{await f.close();}
 }
 console.log('PASS recorded/unrecorded partial/type/default/check rejection and atomic additive-fault rollback');
}
function latch(){let resolve;return {promise:new Promise(r=>resolve=r),resolve:(v)=>resolve(v)};}
async function providerChecks(f){
 await f.migrate();let clock=Date.parse('2026-09-29T12:00:00Z'),calls=0,reply=()=>new Response('[]');
 const transaction=fn=>f.transaction(tx=>fn({...tx,get:(s,p)=>s.includes(' AS now')?{now:new Date(clock).toISOString()}:tx.get(s,p)}));
 const client=createStravaProviderClient({dialect:f.dialect,withTransaction:transaction,fetchImpl:async()=>{calls++;return reply();}});
 const request=(input={accessToken:'synthetic'},options={})=>client.request('activities',input,{waitForSpacing:false,...options});
 const headers=(q,d,u=1,v=1,extra={})=>new Response('[]',{headers:{'X-RateLimit-Limit':`${q},${d}`,'X-RateLimit-Usage':`${u},${v}`,...extra}});
 async function reset(){await f.db.run('UPDATE background_sync_control SET paused=FALSE,observed_quarter_cap=NULL,observed_day_cap=NULL,provider_limits_epoch=1,quarter_used=0,day_used=0,quarter_start=?,day_start=?,next_allowed_at=?',[new Date(Math.floor(clock/900000)*900000).toISOString(),new Date(Math.floor(clock/86400000)*86400000).toISOString(),new Date(clock).toISOString()]);reply=()=>new Response('[]');}
 await reset();await request({accessToken:'s',verified:true,headers:{'X-RateLimit-Limit':'1,1'},observed_quarter_cap:1});let row=await state(f);assert.equal(row.observed_quarter_cap,null,'caller facts never supply grant authority');assert.equal(row.observed_day_cap,null);
 await assert.rejects(()=>request({accessToken:'bad\r\ntoken'}),{code:'STRAVA_REQUEST_INVALID'});
 await assert.rejects(()=>client.request('https://untrusted.invalid',{accessToken:'s'}),{code:'STRAVA_REQUEST_INVALID'});
 clock+=1000;reply=()=>headers(10,100);await request();reply=()=>headers(60,600);
 for(let i=0;i<8;i++){clock+=1000;await request();}row=await state(f);assert.equal(row.quarter_used,10);assert.equal(row.observed_quarter_cap,10);assert.equal(row.observed_day_cap,100);assert.ok(!row.paused);
 clock+=1000;const before=calls;await assert.rejects(()=>request(),{code:'STRAVA_QUOTA_UNAVAILABLE'});assert.equal(calls,before);
 clock=Math.ceil(clock/900000)*900000;reply=()=>new Response('[]');await request();row=await state(f);assert.equal(row.quarter_used,1);assert.equal(row.day_used,11);assert.equal(row.observed_quarter_cap,10);
 clock=Math.ceil(clock/86400000)*86400000;await request();assert.equal((await state(f)).day_used,1);assert.equal((await state(f)).observed_day_cap,100);
 const retained=await state(f);await f.migrate();assert.deepEqual(await state(f),retained,'restart migration never resets observed grant or epoch');
 await f.db.run('UPDATE background_sync_control SET paused=TRUE');clock+=86400000;await assert.rejects(()=>request(),{code:'STRAVA_PROVIDER_PAUSED'});await f.migrate();assert.ok((await state(f)).paused);
 // Earlier-window cap evidence remains durable; earlier-window usage does not.
 await reset();let seen=latch(),held=latch();reply=async()=>{seen.resolve();return held.promise;};let pending=request();await seen.promise;
 clock+=86400000;reply=()=>new Response('[]');await request();held.resolve(headers(5,50,45,450));await pending;
 row=await state(f);assert.equal(row.observed_quarter_cap,5);assert.equal(row.observed_day_cap,50);assert.equal(row.quarter_used,1);assert.equal(row.day_used,1);
 // Controlled SQL epoch replacement is a fixture, NOT an operator-recovery API.
 await reset();seen=latch();held=latch();reply=async()=>{seen.resolve();return held.promise;};pending=request();await seen.promise;
 await f.db.run('UPDATE background_sync_control SET provider_limits_epoch=2,observed_quarter_cap=30,observed_day_cap=300');
 held.resolve(new Response('[]',{status:429,headers:{'X-RateLimit-Limit':'2,20','X-RateLimit-Usage':'12,24','Retry-After':'120'}}));await assert.rejects(()=>pending,{status:429});row=await state(f);
 assert.equal(row.observed_quarter_cap,30);assert.equal(row.observed_day_cap,300);assert.equal(row.quarter_used,12);assert.equal(row.day_used,24);assert.ok(Date.parse(row.next_allowed_at)>=clock+120000);
 clock+=121000;reply=()=>headers(10,100);await request();assert.equal((await state(f)).observed_quarter_cap,10);
 clock+=1000;await assert.rejects(()=>request(),{code:'STRAVA_QUOTA_UNAVAILABLE'});assert.equal((await state(f)).quarter_used,13,'reduction below consumed use cannot refund requests');
 // Both arrival orders, real separate PG transactions/clients where applicable.
 for(const reverse of [false,true]){
  await reset();const a=latch(),b=latch(),aSeen=latch(),bSeen=latch();let n=0;
  reply=()=>{n++;if(n===1){aSeen.resolve();return a.promise;}bSeen.resolve();return b.promise;};
  const one=request();await aSeen.promise;clock+=1000;const two=request();await bSeen.promise;
  if(reverse){b.resolve(headers(30,200));await two;a.resolve(headers(10,100));await one;}
  else{a.resolve(headers(10,100));await one;b.resolve(headers(30,200));await two;}
  row=await state(f);assert.equal(row.observed_quarter_cap,10);assert.equal(row.observed_day_cap,100);
 }
 // One remaining reservation: same control row arbitrates replica contenders.
 await reset();await f.db.run('UPDATE background_sync_control SET observed_quarter_cap=1,observed_day_cap=10');
 if(f.dialect==='postgres'){
  const results=await Promise.allSettled([request(),request(),request()]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 }else{await request();await assert.rejects(()=>request(),{code:'STRAVA_QUOTA_UNAVAILABLE'});}
 assert.equal((await state(f)).quarter_used,1);
 for(const malformed of ['0,10','-1,10','1.5,10','1000000000,10','NaN,10','1','']){
  await reset();reply=()=>new Response('[]',{headers:{'X-RateLimit-Limit':malformed,'X-RateLimit-Usage':'1,1','X-ReadRateLimit-Limit':'8,80','X-ReadRateLimit-Usage':'1,1'}});await request();row=await state(f);assert.equal(row.observed_quarter_cap,8);assert.equal(row.observed_day_cap,80);assert.ok(!row.paused);assert.ok(Date.parse(row.next_allowed_at)>=Math.floor(clock/900000)*900000+900000);
 }
 for(const retry of ['0','120',new Date(clock+120000).toUTCString(),new Date(clock-120000).toUTCString(),'999999999','invalid',null]){
  await reset();const responseHeaders=retry===null?{}:{'Retry-After':retry};reply=()=>new Response('{}',{status:429,headers:responseHeaders});
  await assert.rejects(()=>request(),{status:429});row=await state(f);assert.ok(!row.paused);assert.equal(row.observed_quarter_cap,null);
  const minimum=retry==='0'?clock+1000:retry==='120'||retry===new Date(clock+120000).toUTCString()?clock+120000:Math.floor(clock/900000)*900000+900000;
  assert.ok(Date.parse(row.next_allowed_at)>=minimum,'429 cannot shorten backoff or fabricate caps');
 }
 // Read API cannot receive a trusted caller receipt; malformed adapter values
 // also fail before network instead of numeric-coercing arbitrary inputs.
 for(const [name,invalid] of [['observed_quarter_cap',0],['observed_quarter_cap',false],['observed_quarter_cap',[]],['observed_day_cap',{}],['observed_day_cap',' 10'],['observed_day_cap',601],['provider_limits_epoch',null],['provider_limits_epoch',undefined],['provider_limits_epoch',9000000000000001]]){
  await reset();const beforeCalls=calls;
  const bad=createStravaProviderClient({dialect:f.dialect,withTransaction:fn=>transaction(tx=>fn({...tx,get:async(s,p)=>{const r=await tx.get(s,p);return s.startsWith('SELECT * FROM background_sync_control')?{...r,[name]:invalid}:r;}})),fetchImpl:async()=>{calls++;return new Response('[]');}});
  await assert.rejects(()=>bad.request('activities',{accessToken:'s'}),{code:'STRAVA_CONTROL_INVALID'});assert.equal(calls,beforeCalls);
 }
 // Pausing while a response is in flight is not cleared by its valid headers.
 await reset();seen=latch();held=latch();reply=async()=>{seen.resolve();return held.promise;};pending=request();await seen.promise;
 await f.db.run('UPDATE background_sync_control SET paused=TRUE');held.resolve(headers(10,100));await pending;assert.ok((await state(f)).paused);
 console.log(`PASS ${f.dialect} UNKNOWN/10-100 continuation/rollover/old-window caps/old-epoch usage+backoff/minima/atomic quota/caller negatives/global pause`);
}
async function postgres(){
 const {Pool}=require('pg'),url=new URL('postgresql://forge_background_test@127.0.0.1:55449/forge_background_test'),admin=new Pool({connectionString:url.href});let pool,created=false;const name='forge_limits_'+crypto.randomBytes(8).toString('hex');
 try{assert.deepEqual((await admin.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0],{db:'forge_background_test',role:'forge_background_test',port:55449});await admin.query(`CREATE DATABASE "${name}"`);created=true;url.pathname='/'+name;pool=new Pool({connectionString:url.href});
  const adapter=c=>{const q=(s,p=[])=>{let i=0;return c.query(s.replace(/\?/g,()=>`$${++i}`),p);};return {exec:s=>c.query(s),run:async(s,p)=>({changes:(await q(s,p)).rowCount}),get:async(s,p)=>(await q(s,p)).rows[0],all:async(s,p)=>(await q(s,p)).rows};};
  const make=async()=>{await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await pool.query(baseSql('postgres'));return {dialect:'postgres',pool,db:adapter(pool),migrate:()=>schema.migrateBackgroundSyncPostgres(pool),close:()=>{},transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const r=await fn(adapter(c));await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};};
  await migrationChecks(await make());await malformedSchemas(make);await providerChecks(await make());
 }finally{if(pool)await pool.end();if(created){await admin.query(`DROP DATABASE "${name}"`);console.log('Removed owned child '+name);}await admin.end();}
}
(async()=>{let f=sqlite();try{await migrationChecks(f);}finally{f.close();}await malformedSchemas(sqlite);f=sqlite();try{await providerChecks(f);}finally{f.close();}if(process.argv.includes('--postgres'))await postgres();console.log('STRAVA PROVIDER LIMITS OK — no recovery command/delivery/intake implementation claimed');})().catch(e=>{console.error(e);process.exitCode=1;});
