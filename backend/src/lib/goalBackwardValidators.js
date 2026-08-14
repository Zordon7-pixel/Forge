const {
  GOAL_BACKWARD_PLANNING_POLICY_V1,
  addDays,
  canonicalHash,
  daysBetween,
} = require('./racePlanPolicy');
const { aggregateWeeklyStress, resolveSessionStress, resolveStressVector } = require('./goalBackwardLoad');

const DIMENSIONS = [
  'aerobic',
  'running_impact',
  'lower_body_muscular',
  'upper_body_muscular',
  'grip',
  'neuromuscular',
  'metabolic',
  'event_specific_fatigue',
];
const RUNNING_FAMILIES = new Set([
  'recovery_run', 'easy_run', 'long_aerobic', 'steady_run', 'threshold_run', 'interval_run',
  'race_rhythm_run', 'hyrox_compromised', 'hyrox_partial_simulation', 'hyrox_full_simulation',
  'assessment', 'race',
]);
const QUALITY_FAMILIES = new Set([
  'threshold_run', 'interval_run', 'race_rhythm_run', 'hyrox_compromised',
  'hyrox_partial_simulation', 'hyrox_full_simulation', 'race',
]);
const COMPROMISED_FAMILIES = new Set(['hyrox_compromised', 'hyrox_partial_simulation', 'hyrox_full_simulation']);
const PEAK_SIMULATION_FAMILIES = new Set(['hyrox_partial_simulation', 'hyrox_full_simulation']);
const EASY_REST_FAMILIES = new Set(['rest', 'mobility', 'manual_recovery', 'recovery_run', 'easy_run']);
const CLOSED_ROLES = new Set(['PRIMARY_KEY', 'ASSESSMENT', 'SUPPORTING', 'RECOVERY', 'REST']);
const COSMETIC_FIELDS = new Set([
  'title', 'display_name', 'displayName', 'description', 'purpose', 'why', 'why_today', 'whyToday',
  'notes', 'explanation', 'copy',
]);
const PRESCRIPTION_IDENTITY_FIELDS = new Set([
  'session_id', 'sessionId', 'id', 'scheduled_local_date', 'scheduledLocalDate', 'scheduled_start_at',
  'scheduledStartAt', 'date', 'local_date',
]);

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

function sessionFamily(session = {}) {
  return session.workout_family ?? session.workoutFamily ?? session.family ?? null;
}

function sessionRole(session = {}) {
  return String(session.role ?? session.session_role ?? session.sessionRole ?? '').toUpperCase() || null;
}

function sessionId(session = {}, index = 0) {
  return String(session.session_id ?? session.sessionId ?? session.id ?? `session-${index + 1}`);
}

function sessionLocalDate(session = {}) {
  return dateOnly(
    session.scheduled_local_date ?? session.scheduledLocalDate ?? session.local_date ?? session.date
    ?? session.scheduled_start_at ?? session.scheduledStartAt
  );
}

function sessionsFrom(container = {}) {
  if (Array.isArray(container)) return container;
  if (Array.isArray(container.sessions)) return container.sessions;
  return (container.weeks || []).flatMap((week) => (
    (week.days || week.sessions || []).flatMap((day) => (
      Array.isArray(day.sessions)
        ? day.sessions.map((session) => ({ ...session, scheduled_local_date: sessionLocalDate(session) || sessionLocalDate(day) }))
        : [{ ...day, scheduled_local_date: sessionLocalDate(day) }]
    ))
  ));
}

function resolvedSession(session = {}, index = 0) {
  const stress = resolveSessionStress(session, index);
  return {
    source: session,
    session_id: stress.session_id,
    scheduled_local_date: sessionLocalDate(session),
    workout_family: stress.workout_family,
    role: sessionRole(session),
    vector: stress.vector,
  };
}

function stationKey(step = {}) {
  return String(step.station_id ?? step.stationId ?? step.station ?? step.type ?? '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_');
}

function prescribedStationAmount(step = {}) {
  const candidates = [step.distance_m, step.distanceMeters, step.repetitions, step.reps, step.count]
    .map(Number).filter((value) => Number.isFinite(value) && value >= 0);
  return candidates[0] ?? null;
}

