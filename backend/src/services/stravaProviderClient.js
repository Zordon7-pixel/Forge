'use strict';
const { performance } = require('node:perf_hooks');

// One provider-wide reservation authority. All network work starts only after
// the control-only transaction commits; reservations are never refunded.
const REQUEST_MS = 20000;
const BODY_BYTES = 4 * 1024 * 1024;
const QUARTER_MS = 900000;
const DAY_MS = 86400000;
const rejectedResponses=new WeakMap();
// Status authority cannot be manufactured by a callback body or Error.status.
function providerRejection(error){return rejectedResponses.get(error)||null;}
function failure(code, status = 503, retryAt) {
  return Object.assign(new Error('Strava is temporarily unavailable'), { code, status, retryAt });
}
function instant(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string') throw failure('STRAVA_CONTROL_INVALID');
  const normalized = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const n = Date.parse(/[Zz]|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`);
  if (!Number.isFinite(n)) throw failure('STRAVA_CONTROL_INVALID');
  return n;
}
const iso = value => new Date(value).toISOString();
function count(value) {
  const n = Number(value);
  if (value === null || !Number.isSafeInteger(n) || n < 0) throw failure('STRAVA_CONTROL_INVALID');
  return n;
}
function pair(value) {
  if (typeof value !== 'string' || !/^\d{1,9},\s*\d{1,9}$/.test(value)) return null;
  return value.split(',').map(Number);
}
function limitState(row) {
  function integer(value, maximum) {
    if (!((typeof value === 'number' || (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)))
      && Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= maximum)) throw failure('STRAVA_CONTROL_INVALID');
    return Number(value);
  }
  return { quarterCap: row.observed_quarter_cap === null ? 60 : integer(row.observed_quarter_cap,60),
    dayCap: row.observed_day_cap === null ? 600 : integer(row.observed_day_cap,600),
    epoch: integer(row.provider_limits_epoch,9000000000000000) };
}
function createStravaProviderClient({ withTransaction, fetchImpl = (...args) => fetch(...args), dialect = 'postgres' }) {
  const transact = fn => withTransaction(fn, { skipContextUserGuard: true });
  const clockSql = dialect === 'sqlite' ? "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now" : 'SELECT clock_timestamp() AS now';
  async function locked(tx) {
    if (dialect === 'postgres') {
      await tx.run("SET LOCAL lock_timeout='150ms'");
      await tx.run("SET LOCAL statement_timeout='750ms'");
      await tx.run("SET LOCAL idle_in_transaction_session_timeout='1000ms'");
    }
    const updated = await tx.run("UPDATE background_sync_control SET next_allowed_at=next_allowed_at WHERE id='strava'");
    if (Number(updated.changes ?? updated.rowCount) !== 1) throw failure('STRAVA_CONTROL_MISSING');
    const row = await tx.get("SELECT * FROM background_sync_control WHERE id='strava'");
    const now = instant((await tx.get(clockSql)).now);
    const quarter = Math.floor(now / QUARTER_MS) * QUARTER_MS;
    const day = Math.floor(now / DAY_MS) * DAY_MS;
    return { row, now, quarter, day };
  }
  async function reserve() {
    return transact(async tx => {
      const { row, now, quarter, day } = await locked(tx);
      const {quarterCap,dayCap,epoch}=limitState(row);
      if (row.paused === true || row.paused === 1) throw failure('STRAVA_PROVIDER_PAUSED');
      const q = instant(row.quarter_start) === quarter ? count(row.quarter_used) : 0;
      const d = instant(row.day_start) === day ? count(row.day_used) : 0;
      const allowed = Math.max(instant(row.next_allowed_at), q >= quarterCap ? quarter + QUARTER_MS : 0, d >= dayCap ? day + DAY_MS : 0);
      if (now < allowed) throw Object.assign(failure('STRAVA_QUOTA_UNAVAILABLE', 503, allowed), {
        spacingDelay: q < quarterCap && d < dayCap && allowed - now <= 1000 ? allowed - now : null,
      });
      await tx.run(`UPDATE background_sync_control SET quarter_start=?,quarter_used=?,day_start=?,day_used=?,next_allowed_at=? WHERE id='strava'`,
        [iso(quarter), q + 1, iso(day), d + 1, iso(now + 1000)]);
      return { quarter, day, provider_limits_epoch:epoch };
    });
  }
  async function observe(ticket, response) {
    const headers = response.headers;
    const get = name => headers?.get?.(name) ?? null;
    const values = ['x-ratelimit-limit','x-ratelimit-usage','x-readratelimit-limit','x-readratelimit-usage'].map(get);
    const retry = get('retry-after');
    if (values.every(v => v === null) && retry === null && response.status !== 429) return;
    await transact(async tx => {
      const { row, now, quarter, day } = await locked(tx);
      const state=limitState(row);
      let next = instant(row.next_allowed_at), q = count(row.quarter_used), d = count(row.day_used);
      let malformed = false, quarterCap=row.observed_quarter_cap, dayCap=row.observed_day_cap;
      for (let i = 0; i < 4; i += 2) {
        if (values[i] === null && values[i + 1] === null) continue;
        const limits = pair(values[i]), usage = pair(values[i + 1]);
        if (!limits || !usage || limits.some(v => v < 1)) { malformed = true; continue; }
        // Grant authority is durable within its epoch, unlike windowed usage.
        if(ticket.provider_limits_epoch===state.epoch){
          quarterCap=Math.min(quarterCap??60,limits[0]);dayCap=Math.min(dayCap??600,limits[1]);
        }
        if (ticket.quarter === quarter && instant(row.quarter_start) === quarter) q = Math.max(q, usage[0]);
        if (ticket.day === day && instant(row.day_start) === day) d = Math.max(d, usage[1]);
      }
      if(instant(row.quarter_start)===quarter && q >= (quarterCap??60))next=Math.max(next,quarter+QUARTER_MS);
      if(instant(row.day_start)===day && d >= (dayCap??600))next=Math.max(next,day+DAY_MS);
      if (retry !== null) {
        const delta = /^\d{1,5}$/.test(retry) ? Number(retry) * 1000 : NaN;
        const date = typeof retry === 'string' && /^[A-Za-z]{3}, /.test(retry) ? Date.parse(retry) : NaN;
        const until = Number.isFinite(delta) ? now + delta : date;
        if (!Number.isFinite(until) || until < now || until > now + DAY_MS) malformed = true;
        else next = Math.max(next, until);
      }
      if (malformed || (response.status === 429 && retry === null)) next = Math.max(next, quarter + QUARTER_MS);
      await tx.run(`UPDATE background_sync_control SET quarter_used=?,day_used=?,next_allowed_at=?,observed_quarter_cap=?,observed_day_cap=? WHERE id='strava'`,
        [q,d,iso(next),quarterCap,dayCap]);
    });
  }
  function endpoint(operation, input) {
    const headers = { Accept: 'application/json' };
    const objectId=['activity','streams'].includes(operation)?String(input.activityId):null;
    let url, method = 'GET', body;
    if (operation === 'token') {
      const { clientId, clientSecret, code, refreshToken } = input;
      if (!clientId || !clientSecret || (Boolean(code) === Boolean(refreshToken))) throw failure('STRAVA_REQUEST_INVALID', 400);
      url = 'https://www.strava.com/oauth/token'; method = 'POST';
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams({ client_id:clientId,client_secret:clientSecret,grant_type:code?'authorization_code':'refresh_token',
        ...(code?{code}:{refresh_token:refreshToken}) }).toString();
    } else {
      if (typeof input.accessToken !== 'string' || !input.accessToken || /[\r\n]/.test(input.accessToken)) throw failure('STRAVA_REQUEST_INVALID',400);
      headers.Authorization = `Bearer ${input.accessToken}`;
      if (operation === 'activities') url = 'https://www.strava.com/api/v3/athlete/activities?per_page=20';
      else if (operation === 'athlete') url = 'https://www.strava.com/api/v3/athlete';
      else if (['activity','streams'].includes(operation) && /^[1-9][0-9]{0,29}$/.test(objectId)) {
        url = `https://www.strava.com/api/v3/activities/${objectId}${operation==='streams'?'/streams?keys=latlng,altitude,time&key_by_type=true':''}`;
      } else throw failure('STRAVA_REQUEST_INVALID',400);
    }
    return {url,objectId,options:{method,headers,body,redirect:'error'}};
  }
  async function request(operation, input = {}, { signal, waitForSpacing = true, beforeNetwork } = {}) {
    const {url,objectId,options} = endpoint(operation,input);
    if(beforeNetwork!==undefined&&typeof beforeNetwork!=='function')throw failure('STRAVA_REQUEST_INVALID',400);
    if (signal?.aborted) throw failure('STRAVA_REQUEST_ABORTED');
    let ticket;
    try { ticket = await reserve(); }
    catch (error) {
      if (!waitForSpacing || error.code !== 'STRAVA_QUOTA_UNAVAILABLE' || !(error.spacingDelay > 0)) throw error;
      // One bounded, abortable wait outside the transaction accommodates a
      // normal token/list/detail sequence. Contention on re-reservation fails
      // closed; this is neither a quota wait loop nor a provider retry.
      await new Promise((resolve, reject) => {
        const notBefore = performance.now() + error.spacingDelay;
        let timer;
        const aborted = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(failure('STRAVA_REQUEST_ABORTED')); };
        const wake = () => {
          // Timers are wake-up hints, not proof that the full interval elapsed.
          // Rearm only the remainder of this one budget; never reserve early.
          const remaining = notBefore - performance.now();
          if (remaining > 0) { timer = setTimeout(wake, Math.ceil(remaining)); return; }
          signal?.removeEventListener('abort', aborted); resolve();
        };
        timer = setTimeout(wake, Math.ceil(error.spacingDelay));
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) aborted();
      });
      ticket = await reserve();
    }
    if (signal?.aborted) throw failure('STRAVA_REQUEST_ABORTED');
    // This private worker hook follows a known reservation COMMIT. Its own
    // bounded job→control transaction must commit before any HTTP is opened.
    if(beforeNetwork)await beforeNetwork(Object.freeze({operation,objectId}));
    if (signal?.aborted) throw failure('STRAVA_REQUEST_ABORTED');
    const controller = new AbortController();
    let timer, rejectDeadline;
    const deadline = new Promise((_,reject) => { rejectDeadline=reject; });
    function stop(code) { controller.abort(); rejectDeadline(failure(code)); }
    const onAbort = () => stop('STRAVA_REQUEST_ABORTED');
    signal?.addEventListener('abort',onAbort,{once:true});
    timer = setTimeout(()=>stop('STRAVA_REQUEST_TIMEOUT'),REQUEST_MS);
    try {
      if(signal?.aborted)onAbort();
      return await Promise.race([deadline,(async()=>{
        const response = await fetchImpl(url,{...options,signal:controller.signal});
        if(controller.signal.aborted)throw failure('STRAVA_REQUEST_ABORTED');
        await observe(ticket,response);
        if(controller.signal.aborted)throw failure('STRAVA_REQUEST_ABORTED');
        let text = '';
        if (response.body?.getReader) {
          const reader=response.body.getReader(); let size=0; const chunks=[];
          const cancelReader=()=>reader.cancel().catch(()=>console.warn('[strava/provider] response reader cancellation unavailable'));
          controller.signal.addEventListener('abort',cancelReader,{once:true});
          try { while(true) { const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
            if(size>BODY_BYTES)throw failure('STRAVA_RESPONSE_TOO_LARGE',502);chunks.push(Buffer.from(part.value)); }
            // A bounded completed negative response does not require JSON or
            // valid UTF-8; truncated/oversized/timed-out bodies remain unknown.
            if(response.ok)text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));
          } finally { controller.signal.removeEventListener('abort',cancelReader);cancelReader(); }
        } else {
          text=await response.text(); if(Buffer.byteLength(text)>BODY_BYTES)throw failure('STRAVA_RESPONSE_TOO_LARGE',502);
        }
        if(controller.signal.aborted)throw failure('STRAVA_REQUEST_ABORTED');
        if(!response.ok){
          if(!Number.isInteger(response.status)||response.status<400||response.status>599)throw failure('STRAVA_RESPONSE_INVALID',502);
          const rejected=failure('STRAVA_PROVIDER_REJECTED',response.status);
          rejectedResponses.set(rejected,Object.freeze({status:response.status,operation,objectId}));
          throw rejected;
        }
        let payload;try{payload=JSON.parse(text);}catch{throw failure('STRAVA_RESPONSE_INVALID',502);}
        if(payload===null || typeof payload!=='object')throw failure('STRAVA_RESPONSE_INVALID',502);
        if(operation==='activities' && (!Array.isArray(payload) || payload.length>20 || payload.some(row=>!row || typeof row!=='object' || Array.isArray(row))))throw failure('STRAVA_RESPONSE_INVALID',502);
        if(operation!=='activities' && Array.isArray(payload))throw failure('STRAVA_RESPONSE_INVALID',502);
        return payload;
      })()]);
    } finally { clearTimeout(timer); signal?.removeEventListener('abort',onAbort); controller.abort(); }
  }
  return Object.freeze({request});
}
let shared;
function getStravaProviderClient() {
  if(!shared)shared=createStravaProviderClient({withTransaction:require('../db').withTransaction});
  return shared;
}
module.exports={createStravaProviderClient,getStravaProviderClient,providerRejection,REQUEST_MS,BODY_BYTES};
