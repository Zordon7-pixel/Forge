'use strict';
const {randomUUID}=require('node:crypto');
const {performance}=require('node:perf_hooks');

const LIMITS=Object.freeze({scan:10,active:2,lease:120000,execution:100000,episode:72*3600000,attempts:12,fetch:30000,purge:100,retention:30*86400000});
const fail=(code='STRAVA_JOB_STALE')=>Object.assign(new Error('Background job unavailable'),{code,status:503});
const iso=n=>new Date(n).toISOString();
function instant(value){
  if(value instanceof Date&&Number.isFinite(value.getTime()))return value.getTime();
  if(typeof value!=='string'||!value.length)throw fail('STRAVA_JOB_INVALID');
  const text=value.replace(' ','T').replace(/([+-]\d{2})$/,'$1:00');
  const n=Date.parse(/[Zz]|[+-]\d{2}:\d{2}$/.test(text)?text:`${text}Z`);
  if(!Number.isFinite(n))throw fail('STRAVA_JOB_INVALID');return n;
}
function integer(value){if(!((typeof value==='number'||typeof value==='string'&&/^\d+$/.test(value))&&Number.isSafeInteger(Number(value))&&Number(value)>=0&&Number(value)<9e15))throw fail('STRAVA_JOB_INVALID');return Number(value);}
function createStravaEventQueue({database}){
  const claims=new WeakMap(),held=new Map();let closed=false,claiming=false;
  const lock=database.dialect==='sqlite'?'':' FOR UPDATE';
  const clock=async tx=>instant((await tx.get(database.dialect==='sqlite'?"SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now":'SELECT clock_timestamp() AS now')).now);
  const changed=result=>{if(Number(result.changes??result.rowCount)!==1)throw fail();};
  function rowValid(row){
    if(!row||!['PENDING','RETRY','LEASED','DONE','DEAD'].includes(row.state))throw fail();
    const requested=integer(row.requested_revision),processed=integer(row.processed_revision);integer(row.attempts);
    if(requested<1||processed>requested)throw fail('STRAVA_JOB_INVALID');
    instant(row.episode_started_at);instant(row.available_at);if(row.last_fetch_at!==null)instant(row.last_fetch_at);
  }
  const exhausted=(row,now)=>now>=instant(row.episode_started_at)+LIMITS.episode?'STRAVA_JOB_EPISODE_EXPIRED':integer(row.attempts)>=LIMITS.attempts?'STRAVA_JOB_ATTEMPTS_EXHAUSTED':null;
  async function claim({signal}={}){
    if(closed||claiming)throw fail();claiming=true;
    try{
      for(const [handle,data] of held)if(performance.now()>=data.deadline){data.stop?.();held.delete(handle);}
      const capacity=LIMITS.active-held.size;if(capacity<=0)return [];
      const selected=await database.transaction(async tx=>{
        const control=await tx.get("SELECT paused FROM background_sync_control WHERE id='strava'");
        if(!control)throw fail('STRAVA_CONTROL_MISSING');
        if(control.paused===true||control.paused===1)return [];
        if(control.paused!==false&&control.paused!==0)throw fail('STRAVA_CONTROL_INVALID');
        const now=await clock(tx),nowText=iso(now);
        const due=database.dialect==='sqlite'?'julianday(available_at)<=julianday(?)':'available_at<=?';
        const expired=database.dialect==='sqlite'?'julianday(lease_until)<=julianday(?)':'lease_until<=?';
        const rows=await tx.all(`SELECT * FROM provider_event_jobs WHERE (state IN ('PENDING','RETRY') AND ${due}) OR (state='LEASED' AND ${expired}) ORDER BY available_at,id LIMIT 10${database.dialect==='sqlite'?'':' FOR UPDATE SKIP LOCKED'}`,[nowText,nowText]);
        const result=[];
        for(const row of rows){
          rowValid(row);const reason=exhausted(row,now);
          if(reason){changed(await tx.run("UPDATE provider_event_jobs SET state='DEAD',lease_token=NULL,lease_until=NULL,leased_revision=NULL,last_error_code=?,updated_at=? WHERE id=?",[reason,nowText,row.id]));continue;}
          if(result.length>=capacity)continue;
          const binding=await tx.get('SELECT id,user_id,athlete_id FROM strava_ingress_bindings WHERE id=?',[row.binding_id]);
          if(!binding)throw fail();
          const token=randomUUID(),until=iso(now+LIMITS.lease);
          changed(await tx.run("UPDATE provider_event_jobs SET state='LEASED',lease_token=?,lease_until=?,leased_revision=requested_revision,updated_at=? WHERE id=?",[token,until,nowText,row.id]));
          result.push({id:row.id,bindingId:binding.id,userId:binding.user_id,athleteId:String(binding.athlete_id),objectType:row.object_type,objectId:row.object_id,token,revision:integer(row.requested_revision),leaseUntil:until});
        }return result;
      },{signal});
      return selected.map(data=>{
        const handle=Object.freeze({id:data.id,userId:data.userId,bindingId:data.bindingId,athleteId:data.athleteId,objectType:data.objectType,objectId:data.objectId});
        data.deadline=performance.now()+LIMITS.execution;claims.set(handle,data);held.set(handle,data);return handle;
      });
    }finally{claiming=false;}
  }
  function execution(handle,{signal}={}){
    const data=claims.get(handle);
    if(closed||!data||!held.has(handle)||data.started)throw fail();data.started=true;
    const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    let charged=false,fetched=false,busy=false,finished=false;
    const timer=setTimeout(()=>controller.abort(),Math.max(0,data.deadline-performance.now()));
    const stop=()=>{clearTimeout(timer);controller.abort();held.delete(handle);};data.stop=stop;
    const check=()=>{if(closed||finished||combined.aborted||performance.now()>=data.deadline)throw fail('STRAVA_JOB_CANCELLED');};
    async function leased(tx,{bindingLock=false,age=true}={}){
      check();database.assertTransaction(tx);
      if(bindingLock){
        const binding=await tx.get(`SELECT id,user_id,athlete_id FROM strava_ingress_bindings WHERE id=?${lock}`,[data.bindingId]);
        if(!binding||binding.user_id!==data.userId||String(binding.athlete_id)!==data.athleteId)throw fail();
      }
      const row=await tx.get(`SELECT * FROM provider_event_jobs WHERE id=?${lock}`,[data.id]);rowValid(row);
      const now=await clock(tx);
      if(row.binding_id!==data.bindingId||row.state!=='LEASED'||row.lease_token!==data.token||integer(row.leased_revision)!==data.revision||instant(row.lease_until)<=now)throw fail();
      if(age&&now>=instant(row.episode_started_at)+LIMITS.episode)throw fail('STRAVA_JOB_EPISODE_EXPIRED');
      // This unlocked lookup never introduces job→binding lock inversion.
      const binding=await tx.get('SELECT id,user_id,athlete_id FROM strava_ingress_bindings WHERE id=?',[data.bindingId]);
      if(!binding||binding.user_id!==data.userId||String(binding.athlete_id)!==data.athleteId)throw fail();
      return {row,now};
    }
    async function beforeNetwork({operation,objectId}){
      check();if(busy)throw fail('STRAVA_JOB_ADMISSION_BUSY');
      const objectFetch=operation==='activity'&&data.objectType==='activity'||operation==='athlete'&&data.objectType==='athlete';
      if(!['token','activity','athlete','streams'].includes(operation)
        ||data.objectType==='athlete'&&data.objectId!==data.athleteId
        ||['activity','streams'].includes(operation)&&(data.objectType!=='activity'||objectId!==data.objectId)
        ||operation==='streams'&&!fetched||objectFetch&&fetched)throw fail('STRAVA_JOB_OPERATION_INVALID');
      busy=true;
      try{
        await database.transaction(async tx=>{
          const {row}=await leased(tx);
          if((!charged&&integer(row.attempts)>=LIMITS.attempts)||charged&&integer(row.attempts)>LIMITS.attempts)throw fail('STRAVA_JOB_ATTEMPTS_EXHAUSTED');
          const control=await tx.get(`SELECT paused FROM background_sync_control WHERE id='strava'${lock}`);
          if(!control)throw fail('STRAVA_CONTROL_MISSING');
          if(control.paused===true||control.paused===1)throw fail('STRAVA_PROVIDER_PAUSED');
          if(control.paused!==false&&control.paused!==0)throw fail('STRAVA_CONTROL_INVALID');
          const now=await clock(tx);
          if(instant(row.lease_until)<=now||now>=instant(row.episode_started_at)+LIMITS.episode)throw fail();
          if(objectFetch&&row.last_fetch_at!==null&&now<instant(row.last_fetch_at)+LIMITS.fetch)throw fail('STRAVA_JOB_FETCH_NOT_DUE');
          const live=database.dialect==='sqlite'?"julianday(lease_until)>julianday('now') AND julianday(episode_started_at)+3>julianday('now')":"lease_until>clock_timestamp() AND episode_started_at+INTERVAL '72 hours'>clock_timestamp()";
          changed(await tx.run(`UPDATE provider_event_jobs SET attempts=?,last_fetch_at=?,updated_at=? WHERE id=? AND lease_token=? AND ${live}`,
            [integer(row.attempts)+(charged?0:1),objectFetch?iso(now):row.last_fetch_at,iso(now),data.id,data.token]));
        },{signal:combined});
        charged=true;if(objectFetch)fetched=true;check();
      }catch(error){if(error.code==='STRAVA_WORKER_COMMIT_UNCERTAIN')stop();throw error;}
      finally{busy=false;}
    }
    async function transition(tx,{success=false,reason='TRANSIENT',retryAt=null,revocation=false}={}){
      database.assertTransaction(tx,success?data.userId:undefined);
      const {row,now}=await leased(tx,{bindingLock:revocation,age:success});
      if(success&&(!charged||(!fetched&&!revocation)))throw fail('STRAVA_JOB_RESULT_UNADMITTED');
      const dirty=integer(row.requested_revision)>data.revision;
      const terminal=exhausted(row,now);
      const state=success&&!dirty?'DONE':terminal?'DEAD':'RETRY';
      const delay=reason==='PAUSED'?60000:reason==='TRANSIENT'?Math.min(3600000,30000*2**Math.max(0,integer(row.attempts)-1)):30000;
      if(retryAt!==null&&(!Number.isSafeInteger(retryAt)||retryAt<0))throw fail('STRAVA_JOB_RETRY_INVALID');
      const due=Math.max(now+(success?0:delay),row.last_fetch_at===null?0:instant(row.last_fetch_at)+LIMITS.fetch,retryAt||0);
      const timePredicate=database.dialect==='sqlite'?"julianday(lease_until)>julianday('now')":"lease_until>clock_timestamp()";
      const episodePredicate=database.dialect==='sqlite'?"julianday(episode_started_at)+3>julianday('now')":"episode_started_at+INTERVAL '72 hours'>clock_timestamp()";
      changed(await tx.run(`UPDATE provider_event_jobs SET state=?,processed_revision=?,lease_token=NULL,lease_until=NULL,leased_revision=NULL,available_at=?,updated_at=?,last_error_code=?
        WHERE id=? AND binding_id=? AND state='LEASED' AND lease_token=? AND leased_revision=? AND ${timePredicate}${success?` AND ${episodePredicate}`:''}`,
        [state,success?data.revision:integer(row.processed_revision),iso(due),iso(now),state==='DONE'?null:terminal||`STRAVA_JOB_${success?'DIRTY':reason}`,data.id,data.bindingId,data.token,data.revision]));
      return state;
    }
    // Called after canonical reconciliation inside the existing owner/planning
    // transaction. It cannot mark a lease complete through a copied handle.
    const finish=tx=>transition(tx,{success:true});
    async function reschedule(reason,{retryAt=null}={}){
      if(!['QUOTA','PAUSED','REFRESH_BUSY','OWNER_BUSY','TRANSIENT'].includes(reason))throw fail('STRAVA_JOB_RETRY_INVALID');
      const result=await database.transaction(tx=>transition(tx,{reason,retryAt}),{signal:combined});finished=true;stop();return result;
    }
    async function finalizeVerifiedRevocation(userId,commitRevocation){
      if(userId!==data.userId||typeof commitRevocation!=='function')throw fail();
      const result=await database.withOwnerMutation(userId,async tx=>{
        await transition(tx,{success:true,revocation:true});
        return commitRevocation(tx);
      },{signal:combined});finished=true;stop();return result;
    }
    return Object.freeze({signal:combined,beforeNetwork,finish,reschedule,finalizeVerifiedRevocation,close:stop});
  }
  async function purge({signal}={}){
    return database.transaction(async tx=>{
      const cutoff=iso(await clock(tx)-LIMITS.retention),time=database.dialect==='sqlite'?'julianday(updated_at)<julianday(?)':'updated_at<?';
      const rows=await tx.all(`SELECT id FROM provider_event_jobs WHERE state='DONE' AND processed_revision=requested_revision AND lease_token IS NULL AND ${time} ORDER BY updated_at,id LIMIT 100${database.dialect==='sqlite'?'':' FOR UPDATE SKIP LOCKED'}`,[cutoff]);
      let count=0;for(const row of rows)count+=Number((await tx.run(`DELETE FROM provider_event_jobs WHERE id=? AND state='DONE' AND processed_revision=requested_revision AND lease_token IS NULL AND ${time}`,[row.id,cutoff])).changes);return count;
    },{signal});
  }
  function close(){closed=true;for(const data of held.values())data.stop?.();held.clear();}
  return Object.freeze({claim,execution,purge,close});
}
module.exports={createStravaEventQueue,LIMITS};
