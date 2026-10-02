'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createWorkerDatabase}=require('../src/db/backgroundSyncWorker');
const {createWebPushSetup}=require('../src/services/webPushSetup');
const {neutralizeOwnedWebPushAuthority,erasePushSetupUserRate}=require('../src/lib/accountDataCoverage');
const schema=require('./webPushAuthoritySchema.smoke');
const {harness,sub,input,common,context,confirm,rateSecret,autoIssue}=require('./webPushSetup.smoke');
const plain=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)};};
function service(database,send=async()=>({statusCode:201})) {
  return autoIssue(createWebPushSetup({database,send,rateSecret,vapidDetails:{publicKey:'synthetic',privateKey:'synthetic',subject:'mailto:synthetic@example.invalid'}}));
}
async function takeover(make) {
  const f=await harness(make);try {
    const a=input(sub()),ca=await f.service.execute('create',a,context()),proofA=crypto.randomBytes(32);
    const ac={...confirm(a,ca,f.sent[0].payload.setup.secret),nextPossessionProofHash:crypto.createHash('sha256').update(proofA).digest('hex')};
    const active=await f.service.execute('confirm',ac,context());
    const b=input(a.subscription),cb=await f.service.execute('create',b,context('b')),bc=confirm(b,cb,f.sent.at(-1).payload.setup.secret);
    const oldB=plain(await f.db.get('SELECT * FROM web_push_challenges WHERE id=?',[cb.challengeId]));
    const revoke={...common(a),subscription:a.subscription,targetId:active.targetId,generation:active.generation,incarnation:active.incarnation,revision:active.revision,possessionProof:proofA.toString('base64url')};
    assert.equal((await f.service.execute('revoke',revoke,context())).state,'REVOKED');
    await assert.rejects(()=>f.service.execute('confirm',bc,context('b')),{code:'CLAIM_CHANGED'});
    assert.deepEqual(plain(await f.db.get('SELECT * FROM web_push_challenges WHERE id=?',[cb.challengeId])),oldB,'foreign pending data retained, old incarnation invalid');
    await assert.rejects(()=>f.service.execute('revoke',revoke,context()),{code:'CLAIM_CHANGED'});
    const retry=input(a.subscription),cr=await f.service.execute('create',retry,context('b'));
    const next=await f.service.execute('confirm',confirm(retry,cr,f.sent.at(-1).payload.setup.secret),context('b'));
    assert.notEqual(next.targetId,active.targetId);assert.equal(next.revision,1);assert.notEqual(next.incarnation,active.incarnation);
    await assert.rejects(()=>f.service.execute('confirm',bc,context('b')),{code:'CLAIM_CHANGED'});
    assert.equal((await f.db.get('SELECT user_id FROM push_subscriptions WHERE id=?',[active.targetId])).user_id,'a');
    console.log(`PASS ${f.dialect} foreign transfer/revoke/absent-period ABA/no ownership reassignment`);
  }finally{await f.close();}
}
async function erasure(make,{reverse=false,confirmFirst=false}={}) {
  const f=await harness(make),old=process.env.WEB_PUSH_SETUP_RATE_SECRET;process.env.WEB_PUSH_SETUP_RATE_SECRET=rateSecret;
  try {
    const original=reverse?'b':'a',successor=reverse?'a':'b';
    const a=input(sub()),ca=await f.service.execute('create',a,context(original));await f.service.execute('confirm',confirm(a,ca,f.sent[0].payload.setup.secret),context(original));
    const b=input(a.subscription),cb=await f.service.execute('create',b,context(successor)),pending=confirm(b,cb,f.sent.at(-1).payload.setup.secret);
    let accepted;if(confirmFirst)accepted=await f.service.execute('confirm',pending,context(successor));
    const foreign=plain(await f.db.get('SELECT * FROM web_push_challenges WHERE id=?',[cb.challengeId]));
    await f.database.withOwnerMutation(original,async tx=>{await neutralizeOwnedWebPushAuthority(tx,original);await tx.run('DELETE FROM users WHERE id=?',[original]);await erasePushSetupUserRate(tx,original);});
    assert.deepEqual(plain(await f.db.get('SELECT * FROM web_push_challenges WHERE id=?',[cb.challengeId])),foreign);
    const claim=await f.db.get('SELECT * FROM web_push_claims');
    if(confirmFirst){assert.equal((await f.service.execute('confirm',pending,context(successor))).generation,accepted.generation);assert.equal(claim.subscription_id,accepted.targetId);}
    else {await assert.rejects(()=>f.service.execute('confirm',pending,context(successor)),{code:'CLAIM_CHANGED'});assert.equal(claim.state,'VACANT');for(const k of ['subscription_id','proof_hash','last_operation_id','confirm_hash'])assert.equal(claim[k],null);}
    console.log(`PASS ${f.dialect} real D2a erase ${original}→${successor} ${confirmFirst?'confirm-first':'erase-first'}/USER HMAC last/foreign retention`);
  }finally{await f.close();if(old===undefined)delete process.env.WEB_PUSH_SETUP_RATE_SECRET;else process.env.WEB_PUSH_SETUP_RATE_SECRET=old;}
}
async function independentPG() {
  const f=await harness(schema.postgres);const other=createWorkerDatabase({pool:f.pool});
  try {
    const p=input(sub()),c=await f.service.execute('create',p,context()),confirmation=confirm(p,c,f.sent[0].payload.setup.secret);
    const results=await Promise.all([f.service.execute('confirm',confirmation,context()),service(other).execute('confirm',confirmation,context())]);
    assert.equal(results[0].generation,results[1].generation);assert.equal(Number((await f.db.get('SELECT claim_revision FROM web_push_claims')).claim_revision),1);
    const second=input(sub(p.subscription.endpoint)),created=await f.service.execute('create',second,context()),proof=f.sent.at(-1).payload.setup.secret;
    const outcomes=await Promise.allSettled([f.service.execute('confirm',confirm(second,created,proof),context()),service(other).execute('confirm',confirm(second,created,proof),context())]);
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);assert.equal(outcomes.filter(x=>x.status==='rejected'&&x.reason.code==='CLAIM_CHANGED').length,1);
    assert.equal(Number((await f.db.get('SELECT claim_revision FROM web_push_claims')).claim_revision),2);
    // Actual independent owner UPDATE blocks setup, bounded at 150ms; no IO.
    const held=await f.pool.connect();await held.query('BEGIN');await held.query("SELECT id FROM users WHERE id='a' FOR UPDATE");
    const started=Date.now();try {await assert.rejects(()=>service(other).execute('status',common(second),context()),e=>e.code==='55P03');assert(Date.now()-started<1500);}
    finally{await held.query('ROLLBACK');held.release();}
    const controller=new AbortController();controller.abort();await assert.rejects(()=>service(other).execute('status',common(second),{...context(),signal:controller.signal}),{code:'STRAVA_WORKER_DB_UNAVAILABLE'});
    await other.close();assert.equal((await f.pool.query('SELECT 1 AS alive')).rows[0].alive,1);
    console.log('PASS postgres independent-client exact replay/conflicting confirm/real owner lock timeout/preabort/borrowed pool isolation');
  }finally{await other.close();await f.close();}
}
async function predecessorChange() {
  const f=await harness(schema.postgres);await f.db.run("INSERT INTO users(id,name,email,password_hash) VALUES('c','Synthetic','c@example.invalid','synthetic')");
  const raw=createWorkerDatabase({pool:f.pool});
  try {
    const a=input(sub()),ca=await f.service.execute('create',a,context());await f.service.execute('confirm',confirm(a,ca,f.sent[0].payload.setup.secret),context());
    const b=input(a.subscription),cb=await f.service.execute('create',b,context('b')),bProof=f.sent.at(-1).payload.setup.secret;
    const c=input(a.subscription),cc=await f.service.execute('create',c,context('c')),cProof=f.sent.at(-1).payload.setup.secret;
    const discovered=deferred(),release=deferred();let calls=0;
    const wrapped={...raw,transaction:async(fn,options)=>{if(++calls===2){discovered.resolve();await release.promise;}return raw.transaction(fn,options);}};
    const loser=service(wrapped).execute('confirm',confirm(b,cb,bProof),context('b'));
    await discovered.promise;const winner=await f.service.execute('confirm',confirm(c,cc,cProof),context('c'));release.resolve();
    await assert.rejects(()=>loser,{code:'CLAIM_CHANGED'});
    assert.equal((await f.db.get('SELECT subscription_id FROM web_push_claims')).subscription_id,winner.targetId);
    console.log('PASS postgres changed advisory predecessor immediate conflict, no late owner lock or implicit retry');
  }finally{await raw.close();await f.close();}
}
async function unknownCommit() {
  for(const stage of ['create','confirm']) {
    const f=await harness(schema.postgres);let bounded;
    try {
      const p=input(sub());let callBody=p;
      if(stage==='confirm'){const c=await f.service.execute('create',p,context());callBody=confirm(p,c,f.sent.at(-1).payload.setup.secret);}
      let uncertain=false;
      const pool={connect:async()=>{const c=await f.pool.connect();let affected=false;return {on:c.on.bind(c),removeListener:c.removeListener.bind(c),release:x=>c.release(x),query:async(sql,params)=>{
        if((stage==='create'&&sql.startsWith('INSERT INTO web_push_challenges'))||(stage==='confirm'&&sql.startsWith("UPDATE web_push_claims SET incarnation=")))affected=true;
        const result=await c.query(sql,params);if(sql==='COMMIT'&&affected&&!uncertain){uncertain=true;throw new Error('synthetic lost commit response');}return result;
      }};}};
      bounded=createWorkerDatabase({pool});let sends=0;
      await assert.rejects(()=>service(bounded,async()=>{sends++;}).execute(stage,callBody,context()),{code:'STRAVA_WORKER_COMMIT_UNCERTAIN'});
      assert(uncertain);assert.equal(sends,0);
      const status=await f.service.execute('status',common(p),context());assert.equal(status.state,stage==='create'?'RESERVED':'CONFIRMED');
      if(stage==='create'){await f.service.execute('create',p,context());assert.equal(f.sent.length,0,'lost create response never recovers send authority');}
      assert.equal((await f.pool.query('SELECT 1 AS alive')).rows[0].alive,1);
      console.log(`PASS postgres actual ${stage} COMMIT with lost reply: explicit unknown, no IO/false success, durable status only`);
    }finally{if(bounded)await bounded.close();await f.close();}
  }
}
async function crashChild() {
  const url=new URL(process.env.FORGE_SETUP_CHILD_DB);assert.equal(url.hostname,'127.0.0.1');assert.equal(url.port,'55449');assert.equal(url.username,'forge_background_test');assert.match(url.pathname,/^\/forge_d2_authority_[a-f0-9]{16}$/);
  const {Pool}=require('pg'),pool=new Pool({connectionString:url.href});
  const wrapped={connect:async()=>{const c=await pool.connect();let write=false,attempted=false;return {on:c.on.bind(c),removeListener:c.removeListener.bind(c),release:x=>c.release(x),query:async(sql,p)=>{
    if(sql.startsWith('INSERT INTO web_push_challenges'))write=true;
    if(sql.startsWith("UPDATE web_push_setup_operations SET send_state='ATTEMPTED'"))attempted=true;
    if(sql==='COMMIT'&&write&&process.env.FORGE_SETUP_DEATH==='before')process.kill(process.pid,'SIGKILL');
    const result=await c.query(sql,p);
    if(sql==='COMMIT'&&write&&process.env.FORGE_SETUP_DEATH==='after')process.kill(process.pid,'SIGKILL');
    if(sql==='COMMIT'&&attempted&&process.env.FORGE_SETUP_DEATH==='attempted')process.kill(process.pid,'SIGKILL');
    return result;
  }};}};
  const db=createWorkerDatabase({pool:wrapped});
  try{await service(db,async()=>{process.send?.({unexpectedSend:true});}).execute('create',JSON.parse(process.env.FORGE_SETUP_CHILD_INPUT),context());throw new Error('Crash boundary missed');}
  finally{await db.close();await pool.end();}
}
async function processDeath() {
  const {spawn}=require('node:child_process');
  for(const stage of ['before','after','attempted']) {
    const f=await harness(schema.postgres);try {
      const p=input(sub());const issued=await f.service.execute('issue-create',p,context());Object.assign(p,{operationId:issued.operationId,createAdmission:issued.createAdmission});let sends=0;
      const child=spawn(process.execPath,[__filename,'--crash-child'],{env:{...process.env,FORGE_SETUP_CHILD_DB:f.pool.options.connectionString,FORGE_SETUP_CHILD_INPUT:JSON.stringify(p),FORGE_SETUP_DEATH:stage},stdio:['ignore','pipe','pipe','ipc']});
      let errors='';child.stderr.on('data',chunk=>errors+=chunk);child.on('message',()=>sends++);
      const result=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
      assert.equal(result.signal,'SIGKILL',errors);assert.equal(sends,0);
      const rows=await f.db.all('SELECT * FROM web_push_challenges');assert.equal(rows.length,stage==='before'?0:1);
      if(stage!=='before'){assert.equal((await f.service.execute('status',common(p),context())).state,stage==='after'?'RESERVED':'UNKNOWN');await f.service.execute('create',p,context());assert.equal(f.sent.length,0);}
      else {await f.service.execute('create',p,context());assert.equal(f.sent.length,1,'known noncommit can explicitly retry the still-live ticket once');}
      console.log(`PASS postgres actual process death ${stage} durable create COMMIT, no resend/activation`);
    }finally{await f.close();}
  }
}
async function eraseRace(reverse,confirmWins) {
  const f=await harness(schema.postgres),other=createWorkerDatabase({pool:f.pool}),entered=deferred(),release=deferred();
  const original=reverse?'b':'a',successor=reverse?'a':'b',old=process.env.WEB_PUSH_SETUP_RATE_SECRET;process.env.WEB_PUSH_SETUP_RATE_SECRET=rateSecret;
  let bounded,one,two;
  try {
    const p=input(sub()),first=await f.service.execute('create',p,context(original));await f.service.execute('confirm',confirm(p,first,f.sent[0].payload.setup.secret),context(original));
    const q=input(p.subscription),second=await f.service.execute('create',q,context(successor)),proof=confirm(q,second,f.sent.at(-1).payload.setup.secret);
    const foreign=plain(await f.db.get('SELECT * FROM web_push_challenges WHERE id=?',[second.challengeId]));
    let waited=false;
    const pool={connect:async()=>{const c=await f.pool.connect();return {on:c.on.bind(c),removeListener:c.removeListener.bind(c),release:x=>c.release(x),query:async(s,p)=>{
      const result=await c.query(s,p);if(s.startsWith('SELECT id FROM users WHERE id')&&!waited){waited=true;entered.resolve();await release.promise;}return result;
    }};}};
    bounded=createWorkerDatabase({pool});
    const erase=db=>db.withOwnerMutation(original,async tx=>{await neutralizeOwnedWebPushAuthority(tx,original);await tx.run('DELETE FROM users WHERE id=?',[original]);await erasePushSetupUserRate(tx,original);});
    one=confirmWins?service(bounded).execute('confirm',proof,context(successor)):erase(bounded);await entered.promise;
    two=confirmWins?erase(other):service(other).execute('confirm',proof,context(successor));
    const outcome=confirmWins?two:assert.rejects(()=>two,{code:'CLAIM_CHANGED'});
    await new Promise(r=>setTimeout(r,20));release.resolve();const result=await one;await outcome;
    const current=await f.db.get('SELECT * FROM web_push_claims');
    if(confirmWins){assert.equal(current.subscription_id,result.targetId);assert.equal((await f.service.execute('status',common(q),context(successor))).state,'CONFIRMED');}
    else {assert.equal(current.state,'VACANT');assert.deepEqual(plain(await f.db.get('SELECT * FROM web_push_challenges WHERE id=?',[second.challengeId])),foreign);}
    assert.equal(await f.db.get('SELECT id FROM users WHERE id=?',[original]),undefined);
    console.log(`PASS postgres concurrent transfer/real erase ${original}→${successor} ${confirmWins?'confirm':'erase'} wins, no late owner lock/successor deletion`);
  }finally{release.resolve();await Promise.allSettled([one,two]);if(bounded)await bounded.close();await other.close();await f.close();if(old===undefined)delete process.env.WEB_PUSH_SETUP_RATE_SECRET;else process.env.WEB_PUSH_SETUP_RATE_SECRET=old;}
}
async function legacyRace(status,confirmWins) {
  const f=await harness(schema.postgres),entered=deferred(),release=deferred();let delivery;
  try {
    const dbPath=require.resolve('../src/db'),prior=require.cache[dbPath];require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:{}};
    let createLegacyPushSender;try{({createLegacyPushSender}=require('../src/services/push'));}finally{if(prior)require.cache[dbPath]=prior;else delete require.cache[dbPath];}
    const {createWebPushTransport}=require('../src/services/webPushTransport'),{EventEmitter}=require('node:events'),webpush=require('web-push');
    const p=input(sub()),first=await f.service.execute('create',p,context());await f.service.execute('confirm',confirm(p,first,f.sent[0].payload.setup.secret),context());
    const q=input(sub(p.subscription.endpoint)),second=await f.service.execute('create',q,context()),proof=confirm(q,second,f.sent.at(-1).payload.setup.secret);
    const transport=createWebPushTransport({resolverFactory:()=>({resolve4(_h,cb){queueMicrotask(()=>cb(null,['8.8.8.8']));},resolve6(_h,cb){queueMicrotask(()=>cb(null,[]));},cancel(){}}),
      request:(_o,callback)=>{const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{entered.resolve();release.promise.then(()=>{const res=new EventEmitter();res.statusCode=status;res.destroy=()=>{};callback(res);res.emit('end');});};return req;}});
    const sender=createLegacyPushSender({all:f.db.all.bind(f.db),get:f.db.get.bind(f.db),run:f.db.run.bind(f.db),send:transport,vapidDetails:{...webpush.generateVAPIDKeys(),subject:'mailto:synthetic@example.invalid'},log:()=>{}});
    delivery=sender('a');await entered.promise;
    if(confirmWins){const result=await f.service.execute('confirm',proof,context());const row=plain(await f.db.get('SELECT * FROM push_subscriptions WHERE id=?',[result.targetId]));release.resolve();await delivery;assert.deepEqual(plain(await f.db.get('SELECT * FROM push_subscriptions WHERE id=?',[result.targetId])),row);}
    else {release.resolve();await delivery;await assert.rejects(()=>f.service.execute('confirm',proof,context()),{code:'CLAIM_CHANGED'});assert.equal(Boolean((await f.db.get('SELECT active FROM push_subscriptions')).active),false);}
    console.log(`PASS postgres actual branded D1 ${status}/changed-key confirm ${confirmWins?'confirm':'deactivation'} wins, exact successor preserved`);
  }finally{release.resolve();await Promise.allSettled([delivery]);await f.close();}
}
async function activeLimit() {
  const f=await harness(schema.postgres),second=createWorkerDatabase({pool:f.pool}),third=createWorkerDatabase({pool:f.pool});
  const entered=deferred(),release=deferred();let sends=0;
  const held=async(_s,_p,o)=>{assert.equal(await o.beforeSend(),true);if(++sends===2)entered.resolve();await release.promise;return {statusCode:201};};
  let one,two;
  try {
    await f.db.run("INSERT INTO users(id,name,email,password_hash) VALUES('c','Synthetic','c@example.invalid','synthetic')");
    const p=input(sub('https://fcm.googleapis.com/a')),q=input(sub('https://fcm.googleapis.com/b'));
    one=service(f.database,held).execute('create',p,context());two=service(second,held).execute('create',q,context('b'));
    await entered.promise;
    const before=plain(await f.db.all('SELECT * FROM web_push_setup_rate_buckets ORDER BY dimension,key_hash'));
    await assert.rejects(()=>service(third,held).execute('create',input(sub('https://fcm.googleapis.com/c')),context('c')),{code:'SETUP_UNAVAILABLE'});
    assert.deepEqual(plain(await f.db.all('SELECT * FROM web_push_setup_rate_buckets ORDER BY dimension,key_hash')),before);
    const replay=await service(third,held).execute('create',p,context());assert.equal(replay.state,'UNKNOWN');assert.equal(sends,2);
    release.resolve();await Promise.all([one,two]);assert.equal(sends,2);
    console.log('PASS postgres max two postcommit sends/no queue/third rollback/exact replay during occupied capacity');
  }finally{release.resolve();await Promise.allSettled([one,two]);await second.close();await third.close();await f.close();}
}
async function boundedFaults() {
  for(const mode of ['acquisition','statement','idle','whole','abort']) {
    const f=await harness(schema.postgres);let bounded,held,ownedPool,releaseWait;const queries=[];
    try {
      const p=input(sub()),c=await f.service.execute('create',p,context());
      const controller=new AbortController();let fired=false;
      let source=f.pool;
      if(mode==='acquisition') {const {Pool}=require('pg');ownedPool=new Pool({...f.pool.options,max:1});source=ownedPool;held=await source.connect();}
      const pool={connect:async()=>{const client=await source.connect();return {on:client.on.bind(client),removeListener:client.removeListener.bind(client),release:x=>client.release(x),query:async(sql,params)=>{
        queries.push(sql);
        if(sql.startsWith('SELECT id FROM users WHERE id IN')&&!fired){fired=true;
          if(mode==='statement')await client.query('SELECT pg_sleep(1.2)');
          if(mode==='idle')await new Promise(r=>setTimeout(r,1200));
          if(mode==='whole')for(let i=0;i<8;i++)await client.query('SELECT pg_sleep(0.7)');
          if(mode==='abort'){controller.abort();await new Promise(r=>{releaseWait=r;setTimeout(r,25);});}
        }
        return client.query(sql,params);
      }};}};
      bounded=createWorkerDatabase({pool});const before=plain(await f.db.all('SELECT * FROM web_push_setup_operations'));
      const started=Date.now();await assert.rejects(()=>service(bounded).execute('cancel',common(p),{...context(),signal:controller.signal}));
      assert(Date.now()-started<6500,mode+' finite bound');
      await new Promise(r=>setTimeout(r,50));
      assert.deepEqual(plain(await f.db.all('SELECT * FROM web_push_setup_operations')),before,mode+' no late mutation/COMMIT');
      assert.equal((await f.pool.query('SELECT 1 AS alive')).rows[0].alive,1);
      console.log('PASS postgres actual borrowed setup '+mode+' bound/cancellation/no late mutation/shared pool usable');
    }finally{releaseWait?.();held?.release();if(bounded)await bounded.close();if(ownedPool)await ownedPool.end();await f.close();}
  }
}
async function cancelAndLocks() {
  const f=await harness(schema.postgres),queries=[];let bounded;
  try {
    const wrapped={connect:async()=>{const c=await f.pool.connect();return {on:c.on.bind(c),removeListener:c.removeListener.bind(c),release:x=>c.release(x),query:async(s,p)=>{queries.push({s,p});return c.query(s,p);}};}};
    bounded=createWorkerDatabase({pool:wrapped});const sent=[];
    const svc=service(bounded,async(_s,p,o)=>{assert.equal(await o.beforeSend(),true);sent.push(JSON.parse(p));return {statusCode:201};});
    const p=input(sub()),first=await svc.execute('create',p,context());
    const next=input(p.subscription),second=await svc.execute('create',next,context());
    await assert.rejects(()=>svc.execute('confirm',confirm(p,first,sent[0].setup.secret),context()),{code:'CLAIM_CHANGED'});
    const status=await svc.execute('status',common(p),context());assert.equal(status.state,'CANCELLED');
    assert.equal(Number((await f.db.get("SELECT used_count FROM web_push_setup_rate_buckets WHERE dimension='GLOBAL'")).used_count),2);
    let transaction=[];
    for(const q of queries) {
      if(q.s==='BEGIN')transaction=[];
      else if(q.s==='COMMIT'||q.s==='ROLLBACK') {
        const app=transaction.filter(x=>!x.s.startsWith('SET LOCAL'));
        if(app.some(x=>x.s.startsWith('INSERT INTO web_push_challenges'))) {
          assert.match(app[0].s,/^SELECT id FROM users WHERE id IN .* ORDER BY id FOR UPDATE$/);
          assert.deepEqual(app[0].p,[...app[0].p].sort());
          const firstQuota=app.findIndex(x=>x.s.startsWith('INSERT INTO web_push_setup_rate_buckets'));
          assert(firstQuota>0);assert(app.slice(firstQuota).every(x=>x.s.includes('web_push_setup_rate_buckets')));
          assert.deepEqual(app.slice(firstQuota).filter(x=>x.s.startsWith('INSERT')).map(x=>x.p[0]),['GLOBAL','USER','ENDPOINT','IP']);
        }
      } else transaction.push(q);
    }
    const forged={...bounded,transaction:(fn,options)=>bounded.transaction(tx=>fn({...tx}),options)};
    await assert.rejects(()=>service(forged).execute('create',input(sub()),context()),{code:'STRAVA_WORKER_TRANSACTION_REQUIRED'});
    assert.equal(Number((await f.db.get('SELECT count(*) AS n FROM web_push_challenges')).n),2);
    await svc.execute('cancel',common(next),context());await assert.rejects(()=>svc.execute('confirm',confirm(next,second,sent[1].setup.secret),context()),{code:'CLAIM_CHANGED'});
    console.log('PASS postgres new operation cancellation/exact quota/first application complete owner set/private tx brand/children then G-U-E-IP last');
  }finally{if(bounded)await bounded.close();await f.close();}
}
async function revokeRace(confirmWins) {
  const f=await harness(schema.postgres),other=createWorkerDatabase({pool:f.pool}),entered=deferred(),release=deferred();let bounded,one,two;
  try {
    const p=input(sub()),first=await f.service.execute('create',p,context()),possession=crypto.randomBytes(32);
    const active=await f.service.execute('confirm',{...confirm(p,first,f.sent[0].payload.setup.secret),nextPossessionProofHash:crypto.createHash('sha256').update(possession).digest('hex')},context());
    const next=input(p.subscription),second=await f.service.execute('create',next,context());
    const confirmation=confirm(next,second,f.sent.at(-1).payload.setup.secret);
    const revoke={...common(p),subscription:p.subscription,targetId:active.targetId,generation:active.generation,incarnation:active.incarnation,revision:active.revision,possessionProof:possession.toString('base64url')};
    let waited=false;
    const pool={connect:async()=>{const c=await f.pool.connect();return {on:c.on.bind(c),removeListener:c.removeListener.bind(c),release:x=>c.release(x),query:async(sql,params)=>{
      const result=await c.query(sql,params);if(sql.startsWith('SELECT id FROM users WHERE id IN')&&!waited){waited=true;entered.resolve();await release.promise;}return result;
    }};}};
    bounded=createWorkerDatabase({pool});
    one=service(bounded).execute(confirmWins?'confirm':'revoke',confirmWins?confirmation:revoke,context());
    await entered.promise;
    two=service(other).execute(confirmWins?'revoke':'confirm',confirmWins?revoke:confirmation,context());
    const loser=assert.rejects(()=>two,{code:'CLAIM_CHANGED'});
    await new Promise(r=>setTimeout(r,20));release.resolve();assert.equal((await one).state,confirmWins?'CONFIRMED':'REVOKED');await loser;
    console.log('PASS postgres independent revoke/confirm race '+(confirmWins?'confirm wins':'revoke wins'));
  }finally{release.resolve();await Promise.allSettled([one,two]);if(bounded)await bounded.close();await other.close();await f.close();}
}
async function sharedQuota() {
  const f=await harness(schema.postgres),other=createWorkerDatabase({pool:f.pool});try {
    const p=input(sub());await f.service.execute('create',p,context());
    await f.db.run("UPDATE web_push_setup_rate_buckets SET used_count=2 WHERE dimension='ENDPOINT'");
    const before=Number((await f.db.get("SELECT used_count FROM web_push_setup_rate_buckets WHERE dimension='GLOBAL'")).used_count);
    const result=await Promise.allSettled([f.service.execute('create',input(p.subscription),context()),service(other).execute('create',input(p.subscription),context('b'))]);
    assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.filter(r=>r.status==='rejected'&&r.reason.code==='SETUP_RATE_LIMITED').length,1);
    assert.equal(Number((await f.db.get("SELECT used_count FROM web_push_setup_rate_buckets WHERE dimension='ENDPOINT'")).used_count),3);
    assert.equal(Number((await f.db.get("SELECT used_count FROM web_push_setup_rate_buckets WHERE dimension='GLOBAL'")).used_count),before+1);
    console.log('PASS postgres independent clients share endpoint cap3 and rollback loser GLOBAL charge');
  }finally{await other.close();await f.close();}
}
async function admissionRaces() {
  for(const mode of ['same-ticket','lock-expiry','retained-disappears']) {
    const f=await harness(schema.postgres);let bounded,held;
    try {
      const p=input(sub()),ticket=await f.rawService.execute('issue-create',p,context());Object.assign(p,{operationId:ticket.operationId,createAdmission:ticket.createAdmission});
      if(mode==='retained-disappears')await f.rawService.execute('create',p,context());
      const baseline=Number((await f.db.get('SELECT count(*) AS n FROM web_push_setup_rate_buckets')).n);
      let removed=false,sendCount=0;
      const pool={connect:async()=>{const c=await f.pool.connect();return {on:c.on.bind(c),removeListener:c.removeListener.bind(c),release:x=>c.release(x),query:async(s,params)=>{
        if(mode!=='same-ticket'&&s.startsWith('SELECT floor(extract(epoch FROM clock_timestamp())'))return c.query("SELECT floor(extract(epoch FROM (clock_timestamp()+($1*interval '1 millisecond')))*1000)::bigint AS ms",[mode==='lock-expiry'?119950:120001]);
        const result=await c.query(s,params);
        if(mode==='retained-disappears'&&s.startsWith('SELECT c.id FROM web_push_challenges c JOIN')&&!removed) {
          removed=true;await f.db.run('DELETE FROM web_push_challenges WHERE operation_id=?',[p.operationId]);
        }
        return result;
      }};}};
      bounded=createWorkerDatabase({pool});const svc=service(bounded,async()=>{sendCount++;return {statusCode:201};});
      if(mode==='same-ticket') {
        const results=await Promise.all([f.rawService.execute('create',p,context()),svc.execute('create',p,context())]);
        assert.equal(results[0].challengeId,results[1].challengeId);assert.equal(sendCount+f.sent.length,1);
        assert.equal(Number((await f.db.get('SELECT count(*) AS n FROM web_push_challenges')).n),1);
        assert.equal(Number((await f.db.get("SELECT used_count FROM web_push_setup_rate_buckets WHERE dimension='GLOBAL'")).used_count),1);
      } else {
        if(mode==='lock-expiry'){held=await f.pool.connect();await held.query('BEGIN');await held.query("SELECT id FROM users WHERE id='a' FOR UPDATE");}
        const attempt=svc.execute('create',p,context()),rejected=assert.rejects(()=>attempt,{code:'SETUP_EXPIRED'});
        if(held){await new Promise(r=>setTimeout(r,90));await held.query('ROLLBACK');held.release();held=null;}
        await rejected;assert.equal(sendCount,0);assert.equal(Number((await f.db.get('SELECT count(*) AS n FROM web_push_setup_rate_buckets')).n),baseline);
        if(mode==='lock-expiry'){assert.equal(Number((await f.db.get('SELECT count(*) AS n FROM web_push_claims')).n),0);assert.equal(Number((await f.db.get('SELECT count(*) AS n FROM push_subscriptions')).n),0);}
      }
      console.log('PASS postgres admission '+mode+' durable precedence/expiry-before-mutation/one-send');
    } finally {if(held){await held.query('ROLLBACK');held.release();}if(bounded)await bounded.close();await f.close();}
  }
}
async function main() {
  await takeover(schema.sqlite);await erasure(schema.sqlite);
  if(process.argv.includes('--postgres')){await takeover(schema.postgres);for(const reverse of [false,true])for(const confirmFirst of [false,true])await erasure(schema.postgres,{reverse,confirmFirst});await independentPG();await predecessorChange();await unknownCommit();await processDeath();await activeLimit();await boundedFaults();await cancelAndLocks();await revokeRace(false);await revokeRace(true);await sharedQuota();await admissionRaces();for(const reverse of [false,true])for(const wins of [false,true])await eraseRace(reverse,wins);for(const status of [404,410])for(const wins of [false,true])await legacyRace(status,wins);}
  console.log('WEB PUSH SETUP CONCURRENCY SMOKE OK');
}
if(require.main===module)(process.argv.includes('--crash-child')?crashChild():main()).catch(e=>{console.error(e);process.exitCode=1;});
module.exports={main};
