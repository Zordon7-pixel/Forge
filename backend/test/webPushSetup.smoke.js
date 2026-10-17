'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {createWorkerDatabase}=require('../src/db/backgroundSyncWorker');
const {createWebPushSetup,PROTOCOL}=require('../src/services/webPushSetup');
const schema=require('./webPushAuthoritySchema.smoke');
const rateSecret='synthetic-setup-rate-secret-32-bytes-minimum';
const sub=(endpoint='https://fcm.googleapis.com/synthetic')=>{const ec=crypto.createECDH('prime256v1');ec.generateKeys();return {endpoint,keys:{p256dh:ec.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')}};};
const input=subscription=>({protocol:PROTOCOL,clientNonce:crypto.randomBytes(32).toString('base64url'),authEpoch:crypto.randomUUID(),subscription});
// Normal synthetic clients explicitly call the actual stateless issue endpoint
// before first create. Never manufacture a server admission in the fixture.
const autoIssue=service=>({execute:async(action,body,options)=>{
  if(action==='create'&&!body.operationId){const issued=await service.execute('issue-create',body,options);Object.assign(body,{operationId:issued.operationId,createAdmission:issued.createAdmission});}
  return service.execute(action,body,options);
}});
const common=p=>({protocol:p.protocol,operationId:p.operationId,clientNonce:p.clientNonce,authEpoch:p.authEpoch});
const context=(owner='a')=>({owner,token:'synthetic-jwt-'+owner,address:'::ffff:127.0.0.1'});
const plain=value=>JSON.parse(JSON.stringify(value));
async function harness(make=schema.sqlite) {
  const f=await make();await f.migrate();
  await f.db.exec("INSERT INTO users(id,name,email,password_hash) VALUES('a','Synthetic','a@example.invalid','synthetic'),('b','Synthetic','b@example.invalid','synthetic')");
  const database=createWorkerDatabase(f.dialect==='sqlite'?{sqlite:f.native}:{pool:f.pool}),sent=[];
  const service=createWebPushSetup({database,rateSecret,vapidDetails:{publicKey:'synthetic',privateKey:'synthetic',subject:'mailto:synthetic@example.invalid'},
    send:async(s,p,options)=>{assert.equal(f.native?.isTransaction||false,false);assert.equal(await options.beforeSend(),true);sent.push({subscription:s,payload:JSON.parse(p),options});return {statusCode:201};}});
  return {...f,database,service:autoIssue(service),rawService:service,sent,close:async()=>{await database.close();await f.close();}};
}
const confirm=(p,created,proof)=>({...common(p),subscription:p.subscription,challengeId:created.challengeId,proof,nextPossessionProofHash:crypto.randomBytes(32).toString('hex')});
async function lifecycle(make) {
  const f=await harness(make);try {
    const p=input(sub()),created=await f.service.execute('create',p,context());
    assert.equal(f.sent.length,1);assert.equal(f.sent[0].payload.title,'Forged Hybrid');assert.equal(f.sent[0].payload.body,'Open Forge to finish enabling notifications.');
    const counters=plain(await f.db.all('SELECT * FROM web_push_setup_rate_buckets ORDER BY dimension'));
    assert.equal(counters.length,4);assert(counters.every(r=>Number(r.used_count)===1));
    assert.equal((await f.service.execute('create',p,context())).challengeId,created.challengeId);assert.equal(f.sent.length,1);
    assert.deepEqual(plain(await f.db.all('SELECT * FROM web_push_setup_rate_buckets ORDER BY dimension')),counters);
    await assert.rejects(()=>f.service.execute('create',{...p,subscription:sub(p.subscription.endpoint)},context()),{code:'OPERATION_CONFLICT'});
    const confirmation=confirm(p,created,f.sent[0].payload.setup.secret);
    const active=await f.service.execute('confirm',confirmation,context());assert.equal(active.state,'CONFIRMED');
    const stable=plain(await f.db.get('SELECT * FROM push_subscriptions WHERE id=?',[active.targetId]));
    const replay=await f.service.execute('confirm',confirmation,context());assert.equal(replay.generation,active.generation);
    for(const changedKeys of [false,true]) {
      const next=input(changedKeys?sub(p.subscription.endpoint):p.subscription);
      const before=plain(await f.db.get('SELECT * FROM push_subscriptions WHERE id=?',[active.targetId]));
      const claimBefore=plain(await f.db.get('SELECT * FROM web_push_claims'));
      const pending=await f.service.execute('create',next,context());
      assert.deepEqual(plain(await f.db.get('SELECT * FROM push_subscriptions WHERE id=?',[active.targetId])),before,'pending never replaces working keys or generation');
      assert.deepEqual(plain(await f.db.get('SELECT * FROM web_push_claims')),claimBefore);
      assert.deepEqual(f.sent.at(-1).subscription,next.subscription);
      const proof=f.sent.at(-1).payload.setup.secret;
      await assert.rejects(()=>f.service.execute('confirm',{...confirm(next,pending,proof),subscription:sub(p.subscription.endpoint)},context()),{code:'OPERATION_CONFLICT'});
      const after=await f.service.execute('confirm',confirm(next,pending,proof),context());
      assert.equal(after.targetId,active.targetId);assert.notEqual(after.generation,before.generation);
      const row=await f.db.get('SELECT * FROM push_subscriptions WHERE id=?',[active.targetId]);
      assert.equal(row.keys_p256dh,next.subscription.keys.p256dh);assert.equal(row.keys_auth,next.subscription.keys.auth);
      await assert.rejects(()=>f.service.execute('confirm',confirmation,context()),{code:'CLAIM_CHANGED'});
    }
    const beforeLimit=plain(await f.db.all('SELECT * FROM web_push_challenges'));
    await assert.rejects(()=>f.service.execute('create',input(sub()),context()),{code:'SETUP_RATE_LIMITED'});
    assert.deepEqual(plain(await f.db.all('SELECT * FROM web_push_challenges')),beforeLimit);
    assert.notEqual(stable.generation,(await f.db.get('SELECT generation FROM push_subscriptions WHERE id=?',[active.targetId])).generation);
    console.log(`PASS ${f.dialect} first confirm/same-owner identical and changed-key rotation/replay/substitution/quota rollback`);
  }finally{await f.close();}
}
async function grants(make) {
  const f=await harness(make);try {
    const p=input(sub()),created=await f.service.execute('create',p,context());
    for(let i=0;i<3;i++) {
      const grant=await f.service.execute('authorize-handoff',{...common(p),clientId:'synthetic-client'},context());
      const redeem={...common(p),challengeId:created.challengeId,clientId:'synthetic-client',grant:grant.grant};
      const result=await f.service.execute('redeem-handoff',redeem);assert.equal(result.operationId,p.operationId);assert(!JSON.stringify(result).includes(grant.grant));
      await assert.rejects(()=>f.service.execute('redeem-handoff',redeem),{code:'CLAIM_CHANGED'});
    }
    await assert.rejects(()=>f.service.execute('authorize-handoff',{...common(p),clientId:'synthetic-client'},context()),{code:'SETUP_GRANT_LIMIT'});
    for(let i=0;i<5;i++)assert.equal((await f.service.execute('confirm',confirm(p,created,crypto.randomBytes(32).toString('base64url')),context())).error,'SETUP_PROOF_INVALID');
    assert.equal((await f.service.execute('status',common(p),context())).state,'CANCELLED');
    await assert.rejects(()=>f.service.execute('confirm',confirm(p,created,f.sent[0].payload.setup.secret),context()),{code:'CLAIM_CHANGED'});
    assert.equal(Boolean((await f.db.get('SELECT active FROM push_subscriptions')).active),false);
    console.log(`PASS ${f.dialect} bounded grants/single redemption/five bad proofs/cancel no activation`);
  }finally{await f.close();}
}
async function quotaAndPrivacy() {
  const f=await harness();try {
    let time=Date.parse('2026-10-01T10:09:59.000Z');
    f.native.function('julianday',_value=>time/86400000+2440587.5);
    const p=input(sub());await f.service.execute('create',p,context());
    const rows=await f.db.all('SELECT * FROM web_push_setup_rate_buckets');
    const hmac=(domain,value)=>crypto.createHmac('sha256',rateSecret).update(domain).update(value).digest('hex');
    assert.equal(Buffer.from(rows.find(r=>r.dimension==='USER').key_hash).toString('hex'),hmac('forge:web-push-setup-rate:v1:USER\0','a'));
    assert.equal(Buffer.from(rows.find(r=>r.dimension==='IP').key_hash).toString('hex'),hmac('forge:web-push-setup-rate:v1:IP\0','127.0.0.1'));
    assert.equal(Buffer.from(rows.find(r=>r.dimension==='GLOBAL').key_hash).toString('hex'),crypto.createHash('sha256').update('forge:web-push-setup-rate:v1:GLOBAL').digest('hex'));
    const op=await f.db.get('SELECT * FROM web_push_setup_operations');assert.equal(Buffer.from(op.session_hash).toString('hex'),hmac('forge:web-push-setup-session:v1\0','synthetic-jwt-a'));
    const raw=JSON.stringify(await f.db.all('SELECT * FROM web_push_setup_operations'));
    for(const secret of [p.clientNonce,p.subscription.endpoint,p.subscription.keys.auth,p.subscription.keys.p256dh,'synthetic-jwt-a',f.sent[0].payload.setup.secret])assert(!raw.includes(secret));
    const alternate={...p,subscription:{...p.subscription,keys:Object.fromEntries(Object.entries(p.subscription.keys).map(([k,v])=>[k,Buffer.from(v,'base64url').toString('base64')]))}};
    await f.service.execute('create',alternate,context());assert.equal(f.sent.length,1,'decoded key spelling keeps exact replay');
    for(const field of ['clientNonce','authEpoch']) {
      const changed={...common(p),[field]:field==='clientNonce'?crypto.randomBytes(32).toString('base64url'):crypto.randomUUID()};
      await assert.rejects(()=>f.service.execute('status',changed,context()),{code:'CLAIM_CHANGED'});
    }
    await assert.rejects(()=>f.service.execute('status',common(p),{...context(),token:'successor-session'}),{code:'CLAIM_CHANGED'});
    const oldRows=plain(await f.db.all('SELECT * FROM web_push_setup_rate_buckets'));
    for(const key of ['', 'short']) {
      const svc=autoIssue(createWebPushSetup({database:f.database,rateSecret:key}));
      await assert.rejects(()=>svc.execute('create',input(sub()),context()),{code:'SETUP_UNAVAILABLE'});
      assert.deepEqual(plain(await f.db.all('SELECT * FROM web_push_setup_rate_buckets')),oldRows);
    }
    // Independent dimensions: prefill a current real bucket to its boundary,
    // then use the actual producer to demonstrate all-or-nothing rejection.
    for(const [dimension,cap] of [['GLOBAL',100],['USER',3],['ENDPOINT',3],['IP',20]]) {
      await f.db.run('UPDATE web_push_setup_rate_buckets SET used_count=? WHERE dimension=?',[cap,dimension]);
      const before=plain(await f.db.all('SELECT * FROM web_push_setup_rate_buckets ORDER BY dimension'));
      await assert.rejects(()=>f.service.execute('create',input(p.subscription),context()),{code:'SETUP_RATE_LIMITED'});
      assert.deepEqual(plain(await f.db.all('SELECT * FROM web_push_setup_rate_buckets ORDER BY dimension')),before);
      await f.db.run('UPDATE web_push_setup_rate_buckets SET used_count=1 WHERE dimension=?',[dimension]);
    }
    time+=2000;await f.service.execute('create',input(sub()),context());
    assert.equal(Number((await f.db.get('SELECT count(DISTINCT window_start_ms) AS n FROM web_push_setup_rate_buckets')).n),2);
    time+=600000;await f.service.execute('create',input(sub()),context());
    assert.equal(Number((await f.db.get('SELECT count(DISTINCT window_start_ms) AS n FROM web_push_setup_rate_buckets')).n),2);
    assert.equal(Number((await f.db.get('SELECT MIN(window_start_ms) AS n FROM web_push_setup_rate_buckets')).n),Math.floor(time/600000)*600000-600000);
    console.log('PASS sqlite exact USER/IP/GLOBAL/session commitments/decoded keys/secret exclusion/independent quota boundaries/DB UTC rollover');
  }finally{await f.close();}
}
async function retention() {
  const f=await harness();try {
    let time=Date.now();f.native.function('julianday',_value=>time/86400000+2440587.5);
    const p=input(sub()),c=await f.service.execute('create',p,context());await f.service.execute('confirm',confirm(p,c,f.sent[0].payload.setup.secret),context());
    const target=plain(await f.db.get('SELECT * FROM push_subscriptions'));
    time+=86400002;
    await f.service.execute('create',input(sub()),context());
    assert.equal(await f.db.get('SELECT id FROM web_push_challenges WHERE operation_id=?',[p.operationId]),undefined);
    assert.deepEqual(plain(await f.db.get('SELECT * FROM push_subscriptions WHERE id=?',[target.id])),target);
    await assert.rejects(()=>f.service.execute('status',common(p),context()),{code:'SETUP_EXPIRED'});
    console.log('PASS sqlite bounded expired metadata removal/active target preserved/expired replay410');
  }finally{await f.close();}
}
async function bucketBound() {
  const f=await harness();try {
    let time=Date.parse('2026-10-01T10:00:01Z');f.native.function('julianday',_value=>time/86400000+2440587.5);
    for(let window=0;window<2;window++) {
      for(let n=0;n<100;n++) {
        const owner=`owner-${window}-${n}`;await f.db.run('INSERT INTO users(id,name,email,password_hash) VALUES(?,?,?,?)',[owner,'Synthetic',owner+'@example.invalid','synthetic']);
        await f.service.execute('create',input(sub('https://fcm.googleapis.com/'+owner)),{...context(owner),address:`192.0.2.${n+1}`});
      }
      assert.equal(Number((await f.db.get('SELECT count(*) AS n FROM web_push_setup_rate_buckets')).n),(window+1)*301);
      const before=plain(await f.db.all('SELECT * FROM web_push_setup_rate_buckets ORDER BY dimension,key_hash,window_start_ms'));
      await assert.rejects(()=>f.service.execute('create',input(sub('https://fcm.googleapis.com/exhausted-'+window)),context()),{code:'SETUP_RATE_LIMITED'});
      assert.deepEqual(plain(await f.db.all('SELECT * FROM web_push_setup_rate_buckets ORDER BY dimension,key_hash,window_start_ms')),before,'global exhaustion cannot create lower dimensions');
      time+=600000;
    }
    await f.service.execute('create',input(sub('https://fcm.googleapis.com/third-window')),context());
    assert.equal(Number((await f.db.get('SELECT count(*) AS n FROM web_push_setup_rate_buckets')).n),305);
    console.log('PASS sqlite actual 200-creation producer: 301 per window, 602 two-window cap, GLOBAL exhaustion zero lower buckets, old window cleanup');
  }finally{await f.close();}
}
async function cancellationHistory(make) {
  const f=await harness(make);try {
    const p=input(sub()),c=await f.service.execute('create',p,context()),active=await f.service.execute('confirm',confirm(p,c,f.sent[0].payload.setup.secret),context());
    for(const name of ['pending','leased','accepted']) {
      await f.db.run("INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds) VALUES(?,'a','2026-01-01','easy',1,600)",[name]);
      await f.db.run("INSERT INTO user_notifications(id,user_id,type,title,body,source_key) VALUES(?,'a','activity','Synthetic','Synthetic',?)",[name,name]);
      await f.db.run("INSERT INTO activity_notification_events(id,user_id,run_id,notification_id,state) VALUES(?,'a',?,?,'ACTIVE')",[name,name,name]);
      await f.db.run("INSERT INTO notification_deliveries(id,user_id,event_id,notification_id,transport,target_id,target_generation,disclosure,state,expires_at) VALUES(?,'a',?,?,'WEB_PUSH',?,?,'GENERIC','PENDING','2099-01-01')",[name,name,name,active.targetId,active.generation]);
      if(name!=='pending') {
        await f.db.run("UPDATE notification_deliveries SET state='LEASED',lease_token=?,lease_until='2098-01-01' WHERE id=?",[crypto.randomUUID(),name]);
        await f.db.run('UPDATE notification_deliveries SET admitted_lease_token=lease_token,attempts=attempts+1 WHERE id=?',[name]);
        if(name==='accepted')await f.db.run("UPDATE notification_deliveries SET state='ACCEPTED',accepted_at='2026-01-01',lease_token=NULL,lease_until=NULL,admitted_lease_token=NULL WHERE id=?",[name]);
      }
    }
    const accepted=plain(await f.db.get("SELECT * FROM notification_deliveries WHERE id='accepted'"));
    const next=input(sub(p.subscription.endpoint)),nc=await f.service.execute('create',next,context());
    assert.equal((await f.db.get("SELECT state FROM notification_deliveries WHERE id='leased'")).state,'LEASED');
    await f.service.execute('confirm',confirm(next,nc,f.sent.at(-1).payload.setup.secret),context());
    for(const id of ['pending','leased']){const row=await f.db.get('SELECT * FROM notification_deliveries WHERE id=?',[id]);assert.equal(row.state,'CANCELLED');for(const k of ['lease_token','lease_until','admitted_lease_token'])assert.equal(row[k],null);assert.equal(Number(row.attempts),id==='leased'?1:0);}
    assert.deepEqual(plain(await f.db.get("SELECT * FROM notification_deliveries WHERE id='accepted'")),accepted);
    console.log(`PASS ${f.dialect} real delivery marker/lease clearing on confirm, no create cancellation, accepted history/attempts retained`);
  }finally{await f.close();}
}
async function state(f) {
  const result={};for(const table of ['push_subscriptions','web_push_claims','web_push_challenges','web_push_setup_operations','web_push_setup_rate_buckets'])result[table]=plain(await f.db.all('SELECT * FROM '+table));return result;
}
async function admission() {
  const f=await harness();try {
    let time=Date.parse('2026-10-01T10:00:00Z');f.native.function('julianday',_value=>(time+0.25)/86400000+2440587.5);
    const original=input(sub()),before=await state(f),issued=await f.rawService.execute('issue-create',original,context());
    assert.deepEqual(await state(f),before);assert.equal(f.sent.length,0);assert.match(issued.operationId,/^[a-f0-9-]{36}$/);
    const [encoded,mac]=issued.createAdmission.split('.'),payload=Buffer.from(encoded,'base64url'),parts=JSON.parse(payload);
    assert.equal(parts[0],'FORGE_WEB_PUSH_CREATE_ADMISSION_V1');assert.equal(parts[1],issued.operationId);assert.equal(Number(parts[2]),time);assert.equal(Number(parts[3])-Number(parts[2]),120000);
    assert.equal(mac,crypto.createHmac('sha256',rateSecret).update('forge:web-push-create-admission-token:v1\0').update(payload).digest('base64url'));
    for(const value of [original.subscription.endpoint,original.subscription.keys.p256dh,original.subscription.keys.auth,original.clientNonce,'synthetic-jwt-a'])assert(!payload.toString().includes(value));
    const again=await f.rawService.execute('issue-create',original,context());assert.notEqual(again.operationId,issued.operationId);assert.notEqual(again.createAdmission,issued.createAdmission);assert.deepEqual(await state(f),before);
    for(const field of ['operationId','issuedAtMs','expiresAt','owner','expectedRevision','incarnation','ttl','headers','unknown'])await assert.rejects(()=>f.rawService.execute('issue-create',{...original,[field]:'untrusted'},context()),{code:'SETUP_INVALID'});
    const create={...original,operationId:issued.operationId,createAdmission:issued.createAdmission};
    const encode=(data,validMac=true)=>{const bytes=Buffer.from(JSON.stringify(data));return bytes.toString('base64url')+'.'+(validMac?crypto.createHmac('sha256',rateSecret).update('forge:web-push-create-admission-token:v1\0').update(bytes).digest('base64url'):mac);};
    for(const token of [issued.createAdmission+'=',encoded+'.'+mac+'.x','!.'+mac,encoded+'.x','x'.repeat(1025),
      encode([...parts.slice(0,2),'01',...parts.slice(3)]),encode([parts[0],'not-uuid',...parts.slice(2)]),encode([...parts.slice(0,4),'F'.repeat(64),parts[5]]),
      Buffer.from(JSON.stringify(parts,null,1)).toString('base64url')+'.'+mac,
      Buffer.concat([Buffer.from('["'),Buffer.from([255]),Buffer.from(JSON.stringify(parts).slice(JSON.stringify(parts[0]).length+1))]).toString('base64url')+'.'+mac]) {
      await assert.rejects(()=>f.rawService.execute('create',{...create,createAdmission:token},context()),{code:'SETUP_INVALID'});assert.deepEqual(await state(f),before);
    }
    for(const candidate of [{...create,createAdmission:undefined},{...create,createAdmission:encoded+'.'+Buffer.alloc(32).toString('base64url')},
      {...create,createAdmission:encode(['WRONG_VERSION',...parts.slice(1)])},{...create,operationId:crypto.randomUUID()},
      {...create,authEpoch:crypto.randomUUID()},{...create,clientNonce:crypto.randomBytes(32).toString('base64url')},
      {...create,protocol:'WRONG_PROTOCOL'},{...create,subscription:sub()},
      {...create,subscription:{...original.subscription,endpoint:original.subscription.endpoint+'-other'}},
      {...create,subscription:{...original.subscription,keys:{...original.subscription.keys,auth:crypto.randomBytes(16).toString('base64url')}}}]) {
      await assert.rejects(()=>f.rawService.execute('create',candidate,context()),{code:'SETUP_EXPIRED'});assert.deepEqual(await state(f),before);
    }
    for(const ctx of [context('b'),{...context(),token:'other-session'}]){await assert.rejects(()=>f.rawService.execute('create',create,ctx),{code:'SETUP_EXPIRED'});assert.deepEqual(await state(f),before);}
    const rotated=createWebPushSetup({database:f.database,rateSecret:rateSecret+'rotated'});
    await assert.rejects(()=>rotated.execute('create',create,context()),{code:'SETUP_EXPIRED'});assert.deepEqual(await state(f),before);
    const realDateNow=Date.now;try{Date.now=()=>0;const result=await f.rawService.execute('issue-create',original,context());assert.equal(result.expiresAt,time+120000);Date.now=()=>Number.MAX_SAFE_INTEGER;assert.equal((await f.rawService.execute('issue-create',original,context())).expiresAt,time+120000);}finally{Date.now=realDateNow;}
    time=issued.expiresAt;await assert.rejects(()=>f.rawService.execute('create',create,context()),{code:'SETUP_EXPIRED'});assert.deepEqual(await state(f),before);
    time++;await assert.rejects(()=>f.rawService.execute('create',create,context()),{code:'SETUP_EXPIRED'});
    time=issued.expiresAt-1;const created=await f.rawService.execute('create',create,context());assert.equal(created.expiresAt,time+300000);
    const committed=await state(f);time+=2;
    assert.equal((await f.rawService.execute('create',create,context())).challengeId,created.challengeId);assert.deepEqual(await state(f),committed);assert.equal(f.sent.length,1);
    for(const changed of [{...create,clientNonce:crypto.randomBytes(32).toString('base64url')},{...create,authEpoch:crypto.randomUUID()},{...create,protocol:'CHANGED'},
      {...create,subscription:sub()},{...create,subscription:{...original.subscription,endpoint:original.subscription.endpoint+'-changed'}}]) {
      await assert.rejects(()=>f.rawService.execute('create',changed,context()),{code:'OPERATION_CONFLICT'});assert.deepEqual(await state(f),committed);
    }
    await assert.rejects(()=>f.rawService.execute('create',create,{...context(),token:'changed-session'}),{code:'OPERATION_CONFLICT'});
    time+=86400000;await assert.rejects(()=>f.rawService.execute('create',create,context()),{code:'SETUP_EXPIRED'});assert.deepEqual(await state(f),committed,'logical retained expiry performs no cleanup/mutation');
    console.log('PASS sqlite canonical admission/DB120000ms/no issuance mutation/closed fields/bindings/rotation/expiry -1=+1/wall-clock independence/retained precedence');
  }finally{await f.close();}
}
async function afterPurge(make) {
  const f=await harness(make);let bounded,offset=0;
  try {
    let time=Date.now();
    let raw=f.rawService,svc=f.service;
    if(f.dialect==='sqlite')f.native.function('julianday',_value=>(time+offset+0.25)/86400000+2440587.5);
    else {
      // Controlled DB-clock offset, evaluated by actual PostgreSQL; not an
      // application Date.now expiry authority or a claim of waiting 24h.
      const pool={connect:async()=>{const c=await f.pool.connect();return {on:c.on.bind(c),removeListener:c.removeListener.bind(c),release:x=>c.release(x),query:(s,p)=>s.startsWith('SELECT floor(extract(epoch FROM clock_timestamp())')
        ?c.query("SELECT floor(extract(epoch FROM (clock_timestamp()+($1*interval '1 millisecond')))*1000)::bigint AS ms",[offset]):c.query(s,p)};}};
      bounded=createWorkerDatabase({pool});raw=createWebPushSetup({database:bounded,rateSecret,vapidDetails:{publicKey:'synthetic',privateKey:'synthetic',subject:'mailto:synthetic@example.invalid'},send:async(s,p,o)=>{assert.equal(await o.beforeSend(),true);f.sent.push({subscription:s,payload:JSON.parse(p)});return {statusCode:201};}});svc=autoIssue(raw);
    }
    const old=input(sub()),first=await svc.execute('create',old,context());await svc.execute('confirm',confirm(old,first,f.sent[0].payload.setup.secret),context());
    offset=86400010;
    const newer=input(old.subscription);await svc.execute('create',newer,context());
    assert.equal(await f.db.get('SELECT id FROM web_push_challenges WHERE operation_id=?',[old.operationId]),undefined);
    const snapshot=await state(f),sends=f.sent.length;
    for(const candidate of [old,{...old,createAdmission:undefined},{...old,createAdmission:newer.createAdmission}]) {
      await assert.rejects(()=>raw.execute('create',candidate,context()),{code:'SETUP_EXPIRED'});assert.deepEqual(await state(f),snapshot);assert.equal(f.sent.length,sends);
    }
    assert.notEqual((await svc.execute('status',common(newer),context())).state,'CANCELLED');
    assert.equal(JSON.stringify(await state(f)).includes(old.createAdmission),false);
    console.log(`PASS ${f.dialect} reproduced old-after-purge now410 (expired/missing/fresh-wrong-ID), newer pending byte-identical/no quota/no send`);
  }finally{if(bounded)await bounded.close();await f.close();}
}
async function transitionBoundaries(make) {
  for(const foreignReference of [false,true]) {
    const f=await harness(make);let bounded,time=Date.now();
    try {
      let svc=f.service;
      // Deterministic DB-clock fixture only: all schema, transactions, locks,
      // writes, retention queries and guards remain actual dialect operations.
      if(f.dialect==='sqlite')f.native.function('julianday',_value=>(time+0.25)/86400000+2440587.5);
      else {
        const pool={connect:async()=>{const c=await f.pool.connect();return {on:c.on.bind(c),removeListener:c.removeListener.bind(c),release:x=>c.release(x),query:(s,p)=>s.startsWith('SELECT floor(extract(epoch FROM clock_timestamp())')
          ?c.query('SELECT floor(extract(epoch FROM $1::timestamptz)*1000)::bigint AS ms',[new Date(time).toISOString()]):c.query(s,p)};}};
        bounded=createWorkerDatabase({pool});svc=autoIssue(createWebPushSetup({database:bounded,rateSecret,vapidDetails:{publicKey:'synthetic',privateKey:'synthetic',subject:'mailto:synthetic@example.invalid'},send:async(s,p,o)=>{assert.equal(await o.beforeSend(),true);f.sent.push({payload:JSON.parse(p)});return {statusCode:201};}}));
      }
      const p=input(sub()),c=await svc.execute('create',p,context()),possession=crypto.randomBytes(32);
      const body={...confirm(p,c,f.sent[0].payload.setup.secret),nextPossessionProofHash:crypto.createHash('sha256').update(possession).digest('hex')};
      const initial=plain(await f.db.get('SELECT * FROM web_push_claims'));time+=1000;
      assert.deepEqual(await svc.execute('confirm',{...body,proof:crypto.randomBytes(32).toString('base64url')},context()),{error:'SETUP_PROOF_INVALID'});
      assert.deepEqual(plain(await f.db.get('SELECT * FROM web_push_claims')),initial,'failed proof never refreshes authority age');
      const active=await svc.execute('confirm',body,context()),confirmed=plain(await f.db.get('SELECT * FROM web_push_claims'));
      assert.equal(Date.parse(confirmed.updated_at),time,'successful confirm stamps authoritative DB clock');time+=1000;
      await svc.execute('confirm',body,context());await svc.execute('status',common(p),context());
      assert.deepEqual(plain(await f.db.get('SELECT * FROM web_push_claims')),confirmed,'exact replay and status never refresh age');
      let foreign;
      if(foreignReference){const other=input(p.subscription);await svc.execute('create',other,context('b'));foreign=plain(await f.db.get("SELECT * FROM web_push_challenges WHERE user_id='b'"));}
      time+=86401000;
      const revoke={...common(p),subscription:p.subscription,targetId:active.targetId,generation:active.generation,incarnation:active.incarnation,revision:active.revision,possessionProof:possession.toString('base64url')};
      await assert.rejects(()=>svc.execute('revoke',{...revoke,possessionProof:crypto.randomBytes(32).toString('base64url')},context()),{code:'CLAIM_CHANGED'});
      assert.deepEqual(plain(await f.db.get('SELECT * FROM web_push_claims')),confirmed);
      await svc.execute('revoke',revoke,context());const vacant=plain(await f.db.get('SELECT * FROM web_push_claims')),vacancyAt=time;
      assert.equal(vacant.state,'VACANT');assert.equal(Date.parse(vacant.updated_at),vacancyAt);assert.notEqual(vacant.incarnation,confirmed.incarnation);
      const lookup=()=>f.db.get('SELECT * FROM web_push_claims WHERE endpoint_hash=?',[vacant.endpoint_hash]);
      const cleanup=owner=>svc.execute('create',input(sub('https://fcm.googleapis.com/cleanup-'+crypto.randomUUID())),context(owner));
      await cleanup('a');assert.deepEqual(plain(await lookup()),vacant,'old metadata cleanup cannot purge fresh vacancy');
      const afterFailure=await state(f);await assert.rejects(()=>svc.execute('revoke',revoke,context()),{code:'CLAIM_CHANGED'});assert.deepEqual(await state(f),afterFailure);
      if(foreignReference) {
        time=vacancyAt+86400001;await cleanup('a');assert.deepEqual(plain(await lookup()),vacant,'even expired foreign reference prevents authority purge');
        assert.deepEqual(plain(await f.db.get('SELECT * FROM web_push_challenges WHERE id=?',[foreign.id])),foreign,'cleanup never deletes another owner replay');
        await cleanup('b');assert.equal(await lookup(),undefined,'purge only after referencing owner removes its expired metadata');
      } else {
        assert.equal(Number((await f.db.get('SELECT count(*) AS n FROM web_push_challenges WHERE endpoint_hash=?',[vacant.endpoint_hash])).n),0);
        for(const age of [86399999,86400000]){time=vacancyAt+age;await cleanup('a');assert.deepEqual(plain(await lookup()),vacant,'vacancy survives at and before 24h');}
        time=vacancyAt+86400001;await cleanup('a');assert.equal(await lookup(),undefined,'strictly older than24h and unreferenced may purge');
      }
      const stable=await state(f),sends=f.sent.length;await assert.rejects(()=>svc.execute('create',p,context()),{code:'SETUP_EXPIRED'});assert.deepEqual(await state(f),stable);assert.equal(f.sent.length,sends);
      console.log(`PASS ${f.dialect} successful transition DB clocks/replay and failure age unchanged/VACANT strict24h/reference=${foreignReference}/old create410`);
    }finally{if(bounded)await bounded.close();await f.close();}
  }
  const f=await harness(make);try {
    const p=input(sub()),c=await f.service.execute('create',p,context()),possession=crypto.randomBytes(32);
    const active=await f.service.execute('confirm',{...confirm(p,c,f.sent[0].payload.setup.secret),nextPossessionProofHash:crypto.createHash('sha256').update(possession).digest('hex')},context());
    const incarnation=crypto.randomUUID();await f.db.run('UPDATE web_push_claims SET incarnation=?,claim_revision=?',[incarnation,9000000000000000]);
    for(const owner of ['a','b']) {
      const next=input(sub(p.subscription.endpoint)),created=await f.service.execute('create',next,context(owner)),before=await state(f);
      await assert.rejects(()=>f.service.execute('confirm',confirm(next,created,f.sent.at(-1).payload.setup.secret),context(owner)),{code:'REVISION_EXHAUSTED',status:409});
      assert.deepEqual(await state(f),before,'eligible same-owner rotation/foreign activation at max is exact409 with no writes');
    }
    await f.service.execute('revoke',{...common(p),subscription:p.subscription,targetId:active.targetId,generation:active.generation,incarnation,revision:9000000000000000,possessionProof:possession.toString('base64url')},context());
    const vacant=await f.db.get('SELECT * FROM web_push_claims');assert.equal(vacant.state,'VACANT');assert.equal(Number(vacant.claim_revision),0);assert.notEqual(vacant.incarnation,incarnation);
    console.log(`PASS ${f.dialect} exact REVISION_EXHAUSTED409/no state mutation at max, possession revoke remains available`);
  }finally{await f.close();}
}
async function main(){await lifecycle(schema.sqlite);await grants(schema.sqlite);await quotaAndPrivacy();await retention();await bucketBound();await cancellationHistory(schema.sqlite);await admission();await afterPurge(schema.sqlite);await transitionBoundaries(schema.sqlite);if(process.argv.includes('--postgres')){await lifecycle(schema.postgres);await grants(schema.postgres);await cancellationHistory(schema.postgres);await afterPurge(schema.postgres);await transitionBoundaries(schema.postgres);}console.log('WEB PUSH SETUP SMOKE OK');}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={harness,sub,input,common,context,confirm,lifecycle,grants,rateSecret,autoIssue};
