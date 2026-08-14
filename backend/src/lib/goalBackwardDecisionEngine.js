const {
  GOAL_BACKWARD_PLANNING_POLICY_V1,
  addDays,
  canonicalHash,
  daysBetween,
  eventPolicyFor,
  eventPolicyForGoal,
  minimumWeeklyDemandFor,
} = require('./racePlanPolicy');
const { evaluateGoalBackwardFeasibility } = require('./planFeasibility');

const PRIORITY_ORDER = Object.freeze({ A: 0, B: 1, C: 2, UNSPECIFIED: 3 });
const CONFIDENCE_WEIGHT = Object.freeze({ INSUFFICIENT: 0, LOW: 1, MEDIUM: 2, HIGH: 3 });
const PLANNING_LIFECYCLE = new Set(['SCHEDULED', 'POSTPONED', 'UNKNOWN']);
const PERFORMANCE_GOAL_TYPES = new Set(['PERFORMANCE', 'PR']);

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function dateOnly(value) {
  const raw = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T12:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw ? null : raw;
}

function normalizedPriority(value) {
  const priority = String(value || 'UNSPECIFIED').trim().toUpperCase();
  return Object.hasOwn(PRIORITY_ORDER, priority) ? priority : 'UNSPECIFIED';
}

function normalizedLifecycle(value) {
  const state = String(value || 'UNKNOWN').trim().toUpperCase();
  return GOAL_BACKWARD_PLANNING_POLICY_V1.event_lifecycle_states.includes(state) ? state : 'UNKNOWN';
}

function targetForGoal(goal = {}) {
  return {
    target_time_s: Number.isFinite(Number(goal.target_time_s ?? goal.targetTimeSeconds ?? goal.goal_time_seconds ?? goal.goalTimeSeconds))
      && Number(goal.target_time_s ?? goal.targetTimeSeconds ?? goal.goal_time_seconds ?? goal.goalTimeSeconds) > 0
      ? Number(goal.target_time_s ?? goal.targetTimeSeconds ?? goal.goal_time_seconds ?? goal.goalTimeSeconds)
      : null,
    target_pace: goal.target_pace ?? goal.targetPace ?? goal.goal_pace ?? null,
  };
}

function goalOwnerId(goal = {}) {
  return String(goal.athlete_id ?? goal.athleteId ?? goal.user_id ?? goal.userId ?? '');
}

function raceOwnerId(race = {}) {
  return String(race.athlete_id ?? race.athleteId ?? race.user_id ?? race.userId ?? '');
}

function raceIdentifier(value = {}) {
  const id = value.race_id ?? value.raceId ?? value.id;
  return id === undefined || id === null || String(id) === '' ? null : String(id);
}

function goalRaceIdentifier(value = {}) {
  const id = value.race_id ?? value.raceId;
  return id === undefined || id === null || String(id) === '' ? null : String(id);
}

function goalIdentifier(value = {}, index = 0) {
  return String(value.goal_id ?? value.goalId ?? value.id ?? `goal-${index + 1}`);
}

function normalizationTieReason(goal) {
  if (goal.priority !== 'UNSPECIFIED') return 'ATHLETE_EXPLICIT_PRIORITY';
  if (goal.registered_race && goal.event_local_date) return 'REGISTERED_DATED_RACE';
  if (goal.athlete_selected_primary && PERFORMANCE_GOAL_TYPES.has(goal.goal_type.toUpperCase())) {
    return 'ATHLETE_SELECTED_PERFORMANCE_PRIMARY';
  }
  if (goal.event_local_date) return 'EARLIEST_EVENT_DATE';
  return 'OLDEST_GOAL_CREATION_TIME';
}

function unspecifiedComparator(left, right) {
  const registeredDated = (goal) => (goal.registered_race && goal.event_local_date ? 0 : 1);
  const registeredDifference = registeredDated(left) - registeredDated(right);
  if (registeredDifference) return registeredDifference;
  const selectedPerformance = (goal) => (
    goal.athlete_selected_primary && PERFORMANCE_GOAL_TYPES.has(goal.goal_type.toUpperCase()) ? 0 : 1
  );
  const selectedDifference = selectedPerformance(left) - selectedPerformance(right);
  if (selectedDifference) return selectedDifference;
  const dateDifference = String(left.event_local_date || '9999-12-31')
    .localeCompare(String(right.event_local_date || '9999-12-31'));
  if (dateDifference) return dateDifference;
  const createdDifference = String(left.created_at || '9999-12-31T23:59:59.999Z')
    .localeCompare(String(right.created_at || '9999-12-31T23:59:59.999Z'));
  return createdDifference || left.goal_id.localeCompare(right.goal_id);
}

