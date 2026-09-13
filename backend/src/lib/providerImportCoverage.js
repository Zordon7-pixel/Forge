// Server-only Garmin pagination orchestration. No caller-supplied coverage status.
const { randomUUID } = require('node:crypto');
const { canonicalHash, addDays } = require('./racePlanPolicy');
const { ownDataJsonSnapshot } = require('./goalBackwardRecoveryMaterial');
const VERSION = 'garmin-terminal-coverage-v1';
const PAGE_SIZE = 200, MAX_PAGES = 32;
const latest = (tx, owner) => tx.get(`SELECT * FROM provider_import_receipts WHERE user_id=? AND provider='garmin' ORDER BY revision DESC LIMIT 1`, [owner]);
const decode = row => ownDataJsonSnapshot(typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json,
  { maximumDepth: 10, maximumNodes: 50000 });
async function append(tx, owner, revision, payload, now) {
  const id = randomUUID();
  await tx.run(`INSERT INTO provider_import_receipts(id,user_id,provider,revision,payload_json,content_hash,created_at) VALUES (?,?,'garmin',?,?,?,?)`,
    [id, owner, revision, JSON.stringify(payload), canonicalHash(payload), now]);
  return id;
}
async function physical(tx, owner, id) {
  return await tx.get(`SELECT r.id,r.user_id,r.date,r.distance_miles,r.duration_seconds,r.watch_sync_id,w.garmin_activity_id
    FROM runs r JOIN watch_sync w ON w.id=r.watch_sync_id AND w.user_id=r.user_id WHERE r.user_id=? AND r.id=?`, [owner,id]) || null;
}
// Pagination always runs to exhaustion. We do not assume undocumented ordering
// or treat a short page as terminal; an explicit empty page is required.
async function sync({ userId, client, ingest, toPayload, mutation, now = new Date().toISOString() }) {
  const start = addDays(now.slice(0,10), -56), batch = randomUUID();
  const base = { version: VERSION, batch_id: batch, modality: 'running', window_start: `${start}T00:00:00.000Z`,
    window_end: now, status: 'PARTIAL', terminal: false, pages: 0, unknown_items: 0, failed_items: 0, bindings: [] };
  const initial = await mutation(userId, async tx => {
    const prior = await latest(tx,userId), revision = (prior?.revision || 0) + 1;
    return { revision, id: await append(tx,userId,revision,base,now) };
  });
  const payload = { ...base, bindings: [] }, imported = [], seen = new Set();
  try {
    for (let page=0; page<MAX_PAGES; page++) {
      const rows = ownDataJsonSnapshot(await client.getActivities(page*PAGE_SIZE,PAGE_SIZE), { maximumDepth: 16, maximumNodes: 100000 });
      payload.pages++;
      if (!Array.isArray(rows) || rows.length>PAGE_SIZE) { payload.unknown_items++; break; }
      if (!rows.length) { payload.terminal=true; break; }
      for (const activity of rows) {
        const id = activity?.activityId, time = activity?.startTimeGMT;
        const type = activity?.activityType?.typeKey;
        if (!(typeof id==='string' && id.length>0 && id.length<=128 || Number.isSafeInteger(id) && id>0)
          || typeof time!=='string' || !/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d+)?Z?$/.test(time)
          || typeof type!=='string' || !type.length) { payload.unknown_items++; continue; }
        const at = Date.parse(time.endsWith('Z') ? time : `${time.replace(' ','T')}Z`);
        if (!Number.isFinite(at)) { payload.unknown_items++; continue; }
        const key = `${id}`;
        if (seen.has(key)) { payload.unknown_items++; continue; } // unstable/repeated pages
        seen.add(key);
        if (at<Date.parse(base.window_start) || at>Date.parse(now)) continue;
        const running = ['running','trail_running','treadmill_running','track_running','street_running','indoor_running'].includes(type);
        // Unknown types cannot be assumed to be non-running.
        if (!running && !['walking','hiking','cycling','indoor_cycling','swimming','lap_swimming','strength_training','fitness_equipment','yoga','other'].includes(type)) {
          payload.unknown_items++;
        }
        if (running && (!(typeof activity.distance==='number' && activity.distance>0) || !(typeof activity.duration==='number' && activity.duration>0))) {
          payload.unknown_items++; continue;
        }
        try {
          const input = toPayload(activity);
          if (running && input.date !== new Date(at).toISOString().slice(0,10)) payload.unknown_items++;
          const result = await ingest(userId,input);
          if (!result || !result.id || running && (!result.created_record_id || result.routed_section!=='run'
            || result.duplicate && result.duplicate_reason!=='garmin_activity_id')) { payload.unknown_items++; continue; }
          if (running) payload.bindings.push({ activity_id: key, record_id: result.created_record_id, watch_sync_id: result.id, date:input.date, distance_miles:input.distance_miles, duration_seconds:input.duration_seconds });
          imported.push({ id:result.id, garminActivityId:key, activityName:activity.activityName || result.activity_name, startTimeLocal:activity.startTimeLocal || null });
        } catch { payload.failed_items++; }
      }
    }
  } catch { payload.failed_items++; }
  await mutation(userId,async tx => {
    const current = await latest(tx,userId);
    // A newer started batch suppresses this older in-flight completion.
    if (current?.id!==initial.id) return;
    for (const binding of payload.bindings) {
      const row = await physical(tx,userId,binding.record_id);
      if (!row || row.watch_sync_id!==binding.watch_sync_id || row.garmin_activity_id!==binding.activity_id || ['date','distance_miles','duration_seconds'].some(k=>row[k]!==binding[k])) payload.unknown_items++;
      binding.physical_hash=canonicalHash(row);
    }
    payload.status = payload.failed_items ? 'FAILED' : payload.terminal && !payload.unknown_items ? 'COMPLETE' : 'PARTIAL';
    await append(tx,userId,initial.revision+1,payload,now);
  });
  return { synced: imported.length, imported, status:payload.status };
}
async function load({ tx, userId, observationInstant, timezone='UTC' }) {
  const row = await latest(tx,userId);
  if (!row) return { rows:[], bindings:[], coverage:[] };
  const p=decode(row), bindings=[];
  if (!p || p.version!==VERSION || p.modality!=='running' || row.user_id!==userId || canonicalHash(p)!==row.content_hash
    || !['COMPLETE','PARTIAL','FAILED'].includes(p.status) || !Array.isArray(p.bindings) || p.bindings.length>6400
    || !Number.isSafeInteger(row.revision) || row.revision<1) throw new Error('Invalid importer receipt');
  let status=p.status.toLowerCase();
  if (p.status==='COMPLETE' && (!p.terminal || p.unknown_items || p.failed_items)) status='partial';
  for (const b of p.bindings) {
    const actual=await physical(tx,userId,b.record_id); bindings.push({ record_id:b.record_id, physical:actual });
    if (canonicalHash(actual)!==b.physical_hash) status='partial';
  }
  const at=Date.parse(observationInstant), end=Date.parse(p.window_end), start=Date.parse(p.window_start);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end<start || end>at || at-end>48*3600000
    || !Number.isFinite(Date.parse(row.created_at)) || Date.parse(row.created_at)>at) status='partial';
  // UTC window dates cannot prove whole local days for another timezone yet.
  if (timezone!=='UTC') status='partial';
  return { rows:[row], bindings, coverage:[{ id:row.id, source_system:'garmin', modalities:['running'], status,
    coverage_start_local:p.window_start.slice(0,10), coverage_end_local:p.window_end.slice(0,10), synced_at:p.window_end }] };
}
function merge(coverage, runs, legacy=[]) {
  const sources=new Set(legacy.map(r=>r.source_system));
  for (const r of runs) {
    if (typeof r.health_source==='string' && r.health_source.length) sources.add(r.health_source.toLowerCase());
    else if (r.watch_mode==='garmin-connect') sources.add('garmin');
    else if (r.watch_mode) sources.add('unknown_watch');
  }
  const attested=new Set(coverage.map(r=>r.source_system));
  return [...coverage,...[...sources].filter(s=>!attested.has(s)).map(source_system=>({source_system,modalities:['running'],status:'unknown'}))];
}
module.exports={ sync, load, merge };
