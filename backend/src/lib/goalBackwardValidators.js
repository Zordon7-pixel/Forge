const {
  GOAL_BACKWARD_PLANNING_POLICY_V1,
  addDays,
  canonicalHash,
  daysBetween,
} = require('./racePlanPolicy');
const {
  aggregateWeeklyStress,
  buildGoalBackwardWorkloadEvidence,
  resolveSessionStress,
  resolveStressVector,
} = require('./goalBackwardLoad');
const { normalizePlanningConstraints } = require('./planCandidateLifecycle');
const {
  evaluateMaterialDose,
  normalizeCompletedRunningCredit,
  normalizeScope,
  validateDevelopmentRoleDose,
} = require('./goalBackwardRecoveryMaterial');
const {
  validateCanonicalSession,
  validateCanonicalSessionSet,
  validatePartialRaceOrderCluster,
} = require('./canonicalWorkout');

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
  'scheduledStartAt', 'date', 'local_date', 'session_revision', 'plan_id', 'plan_revision',
  'decision_id', 'content_hash',
]);
const HARD_VALIDATOR_NAMES = Object.freeze([
  'schema',
  'canonical_session_set',
  'material_review',
  'material_dose',
  'development_roles',
  'scope',
  'availability',
  'constraints',
  'roles',
  'required_exposures',
  'cross_modal_ceiling',
  'presentation_floor',
  'safety',
  'interference',
]);
const SAFETY_ACTIONS = new Set([
  'NORMAL',
  'MONITOR',
  'MODIFY_IMPACT',
  'NO_RUNNING',
  'NO_LOWER_BODY',
  'NO_HIGH_INTENSITY',
  'MODIFIED_SESSION_ONLY',
  'FULL_REST',
  'PROFESSIONAL_ASSESSMENT_RECOMMENDED',
]);
const EXECUTABLE_SURFACES = Object.freeze([
  'ui_start',
  'workout_start',
  'watch',
  'fit',
  'calendar_start',
  'map',
  'warm_up',
]);
const PRESENTATION_FLOOR_PACE_MIN_S_PER_MILE = 180;
const PRESENTATION_FLOOR_PACE_MAX_S_PER_MILE = 2400;
const PRESENTATION_FLOOR_FAST_BOUND_FACTOR = 0.9;

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
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value ? null : value;
}

function dateFromStartInstant(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/
  );
  if (!match || /^[+-]14:(?!00$)/.test(match[1])) return null;
  const date = value.slice(0, 10);
  const parsed = new Date(value);
  return dateOnly(date) && !Number.isNaN(parsed.getTime()) ? date : null;
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
  const calendarDate = session.scheduled_local_date ?? session.scheduledLocalDate
    ?? session.local_date ?? session.date;
  if (calendarDate !== null && calendarDate !== undefined) return dateOnly(calendarDate);
  return dateFromStartInstant(session.scheduled_start_at ?? session.scheduledStartAt);
}

function sessionsFrom(container = {}) {
  if (Array.isArray(container)) return container;
  if (Array.isArray(container.sessions)) return container.sessions;
  return (container.weeks || []).flatMap((week) => (
    week === null ? [] :
    (week.days || week.sessions || []).flatMap((day) => (
      day === null ? [] :
      Array.isArray(day.sessions)
        ? day.sessions.map((session) => ({ ...session, scheduled_local_date: sessionLocalDate(session) || sessionLocalDate(day) }))
        : [{ ...day, scheduled_local_date: sessionLocalDate(day) }]
    ))
  ));
}

