'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { randomBytes } = require('node:crypto');
const { fork } = require('node:child_process');
const { Pool } = require('pg');
const { performance } = require('node:perf_hooks');
const { normalizeWebhookEvent, mountStravaWebhookParser } = require('../src/lib/stravaWebhook');
const { createIntakeTransaction } = require('../src/db/backgroundSyncIntake');
const { createStravaEventIntake } = require('../src/services/stravaEventIntake');
const { sqliteFixture, seed } = require('./backgroundRunPersistence.smoke');
const migration = require('../src/db/backgroundSyncSchema');
const event = (id = 900, extra = {}) => ({ owner_id: 123, object_id: id, subscription_id: 77,
  object_type: 'activity', aspect_type: 'create', event_time: 1770000000, updates: {}, ...extra });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const adapter = client => {
  const query = (sql, p = []) => { let i = 0; return client.query(sql.replace(/\?/g, () => `$${++i}`), p); };
  return { get: async (sql,p) => (await query(sql,p)).rows[0], all: async (sql,p) => (await query(sql,p)).rows,
    run: async (sql,p) => ({ changes: (await query(sql,p)).rowCount }) };
};
const intakeFor = transaction => createStravaEventIntake({ transaction, subscriptionId: '77' });

async function semanticChecks(f, transaction, dialect) {
  await seed(f);
  const intake = intakeFor(transaction);
  const job = () => f.tx.get("SELECT * FROM provider_event_jobs WHERE object_id='900'");
  for (const invalid of [null, [], {}, event(0), event(Number.MAX_SAFE_INTEGER+1), event('01'), event(1,{event_time:null}),
    event(1,{event_time:-1}), event(1,{unknown:true}), event(1,{updates:[]}), event(1,{updates:{title:'x'.repeat(513)}}),
    event(1,{updates:{nested:{value:1}}}), event(1,{aspect_type:'CREATE'}), event(1,{subscription_id:78})]) {
    await assert.rejects(() => intake(invalid), { status: 400 });
  }
  await assert.rejects(() => createStravaEventIntake({transaction,subscriptionId:null})(event()), {status:503});
  assert.equal((await f.tx.all('SELECT * FROM provider_event_jobs')).length,0);
  assert.deepEqual(await intake(event(1,{owner_id:999})),{received:true,ignored:true});
  const quota = await f.tx.get("SELECT * FROM background_sync_control WHERE id='strava'");
  assert.deepEqual(await intake(event()),{received:true});
  const original = await job(); await intake(event()); assert.deepEqual(await job(),original,'duplicate is exact no-op');
  await intake(event(900,{updates:{title:'changed',private:true}}));
  assert.equal(Number((await job()).requested_revision),2);
  const fingerprint=normalizeWebhookEvent(event(1,{updates:{title:'a',private:true}})).fingerprint;
  assert.equal(normalizeWebhookEvent(event(1,{updates:{private:true,title:'a'}})).fingerprint,fingerprint);
  assert.ok(!JSON.stringify(await job()).includes('changed'),'raw hints are not persisted');
  await f.tx.run("UPDATE provider_event_jobs SET state='LEASED',lease_token='lease',lease_until='2099-01-01T00:00:00Z',leased_revision=2,available_at='2020-01-01T00:00:00Z' WHERE id=?",[original.id]);
  const leased=await job(); await intake(event(900,{aspect_type:'delete',event_time:1770000001}));
  const hinted=await job();
  for(const key of ['state','lease_token','lease_until','leased_revision','available_at','processed_revision','last_fetch_at']) assert.deepEqual(hinted[key],leased[key],key);
  assert.equal(Number(hinted.requested_revision),3);
  await f.tx.run("UPDATE provider_event_jobs SET state='RETRY',lease_token=NULL,lease_until=NULL,leased_revision=NULL,last_fetch_at='2020-01-01T00:00:00Z',available_at='2020-01-01T00:00:30Z' WHERE id=?",[original.id]);
  await intake(event(900,{event_time:1770000002})); const due=(await job()).available_at;
  await intake(event(900,{event_time:1770000003}));assert.deepEqual((await job()).available_at,due,'bursts never debounce due work');
  await f.tx.run("UPDATE provider_event_jobs SET state='DEAD',attempts=12,updated_at='2020-01-01T00:00:00Z' WHERE id=?",[original.id]);
  const dead=await job();await intake(event(900,{event_time:1}));assert.equal((await job()).state,'DEAD');assert.deepEqual((await job()).updated_at,dead.updated_at,'old hints cannot postpone DEAD cooldown');
  await intake(event(900,{event_time:1770000004}));assert.equal((await job()).state,'PENDING');assert.equal(Number((await job()).attempts),0);
  await f.tx.run('UPDATE provider_event_jobs SET requested_revision=8999999999999999 WHERE id=?',[original.id]);
  await assert.rejects(()=>intake(event(900,{event_time:1770000005})));assert.equal(Number((await job()).requested_revision),8999999999999999);
  for(let i=0;i<99;i++)await intake(event(1000+i));
  await assert.rejects(()=>intake(event(2000)));assert.equal((await f.tx.all('SELECT id FROM provider_event_jobs')).length,100);
  await intake(event(1000,{event_time:1770000010}));
  assert.deepEqual(await f.tx.get("SELECT * FROM background_sync_control WHERE id='strava'"),quota,'intake never changes quotas/pause/activation');
  await f.tx.run("DELETE FROM strava_tokens WHERE user_id='a'");
  assert.equal((await f.tx.all('SELECT * FROM provider_event_jobs')).length,0);
  assert.deepEqual(await intake(event()),{received:true,ignored:true});
  console.log(`PASS ${dialect} strict normalization/subscription/no-op/leased-hints/due/revision/capacity/retirement/quota invariance`);
}