function officialStationAmount(session, step) {
  const direct = [step.official_distance_m, step.officialDistanceMeters, step.official_repetitions, step.officialRepetitions]
    .map(Number).find((value) => Number.isFinite(value) && value > 0);
  if (direct) return direct;
  const key = stationKey(step);
  const registry = session.active_ruleset_official_volume ?? session.activeRulesetOfficialVolume
    ?? session.official_station_volumes ?? {};
  const value = Number(registry[key]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function isSledLungeHighVolume(resolved) {
  const steps = Array.isArray(resolved.source.steps) ? resolved.source.steps : [];
  let officialAvailable = false;
  let relevantStationStep = false;
  for (const step of steps) {
    if (!/(sled_push|sled_pull|sandbag_lunge)/.test(stationKey(step))) continue;
    relevantStationStep = true;
    const prescribed = prescribedStationAmount(step);
    const official = officialStationAmount(resolved.source, step);
    if (official !== null) officialAvailable = true;
    if (prescribed !== null && official !== null && prescribed * 2 >= official) return true;
  }
  return relevantStationStep && !officialAvailable && resolved.vector?.[2] === 4;
}

function classifyInterferencePredicates(session = {}) {
  const resolved = resolvedSession(session);
  const family = resolved.workout_family;
  const vector = resolved.vector;
  return deepFreeze({
    workout_family: family,
    vector,
    threshold_interval_run: ['threshold_run', 'interval_run'].includes(family),
    running_quality: QUALITY_FAMILIES.has(family),
    heavy_lower_body_strength: ['strength_lower', 'strength_full_body'].includes(family) && vector?.[2] >= 3,
    long_run: family === 'long_aerobic',
    compromised_hyrox: COMPROMISED_FAMILIES.has(family),
    sled_lunge_high_volume: vector ? isSledLungeHighVolume(resolved) : false,
    peak_partial_full_simulation: PEAK_SIMULATION_FAMILIES.has(family),
    hard_lower_body: vector?.[2] >= 3,
    upper_body_strength: family === 'strength_upper' && vector?.[2] <= 1 && vector?.[6] <= 1,
    easy_recovery_run: ['easy_run', 'recovery_run'].includes(family),
    race_simulation: family === 'hyrox_full_simulation'
      || (family === 'assessment' && vector?.[7] === 4 && session.complete_event_order_step_graph === true),
    race: family === 'race',
  });
}

function startTimeMillis(session) {
  const supplied = session.scheduled_start_at ?? session.scheduledStartAt;
  if (supplied) {
    const parsed = new Date(supplied);
    if (!Number.isNaN(parsed.getTime())) return parsed.getTime();
  }
  const date = sessionLocalDate(session);
  return date ? new Date(`${date}T12:00:00.000Z`).getTime() : null;
}

function longestRequiredSeparation(left, right, options = {}) {
  const a = classifyInterferencePredicates(left);
  const b = classifyInterferencePredicates(right);
  const policy = GOAL_BACKWARD_PLANNING_POLICY_V1.interference;
  const age = String(options.training_age_class || '').toUpperCase();
  const requirements = [];
  const either = (first, second) => (a[first] && b[second]) || (a[second] && b[first]);
  if (either('threshold_interval_run', 'heavy_lower_body_strength')) {
    requirements.push({
      hours: ['BEGINNER', 'RETURNING'].includes(age)
        ? policy.threshold_heavy_lower_beginner_returning_hours
        : policy.threshold_heavy_lower_hours,
      rule: 'THRESHOLD_HEAVY_LOWER',
    });
  }
  if (either('heavy_lower_body_strength', 'long_run')) {
    requirements.push({ hours: policy.heavy_lower_long_hours, rule: 'HEAVY_LOWER_LONG' });
  }
  if (either('compromised_hyrox', 'threshold_interval_run')) {
    requirements.push({ hours: policy.compromised_threshold_hours, rule: 'COMPROMISED_THRESHOLD' });
  }
  if ((a.sled_lunge_high_volume && (b.long_run || b.running_quality))
    || (b.sled_lunge_high_volume && (a.long_run || a.running_quality))) {
    requirements.push({ hours: policy.sled_lunge_quality_hours, rule: 'SLED_LUNGE_QUALITY' });
  }
  if (either('peak_partial_full_simulation', 'hard_lower_body')) {
    requirements.push({ hours: policy.peak_simulation_hard_lower_hours, rule: 'PEAK_SIMULATION_HARD_LOWER' });
  }
  if (either('peak_partial_full_simulation', 'long_run')) {
    requirements.push({ hours: policy.peak_simulation_long_hours, rule: 'PEAK_SIMULATION_LONG' });
  }
  if (either('race_simulation', 'race')) {
    requirements.push({ hours: policy.full_simulation_race_hours, rule: 'RACE_SIMULATION_RACE' });
  }
  return requirements.sort((leftRule, rightRule) => rightRule.hours - leftRule.hours)[0] || null;
}

function toleratedStack(left, right, options) {
  const familyTuple = [sessionFamily(left), sessionFamily(right)];
  return (options.tolerated_stack_patterns || []).some((pattern) => (
    Array.isArray(pattern)
    && pattern.length === 2
    && ((pattern[0] === familyTuple[0] && pattern[1] === familyTuple[1])
      || (pattern[1] === familyTuple[0] && pattern[0] === familyTuple[1]))
  ));
}

function isHardSession(session) {
  const vector = resolveStressVector(sessionFamily(session), {
    event_kind: session.event_kind,
    contributing_work_families: session.contributing_work_families,
  });
  return Boolean(vector && [1, 2, 5, 6, 7].some((index) => vector[index] >= 3));
}

function validateIntentionalStack(left, right, sessions, options = {}) {
  const violations = [];
  const age = String(options.training_age_class || '').toUpperCase();
  const second = startTimeMillis(left) <= startTimeMillis(right) ? right : left;
  const secondPredicates = classifyInterferencePredicates(second);
  if (!['ESTABLISHED', 'ADVANCED'].includes(age)) violations.push({ code: 'INTENTIONAL_STACK_INELIGIBLE', reason: 'TRAINING_AGE' });
  if (!toleratedStack(left, right, options) && !secondPredicates.upper_body_strength
    && !['hyrox_station_skill', 'mobility'].includes(sessionFamily(second))) {
    violations.push({ code: 'INTENTIONAL_STACK_INELIGIBLE', reason: 'UNTOLERATED_PATTERN' });
  }
  if (!['READY', 'NORMAL'].includes(String(options.recovery_state || '').toUpperCase())
    || !['NORMAL', 'MONITOR'].includes(String(options.safety_action || 'NORMAL').toUpperCase())) {
    violations.push({ code: 'INTENTIONAL_STACK_INELIGIBLE', reason: 'SAFETY_RECOVERY' });
  }
  if (options.combined_stress_passes !== true) violations.push({ code: 'INTENTIONAL_STACK_INELIGIBLE', reason: 'STRESS_BUDGET' });
  if (options.stacking_protects_recovery_day !== true) violations.push({ code: 'INTENTIONAL_STACK_INELIGIBLE', reason: 'DOES_NOT_PROTECT_RECOVERY' });
  if (!(options.reason_codes || []).includes('HARD_DAY_STACK_TO_PROTECT_RECOVERY')) {
    violations.push({ code: 'INTENTIONAL_STACK_INELIGIBLE', reason: 'REASON_CODE_MISSING' });
  }
  const stackDate = sessionLocalDate(left);
  const nextDate = stackDate ? addDays(stackDate, 1) : null;
  const nextDaySessions = sessions.filter((session) => sessionLocalDate(session) === nextDate);
  const nextDayStress = nextDaySessions.length ? aggregateWeeklyStress(nextDaySessions.map((session) => ({
    ...session,
    scheduled_local_date: sessionLocalDate(session),
  }))) : null;
  if (nextDaySessions.some((session) => !EASY_REST_FAMILIES.has(sessionFamily(session)) || isHardSession(session))
    || nextDayStress?.days.some((day) => day.hard_day)) {
    violations.push({ code: 'INTENTIONAL_STACK_RECOVERY_REQUIRED', scheduled_local_date: nextDate });
  }
  return violations;
}

function validateInterference(sessions = [], options = {}) {
  const source = Array.isArray(sessions) ? sessions : [];
  const violations = [];
  source.forEach((session, index) => {
    if (!resolveStressVector(sessionFamily(session), {
      event_kind: session.event_kind,
      contributing_work_families: session.contributing_work_families,
    })) {
      violations.push({ code: 'WORKOUT_FAMILY_UNRESOLVED', session_id: sessionId(session, index) });
    }
  });
  for (let leftIndex = 0; leftIndex < source.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < source.length; rightIndex += 1) {
      const left = source[leftIndex];
      const right = source[rightIndex];
      const required = longestRequiredSeparation(left, right, options);
      if (!required) continue;
      const leftStart = startTimeMillis(left);
      const rightStart = startTimeMillis(right);
      if (leftStart === null || rightStart === null) continue;
      const actualHours = Math.abs(rightStart - leftStart) / 3600000;
      if (actualHours >= required.hours) continue;
      const intentional = left.intentional_stack === true || right.intentional_stack === true
        || (options.intentional_stack_session_ids || []).includes(sessionId(left, leftIndex))
        || (options.intentional_stack_session_ids || []).includes(sessionId(right, rightIndex));
      if (intentional && sessionLocalDate(left) === sessionLocalDate(right)) {
        const stackViolations = validateIntentionalStack(left, right, source, options);
        if (!stackViolations.length) continue;
        violations.push(...stackViolations.map((violation) => ({
          ...violation,
          session_ids: [sessionId(left, leftIndex), sessionId(right, rightIndex)],
        })));
        continue;
      }
      violations.push({
        code: 'INTERFERENCE_SPACING',
        rule: required.rule,
        session_ids: [sessionId(left, leftIndex), sessionId(right, rightIndex)],
        actual_separation_hours: actualHours,
        minimum_separation_hours: required.hours,
      });
    }
  }
  const unique = [...new Map(violations.map((violation) => [
    [violation.code, violation.rule, violation.reason, violation.scheduled_local_date, ...(violation.session_ids || [])].join(':'),
    violation,
  ])).values()];
  return deepFreeze({
    validator: 'interference',
    valid: unique.length === 0,
    violations: unique,
    reason_codes: [...new Set(unique.map((violation) => (
      violation.code === 'WORKOUT_FAMILY_UNRESOLVED' ? violation.code : 'CROSS_MODAL_FATIGUE_LIMIT'
    )))],
  });
}

function validateAvailability(sessions, options) {
  const available = Array.isArray(options.available_local_dates) ? new Set(options.available_local_dates.map(dateOnly)) : null;
  const timeConstraints = options.time_constraints || {};
  const violations = [];
  sessions.forEach((session, index) => {
    const date = sessionLocalDate(session);
    if (!date) violations.push({ code: 'SESSION_DATE_INVALID', session_id: sessionId(session, index) });
    else if (available && !available.has(date)) violations.push({ code: 'SCHEDULE_CONSTRAINT', session_id: sessionId(session, index), scheduled_local_date: date });
    const maximum = Number(timeConstraints[date]?.available_minutes ?? timeConstraints[date]?.maximum_minutes);
    const duration = Number(session.duration_min ?? session.duration_minutes ?? (Number(session.duration_s || 0) / 60));
    if (Number.isFinite(maximum) && Number.isFinite(duration) && duration > maximum) {
      violations.push({ code: 'SCHEDULE_CONSTRAINT', session_id: sessionId(session, index), scheduled_local_date: date, available_minutes: maximum });
    }
  });
  return { validator: 'availability', valid: violations.length === 0, violations, reason_codes: violations.map((violation) => violation.code) };
}

function matchesRoleFamily(session, constraint) {
  const role = constraint.role ? sessionRole(session) === String(constraint.role).toUpperCase() : true;
  const family = constraint.workout_family ? sessionFamily(session) === constraint.workout_family : true;
  return role && family;
}

function validateConstraints(sessions, options) {
  const violations = [];
  for (const lock of options.locks || []) {
    const kind = String(lock.constraint_kind ?? lock.kind ?? lock.type ?? '').toLowerCase();
    if (kind === 'day_lock') {
      const date = dateOnly(lock.local_date ?? lock.scheduled_local_date ?? lock.date);
      if (!sessions.some((session) => sessionLocalDate(session) === date && matchesRoleFamily(session, lock))) {
        violations.push({ code: 'ATHLETE_LOCK_CONFLICT', constraint_kind: 'day_lock', local_date: date });
      }
    } else if (kind === 'session_lock') {
      const lockedId = String(lock.session_id ?? lock.sessionId ?? '');
      const session = sessions.find((entry, index) => sessionId(entry, index) === lockedId);
      const date = dateOnly(lock.local_date ?? lock.scheduled_local_date ?? lock.date);
      if (!session || (date && sessionLocalDate(session) !== date) || !matchesRoleFamily(session || {}, lock)) {
        violations.push({ code: 'ATHLETE_LOCK_CONFLICT', constraint_kind: 'session_lock', session_id: lockedId });
      }
    }
  }
  for (const edit of options.manual_edits || []) {
    const editId = String(edit.session_id ?? edit.sessionId ?? '');
    const session = sessions.find((entry, index) => sessionId(entry, index) === editId);
    if (!session || (edit.workout_family && sessionFamily(session) !== edit.workout_family)
      || (edit.scheduled_local_date && sessionLocalDate(session) !== dateOnly(edit.scheduled_local_date))) {
      violations.push({ code: 'ATHLETE_EDIT_PRESERVED', session_id: editId });
    }
  }
  return { validator: 'constraints', valid: violations.length === 0, violations, reason_codes: violations.map((violation) => violation.code) };
}

function maximumPrimaryKeys(options) {
  const age = String(options.training_age_class || '').toUpperCase();
  const consistency = String(options.consistency_state || '').toUpperCase();
  const recovery = String(options.recovery_state || '').toUpperCase();
  const availableDays = Number(options.available_days_count ?? options.available_local_dates?.length ?? 0);
  const constrained = ['BEGINNER', 'RETURNING'].includes(age)
    || ['RETURNING', 'SPARSE_DATA'].includes(consistency)
    || recovery === 'CAUTION' || availableDays <= 4;
  if (constrained) return 1;
  if (['ESTABLISHED', 'ADVANCED'].includes(age) && availableDays >= 6
    && options.tolerated_three_hard_stimuli === true) return 3;
  return availableDays >= 5 ? 2 : 1;
}

function validateRoles(sessions, options) {
  const violations = [];
  sessions.forEach((session, index) => {
    const role = sessionRole(session);
    if (!CLOSED_ROLES.has(role)) violations.push({ code: 'SESSION_ROLE_UNJUSTIFIED', session_id: sessionId(session, index), reason: 'ROLE_UNRESOLVED' });
    if (role === 'SUPPORTING' && !(
      session.supports_requirement_id || session.supports_session_id || session.limiter_id
      || session.safety_reason || session.recovery_requirement
    )) {
      violations.push({ code: 'SESSION_ROLE_UNJUSTIFIED', session_id: sessionId(session, index), reason: 'SUPPORT_LINK_MISSING' });
    }
  });
  const primary = sessions.filter((session) => sessionRole(session) === 'PRIMARY_KEY');
  const maximum = maximumPrimaryKeys(options);
  if (primary.length > maximum) violations.push({ code: 'SESSION_ROLE_UNJUSTIFIED', reason: 'PRIMARY_KEY_CAP', actual: primary.length, maximum });
  if (primary.length === 3) {
    const thirdEligible = primary.some((session) => {
      const predicates = classifyInterferencePredicates(session);
      return predicates.upper_body_strength || ['hyrox_station_skill', 'mobility'].includes(sessionFamily(session));
    });
    if (!thirdEligible) violations.push({ code: 'SESSION_ROLE_UNJUSTIFIED', reason: 'THIRD_KEY_NOT_UPPER_TECHNIQUE' });
  }
  return { validator: 'roles', valid: violations.length === 0, violations, reason_codes: violations.map((violation) => violation.code) };
}

function validateRequiredExposures(sessions, options) {
  const ledger = options.required_exposure_ledger?.due_roles
    ?? options.required_exposure_ledger
    ?? [];
  const violations = [];
  for (const requirement of ledger) {
    if ((options.unplaceable_requirement_ids || []).includes(requirement.requirement_id)) continue;
    const satisfied = sessions.some((session) => (
      (requirement.any_of || []).includes(sessionFamily(session))
      && (!requirement.role || sessionRole(session) === String(requirement.role).toUpperCase())
    ));
    if (!satisfied) violations.push({ code: 'REQUIRED_EXPOSURE_UNPLACEABLE', requirement_id: requirement.requirement_id });
  }
  return { validator: 'required_exposures', valid: violations.length === 0, violations, reason_codes: violations.map((violation) => violation.code) };
}

function qualityWorkMinutes(session) {
  const direct = Number(session.quality_work_duration_min ?? session.qualityWorkDurationMinutes);
  if (Number.isFinite(direct)) return direct;
  const seconds = (session.steps || []).filter((step) => String(step.step_role ?? step.role ?? '').toUpperCase() === 'WORK')
    .reduce((sum, step) => sum + Number(step.duration_s || step.duration_seconds || 0) * Number(step.repetitions || 1), 0);
  return seconds / 60;
}

function validatePresentationFloor(sessions, options) {
  const violations = [];
  const age = String(options.training_age_class || '').toUpperCase();
  const beginner = age === 'BEGINNER';
  const returning = age === 'RETURNING';
  const weeklyMinutes = Number(options.recent_normal_running_minutes_per_week);
  const ordinaryEasy = Number(options.median_ordinary_easy_duration_min);
  sessions.forEach((session, index) => {
    const family = sessionFamily(session);
    const duration = Number(session.duration_min ?? session.duration_minutes ?? (Number(session.duration_s || 0) / 60));
    let below = false;
    if (family === 'recovery_run') below = duration < (beginner || (Number.isFinite(weeklyMinutes) && weeklyMinutes < 60) ? 15 : 20);
    else if (family === 'easy_run') below = duration < (beginner || returning ? 20 : 25);
    else if (family === 'long_aerobic' && options.beginner_time_on_feet_policy !== true) {
      below = duration < 30 || (Number.isFinite(ordinaryEasy) && duration < ordinaryEasy * 1.5);
    } else if (['threshold_run', 'interval_run', 'race_rhythm_run'].includes(family)) {
      below = qualityWorkMinutes(session) < 8;
    } else if (family === 'hyrox_compromised') {
      below = Number(session.run_station_pair_count || 0) < 2 || Number(session.main_work_duration_min || 0) < 20;
    } else if (['strength_lower', 'strength_upper', 'strength_full_body'].includes(family)
      && session.technique_or_rehab_scope !== true) {
      const exercises = Array.isArray(session.exercises) ? session.exercises : [];
      below = exercises.length < 2 || exercises.some((exercise) => Number(exercise.working_sets ?? exercise.sets ?? 0) < 2);
    }
    const allowedException = (session.reason_codes || []).includes('BELOW_PRESENTATION_FLOOR_EXCEPTION')
      && Boolean(session.beginner_or_rehab_protocol_id);
    if (below && !allowedException) violations.push({
      code: 'BELOW_PRESENTATION_FLOOR_EXCEPTION',
      session_id: sessionId(session, index),
      workout_family: family,
    });
  });
  return { validator: 'presentation_floor', valid: violations.length === 0, violations, reason_codes: violations.map((violation) => violation.code) };
}

function safetyBlocksSession(action, session) {
  const family = sessionFamily(session);
  const vector = resolveStressVector(family, {
    event_kind: session.event_kind,
    contributing_work_families: session.contributing_work_families,
  });
  if (action === 'FULL_REST') return true;
  if (action === 'NO_RUNNING') return RUNNING_FAMILIES.has(family) || vector?.[1] > 0;
  if (action === 'NO_LOWER_BODY') return vector?.[1] > 0 || vector?.[2] > 0;
  if (action === 'NO_HIGH_INTENSITY') return vector?.some((value) => value >= 3);
  if (action === 'MODIFY_IMPACT') return vector?.[1] > 0 && session.impact_modified !== true;
  if (action === 'MODIFIED_SESSION_ONLY') return session.explicitly_validated_modified_session !== true;
  return false;
}

function validateSafety(sessions, options) {
  const action = String(options.safety_action || 'NORMAL').toUpperCase();
  const violations = sessions.map((session, index) => (
    safetyBlocksSession(action, session)
      ? { code: action, session_id: sessionId(session, index), workout_family: sessionFamily(session) }
      : null
  )).filter(Boolean);
  return { validator: 'safety', valid: violations.length === 0, violations, reason_codes: violations.map((violation) => violation.code) };
}

function validateGoalBackwardCandidate(candidate = {}, options = {}) {
  const sessions = sessionsFrom(candidate);
  const results = [
    validateAvailability(sessions, options),
    validateConstraints(sessions, options),
    validateRoles(sessions, options),
    validateRequiredExposures(sessions, options),
    validatePresentationFloor(sessions, options),
    validateSafety(sessions, options),
    validateInterference(sessions, options),
  ];
  if (options.workload_evidence && options.workload_evidence.valid === false) {
    results.push({
      validator: 'cross_modal_ceiling',
      valid: false,
      violations: clone(options.workload_evidence.violations || []),
      reason_codes: ['CROSS_MODAL_FATIGUE_LIMIT'],
    });
  }
  return deepFreeze({
    valid: results.every((result) => result.valid),
    validator_results: results,
    violations: results.flatMap((result) => result.violations || []),
    reason_codes: [...new Set(results.flatMap((result) => result.reason_codes || []))],
  });
}

function canonicalPrescriptionValue(value) {
  if (Array.isArray(value)) return value.map(canonicalPrescriptionValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    if (!COSMETIC_FIELDS.has(key) && !PRESCRIPTION_IDENTITY_FIELDS.has(key) && value[key] !== undefined) {
      result[key] = canonicalPrescriptionValue(value[key]);
    }
    return result;
  }, {});
}

