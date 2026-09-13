// Actual Express adapters and watchSync SQL ingestion, with a synthetic client.
const assert = require('node:assert/strict');
const { createDb } = require('./helpers/adaptiveShadowDb');
const fixture = createDb(), { db, tx } = fixture;
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id:dbPath, filename:dbPath, loaded:true, exports:fixture.exports };
let now='2026-03-09T16:00:00Z', fetchPage=async()=>[];
const RealDate=Date;
global.Date=class extends RealDate { constructor(...args){super(...(args.length?args:[now]));} static now(){return RealDate.parse(now);} };
const clientPath=require.resolve('garmin-connect');
require.cache[clientPath]={id:clientPath,filename:clientPath,loaded:true,exports:{GarminConnect:class {
  async login() {} async getUserProfile(){return {displayName:"Synthetic"};} async getActivities(offset,size){return fetchPage(offset,size);} async getSleepData(){return null;}
}}};
const router=require('../src/routes/garmin');
const coverage=require('../src/lib/providerImportCoverage');
const owner='33333333-3333-4333-8333-000000000001';
async function route(path, body={}) {
  const layer=router.stack.find(l=>l.route?.path===path && l.route.methods.post);
  let status=200, payload;
  const res={status(n){status=n;return this;},json(p){payload=p;return this;}};
  await layer.route.stack.at(-1).handle({user:{id:owner},body},res);
  return {status,payload};
}
const lastSync=()=>db.prepare("SELECT value FROM user_settings WHERE user_id=? AND key='garmin_last_sync'").get(owner)?.value;
async function main(){
  db.prepare("INSERT INTO users(id,name,email,password_hash,timezone,planning_input_revision) VALUES (?,'Synthetic','garmin@example.invalid','','America/New_York',1)").run(owner);
  assert.equal((await route('/connect',{username:'synthetic',password:'synthetic'})).status,200);
  const activity={activityId:100,startTimeGMT:'2026-03-08T06:30:00',startTimeLocal:'2026-03-08T01:30:00',activityType:{typeKey:'running'},distance:5000,duration:2200};
  fetchPage=async offset=>offset===0?[activity]:[];
  let response=await route('/sync');
  assert.equal(response.status,200);assert.equal(response.payload.status,'COMPLETE');assert.equal(response.payload.synced,1);assert.equal(lastSync(),new Date(now).toISOString());
  let loaded=await coverage.load({tx,userId:owner,observationInstant:now,timezone:'America/New_York'});
  assert.equal(loaded.coverage[0].status,'complete');assert.equal(loaded.coverage[0].coverage_start_local,'2026-01-12');assert.equal(loaded.coverage[0].coverage_end_local,'2026-03-08');
  assert.equal(loaded.bindings.length,1);
  const runLoad = rows => require('../src/lib/goalBackwardEvidence').canonicalizeRunLoadInput({
    athleteId:owner,planningInstant:now,planningDateLocal:'2026-03-09',timezone:'America/New_York',
    runs:db.prepare('SELECT * FROM runs WHERE user_id=?').all(owner),providerCoverage:rows });
  const load=runLoad(loaded.coverage);
  assert.equal(load.load_input_state,'PARTIAL','today remains partial');
  assert.equal(load.recent_normal_weeks.find(w=>w.week_end_local==='2026-03-08').eligible,true,'completed DST week is independently covered');
  for(const status of ['partial','failed','unknown']) assert.ok(runLoad(loaded.coverage.map(c=>({...c,status}))).recent_normal_weeks.every(w=>!w.eligible));

  response=await route('/sync');assert.equal(response.payload.synced,0);assert.deepEqual(response.payload.activities,[]);assert.equal(response.payload.status,'COMPLETE');
  const stamp=lastSync();now='2026-03-09T17:00:00Z';
  fetchPage=async()=>{throw Error('private-provider-error-synthetic');};
  response=await route('/sync');assert.equal(response.status,500);assert.equal(response.payload.status,'FAILED');assert.equal(lastSync(),stamp);
  assert.ok(!JSON.stringify(response).includes('private-provider'));assert.equal(response.payload.synced,0);
  fetchPage=async offset=>offset===0?[{...activity,activityId:101,activityType:{typeKey:'unrecognized'}}]:[];
  response=await route('/sync');assert.equal(response.status,200);assert.equal(response.payload.status,'PARTIAL');assert.equal(lastSync(),stamp);
  // Fall-back DST repeats an hour, but the full Sunday is still provable.
  now='2026-11-02T17:00:00Z';
  fetchPage=async offset=>offset===0?[{...activity,activityId:102,startTimeGMT:'2026-11-01T06:30:00',startTimeLocal:'2026-11-01T01:30:00'}]:[];
  response=await route('/sync');assert.equal(response.payload.status,'COMPLETE');assert.equal(response.payload.synced,1);
  loaded=await coverage.load({tx,userId:owner,observationInstant:now,timezone:'America/New_York'});
  assert.equal(loaded.coverage[0].status,'complete');assert.equal(loaded.coverage[0].coverage_start_local,'2026-09-07');assert.equal(loaded.coverage[0].coverage_end_local,'2026-11-01');
  // A GMT/local-day mismatch cannot attest coverage. Ingestion remains intact.
  fetchPage=async offset=>offset===0?[{...activity,activityId:103,startTimeGMT:'2026-11-02T01:30:00',startTimeLocal:'2026-11-02T01:30:00'}]:[];
  response=await route('/sync');assert.equal(response.payload.status,'PARTIAL');
  // Different planning timezone cannot reuse a physical row under the wrong day.
  assert.equal((await coverage.load({tx,userId:owner,observationInstant:now,timezone:'America/New_York'})).coverage[0].status,'partial');
  console.log('ok - actual Garmin connect/sync adapter: new/duplicate counts, failed/partial responses, timestamps, local whole days and both DST transitions');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{global.Date=RealDate;db.close();});