function goalComparator(left, right) {
  const priorityDifference = PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority];
  if (priorityDifference) return priorityDifference;
  return unspecifiedComparator(left, right);
}

function resolveOwnedGoals(input = {}) {
  const athleteId = String(input.athlete_id ?? input.athleteId ?? '');
  if (!athleteId) return deepFreeze([]);
  const sourceGoals = Array.isArray(input.goals) ? input.goals : [];
  const sourceRaces = Array.isArray(input.races) ? input.races : [];
  const raceRegistryProvided = sourceRaces.length > 0;
  const races = new Map(sourceRaces.map((race) => [raceIdentifier(race), race]));
  const owned = [];
  sourceGoals.forEach((source, index) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    if (goalOwnerId(source) !== athleteId) return;
    const raceId = goalRaceIdentifier(source);
    const race = raceId ? races.get(raceId) : null;
    if (raceRegistryProvided && raceId && (!race || raceOwnerId(race) !== athleteId)) return;
    const eventState = normalizedLifecycle(source.event_state ?? source.eventState);
    const eventLocalDate = dateOnly(
      source.postponed_event_local_date
      ?? source.postponedEventLocalDate
      ?? source.event_local_date
      ?? source.eventLocalDate
      ?? source.race_date
      ?? source.raceDate
      ?? source.date
    );
    const priority = normalizedPriority(source.priority);
    const target = targetForGoal(source);
    const distanceMiles = Number(source.distance_miles ?? source.distanceMiles ?? source.distance);
    const goal = {
      goal_id: goalIdentifier(source, index),
      race_id: raceId,
      athlete_id: athleteId,
      event_kind: String(source.event_kind ?? source.eventKind ?? '').toUpperCase() || null,
      event_policy_id: source.event_policy_id ?? source.eventPolicyId ?? null,
      distance_miles: Number.isFinite(distanceMiles) && distanceMiles > 0 ? distanceMiles : null,
      event_local_date: eventLocalDate,
      event_timezone: source.event_timezone ?? source.eventTimezone ?? source.timezone ?? null,
      location: source.location ?? null,
      event_state: eventState,
      priority,
      effective_priority: priority,
      effective_priority_order: null,
      tie_break_reason: null,
      goal_type: String(source.goal_type ?? source.goalType ?? (target.target_time_s ? 'performance' : 'completion')).toLowerCase(),
      target_time_s: target.target_time_s,
      target_pace: target.target_pace,
      athlete_selected_primary: source.athlete_selected_primary === true || source.athleteSelectedPrimary === true,
      created_at: source.created_at ?? source.createdAt ?? null,
      registered_race: Boolean(raceId && (!raceRegistryProvided || race)),
      planning_eligible: PLANNING_LIFECYCLE.has(eventState),
      specificity_active: !['CANCELLED', 'DNS'].includes(eventState),
      source_revision: source.revision ?? source.goal_revision ?? null,
    };
    goal.tie_break_reason = normalizationTieReason(goal);
    owned.push(goal);
  });
  owned.sort(goalComparator);
  const highestExplicitRank = Math.max(-1, ...owned.filter((goal) => goal.priority !== 'UNSPECIFIED')
    .map((goal) => PRIORITY_ORDER[goal.priority]));
  const unspecifiedStartRank = highestExplicitRank + 1;
  let unspecifiedIndex = 0;
  owned.forEach((goal, index) => {
    goal.effective_priority_order = index;
    if (goal.priority === 'UNSPECIFIED') {
      goal.effective_priority = ['A', 'B', 'C'][Math.min(2, unspecifiedStartRank + unspecifiedIndex)] || 'C';
      unspecifiedIndex += 1;
    }
  });
  return deepFreeze(owned.map((goal) => ({ ...goal })));
}

function minimumConfidence(categories) {
  return categories.reduce((minimum, category) => (
    CONFIDENCE_WEIGHT[category] < CONFIDENCE_WEIGHT[minimum] ? category : minimum
  ), 'HIGH');
}

