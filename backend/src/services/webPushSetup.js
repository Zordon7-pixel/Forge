'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const { performance } = require('node:perf_hooks');
const transport = require('./webPushTransport');
const { pushSetupUserRateKey } = require('../lib/accountDataCoverage');
const PROTOCOL = 'FORGE_WEB_PUSH_SETUP_V1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const MAX_REVISION = 9000000000000000;
const ADMISSION_VERSION='FORGE_WEB_PUSH_CREATE_ADMISSION_V1';
const sha = value => crypto.createHash('sha256').update(value).digest();
const hex = value => Buffer.from(value).toString('hex');
const equal = (a,b) => a != null && b != null && Buffer.from(a).length === Buffer.from(b).length && crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
const fail = (code='SETUP_UNAVAILABLE',status=503) => Object.assign(new Error(code),{code,status});
const conflict = () => fail('CLAIM_CHANGED',409);
const secret = () => crypto.randomBytes(32).toString('base64url');
const iso = value => new Date(value).toISOString();
const millis = value => value instanceof Date ? value.getTime() : Date.parse(value);
let activeSends = 0;

function closed(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw fail('SETUP_INVALID',400);
}
function bytes(value,length,standard=false) {
  if (typeof value !== 'string' || !(standard?/^[A-Za-z0-9_+/-]+={0,2}$/:/^[A-Za-z0-9_-]+={0,2}$/).test(value) || value.length > 128) throw fail('SETUP_INVALID',400);
  const decoded=Buffer.from(value,'base64url'),normalized=value.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  if (decoded.length!==length || decoded.toString('base64url')!==normalized) throw fail('SETUP_INVALID',400);
  return decoded;
}
function subscription(value) {
  closed(value,['endpoint','keys','expirationTime']); closed(value.keys,['p256dh','auth']);
  if (value.expirationTime !== undefined && value.expirationTime !== null) throw fail('SETUP_INVALID',400);
  try { transport.validateEndpoint(value.endpoint); } catch { throw fail('SETUP_INVALID',400); }
  const publicKey=bytes(value.keys.p256dh,65,true),auth=bytes(value.keys.auth,16,true);
  try { if (publicKey[0]!==4 || !crypto.ECDH.convertKey(publicKey,'prime256v1').equals(publicKey)) throw new Error(); }
  catch { throw fail('SETUP_INVALID',400); }
  return {endpoint:value.endpoint,keys:{p256dh:publicKey.toString('base64url'),auth:auth.toString('base64url')},
    endpointHash:sha(value.endpoint),keyHash:sha(publicKey),authHash:sha(auth)};
}
function socketAddress(value) {
  if (typeof value!=='string' || value.includes('%')) throw fail('SETUP_INVALID',400);
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(value)) value=value.slice(7);
  if (!net.isIP(value)) throw fail('SETUP_INVALID',400);
  return value.toLowerCase();
}
function commitments(owner,token,address,key) {
  if (typeof key!=='string' || Buffer.byteLength(key)<32) throw fail();
  const hmac=(domain,value)=>crypto.createHmac('sha256',key).update(domain).update(value).digest();
  return {session:hmac('forge:web-push-setup-session:v1\0',token),user:pushSetupUserRateKey(owner,key),
    ip:hmac('forge:web-push-setup-rate:v1:IP\0',socketAddress(address)),global:sha('forge:web-push-setup-rate:v1:GLOBAL')};
}
function requestHash(c,o,s) {
  return sha('forge:web-push-setup-request:v2\0'+JSON.stringify([c.user_id,c.subscription_id,c.endpoint_hash,
    hex(s.keyHash),hex(s.authHash),PROTOCOL,c.operation_id,hex(o.client_nonce_hash),o.auth_epoch,
    hex(o.session_hash),c.id,c.expected_incarnation,String(c.expected_revision)]));
}
function confirmHash(c,o,proof,next) {
  return sha('forge:web-push-setup-confirm:v2\0'+JSON.stringify([hex(o.request_hash),c.id,c.operation_id,c.user_id,
    c.subscription_id,c.endpoint_hash,c.expected_incarnation,String(c.expected_revision),hex(o.client_nonce_hash),
    o.auth_epoch,hex(o.session_hash),hex(proof),next]));
}
function admissionRequest(owner,hashes,input) {
  return sha('forge:web-push-create-admission-request:v1\0'+JSON.stringify([owner,hex(hashes.session),PROTOCOL,input.operationId,
    hex(input.nonceHash),input.authEpoch,hex(input.subscription.endpointHash),hex(input.subscription.keyHash),hex(input.subscription.authHash)]));
}
function admissionFrame(value) {
  if(value===undefined)return null;
  if(typeof value!=='string'||value.length>1024||!value.length)throw fail('SETUP_INVALID',400);
  const parts=value.split('.');if(parts.length!==2||parts.some(p=>!p||!/^[A-Za-z0-9_-]+$/.test(p)))throw fail('SETUP_INVALID',400);
  const payload=Buffer.from(parts[0],'base64url'),mac=Buffer.from(parts[1],'base64url');
  if(payload.toString('base64url')!==parts[0]||mac.toString('base64url')!==parts[1]||mac.length!==32)throw fail('SETUP_INVALID',400);
  let data;try{data=JSON.parse(payload.toString('utf8'));}catch{throw fail('SETUP_INVALID',400);}
  if(!Array.isArray(data)||data.length!==6||data.some(v=>typeof v!=='string')||!Buffer.from(JSON.stringify(data)).equals(payload)
    ||!UUID.test(data[1])||!HEX.test(data[4])||!HEX.test(data[5])||![data[2],data[3]].every(v=>/^(0|[1-9][0-9]*)$/.test(v)&&Number.isSafeInteger(Number(v)))
    ||Number(data[3])-Number(data[2])!==120000)throw fail('SETUP_INVALID',400);
  return {payload,mac,data};
}
function parse(action,input) {
  const common=['protocol','operationId','clientNonce','authEpoch'];
  const extra={'issue-create':['subscription'],create:['subscription','createAdmission'],status:[],cancel:[],'authorize-handoff':['clientId'],
    'redeem-handoff':['challengeId','grant','clientId'],confirm:['subscription','challengeId','proof','nextPossessionProofHash'],
    revoke:['subscription','targetId','generation','incarnation','revision','possessionProof']}[action];
  if (!extra) throw fail('SETUP_INVALID',400);
  closed(input,[...common.filter(k=>action!=='issue-create'||k!=='operationId'),...extra]);
  if ((action==='create'?(typeof input.protocol!=='string'||input.protocol.length>128):input.protocol!==PROTOCOL)
    || (action!=='issue-create'&&!UUID.test(input.operationId)) || !UUID.test(input.authEpoch)) throw fail('SETUP_INVALID',400);
  const result={...input,nonceHash:sha(bytes(input.clientNonce,32))};
  if(action==='issue-create'&&bytes(input.clientNonce,32).toString('base64url')!==input.clientNonce)throw fail('SETUP_INVALID',400);
  if(action==='create')result.admission=admissionFrame(input.createAdmission);
  if (extra.includes('subscription')) result.subscription=subscription(input.subscription);
  for (const name of ['challengeId','targetId','generation','incarnation']) if (extra.includes(name) && !UUID.test(input[name])) throw fail('SETUP_INVALID',400);
  if (extra.includes('clientId') && (typeof input.clientId!=='string' || !/^[\x21-\x7e]{1,256}$/.test(input.clientId))) throw fail('SETUP_INVALID',400);
  for (const name of ['proof','possessionProof','grant']) if (extra.includes(name)) result[name+'Hash']=sha(bytes(input[name],32));
  if (action==='confirm' && !HEX.test(input.nextPossessionProofHash)) throw fail('SETUP_INVALID',400);
  if (action==='revoke' && (!Number.isSafeInteger(input.revision) || input.revision<1 || input.revision>MAX_REVISION)) throw fail('SETUP_INVALID',400);
  return result;
}