async function mounted(transaction) {
  process.env.JWT_SECRET='synthetic-intake-only';process.env.STRAVA_WEBHOOK_SUBSCRIPTION_ID='77';
  const seam=require.resolve('../src/db/backgroundSyncIntake'), prior=require.cache[seam];
  require.cache[seam]={...prior,exports:{...prior.exports,getIntakeTransaction:()=>transaction}};
  const intakePath=require.resolve('../src/services/stravaEventIntake'),routePath=require.resolve('../src/routes/strava');
  delete require.cache[intakePath];delete require.cache[routePath];
  const express=require('express'),app=express();mountStravaWebhookParser(app);app.use(express.json({limit:'10mb'}));
  app.use('/api/strava',require('../src/routes/strava'));
  app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:'parser rejected'}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const url=`http://127.0.0.1:${server.address().port}/api/strava/webhook`;
  return {server,url,request:async(body,options={})=>{
    const start=performance.now(),response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...options.headers},body:typeof body==='string'?body:JSON.stringify(body)});
    return {status:response.status,body:await response.json(),ms:performance.now()-start};
  },close:async()=>{await new Promise(resolve=>server.close(resolve));require.cache[seam]=prior;delete require.cache[intakePath];delete require.cache[routePath];}};
}
async function sqlite() {
  const f=await sqliteFixture();
  const transaction=async fn=>{f.exec('BEGIN IMMEDIATE');try{const result=await fn({...f.tx,dialect:'sqlite'});f.exec('COMMIT');return result;}catch(error){f.exec('ROLLBACK');throw error;}};
  let http;try{
    await semanticChecks(f,transaction,'sqlite');http=await mounted(transaction);
    assert.equal((await http.request(event())).status,200);
    assert.equal((await http.request('{')).status,400);
    assert.equal((await http.request('[')).status,400);
    assert.equal((await http.request(JSON.stringify(event(1,{updates:{title:'x'.repeat(17000)}})))).status,413);
    const token=require('../src/lib/stravaWebhook').getWebhookVerifyToken(process.env.JWT_SECRET);
    const handshake=await fetch(`${http.url}?hub.mode=subscribe&hub.challenge=synthetic&hub.verify_token=${token}`);
    assert.equal(handshake.status,200);assert.deepEqual(await handshake.json(),{'hub.challenge':'synthetic'});
    console.log('PASS mounted real router with exact pre-global parser rejects >16KiB and malformed JSON');
    const source=fs.readFileSync(require.resolve('../src/app'),'utf8');
    assert.ok(source.indexOf('mountStravaWebhookParser(app)')<source.indexOf("express.json({ limit: '10mb' })"));
  }finally{if(http)await http.close();f.close();}
}