function canonicalPrescriptionHash(plan = {}) {
  const prescriptions = sessionsFrom(plan).map((session) => canonicalPrescriptionValue(session))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return canonicalHash(prescriptions);
}

function distanceMeters(session) {
  const direct = Number(session.running_distance_m ?? session.distance_m ?? session.distanceMeters);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const miles = Number(session.distance_miles ?? session.distanceMiles);
  return Number.isFinite(miles) && miles >= 0 ? miles * 1609.344 : 0;
}

function runningDistanceMeters(session) {
  return RUNNING_FAMILIES.has(sessionFamily(session)) ? distanceMeters(session) : 0;
}

function sessionMatchKey(session, index) {
  const explicit = session.session_id ?? session.sessionId ?? session.id;
  if (explicit !== undefined && explicit !== null && String(explicit)) return `id:${explicit}`;
  return `fallback:${sessionLocalDate(session)}:${sessionRole(session)}:${sessionFamily(session)}`;
}

function relativeDelta(baseline, candidate) {
  return baseline > 0 ? Math.abs(candidate - baseline) / baseline : null;
}

function numericField(session, names) {
  for (const name of names) {
    const value = Number(session[name]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function stressVectorForMaterial(session) {
  if (Array.isArray(session.stress_vector) && session.stress_vector.length === DIMENSIONS.length) return session.stress_vector.map(Number);
  return resolveStressVector(sessionFamily(session), {
    event_kind: session.event_kind,
    contributing_work_families: session.contributing_work_families,
  });
}

function compareMatchedSession(baseline, candidate, changes) {
  const baselineFamily = sessionFamily(baseline);
  const candidateFamily = sessionFamily(candidate);
  const keySession = sessionRole(baseline) === 'PRIMARY_KEY' || sessionRole(candidate) === 'PRIMARY_KEY';
  if (keySession && baselineFamily !== candidateFamily) {
    changes.push({ code: 'KEY_SESSION_FAMILY_CHANGED', session_id: sessionId(candidate) });
  }
  const paceFields = ['target_pace_s_per_km', 'target_pace_seconds_per_km', 'goal_pace_seconds_per_mile'];
  const baselinePace = numericField(baseline, paceFields);
  const candidatePace = numericField(candidate, paceFields);
  if (baselinePace !== null && candidatePace !== null
    && relativeDelta(baselinePace, candidatePace) > GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.pace_percentage_strictly_greater_than) {
    changes.push({ code: 'TARGET_PACE_CHANGED', session_id: sessionId(candidate) });
  }
  const baselineZone = numericField(baseline, ['target_zone_number', 'hr_zone']);
  const candidateZone = numericField(candidate, ['target_zone_number', 'hr_zone']);
  if (baselineZone !== null && candidateZone !== null && Math.abs(candidateZone - baselineZone) >= 1) {
    changes.push({ code: 'TARGET_ZONE_CHANGED', session_id: sessionId(candidate) });
  }
  const structuralFields = [
    ['work_duration_s', 'work_duration_seconds'], ['repetitions', 'reps'], ['station_distance_m'],
    ['station_repetitions'], ['load_kg'],
  ];
  for (const names of structuralFields) {
    const before = numericField(baseline, names);
    const after = numericField(candidate, names);
    if (before === null || after === null || before === after) continue;
    if (before === 0 || relativeDelta(before, after) >= GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.interval_station_load_percentage) {
      changes.push({ code: 'SESSION_DOSAGE_CHANGED', session_id: sessionId(candidate), field: names[0] });
    }
  }
  const baselineSets = numericField(baseline, ['strength_hard_sets', 'hard_sets']);
  const candidateSets = numericField(candidate, ['strength_hard_sets', 'hard_sets']);
  if (baselineSets !== null && candidateSets !== null && baselineSets !== candidateSets
    && (relativeDelta(baselineSets, candidateSets) >= GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.strength_hard_sets.percentage
      || Math.abs(candidateSets - baselineSets) >= GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.strength_hard_sets.absolute)) {
    changes.push({ code: 'STRENGTH_HARD_SETS_CHANGED', session_id: sessionId(candidate) });
  }
  const beforeVector = stressVectorForMaterial(baseline);
  const afterVector = stressVectorForMaterial(candidate);
  if (beforeVector && afterVector && beforeVector.some((value, index) => (
    value !== afterVector[index] && (value === 0 || Math.abs(afterVector[index] - value) / value >= 0.20)
  ))) {
    changes.push({ code: 'HYBRID_STRESS_DIMENSION_CHANGED', session_id: sessionId(candidate) });
  }
  if ((isHardSession(baseline) || isHardSession(candidate))
    && sessionLocalDate(baseline) && sessionLocalDate(candidate)
    && Math.abs(daysBetween(sessionLocalDate(baseline), sessionLocalDate(candidate))) >= 2) {
    changes.push({ code: 'HARD_SESSION_MOVED', session_id: sessionId(candidate) });
  }
}

function hardAdjacencyPairs(sessions) {
  const hard = sessions.filter(isHardSession);
  const pairs = new Set();
  for (let left = 0; left < hard.length; left += 1) {
    for (let right = left + 1; right < hard.length; right += 1) {
      const leftDate = sessionLocalDate(hard[left]);
      const rightDate = sessionLocalDate(hard[right]);
      if (!leftDate || !rightDate || Math.abs(daysBetween(leftDate, rightDate)) > 1) continue;
      pairs.add([sessionMatchKey(hard[left], left), sessionMatchKey(hard[right], right)].sort().join('|'));
    }
  }
  return pairs;
}

function lockDatesFrom(input, baseline) {
  return (input.locks || baseline.locks || baseline.athlete_locks || [])
    .map((lock) => dateOnly(lock.local_date ?? lock.scheduled_local_date ?? lock.date))
    .filter(Boolean);
}

function compareMaterialChange(input = {}) {
  const baseline = input.active_applied_plan ?? input.activeAppliedPlan ?? null;
  const candidate = input.candidate || {};
  const candidateHash = canonicalPrescriptionHash(candidate);
  if (!baseline) {
    return deepFreeze({
      material_change_baseline: null,
      baseline_source: null,
      baseline_plan_revision: null,
      material_change: false,
      preview_required: false,
      review_required: true,
      initial_plan_review: true,
      change_label: null,
      prescription_hash_changed: null,
      active_prescription_hash: null,
      candidate_prescription_hash: candidateHash,
      changes: [],
      reason_codes: [],
    });
  }
  const baselineSessions = sessionsFrom(baseline);
  const candidateSessions = sessionsFrom(candidate);
  const changes = [];
  const baselineRunning = baselineSessions.reduce((sum, session) => sum + runningDistanceMeters(session), 0);
  const candidateRunning = candidateSessions.reduce((sum, session) => sum + runningDistanceMeters(session), 0);
  const weeklyDelta = relativeDelta(baselineRunning, candidateRunning);
  const weeklyAbsolute = Math.abs(candidateRunning - baselineRunning);
  if (weeklyDelta !== null
    && weeklyDelta >= GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.weekly_running.percentage
    && weeklyAbsolute >= GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.weekly_running.absolute_m) {
    changes.push({ code: 'WEEKLY_RUNNING_VOLUME', baseline_m: baselineRunning, candidate_m: candidateRunning });
  }
  const longest = (sessions) => Math.max(0, ...sessions.filter((session) => sessionFamily(session) === 'long_aerobic').map(distanceMeters));
  const baselineLong = longest(baselineSessions);
  const candidateLong = longest(candidateSessions);
  const longDelta = relativeDelta(baselineLong, candidateLong);
  if (longDelta !== null
    && longDelta >= GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.long_run.percentage
    && Math.abs(candidateLong - baselineLong) >= GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.long_run.absolute_m) {
    changes.push({ code: 'LONG_RUN_VOLUME', baseline_m: baselineLong, candidate_m: candidateLong });
  }
  const runningDates = (sessions) => new Set(sessions.filter((session) => RUNNING_FAMILIES.has(sessionFamily(session)))
    .map(sessionLocalDate).filter(Boolean));
  const baselineRunningDays = runningDates(baselineSessions).size;
  const candidateRunningDays = runningDates(candidateSessions).size;
  if (Math.abs(candidateRunningDays - baselineRunningDays) >= 1) {
    changes.push({ code: 'RUNNING_DAYS_CHANGED', baseline: baselineRunningDays, candidate: candidateRunningDays });
  }
  const baselineByKey = new Map(baselineSessions.map((session, index) => [sessionMatchKey(session, index), session]));
  const candidateByKey = new Map(candidateSessions.map((session, index) => [sessionMatchKey(session, index), session]));
  for (const [key, session] of baselineByKey) {
    const next = candidateByKey.get(key);
    if (!next && sessionRole(session) === 'PRIMARY_KEY') changes.push({ code: 'KEY_SESSION_REMOVED', session_id: sessionId(session) });
    else if (next) compareMatchedSession(session, next, changes);
  }
  for (const [key, session] of candidateByKey) {
    if (!baselineByKey.has(key) && (sessionRole(session) === 'PRIMARY_KEY' || isHardSession(session))) {
      changes.push({
        code: sessionRole(session) === 'PRIMARY_KEY' ? 'KEY_SESSION_ADDED' : 'HARD_SESSION_ADDED',
        session_id: sessionId(session),
      });
    }
  }
  const baselineAdjacency = hardAdjacencyPairs(baselineSessions);
  const candidateAdjacency = hardAdjacencyPairs(candidateSessions);
  if ([...candidateAdjacency].some((pair) => !baselineAdjacency.has(pair))) {
    changes.push({ code: 'HARD_SESSION_BECAME_ADJACENT' });
  }
  const lockDates = lockDatesFrom(input, baseline);
  if (lockDates.length) {
    for (const [key, before] of baselineByKey) {
      const after = candidateByKey.get(key);
      const beforeDate = sessionLocalDate(before);
      const afterDate = after && sessionLocalDate(after);
      if (!after || !beforeDate || !afterDate || beforeDate === afterDate || !(isHardSession(before) || isHardSession(after))) continue;
      const low = beforeDate < afterDate ? beforeDate : afterDate;
      const high = beforeDate < afterDate ? afterDate : beforeDate;
      if (lockDates.some((date) => date >= low && date <= high)) {
        changes.push({ code: 'HARD_SESSION_CROSSED_LOCK', session_id: sessionId(after) });
      }
    }
  }
  if (String(baseline.phase || '') !== String(candidate.phase || '') && (baseline.phase || candidate.phase)) {
    changes.push({ code: 'PHASE_CHANGED', baseline: baseline.phase ?? null, candidate: candidate.phase ?? null });
  }
  const baselinePriority = baseline.goal_priority ?? baseline.primary_goal_priority;
  const candidatePriority = candidate.goal_priority ?? candidate.primary_goal_priority;
  if (baselinePriority !== candidatePriority && (baselinePriority || candidatePriority)) {
    changes.push({ code: 'GOAL_PRIORITY_CHANGED', baseline: baselinePriority ?? null, candidate: candidatePriority ?? null });
  }
  const baselineSafety = JSON.stringify(baseline.safety_scope ?? null);
  const candidateSafety = JSON.stringify(candidate.safety_scope ?? null);
  if (baselineSafety !== candidateSafety && (baseline.safety_scope || candidate.safety_scope)) {
    changes.push({ code: 'SAFETY_SCOPE_CHANGED' });
  }
  const uniqueChanges = [...new Map(changes.map((change) => [
    [change.code, change.session_id, change.field].join(':'), change,
  ])).values()];
  const activeHash = canonicalPrescriptionHash(baseline);
  const material = uniqueChanges.length > 0;
  return deepFreeze({
    material_change_baseline: {
      plan_revision: baseline.plan_revision ?? baseline.planRevision ?? null,
      source: 'ACTIVE_APPLIED_PLAN',
    },
    baseline_source: 'ACTIVE_APPLIED_PLAN',
    baseline_plan_revision: baseline.plan_revision ?? baseline.planRevision ?? null,
    material_change: material,
    preview_required: material,
    review_required: material,
    initial_plan_review: false,
    change_label: material ? 'material_change' : 'minor_or_no_change',
    prescription_hash_changed: activeHash !== candidateHash,
    active_prescription_hash: activeHash,
    candidate_prescription_hash: candidateHash,
    changes: uniqueChanges,
    reason_codes: material ? ['MATERIAL_CHANGE_REVIEW_REQUIRED'] : [],
  });
}

module.exports = {
  canonicalPrescriptionHash,
  classifyInterferencePredicates,
  compareMaterialChange,
  validateGoalBackwardCandidate,
  validateInterference,
};
