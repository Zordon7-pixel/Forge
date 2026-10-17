'use strict';
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const express=require('express'),jwt=require('jsonwebtoken');
const {createPushSetupRouter}=require('../src/routes/pushSetup');
const {createWorkerDatabase}=require('../src/db/backgroundSyncWorker');
const {createWebPushSetup}=require('../src/services/webPushSetup');
const {harness,sub,input,rateSecret,confirm}=require('./webPushSetup.smoke');
const schema=require('./webPushAuthoritySchema.smoke');

async function mounted(make) {
  const f=await harness(make),oldJWT=process.env.JWT_SECRET;process.env.JWT_SECRET='synthetic-setup-route-jwt';
  let server,created=0,closed=0,corsHits=0,missingPool=false,legacyWrites=0;const applications=[];
  const options={origin:'http://127.0.0.1',production:false,getPool:()=>missingPool?null:(f.pool||{connect(){throw new Error('SQLite fixture must not use PG');}}),
    databaseFactory:()=>{created++;const db=createWorkerDatabase(f.native?{sqlite:f.native}:{pool:f.pool});return {...db,close:async()=>{closed++;await db.close();}};},
    serviceFactory:({database})=>createWebPushSetup({database,rateSecret,vapidDetails:{publicKey:'synthetic',privateKey:'synthetic',subject:'mailto:synthetic@example.invalid'},
      send:async(s,p,o)=>{if(f.native)assert.equal(f.native.isTransaction,false);assert.equal(await o.beforeSend(),true);f.sent.push(JSON.parse(p));return {statusCode:201};}})};
  // Execute the actual application mount ordering, not a source-string-only
  // substitute. Ordinary unrelated routers/startup DB are inert local seams.
  const appSource=fs.readFileSync(path.join(__dirname,'../src/app.js'),'utf8');
  const processStub={env:{JWT_SECRET:process.env.JWT_SECRET},once(){},exit(){throw new Error('Unexpected startup');}};
  const actualRequire=require;
  const scopedRequire=name=>{
    if(name==='express')return Object.assign(()=>{const app=express();applications.push(app);return app;},express);
    if(name==='./routes/pushSetup')return {createPushSetupRouter:()=>createPushSetupRouter(options)};
    if(name==='./db')return {initDb:()=>new Promise(()=>{})};
    if(name==='./lib/betaPlanRollout')return {getGoalBackwardV24Audience:()=>'',getGoalBackwardV24Mode:()=>''};
    if(name==='./lib/stravaWebhook')return {mountStravaWebhookParser:()=>{}};
    if(name==='cors')return ()=>{return (_req,res,next)=>{corsHits++;res.set('Access-Control-Allow-Origin','*');next();};};
    if(name==='./routes/notifications') {
      const module={exports:{}};
      vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/routes/notifications.js'),'utf8'),{module,console,require:key=>{
        if(key==='express')return express;
        if(key==='../middleware/auth')return (req,_res,next)=>{req.user={id:'a'};next();};
        if(key==='../db')return {dbRun:()=>{legacyWrites++;throw new Error('Legacy write forbidden');},dbAll:async()=>[]};
        if(key==='../services/push')return {isConfigured:()=>true,getPublicKey:()=>null};
        if(key==='../services/notifications')return {notificationSourceFromKey:()=>null};
        throw new Error('Unexpected legacy dependency');
      }});return module.exports;
    }
    if(name.startsWith('./routes/'))return express.Router();
    if(name.startsWith('./'))return actualRequire(path.join(__dirname,'../src',name));
    return actualRequire(name);
  };
  try {
    vm.runInNewContext(appSource,{require:scopedRequire,__dirname:path.join(__dirname,'../src'),process:processStub,console,setTimeout,clearTimeout,Set,Promise});
    const app=applications[0];assert(app);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
    const token=jwt.sign({id:'a'},process.env.JWT_SECRET),base={'content-type':'application/json',host:'127.0.0.1',origin:'http://127.0.0.1',authorization:'Bearer '+token};
    const request=(action,body,headers={},method='POST',chunks)=>new Promise((resolve,reject)=>{
      const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/push-setup/v1/'+action,method,agent:false,headers:{...base,...headers}},res=>{
        let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text,json:JSON.parse(text)}));
      });req.on('error',reject);if(chunks){for(const c of chunks)req.write(c);req.end();}else req.end(typeof body==='string'?body:JSON.stringify(body));
    });
    const p=input(sub());
    const issuance=await request('issue-create',p);assert.equal(issuance.status,200,issuance.text);
    assert.equal(Number((await f.db.get('SELECT count(*) AS n FROM web_push_challenges')).n),0);assert.equal(f.sent.length,0);
    Object.assign(p,{operationId:issuance.json.operationId,createAdmission:issuance.json.createAdmission});
    const good=await request('create',p);assert.equal(good.status,200,good.text);assert.equal(f.sent.length,1);assert.equal(good.headers['cache-control'],'no-store');assert.equal(good.headers['access-control-allow-origin'],undefined);
    const before=Number((await f.db.get('SELECT count(*) AS n FROM web_push_challenges')).n);
    const cases=[
      ['create',p,{origin:''},'POST',403],['create',p,{origin:'null'},'POST',403],['create',p,{origin:'https://foreign.invalid'},'POST',403],
      ['create',p,{host:'evil.invalid','x-forwarded-host':'127.0.0.1'},'POST',403],
      ['create',p,{},'OPTIONS',405],['create',p,{},'GET',405],['create',p,{},'PUT',405],['create',p,{},'DELETE',405],['absent',p,{},'POST',405],
      ['create','{',{},'POST',400],['create','[]',{},'POST',400],['create','"scalar"',{},'POST',400],
      ['create',p,{'content-type':'text/plain'},'POST',415],['create',p,{'content-encoding':'gzip'},'POST',415],
      ['create',p,{'content-length':'8193'},'POST',413],['create',p,{authorization:''},'POST',401],['create',p,{authorization:'Bearer bad'},'POST',401],
    ];
    const issueBody=input(sub());
    const issueCases=cases.filter(c=>c[0]==='create').map(([,body,headers,method,status])=>['issue-create',typeof body==='string'?body:issueBody,headers,method,status]);
    for(const [action,body,headers,method,status] of [...cases,...issueCases]) {
      const r=await request(action,body,headers,method);assert.equal(r.status,status,r.text);assert.equal(r.headers['cache-control'],'no-store');assert.equal(r.headers['access-control-allow-origin'],undefined);assert(Buffer.byteLength(r.text)<=2048);assert(!r.text.includes(token));
    }
    const raw=JSON.stringify(p),padded=raw+' '.repeat(8192-Buffer.byteLength(raw));
    assert.equal((await request('create',padded)).status,200,'exact 8192 byte valid replay');
    assert.equal((await request('create',null,{},'POST',[padded,' '])).status,413,'chunked byte 8193 rejected');
    const issueRaw=JSON.stringify(issueBody),issuePadded=issueRaw+' '.repeat(8192-Buffer.byteLength(issueRaw));
    const exactIssue=await request('issue-create',issuePadded);assert.equal(exactIssue.status,200,exactIssue.text);assert(Buffer.byteLength(exactIssue.text)<=2048);
    assert.equal((await request('issue-create',null,{},'POST',[issuePadded,' '])).status,413);
    for(const extra of [{operationId:p.operationId},{owner:'a'},{ttl:300},{issuedAt:1},{expiresAt:1},{httpOptions:{}}])assert.equal((await request('issue-create',{...issueBody,...extra})).status,400);
    const spoof=await request('issue-create',issueBody,{'x-forwarded-for':'10.0.0.1','x-forwarded-host':'evil.invalid'});assert.equal(spoof.status,200,'forwarded headers never replace exact Origin/raw Host/socket authority');
    missingPool=true;const unavailable=await request('issue-create',issueBody);missingPool=false;assert.equal(unavailable.status,503);assert.deepEqual(unavailable.json,{error:'SETUP_UNAVAILABLE'});
    assert.equal(Number((await f.db.get('SELECT count(*) AS n FROM web_push_challenges')).n),before);assert.equal(f.sent.length,1);assert.equal(corsHits,0);
    const removed=await request('status',{protocol:p.protocol,operationId:p.operationId,clientNonce:p.clientNonce,authEpoch:p.authEpoch},{authorization:'Bearer '+jwt.sign({id:'missing'},process.env.JWT_SECRET)});
    assert.equal(removed.status,410); // No foreign operation/owner disclosure.
    assert.equal((await request('issue-create',issueBody,{authorization:'Bearer '+jwt.sign({id:'missing'},process.env.JWT_SECRET)})).status,401);
    if(f.pool) {
      const body=input(sub()),issued=await request('issue-create',body);Object.assign(body,{operationId:issued.json.operationId,createAdmission:issued.json.createAdmission});
      const holder=await f.pool.connect();await holder.query('BEGIN');await holder.query("SELECT id FROM users WHERE id='a' FOR UPDATE");
      try {
        const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/push-setup/v1/create',method:'POST',agent:false,headers:base});
        const ended=new Promise(resolve=>{req.on('error',resolve);req.on('close',resolve);});req.end(JSON.stringify(body));
        await new Promise(r=>setTimeout(r,40));req.destroy();await ended;
        await new Promise(r=>setTimeout(r,200));
      } finally {await holder.query('ROLLBACK');holder.release();}
      await new Promise(r=>setTimeout(r,50));
      assert.equal(Number((await f.db.get('SELECT count(*) AS n FROM web_push_challenges')).n),before,'response-close abort cannot commit later');assert.equal(f.sent.length,1);
    }
    assert.equal(created,closed,'every request closes only its borrowed wrapper');
    assert.equal(Number((await f.db.get('SELECT count(*) AS n FROM users')).n),2,'unrelated database remains usable');
    for(const method of ['POST','DELETE']) {
      const result=await new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:'/api/notifications/push/subscribe',method,agent:false,headers:base},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text),cache:res.headers['cache-control']}));});req.on('error',reject);req.end(JSON.stringify({endpoint:p.subscription.endpoint,keys:p.subscription.keys}));});
      assert.deepEqual(result,{status:409,body:{error:'PUSH_SETUP_REQUIRED'},cache:'no-store'});
    }
    assert.equal(legacyWrites,0,'actual legacy route has no setup/revoke bypass');
    assert.equal((await request('confirm',confirm(p,good.json,f.sent[0].setup.secret))).status,200);
    await f.db.run('UPDATE web_push_claims SET incarnation=?,claim_revision=?',[crypto.randomUUID(),9000000000000000]);
    const next=input(sub(p.subscription.endpoint)),nextIssue=await request('issue-create',next);
    Object.assign(next,{operationId:nextIssue.json.operationId,createAdmission:nextIssue.json.createAdmission});
    const nextCreated=await request('create',next);assert.equal(nextCreated.status,200,nextCreated.text);
    const snapshot=async()=>{const rows={};for(const table of ['push_subscriptions','web_push_claims','web_push_challenges','web_push_setup_operations','web_push_setup_rate_buckets'])rows[table]=await f.db.all('SELECT * FROM '+table);return JSON.stringify(rows);};
    const stable=await snapshot(),exhausted=await request('confirm',confirm(next,nextCreated.json,f.sent.at(-1).setup.secret));
    assert.equal(exhausted.status,409);assert.deepEqual(exhausted.json,{error:'REVISION_EXHAUSTED'});assert.equal(exhausted.headers['cache-control'],'no-store');assert.equal(exhausted.headers['access-control-allow-origin'],undefined);
    assert.equal(await snapshot(),stable,'actual mounted max-revision failure preserves all authority/targets/metadata/quota');assert.equal(created,closed);
    console.log(`WEB PUSH SETUP ROUTES OK ${f.dialect}: actual app early issue/create stack/no CORS/8KiB/origin/JWT/fixed errors/borrowed cleanup`);
  }finally{if(server)await new Promise(r=>server.close(r));await f.close();if(oldJWT===undefined)delete process.env.JWT_SECRET;else process.env.JWT_SECRET=oldJWT;}
}
async function main(){await mounted(schema.sqlite);if(process.argv.includes('--postgres'))await mounted(schema.postgres);}
if(require.main===module)main().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={main};