// Constructed per request with a borrowed bounded database. No pool, worker,
// scheduler, transport retry, or public activation authority is created here.
function createWebPushSetup({database,send=transport.send,rateSecret=process.env.WEB_PUSH_SETUP_RATE_SECRET,
  vapidDetails={publicKey:process.env.VAPID_PUBLIC_KEY,privateKey:process.env.VAPID_PRIVATE_KEY,
    subject:process.env.VAPID_SUBJECT||'mailto:support@forgeathlete.app'},now=()=>performance.now()}={}) {
  if (!database || typeof database.assertTransaction!=='function') throw fail();
  const lockedSets=new WeakMap();
  const suffix=database.dialect==='postgres'?' FOR UPDATE':'';
  const clock=async tx=>{
    const row=await tx.get(database.dialect==='postgres'?"SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS ms":"SELECT CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) AS ms");
    const ms=Number(row.ms);if(!Number.isSafeInteger(ms)||ms<0)throw fail();return ms;
  };
  function admissionMAC(payload) {return crypto.createHmac('sha256',rateSecret).update('forge:web-push-create-admission-token:v1\0').update(payload).digest();}
  function validateAdmission(input,owner,hashes,time) {
    const frame=input.admission;
    if(!frame||input.protocol!==PROTOCOL||frame.data[0]!==ADMISSION_VERSION||frame.data[1]!==input.operationId||!equal(frame.mac,admissionMAC(frame.payload))
      ||!equal(Buffer.from(frame.data[5],'hex'),admissionRequest(owner,hashes,input))||time<Number(frame.data[2])||time>=Number(frame.data[3]))throw fail('SETUP_EXPIRED',410);
  }
  async function advisory(owner,input,action,signal) {
    return database.transaction(async tx=>{
      let c=null;
      if (action!=='revoke') c=await tx.get(action==='redeem-handoff'
        ?'SELECT * FROM web_push_challenges WHERE id=?':'SELECT * FROM web_push_challenges WHERE user_id=? AND operation_id=?',
      action==='redeem-handoff'?[input.challengeId]:[owner,input.operationId]);
      if (!['create','revoke'].includes(action) && !c) throw fail('SETUP_EXPIRED',410);
      const endpoint=c?c.endpoint_hash:hex(input.subscription.endpointHash);
      const predecessor=await tx.get('SELECT p.user_id FROM web_push_claims c JOIN push_subscriptions p ON p.id=c.subscription_id WHERE c.endpoint_hash=?',[endpoint]);
      const target=c?await tx.get('SELECT endpoint FROM push_subscriptions WHERE id=?',[c.subscription_id]):null;
      return {owner:owner||c.user_id,endpoint,targetEndpoint:target?.endpoint||input.subscription?.endpoint,predecessor:predecessor?.user_id||null};
    },{signal});
  }
  async function lockOwners(tx,discovery) {
    database.assertTransaction(tx);
    const owners=[...new Set([discovery.owner,discovery.predecessor].filter(Boolean))].sort();
    // FIRST application statement. No owner lock may be acquired after this.
    const rows=await tx.all(`SELECT id FROM users WHERE id IN (${owners.map(()=>'?').join(',')}) ORDER BY id${suffix}`,owners);
    if (!rows.some(r=>r.id===discovery.owner)) throw fail('AUTH_ACCOUNT_DELETED',401);
    lockedSets.set(tx,new Set(rows.map(r=>r.id)));
  }
  async function graph(tx,discovery,create=false,endpoint,admissionGuard) {
    database.assertTransaction(tx);
    if(!lockedSets.has(tx))await lockOwners(tx,discovery);
    let claim=await tx.get(`SELECT * FROM web_push_claims WHERE endpoint_hash=?${suffix}`,[discovery.endpoint]);
    if (!claim && create) {
      await admissionGuard();
      await tx.run("INSERT INTO web_push_claims(endpoint_hash,incarnation,state,claim_revision) VALUES(?,?,'VACANT',0) ON CONFLICT(endpoint_hash) DO NOTHING",[discovery.endpoint,crypto.randomUUID()]);
      claim=await tx.get(`SELECT * FROM web_push_claims WHERE endpoint_hash=?${suffix}`,[discovery.endpoint]);
    }
    if (!claim) throw conflict();
    const referenced=claim.subscription_id?await tx.get('SELECT user_id FROM push_subscriptions WHERE id=?',[claim.subscription_id]):null;
    if (referenced && !lockedSets.get(tx).has(referenced.user_id)) throw conflict();
    const targets=await tx.all(`SELECT * FROM push_subscriptions WHERE id=? OR (user_id=? AND endpoint=?) ORDER BY id${suffix}`,
      [claim.subscription_id,discovery.owner,endpoint||'']);
    if (targets.some(r=>!lockedSets.get(tx).has(r.user_id))) throw conflict();
    const challenges=await tx.all(`SELECT * FROM web_push_challenges WHERE user_id=? AND endpoint_hash=? ORDER BY id${suffix}`,[discovery.owner,discovery.endpoint]);
    const ops=[];
    for (const c of challenges) {const o=await tx.get(`SELECT * FROM web_push_setup_operations WHERE challenge_id=?${suffix}`,[c.id]);if(o)ops.push(o);}
    if(targets.length)await tx.all(`SELECT id FROM notification_deliveries WHERE target_id IN (${targets.map(()=>'?').join(',')}) ORDER BY id${suffix}`,targets.map(t=>t.id));
    return {claim,targets,challenges,ops};
  }
  function assertGraph(tx,g) {
    database.assertTransaction(tx);const owners=lockedSets.get(tx);
    if (!owners || g.targets.some(t=>!owners.has(t.user_id))) throw fail();
  }
  function operation(g,input,owner,hashes,redeem=false) {
    const c=g.challenges.find(r=>r.operation_id===input.operationId&&r.user_id===owner);
    const o=c&&g.ops.find(r=>r.challenge_id===c.id);
    if(!c||!o)throw fail('SETUP_EXPIRED',410);
    if (o.auth_epoch!==input.authEpoch || !equal(o.client_nonce_hash,input.nonceHash)
      || (!redeem&&!equal(o.session_hash,hashes.session)) || (input.challengeId&&input.challengeId!==c.id)) throw conflict();
    return {c,o};
  }
  function publicState(g,c,o,time) {
    const target=g.targets.find(t=>t.id===c.subscription_id);
    if(Number(o.retain_until_ms)<=time)throw fail('SETUP_EXPIRED',410);
    let state;
    if(o.confirm_hash) {
      if(g.claim.state!=='ACTIVE'||g.claim.incarnation!==o.result_incarnation||String(g.claim.claim_revision)!==String(o.result_revision)
        ||g.claim.subscription_id!==c.subscription_id||!equal(g.claim.confirm_hash,o.confirm_hash)||!target?.active||target.generation!==o.result_generation)throw conflict();
      state='CONFIRMED';
    } else if (g.claim.incarnation!==c.expected_incarnation||String(g.claim.claim_revision)!==String(c.expected_revision)) throw conflict();
    else if(o.cancelled_at_ms!==null)state='CANCELLED';
    else if(millis(c.expires_at)<=time)state='EXPIRED';
    else if(!target || target.disclosure!=='GENERIC' || (g.claim.state==='ACTIVE'&&g.claim.subscription_id===target.id&&!target.active))throw conflict();
    else {
      if(!(g.claim.state==='ACTIVE'&&g.claim.subscription_id===target.id)) {
        const current=subscription({endpoint:target.endpoint,keys:{p256dh:target.keys_p256dh,auth:target.keys_auth}});
        if(!equal(requestHash(c,o,current),o.request_hash))throw conflict();
      }
      state=o.send_state==='ATTEMPTED'?'UNKNOWN':o.send_state;
    }
    return {protocol:PROTOCOL,operationId:c.operation_id,challengeId:c.id,expiresAt:millis(c.expires_at),state,
      ...(state==='CONFIRMED'?{targetId:c.subscription_id,generation:o.result_generation,revision:Number(o.result_revision),incarnation:o.result_incarnation}:{})};
  }
  function pending(g,c,o,time) {
    const result=publicState(g,c,o,time);
    if(['CONFIRMED','CANCELLED','EXPIRED'].includes(result.state)||c.consumed_at||Number(o.failed_confirm_count)>=5)throw conflict();
    return result;
  }
  async function cancelDeliveries(tx,target) {
    await tx.run("UPDATE notification_deliveries SET state='CANCELLED',lease_token=NULL,lease_until=NULL,admitted_lease_token=NULL WHERE user_id=? AND target_id=? AND target_generation=? AND state IN ('PENDING','LEASED','RETRY')",[target.user_id,target.id,target.generation]);
  }
  async function quotas(tx,hashes,endpoint,time) {
    const window=Math.floor(time/600000)*600000;
    for (const [dimension,key,cap] of [['GLOBAL',hashes.global,100],['USER',hashes.user,3],['ENDPOINT',Buffer.from(endpoint,'hex'),3],['IP',hashes.ip,20]]) {
      // All child work is already complete. GLOBAL serialization precedes cleanup
      // and every lower dimension, including the first insertion in a UTC window.
      const charged=await tx.get('INSERT INTO web_push_setup_rate_buckets(dimension,key_hash,window_start_ms,used_count) VALUES(?,?,?,1) ON CONFLICT(dimension,key_hash,window_start_ms) DO UPDATE SET used_count=web_push_setup_rate_buckets.used_count+1 WHERE web_push_setup_rate_buckets.used_count<? RETURNING used_count',[dimension,key,window,cap]);
      if(!charged)throw Object.assign(fail('SETUP_RATE_LIMITED',429),{retryAfterSeconds:Math.ceil((window+600000-time)/1000)});
      if(dimension==='GLOBAL')await tx.run('DELETE FROM web_push_setup_rate_buckets WHERE window_start_ms<?',[window-600000]);
    }
  }
  async function cleanup(owner,signal) {
    // Retention is a separate bounded owner transaction, never appended after
    // quota locks. It cannot acquire another owner's row or delete their proof.
    await database.transaction(async tx=>{
      database.assertTransaction(tx);
      const users=await tx.all(`SELECT id FROM users WHERE id=? ORDER BY id${suffix}`,[owner]);
      if(!users.length)throw fail('AUTH_ACCOUNT_DELETED',401);
      lockedSets.set(tx,new Set(users.map(row=>row.id)));
      const time=await clock(tx);
      const expired=await tx.all('SELECT c.id,c.endpoint_hash,c.subscription_id FROM web_push_challenges c JOIN web_push_setup_operations o ON o.challenge_id=c.id WHERE c.user_id=? AND o.retain_until_ms<=? ORDER BY c.id LIMIT 100',[owner,time]);
      if(!expired.length)return;
      for(const endpoint of [...new Set(expired.map(c=>c.endpoint_hash))].sort())await tx.get(`SELECT endpoint_hash FROM web_push_claims WHERE endpoint_hash=?${suffix}`,[endpoint]);
      for(const id of [...new Set(expired.map(c=>c.subscription_id))].sort())await tx.get(`SELECT id FROM push_subscriptions WHERE id=? AND user_id=?${suffix}`,[id,owner]);
      for(const c of expired)await tx.get(`SELECT id FROM web_push_challenges WHERE id=? AND user_id=?${suffix}`,[c.id,owner]);
      for(const c of expired)await tx.get(`SELECT challenge_id FROM web_push_setup_operations WHERE challenge_id=?${suffix}`,[c.id]);
      for(const c of expired)await tx.run('DELETE FROM web_push_challenges WHERE id=? AND user_id=?',[c.id,owner]);
    },{signal});
    // Neutral purge is the approved ownerless authority-only exception. Never
    // infer a VACANT incarnation from absence or delete a referenced authority.
    await database.transaction(async tx=>{
      const cutoff=iso((await clock(tx))-86400000);
      const rows=await tx.all(`SELECT endpoint_hash FROM web_push_claims c WHERE state='VACANT' AND updated_at<? AND NOT EXISTS(SELECT 1 FROM web_push_challenges h WHERE h.endpoint_hash=c.endpoint_hash) ORDER BY endpoint_hash LIMIT 100${suffix}${suffix?' SKIP LOCKED':''}`,[cutoff]);
      for(const row of rows)await tx.run("DELETE FROM web_push_claims WHERE endpoint_hash=? AND state='VACANT' AND updated_at<? AND NOT EXISTS(SELECT 1 FROM web_push_challenges WHERE endpoint_hash=?)",[row.endpoint_hash,cutoff,row.endpoint_hash]);
    },{signal});
  }
  async function execute(action,body,{owner,token,address,signal}={}) {
    const input=parse(action,body),redeem=action==='redeem-handoff';
    if (!redeem&&(typeof owner!=='string'||!owner||owner.length>256||typeof token!=='string'||!token))throw fail('SETUP_UNAUTHORIZED',401);
    const hashes=redeem?null:commitments(owner,token,address,rateSecret);
    if(action==='issue-create')return database.transaction(async tx=>{
      database.assertTransaction(tx);
      if(!await tx.get('SELECT id FROM users WHERE id=?',[owner]))throw fail('AUTH_ACCOUNT_DELETED',401);
      const time=await clock(tx),operationId=crypto.randomUUID();if(!Number.isSafeInteger(time+120000))throw fail();input.operationId=operationId;
      const payload=Buffer.from(JSON.stringify([ADMISSION_VERSION,operationId,String(time),String(time+120000),crypto.randomBytes(32).toString('hex'),hex(admissionRequest(owner,hashes,input))]));
      return {protocol:PROTOCOL,operationId,createAdmission:payload.toString('base64url')+'.'+admissionMAC(payload).toString('base64url'),expiresAt:time+120000};
    },{signal});
    const discovery=await advisory(owner,input,action,signal);
    let heldSlot=false,sendContext;
    try {
      const result=await database.transaction(async tx=>{
        let retained;
        const guard=async()=>validateAdmission(input,owner,hashes,await clock(tx));
        if(action==='create') {
          await lockOwners(tx,discovery);
          const time=await clock(tx);
          retained=await tx.get('SELECT c.id FROM web_push_challenges c JOIN web_push_setup_operations o ON o.challenge_id=c.id WHERE c.user_id=? AND c.operation_id=?',[owner,input.operationId]);
          if(!retained)validateAdmission(input,owner,hashes,time);
        }
        let g;
        try{g=await graph(tx,discovery,action==='create'&&!retained,discovery.targetEndpoint,guard);}
        catch(error){
          if(action!=='create'||!retained||error.code!=='CLAIM_CHANGED'||await tx.get('SELECT id FROM web_push_challenges WHERE user_id=? AND operation_id=?',[owner,input.operationId]))throw error;
          await guard();g=await graph(tx,discovery,true,discovery.targetEndpoint,guard);
        }
        assertGraph(tx,g);const time=await clock(tx);
        if(action==='revoke') {
          const target=g.targets.find(t=>t.id===input.targetId);
          if(g.claim.state!=='ACTIVE'||g.claim.subscription_id!==input.targetId||g.claim.incarnation!==input.incarnation
            ||Number(g.claim.claim_revision)!==input.revision||!target||target.user_id!==owner||!target.active||target.generation!==input.generation
            ||!equal(Buffer.from(g.claim.proof_hash,'hex'),input.possessionProofHash))throw conflict();
          await cancelDeliveries(tx,target);
          await tx.run("UPDATE web_push_claims SET incarnation=?,state='VACANT',claim_revision=0,subscription_id=NULL,proof_hash=NULL,last_operation_id=NULL,confirm_hash=NULL,updated_at=? WHERE endpoint_hash=?",[crypto.randomUUID(),iso(time),discovery.endpoint]);
          await tx.run('UPDATE push_subscriptions SET active=FALSE,generation=? WHERE id=? AND user_id=?',[crypto.randomUUID(),target.id,owner]);
          return {protocol:PROTOCOL,state:'REVOKED'};
        }
        if(action==='create') {
          const existing=g.challenges.find(c=>c.operation_id===input.operationId);
          if(existing) {
            let resolved;try{resolved=operation(g,input,owner,hashes);}catch(error){if(error.code==='CLAIM_CHANGED')throw fail('OPERATION_CONFLICT',409);throw error;}
            const {c,o}=resolved;
            if(input.protocol!==PROTOCOL)throw fail('OPERATION_CONFLICT',409);
            if(hex(input.subscription.endpointHash)!==c.endpoint_hash||!equal(requestHash(c,o,input.subscription),o.request_hash))throw fail('OPERATION_CONFLICT',409);
            return publicState(g,c,o,time);
          }
          await guard();
          // An operation ID cannot silently move to a different endpoint.
          if(await tx.get('SELECT id FROM web_push_challenges WHERE user_id=? AND operation_id=?',[owner,input.operationId]))throw fail('OPERATION_CONFLICT',409);
          if(!vapidDetails.publicKey||!vapidDetails.privateKey||!vapidDetails.subject||activeSends>=2)throw fail();
          activeSends++;heldSlot=true;
          for(const c of g.challenges) {
            const o=g.ops.find(o=>o.challenge_id===c.id);
            if(o&&!o.confirm_hash&&o.cancelled_at_ms===null)await tx.run('UPDATE web_push_setup_operations SET cancelled_at_ms=? WHERE challenge_id=?',[time,c.id]);
          }
          // Bounded, already owner/authority/child-locked retention. No foreign
          // challenge scan or active target deletion and no post-quota lock.
          for(const c of g.challenges.filter(c=>Number(g.ops.find(o=>o.challenge_id===c.id)?.retain_until_ms)<=time).slice(0,100)) {
            await tx.run('DELETE FROM web_push_challenges WHERE id=? AND user_id=?',[c.id,owner]);
          }
          let target=g.targets.find(t=>t.user_id===owner&&t.endpoint===input.subscription.endpoint);
          if(target?.active && (g.claim.state!=='ACTIVE'||g.claim.subscription_id!==target.id))throw conflict();
          if(target&&!target.active&&g.claim.state==='ACTIVE'&&g.claim.subscription_id===target.id)throw conflict();
          if(!target) {
            target={id:crypto.randomUUID(),user_id:owner,endpoint:input.subscription.endpoint,keys_p256dh:input.subscription.keys.p256dh,
              keys_auth:input.subscription.keys.auth,active:false,generation:crypto.randomUUID(),disclosure:'GENERIC'};
            await tx.run('INSERT INTO push_subscriptions(id,user_id,endpoint,keys_p256dh,keys_auth,active,generation,disclosure) VALUES(?,?,?,?,?,FALSE,?,?)',
              [target.id,owner,target.endpoint,input.subscription.keys.p256dh,input.subscription.keys.auth,target.generation,'GENERIC']);g.targets.push(target);
          } else if(!target.active) {
            await tx.run('UPDATE push_subscriptions SET keys_p256dh=?,keys_auth=? WHERE id=? AND user_id=? AND active=FALSE',
              [input.subscription.keys.p256dh,input.subscription.keys.auth,target.id,owner]);
            target.keys_p256dh=input.subscription.keys.p256dh;target.keys_auth=input.subscription.keys.auth;
          }
          const proof=secret(),c={id:crypto.randomUUID(),user_id:owner,subscription_id:target.id,endpoint_hash:discovery.endpoint,
            expected_incarnation:g.claim.incarnation,expected_revision:g.claim.claim_revision,operation_id:input.operationId,expires_at:iso(time+300000)};
          const o={challenge_id:c.id,endpoint_hash:input.subscription.endpointHash,client_nonce_hash:input.nonceHash,session_hash:hashes.session,
            auth_epoch:input.authEpoch,send_state:'RESERVED',cancelled_at_ms:null,failed_confirm_count:0,retain_until_ms:time+86400000};
          o.request_hash=requestHash(c,o,input.subscription);
          await tx.run('INSERT INTO web_push_challenges(id,user_id,subscription_id,endpoint_hash,expected_incarnation,proof_hash,expected_revision,operation_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
            [c.id,owner,target.id,c.endpoint_hash,c.expected_incarnation,hex(sha(bytes(proof,32))),c.expected_revision,c.operation_id,c.expires_at,iso(time)]);
          await tx.run('INSERT INTO web_push_setup_operations(challenge_id,endpoint_hash,client_nonce_hash,session_hash,request_hash,auth_epoch,retain_until_ms) VALUES(?,?,?,?,?,?,?)',
            [c.id,o.endpoint_hash,o.client_nonce_hash,o.session_hash,o.request_hash,o.auth_epoch,o.retain_until_ms]);
          await quotas(tx,hashes,discovery.endpoint,time);
          sendContext={c,o,proof,subscription:input.subscription};
          return publicState(g,c,o,time);
        }
        const {c,o}=operation(g,input,discovery.owner,hashes,redeem);
        if(action==='status')return publicState(g,c,o,time);
        if(action==='cancel') {
          const current=publicState(g,c,o,time);
          if(current.state!=='CONFIRMED')await tx.run('UPDATE web_push_setup_operations SET cancelled_at_ms=COALESCE(cancelled_at_ms,?) WHERE challenge_id=?',[time,c.id]);
          return current.state==='CONFIRMED'?current:{...current,state:'CANCELLED'};
        }
        if(action==='confirm') {
          if(hex(input.subscription.endpointHash)!==c.endpoint_hash||!equal(requestHash(c,o,input.subscription),o.request_hash))throw fail('OPERATION_CONFLICT',409);
          const confirmation=confirmHash(c,o,input.proofHash,input.nextPossessionProofHash);
          if(o.confirm_hash) {if(!equal(o.confirm_hash,confirmation))throw conflict();return publicState(g,c,o,time);}
          pending(g,c,o,time);
          if(!equal(Buffer.from(c.proof_hash,'hex'),input.proofHash)) {
            await tx.run('UPDATE web_push_setup_operations SET failed_confirm_count=failed_confirm_count+1,cancelled_at_ms=CASE WHEN failed_confirm_count=4 THEN ? ELSE cancelled_at_ms END WHERE challenge_id=?',[time,c.id]);
            return {error:'SETUP_PROOF_INVALID'};
          }
          const target=g.targets.find(t=>t.id===c.subscription_id),previous=g.targets.find(t=>t.id===g.claim.subscription_id);
          if(!target||target.user_id!==owner||target.endpoint!==input.subscription.endpoint)throw conflict();
          if(Number(g.claim.claim_revision)>=MAX_REVISION)throw fail('REVISION_EXHAUSTED',409);
          if(previous) {await cancelDeliveries(tx,previous);if(previous.id!==target.id)await tx.run('UPDATE push_subscriptions SET active=FALSE WHERE id=? AND user_id=?',[previous.id,previous.user_id]);}
          const generation=crypto.randomUUID(),incarnation=crypto.randomUUID(),revision=Number(g.claim.claim_revision)+1;
          await tx.run('UPDATE web_push_challenges SET consumed_at=? WHERE id=?',[iso(time),c.id]);
          await tx.run('UPDATE push_subscriptions SET keys_p256dh=?,keys_auth=?,active=TRUE,generation=? WHERE id=? AND user_id=?',
            [input.subscription.keys.p256dh,input.subscription.keys.auth,generation,target.id,owner]);
          await tx.run("UPDATE web_push_claims SET incarnation=?,state='ACTIVE',claim_revision=?,proof_hash=?,subscription_id=?,last_operation_id=?,confirm_hash=?,updated_at=? WHERE endpoint_hash=?",
            [incarnation,revision,input.nextPossessionProofHash,target.id,input.operationId,confirmation,iso(time),discovery.endpoint]);
          await tx.run('UPDATE web_push_setup_operations SET confirm_hash=?,result_generation=?,result_revision=?,result_incarnation=? WHERE challenge_id=?',[confirmation,generation,revision,incarnation,c.id]);
          return {protocol:PROTOCOL,operationId:c.operation_id,challengeId:c.id,state:'CONFIRMED',targetId:target.id,generation,revision,incarnation};
        }
        pending(g,c,o,time);
        if(action==='authorize-handoff') {
          if(Number(o.handoff_count)>=3)throw fail('SETUP_GRANT_LIMIT',409);
          const grant=secret(),until=Math.min(time+30000,millis(c.expires_at));
          await tx.run('UPDATE web_push_setup_operations SET handoff_hash=?,handoff_client_id=?,handoff_until_ms=?,handoff_consumed_at_ms=NULL,handoff_count=handoff_count+1 WHERE challenge_id=?',
            [sha(bytes(grant,32)),input.clientId,until,c.id]);
          return {protocol:PROTOCOL,challengeId:c.id,grant,expiresAt:until};
        }
        if(action==='redeem-handoff') {
          if(!equal(o.handoff_hash,input.grantHash)||o.handoff_client_id!==input.clientId||o.handoff_consumed_at_ms!==null||Number(o.handoff_until_ms)<=time)throw conflict();
          const changed=await tx.run('UPDATE web_push_setup_operations SET handoff_consumed_at_ms=? WHERE challenge_id=? AND handoff_consumed_at_ms IS NULL AND handoff_hash=? AND handoff_until_ms>?',[time,c.id,input.grantHash,time]);
          if(Number(changed.changes)!==1)throw conflict();
          return {protocol:PROTOCOL,challengeId:c.id,operationId:c.operation_id,clientId:input.clientId,authEpoch:o.auth_epoch,clientNonceHash:hex(o.client_nonce_hash),endpointHash:c.endpoint_hash,expiresAt:millis(c.expires_at)};
        }
        throw fail('SETUP_INVALID',400);
      },{signal});
      if(sendContext){await sendOnce(sendContext,input,discovery,hashes,signal);await cleanup(owner,signal);}
      return result;
    } finally {if(heldSlot)activeSends--;}
  }
  async function sendOnce(context,input,discovery,hashes,signal) {
    const observedBefore=now();
    const admitted=await database.transaction(async tx=>{
      const g=await graph(tx,discovery,false,context.subscription.endpoint);const time=await clock(tx);
      const {c,o}=operation(g,input,discovery.owner,hashes);pending(g,c,o,time);
      if(!equal(o.request_hash,context.o.request_hash)||o.send_state!=='RESERVED')return null;
      const changed=await tx.run("UPDATE web_push_setup_operations SET send_state='ATTEMPTED',send_attempted_at_ms=? WHERE challenge_id=? AND send_state='RESERVED'",[time,c.id]);
      return Number(changed.changes)===1?{remaining:millis(c.expires_at)-time}:null;
    },{signal});
    if(!admitted)return;
    let outcome='UNKNOWN';
    try {
      const authority=transport.createSetupExpiryAuthority(observedBefore,admitted.remaining);
      const payload=JSON.stringify({title:'Forged Hybrid',body:'Open Forge to finish enabling notifications.',url:'/more',notificationId:`forge-push-setup:${context.c.id}`,
        setup:{protocol:PROTOCOL,challengeId:context.c.id,operationId:input.operationId,clientNonceHash:hex(input.nonceHash),authEpoch:input.authEpoch,
          endpointHash:discovery.endpoint,secret:context.proof,expiresAt:millis(context.c.expires_at)}});
      await send({endpoint:context.subscription.endpoint,keys:context.subscription.keys},payload,{vapidDetails,signal,setupExpiryAuthority:authority,
        beforeSend:()=>database.transaction(async tx=>{
          const g=await graph(tx,discovery,false,context.subscription.endpoint),time=await clock(tx);
          const {c,o}=operation(g,input,discovery.owner,hashes);pending(g,c,o,time);
          return o.send_state==='ATTEMPTED'&&equal(o.request_hash,context.o.request_hash);
        },{signal})});
      outcome='ACCEPTED';
    } catch(error) {
      if(transport.expiredEndpoint(error)||transport.configurationFailure(error)||['WEB_PUSH_SETUP_EXPIRED','WEB_PUSH_SETUP_AUTHORITY_INVALID','WEB_PUSH_TARGET_STALE','WEB_PUSH_ENDPOINT_INVALID','WEB_PUSH_REQUEST_INVALID','WEB_PUSH_DNS_UNSAFE','WEB_PUSH_DNS_FAILED'].includes(error.code))outcome='FAILED';
    }
    // A cancelled/unknown result cannot be recovered by a new send. Status is
    // readback only; ATTEMPTED is conservatively exposed as UNKNOWN.
    await database.transaction(async tx=>{
      const g=await graph(tx,discovery,false,context.subscription.endpoint);const {c,o}=operation(g,input,discovery.owner,hashes);
      if(o.send_state==='ATTEMPTED'&&!o.confirm_hash&&o.cancelled_at_ms===null
        &&g.claim.incarnation===c.expected_incarnation&&String(g.claim.claim_revision)===String(c.expected_revision)) {
        await tx.run('UPDATE web_push_setup_operations SET send_state=? WHERE challenge_id=? AND send_state=? AND cancelled_at_ms IS NULL AND confirm_hash IS NULL',[outcome,c.id,'ATTEMPTED']);
      }
    },{signal});
  }
  return Object.freeze({execute});
}
module.exports={createWebPushSetup,PROTOCOL};
