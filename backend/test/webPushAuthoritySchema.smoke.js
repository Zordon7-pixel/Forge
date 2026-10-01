'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const migration=require('../src/db/backgroundSyncSchema');
const marker=migration.WEB_PUSH_AUTHORITY_VERSION;
const fixtureSql=dialect=>fs.readFileSync(path.join(__dirname,`fixtures/web-push-predecessor-c0495ac7.${dialect==='sqlite'?'sqlite':'pg'}.sql`),'utf8');
const plain=x=>JSON.parse(JSON.stringify(x));
const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function sqlite(file=':memory:') {
  const native=new DatabaseSync(file);native.exec('PRAGMA foreign_keys=OFF');native.exec(fixtureSql('sqlite'));native.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0');
  const db={dialect:'sqlite',exec:s=>native.exec(s),all:(s,p=[])=>native.prepare(s).all(...p),get:(s,p=[])=>native.prepare(s).get(...p),run:(s,p=[])=>native.prepare(s).run(...p)};
  return {dialect:'sqlite',native,db,migrate:()=>migration.migrateBackgroundSyncSqlite(native),close:()=>native.close()};
}
async function postgres() {
  const {Pool}=require('pg');const admin=new Pool({connectionString:'postgresql://forge_background_test@127.0.0.1:55449/forge_background_test'});
  const name='forge_d2_authority_'+crypto.randomBytes(8).toString('hex');let pool,created=false;
  try {
    assert.deepEqual((await admin.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0],{db:'forge_background_test',role:'forge_background_test',port:55449});
    await admin.query(`CREATE DATABASE "${name}"`);created=true;
    pool=new Pool({connectionString:`postgresql://forge_background_test@127.0.0.1:55449/${name}`});await pool.query(fixtureSql('postgres'));
    const query=(s,p=[])=>{let i=0;return pool.query(s.replace(/\?/g,()=>`$${++i}`),p);};
    return {dialect:'postgres',pool,db:{dialect:'postgres',exec:s=>pool.query(s),all:async(s,p)=>(await query(s,p)).rows,get:async(s,p)=>(await query(s,p)).rows[0],run:async(s,p)=>({changes:(await query(s,p)).rowCount})},migrate:()=>migration.migrateBackgroundSyncPostgres(pool),close:async()=>{await pool.end();await admin.query(`DROP DATABASE "${name}"`);await admin.end();console.log('Removed owned authority child '+name);}};
  } catch(error){if(pool)await pool.end();if(created)await admin.query(`DROP DATABASE "${name}"`);await admin.end();throw error;}
}
async function seedTargets(f) {
  await f.db.exec(`INSERT INTO users(id,name,email,password_hash) VALUES('a','Synthetic','a@example.invalid','synthetic'),('b','Synthetic','b@example.invalid','synthetic');
    INSERT INTO push_subscriptions(id,user_id,endpoint,keys_p256dh,keys_auth) VALUES('pa','a','https://fcm.googleapis.com/a','key-a','auth-a'),('pb','b','https://fcm.googleapis.com/b','key-b','auth-b');`);
}
async function activeClaim(f,hash='a'.repeat(64),incarnation=uuid(1),target='pa') {
  await f.db.run(`INSERT INTO web_push_claims(endpoint_hash,incarnation,state,claim_revision,proof_hash,subscription_id,last_operation_id,confirm_hash)
    VALUES(?,?,'ACTIVE',1,?,?,'operation',?)`,[hash,incarnation,'b'.repeat(64),target,Buffer.alloc(32,7)]);
}
async function delivery(f,id='delivery') {
  await f.db.exec(`INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds) VALUES('run','a','2026-01-01','easy',1,600);
    INSERT INTO user_notifications(id,user_id,type,title,body,source_key) VALUES('notice','a','activity','Synthetic','Synthetic','synthetic');
    INSERT INTO activity_notification_events(id,user_id,run_id,notification_id,state) VALUES('event','a','run','notice','ACTIVE');`);
  await f.db.run(`INSERT INTO notification_deliveries(id,user_id,event_id,notification_id,transport,target_id,target_generation,disclosure,state,expires_at)
    VALUES(?,'a','event','notice','WEB_PUSH','pa','generation','GENERIC','PENDING','2099-01-01')`,[id]);
}
async function upgrade(f) {
  await seedTargets(f);const original=plain(await f.db.get('SELECT * FROM background_sync_control'));
  await f.migrate();assert.deepEqual(plain(await f.db.get('SELECT * FROM background_sync_control')),original);
  const control=plain(await f.db.get('SELECT * FROM web_push_delivery_control'));
  assert.equal(control.state,'CONFIG_PAUSED');assert.equal(control.pause_reason,'CONFIG_UNVERIFIED');assert.equal(control.configuration_identity,null);assert.equal(Number(control.revision),1);
  await f.migrate();assert.deepEqual(plain(await f.db.get('SELECT * FROM web_push_delivery_control')),control);
  const names=await f.db.all(f.dialect==='sqlite'?"SELECT name FROM sqlite_master WHERE type='trigger'":"SELECT tgname AS name FROM pg_trigger WHERE NOT tgisinternal");
  assert.equal(names.filter(r=>r.name==='bg_delete_target_claim').length,1);assert.equal(names.filter(r=>r.name==='bg_target_delete').length,0);
  const reject=(s,p)=>assert.rejects(async()=>f.db.run(s,p));
  await reject("UPDATE web_push_delivery_control SET state='ACTIVE'");await reject('UPDATE web_push_delivery_control SET revision=0');
  await activeClaim(f);await reject("DELETE FROM web_push_claims WHERE subscription_id='pa'");
  await reject("UPDATE web_push_claims SET claim_revision=2 WHERE subscription_id='pa'");
  await reject("UPDATE web_push_claims SET incarnation=?,state='VACANT',claim_revision=0 WHERE subscription_id='pa'",[uuid(2)]);
  await f.db.run('INSERT INTO web_push_challenges(id,user_id,subscription_id,endpoint_hash,expected_incarnation,proof_hash,expected_revision,operation_id,expires_at) VALUES(?,?,?,?,?,?,0,?,?)',
    ['foreign','b','pb','a'.repeat(64),uuid(1),'c'.repeat(64),'foreign-operation','2099-01-01']);
  const foreign=plain(await f.db.get("SELECT * FROM web_push_challenges WHERE id='foreign'"));
  await f.db.run("DELETE FROM push_subscriptions WHERE id='pa'");
  const vacant=await f.db.get('SELECT * FROM web_push_claims');assert.equal(vacant.state,'VACANT');assert.notEqual(vacant.incarnation,uuid(1));assert.equal(Number(vacant.claim_revision),0);
  for(const key of ['proof_hash','subscription_id','last_operation_id','confirm_hash'])assert.equal(vacant[key],null);
  assert.deepEqual(plain(await f.db.get("SELECT * FROM web_push_challenges WHERE id='foreign'")),foreign,'no foreign challenge scan/delete or stale tuple rewrite');
  await reject('DELETE FROM web_push_claims');
  await f.db.run("DELETE FROM web_push_challenges WHERE id='foreign'");await f.db.run('DELETE FROM web_push_claims');
  await f.migrate();assert.equal(Number((await f.db.get('SELECT count(*) AS n FROM schema_migrations WHERE version=?',[marker])).n),1);
  console.log(`PASS ${f.dialect} actual immutable predecessor → successor/rerun/catalog/neutralization/foreign FK/control`);
}
async function admissions(f) {
  await seedTargets(f);await f.migrate();await delivery(f);
  const reject=(s,p)=>assert.rejects(async()=>f.db.run(s,p));
  for(let attempt=1;attempt<=12;attempt++) {
    const lease=uuid(attempt);
    await f.db.run("UPDATE notification_deliveries SET state='LEASED',lease_token=?,lease_until='2098-01-01' WHERE id='delivery'",[lease]);
    const charge=()=>f.db.run("UPDATE notification_deliveries SET admitted_lease_token=lease_token,attempts=attempts+1 WHERE id='delivery' AND admitted_lease_token IS NULL");
    assert.equal(Number((await charge()).changes),1);assert.equal(Number((await charge()).changes),0,'lost-reply repeated admission cannot charge/send twice');
    await reject("UPDATE notification_deliveries SET admitted_lease_token=NULL WHERE id='delivery'");
    await reject("UPDATE notification_deliveries SET attempts=attempts+1 WHERE id='delivery'");
    await reject("UPDATE notification_deliveries SET state='CANCELLED',lease_token=NULL,lease_until=NULL WHERE id='delivery'");
    await f.db.run("UPDATE notification_deliveries SET state='RETRY',lease_token=NULL,lease_until=NULL,admitted_lease_token=NULL WHERE id='delivery'");
  }
  await f.db.run("UPDATE notification_deliveries SET state='LEASED',lease_token=?,lease_until='2098-01-01' WHERE id='delivery'",[uuid(13)]);
  await reject("UPDATE notification_deliveries SET admitted_lease_token=lease_token,attempts=attempts+1 WHERE id='delivery'");
  await f.db.run("UPDATE notification_deliveries SET state='CANCELLED',lease_token=NULL,lease_until=NULL,admitted_lease_token=NULL WHERE id='delivery'");
  const terminal=await f.db.get("SELECT * FROM notification_deliveries WHERE id='delivery'");assert.equal(Number(terminal.attempts),12);assert.ok(terminal.terminal_at);
  await reject("UPDATE notification_deliveries SET state='RETRY' WHERE id='delivery'");
  if(f.dialect==='sqlite')await reject("UPDATE notification_deliveries SET terminal_at='2099-01-01' WHERE id='delivery'");
  else {await f.db.run("UPDATE notification_deliveries SET terminal_at='2099-01-01' WHERE id='delivery'");assert.equal(String((await f.db.get("SELECT terminal_at FROM notification_deliveries WHERE id='delivery'")).terminal_at),String(terminal.terminal_at));}
  console.log(`PASS ${f.dialect} admitted lease CAS/null clearing/old SET rejected/exact twelve attempts/server terminal clock`);
}
async function negatives(make) {
  for(const kind of ['claims','challenges','operations','deliveries','active','partial','marker','trigger','duplicate-trigger','constraint','fault']) {
    const f=await make();try {
      await seedTargets(f);
      if(kind==='active')await f.db.exec('UPDATE push_subscriptions SET active=TRUE');
      if(['claims','challenges','operations','deliveries'].includes(kind)) {
        if(kind==='claims')await f.db.run("INSERT INTO web_push_claims(endpoint_hash,proof_hash,subscription_id) VALUES(?,?,'pa')",['a'.repeat(64),'b'.repeat(64)]);
        if(['challenges','operations'].includes(kind))await f.db.run("INSERT INTO web_push_challenges(id,user_id,subscription_id,proof_hash,expected_revision,operation_id,expires_at) VALUES('old','a','pa',?,0,'old','2099-01-01')",['a'.repeat(64)]);
        if(kind==='operations')await f.db.run("INSERT INTO web_push_setup_operations(challenge_id,endpoint_hash,client_nonce_hash,session_hash,request_hash,auth_epoch,retain_until_ms) VALUES('old',?,?,?, ?,?,1)",[Buffer.alloc(32),Buffer.alloc(32),Buffer.alloc(32),Buffer.alloc(32),uuid(1)]);
        if(kind==='deliveries')await delivery(f);
      }
      if(kind==='partial')await f.db.exec('ALTER TABLE web_push_claims ADD COLUMN incarnation TEXT');
      if(kind==='marker')await f.db.run('INSERT INTO schema_migrations(version) VALUES(?)',[marker]);
      if(kind==='trigger')await f.db.exec(f.dialect==='sqlite'?'DROP TRIGGER bg_target_delete':'DROP TRIGGER bg_delete_target_claim ON push_subscriptions');
      if(kind==='duplicate-trigger')await f.db.exec(f.dialect==='sqlite'?"CREATE TRIGGER bg_delete_target_claim BEFORE DELETE ON push_subscriptions BEGIN SELECT 1; END":"CREATE TRIGGER bg_target_delete BEFORE DELETE ON push_subscriptions FOR EACH ROW EXECUTE FUNCTION bg_delete_target_claim()");
      if(kind==='constraint') {
        if(f.dialect==='sqlite') {await f.db.exec('PRAGMA writable_schema=ON');await f.db.run("UPDATE sqlite_master SET sql=replace(sql,'CHECK(claim_revision>=0)','CHECK(claim_revision>=-1)') WHERE name='web_push_claims'");await f.db.exec('PRAGMA writable_schema=OFF');}
        else await f.db.exec('ALTER TABLE web_push_claims DROP CONSTRAINT web_push_claims_claim_revision_check');
      }
      const before=plain(await f.db.all('SELECT * FROM web_push_claims'));
      if(kind==='fault') {
        const fail=new Error('synthetic authority transform failure');
        if(f.dialect==='sqlite') {const wrapped={function:(...a)=>f.native.function(...a),prepare:s=>f.native.prepare(s),get isTransaction(){return f.native.isTransaction;},exec:s=>{if(s.startsWith('DROP TRIGGER bg_target_delete;')){f.native.exec(s);throw fail;}return f.native.exec(s);}};await assert.rejects(()=>migration.migrateBackgroundSyncSqlite(wrapped),e=>e===fail);}
        else {const wrapped={connect:async()=>{const c=await f.pool.connect();return {release:()=>c.release(),query:async(s,p)=>{if(s.startsWith('DROP TRIGGER bg_delete_target_claim ON')){await c.query(s,p);throw fail;}return c.query(s,p);}};}};await assert.rejects(()=>migration.migrateBackgroundSyncPostgres(wrapped),e=>e===fail);}
      } else await assert.rejects(()=>f.migrate(),e=>e.code?.startsWith('BACKGROUND_SCHEMA_'),kind);
      assert.deepEqual(plain(await f.db.all('SELECT * FROM web_push_claims')),before,kind+' leaves predecessor data unchanged');
      if(kind!=='marker')assert.equal(Boolean(await f.db.get('SELECT version FROM schema_migrations WHERE version=?',[marker])),false);
      if(f.dialect==='sqlite')assert.equal((await f.db.get('PRAGMA foreign_keys')).foreign_keys,1);
    } finally {await f.close();}
  }
  console.log('PASS nonempty/partial/marker/actual trigger+constraint tamper/transform rollback fail closed');
}
async function sqliteConnections() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'forge-d2-uuid-')),file=path.join(dir,'fixture.sqlite');let f,other;
  try {
    f=sqlite(file);other=new DatabaseSync(file);other.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0');
    f.native.exec('BEGIN EXCLUSIVE');await assert.rejects(()=>migration.migrateBackgroundSyncSqlite(other),/locked/);assert.equal(other.prepare('PRAGMA foreign_keys').get().foreign_keys,1);f.native.exec('ROLLBACK');
    // Migration registers before BEGIN, even when BEGIN fails. A genuinely new
    // connection is required for the missing-registration negative control.
    other.close();other=new DatabaseSync(file);other.exec('PRAGMA foreign_keys=ON');
    await seedTargets(f);await f.migrate();await activeClaim(f);
    await assert.rejects(async()=>other.prepare("DELETE FROM push_subscriptions WHERE id='pa'").run(),/no such function/);
    assert.ok(await f.db.get("SELECT id FROM push_subscriptions WHERE id='pa'"));
    await activeClaim(f,'b'.repeat(64),uuid(2),'pb');
    f.native.function('forge_web_push_incarnation',{deterministic:false},()=>uuid(2));
    await assert.rejects(async()=>f.db.run("DELETE FROM push_subscriptions WHERE id='pa'"),/UNIQUE/);
    assert.equal((await f.db.get("SELECT state FROM web_push_claims WHERE subscription_id='pa'")).state,'ACTIVE');
    await f.migrate();await migration.migrateBackgroundSyncSqlite(other);
    await other.prepare("DELETE FROM push_subscriptions WHERE id='pa'").run();
    assert.equal((await f.db.get('SELECT state FROM web_push_claims WHERE endpoint_hash=?',['a'.repeat(64)])).state,'VACANT');
    const noRegistration={prepare:s=>f.native.prepare(s),exec:s=>f.native.exec(s),get isTransaction(){return f.native.isTransaction;}};
    await assert.rejects(()=>migration.migrateBackgroundSyncSqlite(noRegistration),{code:'BACKGROUND_SCHEMA_SQLITE_UUID_REGISTRATION'});
  } finally {if(f?.native.isTransaction)f.native.exec('ROLLBACK');other?.close();f?.close();for(const suffix of ['','-wal','-shm','-journal'])if(fs.existsSync(file+suffix))fs.unlinkSync(file+suffix);fs.rmdirSync(dir);}
  console.log('PASS two actual SQLite connections/missing UUID/collision/FK restoration/explicit registration');
}
async function successorNegatives(make) {
  for(const mode of ['marker-removed','trigger-removed','trigger-body','extra-column','control-missing']) {
    const f=await make();try {
      await f.migrate();
      if(mode==='marker-removed')await f.db.run('DELETE FROM schema_migrations WHERE version=?',[marker]);
      if(mode==='trigger-removed')await f.db.exec(f.dialect==='sqlite'?'DROP TRIGGER bg_delete_target_claim':'DROP TRIGGER bg_delete_target_claim ON push_subscriptions');
      if(mode==='trigger-body') {
        if(f.dialect==='sqlite')await f.db.exec("DROP TRIGGER bg_push_authority_transition_guard; CREATE TRIGGER bg_push_authority_transition_guard BEFORE UPDATE ON web_push_claims BEGIN SELECT 1; END");
        else await f.db.exec("CREATE OR REPLACE FUNCTION bg_push_authority_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$");
      }
      if(mode==='extra-column')await f.db.exec('ALTER TABLE web_push_claims ADD COLUMN residue TEXT');
      if(mode==='control-missing')await f.db.exec('DELETE FROM web_push_delivery_control');
      await assert.rejects(()=>f.migrate(),e=>e.code?.startsWith('BACKGROUND_SCHEMA_'),mode);
    }finally{await f.close();}
  }
  console.log('PASS recorded successor exact catalog/trigger/control validation (marker alone never sufficient)');
}
async function sqliteAuthorityBeginFailure() {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'forge-d2-begin-')),file=path.join(dir,'fixture.sqlite'),f=sqlite(file),locker=new DatabaseSync(file);let begins=0;
  locker.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0');
  const wrapped={function:(...a)=>f.native.function(...a),prepare:s=>f.native.prepare(s),get isTransaction(){return f.native.isTransaction;},exec:s=>{
    if(s.startsWith('BEGIN EXCLUSIVE')&&++begins===3)locker.exec('BEGIN EXCLUSIVE');return f.native.exec(s);
  }};
  try {
    await assert.rejects(()=>migration.migrateBackgroundSyncSqlite(wrapped),/locked/);assert.equal(begins,3,'failure is D2a BEGIN, after earlier stages');
    assert.equal(f.native.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.equal(f.native.isTransaction,false);
    locker.exec('ROLLBACK');assert.equal(Boolean(await f.db.get('SELECT version FROM schema_migrations WHERE version=?',[marker])),false);await f.migrate();
  }finally{if(locker.isTransaction)locker.exec('ROLLBACK');locker.close();f.close();for(const suffix of ['','-wal','-shm','-journal'])if(fs.existsSync(file+suffix))fs.unlinkSync(file+suffix);fs.rmdirSync(dir);}
  console.log('PASS actual second-connection D2a failed BEGIN restores FK and preserves original lock failure');
}
async function runWebPushAuthoritySchemaSmoke({pg=false}={}) {
  for(const work of [upgrade,admissions]){const f=sqlite();try{await work(f);}finally{f.close();}}
  await negatives(async()=>sqlite());await successorNegatives(async()=>sqlite());await sqliteConnections();await sqliteAuthorityBeginFailure();
  if(pg){for(const work of [upgrade,admissions]){const f=await postgres();try{await work(f);}finally{await f.close();}}await negatives(postgres);await successorNegatives(postgres);
    const f=await postgres();try{await Promise.all([f.migrate(),f.migrate()]);assert.equal(Number((await f.db.get('SELECT count(*) AS n FROM schema_migrations WHERE version=?',[marker])).n),1);}finally{await f.close();}
    console.log('PASS separate PG clients concurrent predecessor migration/rerun serialized to one marker');
  }
  console.log('WEB PUSH AUTHORITY SCHEMA GATE OK — dormant schema prerequisite only');
}
module.exports={runWebPushAuthoritySchemaSmoke,sqlite,postgres,seedTargets,activeClaim,delivery,uuid,plain};
if(require.main===module)runWebPushAuthoritySchemaSmoke({pg:process.argv.includes('--postgres')}).catch(e=>{console.error(e);process.exitCode=1;});