function deriveGoalConfidence(observations = [], options = {}) {
  const relevant = (Array.isArray(observations) ? observations : []).filter((observation) => (
    observation && typeof observation === 'object' && observation.target_relevant !== false
  ));
  if (!relevant.length) {
    return deepFreeze({
      confidence: 'INSUFFICIENT',
      factors: { specificity: 'INSUFFICIENT', recency: 'INSUFFICIENT', quantity: 'INSUFFICIENT', agreement: 'INSUFFICIENT', source_quality: 'INSUFFICIENT' },
      relevant_observation_count: 0,
      relevant_dates: [],
      evidence_ids: [],
    });
  }
  const conflicts = options.unresolved_material_conflict === true
    || relevant.some((entry) => entry.material_conflict === true || entry.conflict === true
      || String(entry.quality_state || '').toUpperCase() === 'CONFLICT');
  const sourceBlocking = relevant.some((entry) => (
    ['FAILED_SYNC', 'CORRUPTED'].includes(String(entry.quality_state || '').toUpperCase())
    || (String(entry.quality_state || '').toUpperCase() === 'PARTIAL' && entry.derivation_permitted !== true)
  ));
  const expired = relevant.some((entry) => ['EXPIRED', 'STALE'].includes(String(entry.freshness_state || '').toUpperCase()));
  const fresh = relevant.filter((entry) => String(entry.freshness_state || 'FRESH').toUpperCase() === 'FRESH');
  const dates = [...new Set(fresh.map((entry) => dateOnly(
    entry.observed_local_date ?? entry.observed_at ?? entry.date
  )).filter(Boolean))].sort();
  const direct = fresh.some((entry) => ['SAME_EVENT', 'SAME_DISTANCE'].includes(String(entry.specificity || '').toUpperCase()));
  const eventSpecific = fresh.some((entry) => String(entry.specificity || '').toUpperCase() === 'EVENT_SPECIFIC');
  const nearby = fresh.some((entry) => String(entry.specificity || '').toUpperCase() === 'NEARBY_STANDARD');
  const verifiedSameDistance = fresh.some((entry) => (
    ['SAME_EVENT', 'SAME_DISTANCE'].includes(String(entry.specificity || '').toUpperCase())
    && entry.verified !== false
  ));
  const staleWithinGrace = relevant.some((entry) => String(entry.freshness_state || '').toUpperCase() === 'STALE_WITHIN_GRACE');
  const provisional = relevant.some((entry) => entry.provisional_baseline === true);
  const factors = {
    specificity: direct ? 'HIGH' : eventSpecific || nearby ? 'MEDIUM' : 'LOW',
    recency: expired ? 'INSUFFICIENT' : staleWithinGrace ? 'LOW' : 'HIGH',
    quantity: fresh.length >= 3 && dates.length >= 2 ? 'HIGH'
      : (fresh.length >= 2 && dates.length >= 2) || verifiedSameDistance ? 'MEDIUM' : 'LOW',
    agreement: conflicts ? 'INSUFFICIENT' : 'HIGH',
    source_quality: sourceBlocking ? 'INSUFFICIENT'
      : relevant.every((entry) => String(entry.quality_state || 'COMPLETE').toUpperCase() === 'COMPLETE') ? 'HIGH' : 'LOW',
  };
  if (provisional) factors.quantity = 'LOW';
  let confidence = minimumConfidence(Object.values(factors));
  if (confidence === 'HIGH' && !(fresh.length >= 3 && dates.length >= 2 && (direct || eventSpecific))) {
    confidence = 'MEDIUM';
  }
  return deepFreeze({
    confidence,
    factors,
    relevant_observation_count: relevant.length,
    fresh_observation_count: fresh.length,
    relevant_dates: dates,
    verified_same_distance: verifiedSameDistance,
    event_specific_or_nearby: eventSpecific || nearby,
    evidence_ids: relevant.map((entry) => entry.evidence_id).filter(Boolean).map(String),
  });
}

function hasFoundationGate(athleteState = {}) {
  const consistency = String(athleteState.consistency_state || '').toUpperCase();
  const runningStatus = String(athleteState.recent_normal_running?.status || '').toUpperCase();
  const safety = String(athleteState.safety_action || 'NORMAL').toUpperCase();
  return !['SPARSE_DATA', 'RETURNING', 'INTERRUPTED', 'UNKNOWN'].includes(consistency)
    && Number(athleteState.consistent_weeks ?? athleteState.consistentWeeks ?? 0) >= 4
    && ['PROVISIONAL', 'ESTABLISHED'].includes(runningStatus)
    && !['FULL_REST', 'NO_RUNNING', 'NO_HIGH_INTENSITY'].includes(safety);
}