async function postgres() {
  const url=new URL('postgresql://forge_background_test@127.0.0.1:55449/forge_background_test');
  const admin=new Pool({connectionString:url.href}),name=`forge_intake_${randomBytes(8).toString('hex')}`;
  let created=false,pool,intakePool,http;
  try{
    assert.deepEqual((await admin.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0],{db:'forge_background_test',role:'forge_background_test',port:55449});
    await admin.query(`CREATE DATABASE "${name}"`);created=true;url.pathname='/'+name;
    pool=new Pool({connectionString:url.href});intakePool=new Pool({connectionString:url.href,max:2,connectionTimeoutMillis:150});
    const schema=fs.readFileSync(require.resolve('../src/db/schema.pg.sql'),'utf8');
    for(const table of ['users','runs','strava_tokens','push_subscriptions','user_notifications'])await pool.query(schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))[0]);
    const f={tx:adapter(pool),migrate:()=>migration.migrateBackgroundSyncPostgres(pool)};
    const transaction=createIntakeTransaction(intakePool);await semanticChecks(f,transaction,'postgres');
    await pool.query("INSERT INTO strava_tokens(user_id,athlete_id,access_token,refresh_token,connection_generation) VALUES('a',123,'synthetic','synthetic','replacement')");
    await pool.query("INSERT INTO strava_ingress_bindings(id,user_id,athlete_id) SELECT connection_generation,user_id,athlete_id::text FROM strava_tokens WHERE user_id='a'");
    http=await mounted(transaction);
    const held=await pool.connect();await held.query('BEGIN');await held.query("SELECT id FROM users WHERE id='a' FOR UPDATE");
    const started=performance.now(),response=await http.request(event());assert.equal(response.status,200);assert.ok(response.ms<2000);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_event_jobs WHERE object_id='900'")).rows[0].n,1,'independent reader sees commit before ACK');
    await pause(Math.max(0,2100-(performance.now()-started)));await held.query('ROLLBACK');held.release();
    console.log(`PASS actual Express PG durable ACK ${Math.round(response.ms)}ms while owner UPDATE held >2100ms`);
    const blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('SELECT id FROM strava_ingress_bindings FOR UPDATE');
    assert.equal((await http.request(event(901))).status,503);await blocker.query('ROLLBACK');blocker.release();
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_event_jobs WHERE object_id='901'")).rows[0].n,0);
    const one=await intakePool.connect(),two=await intakePool.connect();const unavailable=await http.request(event(902));assert.equal(unavailable.status,503);assert.ok(unavailable.ms<700);one.release();two.release();await pause(200);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_event_jobs WHERE object_id='902'")).rows[0].n,0);
    await pool.query("CREATE FUNCTION synthetic_slow_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$; CREATE TRIGGER synthetic_slow BEFORE INSERT ON provider_event_jobs FOR EACH ROW EXECUTE FUNCTION synthetic_slow_insert()");
    const slow=await http.request(event(903));assert.equal(slow.status,503);assert.ok(slow.ms<1200);await pause(350);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_event_jobs WHERE object_id='903'")).rows[0].n,0);
    await pool.query('DROP TRIGGER synthetic_slow ON provider_event_jobs');
    await assert.rejects(()=>transaction(async tx=>{await tx.get('SELECT pg_sleep(0.65)');await tx.get('SELECT pg_sleep(0.65)');await tx.run("DELETE FROM provider_event_jobs");}));
    await pause(200);assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_event_jobs')).rows[0].n,1,'whole deadline cancels before late write/commit');
    await assert.rejects(()=>transaction(async tx=>{await pause(1100);await tx.run('DELETE FROM provider_event_jobs');}));
    await pause(150);assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_event_jobs')).rows[0].n,1,'idle timeout handled without crash/late continuation');
    const uncertainPool={connect:async()=>{const client=await pool.connect();return{release:x=>client.release(x),query:async(...args)=>{const result=await client.query(...args);if(args[0]==='COMMIT')throw new Error('synthetic lost COMMIT response');return result;}};}};
    await assert.rejects(()=>intakeFor(createIntakeTransaction(uncertainPool))(event(904)));
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_event_jobs WHERE object_id='904'")).rows[0].n,1,'uncertain commit is not claimed absent');
    assert.deepEqual(await intakeFor(transaction)(event(904)),{received:true});
    console.log('PASS PG acquisition/row lock/statement cancellation/whole deadline/uncertain COMMIT no false ACK or detached write');
    const requests=Array.from({length:12},(_,i)=>intakeFor(transaction)(event(905,{event_time:1770000000+i})));
    await Promise.all(requests);const coalesced=(await pool.query("SELECT * FROM provider_event_jobs WHERE object_id='905'")).rows[0];assert.equal(Number(coalesced.requested_revision),12);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_event_jobs WHERE object_id='905'")).rows[0].n,1);
    await processBoundary(url.href,pool,'before');await processBoundary(url.href,pool,'after');
    // An aborted HTTP consumer cannot enqueue a later commit from the same
    // transaction continuation, including when it already wrote a slot.
    const controller=new AbortController();
    await assert.rejects(()=>transaction(async tx=>{await tx.run("UPDATE provider_event_jobs SET last_error_code='must-rollback' WHERE object_id='900'");controller.abort();await tx.get('SELECT pg_sleep(0.1)');},{signal:controller.signal}));
    await pause(100);assert.equal((await pool.query("SELECT last_error_code FROM provider_event_jobs WHERE object_id='900'")).rows[0].last_error_code,null);
    await lifecycleRaces(pool,http,transaction);
    await globalCapacity(pool,transaction);
    console.log('STRAVA INTAKE POSTGRES GATE OK');
  }finally{if(http)await http.close();if(intakePool)await intakePool.end();if(pool)await pool.end();if(created){await admin.query(`DROP DATABASE "${name}"`);console.log('Removed owned intake child database');}await admin.end();}
}

