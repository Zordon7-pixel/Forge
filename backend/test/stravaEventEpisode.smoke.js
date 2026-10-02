'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomBytes}=require('node:crypto'),{DatabaseSync}=require('node:sqlite');
const migration=require('../src/db/backgroundSyncSchema');
const {storeHint}=require('../src/services/stravaEventIntake');
const {normalizeWebhookEvent}=require('../src/lib/stravaWebhook');
const base=fs.readFileSync(require.resolve('../src/db/schema.pg.sql'),'utf8');
function baseSql(dialect){const sql=['users','runs','strava_tokens','push_subscriptions','user_notifications']
  .map(table=>base.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))[0]).join('\n');
  return dialect==='sqlite'?sql.replace(/id SERIAL PRIMARY KEY/g,'id INTEGER PRIMARY KEY AUTOINCREMENT').replace(/TIMESTAMPTZ/g,'TEXT').replace(/NOW\(\)/g,'CURRENT_TIMESTAMP'):sql;}
function sqlite(file=':memory:'){
  const native=new DatabaseSync(file);native.exec('PRAGMA foreign_keys=ON');native.exec(baseSql('sqlite'));
  const db={exec:s=>native.exec(s),get:(s,p=[])=>native.prepare(s).get(...p),all:(s,p=[])=>native.prepare(s).all(...p),run:(s,p=[])=>native.prepare(s).run(...p)};
  return {dialect:'sqlite',native,db,migrate:()=>migration.migrateBackgroundSyncSqlite(native),close:()=>native.close(),transaction:async fn=>{
    native.exec('BEGIN IMMEDIATE');try{const v=await fn(db);native.exec('COMMIT');return v;}catch(e){native.exec('ROLLBACK');throw e;}}};
}
const plain=x=>JSON.parse(JSON.stringify(x)),iso=n=>new Date(n).toISOString();
const millis=x=>x instanceof Date?x.getTime():Date.parse(/[zZ]|[+-]\d\d(?::\d\d)?$/.test(x)?x:x.replace(' ','T')+'Z');
const event=(time=10,update={})=>normalizeWebhookEvent({owner_id:123,object_id:900,subscription_id:77,object_type:'activity',aspect_type:'create',event_time:time,updates:update});
async function seed(f){await f.db.exec("INSERT INTO users(id,name,email,password_hash) VALUES('a','Synthetic','a@example.invalid','synthetic'); INSERT INTO strava_tokens(user_id,athlete_id,access_token,refresh_token) VALUES('a',123,'synthetic','synthetic')");await f.migrate();}
async function strip(f){await f.db.exec('ALTER TABLE provider_event_jobs DROP COLUMN episode_started_at');await f.db.run('DELETE FROM schema_migrations WHERE version=?',[migration.EPISODE_MIGRATION_VERSION]);}
const job=f=>f.db.get("SELECT * FROM provider_event_jobs WHERE object_id='900'");
async function insertOld(f,extra=''){
  await f.db.exec(`INSERT INTO provider_event_jobs(id,binding_id,object_type,object_id,last_fingerprint,reported_event_time,last_aspect,state,attempts,first_seen_at,updated_at)
    SELECT 'old-job',id,'activity','900','${'a'.repeat(64)}',10,'create','RETRY',12,'2020-01-01T00:00:00Z','2026-09-30T00:00:00Z' FROM strava_ingress_bindings;${extra}`);
}
async function extras(f){return plain({control:await f.db.all('SELECT * FROM background_sync_control'),fence:await f.db.all('SELECT * FROM strava_connection_fences'),eligibility:await f.db.all('SELECT * FROM run_save_eligibility'),tokens:await f.db.all('SELECT * FROM strava_tokens')});}
async function upgrade(f){
  await seed(f);await strip(f);await insertOld(f,'CREATE INDEX retained_job_attempts ON provider_event_jobs(attempts);');
  if(f.dialect==='sqlite')await f.db.exec("CREATE TRIGGER retained_job_guard BEFORE UPDATE ON provider_event_jobs BEGIN SELECT RAISE(ABORT,'synthetic retained job trigger'); END");
  const old=plain(await job(f)),before=await extras(f);await f.migrate();let upgraded=plain(await job(f));
  assert.equal(millis(upgraded.episode_started_at),millis(old.first_seen_at));delete upgraded.episode_started_at;assert.deepEqual(upgraded,old);
  assert.deepEqual(await extras(f),before,'migration does not reset activation/pause/caps/fence/eligibility');
  const full=plain(await job(f));await f.migrate();assert.deepEqual(plain(await job(f)),full,'rerun preserves episode byte-for-byte');
  const indexes=await f.db.all(f.dialect==='sqlite'?"SELECT name FROM sqlite_master WHERE type='index'":"SELECT indexname AS name FROM pg_indexes WHERE schemaname=current_schema()");
  assert.ok(indexes.some(r=>r.name==='retained_job_attempts'));assert.ok(indexes.some(r=>r.name==='bg_jobs_due'));
  if(f.dialect==='sqlite'){
    await assert.rejects(async()=>f.db.run('UPDATE provider_event_jobs SET attempts=1'),/synthetic retained job trigger/);
    await f.db.exec('DROP TRIGGER retained_job_guard');
  }
  for(const value of [null,'invalid','infinity','-infinity'])await assert.rejects(async()=>f.db.run('UPDATE provider_event_jobs SET episode_started_at=?',[value]));
  await assert.rejects(async()=>f.db.run("UPDATE provider_event_jobs SET binding_id='foreign'"));
  await assert.rejects(async()=>f.db.run("UPDATE provider_event_jobs SET state='LEASED'"));
  await assert.rejects(async()=>f.db.run('UPDATE provider_event_jobs SET processed_revision=requested_revision+1'));
  await f.db.run("DELETE FROM strava_tokens WHERE user_id='a'");assert.equal((await f.db.all('SELECT * FROM provider_event_jobs')).length,0);
  console.log(`PASS ${f.dialect} actual pre-episode upgrade/backfill/rerun/bytes/index/FK/check/cascade`);
}
async function malformed(make){
  for(const mode of ['unrecorded','partial','missing','type','default','check','extra','index','first-clock','attempts','revision','fault']){
    const f=await make();try{await seed(f);
      if(mode==='unrecorded')await f.db.run('DELETE FROM schema_migrations WHERE version=?',[migration.EPISODE_MIGRATION_VERSION]);
      else if(mode==='missing')await f.db.exec('ALTER TABLE provider_event_jobs DROP COLUMN episode_started_at');
      else if(mode==='partial'){await strip(f);await f.db.exec('ALTER TABLE provider_event_jobs ADD COLUMN episode_started_at TEXT');}
      else if(['type','default','check'].includes(mode)){
        if(f.dialect==='sqlite'){
          const original=(await f.db.get("SELECT sql FROM sqlite_master WHERE name='provider_event_jobs' AND type='table'")).sql;
          const changed=mode==='type'?original.replace('episode_started_at TEXT','episode_started_at BLOB'):mode==='default'?original.replace('episode_started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP','episode_started_at TEXT NOT NULL DEFAULT 0'):original.replace("julianday(episode_started_at) IS NOT NULL","episode_started_at IS NOT NULL");
          assert.notEqual(changed,original);await f.db.exec('PRAGMA writable_schema=ON');await f.db.run("UPDATE sqlite_master SET sql=? WHERE name='provider_event_jobs' AND type='table'",[changed]);await f.db.exec('PRAGMA writable_schema=RESET');
        }else{
          if(mode==='type')await f.db.exec('ALTER TABLE provider_event_jobs ALTER COLUMN episode_started_at TYPE TIMESTAMP');
          if(mode==='default')await f.db.exec("ALTER TABLE provider_event_jobs ALTER COLUMN episode_started_at SET DEFAULT '2020-01-01'::timestamptz");
          if(mode==='check')await f.db.exec('ALTER TABLE provider_event_jobs DROP CONSTRAINT bg_jobs_episode_finite; ALTER TABLE provider_event_jobs ADD CONSTRAINT bg_jobs_episode_finite CHECK(episode_started_at IS NOT NULL)');
        }
      }else if(mode==='extra')await f.db.exec('ALTER TABLE provider_event_jobs ADD COLUMN unknown INTEGER');
      else if(mode==='index')await f.db.exec('DROP INDEX bg_jobs_due; CREATE INDEX bg_jobs_due ON provider_event_jobs(id)');
      else{
        await strip(f);await insertOld(f);
        if(mode==='first-clock')await f.db.run('UPDATE provider_event_jobs SET first_seen_at=?',[f.dialect==='sqlite'?'malformed':'infinity']);
        if(mode==='attempts'||mode==='revision'){
          if(f.dialect==='sqlite'){await f.db.exec('PRAGMA ignore_check_constraints=ON');await f.db.exec(`UPDATE provider_event_jobs SET ${mode==='attempts'?'attempts=-1':'requested_revision=0'}`);await f.db.exec('PRAGMA ignore_check_constraints=OFF');}
          else{const col=mode==='attempts'?'attempts':'requested_revision';await f.db.exec(`ALTER TABLE provider_event_jobs DROP CONSTRAINT provider_event_jobs_${col}_check`);await f.db.exec(`UPDATE provider_event_jobs SET ${col}=${mode==='attempts'?'-1':'0'}`);}
        }
        if(mode==='fault'){
          const before=plain(await job(f)),err=new Error('synthetic episode copy failure');
          if(f.dialect==='sqlite'){
            const wrapper={function:(...args)=>f.native.function(...args),get isTransaction(){return f.native.isTransaction;},prepare:s=>f.native.prepare(s),exec:s=>{if(s.includes('INSERT INTO bg_episode_jobs')){f.native.exec(s);throw err;}return f.native.exec(s);}};
            await assert.rejects(()=>migration.migrateBackgroundSyncSqlite(wrapper),e=>e===err);
            assert.equal(f.native.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
          }else{
            const wrapped={connect:async()=>{const c=await f.pool.connect();return {release:()=>c.release(),query:async(s,p)=>{if(s.includes('ADD COLUMN episode_started_at')){await c.query(s,p);throw err;}return c.query(s,p);}};}};
            await assert.rejects(()=>migration.migrateBackgroundSyncPostgres(wrapped),e=>e===err);
          }
          assert.deepEqual(plain(await job(f)),before);assert.equal(await f.db.get('SELECT version FROM schema_migrations WHERE version=?',[migration.EPISODE_MIGRATION_VERSION]),undefined);await f.migrate();continue;
        }
      }
      await assert.rejects(f.migrate,e=>e.code?.startsWith('BACKGROUND_SCHEMA_EPISODE'),mode);
      if(f.dialect==='sqlite')assert.equal(f.native.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
    }finally{await f.close();}
  }
  console.log('PASS episode recorded/partial/type/default/check/index/rows/fault failure controls');
}
async function transitions(f){
  await seed(f);let now=Date.parse('2026-09-30T12:00:00Z');
  const intake=hint=>f.transaction(tx=>storeHint({...tx,dialect:f.dialect,get:(s,p)=>s.includes(' AS now')?{now:iso(now)}:tx.get(s,p)},hint));
  await intake(event());const first=await job(f);assert.equal(millis(first.episode_started_at),now);assert.equal(Number(first.attempts),0);
  const originalFirst=plain(first.first_seen_at),old=iso(now-73*3600000);
  for(const state of ['PENDING','RETRY','LEASED','DONE','DEAD']){
    await f.db.run(`UPDATE provider_event_jobs SET state=?,attempts=12,episode_started_at=?,last_fetch_at=?,updated_at=?,available_at=?,
      processed_revision=requested_revision,lease_token=?,lease_until=?,leased_revision=?`,[state,old,iso(now-60000),iso(now-60000),iso(now-30000),state==='LEASED'?'lease':null,state==='LEASED'?iso(now-1):null,state==='LEASED'?Number((await job(f)).requested_revision):null]);
    const replay=event(Number((await job(f)).reported_event_time),{state});
    await f.db.run('UPDATE provider_event_jobs SET last_fingerprint=?',[replay.fingerprint]);
    const prior=plain(await job(f));await intake(replay);assert.deepEqual(plain(await job(f)),prior,`${state} exact replay preserves every field`);
    const matching=event(Number(prior.reported_event_time),{state,distinct:true});
    // New hint, then another exact replay in the resulting state.
    await intake(matching);let changed=plain(await job(f));
    if(state==='DONE'){assert.equal(millis(changed.episode_started_at),now);assert.equal(Number(changed.attempts),0);}
    else {assert.equal(changed.episode_started_at,prior.episode_started_at);assert.equal(Number(changed.attempts),12);}
    assert.deepEqual(changed.first_seen_at,originalFirst);
    const stable=plain(await job(f));now+=1000;await intake(matching);assert.deepEqual(plain(await job(f)),stable,'duplicate no-op including episode and clocks');
    if(state==='LEASED')for(const key of ['state','lease_token','lease_until','leased_revision','available_at','processed_revision','last_fetch_at'])assert.deepEqual(changed[key],prior[key]);
  }
  // Clean DONE distinct work resets once, but cannot advance last-fetch spacing.
  await f.db.exec("UPDATE provider_event_jobs SET state='DONE',processed_revision=requested_revision,lease_token=NULL,lease_until=NULL,leased_revision=NULL");
  await f.db.run('UPDATE provider_event_jobs SET last_fetch_at=?,episode_started_at=?,attempts=12',[iso(now-1000),old]);await intake(event(50));
  let r=await job(f);assert.equal(millis(r.episode_started_at),now);assert.equal(millis(r.available_at),now+29000);assert.equal(Number(r.attempts),0);
  // Same/older hints do not move DEAD cooldown; exact30s newer hint restarts.
  await f.db.run("UPDATE provider_event_jobs SET state='DEAD',attempts=12,episode_started_at=?,last_fetch_at=?,updated_at=?",[old,iso(now-30000),iso(now-30000)]);
  const dead=plain(await job(f));await intake(event(49));r=plain(await job(f));assert.equal(r.episode_started_at,dead.episode_started_at);assert.equal(r.updated_at,dead.updated_at);
  now-=1;await intake(event(51));assert.equal((await job(f)).state,'DEAD');now+=1;await intake(event(52));r=await job(f);assert.equal(r.state,'PENDING');assert.equal(millis(r.episode_started_at),now);assert.equal(Number(r.attempts),0);
  // Boundary budgets are retained by intake, NOT worker execution proof. It
  // must not convert dirty callbacks into a new allowance at11/12 or72hours.
  for(const attempts of [0,11,12])for(const age of [72*3600000-1,72*3600000,72*3600000+1]){
    await f.db.run("UPDATE provider_event_jobs SET state='RETRY',attempts=?,episode_started_at=?",[attempts,iso(now-age)]);
    const prior=plain(await job(f));await intake(event(60+attempts,{age}));r=plain(await job(f));assert.equal(r.episode_started_at,prior.episode_started_at);assert.equal(Number(r.attempts),attempts);
  }
  await f.db.exec("UPDATE provider_event_jobs SET state='DONE',processed_revision=requested_revision-1");const inconsistent=plain(await job(f));
  await assert.rejects(()=>intake(event(100)),{code:'STRAVA_INTAKE_STATE_INVALID'});assert.deepEqual(plain(await job(f)),inconsistent);
  console.log(`PASS ${f.dialect} complete intake transition/reset/no-op/cooldown/12-72 preservation matrix; worker enforcement deferred`);
}
async function fileLock(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'forge-episode-')),file=path.join(dir,'episode.sqlite'),f=sqlite(file);let blocker;
  try{await seed(f);await strip(f);await insertOld(f);blocker=new DatabaseSync(file);
    const before=plain(await job(f));let engaged=false;
    const wrapped={function:(...args)=>f.native.function(...args),get isTransaction(){return f.native.isTransaction;},prepare:s=>f.native.prepare(s),exec:s=>{
      if(s==='BEGIN EXCLUSIVE'){blocker.exec('BEGIN EXCLUSIVE');engaged=true;}
      return f.native.exec(s);
    }};
    await assert.rejects(()=>migration.migrateBackgroundSyncSqlite(wrapped),e=>/locked/.test(e.message));assert.ok(engaged,'failure targets episode BEGIN, not earlier base migration');
    assert.equal(f.native.prepare('PRAGMA foreign_keys').get().foreign_keys,1);blocker.exec('ROLLBACK');assert.deepEqual(plain(await job(f)),before);await f.migrate();
    assert.equal(f.native.prepare('PRAGMA foreign_key_check').all().length,0);
    console.log('PASS real file-backed two-connection episode BEGIN failure restores FK1, preserves original error/data, then upgrades');
  }finally{if(blocker){if(blocker.isTransaction)blocker.exec('ROLLBACK');blocker.close();}f.close();fs.rmSync(file,{force:true});fs.rmdirSync(dir);}
}
async function postgres(){
  const {Pool}=require('pg'),url=new URL('postgresql://forge_background_test@127.0.0.1:55449/forge_background_test'),admin=new Pool({connectionString:url.href});
  const name='forge_episode_'+randomBytes(8).toString('hex');let pool,created=false;
  try{assert.deepEqual((await admin.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0],{db:'forge_background_test',role:'forge_background_test',port:55449});await admin.query(`CREATE DATABASE "${name}"`);created=true;url.pathname='/'+name;pool=new Pool({connectionString:url.href});
    const adapter=c=>{const q=(s,p=[])=>{let i=0;return c.query(s.replace(/\?/g,()=>`$${++i}`),p);};return{exec:s=>c.query(s),get:async(s,p)=>(await q(s,p)).rows[0],all:async(s,p)=>(await q(s,p)).rows,run:async(s,p)=>({changes:(await q(s,p)).rowCount})};};
    const make=async()=>{await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');await pool.query(baseSql('postgres'));return{dialect:'postgres',pool,db:adapter(pool),migrate:()=>migration.migrateBackgroundSyncPostgres(pool),close:()=>{},transaction:async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const v=await fn(adapter(c));await c.query('COMMIT');return v;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}};};
    await upgrade(await make());await malformed(make);await transitions(await make());
    const f=await make();await seed(f);await strip(f);await insertOld(f);await Promise.all([f.migrate(),f.migrate()]);assert.equal((await f.db.all('SELECT version FROM schema_migrations WHERE version=?',[migration.EPISODE_MIGRATION_VERSION])).length,1);
    const initial=await job(f),eventHint=event(99);await f.db.exec("UPDATE provider_event_jobs SET state='DONE',processed_revision=requested_revision");
    const send=()=>f.transaction(tx=>storeHint({...tx,dialect:'postgres'},eventHint));await Promise.all([send(),send()]);const after=await job(f);
    assert.equal(Number(after.requested_revision),Number(initial.requested_revision)+1);assert.equal(Number(after.attempts),0);assert.equal(millis(after.first_seen_at),millis(initial.first_seen_at));
    console.log('PASS real PG concurrent migration once and concurrent identical DONE restart once');
  }finally{if(pool)await pool.end();if(created){await admin.query(`DROP DATABASE "${name}"`);console.log('Removed owned episode child '+name);}await admin.end();}
}
(async()=>{let f=sqlite();try{await upgrade(f);}finally{f.close();}await malformed(sqlite);f=sqlite();try{await transitions(f);}finally{f.close();}await fileLock();if(process.argv.includes('--postgres'))await postgres();console.log('STRAVA EVENT EPISODE W1 OK — no worker/activation authority');})().catch(e=>{console.error(e);process.exitCode=1;});