function selectGoalBackwardPhase(input = {}) {
  const goal = input.goal || {};
  const policy = eventPolicyFor(input.event_policy ?? input.eventPolicy) || input.event_policy || input.eventPolicy;
  const planningDate = dateOnly(input.planning_date_local ?? input.planningDateLocal);
  const eventDate = dateOnly(goal.event_local_date ?? goal.eventLocalDate ?? goal.date);
  const eventState = normalizedLifecycle(goal.event_state ?? goal.eventState);
  const daysToEvent = planningDate && eventDate ? daysBetween(planningDate, eventDate) : null;
  const taperDays = Number(policy?.taper_days ?? 0);
  const recoveryBufferDays = Number(policy?.recovery_buffer_days ?? 2);
  const dueExposureCount = Math.max(0, Number(input.due_exposure_count ?? input.dueExposureCount ?? 0));
  const reasonCodes = [];
  let phase;
  if (eventState === 'COMPLETED' && input.transition_exit_met !== true) {
    phase = 'POST_RACE_TRANSITION';
    reasonCodes.push('POST_RACE_TRANSITION');
  } else if (daysToEvent !== null && daysToEvent <= taperDays) {
    phase = 'TAPER_RACE_WEEK';
    reasonCodes.push('TAPER_ENTRY');
    if (dueExposureCount > 0) reasonCodes.push('LATE_BUILD_PREVENTED', 'REQUIRED_EXPOSURE_UNPLACEABLE');
  } else if (input.recovery_buffer_overload_unsafe === true) {
    phase = 'TAPER_RACE_WEEK';
    const override = String(input.early_taper_reason || 'CROSS_MODAL_FATIGUE_LIMIT').toUpperCase();
    const allowed = new Set(['RECOVERY_VOLUME_REDUCTION', 'ILLNESS_RECOVERY', 'INJURY_SCOPE', 'CROSS_MODAL_FATIGUE_LIMIT']);
    reasonCodes.push('TAPER_ENTRY', allowed.has(override) ? override : 'CROSS_MODAL_FATIGUE_LIMIT');
  } else {
    const preTaperDays = daysToEvent === null ? null : daysToEvent - taperDays;
    const safeUsefulPeakFits = input.safe_useful_peak_fits === true
      && preTaperDays !== null && preTaperDays >= recoveryBufferDays;
    if (dueExposureCount > 0 && preTaperDays !== null && preTaperDays < recoveryBufferDays) {
      phase = 'SHARPENING';
      reasonCodes.push('SHARPENING_ENTRY', 'LATE_BUILD_PREVENTED', 'REQUIRED_EXPOSURE_UNPLACEABLE');
    } else if (input.peak_exposure_complete === true) {
      phase = 'SHARPENING';
      reasonCodes.push('SHARPENING_ENTRY');
    } else if (!hasFoundationGate(input.athlete_state || input.athleteState || {})) {
      phase = 'FOUNDATION';
      reasonCodes.push('FOUNDATION_ENTRY');
    } else if (safeUsefulPeakFits || (
      input.development_gate_complete === true
      && dueExposureCount > 0
      && preTaperDays !== null
      && Math.floor(preTaperDays / 7) >= 3
    )) {
      phase = 'EVENT_SPECIFIC_DEVELOPMENT';
      reasonCodes.push('EVENT_SPECIFIC_ENTRY');
      if (safeUsefulPeakFits) reasonCodes.push('PREMATURE_TAPER_PREVENTED');
    } else {
      phase = 'DEVELOPMENT';
      reasonCodes.push('DEVELOPMENT_ENTRY');
    }
  }
  return deepFreeze({
    phase,
    days_to_event: daysToEvent,
    taper_days: taperDays,
    recovery_buffer_days: recoveryBufferDays,
    reason_codes: [...new Set(reasonCodes)],
  });
}

function normalizedAvailableDaysCount(input = {}) {
  if (Number.isInteger(input.available_days_count)) return Math.max(0, input.available_days_count);
  if (Array.isArray(input.available_days)) return input.available_days.length;
  return 0;
}

