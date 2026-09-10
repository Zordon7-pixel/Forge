// Physical evidence only. These records are never prescribed stress sessions.
const { canonicalHash, addDays } = require('./racePlanPolicy');
const VERSION = 'activity-physical-observation-v1';
const clone = value => JSON.parse(JSON.stringify(value));
const measure = value => value === null || value === undefined || value === ''
  ? { state: 'UNKNOWN', value: null }
  : typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? { state: value === 0 ? 'VALID_ZERO' : 'KNOWN', value }
    : { state: 'INVALID', value: null };
const optional = value => value == null || value === '' ? { state: 'UNKNOWN', value: null } : { state: 'KNOWN', value };
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function canonicalLiftActivities(lifts, ownerId) {
  const groups = new Map();
  for (const row of lifts) {
    if (!row.id || row.user_id != null && String(row.user_id) !== String(ownerId)) throw new Error('ACTIVITY_LIFT_OWNER_INVALID');
    // watch_sync_id is a server-owned recorded workout identity, not a match
    // by exercise name/date/amount. Manual rows without it remain independent.
    const key = row.watch_sync_id ? `watch:${row.watch_sync_id}` : `lift:${row.id}`;
    const group = groups.get(key) || []; group.push(row); groups.set(key, group);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => ({
    canonical_activity_id: canonicalHash({ owner_id: String(ownerId), source_identity: key }),
    source_identity: key, evidence_ids: rows.map(row => String(row.id)).sort(),
    records: rows.map(row => ({ id: String(row.id), local_date: row.date, exercise_name: optional(row.exercise_name),
      sets: measure(row.sets), reps: measure(row.reps), load_lbs: measure(row.weight_lbs),
      duration_s: measure(row.workout_duration_seconds), intensity: optional(row.intensity) })).sort((a, b) => a.id.localeCompare(b.id)),
    observed_v3_vector_state: 'NOT_AVAILABLE' }));
}
function buildObservation({ ownerId, planningDate, timezone, planningInputRevision, assessment,
  lifts = [], workouts = [], workoutSets = [], completedIds = [] }) {
  if (assessment.athleteId !== String(ownerId)) throw new Error('ACTIVITY_OBSERVATION_OWNER_INVALID');
  const runs = assessment.canonicalRuns.map(row => {
    const sources = assessment.sources.get(row.id) || [];
    return { canonical_activity_id: row.id, evidence_ids: [...row.evidence_ids].sort(), local_date: row.date,
      distance_m: measure(row.distance_miles == null ? null : Math.round(row.distance_miles * 1609.344)),
      duration_s: measure(row.duration_seconds), rpe: measure(row.perceived_effort),
      pain: optional(row.pain_level), energy: optional(row.post_energy), heart_rate: measure(row.avg_heart_rate),
      heart_rate_zones: optional(row.heart_rate_zones), explicitly_unlinked: row.explicitly_unlinked,
      // Preserve original zero/absent state and real instants. Normalizer fallback
      // noon is not represented as an observed start instant.
      source_fields: sources.map(source => ({ id: String(source.id), start_at: source.health_start_at || null,
        end_at: source.health_end_at || null, distance_miles: measure(source.distance_miles),
        duration_s: measure(source.duration_seconds), plan_session_id: source.plan_session_id ?? null,
        planned_session_json: source.planned_session_json ?? null })).sort((a, b) => a.id.localeCompare(b.id)) };
  }).sort((a, b) => a.canonical_activity_id.localeCompare(b.canonical_activity_id));
  const date = new Date(`${planningDate}T12:00:00Z`);
  const weekStart = addDays(planningDate, -((date.getUTCDay() + 6) % 7));
  const current = runs.filter(row => row.local_date >= weekStart && row.local_date <= planningDate);
  const lowerBound = current.reduce((sum, row) => sum + (['KNOWN', 'VALID_ZERO'].includes(row.distance_m.state) ? row.distance_m.value : 0), 0);
  const body = { version: VERSION, owner_id: String(ownerId), planning_date: planningDate, timezone,
    planning_input_revision: planningInputRevision, runs, lifts: clone(lifts), workouts: clone(workouts), workout_sets: clone(workoutSets),
    canonical_lift_activities: canonicalLiftActivities(lifts, ownerId),
    qualified_completed_session_ids: [...new Set(completedIds.map(String))].sort(),
    canonical_activity_count: runs.length,
    evidence_snapshot_hash: assessment.load.load_input_hash,
    identity_receipt: clone(assessment.load.identity_decision_receipt),
    correction_state: assessment.load.correction_input_state, correction_receipt_hash: assessment.load.correction_receipt_hash,
    coverage_state: assessment.load.coverage_state, load_input_state: assessment.load.load_input_state,
    physical_windows: clone(assessment.load.windows),
    current_week: { version: VERSION, source: 'CANONICAL_CURRENT_WEEK_LOWER_BOUND',
      planning_week_start_local: weekStart, through_local_date: planningDate,
      canonical_activity_count: current.length, canonical_activity_ids: current.map(row => row.canonical_activity_id).sort(),
      known_distance_lower_bound_m: lowerBound,
      distance_state: current.some(row => !['KNOWN', 'VALID_ZERO'].includes(row.distance_m.state)) ? 'PARTIAL' : current.length ? 'KNOWN' : 'UNKNOWN',
      coverage_state: assessment.load.coverage_state },
    recent_run_load: clone(assessment.recentRunLoad), observed_v3_vector_state: 'NOT_AVAILABLE' };
  return freeze({ ...body, content_hash: canonicalHash(body) });
}
function validateObservation(value, context) {
  try {
    const { content_hash, ...body } = value;
    const exactKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object)
      && Object.keys(object).sort().join('|') === [...keys].sort().join('|');
    const validMeasure = field => exactKeys(field, ['state', 'value']) && (
      field.state === 'KNOWN' && typeof field.value === 'number' && Number.isFinite(field.value) && field.value > 0
      || field.state === 'VALID_ZERO' && field.value === 0
      || ['UNKNOWN', 'INVALID'].includes(field.state) && field.value === null);
    const uniqueStrings = values => Array.isArray(values) && values.every(id => typeof id === 'string' && id.length > 0)
      && new Set(values).size === values.length;
    if (!exactKeys(body, ['version', 'owner_id', 'planning_date', 'timezone', 'planning_input_revision', 'runs',
      'lifts', 'workouts', 'workout_sets', 'canonical_lift_activities', 'qualified_completed_session_ids',
      'canonical_activity_count', 'evidence_snapshot_hash', 'identity_receipt', 'correction_state',
      'correction_receipt_hash', 'coverage_state', 'load_input_state', 'physical_windows', 'current_week',
      'recent_run_load', 'observed_v3_vector_state']) || !Array.isArray(body.runs)
      || !['lifts', 'workouts', 'workout_sets', 'canonical_lift_activities', 'physical_windows'].every(key => Array.isArray(body[key]))
      || !uniqueStrings(body.qualified_completed_session_ids)
      || !body.runs.every(row => exactKeys(row, ['canonical_activity_id', 'evidence_ids', 'local_date', 'distance_m',
        'duration_s', 'rpe', 'pain', 'energy', 'heart_rate', 'heart_rate_zones', 'explicitly_unlinked', 'source_fields'])
        && uniqueStrings(row.evidence_ids) && ['distance_m', 'duration_s', 'rpe', 'heart_rate'].every(key => validMeasure(row[key]))
        && /^\d{4}-\d{2}-\d{2}$/.test(row.local_date) && Array.isArray(row.source_fields))) return false;
    const weekStart = addDays(body.planning_date, -((new Date(`${body.planning_date}T12:00:00Z`).getUTCDay() + 6) % 7));
    const current = body.runs.filter(row => row.local_date >= weekStart && row.local_date <= body.planning_date);
    const expectedWeek = { version: VERSION, source: 'CANONICAL_CURRENT_WEEK_LOWER_BOUND',
      planning_week_start_local: weekStart, through_local_date: body.planning_date,
      canonical_activity_count: current.length, canonical_activity_ids: current.map(row => row.canonical_activity_id).sort(),
      known_distance_lower_bound_m: current.reduce((sum, row) => sum + (['KNOWN', 'VALID_ZERO'].includes(row.distance_m.state) ? row.distance_m.value : 0), 0),
      distance_state: current.some(row => !['KNOWN', 'VALID_ZERO'].includes(row.distance_m.state)) ? 'PARTIAL' : current.length ? 'KNOWN' : 'UNKNOWN',
      coverage_state: body.coverage_state };
    return body.version === VERSION && content_hash === canonicalHash(body)
      && content_hash === context.observation_hash && canonicalHash(body.recent_run_load) === context.recent_run_load_hash
      && body.owner_id === context.owner_id && body.planning_date === context.planning_date
      && body.timezone === context.timezone && body.planning_input_revision === context.planning_input_revision
      && body.observed_v3_vector_state === 'NOT_AVAILABLE' && body.canonical_activity_count === body.runs.length
      && uniqueStrings(body.runs.map(row => row.canonical_activity_id))
      && canonicalHash(body.current_week) === canonicalHash(expectedWeek)
      && canonicalHash(body.canonical_lift_activities) === canonicalHash(canonicalLiftActivities(body.lifts, body.owner_id));
  } catch { return false; }
}
function currentWeekPhysicalMaterial(observation, candidate, context) {
  if (!validateObservation(observation, context)) throw new Error('ACTIVITY_PHYSICAL_MATERIAL_SOURCE_INVALID');
  const current = observation.current_week;
  if (!Number.isSafeInteger(current.known_distance_lower_bound_m) || current.known_distance_lower_bound_m > 1000000) {
    throw new Error('ACTIVITY_PHYSICAL_MATERIAL_BOUND_EXCEEDED');
  }
  // The existing four-ID schema references this complete immutable evidence
  // artifact. No activity ID is discarded to fit that envelope.
  const credit = current.known_distance_lower_bound_m > 0 ? {
    schema_version: 1, source: 'CANONICAL_CURRENT_WEEK_LOWER_BOUND',
    planning_week_start_local: current.planning_week_start_local, through_local_date: current.through_local_date,
    completed_running_m: current.known_distance_lower_bound_m, evidence_ids: [`observation:${observation.content_hash}`],
  } : null;
  const material = require('./goalBackwardRecoveryMaterial').evaluateMaterialDose({
    candidate, planning_date_local: context.planning_date,
    candidate_window_end_local: addDays(current.planning_week_start_local, 6), completed_running_credit: credit,
  });
  return { version: VERSION, observation_hash: observation.content_hash,
    canonical_activity_count: current.canonical_activity_count,
    all_canonical_activity_ids_hash: canonicalHash(current.canonical_activity_ids),
    completion_credit_claimed: false, observed_plus_remaining_physical_lower_bound: material,
    // A duration-only prescription stays useful but has no invented distance.
    physical_distance_state: Number.isFinite(material.candidate_running_m)
      ? current.distance_state === 'PARTIAL' ? 'PARTIAL' : 'KNOWN' : 'UNKNOWN',
    absolute_safety_budget_claimed: false, coverage_state: observation.coverage_state };
}
module.exports = { VERSION, buildObservation, validateObservation, canonicalLiftActivities, currentWeekPhysicalMaterial, measure };