function validatePartialRaceOrderClusterExposure(container = {}, options = {}) {
  const sessions = sessionsFrom(container);
  const eventDate = dateOnly(options.event_local_date ?? options.eventLocalDate);
  const earliest = eventDate ? addDays(eventDate, -28) : null;
  const latest = eventDate ? addDays(eventDate, -14) : null;
  const mandatory = options.mandatory_hyrox_cluster === true;
  const violations = [];
  const candidates = sessions.filter((session) => sessionFamily(session) === 'hyrox_partial_simulation');
  const validClusters = [];
  for (const [index, session] of candidates.entries()) {
    const schema = validatePartialRaceOrderCluster(session, options);
    if (!schema.valid) {
      violations.push(...schema.violations.map((violation) => ({
        code: 'REQUIRED_EXPOSURE_UNPLACEABLE',
        reason: violation.reason || violation.code,
        session_id: sessionId(session, index),
      })));
      continue;
    }
    const date = sessionLocalDate(session);
    if (!date) {
      violations.push({ code: 'REQUIRED_EXPOSURE_UNPLACEABLE', reason: 'CLUSTER_DATE_INVALID', session_id: sessionId(session, index) });
      continue;
    }
    validClusters.push({ session, date, schema, session_id: sessionId(session, index) });
  }
  const sorted = validClusters.slice().sort((left, right) => left.date.localeCompare(right.date));
  for (let index = 1; index < sorted.length; index += 1) {
    const separationDays = daysBetween(sorted[index - 1].date, sorted[index].date);
    if (separationDays < 14) violations.push({
      code: 'REQUIRED_EXPOSURE_UNPLACEABLE',
      reason: 'CLUSTER_FREQUENCY_EXCEEDED',
      session_ids: [sorted[index - 1].session_id, sorted[index].session_id],
      separation_local_days: separationDays,
      minimum_separation_local_days: 14,
    });
  }
  const qualifying = eventDate
    ? sorted.filter((entry) => entry.date >= earliest && entry.date <= latest)
    : [];
  if (eventDate) {
    sorted.filter((entry) => entry.date < earliest || entry.date > latest).forEach((entry) => {
      violations.push({
        code: 'REQUIRED_EXPOSURE_UNPLACEABLE',
        reason: 'CLUSTER_OUTSIDE_REQUIRED_WINDOW',
        session_id: entry.session_id,
        scheduled_local_date: entry.date,
        earliest_local_date: earliest,
        latest_local_date: latest,
      });
    });
  }
  if (mandatory && (!eventDate || qualifying.length === 0)) {
    violations.push({
      code: 'REQUIRED_EXPOSURE_UNPLACEABLE',
      reason: eventDate ? 'MANDATORY_CLUSTER_MISSING' : 'EVENT_DATE_REQUIRED_FOR_CLUSTER_WINDOW',
    });
  }
  if (options.require_completed_exposure === true && !qualifying.some((entry) => entry.schema.completed_successfully)) {
    violations.push({ code: 'REQUIRED_EXPOSURE_UNPLACEABLE', reason: 'CLUSTER_COMPLETION_INCOMPLETE' });
  }
  return deepFreeze({
    valid: violations.length === 0,
    mandatory,
    window: { earliest_local_date: earliest, latest_local_date: latest },
    cluster_dates: sorted.map((entry) => entry.date),
    qualifying_cluster_dates: qualifying.map((entry) => entry.date),
    completed_qualifying_cluster_dates: qualifying.filter((entry) => entry.schema.completed_successfully).map((entry) => entry.date),
    violations,
    reason_codes: violations.length ? ['REQUIRED_EXPOSURE_UNPLACEABLE'] : [],
  });
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

function validateCandidateSchema(sessions) {
  const violations = [];
  const ids = new Set();
  sessions.forEach((session, index) => {
    if (!session || typeof session !== 'object' || Array.isArray(session)) {
      violations.push({ code: 'SESSION_ROLE_UNJUSTIFIED', reason: 'SESSION_NOT_OBJECT', session_index: index });
      return;
    }
    const suppliedId = session.session_id ?? session.sessionId ?? session.id;
    const id = sessionId(session, index);
    if (suppliedId === undefined || suppliedId === null || !String(suppliedId).trim()) {
      violations.push({ code: 'SESSION_ROLE_UNJUSTIFIED', reason: 'SESSION_ID_REQUIRED', session_index: index });
    } else if (ids.has(id)) {
      violations.push({ code: 'SESSION_ROLE_UNJUSTIFIED', reason: 'DUPLICATE_SESSION_ID', session_id: id });
    }
    ids.add(id);
    if (!sessionLocalDate(session)) {
      violations.push({ code: 'SESSION_ROLE_UNJUSTIFIED', reason: 'SESSION_DATE_INVALID', session_id: id });
    }
    if (!sessionFamily(session) || !resolveStressVector(sessionFamily(session), {
      event_kind: session.event_kind,
      contributing_work_families: session.contributing_work_families,
    })) {
      violations.push({ code: 'WORKOUT_FAMILY_UNRESOLVED', session_id: id });
    }
    if (!CLOSED_ROLES.has(sessionRole(session))) {
      violations.push({ code: 'SESSION_ROLE_UNJUSTIFIED', reason: 'ROLE_UNRESOLVED', session_id: id });
    }
  });
  return {
    validator: 'schema',
    valid: violations.length === 0,
    violations,
    reason_codes: [...new Set(violations.map((violation) => violation.code))],
  };
}

function validateCanonicalMaterialization(candidate, sessions) {
  const canonical = sessions.filter((session) => Number(session?.canonical_workout_schema_version) === 1);
  const violations = [];
  if (canonical.length && canonical.length !== sessions.length) {
    violations.push({ code: 'CANONICAL_SESSION_SET_INVALID', reason: 'PARTIAL_CANONICAL_MATERIALIZATION' });
  }
  canonical.forEach((session, index) => {
    const result = validateCanonicalSession(session);
    if (!result.valid) violations.push({
      code: 'CANONICAL_SESSION_SET_INVALID',
      reason: 'SESSION_INVALID',
      session_index: index,
      details: result.violations,
    });
  });
  if (canonical.length) {
    if (!candidate.canonical_session_set) {
      violations.push({ code: 'CANONICAL_SESSION_SET_INVALID', reason: 'SESSION_SET_REQUIRED' });
    } else {
      const result = validateCanonicalSessionSet(candidate.canonical_session_set);
      if (!result.valid) violations.push(...result.violations);
    }
  }
  return {
    validator: 'canonical_session_set',
    valid: violations.length === 0,
    violations,
    reason_codes: violations.length ? ['CANONICAL_SESSION_SET_INVALID'] : [],
  };
}

function validateMaterialReview(candidate, sessions) {
  const summary = candidate.material_change;
  const violations = [];
  if (!summary) {
    return { validator: 'material_review', valid: true, violations, reason_codes: [] };
  }
  if (summary.auto_apply_allowed !== false) {
    violations.push({ code: 'MATERIAL_CHANGE_REVIEW_REQUIRED', reason: 'AUTO_APPLY_NOT_DISABLED' });
  }
  if (summary.material_change === true) {
    const items = Array.isArray(summary.changes) ? summary.changes : [];
    const canonicalSet = candidate.canonical_session_set;
    const canonicalSessions = Array.isArray(canonicalSet?.sessions) ? canonicalSet.sessions : [];
    const baselineBindings = new Map((summary.baseline_session_bindings || []).map((binding) => [
      String(binding.session_id || ''), binding,
    ]));
    if (summary.preview_required !== true || summary.review_required !== true
      || summary.review_contract_complete !== true || !items.length) {
      violations.push({ code: 'MATERIAL_CHANGE_REVIEW_REQUIRED', reason: 'REVIEW_CONTRACT_INCOMPLETE' });
    }
    for (const item of items) {
      const baselineBindingHash = canonicalHash({
        material_change_baseline: summary.material_change_baseline ?? null,
        baseline_plan_revision: summary.baseline_plan_revision ?? null,
        active_prescription_hash: summary.active_prescription_hash ?? null,
        baseline_session_bindings: summary.baseline_session_bindings ?? [],
      });
      const canonicalBindingInvalid = candidate.canonical_sessions_materialized === true && (
        item.decision_id !== candidate.canonical_session_set?.decision_id
        || item.candidate_hash !== candidate.candidate_hash
        || item.canonical_session_set_hash !== candidate.canonical_session_set?.content_hash
        || item.candidate_plan_revision !== candidate.canonical_session_set?.plan_revision
        || baselineBindingHash !== candidate.canonical_session_set?.material_change_baseline_binding_hash
      );
      let sessionBindingInvalid = false;
      if (candidate.canonical_sessions_materialized === true) {
        if (item.session_id) {
          const matched = canonicalSessions.find((session) => String(session.session_id) === String(item.session_id));
          if (matched) {
            sessionBindingInvalid = item.candidate_binding_state !== 'CANONICAL'
              || item.candidate_session_revision !== matched.session_revision
              || item.candidate_session_content_hash !== matched.content_hash;
          } else {
            sessionBindingInvalid = item.candidate_binding_state !== 'REMOVED'
              || item.candidate_session_revision !== null
              || item.candidate_session_content_hash !== null;
          }
          const baselineBinding = baselineBindings.get(String(item.session_id));
          if (!matched && !baselineBinding) sessionBindingInvalid = true;
          if (baselineBinding) {
            sessionBindingInvalid = sessionBindingInvalid
              || item.baseline_binding_state !== baselineBinding.binding_state
              || item.baseline_session_revision !== baselineBinding.session_revision
              || item.baseline_session_content_hash !== baselineBinding.session_content_hash
              || (baselineBinding.binding_state === 'CANONICAL' && (
                !Number.isSafeInteger(baselineBinding.session_revision) || baselineBinding.session_revision < 1
                || !/^[a-f0-9]{64}$/.test(String(baselineBinding.session_content_hash || ''))
              ))
              || (baselineBinding.binding_state === 'LEGACY_PLAN_REVISION' && (
                baselineBinding.session_revision !== null || baselineBinding.session_content_hash !== null
              ));
          } else {
            sessionBindingInvalid = sessionBindingInvalid
              || item.baseline_binding_state !== 'NOT_APPLICABLE'
              || item.baseline_session_revision !== null
              || item.baseline_session_content_hash !== null;
          }
        } else {
          sessionBindingInvalid = item.baseline_binding_state !== 'PLAN_LEVEL'
            || item.candidate_binding_state !== 'PLAN_LEVEL'
            || item.baseline_session_revision !== null
            || item.candidate_session_revision !== null
            || item.baseline_session_content_hash !== null
            || item.candidate_session_content_hash !== null;
        }
      }
      if (item.review_required !== true || item.reason_code !== 'MATERIAL_CHANGE_REVIEW_REQUIRED'
        || !Array.isArray(item.decisive_evidence_ids) || !item.decisive_evidence_ids.length
        || !Number.isSafeInteger(item.baseline_plan_revision) || item.baseline_plan_revision < 1
        || !Number.isSafeInteger(item.candidate_plan_revision) || item.candidate_plan_revision < 1
        || canonicalBindingInvalid || sessionBindingInvalid) {
        violations.push({
          code: 'MATERIAL_CHANGE_REVIEW_REQUIRED',
          reason: 'MATERIAL_ITEM_BINDING_INCOMPLETE',
          change_code: item.code || null,
        });
      }
    }
  } else if (summary.initial_plan_review === true) {
    const items = Array.isArray(summary.initial_review_items) ? summary.initial_review_items : [];
    if (summary.review_required !== true || items.length !== sessions.length) {
      violations.push({ code: 'MATERIAL_CHANGE_REVIEW_REQUIRED', reason: 'INITIAL_REVIEW_INCOMPLETE' });
    }
  }
  return {
    validator: 'material_review',
    valid: violations.length === 0,
    violations,
    reason_codes: violations.length ? ['MATERIAL_CHANGE_REVIEW_REQUIRED'] : [],
  };
}

function validateMaterialDose(candidate, options = {}) {
  if (!options.material_dose) {
    return { validator: 'material_dose', valid: true, violations: [], reason_codes: [] };
  }
  const receipt = evaluateMaterialDose({
    ...options.material_dose,
    candidate,
  });
  return {
    validator: 'material_dose',
    valid: receipt.valid,
    violations: clone(receipt.violations || []),
    reason_codes: clone(receipt.reason_codes || []),
    receipt,
  };
}

function dueRoleRequirements(options = {}) {
  const source = options.required_exposure_ledger?.due_roles
    ?? options.required_exposure_ledger
    ?? [];
  return Array.isArray(source) ? source : [];
}

function validateCandidateScope(sessions, options = {}) {
  const violations = [];
  const requirements = dueRoleRequirements(options);
  const byId = new Map(requirements.map((requirement) => [String(requirement.requirement_id), requirement]));
  const explicitlyAllowed = Array.isArray(options.allowed_requirement_ids)
    ? options.allowed_requirement_ids.map(String)
    : options.enforce_due_role_scope === true
      ? requirements.map((requirement) => String(requirement.requirement_id))
      : [];
  const allowed = new Set(explicitlyAllowed);
  const enforceScope = Array.isArray(options.allowed_requirement_ids) || options.enforce_due_role_scope === true;
  const maximum = Number(options.maximum_session_count);
  if (Number.isSafeInteger(maximum) && maximum >= 0 && sessions.length > maximum) {
    violations.push({
      code: 'SESSION_ROLE_UNJUSTIFIED',
      reason: 'MAXIMUM_SESSION_COUNT',
      actual: sessions.length,
      maximum,
    });
  }
  sessions.forEach((session, index) => {
    const requirementId = String(session.requirement_id ?? session.requirementId ?? '');
    if (enforceScope && (!requirementId || !allowed.has(requirementId))) {
      violations.push({
        code: 'SESSION_ROLE_UNJUSTIFIED',
        reason: 'OUTSIDE_DUE_ROLE_MULTISET',
        session_id: sessionId(session, index),
      });
      return;
    }
    const requirement = byId.get(requirementId);
    if (requirement && (!(requirement.any_of || []).includes(sessionFamily(session))
      || (requirement.role && String(requirement.role).toUpperCase() !== sessionRole(session)))) {
      violations.push({
        code: 'SESSION_ROLE_UNJUSTIFIED',
        reason: 'DUE_ROLE_MISMATCH',
        requirement_id: requirementId,
        session_id: sessionId(session, index),
      });
    }
  });
  return {
    validator: 'scope',
    valid: violations.length === 0,
    violations,
    reason_codes: violations.length ? ['SESSION_ROLE_UNJUSTIFIED'] : [],
  };
}

function validateCrossModalCeiling(options = {}) {
  const evidence = options.workload_evidence;
  const violations = evidence?.valid === false
    ? clone((evidence.violations || []).length ? evidence.violations : [{ code: 'CROSS_MODAL_FATIGUE_LIMIT' }])
    : [];
  return {
    validator: 'cross_modal_ceiling',
    valid: violations.length === 0,
    violations,
    reason_codes: violations.length
      ? ['CROSS_MODAL_FATIGUE_LIMIT'] : [...new Set(evidence?.reason_codes || [])],
  };
}

function matchesRoleFamily(session, constraint) {
  const role = constraint.role ? sessionRole(session) === String(constraint.role).toUpperCase() : true;
  const family = constraint.workout_family ? sessionFamily(session) === constraint.workout_family : true;
  return role && family;
}

function constraintsFromOptions(options = {}) {
  const supplied = options.planning_constraints ?? options.planningConstraints;
  if (supplied && !Array.isArray(supplied)
    && Array.isArray(supplied.locks) && Array.isArray(supplied.manual_edits)) {
    return supplied;
  }
  if (Array.isArray(supplied)) {
    return normalizePlanningConstraints(supplied, {
      athleteId: options.athlete_id ?? options.athleteId,
      planId: options.plan_id ?? options.planId ?? null,
    });
  }
  return { locks: options.locks || [], manual_edits: options.manual_edits || [] };
}

function constraintDate(constraint = {}) {
  return dateOnly(constraint.date_local ?? constraint.local_date
    ?? constraint.scheduled_local_date ?? constraint.date);
}

function constraintPrescriptionMatches(session, constraint, { manualEdit = false } = {}) {
  if (!session) return false;
  if (constraint.workout_family && sessionFamily(session) !== constraint.workout_family) return false;
  if (constraint.role && sessionRole(session) !== String(constraint.role).toUpperCase()) return false;
  const date = constraintDate(constraint);
  if (date && sessionLocalDate(session) !== date) return false;
  const expectedRevision = constraint.session_revision ?? constraint.sessionRevision;
  if (expectedRevision !== null && expectedRevision !== undefined
    && Number(session.session_revision ?? session.sessionRevision) !== Number(expectedRevision)) return false;
  const expectedHash = constraint.content_hash ?? constraint.session_content_hash ?? constraint.prescription_hash;
  if (expectedHash && String(
    session.content_hash ?? session.session_content_hash ?? session.prescription_hash ?? ''
  ) !== String(expectedHash)) {
    return false;
  }
  if ((constraint.pins_dosage === true || constraint.lock_scope === 'full_prescription') && !expectedHash) {
    const expectedPrescription = constraint.prescription ?? constraint.session ?? null;
    if (!expectedPrescription) return false;
    if (JSON.stringify(canonicalPrescriptionValue(session))
      !== JSON.stringify(canonicalPrescriptionValue(expectedPrescription))) return false;
  }
  if (Array.isArray(constraint.steps)
    && JSON.stringify(session.steps || []) !== JSON.stringify(constraint.steps)) return false;
  if (manualEdit && String(constraint.owner || '').toLowerCase() !== 'athlete') return false;
  return true;
}

function validateConstraints(sessions, options) {
  const violations = [];
  const constraints = constraintsFromOptions(options);
  for (const lock of constraints.locks || []) {
    if (lock.active === false) continue;
    const kind = String(lock.constraint_kind ?? lock.kind ?? lock.type ?? '').toLowerCase();
    if (kind === 'day_lock') {
      const date = constraintDate(lock);
      if (!sessions.some((session) => sessionLocalDate(session) === date
        && matchesRoleFamily(session, lock)
        && constraintPrescriptionMatches(session, lock))) {
        violations.push({ code: 'ATHLETE_LOCK_CONFLICT', constraint_kind: 'day_lock', local_date: date });
      }
    } else if (kind === 'session_lock') {
      const lockedId = String(lock.session_id ?? lock.sessionId ?? '');
      const session = sessions.find((entry, index) => sessionId(entry, index) === lockedId);
      if (!constraintPrescriptionMatches(session, lock)) {
        violations.push({ code: 'ATHLETE_LOCK_CONFLICT', constraint_kind: 'session_lock', session_id: lockedId });
      }
    }
  }
  for (const edit of constraints.manual_edits || []) {
    if (edit.active === false) continue;
    const editId = String(edit.session_id ?? edit.sessionId ?? '');
    const session = sessions.find((entry, index) => sessionId(entry, index) === editId);
    if (!constraintPrescriptionMatches(session, edit, { manualEdit: true })) {
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
  const mandatoryClusterWeek = dueRoleRequirements(options).some((requirement) => (
    (requirement.any_of || []).includes('hyrox_partial_simulation')
  ));
  if (mandatoryClusterWeek) {
    const aggregate = aggregateWeeklyStress(sessions);
    for (const stationSkill of sessions.filter((session) => sessionFamily(session) === 'hyrox_station_skill')) {
      const day = aggregate.days.find((entry) => entry.scheduled_local_date === sessionLocalDate(stationSkill));
      if (day?.hard_day) violations.push({
        code: 'SESSION_ROLE_UNJUSTIFIED',
        reason: 'MANDATORY_STATION_SKILL_MUST_REMAIN_NON_HARD',
        session_id: sessionId(stationSkill),
      });
    }
  }
  return { validator: 'roles', valid: violations.length === 0, violations, reason_codes: violations.map((violation) => violation.code) };
}

function validateRequiredExposures(sessions, options) {
  const ledger = options.required_exposure_ledger?.due_roles
    ?? options.required_exposure_ledger
    ?? [];
  const violations = [];
  const partialRequirement = ledger.some((requirement) => (
    (requirement.any_of || []).includes('hyrox_partial_simulation')
  ));
  const recordedUnplaceable = new Set([
    ...(options.unplaceable_requirement_ids || []),
    ...(options.required_exposure_ledger?.unplaceable_requirement_ids || []),
  ].map(String));
  const clusterExposure = partialRequirement ? validatePartialRaceOrderClusterExposure(sessions, {
    ...options,
    mandatory_hyrox_cluster: true,
  }) : null;
  for (const requirement of ledger) {
    if (recordedUnplaceable.has(String(requirement.requirement_id))) continue;
    const requiresPartial = (requirement.any_of || []).includes('hyrox_partial_simulation');
    const satisfied = requiresPartial
      ? clusterExposure?.valid === true && sessions.some((session) => (
        sessionFamily(session) === 'hyrox_partial_simulation'
        && (!requirement.role || sessionRole(session) === String(requirement.role).toUpperCase())
      ))
      : sessions.some((session) => (
        (requirement.any_of || []).includes(sessionFamily(session))
        && (!requirement.role || sessionRole(session) === String(requirement.role).toUpperCase())
      ));
    if (!satisfied) violations.push({ code: 'REQUIRED_EXPOSURE_UNPLACEABLE', requirement_id: requirement.requirement_id });
  }
  if (clusterExposure && !clusterExposure.valid) violations.push(...clusterExposure.violations);
  const minimumRunning = Number(options.minimum_weekly_demand?.running_m);
  if (Number.isSafeInteger(minimumRunning) && minimumRunning >= 0) {
    const completedRunningReceipt = normalizeCompletedRunningCredit(
      options.completed_running_credit,
      options.planning_date_local,
    );
    const completedRunning = completedRunningReceipt?.completed_running_m ?? 0;
    const creditedWeekEnd = completedRunning > 0
      ? addDays(completedRunningReceipt.planning_week_start_local, 6) : null;
    const applicableSessions = creditedWeekEnd
      ? sessions.filter((session) => sessionLocalDate(session) <= creditedWeekEnd)
      : sessions;
    const actualRunning = aggregateKnownRunningDistance(applicableSessions);
    if (actualRunning === null) violations.push({
      code: 'REQUIRED_EXPOSURE_UNPLACEABLE', reason: 'WEEKLY_RUNNING_DISTANCE_UNKNOWN', required_running_m: minimumRunning,
    });
    else if (Math.round(actualRunning + completedRunning) < minimumRunning) violations.push({
      code: 'REQUIRED_EXPOSURE_UNPLACEABLE', reason: 'WEEKLY_RUNNING_FLOOR',
      required_running_m: minimumRunning,
      proposed_running_m: Math.round(actualRunning),
      ...(completedRunning > 0 ? {
        completed_running_credit_m: completedRunning,
        credited_running_m: Math.round(actualRunning + completedRunning),
      } : {}),
    });
  }
  return { validator: 'required_exposures', valid: violations.length === 0, violations, reason_codes: violations.map((violation) => violation.code) };
}

function primitiveFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function presentationFloorPaceSecondsPerMile(options = {}) {
  const pace = primitiveFiniteNumber(
    options.presentation_floor_pace_s_per_mile
      ?? options.presentationFloorPaceSecondsPerMile,
  );
  return pace !== null
    && pace >= PRESENTATION_FLOOR_PACE_MIN_S_PER_MILE
    && pace <= PRESENTATION_FLOOR_PACE_MAX_S_PER_MILE ? pace : null;
}

function canonicalTargetHas(session, field, { workOnly = false } = {}) {
  return flattenedCanonicalSteps(session.steps).some(({ step }) => (
    (!workOnly || String(step.step_role ?? step.role ?? '').toUpperCase() === 'WORK')
      && step.target && Object.hasOwn(step.target, field)
  ));
}

function equivalentMinutesFromDistance(distanceM, options = {}) {
  const distance = primitiveFiniteNumber(distanceM);
  const pace = presentationFloorPaceSecondsPerMile(options);
  if (distance === null || distance <= 0 || pace === null) return null;
  // A floor is a minimum-dose proof, so use the faster side of the bounded
  // observed-pace witness. This cannot turn a short distance into a passing
  // duration merely by assuming the athlete moves unusually slowly.
  return ((distance / 1609.344) * (pace * PRESENTATION_FLOOR_FAST_BOUND_FACTOR)) / 60;
}

function sessionDurationMinutes(session, options = {}) {
  const canonical = session.canonical_workout_schema_version === 1;
  if (canonical && canonicalTargetHas(session, 'duration_s')) {
    const seconds = primitiveFiniteNumber(session.derived_totals?.duration_s);
    return seconds === null ? null : seconds / 60;
  }
  for (const value of [session.duration_min, session.duration_minutes]) {
    const minutes = primitiveFiniteNumber(value);
    if (minutes !== null) return minutes;
  }
  for (const value of [session.duration_s, session.duration_seconds]) {
    const seconds = primitiveFiniteNumber(value);
    if (seconds !== null) return seconds / 60;
  }
  const derivedSeconds = primitiveFiniteNumber(session.derived_totals?.duration_s);
  if (derivedSeconds !== null && derivedSeconds > 0) return derivedSeconds / 60;
  return equivalentMinutesFromDistance(distanceMeters(session), options) ?? 0;
}

function qualityWorkMinutes(session, options = {}) {
  for (const value of [session.quality_work_duration_min, session.qualityWorkDurationMinutes]) {
    const direct = primitiveFiniteNumber(value);
    if (direct !== null) return direct;
  }
  const canonical = session.canonical_workout_schema_version === 1;
  const canonicalWorkDuration = primitiveFiniteNumber(session.derived_totals?.work_duration_s);
  if (canonical && canonicalTargetHas(session, 'duration_s', { workOnly: true })) {
    return canonicalWorkDuration === null ? 0 : canonicalWorkDuration / 60;
  }
  if (canonicalWorkDuration !== null && canonicalWorkDuration > 0) return canonicalWorkDuration / 60;
  const workSteps = flattenedCanonicalSteps(session.steps).filter(({ step }) => (
    String(step.step_role ?? step.role ?? '').toUpperCase() === 'WORK'
  ));
  const seconds = workSteps.reduce((sum, { step, multiplier }) => {
    const duration = primitiveFiniteNumber(step.duration_s ?? step.duration_seconds);
    return sum + (duration === null ? 0 : duration * multiplier);
  }, 0);
  if (seconds > 0) return seconds / 60;
  const workDistance = primitiveFiniteNumber(session.derived_totals?.work_distance_m)
    ?? workSteps.reduce((sum, { step, multiplier }) => {
      const distance = primitiveFiniteNumber(step.target?.distance_m ?? step.distance_m);
      return sum + (distance === null ? 0 : distance * multiplier);
    }, 0);
  return equivalentMinutesFromDistance(workDistance, options) ?? 0;
}

function validatePresentationFloor(sessions, options = {}) {
  const violations = [];
  const age = String(options.training_age_class || '').toUpperCase();
  const beginner = age === 'BEGINNER';
  const returning = age === 'RETURNING';
  const weeklyMinutes = Number(options.recent_normal_running_minutes_per_week);
  const ordinaryEasy = Number(options.median_ordinary_easy_duration_min);
  sessions.forEach((session, index) => {
    const family = sessionFamily(session);
    const duration = sessionDurationMinutes(session, options);
    let below = false;
    if (family === 'recovery_run') below = duration < (beginner || (Number.isFinite(weeklyMinutes) && weeklyMinutes < 60) ? 15 : 20);
    else if (family === 'easy_run') below = duration < (beginner || returning ? 20 : 25);
    else if (family === 'long_aerobic' && options.beginner_time_on_feet_policy !== true) {
      below = duration < 30 || (Number.isFinite(ordinaryEasy) && duration < ordinaryEasy * 1.5);
    } else if (['threshold_run', 'interval_run', 'race_rhythm_run'].includes(family)) {
      below = qualityWorkMinutes(session, options) < 8;
    } else if (family === 'hyrox_compromised') {
      const canonicalSteps = flattenedCanonicalSteps(session.steps);
      const canonicalRunPairs = canonicalSteps.filter(({ step }) => (
        ['run', 'interval'].includes(step.type)
      )).length;
      const canonicalStationPairs = canonicalSteps.filter(({ step }) => step.type === 'station').length;
      const pairCount = Number(session.run_station_pair_count || 0)
        || Math.min(canonicalRunPairs, canonicalStationPairs);
      const mainWorkDuration = Number(session.main_work_duration_min || 0)
        || Number(session.derived_totals?.work_duration_s || 0) / 60;
      below = pairCount < 2 || mainWorkDuration < 20;
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
  if (!vector && !['NORMAL', 'MONITOR'].includes(action)) return true;
  if (action === 'NO_RUNNING') return RUNNING_FAMILIES.has(family) || vector?.[1] > 0;
  if (action === 'NO_LOWER_BODY') return vector?.[1] > 0 || vector?.[2] > 0;
  if (action === 'NO_HIGH_INTENSITY') return vector?.some((value) => value >= 3);
  if (action === 'MODIFY_IMPACT') return vector?.[1] > 0 && session.impact_modified !== true;
  if (action === 'MODIFIED_SESSION_ONLY') return session.explicitly_validated_modified_session !== true;
  return false;
}

function buildSafetyExecutability(container = {}, options = {}) {
  const sessions = sessionsFrom(container);
  const requestedAction = String(options.safety_action ?? options.safetyAction ?? 'NORMAL').toUpperCase();
  const action = SAFETY_ACTIONS.has(requestedAction) ? requestedAction : 'FULL_REST';
  const scopedActionRaw = options.scoped_safety_action ?? options.scopedSafetyAction
    ?? options.safety_scope?.action ?? options.safetyScope?.action;
  const scopedAction = String(scopedActionRaw || '').toUpperCase();
  const enforcementAction = action === 'PROFESSIONAL_ASSESSMENT_RECOMMENDED'
    ? (SAFETY_ACTIONS.has(scopedAction) && scopedAction !== 'PROFESSIONAL_ASSESSMENT_RECOMMENDED'
      ? scopedAction : 'FULL_REST')
    : action;
  const rawScopeInput = options.safety_scope ?? options.safetyScope;
  // Legacy safety_scope is a closed list of affected modality strings paired
  // with the global safety action. C3 structured scopes are objects with
  // explicit dates, evidence, expiry, and action; preserve the legacy path.
  const rawScopes = Array.isArray(rawScopeInput)
    ? rawScopeInput.filter((scope) => scope && typeof scope === 'object' && !Array.isArray(scope))
    : rawScopeInput && typeof rawScopeInput === 'object' ? [rawScopeInput] : [];
  const normalizedScopes = rawScopes.map(normalizeScope);
  const invalidScope = normalizedScopes.some((scope) => !scope || !SAFETY_ACTIONS.has(scope.action));
  const scopes = normalizedScopes.filter((scope) => scope && SAFETY_ACTIONS.has(scope.action));
  const safetyStateRevision = Number(options.safety_state_revision ?? options.safetyStateRevision
    ?? options.athlete_state_revision ?? options.athleteStateRevision ?? 0);
  const evaluatedSessions = sessions.map((session, index) => {
    const localDate = sessionLocalDate(session);
    const activeScopes = scopes.filter((scope) => {
      const expiryDate = scope.expires_on_local;
      return !localDate || (localDate >= scope.effective_from_local && expiryDate && localDate < expiryDate);
    });
    const blockingScopes = activeScopes.filter((scope) => safetyBlocksSession(scope.action, session))
      .sort((left, right) => left.action.localeCompare(right.action) || left.scope_hash.localeCompare(right.scope_hash));
    const globalBlocked = safetyBlocksSession(enforcementAction, session);
    const blocked = invalidScope || globalBlocked || blockingScopes.length > 0;
    const reasonCode = invalidScope ? 'SAFETY_SCOPE_INVALID'
      : globalBlocked ? enforcementAction : blockingScopes[0]?.action ?? null;
    const surfaceExecutability = Object.fromEntries(EXECUTABLE_SURFACES.map((surface) => [surface, !blocked]));
    return {
      session_id: sessionId(session, index),
      workout_family: sessionFamily(session),
      executable: !blocked,
      reason_code: reasonCode,
      safety_action: action,
      enforcement_action: reasonCode || enforcementAction,
      applied_scope_hashes: activeScopes.map((scope) => scope.scope_hash).sort(),
      safety_state_revision: safetyStateRevision,
      surface_executability: surfaceExecutability,
    };
  });
  const allBlocked = invalidScope || enforcementAction === 'FULL_REST'
    || (evaluatedSessions.length > 0 && !evaluatedSessions.some((session) => session.executable));
  return deepFreeze({
    safety_action: action,
    enforcement_action: enforcementAction,
    safety_state_revision: safetyStateRevision,
    supersedes_safety_state_revision: options.supersedes_safety_state_revision
      ?? options.supersedesSafetyStateRevision ?? null,
    resolution_evidence_ids: clone(options.resolution_evidence_ids || options.resolutionEvidenceIds || []),
    advisory_flags: action === 'PROFESSIONAL_ASSESSMENT_RECOMMENDED'
      ? ['PROFESSIONAL_ASSESSMENT_RECOMMENDED'] : [],
    safety_scope_state: invalidScope ? 'INVALID_FAIL_CLOSED'
      : scopes.length ? 'BOUNDED' : 'NONE',
    safety_scope_hashes: scopes.map((scope) => scope.scope_hash).sort(),
    surface_executability: Object.fromEntries(EXECUTABLE_SURFACES.map((surface) => [surface, !allBlocked])),
    sessions: evaluatedSessions,
  });
}

function validateSafety(sessions, options) {
  const executability = buildSafetyExecutability(sessions, options);
  const violations = executability.sessions.filter((session) => !session.executable).map((session) => ({
    code: session.reason_code,
    session_id: session.session_id,
    workout_family: session.workout_family,
    safety_state_revision: session.safety_state_revision,
  }));
  return {
    validator: 'safety',
    valid: violations.length === 0,
    violations,
    reason_codes: [...new Set(violations.map((violation) => violation.code))],
    executability,
  };
}

function validateGoalBackwardAdaptationCandidate(candidate = {}, options = {}) {
  const sessions = sessionsFrom(candidate);
  const interference = validateInterference(sessions, options);
  const workloadEvidence = buildGoalBackwardWorkloadEvidence({
    ...options,
    sessions,
    spacing_valid: interference.valid,
  });
  const results = [
    validateConstraints(sessions, options),
    validateCrossModalCeiling({ ...options, workload_evidence: workloadEvidence }),
    validatePresentationFloor(sessions, options),
    validateSafety(sessions, options),
    interference,
  ];
  return deepFreeze({
    valid: results.every((result) => result.valid),
    validator_results: results,
    workload_evidence: workloadEvidence,
    safety_executability: results.find((result) => result.validator === 'safety')?.executability || null,
    violations: results.flatMap((result) => result.violations || []),
    reason_codes: [...new Set(results.flatMap((result) => result.reason_codes || []))],
  });
}

function validateGoalBackwardCandidate(candidate = {}, options = {}) {
  const sessions = sessionsFrom(candidate);
  const results = [
    validateCandidateSchema(sessions),
    validateCanonicalMaterialization(candidate, sessions),
    validateMaterialReview(candidate, sessions),
    validateMaterialDose(candidate, options),
    validateDevelopmentRoleDose(candidate, options),
    validateCandidateScope(sessions, options),
    validateAvailability(sessions, options),
    validateConstraints(sessions, options),
    validateRoles(sessions, options),
    validateRequiredExposures(sessions, options),
    validateCrossModalCeiling(options),
    validatePresentationFloor(sessions, options),
    validateSafety(sessions, options),
    validateInterference(sessions, options),
  ];
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
  const directRaw = session.running_distance_m ?? session.distance_m ?? session.distanceMeters;
  const direct = directRaw === null || directRaw === undefined || directRaw === '' ? NaN : Number(directRaw);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const canonicalDistances = flattenedCanonicalSteps(session.steps)
    .filter(({ step }) => step.target?.distance_m !== null && step.target?.distance_m !== undefined
      && step.target?.distance_m !== '' && Number.isFinite(Number(step.target.distance_m)))
    .map(({ step, multiplier }) => Number(step.target.distance_m) * multiplier);
  if (canonicalDistances.length) return canonicalDistances.reduce((sum, value) => sum + value, 0);
  if (Number(session.canonical_workout_schema_version) === 1 || session.distance_is_estimate === true) return null;
  const derivedRaw = session.derived_totals?.distance_m;
  const derived = derivedRaw === null || derivedRaw === undefined || derivedRaw === '' ? NaN : Number(derivedRaw);
  if (Number.isFinite(derived) && derived >= 0) return derived;
  const milesRaw = session.distance_miles ?? session.distanceMiles;
  const miles = milesRaw === null || milesRaw === undefined || milesRaw === '' ? NaN : Number(milesRaw);
  return Number.isFinite(miles) && miles >= 0 ? miles * 1609.344 : null;
}

function runningDistanceMeters(session) {
  const family = sessionFamily(session);
  if (!RUNNING_FAMILIES.has(family)) return 0;
  if (COMPROMISED_FAMILIES.has(family)) {
    const directRaw = session.running_distance_m;
    const direct = directRaw === null || directRaw === undefined || directRaw === ''
      ? NaN : Number(directRaw);
    if (Number.isFinite(direct) && direct >= 0) return direct;
    const canonicalRunningDistances = flattenedCanonicalSteps(session.steps)
      .filter(({ step }) => ['run', 'interval'].includes(step.type))
      .map(({ step, multiplier }) => Number(step.target?.distance_m) * multiplier)
      .filter((value) => Number.isFinite(value) && value >= 0);
    if (canonicalRunningDistances.length) {
      return canonicalRunningDistances.reduce((sum, value) => sum + value, 0);
    }
  }
  return distanceMeters(session);
}

function aggregateKnownRunningDistance(sessions) {
  const values = sessions.filter((session) => RUNNING_FAMILIES.has(sessionFamily(session))).map(runningDistanceMeters);
  if (values.some((value) => value === null)) return null;
  return values.reduce((sum, value) => sum + value, 0);
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
    const raw = session[name];
    if (raw === null || raw === undefined || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function flattenedCanonicalSteps(steps = [], multiplier = 1, output = []) {
  for (const step of Array.isArray(steps) ? steps : []) {
    if (!step || typeof step !== 'object') continue;
    if (step.type === 'repeat') {
      const count = Number.isSafeInteger(step.repeat_count) && step.repeat_count > 0 ? step.repeat_count : 0;
      flattenedCanonicalSteps(step.children, multiplier * count, output);
    } else {
      output.push({ step, multiplier });
    }
  }
  return output;
}

function sortedCanonicalTargetValues(session, field) {
  const values = [];
  for (const { step, multiplier } of flattenedCanonicalSteps(session.steps)) {
    const value = step.target?.[field];
    if (value && typeof value === 'object' && value.minimum !== null && value.minimum !== undefined
      && value.maximum !== null && value.maximum !== undefined
      && Number.isFinite(Number(value.minimum)) && Number.isFinite(Number(value.maximum))) {
      values.push(Number(value.minimum), Number(value.maximum));
    } else if (value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))) {
      values.push(Number(value) * (['repetitions', 'sets'].includes(field) ? multiplier : 1));
    }
  }
  return values.sort((left, right) => left - right);
}

function canonicalPaceValues(session) {
  const nested = sortedCanonicalTargetValues(session, 'pace_range_s_per_km');
  if (nested.length) return nested;
  const perKm = numericField(session, ['target_pace_s_per_km', 'target_pace_seconds_per_km']);
  if (perKm !== null) return [perKm];
  const perMile = numericField(session, ['goal_pace_seconds_per_mile']);
  return perMile === null ? [] : [perMile / 1.609344];
}

function canonicalHeartRateValues(session) {
  return sortedCanonicalTargetValues(session, 'heart_rate_range_bpm');
}

function zoneNumbers(session) {
  const direct = numericField(session, ['target_zone_number', 'hr_zone']);
  if (direct !== null) return [direct];
  const raw = String(session.target_zone || '');
  return [...raw.matchAll(/\b(?:zone\s*)?(\d+(?:\.\d+)?)\b/gi)].map((match) => Number(match[1]));
}

function targetArrayMateriallyChanged(before, after, threshold, { additionIsMaterial = true } = {}) {
  if (!before.length && !after.length) return false;
  if (!before.length || !after.length || before.length !== after.length) return additionIsMaterial;
  return before.some((value, index) => (
    value !== after[index] && (value === 0 || relativeDelta(value, after[index]) > threshold + 1e-12)
  ));
}

function canonicalDosageMetric(session, field) {
  if (field === 'work_duration_s') {
    const raw = session.derived_totals?.work_duration_s;
    const canonical = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
    if (Number.isFinite(canonical)) return canonical;
    return numericField(session, ['work_duration_s', 'work_duration_seconds']);
  }
  if (field === 'repetitions') {
    const raw = session.derived_totals?.repetitions;
    const canonical = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
    if (Number.isFinite(canonical)) return canonical;
    return numericField(session, ['repetitions', 'reps']);
  }
  if (field === 'station_distance_m') {
    const raw = session.derived_totals?.station_distance_m;
    const canonical = raw === null || raw === undefined || raw === '' ? NaN : Number(raw);
    if (Number.isFinite(canonical)) return canonical;
    return numericField(session, ['station_distance_m']);
  }
  if (field === 'station_repetitions') {
    const values = flattenedCanonicalSteps(session.steps)
      .filter(({ step }) => step.type === 'station')
      .filter(({ step }) => step.target?.repetitions !== null && step.target?.repetitions !== undefined
        && step.target?.repetitions !== '' && Number.isFinite(Number(step.target.repetitions)))
      .map(({ step, multiplier }) => Number(step.target.repetitions) * multiplier);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : numericField(session, ['station_repetitions']);
  }
  if (field === 'load_kg') {
    const values = sortedCanonicalTargetValues(session, 'load_kg');
    return values.length ? Math.max(...values) : numericField(session, ['load_kg']);
  }
  return null;
}

function canonicalStrengthHardSets(session) {
  const values = flattenedCanonicalSteps(session.steps)
    .filter(({ step }) => step.type === 'strength_exercise')
    .filter(({ step }) => step.target?.sets !== null && step.target?.sets !== undefined
      && step.target?.sets !== '' && Number.isFinite(Number(step.target.sets)))
    .map(({ step, multiplier }) => Number(step.target.sets) * multiplier);
  return values.length ? values.reduce((sum, value) => sum + value, 0)
    : numericField(session, ['strength_hard_sets', 'hard_sets']);
}

function stressVectorForMaterial(session) {
  if (Array.isArray(session.stress_vector) && session.stress_vector.length === DIMENSIONS.length
    && session.stress_vector.every((value) => value !== null && value !== undefined && value !== ''
      && Number.isFinite(Number(value)))) return session.stress_vector.map(Number);
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
  if (targetArrayMateriallyChanged(
    canonicalPaceValues(baseline),
    canonicalPaceValues(candidate),
    GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.pace_percentage_strictly_greater_than,
  )) {
    changes.push({ code: 'TARGET_PACE_CHANGED', session_id: sessionId(candidate) });
  }
  const baselineZone = zoneNumbers(baseline);
  const candidateZone = zoneNumbers(candidate);
  if ((baselineZone.length || candidateZone.length) && (
    baselineZone.length !== candidateZone.length
    || baselineZone.some((value, index) => Math.abs(candidateZone[index] - value) >= 1)
  )) {
    changes.push({ code: 'TARGET_ZONE_CHANGED', session_id: sessionId(candidate) });
  }
  if (targetArrayMateriallyChanged(
    canonicalHeartRateValues(baseline),
    canonicalHeartRateValues(candidate),
    GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.pace_percentage_strictly_greater_than,
  )) {
    changes.push({ code: 'TARGET_HEART_RATE_CHANGED', session_id: sessionId(candidate) });
  }
  const structuralFields = ['work_duration_s', 'repetitions', 'station_distance_m', 'station_repetitions', 'load_kg'];
  for (const field of structuralFields) {
    const before = canonicalDosageMetric(baseline, field);
    const after = canonicalDosageMetric(candidate, field);
    if (before === after) continue;
    if (before === null || after === null || before === 0
      || relativeDelta(before, after) >= GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.interval_station_load_percentage) {
      changes.push({ code: 'SESSION_DOSAGE_CHANGED', session_id: sessionId(candidate), field });
    }
  }
  const baselineSets = canonicalStrengthHardSets(baseline);
  const candidateSets = canonicalStrengthHardSets(candidate);
  if (baselineSets !== candidateSets && (
    baselineSets === null || candidateSets === null
    || relativeDelta(baselineSets, candidateSets) >= GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.strength_hard_sets.percentage
    || Math.abs(candidateSets - baselineSets) >= GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.strength_hard_sets.absolute
  )) {
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
    const initialSessions = sessionsFrom(candidate);
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
      auto_apply_allowed: false,
      initial_review_items: initialSessions.map((session, index) => ({
        review_kind: 'INITIAL_PLAN_SESSION',
        material_change: false,
        session_id: sessionId(session, index),
        scheduled_local_date: sessionLocalDate(session),
        role: sessionRole(session),
        workout_family: sessionFamily(session),
      })),
    });
  }
  const baselineSessions = sessionsFrom(baseline);
  const candidateSessions = sessionsFrom(candidate);
  const changes = [];
  const baselineRunning = aggregateKnownRunningDistance(baselineSessions);
  const candidateRunning = aggregateKnownRunningDistance(candidateSessions);
  const weeklyDelta = relativeDelta(baselineRunning, candidateRunning);
  const weeklyAbsolute = baselineRunning === null || candidateRunning === null
    ? null : Math.abs(candidateRunning - baselineRunning);
  if (weeklyDelta !== null
    && weeklyDelta >= GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.weekly_running.percentage
    && weeklyAbsolute >= GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.weekly_running.absolute_m) {
    changes.push({ code: 'WEEKLY_RUNNING_VOLUME', baseline_m: baselineRunning, candidate_m: candidateRunning });
  } else if (baselineRunning !== null && candidateRunning !== null && weeklyDelta === null
    && weeklyAbsolute >= GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.weekly_running.absolute_m) {
    changes.push({ code: 'WEEKLY_RUNNING_VOLUME', baseline_m: baselineRunning, candidate_m: candidateRunning });
  } else if ((baselineRunning === null) !== (candidateRunning === null)) {
    changes.push({ code: 'WEEKLY_RUNNING_VOLUME_STATE_CHANGED', baseline_m: baselineRunning, candidate_m: candidateRunning });
  }
  const longest = (sessions) => {
    const values = sessions.filter((session) => sessionFamily(session) === 'long_aerobic').map(distanceMeters);
    if (!values.length) return 0;
    if (values.some((value) => value === null)) return null;
    return Math.max(...values);
  };
  const baselineLong = longest(baselineSessions);
  const candidateLong = longest(candidateSessions);
  const longDelta = relativeDelta(baselineLong, candidateLong);
  if (longDelta !== null
    && longDelta >= GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.long_run.percentage
    && Math.abs(candidateLong - baselineLong) >= GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.long_run.absolute_m) {
    changes.push({ code: 'LONG_RUN_VOLUME', baseline_m: baselineLong, candidate_m: candidateLong });
  } else if (baselineLong !== null && candidateLong !== null && longDelta === null
    && Math.abs(candidateLong - baselineLong) >= GOAL_BACKWARD_PLANNING_POLICY_V1.material_change.long_run.absolute_m) {
    changes.push({ code: 'LONG_RUN_VOLUME', baseline_m: baselineLong, candidate_m: candidateLong });
  } else if ((baselineLong === null) !== (candidateLong === null)) {
    changes.push({ code: 'LONG_RUN_VOLUME_STATE_CHANGED', baseline_m: baselineLong, candidate_m: candidateLong });
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
  const safetyExecutability = (plan) => {
    const scope = plan?.safety_scope;
    if (scope && typeof scope === 'object' && !Array.isArray(scope) && typeof scope.executable === 'boolean') {
      return scope.executable;
    }
    const value = plan?.executability ?? scope?.executability ?? plan?.safety_action;
    return value === undefined || value === null ? null : String(value);
  };
  const baselineSafety = safetyExecutability(baseline);
  const candidateSafety = safetyExecutability(candidate);
  if (baselineSafety !== candidateSafety && baselineSafety !== null && candidateSafety !== null) {
    changes.push({ code: 'SAFETY_SCOPE_CHANGED' });
  }
  const uniqueChanges = [...new Map(changes.map((change) => [
    [change.code, change.session_id, change.field].join(':'), change,
  ])).values()];
  const decisiveEvidenceIds = [...new Set((input.decisive_evidence_ids
    ?? candidate.decisive_evidence_ids
    ?? candidate.evidence_used
    ?? []).map(String).filter(Boolean))].sort();
  const baselineRevision = baseline.plan_revision ?? baseline.planRevision ?? null;
  const candidateRevision = candidate.plan_revision ?? candidate.planRevision ?? null;
  const sessionBinding = (session, { absentState }) => {
    if (!session) return {
      binding_state: absentState,
      session_revision: null,
      session_content_hash: null,
    };
    const canonical = Number(session.canonical_workout_schema_version) === 1
      && Number.isSafeInteger(session.session_revision) && session.session_revision >= 1
      && /^[a-f0-9]{64}$/.test(String(session.content_hash || ''));
    return {
      binding_state: canonical ? 'CANONICAL' : 'LEGACY_PLAN_REVISION',
      session_revision: canonical ? session.session_revision : null,
      session_content_hash: canonical ? session.content_hash : null,
    };
  };
  const baselineSessionBindings = baselineSessions.map((session, index) => ({
    session_id: sessionId(session, index),
    ...sessionBinding(session, { absentState: 'NOT_APPLICABLE' }),
  }));
  const reviewItems = uniqueChanges.map((change) => {
    const baselineSession = change.session_id
      ? baselineSessions.find((session, index) => sessionId(session, index) === String(change.session_id))
      : null;
    const candidateSession = change.session_id
      ? candidateSessions.find((session, index) => sessionId(session, index) === String(change.session_id))
      : null;
    const baselineBinding = change.session_id
      ? sessionBinding(baselineSession, { absentState: 'NOT_APPLICABLE' })
      : { binding_state: 'PLAN_LEVEL', session_revision: null, session_content_hash: null };
    const candidateBinding = change.session_id
      ? sessionBinding(candidateSession, { absentState: 'REMOVED' })
      : { binding_state: 'PLAN_LEVEL', session_revision: null, session_content_hash: null };
    return {
      ...change,
      review_required: true,
      reason_code: input.material_reason_code || 'MATERIAL_CHANGE_REVIEW_REQUIRED',
      decisive_evidence_ids: decisiveEvidenceIds,
      baseline_plan_revision: baselineRevision,
      candidate_plan_revision: candidateRevision,
      baseline_binding_state: baselineBinding.binding_state,
      candidate_binding_state: candidateBinding.binding_state,
      baseline_session_revision: baselineBinding.session_revision,
      candidate_session_revision: candidateBinding.session_revision,
      baseline_session_content_hash: baselineBinding.session_content_hash,
      candidate_session_content_hash: candidateBinding.session_content_hash,
      decision_id: input.decision_id ?? candidateSession?.decision_id ?? null,
      candidate_hash: input.candidate_hash ?? null,
      canonical_session_set_hash: input.canonical_session_set_hash ?? null,
    };
  });
  const activeHash = canonicalPrescriptionHash(baseline);
  const material = reviewItems.length > 0;
  return deepFreeze({
    material_change_baseline: {
      plan_revision: baselineRevision,
      source: 'ACTIVE_APPLIED_PLAN',
    },
    baseline_source: 'ACTIVE_APPLIED_PLAN',
    baseline_plan_revision: baselineRevision,
    candidate_plan_revision: candidateRevision,
    material_change: material,
    preview_required: material,
    review_required: material,
    initial_plan_review: false,
    change_label: material ? 'material_change' : 'minor_or_no_change',
    prescription_hash_changed: activeHash !== candidateHash,
    active_prescription_hash: activeHash,
    candidate_prescription_hash: candidateHash,
    baseline_session_bindings: baselineSessionBindings,
    changes: reviewItems,
    material_review_items: reviewItems,
    review_contract_complete: !material || (
      decisiveEvidenceIds.length > 0 && baselineRevision !== null && candidateRevision !== null
      && (input.require_canonical_bindings !== true || (
        typeof input.decision_id === 'string' && input.decision_id.length > 0
        && /^[a-f0-9]{64}$/.test(String(input.candidate_hash || ''))
        && /^[a-f0-9]{64}$/.test(String(input.canonical_session_set_hash || ''))
      ))
    ),
    auto_apply_allowed: false,
    reason_codes: material ? ['MATERIAL_CHANGE_REVIEW_REQUIRED'] : [],
  });
}

module.exports = {
  HARD_VALIDATOR_NAMES,
  buildSafetyExecutability,
  canonicalPrescriptionHash,
  classifyInterferencePredicates,
  compareMaterialChange,
  validateGoalBackwardCandidate,
  validateGoalBackwardAdaptationCandidate,
  validateInterference,
  validatePartialRaceOrderClusterExposure,
  validatePresentationFloor,
};