function constrainedPrimary(input = {}) {
  const age = String(input.training_age_class || '').toUpperCase();
  const consistency = String(input.consistency_state || '').toUpperCase();
  const recovery = String(input.recovery_state || '').toUpperCase();
  const days = normalizedAvailableDaysCount(input);
  return ['BEGINNER', 'RETURNING'].includes(age)
    || ['RETURNING', 'SPARSE_DATA'].includes(consistency)
    || recovery === 'CAUTION'
    || days <= 4;
}

function copiedExposure(exposure, overrides = {}) {
  return {
    requirement_id: String(exposure.requirement_id),
    any_of: [...(exposure.any_of || [])],
    role: exposure.role || 'PRIMARY_KEY',
    scheduled_local_date: null,
    ...overrides,
  };
}

function buildDueExposureLedger(input = {}) {
  const policy = eventPolicyFor(input.event_policy ?? input.eventPolicy) || input.event_policy || input.eventPolicy;
  const phase = String(input.phase || '').toUpperCase();
  if (!policy || !Object.hasOwn(policy.required_exposure_ledger || {}, phase)) {
    const foundation = phase === 'FOUNDATION'
      ? [copiedExposure({ requirement_id: 'foundation_aerobic_consistency', any_of: ['easy_run'], role: 'PRIMARY_KEY' })]
      : [];
    const sharpening = phase === 'TAPER_RACE_WEEK' && policy?.required_exposure_ledger?.SHARPENING?.[0]
      ? [copiedExposure({
        ...policy.required_exposure_ledger.SHARPENING[0],
        requirement_id: 'taper_bounded_stimulus',
        role: 'PRIMARY_KEY',
      })]
      : [];
    const dueRoles = [...foundation, ...sharpening];
    return deepFreeze({
      event_policy_id: policy?.event_policy_id || null,
      phase,
      due_roles: dueRoles,
      required_primary_count: dueRoles.length,
      satisfied_requirement_ids: [],
      unplaceable_requirement_ids: [],
      runway_conflict: false,
      complete: dueRoles.length === 0,
      reason_codes: [],
    });
  }
  const completed = new Set((input.completed_requirement_ids || []).map(String));
  const source = policy.required_exposure_ledger[phase].filter((entry) => !completed.has(String(entry.requirement_id)));
  const primary = source.filter((entry) => !['SUPPORTING', 'OPTIONAL_KEY'].includes(entry.role || 'PRIMARY_KEY'));
  const supporting = source.filter((entry) => entry.role === 'SUPPORTING');
  const optional = source.filter((entry) => entry.role === 'OPTIONAL_KEY');
  const isMandatoryHyroxCluster = input.mandatory_hyrox_cluster === true
    && ['HYROX_SINGLES', 'HYROX_DOUBLES'].includes(policy.event_kind)
    && phase === 'EVENT_SPECIFIC_DEVELOPMENT';
  const constrained = constrainedPrimary(input);
  let selectedPrimary;
  let selectedSupporting = supporting;
  const unplaceable = [];
  const reasons = [];
  if (isMandatoryHyroxCluster) {
    const partial = primary.find((entry) => entry.any_of.includes('hyrox_partial_simulation'));
    const long = primary.find((entry) => entry.any_of.includes('long_aerobic'));
    selectedPrimary = [partial, ...(!constrained && long ? [long] : [])].filter(Boolean);
    if (constrained && long) {
      unplaceable.push(String(long.requirement_id));
      reasons.push('REQUIRED_EXPOSURE_UNPLACEABLE');
    }
    selectedSupporting = supporting.filter((entry) => entry.any_of.includes('hyrox_station_skill'));
  } else {
    const requiredCount = constrained ? Math.min(1, primary.length) : Math.min(2, primary.length);
    selectedPrimary = primary.slice(0, requiredCount);
    if (input.allow_optional_key === true) selectedPrimary.push(...optional.slice(0, 1));
  }
  let runwayConflict = false;
  const planningDate = dateOnly(input.planning_date_local ?? input.planningDateLocal);
  const eventDate = dateOnly(input.event_local_date ?? input.eventLocalDate);
  if (planningDate && eventDate && selectedPrimary.length) {
    const daysToEvent = daysBetween(planningDate, eventDate);
    const preTaperDays = daysToEvent - Number(policy.taper_days || 0);
    const minimumPlacementRunway = Number(policy.recovery_buffer_days || 2)
      + Math.max(0, selectedPrimary.length - 1) * 2;
    if (preTaperDays < minimumPlacementRunway) {
      runwayConflict = true;
      selectedPrimary.forEach((entry) => unplaceable.push(String(entry.requirement_id)));
      reasons.push('REQUIRED_EXPOSURE_UNPLACEABLE', 'LATE_BUILD_PREVENTED');
    }
  }
  const dueRoles = [
    ...selectedPrimary.map((entry) => copiedExposure(entry, { role: 'PRIMARY_KEY' })),
    ...selectedSupporting.map((entry) => copiedExposure(entry, {
      role: 'SUPPORTING',
      supports_requirement_id: selectedPrimary[0]?.requirement_id || null,
    })),
  ];
  return deepFreeze({
    event_policy_id: policy.event_policy_id,
    phase,
    due_roles: dueRoles,
    required_primary_count: selectedPrimary.length,
    satisfied_requirement_ids: [...completed].sort(),
    unplaceable_requirement_ids: [...new Set(unplaceable)],
    runway_conflict: runwayConflict,
    complete: dueRoles.length === 0 && unplaceable.length === 0,
    reason_codes: [...new Set(reasons)],
  });
}

