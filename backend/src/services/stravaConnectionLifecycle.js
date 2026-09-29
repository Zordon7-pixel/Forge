'use strict';

// B1c prerequisite. Transaction-only owner lifecycle; no network, route, worker,
// provider trust flag or physiological revision is introduced by this module.
const crypto = require('node:crypto');
const DOMAIN = 'forge:strava:oauth-state:v2\0';
const EPOCH = /^[a-f0-9]{64}$/;
const CAP = 4096;
const stateProofs = new WeakSet();
const connectionProofs = new WeakSet();
function failure(code = 'STRAVA_CONNECTION_ATTEMPT_STALE') {
  return Object.assign(new Error('Strava connection authority is unavailable'), { code, status:409 });
}
function secretKey(secret) {
  if (typeof secret !== 'string' || !secret.trim()) throw failure('STRAVA_SIGNING_UNAVAILABLE');
  return secret;
}
function ownerId(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw failure();
  return value;
}
function deepLink(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || value !== value.trim() || !value.length || value.length > 512
    || !/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) throw failure('STRAVA_RETURN_LINK_INVALID');
  return value;
}
function nonce(previous) {
  const value = crypto.randomBytes(32).toString('hex');
  if (!EPOCH.test(value) || value === previous) throw failure('STRAVA_EPOCH_UNAVAILABLE');
  return value;
}
function seconds(now) {
  if (!Number.isSafeInteger(now) || now < 0) throw failure('STRAVA_CLOCK_INVALID');
  return now;
}
function stateShape(value, now) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'deeplink,epoch,exp,user_id,v'
    || value.v !== 2 || typeof value.epoch !== 'string' || !EPOCH.test(value.epoch)
    || !Number.isSafeInteger(value.exp) || value.exp <= now || value.exp > now + 600) throw failure();
  ownerId(value.user_id); deepLink(value.deeplink);
}
function encodeState(value, secret, now) {
  secretKey(secret); stateShape(value, seconds(now));
  const body = Buffer.from(JSON.stringify(value),'utf8').toString('base64url');
  const signature = crypto.createHmac('sha256',secret).update(DOMAIN).update(body).digest('base64url');
  const result = `${body}.${signature}`;
  if (Buffer.byteLength(result) > CAP) throw failure('STRAVA_STATE_SIZE');
  return result;
}
function verifyState(raw, secret, now = Math.floor(Date.now()/1000)) {
  secretKey(secret); seconds(now);
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > CAP) throw failure();
  const parts = raw.split('.');
  if (parts.length !== 2 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p)
    || Buffer.from(p,'base64url').toString('base64url') !== p)) throw failure();
  const [body, encodedSignature] = parts;
  const signature = Buffer.from(encodedSignature,'base64url');
  const expected = crypto.createHmac('sha256',secret).update(DOMAIN).update(body).digest();
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature,expected)) throw failure();
  let value;
  try { value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(body,'base64url'))); }
  catch { throw failure(); }
  stateShape(value,now);
  const proof = Object.freeze(value); stateProofs.add(proof); return proof;
}
async function lockedOwner(tx, userId) {
  ownerId(userId);
  // Runtime caller owns the UPDATE transaction. Requiring the row here also
  // prevents standalone callback helpers from recreating a deleted account.
  if (!(await tx.get('SELECT id FROM users WHERE id=?',[userId]))) throw failure('AUTH_ACCOUNT_DELETED');
}
async function fence(tx, userId, {create=false} = {}) {
  await lockedOwner(tx,userId);
  let row = await tx.get('SELECT epoch FROM strava_connection_fences WHERE user_id=?',[userId]);
  if (!row && create) {
    if (await tx.get('SELECT user_id FROM strava_tokens WHERE user_id=?',[userId])) throw failure('STRAVA_FENCE_MISSING');
    row = {epoch:nonce()};
    await tx.run('INSERT INTO strava_connection_fences(user_id,epoch) VALUES(?,?)',[userId,row.epoch]);
  }
  if (!row || !EPOCH.test(row.epoch)) throw failure('STRAVA_FENCE_MISSING');
  return row.epoch;
}
async function rotate(tx, userId, before, after) {
  const changed = await tx.run('UPDATE strava_connection_fences SET epoch=? WHERE user_id=? AND epoch=?',[after,userId,before]);
  if (Number(changed.changes ?? changed.rowCount) !== 1) throw failure();
}
async function start(tx, userId, {secret,returnLink=null,now=Math.floor(Date.now()/1000)} = {}) {
  secretKey(secret); seconds(now); const link=deepLink(returnLink);
  const before=await fence(tx,userId,{create:true}); const next=nonce(before);
  // Encoding/config/size failure occurs before rotation; caller must roll back
  // this whole owner transaction, including first-ever fence creation.
  const state=encodeState({v:2,user_id:userId,deeplink:link,exp:now+600,epoch:next},secret,now);
  await rotate(tx,userId,before,next); return state;
}
async function assertAttempt(tx, proof, now=Math.floor(Date.now()/1000)) {
  if (!stateProofs.has(proof)) throw failure();
  stateShape(proof,seconds(now));
  if (await fence(tx,proof.user_id) !== proof.epoch) throw failure();
  return proof.user_id;
}
async function consume(tx, proof, now=Math.floor(Date.now()/1000)) {
  const userId=await assertAttempt(tx,proof,now);
  await rotate(tx,userId,proof.epoch,nonce(proof.epoch));
  return userId;
}
async function disconnect(tx,userId) {
  const before=await fence(tx,userId,{create:true});
  await rotate(tx,userId,before,nonce(before));
  await tx.run('DELETE FROM strava_tokens WHERE user_id=?',[userId]);
}
async function captureConnection(tx,userId) {
  const epoch=await fence(tx,userId);
  const row=await tx.get('SELECT connection_generation,token_revision FROM strava_tokens WHERE user_id=?',[userId]);
  if (!row || typeof row.connection_generation !== 'string' || !row.connection_generation
    || !Number.isSafeInteger(Number(row.token_revision)) || Number(row.token_revision)<1) throw failure('STRAVA_CONNECTION_STALE');
  const proof=Object.freeze({userId,epoch,generation:row.connection_generation,revision:Number(row.token_revision)});
  connectionProofs.add(proof);return proof;
}
async function revokeVerified(tx,proof) {
  if (!connectionProofs.has(proof)) throw failure('STRAVA_CONNECTION_STALE');
  if (await fence(tx,proof.userId) !== proof.epoch) throw failure('STRAVA_CONNECTION_STALE');
  const result=await tx.run('DELETE FROM strava_tokens WHERE user_id=? AND connection_generation=? AND token_revision=?',
    [proof.userId,proof.generation,proof.revision]);
  if (Number(result.changes ?? result.rowCount)!==1) throw failure('STRAVA_CONNECTION_STALE');
  // Intentionally preserve epoch: a newer pending reconnect may have started
  // BEFORE this proof was captured. Token triggers retire only that binding.
}

module.exports={start,verifyState,assertAttempt,consume,disconnect,captureConnection,revokeVerified};
