'use strict';
// Direct internal construction only. app.js deliberately has NO factory/start
// call: complete-B1 activation/recovery remains a separate reviewed artifact.
const {performance}=require('node:perf_hooks');
const {createWorkerDatabase,LIMITS:DB_LIMITS}=require('../db/backgroundSyncWorker');
const {createStravaEventQueue,LIMITS}=require('./stravaEventQueue');
const {createStravaProviderClient,providerRejection,REQUEST_MS}=require('./stravaProviderClient');
const {createStravaConnectionService}=require('./stravaConnectionService');
const {captureStravaConnection,persistStravaActivity}=require('./stravaPersistence');
const {normalizeStravaRun,routeCoordsFromStravaStreams}=require('../lib/stravaActivity');
const {planningInputUnchanged}=require('../lib/planningRevision');
const SCHEDULE=Object.freeze({poll:1000,maintenance:60000,shutdown:5000});
const unavailable=(code='STRAVA_WORKER_UNAVAILABLE')=>Object.assign(new Error('Background sync unavailable'),{code});
function id(value){
  if(typeof value==='string'&&/^[1-9][0-9]{0,14}$/.test(value))return value;
  if(Number.isSafeInteger(value)&&value>0)return String(value);
  throw unavailable('STRAVA_ACTIVITY_INVALID');
}
// Closed provider vocabulary, not substring/title inference. type is deprecated
// ActivityType; sport_type may be a finer SportType. Unknown combinations retry.
// https://developers.strava.com/docs/reference/#api-models-ActivityType
// https://developers.strava.com/docs/reference/#api-models-SportType
const ACTIVITY_TYPES=new Set('AlpineSki BackcountrySki Canoeing Crossfit EBikeRide Elliptical Golf Handcycle Hike IceSkate InlineSkate Kayaking Kitesurf NordicSki Ride RockClimbing RollerSki Rowing Run Sail Skateboard Snowboard Snowshoe Soccer StairStepper StandUpPaddling Surfing Swim Velomobile VirtualRide VirtualRun Walk WeightTraining Wheelchair Windsurf Workout Yoga'.split(' '));
const SPORT_TYPES=new Set([...ACTIVITY_TYPES,...'Badminton Basketball Cricket Dance EMountainBikeRide GravelRide HighIntensityIntervalTraining MountainBikeRide Padel PhysicalTherapy Pickleball Pilates Racquetball Squash TableTennis Tennis TrailRun VirtualRow Volleyball'.split(' ')]);
const FINER_TYPES=Object.freeze({TrailRun:'Run',MountainBikeRide:'Ride',GravelRide:'Ride',EMountainBikeRide:'EBikeRide',VirtualRow:'Rowing'});
function fetchedRunType(activity){
  const type=activity.type,sport=activity.sport_type;
  if(type!=null&&(typeof type!=='string'||!ACTIVITY_TYPES.has(type)))throw unavailable('STRAVA_ACTIVITY_INVALID');
  if(sport!=null&&(typeof sport!=='string'||!SPORT_TYPES.has(sport)))throw unavailable('STRAVA_ACTIVITY_INVALID');
  if(type==null&&sport==null)throw unavailable('STRAVA_ACTIVITY_INVALID');
  if(type!=null&&sport!=null&&type!==sport&&FINER_TYPES[sport]!==type)throw unavailable('STRAVA_ACTIVITY_INVALID');
  return ['Run','TrailRun','VirtualRun'].includes(sport??type);
}
function validFetchedTime(value,{local=false}={}){
  // Supported ISO8601 extended form, seconds and at most millisecond precision.
  // start_date is an instant: no missing/unknown offset, rollover, leap-second,
  // 24:00, whitespace or permissive Date.parse alternate grammar. Local wall
  // time is validated independently, never interpreted as the UTC instant.
  if(typeof value!=='string')return false;
  const m=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if(!m)return false;
  const [,year,month,day,hour,minute,second,,zone]=m;
  const y=Number(year),mo=Number(month),d=Number(day);
  const leap=y%4===0&&(y%100!==0||y%400===0);
  if(y<1||mo<1||mo>12||d<1||d>[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][mo-1]
    ||Number(hour)>23||Number(minute)>59||Number(second)>59)return false;
  if(!zone)return local;
  if(zone==='-00:00'||(zone!=='Z'&&(Number(zone.slice(1,3))>23||Number(zone.slice(4,6))>59)))return false;
  return Number.isFinite(Date.parse(value));
}
function createStravaEventWorker({database,fetchImpl,env=()=>process.env}={}){
  const db=database||createWorkerDatabase(),queue=createStravaEventQueue({database:db});
  const controller=new AbortController();let closed=false,started=false,timer,cycle,closing,lastMaintenance=-Infinity;
  const log=code=>console.warn('[strava/worker]',code);
  async function current(tx,handle,capture){
    const row=await tx.get(`SELECT t.connection_generation,t.athlete_id,b.id AS binding_id FROM strava_tokens t
      JOIN strava_ingress_bindings b ON b.id=t.connection_generation AND b.user_id=t.user_id WHERE t.user_id=?`,[handle.userId]);
    if(!row||row.binding_id!==handle.bindingId||row.connection_generation!==capture.row.connection_generation||String(row.athlete_id)!==handle.athleteId)throw unavailable('STRAVA_CONNECTION_STALE');
  }
  async function perform(handle){
    const execution=queue.execution(handle,{signal:controller.signal}),signal=execution.signal,began=performance.now();
    const provider=createStravaProviderClient({dialect:db.dialect,fetchImpl,
      withTransaction:fn=>db.transaction(fn,{signal})});
    const connections=createStravaConnectionService({withUserMutation:db.withOwnerMutation,provider,env,
      beforeNetwork:execution.beforeNetwork,finalizeVerifiedRevocation:execution.finalizeVerifiedRevocation});
    const options={signal,beforeNetwork:execution.beforeNetwork};
    try{
      let capture=await connections.connection(handle.userId,{signal});
      if(capture.row.connection_generation!==handle.bindingId||String(capture.row.athlete_id)!==handle.athleteId)throw unavailable('STRAVA_CONNECTION_STALE');
      if(handle.objectType==='athlete'){
        const revoked=await connections.verifyRevocation(capture,{signal});
        if(revoked)return {status:'REVOKED'};
        await db.withOwnerMutation(handle.userId,async tx=>{await current(tx,handle,capture);await execution.finish(tx);},{signal});
        return {status:'VERIFIED'};
      }
      capture=await connections.refresh(capture,{signal});
      let activity;
      try{activity=await provider.request('activity',{accessToken:capture.row.access_token,activityId:handle.objectId},options);}
      catch(error){
        const rejected=providerRejection(error);
        if(rejected?.operation==='activity'&&rejected.objectId===handle.objectId&&rejected.status===404){
          await db.withOwnerMutation(handle.userId,async tx=>{
            await current(tx,handle,capture);
            await tx.run("UPDATE provider_activity_links SET state='PROVIDER_UNAVAILABLE',updated_at=CURRENT_TIMESTAMP WHERE user_id=? AND provider='strava' AND object_id=? AND state<>'USER_DELETED'",[handle.userId,handle.objectId]);
            await execution.finish(tx);
          },{signal});
          return {status:'SOURCE_UNAVAILABLE'};
        }
        if(rejected?.operation==='activity'&&rejected.objectId===handle.objectId&&[401,403].includes(rejected.status)){
          if(await connections.verifyRevocation(capture,{signal}))return {status:'REVOKED'};
        }
        throw error;
      }
      if(id(activity.id)!==handle.objectId||id(activity.athlete?.id)!==handle.athleteId)throw unavailable('STRAVA_ACTIVITY_INVALID');
      const isRun=fetchedRunType(activity);
      if(isRun){
        // Do not let the legacy normalizer's date/zero fallbacks fabricate a
        // run from an incomplete provider response. Optional metrics stay optional.
        if(!validFetchedTime(activity.start_date)
          ||(activity.start_date_local!=null&&!validFetchedTime(activity.start_date_local,{local:true}))
          ||typeof activity.distance!=='number'||!Number.isFinite(activity.distance)||activity.distance<0||activity.distance>1000000
          ||typeof activity.moving_time!=='number'||!Number.isFinite(activity.moving_time)||activity.moving_time<0||activity.moving_time>172800)throw unavailable('STRAVA_ACTIVITY_INVALID');
        const normalized=normalizeStravaRun(activity);
        if(activity.trainer!==true&&normalized.routeCoords.length<2&&!signal.aborted
          // Reserve the existing request deadline, reservation/admission/final
          // DB budgets and one spacing wait, not just the HTTP portion.
          &&performance.now()-began<LIMITS.execution-REQUEST_MS-3*DB_LIMITS.whole-1000){
          try{
            const streams=await provider.request('streams',{accessToken:capture.row.access_token,activityId:handle.objectId},options);
            const routeCoords=routeCoordsFromStravaStreams(streams,normalized.startDate);
            if(routeCoords.length>=2)activity={...activity,routeCoords};
          }catch(_optional){log('STRAVA_OPTIONAL_STREAMS_UNAVAILABLE');}
        }
      }
      const expected=captureStravaConnection(handle.userId,capture.row);
      const result=await db.withPlanningMutation(handle.userId,async tx=>{
        await current(tx,handle,capture);
        const saved=await persistStravaActivity(tx,handle.userId,activity,expected);
        await execution.finish(tx);
        // Match the existing run/nonrun revision convention, not a new changed heuristic.
        return isRun?saved:planningInputUnchanged(saved);
      },{signal});
      return {status:result.runId?'SAVED':'NO_RUN',imported:result.imported,enriched:result.enriched};
    }catch(error){
      let reason='TRANSIENT',retryAt=null;
      if(error.code==='STRAVA_PROVIDER_PAUSED')reason='PAUSED';
      else if(error.code==='STRAVA_QUOTA_UNAVAILABLE'||providerRejection(error)?.status===429){
        reason='QUOTA';
        if(Number.isSafeInteger(error.retryAt)&&error.retryAt>=0)retryAt=error.retryAt;
        else if(!signal.aborted){
          const row=await db.transaction(tx=>tx.get("SELECT next_allowed_at FROM background_sync_control WHERE id='strava'"),{signal}).catch(()=>null);
          if(row){const n=Date.parse(row.next_allowed_at instanceof Date?row.next_allowed_at.toISOString():String(row.next_allowed_at));if(Number.isSafeInteger(n)&&n>=0)retryAt=n;}
        }
      }else if(error.code==='STRAVA_REFRESH_BUSY')reason='REFRESH_BUSY';
      else if(error.code==='55P03')reason='OWNER_BUSY';
      // Uncertain/cancelled finalization must retain its lease for recovery;
      // never rewrite a possibly committed outcome to RETRY.
      if(signal.aborted||error.code==='STRAVA_WORKER_COMMIT_UNCERTAIN')return {status:'UNKNOWN'};
      try{return {status:await execution.reschedule(reason,{retryAt}),reason};}
      catch(_reschedule){return {status:'UNKNOWN'};}
    }finally{execution.close();}
  }
  function runOnce(){
    if(closed)return Promise.reject(unavailable('STRAVA_WORKER_CLOSED'));
    if(cycle)return cycle;
    cycle=(async()=>{
      const handles=await queue.claim({signal:controller.signal});
      const results=await Promise.all(handles.map(perform));
      if(!closed&&performance.now()-lastMaintenance>=SCHEDULE.maintenance){
        await queue.purge({signal:controller.signal});lastMaintenance=performance.now();
      }
      return results;
    })().finally(()=>{cycle=null;});return cycle;
  }
  function start(){
    if(closed)throw unavailable('STRAVA_WORKER_CLOSED');if(started)return;started=true;
    const poll=async()=>{try{await runOnce();}catch(_error){log('STRAVA_WORKER_POLL_UNAVAILABLE');}finally{if(!closed)timer=setTimeout(poll,SCHEDULE.poll);}};
    timer=setTimeout(poll,0);
  }
  function close(){
    if(closing)return closing;closed=true;clearTimeout(timer);controller.abort();queue.close();
    closing=(async()=>{let timeout;try{
      await Promise.race([Promise.all([cycle?.catch(()=>undefined),db.close()]),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(unavailable('STRAVA_WORKER_SHUTDOWN_TIMEOUT')),SCHEDULE.shutdown);})]);
    }finally{clearTimeout(timeout);}})();return closing;
  }
  return Object.freeze({runOnce,start,close});
}
module.exports={createStravaEventWorker,SCHEDULE};