function maximumPrimaryKeys(input = {}) {
  if (constrainedPrimary(input)) return 1;
  const age = String(input.training_age_class || '').toUpperCase();
  const days = normalizedAvailableDaysCount(input);
  const recovery = String(input.recovery_state || '').toUpperCase();
  if (['ESTABLISHED', 'ADVANCED'].includes(age)
    && days >= 6
    && ['READY', 'NORMAL'].includes(recovery)
    && input.tolerated_three_hard_stimuli === true) return 3;
  return days >= 5 && ['READY', 'NORMAL'].includes(recovery) ? 2 : 1;
}

function buildRoleMultiset(input = {}) {
  const ledger = input.exposure_ledger || {};
  const roles = (ledger.due_roles || []).map((role) => copiedExposure(role));
  const primaryCount = () => roles.filter((role) => role.role === 'PRIMARY_KEY').length;
  const maximum = maximumPrimaryKeys(input);
  for (const requested of input.additional_primary_stimuli || []) {
    if (primaryCount() >= maximum) break;
    if (primaryCount() === 2 && requested.upper_or_technique_dominant !== true) continue;
    if (!requested.adaptation_id || !requested.requirement_id || !Array.isArray(requested.any_of)) continue;
    roles.push(copiedExposure(requested, { role: 'PRIMARY_KEY' }));
  }
  for (const supporting of input.supporting_stimuli || []) {
    roles.push(copiedExposure(supporting, { role: 'SUPPORTING' }));
  }
  return deepFreeze(roles);
}

function primaryGoalForDecision(goals, transitionExitMet) {
  const first = goals[0] || null;
  if (first?.event_state === 'COMPLETED' && transitionExitMet !== true) return first;
  return goals.find((goal) => goal.planning_eligible && goal.specificity_active) || null;
}

function decisionCreatedAt(input, planningDate) {
  const supplied = input.created_at ?? input.createdAt;
  if (supplied && !Number.isNaN(new Date(supplied).getTime())) return new Date(supplied).toISOString();
  return `${planningDate}T00:00:00.000Z`;
}

