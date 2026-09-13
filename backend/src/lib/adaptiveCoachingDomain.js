// Internal domain adapters. Canonical event material is a prescription, never an observation.
const { canonicalHash, addDays } = require('./racePlanPolicy');
const { validateCanonicalSession } = require('./canonicalWorkout');
const { targetTypeForWorkoutFamily } = require('./goalBackwardTargets');
const clone = value => JSON.parse(JSON.stringify(value));
const EVENT_KEYS = ['athlete_id', 'race_id', 'goal_id', 'event_local_date', 'event_kind', 'event_revision', 'source_revision'];
function ownedEventEntries(foundation, material = []) {
  if (!Array.isArray(material) || material.length > 7) throw new Error('At most seven canonical event prescriptions are supported');
  const state = foundation.athlete_state;
  const goals = foundation.decision.goal_gap.map(g => g.goal).filter(g => g.planning_eligible
    && g.event_local_date >= state.planning_date_local && g.event_local_date <= addDays(state.planning_date_local, 6));
  const ids = new Set(foundation.artifacts[0].payload_json.evidence.map(e => e.evidence_id));
  const entries = material.map(session => {
    const goal = goals.find(g => g.goal_id === session?.event_identity?.goal_id);
    if (!goal || !goal.race_id || !validateCanonicalSession(session).valid || session.workout_family !== 'race'
      || !EVENT_KEYS.every(k => session.event_identity[k] !== undefined && session.event_identity[k] === goal[k])
      || session.scheduled_local_date !== goal.event_local_date || session.event_kind !== goal.event_kind
      || !['ROAD_SHORT', 'ROAD_ENDURANCE', 'MARATHON'].includes(goal.event_kind)
      || session.derived_totals.duration_s <= 0 || !Number.isFinite(goal.distance_miles)
      || Math.abs(session.derived_totals.work_distance_m - Math.round(goal.distance_miles * 1609.344)) > 1
      || session.derived_totals.distance_m < session.derived_totals.work_distance_m
      || session.steps.some(s => !s.target || !Number.isSafeInteger(s.target.duration_s) || s.target.duration_s <= 0
        || s.target.pace_range_s_per_km || s.target.heart_rate_range_bpm || s.target.reference_pace_range_s_per_km)
      || !session.steps.some(s => s.type === 'warmup') || !session.steps.some(s => s.type === 'cooldown')
      || session.target_provenance.some(p => p.source_evidence_ids.some(id => !ids.has(id)))) {
      throw new Error('Event material must be a complete effort-based owned road prescription matching the exact goal revision/date/distance');
    }
    const objective = `objective-event-${canonicalHash(session.event_identity).slice(0, 24)}`;
    return { selection_id: `adaptive-event-${canonicalHash(session.event_identity).slice(0, 24)}`,
      objective_ids: [objective], requirement_id: objective, role: 'PRIMARY_KEY', priority_score: 3000,
      workout_family: 'race', progression_family: null, duration_s: session.derived_totals.duration_s,
      distance_m: session.derived_totals.distance_m, quality_work_s: null,
      fixed_date: goal.event_local_date, event_identity: clone(session.event_identity), canonical_steps: clone(session.steps),
      dose_basis: { policy_id: 'adaptive-observed-dose-v1', authority: 'OWNED_EVENT_PRESCRIPTION',
        source_evidence_ids: [...new Set(session.target_provenance.flatMap(p => p.source_evidence_ids))],
        source_prescription_hash: session.content_hash }, reason_codes: ['WEEKLY_OBJECTIVE_REQUIRED'] };
  });
  if (new Set(entries.map(e => e.event_identity.goal_id)).size !== entries.length) throw new Error('Duplicate event prescription');
  return entries;
}
function strengthVariants(entry) {
  if (!entry.exercises) return [entry];
  const originalSets = entry.exercises.reduce((n, e) => n + e.sets, 0);
  const variants = [entry];
  for (const fraction of [0.75, 0.5]) {
    const exercises = entry.exercises.map(e => ({ ...e, sets: Math.max(2, Math.floor(e.sets * fraction)) }));
    const retained = exercises.reduce((n, e) => n + e.sets, 0);
    if (retained === originalSets || variants.some(v => canonicalHash(v.exercises) === canonicalHash(exercises))) continue;
    variants.push({ ...entry, exercises, dose_basis: { ...entry.dose_basis,
      variant: 'REDUCED_SUPPORTING_STRENGTH', original_selected_sets: originalSets,
      retained_sets: retained, reduction_withheld_sets: originalSets - retained } });
  }
  return variants;
}
// Preserve the completed prescription's topology only when every leaf has a
// timed dose. Completion confirms success; it does not turn leaf targets into measurements.
function timedStructure(pair) {
  if (!pair) return null;
  const steps = pair.prescribed_session.steps;
  let leaves = 0;
  function valid(list) {
    return list.every(s => s.type === 'repeat' ? Number.isSafeInteger(s.repeat_count) && s.repeat_count > 0 && valid(s.children || [])
      : (++leaves <= 64 && ['warmup', 'run', 'interval', 'recovery', 'cooldown'].includes(s.type)
        && Number.isSafeInteger(s.target?.duration_s) && s.target.duration_s > 0));
  }
  return valid(steps) && leaves > 0 ? clone(steps) : null;
}
function observedTargetInputs(pairs, family) {
  const targetType = targetTypeForWorkoutFamily(family);
  const comparable = pairs.filter(p => p.prescribed_session.workout_family === family).flatMap(p => {
    const o = p.observation;
    if (!Array.isArray(o.work_segments) || !o.work_segments.length || o.work_segments.length > 64 || !o.surface_class
      || o.work_segments.some(s => !s || s.quality_state !== 'COMPLETE' || s.step_role !== 'WORK'
        || !Number.isFinite(s.observed_duration_s) || s.observed_duration_s <= 0
        || !Number.isFinite(s.observed_distance_m) || s.observed_distance_m <= 0)) return [];
    return [{ evidence_id: o.evidence_id, observed_at: o.observed_at, quality_state: o.quality_state,
      conflict: o.conflict, unresolved_conflict: o.unresolved_conflict, completed: true,
      surface_class: o.surface_class, target_type: targetType, workout_family: family,
      work_segment_paces_s_per_km: o.work_segments.map(s => s.observed_duration_s * 1000 / s.observed_distance_m) }];
  });
  return { comparable_sessions: comparable };
}
function observedHybridEntry(objective, pairs, state, eventKind) {
  const { STATION_ORDER } = require('./hyroxStandards');
  const pair = pairs.filter(p => objective.candidate_families.includes(p.prescribed_session.workout_family)
    && p.prescribed_session.workout_family.startsWith('hyrox_')).at(-1);
  if (!pair) return null;
  const source = pair.prescribed_session, observation = pair.observation;
  const stations = source.steps.filter(s => s.type === 'station');
  // Individual completed station measurements are required, including in Doubles.
  // A team time or planned split never authorizes an athlete's dose or exact load.
  if (!['warmup', 'mobility'].includes(source.steps[0]?.type) || !['cooldown', 'mobility'].includes(source.steps.at(-1)?.type)
    || source.steps.some(s => !Number.isSafeInteger(s.target?.duration_s) || s.target.duration_s <= 0)) return null;
  const runDistance = source.steps.filter(s => ['run', 'interval', 'warmup', 'cooldown', 'recovery'].includes(s.type)).reduce((n, s) => n + (s.target.distance_m || 0), 0);
  if (runDistance > 0 && observation.observed_running_distance_m !== runDistance) return null;
  if (source.hyrox_event_state && (source.hyrox_event_state.athlete_id !== state.athlete_id
    || eventKind && source.hyrox_event_state.format !== (eventKind === 'HYROX_DOUBLES' ? 'doubles' : 'singles'))) return null;
  if (!stations.length || stations.some(s => !STATION_ORDER.includes(s.station_id))
    || observation.observed_duration_s !== source.derived_totals.duration_s
    || !Array.isArray(observation.observed_station_doses)
    || stations.some(s => {
      const measured = observation.observed_station_doses.find(o => o && o.step_id === s.step_id);
      return !measured || measured.athlete_id !== state.athlete_id || measured.quality_state !== 'COMPLETE'
        || ['duration_s', 'distance_m', 'repetitions', 'load_kg'].some(k => s.target[k] !== undefined
          && measured[k] !== s.target[k]);
    })) return null;
  const metadata = {};
  for (const key of ['hyrox_event_state', 'partial_race_order_cluster', 'run_station_pair_count',
    'main_work_duration_s', 'main_work_duration_min', 'main_set_rpe_range', 'main_set_running_m',
    'warmup_cooldown_running_m', 'running_distance_m', 'ruleset_id', 'ruleset_version']) {
    if (source[key] !== undefined) metadata[key] = clone(source[key]);
  }
  if (metadata.partial_race_order_cluster) metadata.partial_race_order_cluster.completion = {
    status: 'PLANNED', completed_step_ids: [], stop_criteria_breach: false };
  return { selection_id: `adaptive-${canonicalHash({ objective: objective.objective_id, family: source.workout_family }).slice(0, 24)}`,
    objective_ids: [objective.objective_id], requirement_id: objective.requirement_id,
    role: objective.role, priority_score: objective.priority_score, workout_family: source.workout_family,
    progression_family: require('./adaptiveCoachingProgression').progressionFamilyFor(source.workout_family),
    duration_s: source.derived_totals.duration_s, distance_m: null,
    running_distance_m: runDistance, quality_work_s: source.derived_totals.work_duration_s,
    canonical_steps: clone(source.steps), canonical_metadata: metadata,
    ...(source.workout_family === 'hyrox_partial_simulation' ? { earliest_date: addDays(
      state.adaptive_foundation.completion_pairs.filter(p => p.prescribed_session?.workout_family === 'hyrox_partial_simulation'
        && p.observation?.quality_state === 'COMPLETE' && p.observation.observed_duration_s > 0
        && typeof p.observation.observed_at === 'string'
        && p.observation.observed_at.slice(0, 10) <= state.planning_date_local)
        .map(p => p.observation.observed_at.slice(0, 10)).sort().at(-1) || observation.observed_at.slice(0, 10), 14) } : {}),
    dose_basis: { policy_id: 'adaptive-observed-dose-v1', authority: 'OBSERVED_INDIVIDUAL_HYROX_DOSE',
      source_evidence_ids: [observation.evidence_id], source_prescription_hash: source.content_hash,
      observed_duration_s: observation.observed_duration_s, observed_running_distance_m: observation.observed_running_distance_m ?? null,
      progression: 'HOLD_VERIFIED_STATION_DOSE' }, reason_codes: objective.reason_codes };
}
module.exports = { ownedEventEntries, strengthVariants, timedStructure, observedTargetInputs, observedHybridEntry };
