// Real schema-only SQLite gate; --postgres adds guarded disposable PG child.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const migration = require('../src/db/backgroundSyncSchema');
const account = require('../src/lib/accountDataCoverage');
const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.pg.sql'), 'utf8');
const baseTables = ['users', 'runs', 'strava_tokens', 'push_subscriptions', 'user_notifications'];
let sqliteManifest;
async function manifest(db, dialect) {
  const result = {};
  for (const table of [...migration._test.OWNED_TABLES,'strava_tokens','push_subscriptions']) {
    const columns = dialect === 'sqlite' ? await db.all(`PRAGMA table_info(${table})`)
      : await db.all('SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=?',[table]);
    let fks;
    if (dialect === 'sqlite') {
      const rows=await db.all(`PRAGMA foreign_key_list(${table})`), groups=new Map();
      for (const row of rows) { if (!groups.has(row.id)) groups.set(row.id,[]); groups.get(row.id).push(row); }
      fks=[...groups.values()].map(group=>{group.sort((a,b)=>a.seq-b.seq);return [group.map(r=>r.from).join(','),group[0].table,group.map(r=>r.to).join(','),group[0].on_delete].join('|');});
    } else {
      const rows=await db.all(`SELECT c.conname,k.ord,a.attname AS source,t.relname AS target,b.attname AS dest,c.confdeltype AS deletion
        FROM pg_constraint c JOIN pg_class s ON s.oid=c.conrelid JOIN pg_namespace n ON n.oid=s.relnamespace
        JOIN pg_class t ON t.oid=c.confrelid
        CROSS JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY AS k(src,dst,ord)
        JOIN pg_attribute a ON a.attrelid=s.oid AND a.attnum=k.src
        JOIN pg_attribute b ON b.attrelid=t.oid AND b.attnum=k.dst
        WHERE c.contype='f' AND n.nspname=current_schema() AND s.relname=? ORDER BY c.conname,k.ord`,[table]);
      const groups=new Map();for(const row of rows){if(!groups.has(row.conname))groups.set(row.conname,[]);groups.get(row.conname).push(row);}
      fks=[...groups.values()].map(group=>[group.map(r=>r.source).join(','),group[0].target,group.map(r=>r.dest).join(','),{a:'NO ACTION',c:'CASCADE',n:'SET NULL',r:'RESTRICT'}[group[0].deletion]].join('|'));
    }
    result[table]={columns:columns.map(row=>row.name).sort(),fks:fks.sort()};
  }
  return result;
}
function baseSql(sqlite) {
  const sql = baseTables.map(table => {
    const match = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`));
    assert.ok(match, `real base table ${table}`);
    return match[0];
  }).join('\n');
  return sqlite ? sql.replace(/id SERIAL PRIMARY KEY/g, 'id INTEGER PRIMARY KEY AUTOINCREMENT')
    .replace(/TIMESTAMPTZ/g, 'TEXT').replace(/NOW\(\)/g, 'CURRENT_TIMESTAMP') : sql;
}
async function seed(db) {
  await db.exec(`INSERT INTO users(id,name,email,password_hash) VALUES('a','Synthetic','a@example.invalid','not-a-token'),('b','Synthetic','b@example.invalid','not-a-token');
    INSERT INTO strava_tokens(user_id,athlete_id,access_token,refresh_token) VALUES('a',123,'synthetic','synthetic');
    INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds,health_source,health_source_workout_id,workout_metrics_json)
      VALUES('old','a','2026-01-01','easy',1,600,'strava','101','{"strava_activity_id":101}');
    INSERT INTO push_subscriptions(id,user_id,endpoint,keys_p256dh,keys_auth) VALUES
      ('pa','a','https://push.example.invalid/synthetic','synthetic','synthetic'),
      ('pb','b','https://push.example.invalid/synthetic','synthetic','synthetic');
    CREATE INDEX retained_strava_expiry ON strava_tokens(expires_at);
    CREATE INDEX retained_push_created ON push_subscriptions(created_at);`);
}
function sqliteFixture() {
  const native = new DatabaseSync(':memory:');
  native.exec('PRAGMA foreign_keys=ON'); native.exec(baseSql(true));
  const db = { exec: sql => native.exec(sql),
    all: (sql, p = []) => native.prepare(sql).all(...p), get: (sql, p = []) => native.prepare(sql).get(...p),
    run: (sql, p = []) => native.prepare(sql).run(...p) };
  return { native, db, migrate: () => migration.migrateBackgroundSyncSqlite(native), close: () => native.close() };
}
async function sharedChecks(fixture, dialect) {
  const { db, migrate } = fixture;
  await seed(db);
  const first = await migrate(); assert.equal(first.applied, true);
  const shape=await manifest(db,dialect);
  if(dialect==='sqlite') sqliteManifest=shape; else assert.deepEqual(shape,sqliteManifest,'actual column and composite-FK/on-delete parity');
  const before = await db.get("SELECT activation_at FROM background_sync_control WHERE id='strava'");
  const generation = await db.get("SELECT connection_generation FROM strava_tokens WHERE user_id='a'");
  assert.ok(generation.connection_generation);
  assert.equal(Number((await db.get('SELECT count(*) AS n FROM push_subscriptions WHERE active')).n), 0);
  assert.equal((await db.get("SELECT reason FROM run_save_eligibility WHERE run_id='old'")).reason, 'LEGACY');
  assert.equal((await db.get("SELECT run_id FROM provider_activity_links WHERE object_id='101'")).run_id, 'old');
  await db.exec("INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds) VALUES('later','a','2026-02-01','easy',1,600)");
  assert.equal((await migrate()).applied, false);
  assert.deepEqual(await db.get("SELECT activation_at FROM background_sync_control WHERE id='strava'"), before);
  assert.deepEqual(await db.get("SELECT connection_generation FROM strava_tokens WHERE user_id='a'"), generation);
  assert.equal(Number((await db.get("SELECT count(*) AS n FROM run_save_eligibility WHERE run_id='later'")).n), 0);
  const indexRows = dialect === 'sqlite'
    ? await db.all("SELECT name FROM sqlite_master WHERE type='index'")
    : await db.all('SELECT indexname AS name FROM pg_indexes WHERE schemaname=current_schema()');
  for (const name of ['retained_strava_expiry', 'retained_push_created', 'bg_jobs_due', 'bg_delivery_due', 'bg_active_endpoint']) assert.ok(indexRows.some(row => row.name === name), name);
  const reject = async (sql, params = []) => assert.rejects(async () => db.run(sql, params));
  await reject("UPDATE background_sync_control SET activation_at='2020-01-01' WHERE id='strava'");
  await reject("UPDATE background_sync_control SET eligibility_bootstrapped=FALSE WHERE id='strava'");
  await reject("DELETE FROM background_sync_control WHERE id='strava'");
  await reject("INSERT INTO strava_ingress_bindings(id,user_id,athlete_id) VALUES('fake','b','456')");
  await reject("UPDATE strava_ingress_bindings SET athlete_id='999' WHERE user_id='a'");
  await reject("INSERT INTO provider_activity_links(user_id,provider,object_id,run_id,state) VALUES('b','strava','101','old','ACTIVE')");
  await reject("UPDATE strava_tokens SET token_revision=0 WHERE user_id='a'");
  await reject("UPDATE strava_tokens SET refresh_lease_token='half' WHERE user_id='a'");
  await reject("UPDATE push_subscriptions SET disclosure='PRIVATE' WHERE id='pa'");
  await db.exec("INSERT INTO web_push_challenges(id,user_id,subscription_id,proof_hash,expected_revision,operation_id,expires_at) VALUES('challenge','a','pa','" + 'a'.repeat(64) + "',0,'operation','2099-01-01')");
  const buffer = Buffer.alloc(32, 7);
  await db.run(`INSERT INTO web_push_setup_operations(challenge_id,endpoint_hash,client_nonce_hash,session_hash,request_hash,auth_epoch,retain_until_ms)
    VALUES('challenge',?,?,?,?,'00000000-0000-4000-8000-000000000000',123456)`, [buffer,buffer,buffer,buffer]);
  await reject("UPDATE web_push_setup_operations SET endpoint_hash=? WHERE challenge_id='challenge'", [Buffer.alloc(31)]);
  await reject("UPDATE web_push_setup_operations SET send_state='ACCEPTED' WHERE challenge_id='challenge'");
  await reject("UPDATE web_push_setup_operations SET handoff_count=4 WHERE challenge_id='challenge'");
  await reject("UPDATE web_push_setup_operations SET failed_confirm_count=6 WHERE challenge_id='challenge'");
  await reject("UPDATE web_push_setup_operations SET result_revision=1 WHERE challenge_id='challenge'");
  await db.run("INSERT INTO web_push_setup_rate_buckets(dimension,key_hash,window_start_ms,used_count) VALUES('GLOBAL',?,600000,1)", [buffer]);
  for (const sql of ["UPDATE web_push_setup_rate_buckets SET used_count=101", "UPDATE web_push_setup_rate_buckets SET dimension='UNKNOWN'", "UPDATE web_push_setup_rate_buckets SET window_start_ms=1"]) await reject(sql);
  await db.run("INSERT INTO provider_event_jobs(id,binding_id,object_type,object_id,last_fingerprint,reported_event_time,last_aspect,state) VALUES('job',?,'activity','101',?,1,'create','PENDING')", [generation.connection_generation,'a'.repeat(64)]);
  await reject("UPDATE provider_event_jobs SET state='LEASED' WHERE id='job'");
  await db.exec(`INSERT INTO user_notifications(id,user_id,type,title,body,source_key) VALUES('notice','a','activity','Synthetic','Synthetic','synthetic');
    INSERT INTO activity_notification_events(id,user_id,run_id,notification_id,state) VALUES('event','a','old','notice','ACTIVE');
    INSERT INTO notification_deliveries(id,user_id,event_id,notification_id,transport,target_id,target_generation,disclosure,state,expires_at)
     VALUES('delivery','a','event','notice','WEB_PUSH','pa','generation','GENERIC','PENDING','2099-01-01');
    INSERT INTO web_push_claims(endpoint_hash,proof_hash,subscription_id) VALUES('${'b'.repeat(64)}','${'c'.repeat(64)}','pa');`);
  await reject("UPDATE notification_deliveries SET target_id='pb' WHERE id='delivery'");
  await reject("UPDATE notification_deliveries SET state='ACCEPTED' WHERE id='delivery'");
  await reject("UPDATE web_push_challenges SET subscription_id='pb' WHERE id='challenge'");
  for (const item of account.ACCOUNT_EXPORT_TABLES.filter(item => ['push_subscriptions','strava_connection', ...migration._test.OWNED_TABLES].includes(item.key))) {
    const rows = await db.all(account.buildExportSql(item), ['a']);
    const text = JSON.stringify(rows);
    for (const forbidden of ['keys_auth','keys_p256dh','endpoint_hash','proof_hash','access_token','refresh_token','lease_token','session_hash','request_hash']) assert.ok(!text.includes(`"${forbidden}"`), `${item.key}: ${forbidden}`);
  }
  const secret = 'synthetic-only-setup-rate-key-32bytes';
  const previous = process.env.WEB_PUSH_SETUP_RATE_SECRET;
  try {
    process.env.WEB_PUSH_SETUP_RATE_SECRET = secret;
    for (const owner of ['a','b']) await db.run("INSERT INTO web_push_setup_rate_buckets(dimension,key_hash,window_start_ms,used_count) VALUES('USER',?,600000,1)", [account.pushSetupUserRateKey(owner)]);
    delete process.env.WEB_PUSH_SETUP_RATE_SECRET;
    await assert.rejects(() => account.erasePushSetupUserRate(db, 'a'), /key is unavailable/);
    assert.equal(Number((await db.get("SELECT count(*) AS n FROM web_push_setup_rate_buckets WHERE dimension='USER'")).n), 2);
    process.env.WEB_PUSH_SETUP_RATE_SECRET = secret;
    await account.erasePushSetupUserRate(db, 'a');
    assert.equal(Number((await db.get("SELECT count(*) AS n FROM web_push_setup_rate_buckets WHERE dimension='USER'")).n), 1);
    assert.ok(await db.get("SELECT 1 AS present FROM web_push_setup_rate_buckets WHERE dimension='USER' AND key_hash=?", [account.pushSetupUserRateKey('b')]));
  } finally { if (previous === undefined) delete process.env.WEB_PUSH_SETUP_RATE_SECRET; else process.env.WEB_PUSH_SETUP_RATE_SECRET = previous; }
  for (const [sql, params] of account.ACCOUNT_DELETE_QUERIES.slice(0,9)) await db.run(sql, account.bindUserId(params,'a'));
  // Existing runs.user_id is not CASCADE: production account erase explicitly
  // deletes its activity history before the final user row.
  await db.exec("DELETE FROM provider_activity_links WHERE user_id='a'; DELETE FROM runs WHERE user_id='a'; DELETE FROM users WHERE id='a';");
  for (const table of ['web_push_setup_operations', 'web_push_challenges', 'provider_event_jobs', 'strava_ingress_bindings', 'run_save_eligibility', 'provider_activity_links','web_push_claims','notification_deliveries','activity_notification_events']) assert.equal(Number((await db.get(`SELECT count(*) AS n FROM ${table}`)).n), 0, table);
  assert.equal((await db.get("SELECT user_id FROM push_subscriptions WHERE id='pb'")).user_id, 'b');
  console.log(`PASS ${dialect} actual-base upgrade/rerun/bootstrap/quarantine/indexes/owner/constraints/cascades`);
}
async function sqliteNegatives() {
  const classified=new Set([...account.ACCOUNT_EXPORT_TABLES.map(item=>item.table),...account.ACCOUNT_SECRET_TABLES,...Object.keys(account.ACCOUNT_AGGREGATE_TABLES)]);
  for(const table of migration._test.OWNED_TABLES)assert.ok(classified.has(table),`${table} account classification`);
  const key='synthetic-only-dedicated-rate-key-32bytes';
  assert.deepEqual(account.pushSetupUserRateKey('a',key),require('node:crypto').createHmac('sha256',Buffer.from(key,'utf8')).update(Buffer.from('forge:web-push-setup-rate:v1:USER\0a','utf8')).digest());
  assert.throws(()=>account.pushSetupUserRateKey('a','short'),/unavailable/);
  for (const value of [null,undefined,false,true,0,-1,NaN,Infinity,[],{},'','01','1e2',' 1 ',1.2,Number.MAX_SAFE_INTEGER+1]) assert.equal(migration._test.providerId(value),null);
  assert.equal(migration._test.providerId('123'),'123'); assert.equal(migration._test.providerId(123),'123');
  const empty = sqliteFixture();
  await empty.migrate(); assert.equal(empty.db.get('SELECT count(*) AS n FROM run_save_eligibility').n, 0);
  empty.db.exec('DROP INDEX bg_jobs_due');
  await assert.rejects(empty.migrate, { code: 'BACKGROUND_SCHEMA_RECORDED_INDEX_MISSING' }); empty.close();
  for (const action of ['DROP TRIGGER bg_binding_insert','ALTER TABLE web_push_setup_operations DROP COLUMN cancelled_at_ms']) {
    const damaged=sqliteFixture(); await damaged.migrate(); damaged.db.exec(action);
    await assert.rejects(damaged.migrate,error=>['BACKGROUND_SCHEMA_RECORDED_TRIGGER_MISSING','BACKGROUND_SCHEMA_RECORDED_SCHEMA_INCOMPLETE'].includes(error.code));damaged.close();
  }
  for (const kind of ['duplicate', 'orphan', 'athlete', 'partial', 'ambiguous', 'unknown-column']) {
    const f = sqliteFixture(); await seed(f.db);
    if (kind === 'duplicate') f.db.exec("INSERT INTO strava_tokens(user_id,athlete_id) VALUES('b',123)");
    if (kind === 'orphan') f.db.exec('PRAGMA foreign_keys=OFF; UPDATE strava_tokens SET user_id=NULL; PRAGMA foreign_keys=ON;');
    if (kind === 'athlete') f.db.exec('UPDATE strava_tokens SET athlete_id=-1');
    if (kind === 'partial') f.db.exec('ALTER TABLE strava_tokens ADD COLUMN token_revision BIGINT');
    if (kind === 'ambiguous') f.db.exec("INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds,health_source,health_source_workout_id) VALUES('other','a','2026-01-01','easy',1,600,'strava','101')");
    if (kind === 'unknown-column') f.db.exec('ALTER TABLE push_subscriptions ADD COLUMN unreviewed TEXT');
    await assert.rejects(f.migrate, error => error.code?.startsWith('BACKGROUND_SCHEMA_'), kind);
    assert.equal(f.db.get('PRAGMA foreign_keys').foreign_keys, 1);
    assert.equal(f.db.get("SELECT count(*) AS n FROM sqlite_master WHERE name='background_sync_control'").n, 0);
    assert.equal(f.db.get('SELECT count(*) AS n FROM push_subscriptions').n, 2);
    f.close();
  }
  const f = sqliteFixture(); await seed(f.db);
  f.db.exec("UPDATE runs SET workout_metrics_json='malformed'");
  await f.migrate(); assert.equal(f.db.get('SELECT count(*) AS n FROM run_save_eligibility').n, 1);
  assert.equal(f.db.get('SELECT count(*) AS n FROM provider_activity_links').n, 1);
  f.close();
  const bounded=sqliteFixture(); await seed(bounded.db);
  const insert=bounded.native.prepare("INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds,health_source,workout_metrics_json) VALUES(?,'a','2026-01-01','easy',1,600,'apple_health',?)");
  for(let i=0;i<1001;i++)insert.run(`history-${String(i).padStart(4,'0')}`,JSON.stringify({strava_activity_id:String(1000+i)}));
  insert.run('oversized',JSON.stringify({strava_activity_id:'99999',extra:'x'.repeat(32768)}));
  insert.run('array','[{"strava_activity_id":"99998"}]');
  insert.run('invalid-id','{"strava_activity_id":false}');
  await bounded.migrate();
  assert.equal(bounded.db.get('SELECT count(*) AS n FROM provider_activity_links').n,1002);
  assert.equal(bounded.db.get('SELECT count(*) AS n FROM run_save_eligibility').n,1005);
  assert.equal(bounded.db.get('SELECT count(*) AS n FROM activity_notification_events').n,0);
  assert.equal(bounded.db.get('SELECT count(*) AS n FROM notification_deliveries').n,0);
  bounded.close();
  console.log('PASS SQLite invalid-owner/duplicate/partial/ambiguous rollback; malformed provenance remains LEGACY');
}
async function sqliteRestorationFailures() {
  const directory=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'forge-b1a-begin-'));
  const file=path.join(directory,'locked.sqlite');
  let locker, contender;
  try {
    locker=new DatabaseSync(file); contender=new DatabaseSync(file);
    locker.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;');
    contender.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;');
    locker.exec(baseSql(true)); locker.exec('BEGIN EXCLUSIVE');
    await assert.rejects(()=>migration.migrateBackgroundSyncSqlite(contender),error=>error.code==='ERR_SQLITE_ERROR' && /locked/.test(error.message));
    assert.equal(contender.isTransaction,false,'failed BEGIN must not create caller transaction');
    assert.equal(contender.prepare('PRAGMA foreign_keys').get().foreign_keys,1,'failed BEGIN must restore caller FK enforcement');
    locker.exec('ROLLBACK');
    assert.equal((await migration.migrateBackgroundSyncSqlite(contender)).applied,true,'same connection remains usable after rejection');
    assert.equal(contender.prepare('PRAGMA foreign_keys').get().foreign_keys,1);
  } finally {
    if(locker?.isTransaction)locker.exec('ROLLBACK');
    contender?.close(); locker?.close();
    for(const suffix of ['','-wal','-shm','-journal']){const target=file+suffix;if(fs.existsSync(target))fs.unlinkSync(target);}
    fs.rmdirSync(directory);
  }
  console.log('PASS real file-backed two-connection BEGIN failure preserves original lock error and restores FK=1');
  for(const mode of ['off-throws','rollback-throws','restore-throws','restore-noop']) {
    const fixture=sqliteFixture();
    const originalError=new Error('synthetic migration fault');
    const rollbackError=new Error('synthetic rollback fault');
    let rollbackCalls=0;
    const wrapped={get isTransaction(){return fixture.native.isTransaction;},prepare:sql=>fixture.native.prepare(sql),exec:sql=>{
      if(mode==='off-throws' && sql==='PRAGMA foreign_keys=OFF;'){fixture.native.exec(sql);throw originalError;}
      if(sql==='CREATE TABLE IF NOT EXISTS schema_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT UNIQUE NOT NULL, executed_at TEXT DEFAULT CURRENT_TIMESTAMP)')throw originalError;
      if(sql==='ROLLBACK'){rollbackCalls++;if(mode==='rollback-throws')throw rollbackError;}
      if(sql==='PRAGMA foreign_keys=ON'){
        if(mode==='restore-throws')throw new Error('synthetic restoration failure');
        if(mode==='restore-noop')return;
      }
      return fixture.native.exec(sql);
    }};
    try {
      await assert.rejects(()=>migration.migrateBackgroundSyncSqlite(wrapped),error=>{
        if(mode==='off-throws')return error===originalError;
        assert.equal(error.code,'BACKGROUND_SCHEMA_SQLITE_FOREIGN_KEYS_RESTORE');
        assert.ok(error.cause instanceof AggregateError,'restoration failure keeps diagnostic cause');
        if(mode==='rollback-throws')assert.deepEqual(error.cause.errors[0].errors,[originalError,rollbackError]);
        else assert.equal(error.cause.errors[0],originalError);
        return true;
      });
      assert.equal(rollbackCalls,mode==='off-throws'?0:1);
      assert.equal(fixture.db.get('PRAGMA foreign_keys').foreign_keys,mode==='off-throws'?1:0);
    } finally {
      if(fixture.native.isTransaction)fixture.native.exec('ROLLBACK');
      fixture.native.exec('PRAGMA foreign_keys=ON');fixture.close();
    }
  }
  console.log('PASS fault-injected OFF/rollback/restore failure paths reject explicitly; no silent FK restoration success');
}
async function postgres() {
  const { Pool } = require('pg');
  const root = new URL('postgresql://forge_background_test@127.0.0.1:55449/forge_background_test');
  const admin = new Pool({ connectionString: root.href });
  const name = `forge_b1a_${randomBytes(8).toString('hex')}`;
  assert.match(name, /^forge_b1a_[a-f0-9]{16}$/);
  let pool, created = false;
  try {
    assert.deepEqual((await admin.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0], { db:'forge_background_test',role:'forge_background_test',port:55449 });
    await admin.query(`CREATE DATABASE "${name}"`); created = true;
    root.pathname = '/' + name; pool = new Pool({ connectionString:root.href });
    const query = (sql, params = []) => { let i=0; return pool.query(sql.replace(/\?/g, () => `$${++i}`), params); };
    const db = { exec:sql => pool.query(sql), run:query, all:async(sql,p) => (await query(sql,p)).rows, get:async(sql,p) => (await query(sql,p)).rows[0] };
    await db.exec(baseSql(false));
    await migration.migrateBackgroundSyncPostgres(pool);
    assert.equal(Number((await db.get('SELECT count(*) AS n FROM run_save_eligibility')).n),0);
    await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await db.exec(baseSql(false));
    await sharedChecks({ db, migrate:() => migration.migrateBackgroundSyncPostgres(pool) }, 'postgres');
    for (const kind of ['duplicate','owner','athlete','partial','ambiguous']) {
      await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); // Only this freshly created guarded child.
      await db.exec(baseSql(false)); await seed(db);
      if (kind === 'duplicate') await db.exec("INSERT INTO strava_tokens(user_id,athlete_id) VALUES('b',123)");
      if (kind === 'owner') await db.exec('UPDATE strava_tokens SET user_id=NULL');
      if (kind === 'athlete') await db.exec('UPDATE strava_tokens SET athlete_id=-1');
      if (kind === 'partial') await db.exec('ALTER TABLE strava_tokens ADD COLUMN token_revision BIGINT');
      if (kind === 'ambiguous') await db.exec("INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds,health_source,health_source_workout_id) VALUES('other','a','2026-01-01','easy',1,600,'strava','101')");
      await assert.rejects(() => migration.migrateBackgroundSyncPostgres(pool), error => error.code?.startsWith('BACKGROUND_SCHEMA_'), kind);
      assert.equal((await db.get("SELECT to_regclass('background_sync_control') AS present")).present, null);
      assert.equal(Number((await db.get('SELECT count(*) AS n FROM push_subscriptions')).n),2);
    }
    await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const child = require('node:child_process').spawnSync(process.execPath, [__filename, '--startup-child'], {
      cwd: path.join(__dirname,'../..'), encoding:'utf8', timeout:120000,
      env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH, NODE_ENV:'test', DATABASE_URL:root.href, JWT_SECRET:'synthetic-startup-only' },
    });
    process.stdout.write(child.stdout || ''); process.stderr.write(child.stderr || '');
    assert.equal(child.status,0,child.error?.message || 'real startup child');
  } finally {
    if (pool) await pool.end();
    if (created) { await admin.query(`DROP DATABASE "${name}"`); console.log(`Removed owned child ${name}`); }
    await admin.end();
  }
}
(async () => {
  if (process.argv.includes('--startup-child')) {
    const url = new URL(process.env.DATABASE_URL);
    assert.equal(url.hostname,'127.0.0.1'); assert.equal(url.port,'55449'); assert.equal(url.username,'forge_background_test');
    assert.match(url.pathname,/^\/forge_b1a_[a-f0-9]{16}$/);
    const actual = require('../src/db'); const pg = require('../src/db/postgres');
    try {
      assert.equal((await actual.dbGet('SELECT current_database() AS name')).name,url.pathname.slice(1));
      await actual.initDb();
      await seed({exec: sql => pg.query(sql)});
      await actual.dbRun('UPDATE users SET password_hash=?', [require('bcryptjs').hashSync('synthetic-password',4)]);
      await require('../src/db/migrate').runAlwaysMigrations();
      await require('../src/db/migrate').runAlwaysMigrations();
      assert.equal((await actual.dbGet('SELECT version FROM schema_migrations WHERE version=?',[migration.MIGRATION_VERSION])).version,migration.MIGRATION_VERSION);
      // These unchanged legacy provider schemas are lazy, not initDb-owned.
      // Provision their exact existing DDL without requesting a provider/account.
      for (const provider of ['whoop','oura']) {
        const source = fs.readFileSync(path.join(__dirname,`../src/routes/${provider}.js`),'utf8');
        const matches = [...source.matchAll(/await dbRun\(`\s*(CREATE TABLE IF NOT EXISTS [\s\S]*?)`\);/g)];
        assert.equal(matches.length,2);
        for (const match of matches) await pg.query(match[1]);
      }
      const express = require('express');
      const app = express(); app.use(express.json()); app.use('/api/auth',require('../src/routes/auth'));
      const server = await new Promise(resolve => { const instance=app.listen(0,'127.0.0.1',()=>resolve(instance)); });
      try {
        const token = require('jsonwebtoken').sign({id:'a'},process.env.JWT_SECRET);
        const base = `http://127.0.0.1:${server.address().port}/api/auth`;
        const headers = {authorization:`Bearer ${token}`,'content-type':'application/json'};
        const response = await fetch(base+'/me/export',{headers}); assert.equal(response.status,200);
        const exported = await response.json();
        assert.equal(exported.strava_connection[0].user_id,'a');
        assert.equal(exported.run_save_eligibility[0].reason,'LEGACY');
        assert.equal(exported.push_subscriptions[0].active,false);
        for (const key of ['access_token','refresh_token','endpoint','keys_auth','keys_p256dh']) assert.equal(Object.hasOwn(exported.push_subscriptions[0],key),false);
        assert.equal(Object.hasOwn(exported.strava_connection[0],'access_token'),false);
        assert.equal((await fetch(base+'/account',{method:'DELETE',headers,body:JSON.stringify({password:'wrong',confirm:'DELETE'})})).status,401);
        assert.ok(await actual.dbGet("SELECT id FROM users WHERE id='a'"));
        const rateSecret='synthetic-user-rate-key-at-least-32bytes';
        for(const owner of ['a','b'])await actual.dbRun("INSERT INTO web_push_setup_rate_buckets(dimension,key_hash,window_start_ms,used_count) VALUES('USER',?,600000,1)",[account.pushSetupUserRateKey(owner,rateSecret)]);
        assert.equal((await fetch(base+'/account',{method:'DELETE',headers,body:JSON.stringify({password:'synthetic-password',confirm:'DELETE'})})).status,500);
        assert.ok(await actual.dbGet("SELECT id FROM users WHERE id='a'"));
        assert.ok(await actual.dbGet("SELECT run_id FROM provider_activity_links WHERE user_id='a'"));
        process.env.WEB_PUSH_SETUP_RATE_SECRET=rateSecret;
        assert.equal((await fetch(base+'/account',{method:'DELETE',headers,body:JSON.stringify({password:'synthetic-password',confirm:'DELETE'})})).status,200);
        delete process.env.WEB_PUSH_SETUP_RATE_SECRET;
        assert.equal((await actual.dbGet("SELECT count(*) AS n FROM web_push_setup_rate_buckets WHERE dimension='USER'")).n,1);
        assert.equal(await actual.dbGet("SELECT id FROM users WHERE id='a'"),null);
        assert.ok(await actual.dbGet("SELECT id FROM users WHERE id='b'"));
        assert.equal((await fetch(base+'/me/export',{headers})).status,401);
        console.log('PASS authenticated actual-PG account export redaction/owner isolation/erase/token invalidation');
      } finally { await new Promise(resolve=>server.close(resolve)); }
      await pg.query('DROP INDEX bg_jobs_due');
      await assert.rejects(() => require('../src/db/migrate').runAlwaysMigrations(), {code:'BACKGROUND_SCHEMA_RECORDED_INDEX_MISSING'});
      console.log('PASS actual initDb → runAlways startup/rerun and fail-closed recorded-schema rejection');
    } finally { await actual.pool.end(); await pg.close(); }
    return;
  }
  const fixture = sqliteFixture();
  try { await sharedChecks(fixture, 'sqlite'); } finally { fixture.close(); }
  await sqliteNegatives();
  await sqliteRestorationFailures();
  if (process.argv.includes('--postgres')) await postgres();
  console.log('BACKGROUND SYNC SCHEMA GATE OK — schema only, no closed-app acceptance');
})().catch(error => { console.error(error); process.exitCode=1; });
