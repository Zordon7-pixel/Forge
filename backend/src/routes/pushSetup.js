'use strict';
const express=require('express');
const helmet=require('helmet');
const jwt=require('jsonwebtoken');
const {createWorkerDatabase}=require('../db/backgroundSyncWorker');
const {createWebPushSetup}=require('../services/webPushSetup');
const ACTIONS=new Set(['issue-create','create','status','authorize-handoff','redeem-handoff','confirm','cancel','revoke']);

function configuredOrigin(value,production) {
  try {
    const url=new URL(value);
    if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||value!==url.origin
      ||(production?url.protocol!=='https:':!['https:','http:'].includes(url.protocol)))return null;
    return {origin:url.origin,host:url.host};
  } catch{return null;}
}
function createPushSetupRouter({origin=process.env.APP_URL,production=process.env.NODE_ENV==='production',
  getPool=()=>require('../db').pool,databaseFactory=createWorkerDatabase,serviceFactory=createWebPushSetup}={}) {
  const router=express.Router(),authority=configuredOrigin(origin,production);
  const reply=(res,status,body)=>{
    const encoded=JSON.stringify(body);
    if(Buffer.byteLength(encoded)>2048)return res.status(503).json({error:'SETUP_UNAVAILABLE'});
    return res.status(status).type('application/json').send(encoded);
  };
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.use(helmet({contentSecurityPolicy:false}));
  router.use((req,res,next)=>{
    if(!authority)return reply(res,503,{error:'SETUP_UNAVAILABLE'});
    if(req.method!=='POST'||!ACTIONS.has(req.path.slice(1))||req.path!==`/${req.path.slice(1)}`)return reply(res,405,{error:'SETUP_METHOD_REQUIRED'});
    if(req.get('origin')!==authority.origin||req.headers.host!==authority.host)return reply(res,403,{error:'SETUP_ORIGIN_REQUIRED'});
    if(req.headers['content-type']!=='application/json'||(req.headers['content-encoding']&&req.headers['content-encoding']!=='identity'))return reply(res,415,{error:'SETUP_JSON_REQUIRED'});
    const length=req.headers['content-length'];
    if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>8192))return reply(res,413,{error:'SETUP_BODY_TOO_LARGE'});
    next();
  });
  router.use(express.json({limit:8192,strict:true,type:()=>true,inflate:false}));
  router.use(async(req,res)=>{
    const action=req.path.slice(1);
    if(!req.body||typeof req.body!=='object'||Array.isArray(req.body))return reply(res,400,{error:'SETUP_INVALID'});
    let owner,token,database;
    const controller=new AbortController();
    const aborted=()=>controller.abort();
    const closed=()=>{if(!res.writableEnded)controller.abort();};
    req.on('aborted',aborted);res.on('close',closed);if(req.aborted)controller.abort();
    try {
      if(action!=='redeem-handoff') {
        const header=req.headers.authorization;
        if(typeof header!=='string'||!header.startsWith('Bearer '))return reply(res,401,{error:'Unauthorized'});
        token=header.slice(7);
        try{owner=jwt.verify(token,process.env.JWT_SECRET).id;}catch{return reply(res,401,{error:'Invalid token'});}
      }
      const pool=getPool();
      if(!pool||typeof pool.connect!=='function')throw new Error('missing pool');
      database=databaseFactory({pool});
      const result=await serviceFactory({database}).execute(action,req.body,{owner,token,address:req.socket.remoteAddress,signal:controller.signal});
      if(controller.signal.aborted)return;
      return reply(res,result.error?409:200,result);
    } catch(error) {
      if(controller.signal.aborted)return;
      if(error.code==='STRAVA_WORKER_COMMIT_UNCERTAIN')return reply(res,503,{error:'SETUP_COMMIT_UNKNOWN'});
      if(error.code==='AUTH_ACCOUNT_DELETED')return reply(res,401,{error:'Invalid token'});
      const codes=new Set(['SETUP_INVALID','SETUP_UNAUTHORIZED','AUTH_ACCOUNT_DELETED','SETUP_EXPIRED','CLAIM_CHANGED',
        'OPERATION_CONFLICT','SETUP_RATE_LIMITED','SETUP_GRANT_LIMIT','REVISION_EXHAUSTED']);
      return reply(res,codes.has(error.code)?error.status:503,{error:codes.has(error.code)?error.code:'SETUP_UNAVAILABLE',
        ...(error.code==='SETUP_RATE_LIMITED'?{retryAfterSeconds:error.retryAfterSeconds}:{})});
    } finally {
      req.removeListener('aborted',aborted);res.removeListener('close',closed);
      if(database)await database.close();
    }
  });
  router.use((error,_req,res,_next)=>reply(res,error.type==='entity.too.large'?413:400,
    {error:error.type==='entity.too.large'?'SETUP_BODY_TOO_LARGE':'SETUP_INVALID'}));
  return router;
}
module.exports={createPushSetupRouter};
