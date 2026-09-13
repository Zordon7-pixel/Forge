const { canonicalHash, eventPolicyForGoal, minimumWeeklyDemandFor, STRESS_TAXONOMY_V1 } = require('./racePlanPolicy');
const { buildDueExposureLedger } = require('./goalBackwardDecisionEngine');
const { calculateFatigueCeilings, resolveStressVector } = require('./goalBackwardLoad');
const { validatePresentationFloor } = require('./goalBackwardValidators');
const { progressionFamilyFor } = require('./adaptiveCoachingProgression');

function meaningfulDose(family, state) {
  const constraints = { validator: 'presentation_floor', training_age_class: state.training_age_class,
    recent_normal_running_minutes_per_week: state.recent_normal_running.median_duration_s === null
      ? undefined : state.recent_normal_running.median_duration_s / 60 };
  if (family.startsWith('strength_')) return { validator: 'presentation_floor', minimum_exercises: 2, minimum_working_sets_per_exercise: 2 };
  if (family.startsWith('hyrox_')) return { validator: 'presentation_floor', event_policy_required: true };
  // Ask the existing validator for its dose floor instead of maintaining another table.
  for (let minutes = 5; minutes <= 180; minutes += 5) {
    if (validatePresentationFloor([{ workout_family: family, duration_min: minutes,
      quality_work_duration_min: minutes }], constraints).valid) {
      return { validator: 'presentation_floor', minimum_duration_s: minutes * 60,
        quality_work_floor_applies: ['threshold_run', 'interval_run', 'race_rhythm_run'].includes(family) };
    }
  }
  throw new Error('No meaningful dose resolved');
}

function capacitiesFor(family) {
  if (family === 'rest' || family === 'mobility') return [];
  if (family.startsWith('strength_') || family === 'hyrox_station_skill' || family === 'hyrox_station_strength') return ['lift'];
  if (family.startsWith('hyrox_')) return ['run', 'lift'];
  return ['run'];
}

function buildWeeklyObjectives({ athleteState, goalGaps, phaseDecision, progression } = {}) {
  const primary = goalGaps[0] || null;
  const policy = primary ? eventPolicyForGoal(primary.goal) : null;
  const phase = phaseDecision.phase;
  const ready = ['READY', 'NORMAL'].includes(athleteState.recovery_state);
  const safety = athleteState.safety_action;
  const capacity = athleteState.adaptive_foundation.capacities;
  const ceilings = calculateFatigueCeilings(athleteState.cross_modal_recent_normal, {
    training_age_class: athleteState.training_age_class, consistency_state: athleteState.consistency_state,
    recovery_state: athleteState.recovery_state, safety_action: safety, event_policy: policy,
  });
  const factor = phase === 'TAPER_RACE_WEEK' ? 0.5 : phase === 'POST_RACE_TRANSITION' || !ready ? 0.6 : 1;
  const budget = ceilings.normal_ceiling_vector.map(v => Math.floor(v * factor));
  const ledger = buildDueExposureLedger({ event_policy: policy, phase, athlete_state: athleteState,
    training_age_class: athleteState.training_age_class, consistency_state: athleteState.consistency_state,
    recovery_state: athleteState.recovery_state, safety_action: safety,
    available_days_count: athleteState.available_days.length,
    road_performance_qualified: primary?.feasibility_status === 'SUPPORTED',
  });
  const demand = policy ? minimumWeeklyDemandFor(policy.event_policy_id, { phase,
    recent_normal_status: athleteState.recent_normal_running.status,
    recent_normal_median_distance_m: athleteState.recent_normal_running.median_distance_m }) : null;
  const objectives = [];
  function add(requirement, families, role, priority) {
    const permitted = families.filter(f => {
      const prog = progression.find(p => p.family === progressionFamilyFor(f));
      if (!resolveStressVector(f, { event_kind: policy?.event_kind })) return false;
      if (prog?.action === 'OMIT') return false;
      if ((!ready || !['NORMAL', 'MONITOR'].includes(safety))
        && !['recovery_run', 'easy_run', 'strength_upper', 'hyrox_station_skill'].includes(f)) return false;
      return true;
    });
    const id = `objective-${canonicalHash({ state: athleteState.athlete_state_hash, phase, requirement }).slice(0, 24)}`;
    objectives.push({ objective_id: id, requirement_id: requirement, role, priority_score: priority,
      goal_ids: primary ? [primary.goal_id] : [], candidate_families: permitted,
      reason_codes: ['WEEKLY_OBJECTIVE_REQUIRED', ...phaseDecision.reason_codes],
      evidence_ids: [...new Set([...(primary?.evidence_ids || []), ...athleteState.recovery_evidence_ids])].sort(),
    });
  }
  const restOnly = ['FULL_REST', 'PROFESSIONAL_ASSESSMENT_RECOMMENDED', 'MODIFIED_SESSION_ONLY'].includes(safety);
  if (!restOnly) {
    ledger.due_roles.forEach((entry, i) => add(entry.requirement_id, entry.any_of, entry.role,
      entry.role === 'PRIMARY_KEY' ? 1000 - i * 10 : 500 - i * 10));
    if (!ledger.due_roles.length && phase !== 'POST_RACE_TRANSITION') add('aerobic_consistency', ['easy_run', 'recovery_run'], 'PRIMARY_KEY', 900);
    // Additional aerobic work follows observed useful dose, not requested frequency.
    const medianMinutes = athleteState.recent_normal_running.median_duration_s;
    const aerobicCount = ready && medianMinutes !== null
      ? Math.min(3, Math.max(0, Math.floor(medianMinutes / 60 / 40) - ledger.required_primary_count)) : 0;
    for (let i = 0; i < aerobicCount && !['TAPER_RACE_WEEK', 'POST_RACE_TRANSITION'].includes(phase); i += 1) {
      add(`aerobic_support_${i + 1}`, ['easy_run'], 'SUPPORTING', 600 - i * 10);
    }
    if (capacity.lift > 0 && !policy?.event_kind.startsWith('HYROX') && phase !== 'POST_RACE_TRANSITION') {
      add('strength_maintenance', ready && phase !== 'TAPER_RACE_WEEK' && !['NO_LOWER_BODY', 'NO_RUNNING'].includes(safety)
        ? ['strength_full_body', 'strength_upper'] : ['strength_upper'], 'SUPPORTING', 400);
    }
  }
  // Recovery intent is first class, but it is not a scheduled REST day yet.
  objectives.push({ objective_id: `objective-recovery-${athleteState.athlete_state_hash.slice(-24)}`,
    requirement_id: 'protect_recovery', role: 'REST', priority_score: 2000, goal_ids: [], candidate_families: ['rest'],
    reason_codes: [restOnly ? (safety === 'FULL_REST' ? 'FULL_REST' : 'INJURY_SCOPE')
      : phase === 'TAPER_RACE_WEEK' ? 'TAPER_VOLUME_REDUCTION' : 'RECOVERY_VOLUME_REDUCTION'],
    evidence_ids: athleteState.recovery_evidence_ids });
  objectives.sort((a, b) => b.priority_score - a.priority_score || a.objective_id.localeCompare(b.objective_id));
  const content = { version: 'adaptive-weekly-objectives-v1', athlete_state_hash: athleteState.athlete_state_hash,
    goal_gap_hashes: goalGaps.map(g => g.goal_gap_hash), phase, week_intent: phase,
    objectives, progression, running_demand: demand, weekly_stress_budget: budget,
    fatigue_ceiling_evidence: ceilings, capacities: capacity,
    reason_codes: ['FREQUENCY_IS_CAPACITY', ...phaseDecision.reason_codes] };
  return { ...content, weekly_objectives_hash: canonicalHash(content) };
}