function buildGoalBackwardPlanningDecision(input = {}) {
  const athleteId = String(input.athlete_id ?? input.athleteId ?? '');
  const planningDate = dateOnly(input.planning_date_local ?? input.planningDateLocal);
  if (!athleteId || !planningDate) throw new Error('athlete_id and a valid planning_date_local are required');
  const athleteState = clone(input.athlete_state || input.athleteState || {});
  const ownedGoals = resolveOwnedGoals({ athlete_id: athleteId, goals: input.goals, races: input.races });
  const primaryGoal = primaryGoalForDecision(ownedGoals, input.transition_exit_met);
  const eventPolicy = primaryGoal ? eventPolicyForGoal(primaryGoal) : null;
  const initialDueCount = eventPolicy?.required_exposure_ledger?.EVENT_SPECIFIC_DEVELOPMENT
    ?.filter((entry) => (entry.role || 'PRIMARY_KEY') === 'PRIMARY_KEY').length || 0;
  const phaseDecision = primaryGoal ? selectGoalBackwardPhase({
    ...input,
    goal: primaryGoal,
    athlete_state: athleteState,
    event_policy: eventPolicy,
    due_exposure_count: input.due_exposure_count ?? initialDueCount,
  }) : { phase: 'FOUNDATION', days_to_event: null, reason_codes: ['FOUNDATION_ENTRY'] };
  const availableDays = Array.isArray(athleteState.available_days) ? athleteState.available_days : [];
  const exposureLedger = buildDueExposureLedger({
    ...input,
    event_policy: eventPolicy,
    phase: phaseDecision.phase,
    event_local_date: primaryGoal?.event_local_date,
    training_age_class: athleteState.training_age_class,
    consistency_state: athleteState.consistency_state,
    recovery_state: athleteState.recovery_state,
    available_days_count: availableDays.length,
  });
  const roleMultiset = buildRoleMultiset({
    ...input,
    exposure_ledger: exposureLedger,
    training_age_class: athleteState.training_age_class,
    consistency_state: athleteState.consistency_state,
    recovery_state: athleteState.recovery_state,
    available_days_count: availableDays.length,
  });
  const demand = eventPolicy ? minimumWeeklyDemandFor(eventPolicy.event_policy_id, {
    phase: phaseDecision.phase,
    recent_normal_status: athleteState.recent_normal_running?.status,
    recent_normal_median_distance_m: athleteState.recent_normal_running?.median_distance_m,
    training_age_class: athleteState.training_age_class,
    consistency_state: athleteState.consistency_state,
    recovery_state: athleteState.recovery_state,
    available_days_count: availableDays.length,
  }) : { running_m: null, required_exposure_count: 0 };
  const feasibilityByGoal = input.feasibility_by_goal || {};
  const goalFeasibilities = ownedGoals.map((goal) => evaluateGoalBackwardFeasibility({
    goal,
    current_status: goal.feasibility_status || 'unvalidated',
    safety_permits_goal_training: !['FULL_REST', 'NO_RUNNING'].includes(String(athleteState.safety_action || '').toUpperCase()),
    mandatory_exposures_complete: exposureLedger.unplaceable_requirement_ids.length === 0,
    mandatory_exposure_placeable: exposureLedger.unplaceable_requirement_ids.length === 0,
    established_recent_normal: String(athleteState.recent_normal_running?.status || '').toUpperCase() === 'ESTABLISHED',
    ...clone(feasibilityByGoal[goal.goal_id] || {}),
  }));
  const activeGoals = ownedGoals.map((goal) => {
    const feasibility = goalFeasibilities.find((entry) => entry.goal_id === goal.goal_id);
    return { ...clone(goal), feasibility_status: feasibility?.status || 'unvalidated' };
  });
  const createdAt = decisionCreatedAt(input, planningDate);
  const decisionContent = {
    created_at: createdAt,
    athlete_id: athleteId,
    athlete_state_revision: Number(athleteState.athlete_state_revision || 0),
    evidence_snapshot_id: athleteState.evidence_snapshot_id || null,
    plan_id: input.plan_id ?? input.planId ?? null,
    plan_revision: Number(input.plan_revision ?? input.planRevision ?? 0),
    planning_date_local: planningDate,
    timezone: String(input.timezone || athleteState.timezone || 'UTC'),
    active_goals: activeGoals,
    primary_goal_id: primaryGoal?.goal_id || null,
    secondary_goal_ids: activeGoals.filter((goal) => goal.goal_id !== primaryGoal?.goal_id && goal.planning_eligible)
      .map((goal) => goal.goal_id),
    phase: phaseDecision.phase,
    phase_reason_codes: phaseDecision.reason_codes,
    days_to_events: Object.fromEntries(activeGoals.map((goal) => [
      goal.goal_id,
      goal.event_local_date ? daysBetween(planningDate, goal.event_local_date) : null,
    ])),
    event_policy_id: eventPolicy?.event_policy_id || null,
    minimum_weekly_demand: demand,
    training_age_class: athleteState.training_age_class || 'UNKNOWN',
    consistency_state: athleteState.consistency_state || 'UNKNOWN',
    due_exposure_ledger: exposureLedger,
    role_multiset: roleMultiset,
    recent_normal_running_range_m: {
      low: athleteState.recent_normal_running?.lower_bound_m ?? null,
      median: athleteState.recent_normal_running?.median_distance_m ?? null,
      high: athleteState.recent_normal_running?.upper_bound_m ?? null,
    },
    proposed_running_volume_m: Number(input.proposed_running_volume_m || 0),
    proposed_total_training_stress: clone(input.proposed_total_training_stress || {}),
    volume_delta_m: Number(input.volume_delta_m || 0),
    volume_delta_percentage: input.volume_delta_percentage ?? null,
    key_stimuli: roleMultiset.filter((role) => role.role === 'PRIMARY_KEY'),
    supporting_stimuli: roleMultiset.filter((role) => role.role !== 'PRIMARY_KEY'),
    athlete_availability_constraints: clone(input.athlete_availability_constraints || athleteState.time_constraints || []),
    athlete_locks: clone(athleteState.locks || []),
    manual_edits: clone(athleteState.manual_edits || []),
    safety_state: { action: athleteState.safety_action || 'NORMAL', scope: clone(athleteState.safety_scope || []) },
    recovery_state: athleteState.recovery_state || 'UNKNOWN',
    evidence_used: clone(input.evidence_used || []),
    stale_evidence: clone(input.stale_evidence || []),
    conflicting_evidence: clone(input.conflicting_evidence || []),
    unknowns: clone(athleteState.unknowns || []),
    limiting_factors: clone(input.limiting_factors || []),
    goal_feasibilities: goalFeasibilities,
    candidate_ids: [],
    selected_candidate_id: null,
    rejected_candidates: [],
    reason_codes: [...new Set([
      ...phaseDecision.reason_codes,
      ...exposureLedger.reason_codes,
      ...goalFeasibilities.flatMap((entry) => entry.reason_codes || []),
    ])],
    validator_results: [],
    policy_versions: {
      planning_policy_version: GOAL_BACKWARD_PLANNING_POLICY_V1.planning_policy_version,
      event_policy_registry_version: GOAL_BACKWARD_PLANNING_POLICY_V1.event_policy_registry_version,
      stress_taxonomy_version: GOAL_BACKWARD_PLANNING_POLICY_V1.stress_taxonomy_version,
    },
  };
  const decisionHash = canonicalHash(decisionContent);
  return deepFreeze({
    decision_id: input.decision_id || `decision-${decisionHash.slice(0, 24)}`,
    ...decisionContent,
    decision_hash: decisionHash,
  });
}

