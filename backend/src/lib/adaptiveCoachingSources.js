// Generation-only acquisition of physical rows and closed recorder receipts.
// No arbitrary metrics JSON, guessed prescription link or interval coverage claim.
const { addDays, canonicalHash } = require('./racePlanPolicy');
const { canonicalLiftActivities } = require('./activityObservation');
const { localDate } = require('./adaptiveCoachingValidation');
const LIMIT = 64, SET_LIMIT = 8192;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0;
function bounded(rows, limit, owner) {
  if (!Array.isArray(rows) || rows.length > limit) fail('SOURCE_OVERFLOW');
  const ids = new Set();
  for (const row of rows) {
    if (row.user_id !== owner || typeof row.id !== 'string' || !row.id || ids.has(row.id)) fail('SOURCE_ROW_INVALID');
    ids.add(row.id);
    // DB primitives only; bound payload size before hashing/persisting it.
    if (Object.values(row).some(v => v !== null && !['string', 'number'].includes(typeof v)
      || typeof v === 'string' && v.length > 256)) fail('SOURCE_ROW_INVALID');
  }
  return rows;
}
async function loadMeasuredSources({ tx, userId, planningDateISO, observationInstant, timezone = 'UTC' }) {
  try {
    const since = addDays(planningDateISO, -55), until = addDays(planningDateISO, 2);
    const sessionSince = addDays(since, -1); // include UTC offsets at both local-date boundaries
    const lifts = bounded(await tx.all(`SELECT id,user_id,date,exercise_name,sets,reps,weight_lbs,
      workout_duration_seconds,watch_sync_id,category,intensity,created_at FROM lifts
      WHERE user_id=? AND date>=? AND date<=? ORDER BY date,id LIMIT 65`,
    [userId, since, planningDateISO]), LIMIT, userId);
    const workouts = bounded(await tx.all(`SELECT id,user_id,started_at,ended_at,total_seconds,created_at
      FROM workout_sessions WHERE user_id=? AND started_at>=? AND started_at<?
      ORDER BY started_at,id LIMIT 65`, [userId, sessionSince, until]), LIMIT, userId);
    // Include only sets belonging to this owner's bounded session window. A
    // foreign-owned set on an owned session is excluded by the second owner gate.
    const setRows = [];
    for (let offset = 0; ; offset += 257) {
      const page = await tx.all(`SELECT s.id,s.user_id,s.session_id,s.exercise_name,
      s.set_number,s.reps,s.weight_lbs,s.logged_at FROM workout_sets s
      JOIN workout_sessions w ON w.id=s.session_id AND w.user_id=s.user_id
      WHERE s.user_id=? AND w.user_id=? AND w.started_at>=? AND w.started_at<?
      ORDER BY s.session_id,s.id LIMIT 257 OFFSET ?`, [userId, userId, sessionSince, until, offset]);
      setRows.push(...page);
      if (setRows.length > SET_LIMIT) fail('SOURCE_OVERFLOW');
      if (page.length < 257) break;
    }
    const workoutSets = bounded(setRows, SET_LIMIT, userId);
    const corrections = bounded(await tx.all(`SELECT id,user_id,raw_evidence_kind,raw_evidence_ref,revision,created_at
      FROM planning_evidence_corrections WHERE user_id=? AND raw_evidence_kind<>'run'
      ORDER BY id LIMIT 65`, [userId]), LIMIT, userId);
    // Existing correction resolution supports run values only. Never let an
    // unsupported correction silently fall back to an uncorrected strength dose.
    if (corrections.length) fail('SOURCE_CORRECTION_UNSUPPORTED');
    const providerImports = await require('./providerImportCoverage').load({ tx, userId, observationInstant, timezone });
    const measuredReceipts = await require('./activityMeasuredReceipt').load({ tx, userId, observationInstant });
    const at = Date.parse(observationInstant);
    if (!Number.isFinite(at)) fail('SOURCE_ROW_INVALID');
    const past = value => Number.isFinite(Date.parse(value)) && Date.parse(value) <= at;
    const diagnostics = new Set();
    const identities = canonicalLiftActivities(lifts, userId);
    const duplicateLiftIds = new Set(identities.filter(a => a.evidence_ids.length > 1).flatMap(a => a.evidence_ids));
    const usableLifts = lifts.filter(r => {
      const valid = !duplicateLiftIds.has(r.id) && past(r.created_at) && past(`${r.date}T12:00:00Z`)
        && Number.isSafeInteger(r.sets) && r.sets > 0 && r.sets <= 100
        && Number.isSafeInteger(r.reps) && r.reps > 0 && r.reps <= 1000
        && positive(r.weight_lbs) && r.weight_lbs <= 2000;
      if (!valid) diagnostics.add('LIFT_MEASUREMENT_WITHHELD');
      return valid;
    });
    const sessions = workouts.map(w => {
      const rows = workoutSets.filter(s => s.session_id === w.id);
      const keys = rows.map(s => `${s.exercise_name.toLowerCase().trim()}:${s.set_number}`);
      const date = past(w.started_at) ? localDate(w.started_at, timezone) : null;
      const valid = date >= since && date <= planningDateISO && past(w.started_at) && past(w.ended_at) && past(w.created_at)
        && Date.parse(w.ended_at) >= Date.parse(w.started_at) && rows.length > 0
        && new Set(keys).size === keys.length && rows.every(s => past(s.logged_at)
          && Date.parse(s.logged_at) >= Date.parse(w.started_at)
          && Date.parse(s.logged_at) <= Date.parse(w.ended_at)
          && Number.isSafeInteger(s.set_number) && s.set_number > 0
          && Number.isSafeInteger(s.reps) && s.reps > 0 && s.reps <= 1000
          && positive(s.weight_lbs) && s.weight_lbs <= 2000);
      if (!valid) diagnostics.add('WORKOUT_SET_MEASUREMENT_WITHHELD');
      return { session_id: w.id, measured_set_count: valid ? rows.length : null,
        measurement_state: valid ? 'KNOWN_LOWER_BOUND' : 'PARTIAL',
        prescription_link_state: 'UNSUPPORTED', individual_exercise_completion_verified: false };
    });
    // Bind ALL acquired rows, including withheld/future/duplicate records, so an
    // edit or deletion without a planning revision changes the same snapshot.
    const receipt = { version: 'adaptive-physical-sources-v1', lifts, workouts, workout_sets: workoutSets,
      canonical_lift_activities: identities, sessions, correction_rows: corrections, measured_receipts: measuredReceipts, provider_imports: providerImports,
      coverage_state: 'UNKNOWN', reason_codes: [...diagnostics].sort() };
    const linkedMeasurements = measuredReceipts.usable.filter(e => e.row.activity_kind === 'lift').map(e => ({ id: e.row.id, user_id: userId,
      started_at: e.payload.actual.observed_at, created_at: e.row.created_at,
      workout_duration_seconds: e.payload.completeness === 'COMPLETE' ? e.payload.actual.duration_s : null, sets: e.payload.actual.sets }));
    return { lifts: [...usableLifts, ...linkedMeasurements], receipt, sourceFailed: false };
  } catch (error) {
    return { lifts: [], receipt: null, sourceFailed: true,
      reason_code: error.code === 'ACTIVITY_MEASUREMENT_INVALID' ? 'SOURCE_ROW_INVALID' : ['SOURCE_OVERFLOW', 'SOURCE_ROW_INVALID', 'SOURCE_CORRECTION_UNSUPPORTED'].includes(error.code)
        ? error.code : 'SOURCE_SQL_FAILED' };
  }
}
function sourceSupport(foundation) {
  const state = foundation.athlete_state;
  const goals = foundation.decision.goal_gap.map(g => g.goal);
  const pairs = require('./adaptiveCoachingSelection').usablePairs(state);
  const objectives = foundation.decision.weekly_objectives.objectives;
  const protectedFamilies = ['threshold_run','interval_run','race_rhythm_run','steady_run','long_aerobic'];
  const requiredRuns = objectives.filter(o => ['PRIMARY_KEY','ASSESSMENT'].includes(o.role)
    && o.candidate_families.some(f => protectedFamilies.includes(f)));
  const measuredRun = family => pairs.some(p => p.prescribed_session.workout_family === family
    && p.observation.measured_receipt_id && p.observation.quality_state === 'COMPLETE'
    && p.observation.observed_work_duration_s > 0);
  const protectedRun = requiredRuns.length ? requiredRuns.every(o => o.candidate_families.some(measuredRun))
    : protectedFamilies.some(measuredRun);
  const strength = pairs.some(p => p.prescribed_session.kind === 'lift' && p.observation.measured_receipt_id
    && p.observation.quality_state === 'COMPLETE' && foundation.artifacts[0].payload_json.evidence.some(e =>
      e.evidence_id === p.observation.evidence_id && e.truth_class === 'OBSERVED' && e.value?.sets > 0));
  const hybrid = goals.some(g => g.planning_eligible && g.event_kind?.startsWith('HYROX'));
  const hybridWork = objectives.some(o => o.candidate_families.some(f => f.startsWith('hyrox_')));
  const limits = [
    { objective: 'protected_running_work', required: requiredRuns.length > 0,
      required_families: requiredRuns.map(o => o.candidate_families.filter(f => protectedFamilies.includes(f))),
      status: protectedRun ? 'SUPPORTED' : 'UNSUPPORTED', reason_code: protectedRun ? 'MEASURED_RUN_WORK_LINKED' : 'MEASURED_RUN_WORK_SOURCE_ABSENT' },
    { objective: 'strength_prescription_completion', required: objectives.some(o => o.candidate_families.some(f => f.startsWith('strength_'))),
      status: strength ? 'SUPPORTED' : 'UNSUPPORTED', reason_code: strength ? 'MEASURED_STRENGTH_LINKED' : 'CANONICAL_STRENGTH_LINK_ABSENT',
      measurement_scope: 'TOTAL_SET_CAP_AND_ACCEPTED_REPERTOIRE', individual_exercise_completion_verified: false },
    { objective: 'individual_hyrox_station_work', required: hybridWork, status: 'UNSUPPORTED', reason_code: 'MEASURED_STATION_SOURCE_ABSENT' },
  ];
  if (hybrid) limits.push({ objective: 'hyrox_event_execution',
    required: goals.some(g => g.planning_eligible && g.event_kind?.startsWith('HYROX')
      && g.event_local_date >= state.planning_date_local && g.event_local_date <= require('./racePlanPolicy').addDays(state.planning_date_local,6)),
    status: 'DEFERRED', measurement_scope: 'PLANNED_EVENT_DEMAND', reason_code: 'COMPLETE_TIMED_OWNED_HYROX_MATERIAL_ABSENT' });
  if (goals.some(g => g.planning_eligible && g.event_kind === 'HYROX_DOUBLES')) limits.push({ objective: 'individual_doubles_burden',
    required: hybridWork, status: 'UNSUPPORTED', reason_code: 'INDIVIDUAL_DOUBLES_BURDEN_UNKNOWN' });
  return { version: 'adaptive-source-support-v1', active_goal_id: foundation.decision.active_goal_id,
    priority_authority: 'CURRENT_CHRONOLOGICAL_DEFAULT', stored_priority_used: false,
    source_limited: limits.some(l => l.required && l.status !== 'SUPPORTED'),
    scope: 'REQUIRED_OBJECTIVE_SOURCE_COMPLETENESS',
    observed_coverage: foundation.artifacts[0].payload_json.provider_coverage_intervals?.length
      && foundation.artifacts[0].payload_json.provider_coverage_intervals.every(r => r.complete === true) ? 'COMPLETE' : 'UNKNOWN', limits,
    receipt_hash: foundation.artifacts[0].payload_json.physical_sources
      ? canonicalHash(foundation.artifacts[0].payload_json.physical_sources) : null,
    requested_strength_capacity: state.adaptive_foundation.capacities.lift };
}
module.exports = { loadMeasuredSources, sourceSupport };
