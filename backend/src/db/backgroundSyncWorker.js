'use strict';
const {Pool}=require('pg');
const {performance}=require('node:perf_hooks');
const {AsyncLocalStorage}=require('node:async_hooks');
const {createPlanningInputMutationRunner}=require('../lib/planningRevision');

// W2 is a directly constructed internal prerequisite, not a production worker.
const LIMITS=Object.freeze({pool:2,acquisition:150,lock:150,statement:1000,idle:1000,whole:5000,shutdown:5000});
const unavailable=(code='STRAVA_WORKER_DB_UNAVAILABLE')=>Object.assign(new Error('Background transaction unavailable'),{code,status:503});
const positional=sql=>{let index=0;return sql.replace(/\?/g,()=>`$${++index}`);};
function createWorkerDatabase({pool,connectionString,sqlite}={}){
  if(pool&&sqlite)throw new TypeError('Choose one worker database');
  const dialect=sqlite?'sqlite':'postgres';
  const ownedPool=!sqlite&&!pool;
  if(ownedPool)pool=new Pool({connectionString:connectionString||process.env.DATABASE_URL,
    ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false,
    max:LIMITS.pool,connectionTimeoutMillis:LIMITS.acquisition,idleTimeoutMillis:10000});
  if(ownedPool)pool.on('error',()=>console.error('[strava/worker] idle database connection unavailable'));
  if(sqlite)sqlite.exec('PRAGMA busy_timeout=150');
  const contexts=new WeakMap(),nested=new AsyncLocalStorage(),active=new Set();
  let closing=false,sqliteBusy=false,closePromise;
  async function execute(fn,{signal,owner=null}={}){
    if(closing||signal?.aborted||nested.getStore()||sqliteBusy)throw unavailable();
    const until=performance.now()+LIMITS.whole;
    let client,acquireTimer,timer,began=false,committing=false,closed=false,released=false,tx;
    let rejectDeadline;
    const expired=new Promise((_,reject)=>{rejectDeadline=reject;});
    const release=destroy=>{if(client&&!released){released=true;client.removeListener?.('error',cancel);client.release(destroy);}};
    function cancel(){
      closed=true;let code=committing?'STRAVA_WORKER_COMMIT_UNCERTAIN':'STRAVA_WORKER_DB_UNAVAILABLE';
      // SQLite has no cancellable socket: unwind its synchronous transaction
      // immediately, not after an arbitrary awaited callback finally settles.
      if(sqlite&&began&&!committing){try{sqlite.exec('ROLLBACK');began=false;}catch(_rollback){code='STRAVA_WORKER_ROLLBACK_FAILED';}}
      release(true);rejectDeadline(unavailable(code));
    }
    const check=()=>{if(closed||closing||signal?.aborted||performance.now()>=until)throw unavailable(committing?'STRAVA_WORKER_COMMIT_UNCERTAIN':'STRAVA_WORKER_DB_UNAVAILABLE');};
    const query=async(sql,params=[])=>{
      check();
      let result;
      if(sqlite){
        if(/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql)){sqlite.exec(sql);result={rows:[],rowCount:0};}
        else{const statement=sqlite.prepare(sql);const values=params.map(value=>typeof value==='boolean'?Number(value):value);
          if(statement.columns().length){const rows=statement.all(...values);result={rows,rowCount:rows.length};}
          else{const run=statement.run(...values);result={rows:[],rowCount:Number(run.changes)};}}
      }else result=await client.query(positional(sql),params);
      check();return result;
    };
    const work=async()=>{
      if(sqlite)sqliteBusy=true;
      else{
        acquireTimer=setTimeout(cancel,LIMITS.acquisition);
        client=await pool.connect();clearTimeout(acquireTimer);
        if(closed||closing){release(true);throw unavailable();}
        client.on?.('error',cancel);
      }
      tx=Object.assign(query,{dialect,get:async(s,p)=>(await query(s,p)).rows[0]||null,
        all:async(s,p)=>(await query(s,p)).rows,run:async(s,p)=>({changes:(await query(s,p)).rowCount})});
      contexts.set(tx,{owner});
      try{
        await query('BEGIN');began=true;
        if(!sqlite)await query("SET LOCAL lock_timeout='150ms'; SET LOCAL statement_timeout='1000ms'; SET LOCAL idle_in_transaction_session_timeout='1000ms'");
        if(owner&&!await tx.get(`SELECT id FROM users WHERE id=?${sqlite?'':' FOR UPDATE'}`,[owner]))throw unavailable('AUTH_ACCOUNT_DELETED');
        const result=await nested.run(true,()=>fn(tx));
        check();committing=true;await query('COMMIT');began=false;committing=false;
        return result;
      }catch(error){
        if(committing)throw unavailable('STRAVA_WORKER_COMMIT_UNCERTAIN');
        if(began){
          try{if(sqlite)sqlite.exec('ROLLBACK');else if(!closed)await client.query('ROLLBACK');began=false;}
          catch(_rollback){release(true);}
        }
        throw error;
      }finally{contexts.delete(tx);release(closed||began);if(sqlite)sqliteBusy=false;}
    };
    active.add(cancel);timer=setTimeout(cancel,LIMITS.whole);signal?.addEventListener('abort',cancel,{once:true});
    try{return await Promise.race([work(),expired]);}
    finally{closed=true;clearTimeout(timer);clearTimeout(acquireTimer);signal?.removeEventListener('abort',cancel);active.delete(cancel);}
  }
  const transaction=(fn,options)=>execute(fn,options);
  const withOwnerMutation=(userId,fn,{signal}={})=>{
    if(typeof userId!=='string'||!userId.trim()||userId!==userId.trim())return Promise.reject(unavailable('AUTH_ACCOUNT_DELETED'));
    return execute(fn,{signal,owner:userId});
  };
  const withPlanningMutation=(userId,fn,options)=>createPlanningInputMutationRunner((id,callback)=>withOwnerMutation(id,callback,options))(userId,fn);
  function assertTransaction(tx,userId){
    const context=contexts.get(tx);
    if(!context||(userId!==undefined&&context.owner!==userId))throw unavailable('STRAVA_WORKER_TRANSACTION_REQUIRED');
  }
  function close(){
    if(closePromise)return closePromise;
    closing=true;for(const cancel of active)cancel();
    closePromise=(async()=>{
      if(!ownedPool)return;
      let timer;try{await Promise.race([pool.end(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(unavailable('STRAVA_WORKER_SHUTDOWN_TIMEOUT')),LIMITS.shutdown);})]);}
      finally{clearTimeout(timer);}
    })();return closePromise;
  }
  return Object.freeze({dialect,transaction,withOwnerMutation,withPlanningMutation,assertTransaction,close});
}
module.exports={createWorkerDatabase,LIMITS};
