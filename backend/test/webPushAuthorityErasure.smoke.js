'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const account=require('../src/lib/accountDataCoverage');
const {sqlite,postgres,seedTargets,activeClaim,uuid,plain}=require('./webPushAuthoritySchema.smoke');
const {createWorkerDatabase}=require('../src/db/backgroundSyncWorker');
const secret='synthetic-d2a-user-rate-key-at-least-32bytes';
async function seed(f) {
  await seedTargets(f);await f.migrate();await activeClaim(f);
  await f.db.run("INSERT INTO web_push_challenges(id,user_id,subscription_id,endpoint_hash,expected_incarnation,proof_hash,expected_revision,operation_id,expires_at) VALUES('foreign','b','pb',?,?,?,1,'foreign','2099-01-01')",['a'.repeat(64),uuid(1),'c'.repeat(64)]);
  for(const owner of ['a','b'])await f.db.run("INSERT INTO web_push_setup_rate_buckets(dimension,key_hash,window_start_ms,used_count) VALUES('USER',?,600000,1)",[account.pushSetupUserRateKey(owner,secret)]);
}
async function snapshot(f){return plain({users:await f.db.all('SELECT * FROM users ORDER BY id'),targets:await f.db.all('SELECT * FROM push_subscriptions ORDER BY id'),claims:await f.db.all('SELECT * FROM web_push_claims ORDER BY endpoint_hash'),challenges:await f.db.all('SELECT * FROM web_push_challenges ORDER BY id'),rates:await f.db.all('SELECT * FROM web_push_setup_rate_buckets ORDER BY dimension,key_hash')});}
async function direct(f) {
  await seed(f);const bounded=createWorkerDatabase(f.dialect==='sqlite'?{sqlite:f.native}:{pool:f.pool});
  const before=await snapshot(f),writes=[];
  const erase=()=>bounded.withOwnerMutation('a',async tx=>{
    const recorded={...tx,run:async(s,p)=>{writes.push(s);return tx.run(s,p);}};
    await account.ACCOUNT_CALLABLE_CLEANUP[0].execute(recorded,'a');
    await recorded.run("DELETE FROM web_push_challenges WHERE user_id=?",['a']);
    await recorded.run("DELETE FROM push_subscriptions WHERE user_id=?",['a']);
    await recorded.run('DELETE FROM users WHERE id=?',['a']);
    await account.erasePushSetupUserRate(recorded,'a');
  });
  const old=process.env.WEB_PUSH_SETUP_RATE_SECRET;delete process.env.WEB_PUSH_SETUP_RATE_SECRET;
  try {
    await assert.rejects(erase,/rate key is unavailable/);assert.deepEqual(await snapshot(f),before,'missing key rolls back owner deletion and prior neutralization');
    process.env.WEB_PUSH_SETUP_RATE_SECRET=secret;writes.length=0;await erase();
    assert.equal(writes.at(-1),"DELETE FROM web_push_setup_rate_buckets WHERE dimension='USER' AND key_hash=?");
    assert.equal(await f.db.get("SELECT id FROM users WHERE id='a'"),undefined);
    assert.ok(await f.db.get("SELECT id FROM users WHERE id='b'"));
    assert.deepEqual(plain(await f.db.get("SELECT * FROM web_push_challenges WHERE id='foreign'")),before.challenges[0]);
    const claim=await f.db.get('SELECT * FROM web_push_claims');assert.equal(claim.state,'VACANT');assert.notEqual(claim.incarnation,before.claims[0].incarnation);
    for(const key of ['subscription_id','proof_hash','last_operation_id','confirm_hash'])assert.equal(claim[key],null);
    assert.equal(Number((await f.db.get("SELECT count(*) AS n FROM web_push_setup_rate_buckets WHERE dimension='USER'")).n),1);
    assert.ok(await f.db.get("SELECT 1 AS n FROM web_push_setup_rate_buckets WHERE key_hash=?",[account.pushSetupUserRateKey('b',secret)]));
    assert.equal(account.ACCOUNT_EXPORT_TABLES.some(r=>r.table==='web_push_claims'||r.table==='web_push_delivery_control'),false);
    assert.doesNotMatch(account.ACCOUNT_EXPORT_TABLES.find(r=>r.table==='notification_deliveries').columns,/admitted_lease|lease_token/);
  } finally {await bounded.close();if(old===undefined)delete process.env.WEB_PUSH_SETUP_RATE_SECRET;else process.env.WEB_PUSH_SETUP_RATE_SECRET=old;}
  if(f.pool)assert.equal((await f.pool.query('SELECT 1 AS alive')).rows[0].alive,1,'borrowed pool remains usable');
  console.log(`PASS ${f.dialect} callable real neutralization/foreign retention/USER HMAC last/full erase rollback/export secrecy`);
}
// Current repository DDL, not fabricated table/column stubs. SQLite only
// translates its dialect; real PG startup independently proves production DDL.
function addSqliteAccountTables(f) {
  // SQLite has no physical PG storage-size function. These fixtures contain no
  // planning payloads; byte-length is only a dialect shim, not PG size proof.
  f.native.function('pg_column_size',value=>Buffer.byteLength(String(value)));
  f.native.function('char_length',value=>value===null?null:Array.from(String(value)).length);
  f.native.function('jsonb_typeof',value=>{if(value===null)return null;const parsed=JSON.parse(value);return parsed===null?'null':Array.isArray(parsed)?'array':typeof parsed;});
  f.native.function('jsonb_array_length',value=>{if(value===null)return null;const parsed=JSON.parse(value);if(!Array.isArray(parsed))throw new Error('Expected JSON array');return parsed.length;});
  f.native.function('LEAST',{deterministic:true},(a,b)=>a===null?b:b===null?a:a<b?a:b);
  f.native.function('GREATEST',{deterministic:true},(a,b)=>a===null?b:b===null?a:a>b?a:b);
  const root=path.join(__dirname,'../src');
  const files=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())walk(p);else if(p.endsWith('.js')||p.endsWith('.sql'))files.push(p);}}walk(root);
  files.sort((a,b)=>(a.endsWith('/db/index.js')?-1:b.endsWith('/db/index.js')?1:0));
  const statements=new Map();
  for(const file of files) {
    const source=fs.readFileSync(file,'utf8');
    for(const match of source.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(/g)) {
      let depth=1,quote=null,end=match.index+match[0].length;
      for(;end<source.length&&depth;end++) {
        const c=source[end];
        if(quote){if(c===quote){if(source[end+1]===quote)end++;else quote=null;}continue;}
        if(c==="'"||c==='"'){quote=c;continue;}if(c==='(')depth++;if(c===')')depth--;
      }
      const sql=source.slice(match.index,end)+';';
      if(depth===0&&!statements.has(match[1])&&!sql.includes('${'))statements.set(match[1],sql);
    }
  }
  const tables=new Set(['challenges','user_challenges']);
  for(const [sql] of [...account.ACCOUNT_DELETE_QUERIES,...account.ACCOUNT_SOCIAL_DELETE_QUERIES])for(const m of sql.matchAll(/(?:FROM|UPDATE|JOIN)\s+(\w+)/g))tables.add(m[1]);
  const installed=new Set(f.native.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
  for(const table of tables) {
    if(installed.has(table))continue;
    const sql=statements.get(table);assert.ok(sql,'actual repository CREATE authority for '+table);
    for(const ref of sql.matchAll(/REFERENCES\s+(\w+)\s*\(/g))tables.add(ref[1]);
    try {f.native.exec(sql.replace(/\bSERIAL PRIMARY KEY/g,'INTEGER PRIMARY KEY AUTOINCREMENT').replace(/\bTIMESTAMPTZ\b/g,'TEXT')
      .replace(/to_char\(NOW\(\), 'YYYY-MM-DD'\)/g,'CURRENT_DATE')
      .replace(/to_char\(NOW\(\), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'\)/g,"(strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
      .replace(/NOW\(\)/gi,'CURRENT_TIMESTAMP').replace(/::jsonb|::text/g,''));}
    catch(error){error.message=table+': '+error.message;throw error;}
    installed.add(table);
  }
  const startup=fs.readFileSync(path.join(root,'db/index.js'),'utf8');
  for(const match of startup.matchAll(/client\.query\((['"])(ALTER TABLE (challenges|user_challenges) ADD COLUMN IF NOT EXISTS (\w+) [^\n]*?)\1\)/g)) {
    if(f.native.prepare(`PRAGMA table_info(${match[3]})`).all().some(r=>r.name===match[4]))continue;
    f.native.exec(match[2].replace(' IF NOT EXISTS','').replace(/TIMESTAMPTZ/g,'TEXT').replace(/NOW\(\)/g,'CURRENT_TIMESTAMP'));
  }
}
async function route(f,{mode='normal'}={}) {
  await seed(f);
  if(f.dialect==='sqlite')addSqliteAccountTables(f);
  const bcrypt=require('bcryptjs');await f.db.run('UPDATE users SET password_hash=?',[bcrypt.hashSync('synthetic-password',4)]);
  const keys=['../src/db','../src/routes/auth','../src/middleware/auth','../src/db/backgroundSyncWorker'].map(require.resolve);
  const saved=keys.map(k=>require.cache[k]),oldSecret=process.env.JWT_SECRET,oldRate=process.env.WEB_PUSH_SETUP_RATE_SECRET;
  let server,closed=0,created=0,queries=[],releaseHeld,borrowedPool=f.pool,extraPool;
  process.env.JWT_SECRET='synthetic-d2a-auth-only';process.env.WEB_PUSH_SETUP_RATE_SECRET=secret;
  if(f.pool && mode==='acquisition') {
    const {Pool}=require('pg');extraPool=new Pool({...f.pool.options,max:1});borrowedPool=extraPool;const held=await extraPool.connect();releaseHeld=()=>held.release();
  }
  if(f.pool && mode==='owner-lock') {
    const held=await f.pool.connect();await held.query('BEGIN');await held.query("SELECT id FROM users WHERE id='a' FOR UPDATE");
    releaseHeld=async()=>{await held.query('ROLLBACK');held.release();};
  }
  const borrowed=f.pool?{connect:async()=>{
    const c=await borrowedPool.connect();return {on:c.on.bind(c),removeListener:c.removeListener.bind(c),release:(destroy)=>c.release(destroy),query:async(s,p)=>{
      queries.push(s);
      if(s.startsWith('SELECT id, password_hash')) {
        if(mode==='statement')await c.query('SELECT pg_sleep(1.2)');
        if(mode==='idle')await new Promise(r=>setTimeout(r,1200));
        if(mode==='whole') {
          const until=performance.now()+5200;
          while(performance.now()<until){await c.query('SELECT 1');await new Promise(r=>setTimeout(r,200));}
        }
        if(mode==='cancel')await new Promise(r=>setTimeout(r,5200));
      }
      const result=await c.query(s,p);
      if(mode==='uncertain'&&s==='COMMIT')throw new Error('synthetic reply lost after COMMIT');
      return result;
    }};
  }}:Object.freeze({sqliteFixture:true,connect:()=>{throw new Error('SQLite route unexpectedly acquired a PG client');}});
  try {
    require.cache[keys[0]]={id:keys[0],filename:keys[0],loaded:true,exports:{pool:mode==='missing-pool'?undefined:borrowed,dbGet:f.db.get,dbAll:f.db.all,dbRun:f.db.run,runWithUserContext:(_id,next)=>next()}};
    require.cache[keys[3]]={id:keys[3],filename:keys[3],loaded:true,exports:{createWorkerDatabase:({pool})=>{
      assert.equal(pool,borrowed);created++;
      const adapter=f.dialect==='sqlite'?{exec:s=>f.native.exec(s),prepare:s=>{queries.push(s);return f.native.prepare(s.replace(/\s+FOR UPDATE(?: OF [\w, ]+)?\s*$/,'').replace(/clock_timestamp\(\)/g,"strftime('%Y-%m-%dT%H:%M:%fZ','now')"));}}:null;
      const real=createWorkerDatabase(adapter?{sqlite:adapter}:{pool});
      return {...real,close:async()=>{closed++;await real.close();}};
    }}};
    delete require.cache[keys[1]];delete require.cache[keys[2]];
    const express=require('express'),app=express(),router=require('../src/routes/auth');app.use(express.json());app.use('/auth',router);
    server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    const token=require('jsonwebtoken').sign({id:'a'},process.env.JWT_SECRET);
    const request=async(password='synthetic-password',signal)=>fetch(`http://127.0.0.1:${server.address().port}/auth/account`,{method:'DELETE',signal,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({confirm:'DELETE',password})});
    const before=await snapshot(f);
    if(mode==='already-aborted') {
      const {EventEmitter}=require('node:events'),req=new EventEmitter(),res=new EventEmitter();
      Object.assign(req,{aborted:true,user:{id:'a'},body:{confirm:'DELETE',password:'synthetic-password'}});
      Object.assign(res,{statusCode:200,status(code){this.statusCode=code;return this;},json(value){this.body=value;this.writableEnded=true;return this;}});
      await router.stack.find(l=>l.route?.path==='/account'&&l.route.methods.delete).route.stack.at(-1).handle(req,res);
      assert.equal(res.statusCode,503);assert.deepEqual(await snapshot(f),before);assert.equal(queries.length,0);
      assert.equal(req.listenerCount('aborted'),0);assert.equal(res.listenerCount('close'),0);
    } else if(mode==='normal') {
      assert.equal((await request('wrong')).status,401);assert.deepEqual(await snapshot(f),before);
      delete process.env.WEB_PUSH_SETUP_RATE_SECRET;assert.equal((await request()).status,500);assert.deepEqual(await snapshot(f),before);
      process.env.WEB_PUSH_SETUP_RATE_SECRET=secret;queries=[];
      const result=await request();assert.equal(result.status,200);assert.deepEqual(await result.json(),{ok:true});
      const writes=queries.filter(s=>/^(DELETE|UPDATE)/.test(s));assert.match(writes.at(-1),/DELETE FROM web_push_setup_rate_buckets/);
      assert.equal(await f.db.get("SELECT id FROM users WHERE id='a'"),undefined);assert.ok(await f.db.get("SELECT id FROM users WHERE id='b'"));
      assert.equal((await request()).status,401,'old owner JWT is rejected after real erase');
    } else if(mode==='cancel') {
      const abort=new AbortController();const pending=request('synthetic-password',abort.signal);await new Promise(r=>setTimeout(r,80));abort.abort();await assert.rejects(pending);
      await new Promise(r=>setTimeout(r,5300));assert.deepEqual(await snapshot(f),before);assert.equal(queries.includes('COMMIT'),false);
    } else {
      const start=performance.now();const result=await request();assert.equal(result.status,503,mode);assert.deepEqual(await result.json(),{error:'Account deletion is temporarily unavailable.'});
      assert.ok(performance.now()-start<6500,mode+' finite bound');
      if(mode==='whole')assert.ok(performance.now()-start>=4800,'whole deadline, not earlier idle/statement timeout');
      if(mode==='missing-pool')assert.equal(created,0,'missing injected pool never falls back to an environment database');
      if(mode==='uncertain')assert.equal(await f.db.get("SELECT id FROM users WHERE id='a'"),undefined,'known synthetic DB commit occurred; route must NOT claim rollback');
      else assert.deepEqual(await snapshot(f),before);
      if(mode==='whole')await new Promise(r=>setTimeout(r,400));
    }
    assert.equal(closed,created,'all request-owned wrappers close, including password rejection/errors');
    if(f.pool)assert.equal((await f.pool.query('SELECT 1 AS alive')).rows[0].alive,1);
  } finally {
    await releaseHeld?.();if(extraPool)await extraPool.end();if(server)await new Promise(r=>server.close(r));
    keys.forEach((k,i)=>{if(saved[i])require.cache[k]=saved[i];else delete require.cache[k];});
    if(oldSecret===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=oldSecret;
    if(oldRate===undefined)delete process.env.WEB_PUSH_SETUP_RATE_SECRET;else process.env.WEB_PUSH_SETUP_RATE_SECRET=oldRate;
  }
  console.log(`PASS ${f.dialect} actual authenticated erase route ${mode}/bounded borrowed wrapper cleanup`);
}
async function completePgSchema(f) {
  // Same actual initDb/always-migration authorities as production, isolated to
  // this owned child. No HTTP app startup or dormant worker activation.
  // Startup imports seed modules which retain the PG adapter. A fresh process
  // owns that complete module graph; swapping just its root module cache would
  // reopen an old seed module's pool in the next fixture and leak a connection.
  const child=require('node:child_process').spawnSync(process.execPath,[__filename,'--schema-child'],{encoding:'utf8',timeout:30000,
    env:{PATH:process.env.PATH,NODE_ENV:'test',JWT_SECRET:'synthetic-d2a-schema',DATABASE_URL:f.pool.options.connectionString}});
  process.stdout.write(child.stdout||'');process.stderr.write(child.stderr||'');assert.equal(child.status,0,child.error?.message||'actual schema child');
  // Legacy route-owned provider DDL is required by existing full account erase.
  for(const provider of ['whoop','oura'])for(const match of fs.readFileSync(path.join(__dirname,`../src/routes/${provider}.js`),'utf8').matchAll(/await dbRun\(`\s*(CREATE TABLE IF NOT EXISTS [\s\S]*?)`\);/g))await f.db.exec(match[1]);
}
async function ownerOrderRace(firstOwner,secondOwner) {
  const f=await postgres();const logs=new Map();let wrappers=[];
  const previous=process.env.WEB_PUSH_SETUP_RATE_SECRET;process.env.WEB_PUSH_SETUP_RATE_SECRET=secret;
  try {
    await f.migrate();
    for(const [id,target] of [[firstOwner,'pa'],[secondOwner,'pb']]) {
      await f.db.run('INSERT INTO users(id,name,email,password_hash) VALUES(?,?,?,?)',[id,'Synthetic',id+'@example.invalid','synthetic']);
      await f.db.run('INSERT INTO push_subscriptions(id,user_id,endpoint,keys_p256dh,keys_auth) VALUES(?,?,?,?,?)',[target,id,'https://fcm.googleapis.com/'+target,'synthetic','synthetic']);
      await f.db.run("INSERT INTO web_push_setup_rate_buckets(dimension,key_hash,window_start_ms,used_count) VALUES('USER',?,600000,1)",[account.pushSetupUserRateKey(id)]);
    }
    await activeClaim(f);
    await f.db.run("INSERT INTO web_push_challenges(id,user_id,subscription_id,endpoint_hash,expected_incarnation,proof_hash,expected_revision,operation_id,expires_at) VALUES('pending',?,'pb',?,?,?,1,'pending','2099-01-01')",[secondOwner,'a'.repeat(64),uuid(1),'b'.repeat(64)]);
    const erase=async owner=>{
      const log=[];logs.set(owner,log);
      const pool={connect:async()=>{const c=await f.pool.connect();return {on:c.on.bind(c),removeListener:c.removeListener.bind(c),release:destroy=>c.release(destroy),query:(sql,p)=>{log.push({sql,p});return c.query(sql,p);}};}};
      const bounded=createWorkerDatabase({pool});wrappers.push(bounded);
      await bounded.withOwnerMutation(owner,async tx=>{
        await account.neutralizeOwnedWebPushAuthority(tx,owner);
        await tx.run('DELETE FROM web_push_challenges WHERE user_id=?',[owner]);
        await tx.run('DELETE FROM push_subscriptions WHERE user_id=?',[owner]);
        await tx.run('DELETE FROM users WHERE id=?',[owner]);
        await account.erasePushSetupUserRate(tx,owner);
      });
    };
    await Promise.all([erase(firstOwner),erase(secondOwner)]);
    assert.equal(Number((await f.db.get('SELECT count(*) AS n FROM users')).n),0);
    assert.equal((await f.db.get('SELECT state FROM web_push_claims')).state,'VACANT');
    for(const [owner,log] of logs) {
      const ownerIndex=log.findIndex(r=>/SELECT id FROM users.*FOR UPDATE/.test(r.sql)),authorityIndex=log.findIndex(r=>r.sql.includes('FROM web_push_claims c'));
      assert.ok(ownerIndex>=0&&authorityIndex>ownerIndex);assert.deepEqual(log[ownerIndex].p,[owner]);
      const children=log.findIndex(r=>/SELECT id FROM push_subscriptions/.test(r.sql));assert.ok(children>authorityIndex);
      assert.ok(log.filter(r=>r.sql.includes('FROM web_push_challenges')).every(r=>r.p[0]===owner),'never lock/scan another owner challenge');
      assert.match(log.filter(r=>/^(DELETE|UPDATE)/.test(r.sql)).at(-1).sql,/DELETE FROM web_push_setup_rate_buckets/);
    }
    console.log(`PASS real separate PG clients simultaneous owned erasure with foreign reference, ${firstOwner}<->${secondOwner}, owner→authority→children→USER-last`);
  } finally {for(const w of wrappers)await w.close();await f.close();if(previous===undefined)delete process.env.WEB_PUSH_SETUP_RATE_SECRET;else process.env.WEB_PUSH_SETUP_RATE_SECRET=previous;}
}
async function runWebPushAuthorityErasureSmoke({pg=false}={}) {
  for(const work of [direct,route]){const f=sqlite();try{await work(f);}finally{f.close();}}
  for(const mode of ['already-aborted','missing-pool']){const f=sqlite();try{await route(f,{mode});}finally{f.close();}}
  if(pg) {
    const f=await postgres();try{await direct(f);}finally{await f.close();}
    for(const mode of ['normal','acquisition','owner-lock','statement','idle','whole','cancel','uncertain','already-aborted','missing-pool']) {
      const f=await postgres();try{await completePgSchema(f);await route(f,{mode});}finally{await f.close();}
    }
    await ownerOrderRace('a','z');await ownerOrderRace('z','a');
  }
  console.log('WEB PUSH AUTHORITY ERASURE GATE OK — no setup/transport/activation authority');
}
module.exports={runWebPushAuthorityErasureSmoke};
async function schemaChild(){
  const url=new URL(process.env.DATABASE_URL);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55449');assert.equal(url.username,'forge_background_test');assert.match(url.pathname,/^\/forge_d2_authority_[a-f0-9]{16}$/);
  const actual=require('../src/db'),pg=require('../src/db/postgres');
  try{await actual.initDb();await require('../src/db/migrate').runAlwaysMigrations();}finally{await actual.pool.end();await pg.close();}
}
if(require.main===module)(process.argv.includes('--schema-child')?schemaChild():runWebPushAuthorityErasureSmoke({pg:process.argv.includes('--postgres')})).catch(e=>{console.error(e);process.exitCode=1;});
