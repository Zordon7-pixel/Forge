'use strict';

// Caller owns the existing owner-locked transaction. These helpers never commit,
// fetch a provider, or send a push. A later worker's final lease CAS belongs in
// this same transaction so a stale job rolls back the complete saved-run graph.

const { randomUUID } = require('node:crypto');
const { createUserNotificationInTransaction } = require('./notifications');
const { buildRunImportKeys } = require('../lib/runImportKey');

function conflict(code) { const error=new Error(code); error.code=code; throw error; }
function epoch(value, database=false) {
  if (database && value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if(typeof value!=='string')return null;
  let text=value.trim();
  if(database)text=text.replace(' ','T').replace(/([+-]\d{2})$/,'$1:00');
  if(database && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?$/.test(text))text+='Z'; // SQLite DB default is UTC.
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(text))return null;
  const [year,month,day]=text.slice(0,10).split('-').map(Number);
  if(month<1 || month>12 || day<1 || day>new Date(Date.UTC(year,month,0)).getUTCDate())return null;
  const [hour,minute,second]=text.slice(11,19).split(':').map(Number);
  if(hour>23 || minute>59 || second>59)return null;
  const valueMs=Date.parse(text);return Number.isFinite(valueMs)?valueMs:null;
}
async function ownedRun(tx,userId,runId) {
  const run=await tx.get('SELECT * FROM runs WHERE id=? AND user_id=?',[runId,userId]);
  if(!run)conflict('SAVED_RUN_OWNER_MISMATCH');
  return run;
}
async function cancelPending(tx,userId,eventId) {
  await tx.run("UPDATE notification_deliveries SET state='CANCELLED',lease_token=NULL,lease_until=NULL WHERE user_id=? AND event_id=? AND state IN ('PENDING','LEASED','RETRY')",[userId,eventId]);
}
async function ensureSavedRunEvent(tx,{userId,runId,providerStart,providerType}) {
  // Only the authenticated Strava persistence seam supplies these fetched facts.
  // Never use normalized missing-type/date fallbacks or an import body label.
  if(!['Run','TrailRun','VirtualRun'].includes(providerType))return null;
  const run=await ownedRun(tx,userId,runId);
  const control=await tx.get("SELECT activation_at,eligibility_bootstrapped FROM background_sync_control WHERE id='strava'");
  if(!control?.eligibility_bootstrapped)conflict('BACKGROUND_ACTIVATION_UNAVAILABLE');
  const activation=epoch(control.activation_at,true);
  const now=epoch((await tx.get('SELECT CURRENT_TIMESTAMP AS now')).now,true);
  if(activation===null || now===null)conflict('BACKGROUND_CLOCK_UNAVAILABLE');
  const start=epoch(providerStart),created=epoch(run.created_at,true);
  let marker=await tx.get('SELECT * FROM run_save_eligibility WHERE user_id=? AND run_id=?',[userId,runId]);
  if(!marker) {
    const reason=start===null || created===null || start>now+300000 ? 'UNKNOWN_START'
      : created<activation || start<activation ? 'LATE_HISTORICAL' : 'NEW_AFTER_ACTIVATION';
    await tx.run('INSERT INTO run_save_eligibility(user_id,run_id,eligible,reason) VALUES(?,?,?,?)',[userId,runId,reason==='NEW_AFTER_ACTIVATION',reason]);
    marker={eligible:reason==='NEW_AFTER_ACTIVATION'};
  }
  if(!marker.eligible)return null;
  const existing=await tx.get("SELECT * FROM activity_notification_events WHERE user_id=? AND run_id=? AND state='ACTIVE'",[userId,runId]);
  if(existing)return existing; // Never backfill targets registered after the original save.
  const { notification }=await createUserNotificationInTransaction(tx,userId,{
    type:'activity_synced',title:'Run saved',body:'Your run is ready to review in Forge.',
    href:`/run/recap/${encodeURIComponent(runId)}`,sourceKey:`saved-run:${runId}`,
  });
  const id=randomUUID();
  await tx.run("INSERT INTO activity_notification_events(id,user_id,run_id,notification_id,state) VALUES(?,?,?,?,'ACTIVE')",[id,userId,runId,notification.id]);
  const targets=await tx.all("SELECT id,generation FROM push_subscriptions WHERE user_id=? AND active=TRUE AND disclosure='GENERIC'",[userId]);
  const expires=new Date(now+24*60*60*1000).toISOString();
  for(const target of targets)await tx.run(`INSERT INTO notification_deliveries
    (id,user_id,event_id,notification_id,transport,target_id,target_generation,disclosure,state,expires_at)
    VALUES(?,?,?,?,'WEB_PUSH',?,?,'GENERIC','PENDING',?)`,[randomUUID(),userId,id,notification.id,target.id,target.generation,expires]);
  return tx.get('SELECT * FROM activity_notification_events WHERE user_id=? AND id=?',[userId,id]);
}
async function resolveSavedRunEvent(tx,userId,eventId) {
  const seen=new Set();let current=eventId;
  for(let hop=0;hop<=2;hop++) {
    if(seen.has(current))conflict('SAVED_RUN_ALIAS_CYCLE');seen.add(current);
    const event=await tx.get('SELECT * FROM activity_notification_events WHERE id=? AND user_id=?',[current,userId]);
    if(!event)conflict('SAVED_RUN_ALIAS_OWNER');
    if(event.state==='ACTIVE'){await ownedRun(tx,userId,event.run_id);return event;}
    if(event.state==='CANCELLED')return null;
    if(event.state!=='MERGED' || !event.merged_into)conflict('SAVED_RUN_ALIAS_INVALID');
    current=event.merged_into;
  }
  conflict('SAVED_RUN_ALIAS_DEPTH');
}
async function mergeSavedRunReferences(tx,userId,loserRunId,winnerRunId) {
  if(loserRunId===winnerRunId)conflict('SAVED_RUN_SELF_MERGE');
  await ownedRun(tx,userId,loserRunId);await ownedRun(tx,userId,winnerRunId);
  const markers=await tx.all('SELECT * FROM run_save_eligibility WHERE user_id=? AND run_id IN (?,?)',[userId,loserRunId,winnerRunId]);
  const loserMarker=markers.find(row=>row.run_id===loserRunId),winnerMarker=markers.find(row=>row.run_id===winnerRunId);
  // Preserve the canonical marker unless immutable LEGACY must dominate.
  const selected=markers.find(row=>row.reason==='LEGACY') || winnerMarker || loserMarker;
  if(selected) {
    await tx.run(`INSERT INTO run_save_eligibility(user_id,run_id,eligible,reason) VALUES(?,?,?,?)
      ON CONFLICT(user_id,run_id) DO UPDATE SET eligible=excluded.eligible,reason=excluded.reason`,[userId,winnerRunId,Boolean(selected.eligible),selected.reason]);
  }
  const events=await tx.all("SELECT * FROM activity_notification_events WHERE user_id=? AND run_id IN (?,?) AND state='ACTIVE'",[userId,loserRunId,winnerRunId]);
  for(const event of events)await resolveSavedRunEvent(tx,userId,event.id);
  if(selected && !selected.eligible) {
    for(const event of events){await cancelPending(tx,userId,event.id);await tx.run("UPDATE activity_notification_events SET state='CANCELLED',run_id=NULL,merged_into=NULL WHERE id=? AND user_id=?",[event.id,userId]);}
  } else {
    const winnerEvent=events.find(row=>row.run_id===winnerRunId) || events.find(row=>row.run_id===loserRunId);
    if(winnerEvent) {
      for(const event of events.filter(row=>row.id!==winnerEvent.id)) {
        await cancelPending(tx,userId,event.id);
        await tx.run('UPDATE activity_notification_events SET merged_into=? WHERE user_id=? AND state=\'MERGED\' AND merged_into=?',[winnerEvent.id,userId,event.id]);
        await tx.run("UPDATE activity_notification_events SET state='MERGED',run_id=NULL,merged_into=? WHERE id=? AND user_id=?",[winnerEvent.id,event.id,userId]);
      }
      await tx.run('UPDATE activity_notification_events SET run_id=? WHERE id=? AND user_id=?',[winnerRunId,winnerEvent.id,userId]);
    }
  }
  await tx.run('UPDATE provider_activity_links SET run_id=? WHERE user_id=? AND run_id=?',[winnerRunId,userId,loserRunId]);
  await tx.run('DELETE FROM run_save_eligibility WHERE user_id=? AND run_id=?',[userId,loserRunId]);
}
async function retireSavedRun(tx,userId,runId) {
  await ownedRun(tx,userId,runId);
  const links=await tx.all('SELECT object_id FROM provider_activity_links WHERE user_id=? AND run_id=?',[userId,runId]);
  for(const link of links)for(const key of buildRunImportKeys({healthSource:'strava',sourceWorkoutId:link.object_id})) {
    await tx.run('INSERT INTO run_import_tombstones(id,user_id,source_key) VALUES(?,?,?) ON CONFLICT(user_id,source_key) DO NOTHING',[randomUUID(),userId,key]);
  }
  await tx.run("UPDATE provider_activity_links SET state='USER_DELETED',run_id=NULL WHERE user_id=? AND run_id=?",[userId,runId]);
  const events=await tx.all("SELECT id FROM activity_notification_events WHERE user_id=? AND run_id=? AND state='ACTIVE'",[userId,runId]);
  for(const event of events){await cancelPending(tx,userId,event.id);await tx.run("UPDATE activity_notification_events SET state='CANCELLED',run_id=NULL,merged_into=NULL WHERE id=? AND user_id=?",[event.id,userId]);}
}

module.exports={ensureSavedRunEvent,mergeSavedRunReferences,retireSavedRun,resolveSavedRunEvent};
