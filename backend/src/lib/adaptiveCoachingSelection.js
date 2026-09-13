// Objective-led dose selection. No weekday, legacy calendar, or inferred pace authority.
const { canonicalHash, mondayFor, daysBetween, eventPolicyForGoal } = require('./racePlanPolicy');
const { progressionFamilyFor } = require('./adaptiveCoachingProgression');
const { validateCanonicalSession } = require('./canonicalWorkout');
const { validatePresentationFloor } = require('./goalBackwardValidators');
const { buildStrengthExercises } = require('./strengthPrescription');
const { canonicalStrengthExercise, EXERCISES_BY_ID } = require('./strengthDoseAccounting');
const { validateDistributedSession } = require('./distributedStrength');
const { classifyCompletionOutcome } = require('./adaptationEngine');

const POLICY = 'adaptive-observed-dose-v1';
const isStrength = family => family.startsWith('strength_');
const isRun = family => ['easy_run', 'recovery_run', 'long_aerobic', 'threshold_run', 'interval_run', 'race_rhythm_run', 'steady_run', 'race'].includes(family);
const clone = value => JSON.parse(JSON.stringify(value));
function usablePairs(state) {
  return state.adaptive_foundation.completion_pairs.filter(pair => {
    const s = pair.prescribed_session, o = pair.observation;
    const age = daysBetween(String(o.observed_at || '').slice(0, 10), state.planning_date_local);
    return validateCanonicalSession(s).valid && o.linked_session_id === s.session_id
      && o.quality_state === 'COMPLETE' && o.completed === true
      && classifyCompletionOutcome({ prescribed_session: s, observation: o }).outcome === 'ON_TARGET'
      && age !== null && age >= 0 && age <= 28
      && (!s.strength_distribution || validateDistributedSession(s, null));
  }).filter((pair, index, all) => all.findIndex(p => p.prescribed_session.session_id === pair.prescribed_session.session_id) === index);
}
function exerciseFromStep(step) {
  const reference = EXERCISES_BY_ID[step.exercise_id], t = step.target;
  if (!reference) return null;
  // External load is deliberately not progressed from session completion alone.
  return { name: reference.name, sets: t.sets, reps: String(t.repetitions), rest: `${t.rest_s} sec`,
    rpe: `${t.rpe_range.minimum}-${t.rpe_range.maximum}`, load: 'Choose a load within the prescribed effort range.' };
}
function floorFor(family, state) {
  for (let minutes = 5; minutes <= 180; minutes += 5) {
    if (validatePresentationFloor([{ workout_family: family, duration_min: minutes,
      quality_work_duration_min: minutes }], { training_age_class: state.training_age_class,
      recent_normal_running_minutes_per_week: state.recent_normal_running.median_duration_s / 60 }).valid) return minutes * 60;
  }
  return Infinity;
}
function strengthPool(state, pairs, taper) {
  const rows = pairs.filter(p => isStrength(p.prescribed_session.workout_family));
  const week = rows.map(p => mondayFor(p.observation.observed_at.slice(0, 10))).sort().at(-1);
  const latest = rows.filter(p => mondayFor(p.observation.observed_at.slice(0, 10)) === week);
  const byExercise = new Map();
  for (const pair of latest) for (const step of pair.prescribed_session.steps.filter(s => s.type === 'strength_exercise')) {
    const e = exerciseFromStep(step);
    if (!e) continue;
    const prior = byExercise.get(e.name);
    if (prior) prior.sets += e.sets;
    else byExercise.set(e.name, e);
  }
  const onlyUpper = taper || !['NORMAL', 'MONITOR'].includes(state.safety_action)
    || !['READY', 'NORMAL'].includes(state.recovery_state);
  let exercises = [...byExercise.values()].filter(e => !onlyUpper || canonicalStrengthExercise(e).region === 'upper');
  const observed = exercises.length >= 2;
  if (!observed) {
    // Existing strength prescription policy supplies a single minimum maintenance
    // exposure, never a five-session default in the absence of observed sets.
    const upper = buildStrengthExercises({ focus: 'Upper body', equipment: state.equipment, phase: 'taper' });
    const lower = buildStrengthExercises({ focus: 'Lower body', equipment: state.equipment, phase: 'taper' });
    exercises = onlyUpper ? upper.slice(0, 2) : [upper[0], lower[0]];
    exercises = exercises.map(e => ({ ...e, sets: 2, rpe: '6-7' }));
  } else if (taper || !['READY', 'NORMAL'].includes(state.recovery_state)) {
    exercises = exercises.map(e => ({ ...e, sets: Math.floor(e.sets * 0.5), rpe: '6-7' })).filter(e => e.sets >= 2);
  }
  return { exercises, observed, evidence_ids: latest.map(p => p.observation.evidence_id).filter(Boolean),
    basis: observed ? 'OBSERVED_COMPLETED_WEEK_STRENGTH' : 'EXISTING_MINIMUM_MAINTENANCE_POLICY', week };
}
function partitionStrength(pool, count) {
  // Two distinct exercises with >=2 sets each in every admitted partition.
  const remaining = pool.map(clone), parts = [];
  for (let i = 0; i < count; i++) {
    const choices = remaining.filter(e => e.sets >= 2).sort((a, b) => b.sets - a.sets || a.name.localeCompare(b.name));
    if (choices.length < 2) break;
    const part = choices.slice(0, 2).map(e => { e.sets -= 2; return { ...e, sets: 2 }; });
    parts.push(part);
  }
  // Conserve the observed objective dose where capacity permits it; leftovers
  // under a meaningful exposure are explicitly recorded, never token sessions.
  for (const e of remaining) {
    const matching = parts.flatMap(part => part.filter(p => p.name === e.name));
    if (matching.length) { matching[0].sets += e.sets; e.sets = 0; }
    else if (e.sets >= 2 && parts.length) { parts[0].push({ ...e }); e.sets = 0; }
  }
  return { parts, withheld_sets: remaining.reduce((n, e) => n + e.sets, 0) };
}
function buildAdaptiveSessionSelection(foundation) {
  const state = foundation.athlete_state, base = foundation.decision;
  const pairs = usablePairs(state), capacity = base.weekly_objectives.capacities;
  const taper = base.phase === 'TAPER_RACE_WEEK';
  const policy = base.goal_gap[0] ? eventPolicyForGoal(base.goal_gap[0].goal) : null;
  const factor = taper ? policy?.phase_running_floor_factor?.TAPER_RACE_WEEK ?? 0.5
    : ['READY', 'NORMAL'].includes(state.recovery_state) ? 1 : 0.6;
  const recent = state.recent_normal_running;
  const gapRatio = recent.status === 'TRAINING_GAP' ? (recent.median_distance_m > 0 && recent.forward_load_seed_m !== null
    ? Math.min(1, recent.forward_load_seed_m / recent.median_distance_m) : 0) : 1;
  const observedSeconds = recent.median_duration_s === null ? null : Math.floor(recent.median_duration_s * gapRatio);
  const runBudget = Number.isFinite(observedSeconds) ? Math.floor(observedSeconds * factor) : 0;
  const runDistance = recent.median_distance_m === null ? null : Math.floor(recent.median_distance_m * gapRatio);
  const observedRuns = (foundation.artifacts[0].payload_json.canonical_activities || []).filter(a => a.activity_kind === 'run'
    && a.quality_state === 'COMPLETE' && Number.isFinite(a.duration_s) && a.duration_s > 0
    && daysBetween(a.local_activity_date || a.observed_at.slice(0, 10), state.planning_date_local) >= 0
    && daysBetween(a.local_activity_date || a.observed_at.slice(0, 10), state.planning_date_local) <= 28);
  const durations = observedRuns.map(a => a.duration_s).sort((a, b) => a - b);
  const typicalObservedRun = durations.length ? durations[Math.floor((durations.length - 1) / 2)] : 0;
  const pool = strengthPool(state, pairs, taper);
  if (pool.observed && !taper) pool.exercises = pool.exercises.map(e => {
    const family = canonicalStrengthExercise(e).region === 'upper' ? 'strength_upper' : 'strength';
    const action = base.weekly_objectives.progression.find(p => p.family === family)?.action;
    return { ...e, sets: action === 'OMIT' ? 0 : action === 'REGRESS' ? Math.floor(e.sets * 0.9) : e.sets };
  }).filter(e => e.sets >= 2);
  const objectives = clone(base.weekly_objectives.objectives);
  const taperQuality = taper && pairs.find(p => ['threshold_run', 'interval_run'].includes(p.prescribed_session.workout_family));
  if (taperQuality && ['READY', 'NORMAL'].includes(state.recovery_state) && ['NORMAL', 'MONITOR'].includes(state.safety_action)) {
    objectives.push({ objective_id: `objective-taper-touch-${state.athlete_state_hash.slice(0, 24)}`,
      requirement_id: 'retain_observed_intensity', role: 'SUPPORTING', priority_score: 800,
      candidate_families: [taperQuality.prescribed_session.workout_family],
      goal_ids: base.goal_gap.map(g => g.goal_id), reason_codes: ['TAPER_VOLUME_REDUCTION'],
      evidence_ids: [taperQuality.observation.evidence_id].filter(Boolean) });
  }
  // A single aerobic adaptation can be partitioned into meaningful exposures.
  // The number is bounded by observed duration as well as requested capacity.
  const aerobicObjective = objectives.find(o => o.candidate_families.includes('easy_run'));
  if (aerobicObjective) {
    for (let n = objectives.filter(o => o.candidate_families.includes('easy_run')).length; n < 6; n++) {
      objectives.push({ ...clone(aerobicObjective), objective_id: `${aerobicObjective.objective_id}-partition-${n}`,
        requirement_id: `aerobic_dose_partition_${n}`, role: 'SUPPORTING', priority_score: 580 - n * 10 });
    }
  }
  const weeklyContent = { ...clone(base.weekly_objectives), objectives,
    dose_policy: { policy_id: POLICY, running_duration_ceiling_s: runBudget,
      running_distance_ceiling_m: Number.isFinite(runDistance) ? Math.floor(runDistance * factor) : null,
      taper_event_policy_id: taper ? policy?.event_policy_id ?? null : null,
      running_factor: factor, strength: pool } };
  delete weeklyContent.weekly_objectives_hash;
  const weekly = { ...weeklyContent, weekly_objectives_hash: canonicalHash(weeklyContent) };
  const entries = [], deferred = [];
  let remainingSeconds = runBudget, remainingMeters = weekly.dose_policy.running_distance_ceiling_m, runCount = 0;
  const defer = (o, reason) => deferred.push({ objective_id: o.objective_id, role: o.role, reason_codes: [reason] });
  const ordered = objectives.filter(o => o.role !== 'REST').sort((a, b) => b.priority_score - a.priority_score || a.objective_id.localeCompare(b.objective_id));
  const blocked = ['FULL_REST', 'PROFESSIONAL_ASSESSMENT_RECOMMENDED', 'MODIFIED_SESSION_ONLY'].includes(state.safety_action);
  for (const objective of ordered) {
    if (blocked) { defer(objective, 'INJURY_SCOPE'); continue; }
    if (objective.candidate_families.some(isStrength)) continue;
    const family = objective.candidate_families.find(isRun);
    if (!family) { defer(objective, 'OBSERVED_FAMILY_DOSE_UNAVAILABLE'); continue; }
    if (runCount >= capacity.run) { defer(objective, 'FREQUENCY_IS_CAPACITY'); continue; }
    const progression = weekly.progression.find(p => p.family === progressionFamilyFor(family));
    if (progression?.action === 'OMIT') { defer(objective, 'PROGRESSION_OMIT'); continue; }
    const prior = pairs.filter(p => p.prescribed_session.workout_family === family).at(-1);
    let seconds, qualitySeconds = null;
    if (['threshold_run', 'interval_run', 'race_rhythm_run', 'steady_run'].includes(family)) {
      if (!prior) { defer(objective, 'OBSERVED_FAMILY_DOSE_UNAVAILABLE'); continue; }
      const priorTotal = prior.prescribed_session.derived_totals.duration_s;
      qualitySeconds = prior.prescribed_session.derived_totals.work_duration_s;
      if (!qualitySeconds || !priorTotal) { defer(objective, 'OBSERVED_FAMILY_DOSE_UNAVAILABLE'); continue; }
      const change = progression?.action === 'ADVANCE' ? 1 + progression.max_increase_fraction
        : progression?.action === 'REGRESS' ? 0.9 : 1;
      qualitySeconds = Math.floor(qualitySeconds * (taper ? 0.5 : change));
      if (taper) qualitySeconds = Math.min(prior.prescribed_session.derived_totals.work_duration_s, Math.max(480, qualitySeconds));
      seconds = qualitySeconds + 1200;
    } else if (family === 'long_aerobic') {
      const longest = prior?.observation.observed_duration_s ?? prior?.prescribed_session.derived_totals.duration_s;
      if (!longest) { defer(objective, 'OBSERVED_FAMILY_DOSE_UNAVAILABLE'); continue; }
      seconds = Math.floor(longest * (taper ? 0.5 : progression?.action === 'REGRESS' ? 0.9 : 1));
    } else if (family === 'race') {
      defer(objective, 'EVENT_EXECUTION_MATERIAL_REQUIRED'); continue;
    } else {
      const floor = floorFor(family, state);
      const remainingCapacity = Math.max(1, capacity.run - runCount);
      seconds = Math.max(floor, Math.floor(remainingSeconds / remainingCapacity));
      // Never increase individual exposure merely because fewer days were requested.
      const observedMax = prior?.observation.observed_duration_s ?? typicalObservedRun;
      seconds = Math.min(seconds, observedMax);
    }
    const capSeconds = state.adaptive_foundation.max_session_minutes === null ? Infinity : state.adaptive_foundation.max_session_minutes * 60;
    seconds = Math.floor(Math.min(seconds, capSeconds));
    if (seconds > remainingSeconds || seconds < floorFor(family, state)
      || qualitySeconds !== null && (qualitySeconds < 480 || seconds < qualitySeconds + 1200)) {
      defer(objective, 'MEANINGFUL_DOSE_REQUIRED'); continue;
    }
    let distance = Number.isFinite(runDistance) && observedSeconds > 0 ? (seconds === remainingSeconds ? remainingMeters : Math.floor(seconds * runDistance / observedSeconds)) : null;
    if (progression?.allowed_variable === 'distance_m' && progression.next_level_ceiling !== null) {
      distance = Math.min(distance ?? progression.next_level_ceiling, progression.next_level_ceiling);
    }
    const id = `adaptive-${canonicalHash({ objective: objective.objective_id, family }).slice(0, 24)}`;
    entries.push({ selection_id: id, objective_ids: [objective.objective_id], requirement_id: objective.requirement_id,
      role: objective.role, priority_score: objective.priority_score, workout_family: family,
      progression_family: progressionFamilyFor(family), progression, duration_s: seconds, distance_m: distance,
      quality_work_s: qualitySeconds, dose_basis: { policy_id: POLICY, authority: 'OBSERVED_WEEKLY_RUNNING',
        observed_weekly_duration_s: observedSeconds, source_evidence_ids: prior ? [prior.observation.evidence_id].filter(Boolean) : [...new Set(observedRuns.flatMap(a => a.evidence_ids))],
        taper_factor: factor,
        ...(prior ? { observed_session_duration_s: prior.prescribed_session.derived_totals.duration_s,
          observed_work_duration_s: prior.prescribed_session.derived_totals.work_duration_s } : {}) }, reason_codes: objective.reason_codes });
    remainingSeconds -= seconds; if (distance !== null) remainingMeters -= distance; runCount++;
  }
  const strengthObjective = objectives.find(o => o.candidate_families.some(isStrength));
  if (strengthObjective && !blocked && capacity.lift > 0) {
    const partition = partitionStrength(pool.exercises, capacity.lift);
    partition.parts.forEach((exercises, index) => {
      const regions = new Set(exercises.map(e => canonicalStrengthExercise(e).region));
      const family = regions.size > 1 ? 'strength_full_body' : `strength_${[...regions][0]}`;
      entries.push({ selection_id: `adaptive-${canonicalHash({ objective: strengthObjective.objective_id, index }).slice(0, 24)}`,
        objective_ids: [strengthObjective.objective_id], requirement_id: `${strengthObjective.requirement_id}-${index}`,
        role: 'SUPPORTING', priority_score: strengthObjective.priority_score - index,
        workout_family: family, progression_family: progressionFamilyFor(family),
        progression: weekly.progression.find(p => p.family === progressionFamilyFor(family)), exercises,
        dose_basis: { policy_id: POLICY, authority: pool.basis, source_evidence_ids: pool.evidence_ids,
          observed_week: pool.week ?? null, withheld_sets: partition.withheld_sets }, reason_codes: strengthObjective.reason_codes });
    });
    if (!partition.parts.length) defer(strengthObjective, 'MEANINGFUL_DOSE_REQUIRED');
  }
  entries.sort((a, b) => b.priority_score - a.priority_score || a.selection_id.localeCompare(b.selection_id));
  return { weekly_objectives: weekly, entries: entries.map((e, i) => ({ ...e, priority_rank: i + 1 })),
    deferred_objectives: deferred, unused_running_duration_s: remainingSeconds, placement_validated: false };
}
module.exports = { POLICY, isRun, isStrength, buildAdaptiveSessionSelection };