async function lifecycleRaces(pool,http,transaction){
  let entered,release;const started=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
  const pending=intakeFor(fn=>transaction(async tx=>{const result=await fn(tx);entered();await held;return result;}))(event(920));
  await started;
  const deleting=await pool.connect();await deleting.query('BEGIN');
  let deleted=false;const deletion=deleting.query("DELETE FROM strava_tokens WHERE user_id='a'").then(()=>{deleted=true;});
  await pause(40);assert.equal(deleted,false,'token retirement waits on binding, not owner');release();await pending;await deletion;await deleting.query('COMMIT');deleting.release();
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM provider_event_jobs WHERE object_id='920'")).rows[0].n,0);
  assert.deepEqual((await http.request(event(921))).body,{received:true,ignored:true});
  await pool.query("INSERT INTO strava_tokens(user_id,athlete_id,access_token,refresh_token,connection_generation) VALUES('a',123,'synthetic','synthetic','race-generation')");
  await pool.query("INSERT INTO strava_ingress_bindings(id,user_id,athlete_id) VALUES('race-generation','a','123')");
  const retiring=await pool.connect();await retiring.query('BEGIN');await retiring.query("UPDATE strava_tokens SET connection_generation='successor' WHERE user_id='a'");
  assert.equal((await http.request(event(922))).status,503,'retirement-first is unavailable, not false ignored');
  await retiring.query("INSERT INTO strava_ingress_bindings(id,user_id,athlete_id) VALUES('successor','a','123')");await retiring.query('COMMIT');retiring.release();
  assert.equal((await http.request(event(922))).status,200);
  assert.equal((await pool.query("SELECT binding_id FROM provider_event_jobs WHERE object_id='922'")).rows[0].binding_id,'successor');
  const erasing=await pool.connect();await erasing.query('BEGIN');await erasing.query("DELETE FROM runs WHERE user_id='a'");await erasing.query("DELETE FROM users WHERE id='a'");
  assert.equal((await http.request(event(923))).status,503);await erasing.query('COMMIT');erasing.release();
  assert.deepEqual((await http.request(event(923))).body,{received:true,ignored:true});
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM strava_ingress_bindings WHERE user_id='a'")).rows[0].n,0);
  console.log('PASS real PG intake-first retirement cascade, reconnect-first timeout/successor binding, erasure-first timeout/ignored');
}

