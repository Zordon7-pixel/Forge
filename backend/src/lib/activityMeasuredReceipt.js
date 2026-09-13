// Owner-scoped manual measurements of an existing physical activity. Accepted
// prescriptions authenticate identity/repertoire only; they supply no actuals.
const { randomUUID } = require('node:crypto');
const { canonicalHash } = require('./racePlanPolicy');
const { ownDataJsonSnapshot } = require('./goalBackwardRecoveryMaterial');
const VERSION = 'activity-measured-v1';
const fail = () => { throw Object.assign(new Error('Activity measurement rejected'), { code: 'ACTIVITY_MEASUREMENT_INVALID', status: 409 }); };
const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const keys = (o, names) => o && !Array.isArray(o) && Object.keys(o).length === names.length && Object.keys(o).every(k => names.includes(k));
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 128;
function inputSnapshot(input) {
  const b = ownDataJsonSnapshot(input, { maximumDepth: 8, maximumNodes: 2048 });
  if (!keys(b, ['version','activity_kind','activity_id','plan_id','plan_revision','session_id','session_revision','session_hash','expected_revision','completeness','work_intervals'])
    || b.version !== VERSION || !['run','lift'].includes(b.activity_kind)
    || !['activity_id','plan_id','session_id','session_hash'].every(k => text(b[k]))
    || !integer(b.plan_revision) || b.plan_revision < 1 || !integer(b.session_revision) || b.session_revision < 1
    || !integer(b.expected_revision) || !['COMPLETE','PARTIAL','FAILED'].includes(b.completeness)
    || !Array.isArray(b.work_intervals) || b.work_intervals.length > 64) fail();
  let end = 0;
  for (const interval of b.work_intervals) {
    if (!keys(interval, ['start_offset_s','end_offset_s']) || !integer(interval.start_offset_s)
      || !integer(interval.end_offset_s) || interval.start_offset_s < end || interval.end_offset_s <= interval.start_offset_s
      || interval.end_offset_s > 86400) fail();
    end = interval.end_offset_s;
  }
  if (b.activity_kind === 'lift' && b.work_intervals.length) fail();
  return b;
}
async function physical(tx, owner, kind, id) {
  const row = kind === 'run'
    ? await tx.get(`SELECT id,user_id,date,distance_miles,duration_seconds,created_at,plan_session_id,planned_session_json,
        watch_sync_id,health_source,health_source_workout_id FROM runs WHERE id=? AND user_id=?`, [id, owner])
    : await tx.get(`SELECT id,user_id,started_at,ended_at,total_seconds,created_at FROM workout_sessions WHERE id=? AND user_id=?`, [id, owner]);
  if (!row || row.user_id !== owner) fail();
  const sets = kind === 'lift' ? await tx.all(`SELECT id,user_id,session_id,exercise_name,set_number,reps,weight_lbs,logged_at
    FROM workout_sets WHERE session_id=? AND user_id=? ORDER BY id LIMIT 257`, [id, owner]) : [];
  if (sets.length > 256) fail();
  return { row, sets };
}
function measured(p, b, now) {
  const at = Date.parse(now), r = p.row;
  const past = v => typeof v === 'string' && Number.isFinite(Date.parse(v)) && Date.parse(v) <= at;
  const duration = b.activity_kind === 'run' ? r.duration_seconds : r.total_seconds;
  const observed = b.activity_kind === 'run' ? `${r.date}T12:00:00Z` : r.ended_at;
  if (!past(observed) || !past(r.created_at) || !positive(duration) || duration > 86400) fail();
  if (b.work_intervals.some(i => i.end_offset_s > duration)) fail();
  if (b.activity_kind === 'run') {
    if (!positive(r.distance_miles) || r.distance_miles > 500 || r.plan_session_id && r.plan_session_id !== b.session_id) fail();
    if (r.planned_session_json) {
      let link;
      try { link = JSON.parse(r.planned_session_json); } catch { fail(); }
      if (!link || Array.isArray(link) || require('./plannedRunMatch').isExplicitlyUnlinkedRun(r.planned_session_json)
        || link.content_hash && link.content_hash !== b.session_hash || link.planId && link.planId !== b.plan_id
        || link.sessionId && link.sessionId !== b.session_id) fail();
    }
  }
  if (b.activity_kind === 'lift') {
    if (!past(r.started_at) || Date.parse(r.ended_at) <= Date.parse(r.started_at)
      || duration > (Date.parse(r.ended_at) - Date.parse(r.started_at)) / 1000 + 1) fail();
    const ordinals = new Set();
    for (const s of p.sets) {
      if (!text(s.exercise_name) || s.user_id !== r.user_id || s.session_id !== r.id || !integer(s.set_number) || s.set_number < 1
        || !integer(s.reps) || s.reps < 1 || s.reps > 1000 || !positive(s.weight_lbs) || s.weight_lbs > 2000
        || !past(s.logged_at) || Date.parse(s.logged_at) < Date.parse(r.started_at)) fail();
      const key = `${s.exercise_name.trim().toLowerCase()}:${s.set_number}`;
      if (ordinals.has(key)) fail();
      ordinals.add(key);
    }
    if (b.completeness === 'COMPLETE' && !p.sets.length) fail();
  }
  return { observed_at: observed, duration_s: duration,
    distance_m: b.activity_kind === 'run' ? r.distance_miles * 1609.344 : null,
    work_duration_s: b.completeness === 'COMPLETE' && b.work_intervals.length
      ? b.work_intervals.reduce((n, i) => n + i.end_offset_s - i.start_offset_s, 0) : null,
    sets: b.activity_kind === 'lift' && b.completeness === 'COMPLETE' ? p.sets.length : null };
}
function linked(b, accepted) {
  const s = accepted?.sessions.find(s => s.session_id === b.session_id);
  if (!s || accepted.plan_id !== b.plan_id || accepted.plan_revision !== b.plan_revision
    || s.session_revision !== b.session_revision || s.content_hash !== b.session_hash || s.kind !== b.activity_kind) fail();
  return s;
}
async function record({ tx, userId, input, accepted, now }) {
  const b = inputSnapshot(input);
  const session = linked(b, accepted);
  if (session.scheduled_local_date > now.slice(0, 10)) fail();
  const p = await physical(tx, userId, b.activity_kind, b.activity_id);
  const actual = measured(p, b, now);
  const prior = await tx.get(`SELECT id,revision,payload_json FROM activity_measured_receipts
    WHERE user_id=? AND activity_kind=? AND activity_id=? ORDER BY revision DESC LIMIT 1`, [userId,b.activity_kind,b.activity_id]);
  if ((prior?.revision || 0) !== b.expected_revision) fail();
  if (prior) {
    const old = typeof prior.payload_json === 'string' ? JSON.parse(prior.payload_json) : prior.payload_json;
    if (['plan_id','plan_revision','session_id','session_revision','session_hash'].some(k => old.binding[k] !== b[k])) fail();
  }
  // One physical activity per immutable accepted session. A correction revises
  // that activity; it never creates a second independent successful exposure.
  const duplicate = await tx.get(`SELECT id FROM activity_measured_receipts WHERE user_id=? AND plan_id=? AND session_id=?
    AND activity_id<>? LIMIT 1`, [userId,b.plan_id,b.session_id,b.activity_id]);
  if (duplicate) fail();
  const id = randomUUID(), revision = b.expected_revision + 1;
  const payload = { version: VERSION, binding: b, provenance: 'OWNER_SCOPED_MANUAL_RECORDER',
    completeness: b.completeness, physical_hash: canonicalHash(p), actual,
    supersedes_receipt_id: prior?.id || null };
  await tx.run(`INSERT INTO activity_measured_receipts(id,user_id,activity_kind,activity_id,plan_id,session_id,revision,payload_json,content_hash,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, [id,userId,b.activity_kind,b.activity_id,b.plan_id,b.session_id,revision,JSON.stringify(payload),canonicalHash(payload),now]);
  return { id, revision, content_hash: canonicalHash(payload) };
}
async function load({ tx, userId, observationInstant }) {
  const rows = await tx.all(`SELECT id,user_id,activity_kind,activity_id,plan_id,session_id,revision,payload_json,content_hash,created_at
    FROM activity_measured_receipts WHERE user_id=? ORDER BY activity_kind,activity_id,revision LIMIT 65`, [userId]);
  if (rows.length > 64) throw Object.assign(new Error('Measured source overflow'), { code: 'SOURCE_OVERFLOW' });
  const latest = new Map(), bindings = [], ids = new Set();
  for (const row of rows) {
    if (row.user_id !== userId || ids.has(row.id)) fail();
    ids.add(row.id);
    const key = `${row.activity_kind}:${row.activity_id}`, prior = latest.get(key);
    const payload = ownDataJsonSnapshot(typeof row.payload_json === 'string' && row.payload_json.length <= 32768
      ? JSON.parse(row.payload_json) : row.payload_json, { maximumDepth: 10, maximumNodes: 4096 });
    if (!keys(payload, ['version','binding','provenance','completeness','physical_hash','actual','supersedes_receipt_id']) || canonicalHash(payload) !== row.content_hash || payload.version !== VERSION
      || payload.provenance !== 'OWNER_SCOPED_MANUAL_RECORDER') fail();
    const b = inputSnapshot(payload.binding);
    if (!Number.isFinite(Date.parse(row.created_at)) || payload.completeness !== b.completeness
      || !keys(payload.actual, ['observed_at','duration_s','distance_m','work_duration_s','sets'])
      || prior && ['plan_id','plan_revision','session_id','session_revision','session_hash'].some(k => prior.payload.binding[k] !== b[k])) fail();
    if (b.activity_kind !== row.activity_kind || b.activity_id !== row.activity_id || b.plan_id !== row.plan_id || b.session_id !== row.session_id
      || row.revision !== (prior?.row.revision || 0) + 1 || b.expected_revision !== row.revision - 1
      || payload.supersedes_receipt_id !== (prior?.row.id || null)) fail();
    latest.set(key, { row, payload });
  }
  const usable = [];
  for (const entry of latest.values()) {
    let p = null;
    try {
      p = await physical(tx, userId, entry.row.activity_kind, entry.row.activity_id);
    } catch (e) { if (e.code !== 'ACTIVITY_MEASUREMENT_INVALID') throw e; }
    bindings.push({ receipt_id: entry.row.id, physical: p });
    if (!p || canonicalHash(p) !== entry.payload.physical_hash || Date.parse(entry.row.created_at) > Date.parse(observationInstant)) continue;
    try {
      const actual = measured(p, entry.payload.binding, observationInstant);
      if (canonicalHash(actual) !== canonicalHash(entry.payload.actual)) continue;
      usable.push(entry);
    } catch (e) { if (e.code !== 'ACTIVITY_MEASUREMENT_INVALID') throw e; }
  }
  return { rows, bindings, usable };
}
function pairs(receipts, accepted, snapshot) {
  const out = [];
  for (const { row, payload } of receipts?.usable || []) {
    let session;
    try { session = linked(payload.binding, accepted); } catch { continue; }
    const actual = payload.actual;
    const protectedRun = ['threshold_run','interval_run','race_rhythm_run','steady_run','long_aerobic'].includes(session.workout_family);
    const complete = payload.completeness === 'COMPLETE' && (!protectedRun || positive(actual.work_duration_s));
    const activity = row.activity_kind === 'run' ? snapshot.canonical_activities.find(a => a.evidence_ids.includes(row.activity_id)) : null;
    // Reconciliation remains authoritative: duplicate/import conflicts and raw
    // distance corrections cannot be bypassed by a separate work receipt.
    if (row.activity_kind === 'run' && (!activity || activity.evidence_ids.length !== 1 || activity.quality_state !== 'COMPLETE'
      || activity.correction_evidence_ids?.length || Math.abs(activity.duration_s - actual.duration_s) > 1
      || Math.abs(activity.distance_m - actual.distance_m) > 2)) continue;
    out.push({ prescribed_session: session, observation: { athlete_id: row.user_id,
      linked_session_id: session.session_id, evidence_id: row.activity_kind === 'run' ? row.activity_id : row.id,
      source_evidence_ids: row.activity_kind === 'run' ? [row.activity_id] : [row.id],
      observed_at: actual.observed_at, quality_state: complete ? 'COMPLETE' : 'PARTIAL',
      completed: complete, observed_duration_s: actual.duration_s,
      observed_distance_m: actual.distance_m, observed_work_duration_s: actual.work_duration_s,
      measured_receipt_id: row.id, measured_receipt_revision: row.revision } });
  }
  return out;
}
module.exports = { VERSION, inputSnapshot, record, load, pairs };