function finalizeGoalBackwardCandidateDecision(decision, {
  candidates = [],
  selectedCandidate = null,
  totalUniqueCandidateCount = candidates.length,
  truncationReason = null,
} = {}) {
  if (!decision?.decision_id || !decision?.decision_hash) {
    throw new Error('an immutable PlanningDecision is required before candidate selection');
  }
  const retained = Array.isArray(candidates) ? candidates : [];
  const rejected = retained.filter((candidate) => candidate?.validation?.valid !== true).map((candidate) => ({
    candidate_id: candidate.candidate_skeleton_id,
    candidate_hash: candidate.candidate_hash,
    reason_codes: [...new Set(candidate.validation?.reason_codes || [])],
  }));
  const validatorResults = retained.map((candidate) => ({
    candidate_id: candidate.candidate_skeleton_id,
    candidate_hash: candidate.candidate_hash,
    valid: candidate.validation?.valid === true,
    validators_executed: (candidate.validation?.validator_results || []).map((result) => result.validator),
    reason_codes: [...new Set(candidate.validation?.reason_codes || [])],
  }));
  return deepFreeze({
    ...clone(decision),
    candidate_ids: retained.map((candidate) => candidate.candidate_skeleton_id),
    selected_candidate_id: selectedCandidate?.candidate_skeleton_id || null,
    selected_candidate_hash: selectedCandidate?.candidate_hash || null,
    selected_candidate_ranking_tuple: clone(selectedCandidate?.ranking_tuple || null),
    rejected_candidates: rejected,
    validator_results: validatorResults,
    candidate_enumeration: {
      retained_count: retained.length,
      total_unique_candidate_count: Number(totalUniqueCandidateCount || 0),
      truncation_reason: truncationReason,
    },
  });
}

module.exports = {
  buildDueExposureLedger,
  buildGoalBackwardPlanningDecision,
  buildRoleMultiset,
  deriveGoalConfidence,
  finalizeGoalBackwardCandidateDecision,
  resolveOwnedGoals,
  selectGoalBackwardPhase,
};
