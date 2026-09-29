'use strict';
const crypto=require('node:crypto');
const lifecycle=require('./stravaConnectionLifecycle');
const {createUserNotificationInTransaction}=require('./notifications');
const {getStravaProviderClient}=require('./stravaProviderClient');
const REFRESH_LEASE_MS=60000; // Separate from the event job's120s lease; HTTP is bounded20s.
function error(code='STRAVA_CONNECTION_STALE',status=409) {
  return Object.assign(new Error('Strava connection is unavailable'),{code,status});
}
function createStravaConnectionService({withUserMutation,provider,env=()=>process.env,now=()=>Date.now()}) {
  const captures=new WeakSet();
  const owner=(userId,fn)=>withUserMutation(userId,fn,{userLock:'update'});
  function config() {
    const values=env();
    for(const key of ['JWT_SECRET','STRAVA_CLIENT_ID','STRAVA_CLIENT_SECRET','STRAVA_REDIRECT_URI'])
      if(typeof values[key]!=='string'||!values[key].trim())throw error('STRAVA_CONFIG_UNAVAILABLE',503);
    try {
      const uri=new URL(values.STRAVA_REDIRECT_URI);
      if(uri.protocol!=='https:'||uri.username||uri.password||uri.hash||!/^[0-9]+$/.test(values.STRAVA_CLIENT_ID))throw Error();
    }catch{throw error('STRAVA_CONFIG_UNAVAILABLE',503);}
    return values;
  }
  function encrypt(value) {
    const key=crypto.createHash('sha256').update(config().JWT_SECRET).digest(),iv=crypto.randomBytes(12);
    const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
    const content=Buffer.concat([cipher.update(JSON.stringify({token:value}),'utf8'),cipher.final()]);
    return JSON.stringify({v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),content:content.toString('base64')});
  }
  function decode(value) {
    if(typeof value!=='string'||!value||value.length>32768)throw error('STRAVA_TOKEN_INVALID',503);
    if(!value.trim().startsWith('{'))return {token:value,encrypted:false};
    try {
      const p=JSON.parse(value);if(p.v!==1)throw Error();
      const decipher=crypto.createDecipheriv('aes-256-gcm',crypto.createHash('sha256').update(config().JWT_SECRET).digest(),Buffer.from(p.iv,'base64'));
      decipher.setAuthTag(Buffer.from(p.tag,'base64'));
      const parsed=JSON.parse(Buffer.concat([decipher.update(Buffer.from(p.content,'base64')),decipher.final()]).toString('utf8'));
      if(typeof parsed.token!=='string'||!parsed.token)throw Error();
      return {token:parsed.token,encrypted:true};
    } catch {throw error('STRAVA_TOKEN_INVALID',503);}
  }
  const validId=value=>(typeof value==='string'&&/^[1-9][0-9]{0,14}$/.test(value))||(Number.isSafeInteger(value)&&value>0);
  function tokens(payload,{athleteRequired=false,athleteId}={}) {
    for(const key of ['access_token','refresh_token'])if(typeof payload?.[key]!=='string'||!payload[key]||payload[key].length>16384||/[\r\n]/.test(payload[key]))throw error('STRAVA_TOKEN_RESPONSE_INVALID',502);
    if(!Number.isSafeInteger(payload.expires_at)||payload.expires_at<=Math.floor(now()/1000))throw error('STRAVA_TOKEN_RESPONSE_INVALID',502);
    if(athleteRequired&&!validId(payload.athlete?.id))throw error('STRAVA_ATHLETE_RESPONSE_INVALID',502);
    if(payload.athlete!==undefined&&(!validId(payload.athlete?.id)||(athleteId!==undefined&&String(payload.athlete.id)!==String(athleteId))))throw error('STRAVA_ATHLETE_RESPONSE_INVALID',502);
    return payload;
  }
  function changed(result){if(Number(result.changes??result.rowCount)!==1)throw error();}
  async function start(userId,{returnLink=null}={}) {
    const settings=config();
    return owner(userId,tx=>lifecycle.start(tx,userId,{secret:settings.JWT_SECRET,returnLink,now:Math.floor(now()/1000)}));
  }
  function verify(raw) {return lifecycle.verifyState(raw,config().JWT_SECRET,Math.floor(now()/1000));}
  async function cancel(proof){return owner(proof.user_id,tx=>lifecycle.consume(tx,proof,Math.floor(now()/1000)));}
  async function callback(proof,code,{signal}={}) {
    const settings=config();
    if(typeof code!=='string'||!code.trim()||code.length>2048)throw error('STRAVA_CODE_INVALID',400);
    await owner(proof.user_id,tx=>lifecycle.assertAttempt(tx,proof,Math.floor(now()/1000)));
    const payload=tokens(await provider.request('token',{clientId:settings.STRAVA_CLIENT_ID,clientSecret:settings.STRAVA_CLIENT_SECRET,code},{signal}),{athleteRequired:true});
    if(signal?.aborted)throw error('STRAVA_REQUEST_ABORTED',503);
    const generation=crypto.randomUUID(),athleteId=String(payload.athlete.id);
    const athleteName=[payload.athlete.firstname,payload.athlete.lastname].filter(v=>typeof v==='string').join(' ').trim().slice(0,200)||null;
    const access=encrypt(payload.access_token),refresh=encrypt(payload.refresh_token);
    await owner(proof.user_id,async tx=>{
      if(signal?.aborted)throw error('STRAVA_REQUEST_ABORTED',503);
      await lifecycle.consume(tx,proof,Math.floor(now()/1000));
      await tx.run(`INSERT INTO strava_tokens(user_id,access_token,refresh_token,expires_at,athlete_id,athlete_name,connected_at,connection_generation,token_revision,refresh_lease_token,refresh_lease_until)
        VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP,?,1,NULL,NULL) ON CONFLICT(user_id) DO UPDATE SET access_token=excluded.access_token,refresh_token=excluded.refresh_token,
        expires_at=excluded.expires_at,athlete_id=excluded.athlete_id,athlete_name=excluded.athlete_name,connected_at=CURRENT_TIMESTAMP,
        connection_generation=excluded.connection_generation,token_revision=1,refresh_lease_token=NULL,refresh_lease_until=NULL`,
        [proof.user_id,access,refresh,payload.expires_at,athleteId,athleteName,generation]);
      await tx.run('INSERT INTO strava_ingress_bindings(id,user_id,athlete_id) VALUES(?,?,?)',[generation,proof.user_id,athleteId]);
    });
    return {athleteName};
  }
  async function read(tx,userId,{upgrade=true}={}) {
    let row=await tx.get('SELECT * FROM strava_tokens WHERE user_id=?',[userId]);
    if(!row)throw error('STRAVA_NOT_CONNECTED',400);
    const access=decode(row.access_token),refresh=decode(row.refresh_token);
    const revision=Number(row.token_revision);
    if(!Number.isSafeInteger(revision)||revision<1||revision>=Number.MAX_SAFE_INTEGER)throw error();
    if(upgrade&&(!access.encrypted||!refresh.encrypted)&&row.refresh_lease_token===null) {
      changed(await tx.run(`UPDATE strava_tokens SET access_token=?,refresh_token=?,token_revision=token_revision+1
        WHERE user_id=? AND connection_generation=? AND token_revision=? AND refresh_lease_token IS NULL`,
        [encrypt(access.token),encrypt(refresh.token),userId,row.connection_generation,revision]));
      row={...row,token_revision:revision+1};
    }
    const proof=await lifecycle.captureConnection(tx,userId);
    const capture=Object.freeze({row:Object.freeze({...row,access_token:access.token,refresh_token:refresh.token}),proof,userId});
    captures.add(capture);return capture;
  }
  async function connection(userId){config();return owner(userId,tx=>read(tx,userId));}
  function trusted(capture){if(!captures.has(capture))throw error();}
  async function refresh(capture,{force=false,signal}={}) {
    trusted(capture);const settings=config();
    if(!force&&Number(capture.row.expires_at)>Math.floor(now()/1000)+30)return capture;
    const lease=crypto.randomUUID(),until=now()+REFRESH_LEASE_MS;
    await owner(capture.userId,async tx=>{
      const row=await tx.get('SELECT * FROM strava_tokens WHERE user_id=?',[capture.userId]);
      if(!row||row.connection_generation!==capture.row.connection_generation||Number(row.token_revision)!==Number(capture.row.token_revision))throw error();
      if(row.refresh_lease_token!==null && Date.parse(row.refresh_lease_until)>now())throw error('STRAVA_REFRESH_BUSY',503);
      changed(await tx.run(`UPDATE strava_tokens SET refresh_lease_token=?,refresh_lease_until=? WHERE user_id=? AND connection_generation=? AND token_revision=?`,
        [lease,new Date(until).toISOString(),capture.userId,row.connection_generation,row.token_revision]));
    });
    let payload;
    try {
      payload=tokens(await provider.request('token',{clientId:settings.STRAVA_CLIENT_ID,clientSecret:settings.STRAVA_CLIENT_SECRET,refreshToken:capture.row.refresh_token},{signal}),{athleteId:capture.row.athlete_id});
    } catch(failure) {
      // Release only our lease; never erase credentials on token-endpoint401.
      await owner(capture.userId,tx=>tx.run(`UPDATE strava_tokens SET refresh_lease_token=NULL,refresh_lease_until=NULL
        WHERE user_id=? AND connection_generation=? AND token_revision=? AND refresh_lease_token=?`,
        [capture.userId,capture.row.connection_generation,capture.row.token_revision,lease])).catch(()=>{throw error('STRAVA_REFRESH_RECOVERY_REQUIRED',503);});
      throw failure;
    }
    const access=encrypt(payload.access_token),refreshToken=encrypt(payload.refresh_token);
    return owner(capture.userId,async tx=>{
      if(signal?.aborted||now()>=until)throw error('STRAVA_REFRESH_STALE');
      const current=await tx.get('SELECT refresh_lease_until FROM strava_tokens WHERE user_id=? AND connection_generation=? AND token_revision=? AND refresh_lease_token=?',
        [capture.userId,capture.row.connection_generation,capture.row.token_revision,lease]);
      if(!current||Date.parse(current.refresh_lease_until)!==until)throw error('STRAVA_REFRESH_STALE');
      changed(await tx.run(`UPDATE strava_tokens SET access_token=?,refresh_token=?,expires_at=?,token_revision=token_revision+1,refresh_lease_token=NULL,refresh_lease_until=NULL
        WHERE user_id=? AND connection_generation=? AND token_revision=? AND refresh_lease_token=?`,
        [access,refreshToken,payload.expires_at,capture.userId,capture.row.connection_generation,capture.row.token_revision,lease]));
      return read(tx,capture.userId,{upgrade:false});
    });
  }
  async function verifyRevocation(capture,{signal}={}) {
    trusted(capture);let current=capture;
    try {current=await refresh(capture,{signal});}
    catch(e){if(!['STRAVA_PROVIDER_REJECTED'].includes(e.code)||![400,401,403].includes(e.status))throw e;}
    if(current.proof.epoch!==capture.proof.epoch)throw error();
    try {
      const athlete=await provider.request('athlete',{accessToken:current.row.access_token},{signal});
      if(!validId(athlete.id)||String(athlete.id)!==String(current.row.athlete_id))throw error('STRAVA_ATHLETE_RESPONSE_INVALID',502);
      return false;
    } catch(e) {
      // Only this dedicated authenticated current-athlete verification can
      // establish revocation. A list/stream/token401 is never sufficient.
      if(e.code!=='STRAVA_PROVIDER_REJECTED'||![401,403].includes(e.status))throw e;
    }
    if(signal?.aborted)throw error('STRAVA_REQUEST_ABORTED',503);
    await owner(current.userId,async tx=>{
      await lifecycle.revokeVerified(tx,current.proof);
      await createUserNotificationInTransaction(tx,current.userId,{type:'connection',title:'Strava disconnected',
        body:'Reconnect Strava to keep background activity sync active.',href:'/more',sourceKey:`strava:deauthorization:${current.row.connection_generation}`});
    });
    return true;
  }
  const disconnect=userId=>owner(userId,tx=>lifecycle.disconnect(tx,userId));
  return Object.freeze({start,verify,cancel,callback,connection,refresh,verifyRevocation,disconnect});
}
let shared;
function getStravaConnectionService(){
  if(!shared)shared=createStravaConnectionService({withUserMutation:require('../db').withUserMutation,provider:getStravaProviderClient()});
  return shared;
}
module.exports={createStravaConnectionService,getStravaConnectionService,REFRESH_LEASE_MS};
