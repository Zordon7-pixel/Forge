'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { EventEmitter } = require('node:events');
const { createECDH, randomBytes } = require('node:crypto');
const webpush = require('web-push');
const { migrateBackgroundSyncSqlite } = require('../src/db/backgroundSyncSchema');
const { createWebPushTransport } = require('../src/services/webPushTransport');
const dbPath = require.resolve('../src/db');
const priorDb = require.cache[dbPath];
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {} };
const { createLegacyPushSender } = require('../src/services/push');
if (priorDb) require.cache[dbPath]=priorDb; else delete require.cache[dbPath];
const vapidDetails = { ...webpush.generateVAPIDKeys(), subject:'mailto:synthetic@example.invalid' };
const ecdh=createECDH('prime256v1');ecdh.generateKeys();
const keys={p256dh:ecdh.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function main() {
  const native=new DatabaseSync(':memory:');
  try {
    const schema=fs.readFileSync(path.join(__dirname,'../src/db/schema.pg.sql'),'utf8');
    for(const table of ['users','runs','strava_tokens','push_subscriptions','user_notifications']) {
      const sql=schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`));assert(sql);
      native.exec(sql[0].replace(/id SERIAL PRIMARY KEY/g,'id INTEGER PRIMARY KEY AUTOINCREMENT').replace(/TIMESTAMPTZ/g,'TEXT').replace(/NOW\(\)/g,'CURRENT_TIMESTAMP'));
    }
    await migrateBackgroundSyncSqlite(native);
    native.exec("INSERT INTO users(id,name,email,password_hash) VALUES('a','Synthetic','a@example.invalid','no-secret'),('b','Synthetic','b@example.invalid','no-secret')");
    const insert=native.prepare('INSERT INTO push_subscriptions(id,user_id,endpoint,keys_p256dh,keys_auth,active,generation) VALUES(?,?,?,?,?,?,?)');
    function reset(){native.exec('DELETE FROM push_subscriptions');
      insert.run('a1','a','https://fcm.googleapis.com/send/secret-a',keys.p256dh,keys.auth,1,'generation-a');
      insert.run('a0','a','https://fcm.googleapis.com/send/secret-inactive',keys.p256dh,keys.auth,0,'generation-inactive');
      insert.run('b1','b','https://fcm.googleapis.com/send/secret-b',keys.p256dh,keys.auth,1,'generation-b');
    }
    const api={all:async(sql,args)=>native.prepare(sql).all(...args),get:async(sql,args)=>native.prepare(sql).get(...args),
      run:async(sql,args)=>native.prepare(sql).run(...args)};
    const row=id=>native.prepare('SELECT * FROM push_subscriptions WHERE id=?').get(id);
    function sender({status=201,beforeDns,hold=false,error}={}) {
      const state={calls:[],logs:[],payloads:[],finish:null};
      const transport=createWebPushTransport({
        resolverFactory:()=>({resolve4(host,cb){if(beforeDns){try{beforeDns();}catch(error){state.mutationError=error;throw error;}}queueMicrotask(()=>cb(null,['8.8.8.8']));},resolve6(host,cb){queueMicrotask(()=>cb(null,[]));},cancel(){}}),
        request:(options,cb)=>{
          state.calls.push(options);
          const req=new EventEmitter();req.destroy=()=>{};
          req.end=()=>{const finish=()=>{if(error){req.emit('error',error);return;}
            const res=new EventEmitter();res.statusCode=status;res.destroy=()=>{};cb(res);res.emit('data','sensitive-provider-body');res.emit('end');};
            state.finish=finish;if(!hold)queueMicrotask(finish);
          };return req;
        },
      });
      return {state,send:createLegacyPushSender({...api,vapidDetails,log:code=>state.logs.push(code),
        send:(sub,payload,options)=>{state.payloads.push(payload);return transport(sub,payload,options);}})};
    }
    reset();const initial=row('b1');const good=sender();
    assert.deepEqual(await good.send('a',{title:'PRIVATE RUN SAVED',body:'private-health',url:'https://attacker.invalid',notificationId:'foreign'}),{sent:1});
    assert.equal(good.state.calls.length,1);assert.deepEqual(JSON.parse(good.state.payloads[0]),{title:'Forge update',body:'Open Forge to review.',url:'/'});
    assert.deepEqual(row('b1'),initial);assert.equal(row('a0').active,0);
    assert.deepEqual(await good.send('absent'),{sent:0});assert.equal(good.state.calls.length,1);
    for(const status of [404,410]) {
      reset();
      native.exec(`INSERT INTO runs(id,user_id,date,type) VALUES('history-${status}','a','2026-01-01','easy');
        INSERT INTO user_notifications(id,user_id,type,title,body,source_key) VALUES('notice-${status}','a','update','Synthetic','Synthetic','key-${status}');
        INSERT INTO activity_notification_events(id,user_id,run_id,notification_id,state) VALUES('event-${status}','a','history-${status}','notice-${status}','ACTIVE');
        INSERT INTO notification_deliveries(id,user_id,event_id,notification_id,transport,target_id,target_generation,disclosure,state,expires_at,accepted_at)
          VALUES('delivery-${status}','a','event-${status}','notice-${status}','WEB_PUSH','a1','generation-a','GENERIC','ACCEPTED','2099-01-01','2026-01-01');`);
      const accepted=native.prepare('SELECT * FROM notification_deliveries WHERE id=?').get(`delivery-${status}`);
      const f=sender({status});assert.deepEqual(await f.send('a'),{sent:0});
      assert.equal(row('a1').active,0);assert.equal(row('a1').generation,'generation-a');assert.equal(row('b1').active,1);
      assert.equal(native.prepare('SELECT COUNT(*) n FROM push_subscriptions').get().n,3,'deactivate, never delete');
      assert.deepEqual(native.prepare('SELECT * FROM notification_deliveries WHERE id=?').get(`delivery-${status}`),accepted,'accepted history survives deactivation');
    }
    for(const status of [401,403]) {
      reset();const before=native.prepare('SELECT * FROM background_sync_control').all();const f=sender({status});
      assert.deepEqual(await f.send('a'),{sent:0,configurationFailed:true});assert.equal(row('a1').active,1);
      assert.deepEqual(f.state.logs,['WEB_PUSH_CONFIGURATION_FAILED']);assert.deepEqual(native.prepare('SELECT * FROM background_sync_control').all(),before);
    }
    for(const status of [404,410,401,403,201]) {
      reset();const f=sender({status,hold:true});const pending=f.send('a');await tick();assert.equal(f.state.calls.length,1);
      native.prepare("UPDATE push_subscriptions SET user_id='b',generation='successor',keys_auth=? WHERE id='a1'").run(randomBytes(16).toString('base64url'));
      const rebound=row('a1');f.state.finish();await pending;assert.deepEqual(row('a1'),rebound,'late result cannot alter successor generation');
    }
    for(const mutation of ["UPDATE push_subscriptions SET generation='new' WHERE id='a1'",
      "UPDATE push_subscriptions SET user_id='b',generation='new' WHERE id='a1'",
      "UPDATE push_subscriptions SET active=0 WHERE id='a1'",
      "BEGIN; DELETE FROM activity_notification_events WHERE user_id='a'; DELETE FROM push_subscriptions WHERE user_id='a'; DELETE FROM user_notifications WHERE user_id='a'; DELETE FROM runs WHERE user_id='a'; DELETE FROM users WHERE id='a'; COMMIT"]) {
      reset();const f=sender({beforeDns:()=>native.exec(mutation)});assert.deepEqual(await f.send('a'),{sent:0});
      assert.equal(f.state.mutationError,undefined,mutation);assert.equal(f.state.calls.length,0,'recheck after DNS rejects stale owner/generation');
    }
    assert.equal(native.prepare("SELECT id FROM users WHERE id='a'").get(),undefined,'account erasure committed');
    native.exec("INSERT INTO users(id,name,email,password_hash) VALUES('a','Synthetic','a@example.invalid','no-secret')");
    reset();const failed=sender({error:new Error('endpoint secret-a sensitive-provider-body')});await failed.send('a');
    assert.deepEqual(failed.state.logs,['WEB_PUSH_DELIVERY_FAILED']);assert.equal(row('a1').active,1);
    const bogus=createLegacyPushSender({...api,vapidDetails,send:async()=>{throw {statusCode:410,message:'secret'};},log:()=>{}});
    await bogus('a');assert.equal(row('a1').active,1,'unbranded status cannot deactivate');
    assert.deepEqual(await createLegacyPushSender({...api,vapidDetails:{}})('a'),{sent:0,skipped:true});
    await assert.rejects(createLegacyPushSender({...api,vapidDetails,all:async()=>{throw new Error('secret endpoint');}})('a'),
      error=>error.message==='WEB_PUSH_STORAGE_UNAVAILABLE');
    console.log('WEB PUSH LEGACY CONTAINMENT OK: actual current SQLite schema, ownership/current generation, generic copy, late expiry, configuration failure retained');
  } finally {native.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