// Selection contracts are unplaced requirements, not a parallel workout schema.
function buildSessionSelectionContracts({ athleteState, weeklyObjectives } = {}) {
  if (weeklyObjectives?.athlete_state_hash !== athleteState?.athlete_state_hash) throw new Error('Weekly objectives must precede selection and match state');
  const selected = [], deferred = [], used = { run: 0, lift: 0 };
  const stress = STRESS_TAXONOMY_V1.dimensions.map(() => 0);
  for (const objective of weeklyObjectives.objectives.filter(o => o.role !== 'REST')) {
    let accepted = null;
    let reason = 'REQUIRED_EXPOSURE_UNPLACEABLE';
    for (const family of objective.candidate_families) {
      const resources = capacitiesFor(family);
      const vector = resolveStressVector(family);
      if (resources.some(r => used[r] >= weeklyObjectives.capacities[r])) { reason = 'FREQUENCY_IS_CAPACITY'; continue; }
      if (vector.some((v, i) => stress[i] + v > weeklyObjectives.weekly_stress_budget[i])) { reason = 'CROSS_MODAL_FATIGUE_LIMIT'; continue; }
      const dose = meaningfulDose(family, athleteState);
      const minutesCap = athleteState.adaptive_foundation.max_session_minutes;
      if (minutesCap !== null && dose.minimum_duration_s > minutesCap * 60) { reason = 'MEANINGFUL_DOSE_REQUIRED'; continue; }
      accepted = { selection_id: `selection-${canonicalHash({ objective: objective.objective_id, family }).slice(0, 24)}`,
        role: objective.role, priority_score: objective.priority_score, priority_rank: selected.length + 1,
        objective_ids: [objective.objective_id], weekly_objectives_hash: weeklyObjectives.weekly_objectives_hash,
        workout_family: family, progression_family: progressionFamilyFor(family),
        progression: weeklyObjectives.progression.find(p => p.family === progressionFamilyFor(family)),
        fatigue_cost: vector.reduce((sum, v) => sum + v, 0), stress_vector: vector,
        capacity_cost: resources, meaningful_dose: dose,
        reason_codes: [...objective.reason_codes, 'FREQUENCY_IS_CAPACITY', 'MEANINGFUL_DOSE_REQUIRED'] };
      resources.forEach(r => { used[r] += 1; });
      vector.forEach((v, i) => { stress[i] += v; });
      break;
    }
    if (accepted) selected.push(accepted);
    else deferred.push({ objective_id: objective.objective_id, role: objective.role, reason_codes: [reason] });
  }
  return { contracts: selected, deferred_objectives: deferred, used_capacity: used,
    unstacked_stress_vector: stress, placement_validated: false };
}
module.exports = { buildWeeklyObjectives, buildSessionSelectionContracts };