async function globalCapacity(pool,transaction){
  // Synthetic capacity fixture uses actual triggers and indexes, not a mocked
  // COUNT. Each binding stays at <=100 and the final global slot is contested.
  await pool.query(`INSERT INTO users(id,name,email,password_hash) SELECT 'capacity-'||i,'Synthetic','capacity-'||i||'@example.invalid','synthetic' FROM generate_series(1,101) i;
    INSERT INTO strava_tokens(user_id,athlete_id,access_token,refresh_token,connection_generation)
      SELECT 'capacity-'||i,10000+i,'synthetic','synthetic','capacity-generation-'||i FROM generate_series(1,101) i;
    INSERT INTO strava_ingress_bindings(id,user_id,athlete_id)
      SELECT connection_generation,user_id,athlete_id::text FROM strava_tokens WHERE user_id LIKE 'capacity-%';
    DELETE FROM provider_event_jobs;
    INSERT INTO provider_event_jobs(id,binding_id,object_type,object_id,last_fingerprint,reported_event_time,last_aspect,state)
      SELECT 'capacity-job-'||i,'capacity-generation-'||((i-1)/100+1),'activity',i::text,repeat('a',64),1,'create','PENDING' FROM generate_series(1,9999) i;`);
  const attempts=await Promise.allSettled([intakeFor(transaction)(event(50000,{owner_id:10100})),intakeFor(transaction)(event(50001,{owner_id:10101}))]);
  assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM provider_event_jobs')).rows[0].n,10000);
  await assert.rejects(()=>intakeFor(transaction)(event(50002,{owner_id:10101})));
  const plans=await pool.query("EXPLAIN SELECT id FROM provider_event_jobs WHERE binding_id='capacity-generation-100' LIMIT 101");
  assert.match(plans.rows.map(row=>row['QUERY PLAN']).join('\n'),/Index|Bitmap/,'binding capacity uses indexed bounded lookup');
  console.log('PASS actual global10000/binding100 concurrent final-slot capacity, indexed bounded lookup');
}

async function processBoundary(url,pool,mode){
  const child=fork(__filename,['--child',mode],{env:{...process.env,FORGE_SYNTHETIC_INTAKE_DB:url},stdio:['ignore','pipe','pipe','ipc']});
  let text='';child.stderr.on('data',chunk=>{text+=chunk;});
  const next=()=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('child barrier timeout '+text));},5000);child.once('message',value=>{clearTimeout(timer);resolve(value);});child.once('error',reject);});
  const ready=await next();assert.match(ready.url,/^http:\/\/127\.0\.0\.1:\d+\/api\/strava\/webhook$/);
  const barrier=next();let acknowledged=false;
  const request=fetch(ready.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(event(mode==='before'?910:911))}).then(response=>{acknowledged=response.status===200;},()=>{});
  assert.equal(await barrier,'commit-barrier');const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));child.kill('SIGKILL');assert.equal((await exited).signal,'SIGKILL');await request;assert.equal(acknowledged,false,'terminated HTTP process did not ACK');
  await pause(100);const n=(await pool.query('SELECT count(*)::int AS n FROM provider_event_jobs WHERE object_id=$1',[mode==='before'?'910':'911'])).rows[0].n;
  assert.equal(n,mode==='before'?0:1);console.log(`PASS real child SIGKILL ${mode} COMMIT / before ACK durable state ${n}`);
}
async function child(){
  const url=new URL(process.env.FORGE_SYNTHETIC_INTAKE_DB);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55449');assert.match(url.pathname,/^\/forge_intake_[a-f0-9]{16}$/);assert.equal(url.username,'forge_background_test');
  const mode=process.argv[3],pool=new Pool({connectionString:url.href});
  const wrapped={connect:async()=>{const client=await pool.connect();return{release:x=>client.release(x),query:async(...args)=>{
    if(args[0]==='COMMIT'&&mode==='before'){process.send('commit-barrier');await new Promise(()=>{});}
    const result=await client.query(...args);
    if(args[0]==='COMMIT'&&mode==='after'){process.send('commit-barrier');await new Promise(()=>{});}
    return result;
  }};}};
  const http=await mounted(createIntakeTransaction(wrapped));process.send({url:http.url});
  await new Promise(()=>{}); // Parent sends a real callback, then SIGKILLs at COMMIT.
}
if(require.main===module)(async()=>{if(process.argv.includes('--child'))return child();await sqlite();if(process.argv.includes('--postgres'))await postgres();console.log('STRAVA EVENT INTAKE GATE OK');})().catch(error=>{console.error(error);process.exitCode=1;});
