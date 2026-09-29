'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const schema=require('../src/db/backgroundSyncSchema');
const lifecycle=require('../src/services/stravaConnectionLifecycle');
const coverage=require('../src/lib/accountDataCoverage');
const base=fs.readFileSync(path.join(__dirname,'../src/db/schema.pg.sql'),'utf8');
const secret='synthetic-fence-only'; const now=1800000000;
function baseSql(sqlite) {
  let result=['users','runs','strava_tokens','push_subscriptions','user_notifications'].map(table=>{
    const match=base.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`));assert.ok(match,table);return match[0];
  }).join('\n');
  return sqlite?result.replace(/id SERIAL PRIMARY KEY/g,'id INTEGER PRIMARY KEY AUTOINCREMENT').replace(/TIMESTAMPTZ/g,'TEXT').replace(/NOW\(\)/g,'CURRENT_TIMESTAMP'):result;
}
function sqliteFixture() {
  const native=new DatabaseSync(':memory:');native.exec('PRAGMA foreign_keys=ON');native.exec(baseSql(true));
  const tx={exec:s=>native.exec(s),get:(s,p=[])=>native.prepare(s).get(...p),all:(s,p=[])=>native.prepare(s).all(...p),run:(s,p=[])=>native.prepare(s).run(...p)};
  return {tx,native,migrate:()=>schema.migrateBackgroundSyncSqlite(native),mutate:async(fn)=>{
    native.exec('BEGIN IMMEDIATE');try{const value=await fn(tx);native.exec('COMMIT');return value;}
    catch(error){native.exec('ROLLBACK');throw error;}
  },close:()=>native.close()};
}
async function users(tx) {
  await tx.run("INSERT INTO users(id,name,email,password_hash) VALUES('a','Synthetic','a@example.invalid','synthetic'),('b','Synthetic','b@example.invalid','synthetic')");
}
async function credentials(tx,owner,generation,athlete=123) {
  await tx.run(`INSERT INTO strava_tokens(user_id,athlete_id,access_token,refresh_token,connection_generation,token_revision)
    VALUES(?,?,?, ?,?,1) ON CONFLICT(user_id) DO UPDATE SET connection_generation=excluded.connection_generation,token_revision=1,
    athlete_id=excluded.athlete_id,access_token=excluded.access_token,refresh_token=excluded.refresh_token`,[owner,athlete,'synthetic-access','synthetic-refresh',generation]);
  await tx.run('INSERT INTO strava_ingress_bindings(id,user_id,athlete_id) VALUES(?,?,?)',[generation,owner,String(athlete)]);
}
const verify=state=>lifecycle.verifyState(state,secret,now);
const begin=f=>f.mutate(tx=>lifecycle.start(tx,'a',{secret,now}));
async function snapshot(tx) {
  const result={};for(const table of ['strava_connection_fences','strava_tokens','strava_ingress_bindings','provider_event_jobs','background_sync_control','run_save_eligibility'])result[table]=await tx.all(`SELECT * FROM ${table} ORDER BY 1`);
  return JSON.parse(JSON.stringify(result));
}
async function shared(f,label) {
  const {tx}=f;await users(tx);
  await tx.run("INSERT INTO strava_tokens(user_id,athlete_id,access_token) VALUES('a',123,'synthetic')");
  await f.migrate();const original=await snapshot(tx);assert.match(original.strava_connection_fences[0].epoch,/^[a-f0-9]{64}$/);
  await f.migrate();assert.deepEqual(await snapshot(tx),original,'migration rerun does not rotate or rebootstrap');
  assert.ok(coverage.ACCOUNT_SECRET_TABLES.includes('strava_connection_fences'));
  assert.ok(!coverage.ACCOUNT_EXPORT_TABLES.some(x=>x.table==='strava_connection_fences'));
  assert.ok(coverage.ACCOUNT_DELETE_QUERIES.some(([s])=>s==='DELETE FROM strava_connection_fences WHERE user_id = ?'));
  await f.mutate(tx=>lifecycle.disconnect(tx,'a'));const disconnected=await snapshot(tx);
  await f.migrate();assert.deepEqual(await snapshot(tx),disconnected,'disconnected fence retained on rerun');

  // The provider boundary is deliberately outside these transactions. No
  // provider response/boolean is used as a substitute for current DB identity.
  const pending=verify(await begin(f));await f.mutate(tx=>lifecycle.assertAttempt(tx,pending,now));
  await f.mutate(tx=>lifecycle.disconnect(tx,'a'));
  await assert.rejects(()=>f.mutate(tx=>lifecycle.consume(tx,pending,now)),{code:'STRAVA_CONNECTION_ATTEMPT_STALE'});
  assert.equal((await tx.all('SELECT * FROM strava_tokens')).length,0);
  const a=verify(await begin(f)), b=verify(await begin(f));
  await assert.rejects(()=>f.mutate(tx=>lifecycle.consume(tx,a,now)));
  await f.mutate(async tx=>{await lifecycle.consume(tx,b,now);await credentials(tx,'a','g1');});
  await f.mutate(tx=>lifecycle.disconnect(tx,'a'));
  await assert.rejects(()=>f.mutate(tx=>lifecycle.consume(tx,a,now)),'absent-connected-absent must not revive first state');
  await assert.rejects(()=>f.mutate(tx=>lifecycle.consume(tx,b,now)),'consumed state remains consumed');

  const connected=verify(await begin(f));await f.mutate(async tx=>{await lifecycle.consume(tx,connected,now);await credentials(tx,'a','g2');});
  const proofBefore=await f.mutate(tx=>lifecycle.captureConnection(tx,'a'));
  const reconnect=verify(await begin(f));const beforeReject=await snapshot(tx);
  await assert.rejects(()=>f.mutate(tx=>lifecycle.revokeVerified(tx,proofBefore)),{code:'STRAVA_CONNECTION_STALE'});
  assert.deepEqual(await snapshot(tx),beforeReject,'proof before newer start is wholly stale');
  const proofAfter=await f.mutate(tx=>lifecycle.captureConnection(tx,'a'));
  await f.mutate(tx=>lifecycle.revokeVerified(tx,proofAfter));
  assert.equal((await tx.get("SELECT epoch FROM strava_connection_fences WHERE user_id='a'")).epoch,reconnect.epoch);
  await f.mutate(async tx=>{await lifecycle.consume(tx,reconnect,now);await credentials(tx,'a','g3');});
  await assert.rejects(()=>f.mutate(tx=>lifecycle.revokeVerified(tx,proofAfter)),'cannot replay deletion against successor');

  const next=verify(await begin(f));const oldRevision=await f.mutate(tx=>lifecycle.captureConnection(tx,'a'));
  await f.mutate(tx=>tx.run("UPDATE strava_tokens SET token_revision=2 WHERE user_id='a' AND connection_generation='g3'"));
  await assert.rejects(()=>f.mutate(tx=>lifecycle.revokeVerified(tx,oldRevision)));
  const currentRevision=await f.mutate(tx=>lifecycle.captureConnection(tx,'a'));
  const beforeRollback=await snapshot(tx);
  await assert.rejects(()=>f.mutate(async tx=>{await lifecycle.revokeVerified(tx,currentRevision);throw Error('synthetic rollback');}));
  assert.deepEqual(await snapshot(tx),beforeRollback);
  await f.mutate(tx=>lifecycle.revokeVerified(tx,currentRevision));
  await f.mutate(tx=>lifecycle.disconnect(tx,'a'));
  await assert.rejects(()=>f.mutate(tx=>lifecycle.consume(tx,next,now)),'local disconnect cancels pending attempt after remote delete');

  const one=verify(await begin(f)); const beforeInvalid=await snapshot(tx);
  // A successful provider exchange will be installed by later route wiring;
  // this proves its necessary SQL transaction composition, not provider truth.
  await f.mutate(async tx=>{await lifecycle.start(tx,'b',{secret,now});await credentials(tx,'b','foreign-generation',456);});
  const beforeConflict=await snapshot(tx);
  await assert.rejects(()=>f.mutate(async tx=>{await lifecycle.consume(tx,one,now);await credentials(tx,'a','conflicting',456);}));
  assert.deepEqual(await snapshot(tx),beforeConflict,'unique athlete conflict rolls back consumed epoch and all credentials');
  await f.mutate(async tx=>{await tx.run("DELETE FROM strava_tokens WHERE user_id='b'");await tx.run("DELETE FROM strava_connection_fences WHERE user_id='b'");});
  assert.deepEqual(await snapshot(tx),beforeInvalid);
  for(const bad of [{...one},Object.freeze({...one}),null,true])await assert.rejects(()=>f.mutate(tx=>lifecycle.consume(tx,bad,now)));
  for(const bad of [{...currentRevision},null,true])await assert.rejects(()=>f.mutate(tx=>lifecycle.revokeVerified(tx,bad)));
  await assert.rejects(()=>f.mutate(tx=>lifecycle.consume(tx,one,now+600)));
  await assert.rejects(()=>f.mutate(tx=>lifecycle.start(tx,'a',{secret:'',now})));
  await assert.rejects(()=>f.mutate(tx=>lifecycle.start(tx,'a',{secret,now,returnLink:'https://example.invalid/ '.repeat(50)})));
  assert.deepEqual(await snapshot(tx),beforeInvalid,'invalid inputs and expiry do not mutate');
  const savedRandom=crypto.randomBytes;
  try {crypto.randomBytes=()=>Buffer.from(one.epoch,'hex');await assert.rejects(()=>begin(f),{code:'STRAVA_EPOCH_UNAVAILABLE'});}
  finally {crypto.randomBytes=savedRandom;}
  assert.deepEqual(await snapshot(tx),beforeInvalid);
  await f.mutate(tx=>tx.run("DELETE FROM users WHERE id='a'"));
  await assert.rejects(()=>f.mutate(tx=>lifecycle.consume(tx,one,now)),{code:'AUTH_ACCOUNT_DELETED'});
  assert.equal((await tx.all('SELECT * FROM strava_connection_fences')).length,0);
  assert.ok(await tx.get("SELECT id FROM users WHERE id='b'"));
  console.log(`PASS ${label} lifecycle helpers: ABA/start/cancel/consumed/epoch-preserving deauth/revision/rollback/erase; not routed provider proof`);
}
function stateTests() {
  const body={v:2,user_id:'a',deeplink:null,exp:now+600,epoch:'a'.repeat(64)};
  const signed=value=>{const b=Buffer.from(JSON.stringify(value)).toString('base64url');return b+'.'+crypto.createHmac('sha256',secret).update('forge:strava:oauth-state:v2\0').update(b).digest('base64url');};
  const valid=signed(body);assert.equal(verify(valid).user_id,'a');
  for(const raw of ['',null,[],{},valid+'.x',valid+'=',valid.replace(/.$/,'!'),'a'.repeat(4097),signed({...body,extra:true}),signed({...body,v:1}),signed({...body,exp:now}),signed({...body,epoch:'A'.repeat(64)}),signed({...body,exp:now+601}),signed({...body,user_id:1}),signed({...body,deeplink:[]} )])assert.throws(()=>verify(raw));
  const encoded=valid.split('.')[0];const legacy=encoded+'.'+crypto.createHmac('sha256',secret).update(encoded).digest('base64url');assert.throws(()=>verify(legacy));
  console.log('PASS closed canonical state encoding/domain/signature/size/expiry; no legacy fallback');
}
async function sqliteSchemaNegatives() {
  for(const kind of ['unrecorded','missing','wrongcheck','coverage','invalidrow']) {
    const f=sqliteFixture();try {
      await users(f.tx);await f.migrate();
      if(kind==='unrecorded')f.native.prepare('DELETE FROM schema_migrations WHERE version=?').run(schema.FENCE_MIGRATION_VERSION);
      if(kind==='missing')f.native.exec('DROP TABLE strava_connection_fences');
      if(kind==='wrongcheck')f.native.exec("DROP TABLE strava_connection_fences;CREATE TABLE strava_connection_fences(user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,epoch TEXT NOT NULL CHECK(length(epoch)>0))");
      if(kind==='coverage')await credentials(f.tx,'a','missing-fence');
      if(kind==='invalidrow') { f.native.exec('PRAGMA ignore_check_constraints=ON');f.native.exec("INSERT INTO strava_connection_fences VALUES('a','bad')");f.native.exec('PRAGMA ignore_check_constraints=OFF'); }
      await assert.rejects(f.migrate,e=>e.code?.startsWith('BACKGROUND_SCHEMA_FENCE'),kind);
      assert.equal(f.native.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.equal(f.native.isTransaction,false);
    } finally{f.close();}
  }
  // Batch boundary is exercised with authentic base schema, not a fabricated
  // new table. No token generation/activation/legacy recipe is replaced.
  const many=sqliteFixture();try {
    many.native.exec('BEGIN');
    for(let i=0;i<1001;i++) {
      const id=`owner-${String(i).padStart(4,'0')}`;
      many.tx.run('INSERT INTO users(id,name,email,password_hash) VALUES(?,?,?,?)',[id,'Synthetic',id+'@example.invalid','synthetic']);
      many.tx.run('INSERT INTO strava_tokens(user_id,athlete_id) VALUES(?,?)',[id,1000+i]);
    }
    many.native.exec('COMMIT');await many.migrate();
    assert.equal(many.tx.get('SELECT count(*) AS n FROM strava_connection_fences').n,1001);
    const epochs=many.tx.all('SELECT * FROM strava_connection_fences ORDER BY user_id');await many.migrate();
    assert.deepEqual(many.tx.all('SELECT * FROM strava_connection_fences ORDER BY user_id'),epochs);
  } finally {many.close();}
  console.log('PASS SQLite independent additive schema marker/shape/coverage/row negatives; FK remains ON');
}
async function postgres() {
  const {Pool}=require('pg');const root=new URL('postgresql://forge_background_test@127.0.0.1:55449/forge_background_test');
  const admin=new Pool({connectionString:root.href});const name='forge_b1c_'+crypto.randomBytes(8).toString('hex');let pool,created=false;
  assert.match(name,/^forge_b1c_[a-f0-9]{16}$/);
  const adapter=client=>{const q=(s,p=[])=>{let i=0;return client.query(s.replace(/\?/g,()=>`$${++i}`),p);};return {exec:s=>client.query(s),get:async(s,p)=>(await q(s,p)).rows[0],all:async(s,p)=>(await q(s,p)).rows,run:async(s,p)=>({changes:(await q(s,p)).rowCount})};};
  try {
    assert.deepEqual((await admin.query('SELECT current_database() AS db,current_user AS role,inet_server_port() AS port')).rows[0],{db:'forge_background_test',role:'forge_background_test',port:55449});
    await admin.query(`CREATE DATABASE "${name}"`);created=true;root.pathname='/'+name;pool=new Pool({connectionString:root.href});
    const tx=adapter(pool);await tx.exec(baseSql(false));
    const mutate=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT id FROM users WHERE id='a' FOR UPDATE");const value=await fn(adapter(c));await c.query('COMMIT');return value;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}};
    await shared({tx,mutate,migrate:()=>schema.migrateBackgroundSyncPostgres(pool)},'PostgreSQL');
    // Two independent clients prove the final owner-lock/CAS fence: both have
    // an earlier valid signed state, but only one may consume it.
    await tx.run("INSERT INTO users(id,name,email,password_hash) VALUES('a','Synthetic','a@example.invalid','synthetic')");
    const state=verify(await mutate(t=>lifecycle.start(t,'a',{secret,now})));
    const first=await pool.connect(),second=await pool.connect();
    try {
      await first.query('BEGIN');await first.query("SELECT id FROM users WHERE id='a' FOR UPDATE");
      await second.query('BEGIN');await second.query("SET LOCAL lock_timeout='2s'");
      const lock=second.query("SELECT id FROM users WHERE id='a' FOR UPDATE");
      await lifecycle.consume(adapter(first),state,now);await credentials(adapter(first),'a','winner');await first.query('COMMIT');await lock;
      await assert.rejects(()=>lifecycle.consume(adapter(second),state,now),{code:'STRAVA_CONNECTION_ATTEMPT_STALE'});await second.query('ROLLBACK');
      assert.equal((await tx.get("SELECT connection_generation FROM strava_tokens WHERE user_id='a'")).connection_generation,'winner');
    } finally {await first.query('ROLLBACK');await second.query('ROLLBACK');first.release();second.release();}
    for(const order of ['deauth-first','callback-first']) {
      const pending=verify(await mutate(t=>lifecycle.start(t,'a',{secret,now})));
      const proof=await mutate(t=>lifecycle.captureConnection(t,'a'));
      const x=await pool.connect(),y=await pool.connect();
      try {
        await x.query('BEGIN');await x.query("SELECT id FROM users WHERE id='a' FOR UPDATE");
        await y.query('BEGIN');await y.query("SET LOCAL lock_timeout='2s'");
        const waiting=y.query("SELECT id FROM users WHERE id='a' FOR UPDATE");
        if(order==='deauth-first') {
          await lifecycle.revokeVerified(adapter(x),proof);await x.query('COMMIT');await waiting;
          assert.equal((await adapter(y).get("SELECT epoch FROM strava_connection_fences WHERE user_id='a'")).epoch,pending.epoch);
          await lifecycle.consume(adapter(y),pending,now);await credentials(adapter(y),'a',order);await y.query('COMMIT');
        } else {
          await lifecycle.consume(adapter(x),pending,now);await credentials(adapter(x),'a',order);await x.query('COMMIT');await waiting;
          await assert.rejects(()=>lifecycle.revokeVerified(adapter(y),proof),{code:'STRAVA_CONNECTION_STALE'});await y.query('ROLLBACK');
        }
        assert.equal((await tx.get("SELECT connection_generation FROM strava_tokens WHERE user_id='a'")).connection_generation,order);
      } finally {await x.query('ROLLBACK');await y.query('ROLLBACK');x.release();y.release();}
    }
    await tx.exec('ALTER TABLE strava_connection_fences DROP CONSTRAINT strava_connection_fences_epoch_check');
    await assert.rejects(()=>schema.migrateBackgroundSyncPostgres(pool),{code:'BACKGROUND_SCHEMA_FENCE_SCHEMA'});
    console.log('PASS real PG competing owner transactions consume one epoch only; both deauth/callback lock orders preserve successor; removed CHECK fails recorded validation');
  } finally {if(pool)await pool.end();if(created){await admin.query(`DROP DATABASE "${name}"`);console.log('Removed owned child '+name);}await admin.end();}
}
(async()=>{stateTests();const f=sqliteFixture();try{await shared(f,'SQLite');}finally{f.close();}await sqliteSchemaNegatives();if(process.argv.includes('--postgres'))await postgres();console.log('STRAVA FENCE PREREQUISITE OK; unwired helper/migration only, no B1c integration claim');})().catch(e=>{console.error(e.stack);process.exitCode=1;});
