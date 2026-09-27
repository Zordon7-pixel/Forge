const router = require('express').Router();
const auth = require('../middleware/auth');
const { dbGet, dbAll } = require('../db');
const { canonicalHash, addDays } = require('../lib/racePlanPolicy');
const contract = require('../lib/coachingContext');
const { effectiveReadDate, assignmentReadIdentity, validEffectiveAssignmentRead, EFFECTIVE_READ_VERSION,
  MAX_ASSIGNMENT_READ_DEPTH } = require('../lib/acceptedSurfaceDiagnostic');
const { LIMITS, VERSION } = contract;
const reject = code => { const e = Error(code); e.code = code; throw e; };
const bounded = (column, maximum = LIMITS.payloadBytes) => `CASE WHEN octet_length(${column}::text) <= ${maximum} THEN ${column} ELSE NULL END AS ${column.split('.').at(-1)}`;
const localDate = (asOf, timezone) => new Intl.DateTimeFormat('en-CA', {
  timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(asOf));
function assignmentClock(active, owner, asOf) {
  if (active.user_id !== owner || active.training_owner_id !== owner) reject('ASSIGNMENT_LINEAGE_UNAVAILABLE');
  if (active.plan_oversized) reject('CONTEXT_BOUNDS');
  const plan = contract.json(active.plan_data || active.plan_json);
  const zones = [];
  if (plan?.programContract && Object.hasOwn(plan.programContract, 'timezone')) zones.push(plan.programContract.timezone);
  if (plan?.canonical_workout_schema_version === 1) {
    if (!Array.isArray(plan.weeks)) reject('ASSIGNMENT_TIMEZONE_INVALID');
    let count = 0;
    for (const week of plan.weeks) {
      if (!Array.isArray(week?.days)) reject('ASSIGNMENT_TIMEZONE_INVALID');
      for (const day of week.days) {
        if (!Array.isArray(day?.sessions)) reject('ASSIGNMENT_TIMEZONE_INVALID');
        for (const session of day.sessions) {
          if (++count > LIMITS.sessions) reject('CONTEXT_BOUNDS');
          if (session && Object.hasOwn(session, 'timezone')) zones.push(session.timezone);
        }
      }
    }
  }
  // The users table has no timezone column. Persisted plan clocks, not caller
  // offsets or fictional profile data, govern assignment cutover. Missing legacy
  // metadata uses UTC; explicit invalid/conflicting metadata never falls back.
  if (zones.some(zone => {
    if (typeof zone !== 'string' || !zone || zone.length > 128) return true;
    try { localDate(asOf, zone); return false; } catch { return true; }
  }) || new Set(zones).size > 1) reject('ASSIGNMENT_TIMEZONE_INVALID');
  const timezone = zones[0] || 'UTC';
  return { timezone, today: localDate(asOf, timezone) };
}
async function readChain(owner, asOf) {
  // A second active assignment is ambiguous, not permission to choose a winner.
  const columnsAssignment = `up.id AS user_plan_id, up.user_id, up.plan_id, up.status,
      up.plan_version, up.lineage_id, up.effective_from, up.started_at, up.supersedes_user_plan_id,
      tp.user_id AS training_owner_id, ${bounded('tp.plan_data')}, ${bounded('tp.plan_json')},
      CASE WHEN octet_length(tp.plan_data::text)>${LIMITS.payloadBytes} OR octet_length(tp.plan_json::text)>${LIMITS.payloadBytes} THEN 1 ELSE 0 END AS plan_oversized`;
  const assignmentJoin = 'FROM user_plans up LEFT JOIN training_plans tp ON tp.id=up.plan_id AND tp.user_id=?';
  const rows = await dbAll(`SELECT ${columnsAssignment} ${assignmentJoin}
    WHERE up.user_id=? AND up.status='active' ORDER BY up.created_at DESC, up.id DESC LIMIT 2`, [owner, owner]);
  if (rows.length > 1) reject('ASSIGNMENT_AMBIGUOUS');
  let active = rows[0];
  if (!active) return { active: null, candidate: null, artifacts: [] };
  const clock = assignmentClock(active, owner, asOf);
  const { timezone, today } = clock;
  const lineage = [], visited = new Set();
  while (active) {
    if (lineage.length >= MAX_ASSIGNMENT_READ_DEPTH) reject('ASSIGNMENT_LINEAGE_BOUNDS');
    if (visited.has(active.user_plan_id)) reject('ASSIGNMENT_LINEAGE_INVALID');
    visited.add(active.user_plan_id); lineage.push(active);
    if (active.user_id !== owner || active.training_owner_id !== owner) reject('ASSIGNMENT_LINEAGE_UNAVAILABLE');
    if (active.plan_oversized) reject('CONTEXT_BOUNDS');
    const date = effectiveReadDate(active);
    if (!date) reject('ASSIGNMENT_DATE_INVALID');
    if (date <= today) break;
    if (!active.supersedes_user_plan_id) reject('FUTURE_ASSIGNMENT_CONTEXT_UNAVAILABLE');
    active = await dbGet(`SELECT ${columnsAssignment} ${assignmentJoin}
      WHERE up.user_id=? AND up.id=? LIMIT 1`, [owner, owner, active.supersedes_user_plan_id]);
    if (!active) reject('ASSIGNMENT_LINEAGE_UNAVAILABLE');
  }
  const effectiveAssignmentRead = lineage.length > 1 ? { version: EFFECTIVE_READ_VERSION,
    local_date: today, timezone, path: lineage.map(assignmentReadIdentity) } : null;
  if (effectiveAssignmentRead && !validEffectiveAssignmentRead(effectiveAssignmentRead, active, owner)) reject('ASSIGNMENT_LINEAGE_INVALID');
  const candidates = await dbAll(`SELECT id,user_id,status,decision_id,candidate_hash,selected_candidate_hash,
      training_plan_id,user_plan_id,active_plan_version,planning_input_revision,planning_date_local,timezone_offset_minutes,
      engine_version,policy_version,candidate_revision,athlete_state_revision,safety_state_hash,
      lock_revision,edit_revision,surface_revision,export_revision,feature_mode,
      applied_user_plan_id,applied_training_plan_id,created_at,${bounded('goal_revisions_json', 32768)},${bounded('material_change_json', 262144)}
    FROM plan_generation_candidates WHERE user_id=? AND applied_user_plan_id=? AND status='applied'
    ORDER BY applied_at DESC,id DESC LIMIT 2`, [owner, active.user_plan_id]);
  if (candidates.length !== 1) reject('ACCEPTED_CHAIN_UNAVAILABLE');
  const candidate = candidates[0];
  const columns = `id,user_id,artifact_kind,decision_id,parent_artifact_id,plan_generation_candidate_id,
      schema_version,policy_version,revision,content_hash,created_at,${bounded('payload_json')}`;
  const surfaces = await dbAll(`SELECT ${columns} FROM planning_pipeline_artifacts
    WHERE user_id=? AND decision_id=? AND plan_generation_candidate_id=? AND artifact_kind='surface_manifest'
    ORDER BY revision DESC,id DESC LIMIT 2`, [owner, candidate.decision_id, candidate.id]);
  if (!surfaces.length || surfaces.length > 1 && Number(surfaces[0].revision) === Number(surfaces[1].revision)) reject('ACCEPTED_CHAIN_UNAVAILABLE');
  // Follow the accepted head's exact ancestry, not arbitrary latest rows of
  // each kind. Historical revisions can remain stored without being mixed in.
  const artifacts = [surfaces[0]], seen = new Set([surfaces[0].id]);
  let head = surfaces[0];
  for (let hop = 0; head.parent_artifact_id && hop < 6; hop++) {
    if (seen.has(head.parent_artifact_id)) reject('ACCEPTED_CHAIN_UNAVAILABLE');
    head = await dbGet(`SELECT ${columns} FROM planning_pipeline_artifacts
      WHERE user_id=? AND decision_id=? AND id=? LIMIT 1`, [owner, candidate.decision_id, head.parent_artifact_id]);
    if (!head) reject('ACCEPTED_CHAIN_UNAVAILABLE');
    seen.add(head.id); artifacts.push(head);
  }
  if (head.parent_artifact_id || artifacts.length !== 7) reject('ACCEPTED_CHAIN_UNAVAILABLE');
  return { active, candidate, artifacts, lineage, effectiveAssignmentRead, clock };
}
async function readSources(owner, chain, today, asOf) {
  const sessionId = chain.session.session_id;
  let measuredReceipts;
  try { measuredReceipts = await require('../lib/activityMeasuredReceipt').load({ tx: { get: dbGet, all: dbAll },
    userId: owner, observationInstant: asOf, sessionScope: { plan_id: chain.set.plan_id, session_id: sessionId } }); }
  catch { measuredReceipts = { unavailable: true, rows: [], usable: [] }; }
  const receiptRunId = measuredReceipts.rows.find(r => r.activity_kind === 'run')?.activity_id || '';
  const receiptLiftId = measuredReceipts.rows.find(r => r.activity_kind === 'lift')?.activity_id || '';
  const runs = await dbAll(`SELECT id,user_id,date,type,distance_miles,duration_seconds,avg_heart_rate,max_heart_rate,cadence_spm,
      pace_avg,health_source,health_source_workout_id,health_start_at,health_end_at,watch_sync_id,watch_mode,
      watch_activity_type,watch_normalized_type,created_at,plan_session_id,shoe_id,
      ${bounded('planned_session_json', 32768)},${bounded('heart_rate_zones', 32768)},${bounded('workout_metrics_json', 32768)}
    FROM runs WHERE user_id=? AND ((date>=? AND date<=?) OR plan_session_id=? OR id=?)
    ORDER BY date,created_at,id LIMIT 513`, [owner, addDays(today, -57), today, sessionId, receiptRunId]);
  const corrections = await dbAll(`SELECT id,user_id,raw_evidence_kind,raw_evidence_ref,revision,
        ${bounded('corrected_canonical_value_json', 32768)},canonical_unit,reason_code,content_hash,${bounded('reason', 2000)},
        CASE WHEN octet_length(corrected_canonical_value_json::text)>32768 OR octet_length(attribution_json::text)>32768 THEN 1 ELSE 0 END AS correction_oversized,
      attributed_by_user_id,${bounded('attribution_json', 32768)},supersedes_correction_id,created_at
    FROM planning_evidence_corrections WHERE user_id=? AND raw_evidence_kind='run'
    ORDER BY raw_evidence_ref,revision,id LIMIT 1001`, [owner]);
  const lifts = await dbAll(`SELECT id,user_id,started_at,ended_at,total_seconds FROM workout_sessions
    WHERE user_id=? AND ((started_at>=? AND started_at<=?) OR id=?) ORDER BY started_at,id LIMIT 257`,
  [owner, `${addDays(chain.session.scheduled_local_date, -4)}T00:00:00Z`, `${addDays(chain.session.scheduled_local_date, 4)}T23:59:59Z`, receiptLiftId]);
  if (runs.length > LIMITS.runs || corrections.length > LIMITS.corrections || lifts.length > LIMITS.lifts) reject('CONTEXT_BOUNDS');
  if (corrections.some(c => c.correction_oversized)) reject('CONTEXT_BOUNDS');
  const ids = [...new Set(runs.filter(r => r.plan_session_id === sessionId || r.id === receiptRunId).map(r => r.shoe_id).filter(Boolean))];
  let shoes = [], shoeReadStatus = 'AVAILABLE';
  if (ids.length) {
    try { shoes = await dbAll(`SELECT id,user_id,${bounded('brand', 1024)},${bounded('model', 1024)},${bounded('nickname', 1024)},is_retired FROM gear_shoes
      WHERE user_id=? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY id LIMIT 513`, [owner, ...ids]); }
    catch { shoeReadStatus = 'LOOKUP_UNAVAILABLE'; }
  }
  return { runs, corrections, lifts, shoes, shoeReadStatus, measuredReceipts };
}
router.get('/context/:sessionId', auth, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  const owner = req.user.id;
  const sessionId = req.params.sessionId;
  // There is no caller-supplied acceptance, as-of override, owner or hash authority.
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_:.\-]{1,200}$/.test(sessionId) || Object.keys(req.query).length) {
    return res.status(400).json({ schema_version: VERSION, status: 'UNAVAILABLE', reason_codes: ['CONTEXT_REQUEST_INVALID'] });
  }
  try {
    const asOf = new Date().toISOString();
    const profile = await dbGet('SELECT id,planning_input_revision FROM users WHERE id=?', [owner]);
    const raw = await readChain(owner, asOf);
    if (!raw.active) {
      const legacy = await dbGet('SELECT id FROM training_plans WHERE user_id=? LIMIT 1', [owner]);
      reject(legacy ? 'LEGACY_PLAN_NOT_CANONICAL' : 'NO_ACCEPTED_PLAN');
    }
    const chain = contract.accepted({ ownerId: owner, ...raw, sessionId });
    const today = localDate(asOf, chain.session.timezone);
    const sources = await readSources(owner, chain, today, asOf);
    const result = contract.compose({ ownerId: owner, chain, candidate: raw.candidate, profile, ...sources, asOf });
    // Optimistic read consistency: no locks/writes, but do not combine an old
    // acceptance with a changed assignment/artifact or physiological revision.
    const afterSources = await readSources(owner, chain, today, asOf);
    const after = await readChain(owner, asOf);
    const revision = await dbGet('SELECT id,planning_input_revision FROM users WHERE id=?', [owner]);
    if (canonicalHash(raw) !== canonicalHash(after) || canonicalHash(profile) !== canonicalHash(revision)
      || canonicalHash(sources) !== canonicalHash(afterSources)) reject('CONTEXT_CHANGED_DURING_READ');
    return res.json(result);
  } catch (error) {
    const known = new Set(['NO_ACCEPTED_PLAN', 'LEGACY_PLAN_NOT_CANONICAL', 'ACCEPTED_CHAIN_UNAVAILABLE', 'ACCEPTED_CHAIN_STALE',
      'CANONICAL_SET_INVALID', 'SESSION_UNAVAILABLE', 'ASSIGNMENT_AMBIGUOUS', 'FUTURE_ASSIGNMENT_CONTEXT_UNAVAILABLE',
      'ASSIGNMENT_LINEAGE_INVALID', 'ASSIGNMENT_LINEAGE_UNAVAILABLE', 'ASSIGNMENT_LINEAGE_BOUNDS', 'ASSIGNMENT_DATE_INVALID', 'ASSIGNMENT_TIMEZONE_INVALID',
      'CONTEXT_BOUNDS', 'CONTEXT_RESPONSE_BOUNDS', 'CONTEXT_CHANGED_DURING_READ', 'CONTEXT_OWNER_MISMATCH']);
    const reason = known.has(error.code) ? error.code : 'CONTEXT_READ_UNAVAILABLE';
    return res.status(error.code === 'SESSION_UNAVAILABLE' ? 404 : 409).json({ schema_version: VERSION,
      status: 'UNAVAILABLE', executable_authority: false, reason_codes: [reason], session: null,
      note: 'This read is unavailable. It does not change or block your training plan or export.' });
  }
});
module.exports = router;
