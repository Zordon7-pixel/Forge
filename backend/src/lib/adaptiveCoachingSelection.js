// Objective-led dose selection. No weekday, legacy calendar, or inferred pace authority.
const { canonicalHash, mondayFor, daysBetween, eventPolicyForGoal } = require('./racePlanPolicy');
const { progressionFamilyFor } = require('./adaptiveCoachingProgression');
const { validateCanonicalSession } = require('./canonicalWorkout');
const { validatePresentationFloor } = require('./goalBackwardValidators');
const { buildStrengthExercises } = require('./strengthPrescription');
const { canonicalStrengthExercise, EXERCISES_BY_ID } = require('./strengthDoseAccounting');
const { validateDistributedSession } = require('./distributedStrength');
const { classifyCompletionOutcome } = require('./adaptationEngine');

const { ownedEventEntries, strengthVariants, timedStructure, observedTargetInputs, observedHybridEntry } = require('./adaptiveCoachingDomain');

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
function strengthPool(state, pairs, taper, evidence) {
  // Duration/checkbox success cannot prove working sets. The existing observed
  // lift envelope can cap total future sets, but not per-exercise execution.
  const measuredSets = pair => {
    const raw = evidence.find(e => e.evidence_id === pair.observation.evidence_id);
    return raw?.truth_class === 'OBSERVED' && raw.quality_state === 'COMPLETE'
      && raw.value?.activity_kind === 'lift' && Number.isSafeInteger(raw.value.sets)
      && raw.value.sets > 0 ? raw.value.sets : null;
  };
  const rows = pairs.filter(p => isStrength(p.prescribed_session.workout_family) && measuredSets(p) !== null)
    .filter((p, i, all) => all.findIndex(q => q.observation.evidence_id === p.observation.evidence_id) === i);
  const week = rows.map(p => mondayFor(p.observation.observed_at.slice(0, 10))).sort().at(-1);
  const latest = rows.filter(p => mondayFor(p.observation.observed_at.slice(0, 10)) === week);
  const byExercise = new Map();
  for (const pair of latest) for (const step of pair.prescribed_session.steps.filter(s => s.type === 'strength_exercise')) {
    const e = exerciseFromStep(step);
    if (!e) continue;
    const selectedTotal = pair.prescribed_session.steps.filter(s => s.type === 'strength_exercise').reduce((n, s) => n + s.target.sets, 0);
    e.sets = Math.floor(e.sets * Math.min(1, measuredSets(pair) / selectedTotal));
    if (e.sets < 2) continue;
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
    basis: observed ? 'OBSERVED_TOTAL_SET_CAP_FUTURE_DISTRIBUTION' : 'EXISTING_MINIMUM_MAINTENANCE_POLICY',
    confidence: observed ? 'LOW' : 'INSUFFICIENT', individual_exercise_completion_verified: false, week };
}
function partitionStrength(pool, count) {
  // Two distinct exercises with >=2 sets each in every admitted partition.
  const remaining = pool.map(clone), parts = [];
  for (let i = 0; i < count; i++) {
    const choices = remaining.filter(e => e.sets >= 2).sort((a, b) => b.sets - a.sets || a.name.localeCompare(b.name));
    if (choices.length < 2) break;
    // Keep compatible regions together when the accepted repertoire permits
    // it. Mixing every partition needlessly duplicates lower-body fatigue.
    const region = e => canonicalStrengthExercise(e).region;
    const compatible = choices.filter(e => region(e) === region(choices[0]));
    const selected = compatible.length >= 2 ? compatible : choices;
    const part = selected.slice(0, 2).map(e => { e.sets -= 2; return { ...e, sets: 2 }; });
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
function buildAdaptiveSessionSelection(foundation, domain = {}) {
  if (!domain || typeof domain !== 'object' || Array.isArray(domain) || Object.keys(domain).some(k => k !== 'event_material')) throw new Error('Unsupported adaptive domain inputs');
  const events = ownedEventEntries(foundation, domain.event_material);
  const state = foundation.athlete_state, base = foundation.decision;
  const pairs = usablePairs(state), capacity = base.weekly_objectives.capacities;
  const taper = base.phase === 'TAPER_RACE_WEEK';
  const policy = base.goal_gap[0] ? eventPolicyForGoal(base.goal_gap[0].goal) : null;
  const factor = taper ? policy?.phase_running_floor_factor?.TAPER_RACE_WEEK ?? 0.5
    : ['READY', 'NORMAL'].includes(state.recovery_state) ? 1 : 0.6;
  const recent = state.recent_normal_running;
  const gapRatio = recent.status === 'TRAINING_GAP' ? (recent.median_distance_m > 0 && recent.forward_load_seed_m !== null
    ? Math.min(1, recent.forward_load_seed_m / recent.median_distance_m) : 0) : 1;
  let observedSeconds = recent.median_duration_s === null ? null : Math.floor(recent.median_duration_s * gapRatio);
  let runBudget = Number.isFinite(observedSeconds) ? Math.floor(observedSeconds * factor) : 0;
  let runDistance = recent.median_distance_m === null ? null : Math.floor(recent.median_distance_m * gapRatio);
  const observedRuns = (foundation.artifacts[0].payload_json.canonical_activities || []).filter(a => a.activity_kind === 'run'
    && a.quality_state === 'COMPLETE' && Number.isFinite(a.duration_s) && a.duration_s > 0
    && Date.parse(a.observed_at) <= Date.parse(foundation.artifacts[0].payload_json.created_at)
    && daysBetween(a.local_activity_date || a.observed_at.slice(0, 10), state.planning_date_local) >= 0
    && daysBetween(a.local_activity_date || a.observed_at.slice(0, 10), state.planning_date_local) <= 28);
  let recentExposure = null;
  if (observedSeconds === null && recent.status !== 'TRAINING_GAP' && ['BEGINNER', 'RETURNING'].includes(state.training_age_class)) {
    recentExposure = observedRuns.filter(a => daysBetween(a.local_activity_date || a.observed_at.slice(0, 10), state.planning_date_local) <= 7)
      .sort((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)))[0] || null;
    if (recentExposure) {
      observedSeconds = recentExposure.duration_s;
      runDistance = recentExposure.distance_m;
      runBudget = Math.floor(observedSeconds * factor);
    }
  }
  let lowerBoundSeed = null;
  if (observedSeconds === null && recent.status !== 'TRAINING_GAP'
    && !['BEGINNER', 'RETURNING'].includes(state.training_age_class)) {
    // A forward prescription cap, not a complete-week observation or an
    // established fitness baseline. Use the smaller of the observed recent
    // seven days and the 28-day weekly average; never extrapolate missing days.
    const recentRuns = observedRuns.filter(a => daysBetween(a.local_activity_date || a.observed_at.slice(0, 10), state.planning_date_local) < 7);
    const sum = (rows, key) => rows.reduce((n, a) => n + (Number.isFinite(a[key]) ? a[key] : 0), 0);
    const seconds = Math.floor(Math.min(sum(recentRuns, 'duration_s'), sum(observedRuns, 'duration_s') / 4));
    if (seconds > 0) {
      lowerBoundSeed = { duration_s: seconds, confidence: 'LOW', coverage_state: 'UNKNOWN',
        source_evidence_ids: [...new Set(observedRuns.flatMap(a => a.evidence_ids))] };
      observedSeconds = seconds;
      runDistance = observedRuns.every(a => Number.isFinite(a.distance_m))
        ? Math.floor(Math.min(sum(recentRuns, 'distance_m'), sum(observedRuns, 'distance_m') / 4)) : null;
      runBudget = Math.floor(seconds * factor);
    }
  }
  const durations = observedRuns.map(a => a.duration_s).sort((a, b) => a - b);
  const typicalObservedRun = durations.length ? durations[Math.floor((durations.length - 1) / 2)] : 0;
  const pool = strengthPool(state, pairs, taper, foundation.artifacts[0].payload_json.evidence);
  if (pool.observed && !taper) pool.exercises = pool.exercises.map(e => {
    const family = canonicalStrengthExercise(e).region === 'upper' ? 'strength_upper' : 'strength';
    const action = base.weekly_objectives.progression.find(p => p.family === family)?.action;
    return { ...e, sets: action === 'OMIT' ? 0 : action === 'REGRESS' ? Math.floor(e.sets * 0.9) : e.sets };
  }).filter(e => e.sets >= 2);
  const objectives = clone(base.weekly_objectives.objectives);
  for (const event of events) objectives.push({ objective_id: event.objective_ids[0],
    requirement_id: event.requirement_id, role: event.role, priority_score: event.priority_score,
    candidate_families: ['race'], goal_ids: [event.event_identity.goal_id], reason_codes: event.reason_codes,
    evidence_ids: event.dose_basis.source_evidence_ids });
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
        requirement_id: `aerobic_dose_partition_${n}`, role: 'SUPPORTING', priority_score: 580 - n * 10,
        // Retain supported taper touches at the existing recovery floor; the
        // primary easy exposure and total reduced budget remain authoritative.
        ...(taper ? { candidate_families: ['recovery_run'] } : {}) });
    }
  }
  const weeklyContent = { ...clone(base.weekly_objectives), objectives, owned_events: base.goal_gap.map(g => g.goal).filter(g => g.planning_eligible),
    dose_policy: { policy_id: POLICY, forward_lower_bound_seed: lowerBoundSeed, running_duration_ceiling_s: runBudget,
      running_distance_ceiling_m: Number.isFinite(runDistance) ? Math.floor(runDistance * factor) : null,
      taper_event_policy_id: taper ? policy?.event_policy_id ?? null : null,
      running_factor: factor, strength: pool } };
  delete weeklyContent.weekly_objectives_hash;
  const weekly = { ...weeklyContent, weekly_objectives_hash: canonicalHash(weeklyContent) };
  const entries = [...events], deferred = [];
  let remainingSeconds = Math.max(0, runBudget - events.reduce((n, e) => n + e.duration_s, 0));
  let remainingMeters = weekly.dose_policy.running_distance_ceiling_m === null ? null
    : Math.max(0, weekly.dose_policy.running_distance_ceiling_m - events.reduce((n, e) => n + e.distance_m, 0));
  let runCount = events.length;
  const defer = (o, reason) => deferred.push({ objective_id: o.objective_id, role: o.role, reason_codes: [reason] });
  const ordered = objectives.filter(o => o.role !== 'REST').sort((a, b) => b.priority_score - a.priority_score || a.objective_id.localeCompare(b.objective_id));
  const blocked = ['FULL_REST', 'PROFESSIONAL_ASSESSMENT_RECOMMENDED', 'MODIFIED_SESSION_ONLY'].includes(state.safety_action);
  for (const objective of ordered) {
    if (events.some(e => e.requirement_id === objective.requirement_id)) continue;
    if (blocked) { defer(objective, 'INJURY_SCOPE'); continue; }
    if (objective.candidate_families.some(isStrength)) continue;
    const family = objective.candidate_families.find(isRun);
    if (!family) {
      const hybrid = observedHybridEntry(objective, pairs, state, base.goal_gap.find(g => objective.goal_ids.includes(g.goal_id))?.goal.event_kind);
      const resources = hybrid ? require('./adaptiveCoachingObjectives').capacitiesFor(hybrid.workout_family) : [];
      const used = resource => entries.filter(e => require('./adaptiveCoachingObjectives').capacitiesFor(e.workout_family).includes(resource)).length;
      const progression = hybrid && weekly.progression.find(p => p.family === hybrid.progression_family);
      if (!hybrid || progression?.action === 'OMIT' || progression?.action === 'REGRESS' || taper) {
        defer(objective, 'OBSERVED_FAMILY_DOSE_UNAVAILABLE'); continue;
      }
      if (resources.some(r => used(r) >= capacity[r])) { defer(objective, 'FREQUENCY_IS_CAPACITY'); continue; }
      entries.push(hybrid);
      if (resources.includes('run')) {
        remainingSeconds -= hybrid.duration_s;
        if (remainingMeters !== null) remainingMeters -= hybrid.running_distance_m;
        runCount++;
      }
      continue;
    }
    if (runCount >= capacity.run) { defer(objective, 'FREQUENCY_IS_CAPACITY'); continue; }
    const progression = weekly.progression.find(p => p.family === progressionFamilyFor(family));
    if (progression?.action === 'OMIT') { defer(objective, 'PROGRESSION_OMIT'); continue; }
    const prior = pairs.filter(p => p.prescribed_session.workout_family === family).at(-1);
    let seconds, qualitySeconds = null, structureScale = null, longDistance = null;
    if (['threshold_run', 'interval_run', 'race_rhythm_run', 'steady_run', 'long_aerobic'].includes(family)
      && (!Number.isFinite(prior?.observation.observed_duration_s) || prior.observation.observed_duration_s <= 0
        || !Number.isFinite(prior.observation.observed_work_duration_s) || prior.observation.observed_work_duration_s <= 0
        || prior.observation.observed_work_duration_s > prior.observation.observed_duration_s)) {
      defer(objective, 'OBSERVED_FAMILY_DOSE_UNAVAILABLE'); continue;
    }
    if (['threshold_run', 'interval_run', 'race_rhythm_run', 'steady_run'].includes(family)) {
      if (!prior) { defer(objective, 'OBSERVED_FAMILY_DOSE_UNAVAILABLE'); continue; }
      const priorTotal = prior.prescribed_session.derived_totals.duration_s;
      qualitySeconds = prior.observation.observed_work_duration_s;
      if (!qualitySeconds || !priorTotal) { defer(objective, 'OBSERVED_FAMILY_DOSE_UNAVAILABLE'); continue; }
      const change = progression?.action === 'ADVANCE' ? 1 + progression.max_increase_fraction
        : progression?.action === 'REGRESS' ? 0.9 : 1;
      qualitySeconds = Math.floor(qualitySeconds * (taper ? 0.5 : change));
      if (taper) qualitySeconds = Math.min(prior.observation.observed_work_duration_s, Math.max(480, qualitySeconds));
      const structure = timedStructure(prior);
      if (!structure) { defer(objective, 'OBSERVED_FAMILY_DOSE_UNAVAILABLE'); continue; }
      const scale = structureScale = qualitySeconds / prior.prescribed_session.derived_totals.work_duration_s;
      const meaningfulLeaves = steps => steps.every(s => s.type === 'repeat' ? meaningfulLeaves(s.children)
        : s.step_role !== 'WORK' || Math.floor(s.target.duration_s * scale) > 0);
      if (!meaningfulLeaves(structure)) { defer(objective, 'MEANINGFUL_DOSE_REQUIRED'); continue; }
      const scaledWork = (steps, multiplier = 1) => steps.reduce((n, s) => n + (s.type === 'repeat'
        ? scaledWork(s.children, multiplier * s.repeat_count)
        : s.step_role === 'WORK' ? Math.floor(s.target.duration_s * scale) * multiplier : 0), 0);
      qualitySeconds = scaledWork(structure);
      seconds = qualitySeconds + priorTotal - prior.prescribed_session.derived_totals.work_duration_s;
    } else if (family === 'long_aerobic') {
      const longest = prior?.observation.observed_duration_s ?? prior?.prescribed_session.derived_totals.duration_s;
      if (!longest) { defer(objective, 'OBSERVED_FAMILY_DOSE_UNAVAILABLE'); continue; }
      const demand = weekly.long_run_demand;
      const measuredDistance = prior.observation.observed_distance_m;
      const requestedDistance = demand?.next_distance_ceiling_m;
      if (!taper && Number.isFinite(requestedDistance) && measuredDistance > 0) {
        longDistance = Math.min(requestedDistance, progression.next_level_ceiling);
        seconds = Math.ceil(longest * longDistance / measuredDistance);
      } else seconds = Math.floor(longest * (taper ? 0.5 : progression?.action === 'REGRESS' ? 0.9 : 1));
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
      || qualitySeconds !== null && (qualitySeconds < 480 || seconds < qualitySeconds + (prior.prescribed_session.derived_totals.duration_s - prior.prescribed_session.derived_totals.work_duration_s))) {
      defer(objective, 'MEANINGFUL_DOSE_REQUIRED'); continue;
    }
    let distance = Number.isFinite(runDistance) && observedSeconds > 0 ? (seconds === remainingSeconds ? remainingMeters : Math.min(remainingMeters, Math.floor(seconds * runDistance / observedSeconds))) : null;
    if (longDistance !== null) distance = Math.min(remainingMeters ?? longDistance,
      longDistance, Math.floor(prior.observation.observed_distance_m * seconds / prior.observation.observed_duration_s));
    if (progression?.allowed_variable === 'distance_m' && progression.next_level_ceiling !== null) {
      distance = Math.min(distance ?? progression.next_level_ceiling, progression.next_level_ceiling);
    }
    const id = `adaptive-${canonicalHash({ objective: objective.objective_id, family }).slice(0, 24)}`;
    entries.push({ selection_id: id, objective_ids: [objective.objective_id], requirement_id: objective.requirement_id,
      role: objective.role, priority_score: objective.priority_score, workout_family: family,
      progression_family: progressionFamilyFor(family), progression, duration_s: seconds, distance_m: distance,
      quality_work_s: qualitySeconds,
      ...(qualitySeconds !== null ? { completed_prescription_structure: timedStructure(prior), structure_work_scale: structureScale } : {}),
      target_inputs: observedTargetInputs(pairs, family), dose_basis: { policy_id: POLICY, authority: recentExposure ? 'OBSERVED_RECENT_SINGLE_EXPOSURE_CAP' : lowerBoundSeed ? 'OBSERVED_LOWER_BOUND_FORWARD_CAP' : 'OBSERVED_WEEKLY_RUNNING',
        ...(lowerBoundSeed ? { confidence: 'LOW', coverage_state: 'UNKNOWN', forward_duration_cap_s: observedSeconds } : {}),
        observed_weekly_duration_s: recentExposure || lowerBoundSeed ? null : observedSeconds,
        ...(recentExposure ? { observed_recent_exposure_duration_s: recentExposure.duration_s } : {}), source_evidence_ids: prior ? [prior.observation.evidence_id].filter(Boolean) : recentExposure ? recentExposure.evidence_ids : [...new Set(observedRuns.flatMap(a => a.evidence_ids))],
        taper_factor: factor,
        ...(prior && Number.isFinite(prior.observation.observed_duration_s) && Number.isFinite(prior.observation.observed_work_duration_s) ? { observed_session_duration_s: prior.observation.observed_duration_s,
          observed_work_duration_s: prior.observation.observed_work_duration_s } : {}) }, reason_codes: objective.reason_codes });
    remainingSeconds -= seconds; if (distance !== null) remainingMeters -= distance; runCount++;
  }
  // Retain a sub-floor remainder inside an already meaningful easy exposure,
  // rather than losing useful aerobic dose solely to equal slot division.
  // This is still unplaced selection, bounded by observed individual duration.
  for (const entry of [...entries].reverse().filter(e => ['easy_run', 'recovery_run'].includes(e.workout_family))) {
    if (remainingSeconds >= floorFor(entry.workout_family, state)) continue;
    const individualCap = Math.min(typicalObservedRun, state.adaptive_foundation.max_session_minutes === null
      ? Infinity : state.adaptive_foundation.max_session_minutes * 60);
    const extra = Math.max(0, Math.min(remainingSeconds, individualCap - entry.duration_s));
    if (!extra) continue;
    const meters = remainingMeters === null ? null : extra === remainingSeconds ? remainingMeters
      : Math.min(remainingMeters, Math.floor(extra * runDistance / observedSeconds));
    entry.duration_s += extra;
    if (meters !== null) { entry.distance_m += meters; remainingMeters -= meters; }
    remainingSeconds -= extra;
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
          confidence: pool.confidence, individual_exercise_completion_verified: false,
          observed_week: pool.week ?? null, withheld_sets: partition.withheld_sets }, reason_codes: strengthObjective.reason_codes });
    });
    if (!partition.parts.length) defer(strengthObjective, 'MEANINGFUL_DOSE_REQUIRED');
  }
  entries.sort((a, b) => b.priority_score - a.priority_score || a.selection_id.localeCompare(b.selection_id));
  return { weekly_objectives: weekly, entries: entries.map((e, i) => ({ ...e, priority_rank: i + 1, dose_variants: strengthVariants(e).slice(1) })),
    deferred_objectives: deferred, unused_running_duration_s: remainingSeconds, placement_validated: false };
}
module.exports = { POLICY, isRun, isStrength, usablePairs, buildAdaptiveSessionSelection };
