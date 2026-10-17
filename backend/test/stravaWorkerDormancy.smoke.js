'use strict';
const assert=require('node:assert/strict'),path=require('node:path'),Module=require('node:module'),{fork}=require('node:child_process');
const {fixture,hint}=require('./stravaWorkerPrimitives.smoke');
const appPath=path.resolve(__dirname,'../src/app.js');
async function oldWriter(){
  const fs=require('node:fs'),crypto=require('node:crypto');
  const source=fs.readFileSync(path.join(__dirname,'fixtures/stravaEventIntake759a.cjs'),'utf8');
  assert.equal(crypto.createHash('sha256').update(source).digest('hex'),'f836784e1a19693e983d676363e7e1717e188e7e80a17928091c528880693bef');
  const filename=path.resolve(__dirname,'../src/services/stravaEventIntake.js'),legacy=new Module(filename,module);legacy.filename=filename;legacy.paths=Module._nodeModulePaths(path.dirname(filename));legacy._compile(source,filename);
  const f=await fixture('sqlite');
  try{
    const event={ownerId:'123',objectType:'activity',objectId:'9001',fingerprint:'a'.repeat(64),eventTime:1,aspectType:'create'};
    await f.db.transaction(tx=>legacy.exports.storeHint(tx,event));
    assert.equal((await f.tx.get("SELECT state FROM provider_event_jobs WHERE object_id='9001'")).state,'PENDING');
    assert.equal((await f.tx.all("SELECT id FROM provider_event_jobs WHERE state IN ('DONE','DEAD')")).length,0,'old intake alone has no consumer-created terminal work');
    await f.tx.run("UPDATE provider_event_jobs SET state='DONE',processed_revision=requested_revision,attempts=12,episode_started_at='2020-01-01T00:00:00Z' WHERE object_id='9001'");
    await f.db.transaction(tx=>legacy.exports.storeHint(tx,{...event,fingerprint:'b'.repeat(64),eventTime:2}));
    const row=await f.tx.get("SELECT * FROM provider_event_jobs WHERE object_id='9001'");assert.equal(row.state,'PENDING');assert.equal(Number(row.attempts),12);assert.equal(row.episode_started_at,'2020-01-01T00:00:00Z');
    console.log('PASS exact759a old-writer incompatibility reproduced; no runtime activation/refusal artifact invented');
  }finally{await f.close();}
}
async function child(mode){
  const f=await fixture('sqlite');await hint(f);if(mode==='paused')await f.tx.run("UPDATE background_sync_control SET paused=TRUE");
  if(mode==='missing')f.native.exec('DROP TABLE background_sync_control'); // deliberately damaged synthetic schema; not a permitted production deletion
  if(mode==='old')f.native.exec('ALTER TABLE provider_event_jobs DROP COLUMN episode_started_at');
  let claims=0,providers=0,closed=false;
  const original=Module._load,express=original('express',module),oldListen=express.application.listen;
  const db={initDb:async()=>{if(mode==='migration-fail')throw Error('synthetic migration rejection');},pool:{end:async()=>{closed=true;if(mode==='drain-timeout')await new Promise(()=>{});await f.close();}}};
  express.application.listen=function(...args){const server=oldListen.apply(this,args);server.once('listening',()=>process.send({ready:true,port:server.address().port,claims,providers}));return server;};
  Module._load=function(request,parent,isMain){
    if(parent?.filename===appPath){
      if(request==='dotenv')return {config:()=>{}};
      if(request==='./db')return db;
      if(request==='./db/migrate')return {runAlwaysMigrations:async()=>{}};
      if(request==='./db/seed')return {runSeed:async()=>{}};
      if(request==='./db/exercises-seed')return {seedExercises:async()=>{}};
      // This route exports a factory. Load it unchanged: construction performs
      // no database acquisition, worker creation, or provider request.
      if(request==='./routes/pushSetup')return original.apply(this,arguments);
      if(request.startsWith('./routes/'))return express.Router();
      if(request==='./services/stravaEventWorker')return {createStravaEventWorker:()=>{claims++;throw Error('production factory forbidden');}};
    }
    if(request.endsWith('/stravaEventQueue'))return {createStravaEventQueue:()=>({claim:()=>{claims++;throw Error('production claim forbidden');}})};
    if(request.endsWith('/stravaProviderClient'))return {getStravaProviderClient:()=>({request:()=>{providers++;throw Error('provider forbidden');}})};
    return original.apply(this,arguments);
  };
  process.on('exit',code=>{if(mode!=='migration-fail'){assert.equal(claims,0);assert.equal(providers,0);assert.equal(closed,true);}process.send?.({exit:code,claims,providers});});
  require(appPath);
}
async function startup(mode){
  const p=fork(__filename,['--child',mode],{execPath:process.execPath,env:{PATH:process.env.PATH,NODE_PATH:process.env.NODE_PATH,NODE_ENV:'test',JWT_SECRET:'synthetic',PORT:'0',HOST:'127.0.0.1',STRAVA_WORKER_ENABLED:'true',BACKGROUND_SYNC_ACTIVATED:'true'},stdio:['ignore','pipe','pipe','ipc']});
  let output='';p.stdout.on('data',d=>output+=d);p.stderr.on('data',d=>output+=d);const exit=new Promise(resolve=>p.once('exit',(code,signal)=>resolve({code,signal})));
  let timeout;try{
    const result=await Promise.race([new Promise(resolve=>p.once('message',resolve)),exit,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('startup timeout')),7000);})]);
    if(mode==='migration-fail'){assert.equal((await exit).code,1);assert.doesNotMatch(output,/FORGE running|DORMANT_ACTIVATION_REQUIRED/);}
    else{
      assert.equal(result.ready,true,output);assert.equal(result.claims,0);assert.equal(result.providers,0);
      const res=await fetch(`http://127.0.0.1:${result.port}/assets/synthetic-missing.js`);assert.equal(res.status,404);
      assert.match(output,/STRAVA_WORKER_DORMANT_ACTIVATION_REQUIRED/);
      // No public start hook: even an activation-shaped request cannot create a worker.
      const activation=await fetch(`http://127.0.0.1:${result.port}/api/strava/worker/start`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({activate:true,paused:false})});assert.equal(activation.status,404);
      const began=Date.now();p.kill('SIGTERM');const end=await exit;assert.equal(end.code,mode==='drain-timeout'?1:0);assert.ok(Date.now()-began<(mode==='drain-timeout'?6000:5000));
      if(mode==='drain-timeout')assert.match(output,/bounded drain expired/);
    }
    console.log('PASS actual app child dormant/startup/shutdown',mode);
  }finally{clearTimeout(timeout);if(p.exitCode===null&&p.signalCode===null){p.kill('SIGKILL');await exit;}}
}
async function intakeClose(){
  const file=require.resolve('../src/db/backgroundSyncIntake'),original=Module._load;let ended=0;
  class SyntheticOwnedPool{on(){}end(){ended++;return Promise.resolve();}}
  try{
    delete require.cache[file];Module._load=function(request,parent){if(request==='pg'&&parent?.filename===file)return {Pool:SyntheticOwnedPool};return original.apply(this,arguments);};
    const intake=require(file);intake.getIntakeTransaction();const close=intake.closeIntakePool();assert.strictEqual(intake.closeIntakePool(),close);await close;assert.equal(ended,1);assert.throws(()=>intake.getIntakeTransaction(),{code:'STRAVA_INTAKE_UNAVAILABLE'});
  }finally{Module._load=original;delete require.cache[file];}
  console.log('PASS owned intake close is idempotent and cannot reopen');
}
if(process.argv[2]==='--child')child(process.argv[3]).catch(error=>{console.error(error);process.exit(1);});
else(async()=>{for(const mode of ['unpaused','paused','missing','old','unpaused','migration-fail','drain-timeout'])await startup(mode);await intakeClose();await oldWriter();console.log('STRAVA WORKER DORMANCY GATE OK — activation not implemented');})().catch(error=>{console.error(error);process.exitCode=1;});
