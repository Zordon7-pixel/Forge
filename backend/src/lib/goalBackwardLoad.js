const {
  GOAL_BACKWARD_PLANNING_POLICY_V1,
  STRESS_TAXONOMY_V1,
  addDays,
  daysBetween,
  eventPolicyFor,
} = require('./racePlanPolicy');

const DIMENSIONS = STRESS_TAXONOMY_V1.dimensions;
const DIMENSION_COUNT = DIMENSIONS.length;
const HARD_DAY_DIMENSION_INDEXES = Object.freeze([1, 2, 5, 6, 7]);
const NON_CONTRIBUTING_ASSESSMENT_FAMILIES = new Set(['rest', 'mobility', 'manual_recovery']);
const EXCLUDED_ASSESSMENT_STEP_ROLES = new Set(STRESS_TAXONOMY_V1.assessment.excluded_step_roles);
const REQUIRED_RUNNING_RANGES = Object.freeze([
  'recent_normal_range',
  'safe_forward_range',
  'goal_backward_range',
]);

function zeroVector() {
  return Array(DIMENSION_COUNT).fill(0);
}

function canonicalNonnegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function canonicalFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizedLocalDate(value) {
  const raw = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T12:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw ? null : raw;
}

function familyAndOptions(workoutFamily, options) {
  if (!workoutFamily || typeof workoutFamily !== 'object' || Array.isArray(workoutFamily)) {
    return { family: workoutFamily, options };
  }
  return {
    family: workoutFamily.workout_family ?? workoutFamily.workoutFamily ?? workoutFamily.family,
    options: { ...workoutFamily, ...options },
  };
}

function assessmentContributors(options = {}) {
  const source = options.contributing_work_families ?? options.contributingWorkFamilies;
  return Array.isArray(source) ? source : [];
}

function contributorVector(contributor, assessmentOptions) {
  if (typeof contributor === 'string') {
    if (NON_CONTRIBUTING_ASSESSMENT_FAMILIES.has(contributor)) return { excluded: true };
    const vector = resolveStressVector(contributor, assessmentOptions);
    return vector ? { vector } : { invalid: true };
  }
  if (!contributor || typeof contributor !== 'object' || Array.isArray(contributor)) return { invalid: true };
  const role = String(contributor.step_role ?? contributor.stepRole ?? contributor.role ?? '').toUpperCase();
  if (EXCLUDED_ASSESSMENT_STEP_ROLES.has(role)) return { excluded: true };
  const family = contributor.workout_family ?? contributor.workoutFamily ?? contributor.family;
  if (NON_CONTRIBUTING_ASSESSMENT_FAMILIES.has(family)) return { excluded: true };
  const vector = resolveStressVector(family, { ...assessmentOptions, ...contributor });
  return vector ? { vector } : { invalid: true };
}

function resolveStressVector(workoutFamily, options = {}) {
  const normalized = familyAndOptions(workoutFamily, options);
  const family = normalized.family;
  const context = normalized.options;
  if (typeof family !== 'string' || !family || family.trim() !== family) return null;
  const baseline = STRESS_TAXONOMY_V1.family_vectors[family];
  if (baseline) return [...baseline];
  if (family === 'race') {
    const eventKind = String(context.event_kind ?? context.eventKind ?? '').toUpperCase();
    if (eventKind === 'HYROX_SINGLES' || eventKind === 'HYROX_DOUBLES') {
      return [...STRESS_TAXONOMY_V1.race_vectors.hyrox];
    }
    if (!eventKind || ['ROAD_SHORT', 'ROAD_ENDURANCE', 'MARATHON'].includes(eventKind)) {
      return [...STRESS_TAXONOMY_V1.race_vectors.road];
    }
    return null;
  }
  if (family !== 'assessment') return null;
  const contributors = assessmentContributors(context);
  if (!contributors.length) return null;
  const resolved = [];
  for (const contributor of contributors) {
    const result = contributorVector(contributor, context);
    if (result.invalid) return null;
    if (result.vector) resolved.push(result.vector);
  }
  if (!resolved.length) return null;
  const vector = DIMENSIONS.map((_, index) => Math.max(...resolved.map((entry) => entry[index])));
  vector[DIMENSIONS.indexOf('event_specific_fatigue')] = Math.max(
    vector[DIMENSIONS.indexOf('event_specific_fatigue')],
    STRESS_TAXONOMY_V1.assessment.event_specific_fatigue_floor
  );
  return vector;
}

function resolveSessionStress(session = {}, index = 0) {
  const source = session && typeof session === 'object' && !Array.isArray(session) ? session : {};
  const family = sessionFamily(source);
  const vector = resolveStressVector(family, {
    event_kind: source.event_kind ?? source.eventKind,
    contributing_work_families: source.contributing_work_families ?? source.contributingWorkFamilies,
  });
  const resolved = {
    session_id: String(source.session_id ?? source.sessionId ?? source.id ?? `session-${index + 1}`),
    workout_family: family ?? null,
    vector,
  };
  return vector
    ? { valid: true, ...resolved }
    : {
      valid: false,
      ...resolved,
      violation: {
        code: 'WORKOUT_FAMILY_UNRESOLVED',
        session_id: resolved.session_id,
        workout_family: resolved.workout_family,
      },
    };
}

function sessionFamily(session = {}) {
  return session.workout_family ?? session.workoutFamily ?? session.family;
}

function sessionDate(session = {}) {
  return normalizedLocalDate(
    session.scheduled_local_date ?? session.scheduledLocalDate ?? session.local_date ?? session.date
  );
}

function resolveSession(session = {}, index = 0) {
  const source = session && typeof session === 'object' && !Array.isArray(session) ? session : {};
  const family = sessionFamily(source);
  const vector = resolveStressVector(family, {
    event_kind: source.event_kind ?? source.eventKind,
    contributing_work_families: source.contributing_work_families ?? source.contributingWorkFamilies,
  });
  const date = sessionDate(source);
  const sessionId = String(source.session_id ?? source.sessionId ?? source.id ?? `session-${index + 1}`);
  if (!date) {
    return {
      valid: false,
      violation: { code: 'SESSION_DATE_INVALID', session_id: sessionId },
    };
  }
  if (!vector) {
    return {
      valid: false,
      violation: { code: 'WORKOUT_FAMILY_UNRESOLVED', session_id: sessionId, workout_family: family ?? null },
    };
  }
  return {
    valid: true,
    session: {
      session_id: sessionId,
      scheduled_local_date: date,
      workout_family: family,
      vector,
    },
  };
}

function aggregateWeeklyStress(sessions = []) {
  const source = Array.isArray(sessions) ? sessions : [];
  const resolved = source.map(resolveSession);
  const violations = resolved.filter((entry) => !entry.valid).map((entry) => entry.violation);
  if (!Array.isArray(sessions)) violations.push({ code: 'INVALID_SESSION_COLLECTION' });
  const grouped = new Map();
  for (const entry of resolved) {
    if (!entry.valid) continue;
    const date = entry.session.scheduled_local_date;
    if (!grouped.has(date)) grouped.set(date, []);
    grouped.get(date).push(entry.session);
  }
  const days = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, daySessions]) => {
    const rawDimensionSum = zeroVector();
    const qualifyingCount = zeroVector();
    const maximumVector = zeroVector();
    for (const session of daySessions) {
      session.vector.forEach((value, index) => {
        rawDimensionSum[index] += value;
        if (value >= 2) qualifyingCount[index] += 1;
        maximumVector[index] = Math.max(maximumVector[index], value);
      });
    }
    const stackSurcharge = qualifyingCount.map((count) => (count >= 2 ? 1 : 0));
    const dailyDimensionClassification = maximumVector.map((value, index) => (
      Math.min(4, value + stackSurcharge[index])
    ));
    return {
      scheduled_local_date: date,
      sessions: daySessions,
      raw_dimension_sum: rawDimensionSum,
      qualifying_count: qualifyingCount,
      stack_surcharge: stackSurcharge,
      daily_dimension_classification: dailyDimensionClassification,
      hard_day: HARD_DAY_DIMENSION_INDEXES.some((index) => dailyDimensionClassification[index] >= 3),
      very_high_day: HARD_DAY_DIMENSION_INDEXES.some((index) => dailyDimensionClassification[index] === 4),
    };
  });
  const weeklyDimensionSum = zeroVector();
  for (const day of days) {
    weeklyDimensionSum.forEach((_, index) => {
      weeklyDimensionSum[index] += day.raw_dimension_sum[index] + day.stack_surcharge[index];
    });
  }
  return {
    valid: violations.length === 0,
    stress_taxonomy_version: STRESS_TAXONOMY_V1.stress_taxonomy_version,
    dimensions: [...DIMENSIONS],
    days,
    weekly_dimension_sum: weeklyDimensionSum,
    violations,
    reason_codes: [...new Set(violations.map((violation) => (
      violation.code === 'WORKOUT_FAMILY_UNRESOLVED' ? 'WORKOUT_FAMILY_UNRESOLVED' : 'CROSS_MODAL_FATIGUE_LIMIT'
    )))],
  };
}

function integerMedian(values = []) {
  if (!Array.isArray(values)) return null;
  const sorted = values.map(canonicalNonnegativeInteger).filter((value) => value !== null)
    .sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.ceil((sorted[middle - 1] + sorted[middle]) / 2);
}

function fallbackVector(options = {}) {
  const policy = GOAL_BACKWARD_PLANNING_POLICY_V1.fatigue_budget.training_class_fallback;
  const trainingAge = String(options.training_age_class ?? options.trainingAgeClass ?? '').toUpperCase();
  const consistency = String(options.consistency_state ?? options.consistencyState ?? '').toUpperCase();
  if (trainingAge === 'DEVELOPING' && !['RETURNING', 'SPARSE_DATA'].includes(consistency)) {
    return policy.developing;
  }
  if (['ESTABLISHED', 'ADVANCED'].includes(trainingAge) && !['RETURNING', 'SPARSE_DATA'].includes(consistency)) {
    return policy.established_advanced;
  }
  return policy.beginner_returning_sparse;
}

function dimensionHistory(history, dimension) {
  const source = history?.dimensions && typeof history.dimensions === 'object' ? history.dimensions : history;
  const entry = source && typeof source === 'object' ? source[dimension] : null;
  if (Array.isArray(entry)) {
    const values = entry.map(canonicalNonnegativeInteger).filter((value) => value !== null);
    return { values, eligibleWeekCount: values.length, median: integerMedian(values) };
  }
  if (!entry || typeof entry !== 'object') return { values: [], eligibleWeekCount: 0, median: null };
  const coverageState = entry.coverage_state ?? entry.quality_state;
  const suppliedStatus = String(entry.status || '').toUpperCase() || null;
  if ((coverageState !== undefined && coverageState !== 'COMPLETE') || suppliedStatus === 'INSUFFICIENT') {
    return {
      values: [],
      eligibleWeekCount: 0,
      median: null,
      status: null,
      confidence: 'INSUFFICIENT',
      coverageState,
    };
  }
  const valuesSource = entry.eligible_sums ?? entry.weekly_sums ?? entry.values;
  const values = Array.isArray(valuesSource)
    ? valuesSource.map(canonicalNonnegativeInteger).filter((value) => value !== null)
    : [];
  const idCount = Array.isArray(entry.eligible_week_ids) ? entry.eligible_week_ids.length : null;
  const suppliedCount = canonicalNonnegativeInteger(entry.eligible_week_count);
  const eligibleWeekCount = values.length || (suppliedCount !== null
    ? suppliedCount
    : idCount ?? 0);
  const suppliedMedian = canonicalNonnegativeInteger(entry.integer_median_sum ?? entry.median_sum);
  return {
    values,
    eligibleWeekCount,
    median: values.length ? integerMedian(values) : suppliedMedian !== null
      ? suppliedMedian
      : null,
    status: suppliedStatus,
    confidence: String(entry.confidence || '').toUpperCase() || null,
    coverageState,
  };
}

function resolvedEventPolicy(input) {
  if (!input) return null;
  return eventPolicyFor(input);
}

function overloadGatesPass(options, policy) {
  return Boolean(
    policy
    && ['HYROX_SINGLES', 'HYROX_DOUBLES'].includes(policy.event_kind)
    && String(options.phase || '').toUpperCase() === 'EVENT_SPECIFIC_DEVELOPMENT'
    && options.mandatory_hyrox_cluster === true
    && ['READY', 'NORMAL'].includes(String(options.recovery_state || '').toUpperCase())
    && options.safety_restriction === false
    && options.previous_two_weeks_passed === true
  );
}

function calculateFatigueCeilings(history = {}, options = {}) {
  const fallback = fallbackVector(options);
  const policy = resolvedEventPolicy(options.event_policy ?? options.eventPolicy);
  const gatesPass = overloadGatesPass(options, policy);
  const dimensions = {};
  const normalCeilingVector = [];
  const authorizedCeilingVector = [];
  for (const [index, dimension] of DIMENSIONS.entries()) {
    const dimensionEvidence = dimensionHistory(history, dimension);
    const count = dimensionEvidence.eligibleWeekCount;
    const usableMedian = count >= 3 ? dimensionEvidence.median : null;
    const trainingGap = dimensionEvidence.status === 'TRAINING_GAP';
    const established = count >= 4 && usableMedian !== null && !trainingGap;
    const provisional = count === 3 && usableMedian !== null && !trainingGap;
    const status = established ? 'ESTABLISHED' : provisional ? 'PROVISIONAL'
      : trainingGap ? 'TRAINING_GAP' : 'INSUFFICIENT';
    const confidence = established ? (count >= 6 ? 'HIGH' : 'MEDIUM')
      : provisional ? 'LOW' : trainingGap ? 'LOW' : 'INSUFFICIENT';
    const normalCeiling = established || provisional
      ? usableMedian + Math.max(
        GOAL_BACKWARD_PLANNING_POLICY_V1.fatigue_budget.minimum_ceiling_increment,
        Math.ceil(GOAL_BACKWARD_PLANNING_POLICY_V1.fatigue_budget.ceiling_growth_fraction * usableMedian)
      )
      : fallback[index];
    const policyAllowance = Number(policy?.overload_allowance_points?.[dimension] || 0);
    const overloadAllowance = established
      && gatesPass
      && policy.overload_dimensions.includes(dimension)
      && Number.isInteger(policyAllowance)
      && policyAllowance > 0
      ? policyAllowance : 0;
    const result = {
      dimension,
      eligible_week_count: count,
      status,
      confidence,
      integer_median_sum: established || provisional ? usableMedian : null,
      normal_ceiling: normalCeiling,
      overload_allowance: overloadAllowance,
      authorized_ceiling: normalCeiling + overloadAllowance,
      ceiling_source: established || provisional ? 'RECENT_NORMAL' : 'TRAINING_CLASS_FALLBACK',
    };
    if (dimensionEvidence.coverageState !== undefined) result.coverage_state = dimensionEvidence.coverageState;
    dimensions[dimension] = result;
    normalCeilingVector.push(result.normal_ceiling);
    authorizedCeilingVector.push(result.authorized_ceiling);
  }
  return {
    planning_policy_version: GOAL_BACKWARD_PLANNING_POLICY_V1.planning_policy_version,
    stress_taxonomy_version: STRESS_TAXONOMY_V1.stress_taxonomy_version,
    dimensions,
    normal_ceiling_vector: normalCeilingVector,
    authorized_ceiling_vector: authorizedCeilingVector,
    overload_authorized: authorizedCeilingVector.some((value, index) => value > normalCeilingVector[index]),
    event_policy_id: policy?.event_policy_id || null,
  };
}

function normalizedWeeklyVector(input) {
  const vector = Array.isArray(input) ? input : input?.weekly_dimension_sum;
  if (!Array.isArray(vector) || vector.length !== DIMENSION_COUNT) return null;
  const normalized = vector.map(canonicalNonnegativeInteger);
  return normalized.every((value) => value !== null) ? normalized : null;
}

function evaluateStressBudget(weeklyStress, ceilings = {}) {
  const weeklyVector = normalizedWeeklyVector(weeklyStress);
  const normal = normalizedWeeklyVector(ceilings.normal_ceiling_vector);
  const authorized = normalizedWeeklyVector(ceilings.authorized_ceiling_vector);
  if (!weeklyVector || !normal || !authorized) {
    return {
      valid: false,
      violations: [{ code: 'CROSS_MODAL_FATIGUE_LIMIT', dimension: null, reason: 'INVALID_STRESS_BUDGET_INPUT' }],
      overload_dimensions_used: [],
      reason_codes: ['CROSS_MODAL_FATIGUE_LIMIT'],
    };
  }
  const violations = [];
  const overloadDimensionsUsed = [];
  DIMENSIONS.forEach((dimension, index) => {
    if (weeklyVector[index] > authorized[index]) {
      violations.push({
        code: 'CROSS_MODAL_FATIGUE_LIMIT',
        dimension,
        weekly_dimension_sum: weeklyVector[index],
        normal_ceiling: normal[index],
        overload_allowance: authorized[index] - normal[index],
        authorized_ceiling: authorized[index],
      });
    } else if (weeklyVector[index] > normal[index]) {
      overloadDimensionsUsed.push(dimension);
    }
  });
  return {
    valid: violations.length === 0,
    violations,
    overload_dimensions_used: overloadDimensionsUsed,
    reason_codes: violations.length
      ? ['CROSS_MODAL_FATIGUE_LIMIT']
      : overloadDimensionsUsed.length ? ['PHASE_SPECIFIC_OVERLOAD'] : [],
  };
}

function isUpperTechniqueThirdDay(day) {
  const classification = day.daily_dimension_classification;
  return classification[1] <= 1
    && classification[2] <= 1
    && (classification[3] >= 3 || day.sessions.every((session) => (
      ['strength_upper', 'mobility', 'manual_recovery'].includes(session.workout_family)
    )));
}

function rollingWindow(days, startDate) {
  return days.filter((day) => {
    const offset = daysBetween(startDate, day.scheduled_local_date);
    return offset !== null && offset >= 0 && offset <= 6;
  });
}

function validateRollingHardDays(sessions = [], options = {}) {
  const aggregate = aggregateWeeklyStress(sessions);
  if (!aggregate.valid) {
    return {
      valid: false,
      days: aggregate.days,
      violations: aggregate.violations,
      reason_codes: aggregate.reason_codes,
    };
  }
  const violations = [];
  const trainingAge = String(options.training_age_class ?? options.trainingAgeClass ?? '').toUpperCase();
  const establishedAdvanced = ['ESTABLISHED', 'ADVANCED'].includes(trainingAge);
  for (const start of aggregate.days.map((day) => day.scheduled_local_date)) {
    const window = rollingWindow(aggregate.days, start);
    const lowerBodyRunningHardDays = window.filter((day) => (
      day.daily_dimension_classification[1] >= 3 || day.daily_dimension_classification[2] >= 3
    ));
    if (lowerBodyRunningHardDays.length > 2) {
      violations.push({
        code: 'ROLLING_LOWER_BODY_HARD_DAY_CAP',
        window_start_local: start,
        window_end_local: addDays(start, 6),
        actual: lowerBodyRunningHardDays.length,
        maximum: 2,
      });
    }
    const hardDays = window.filter((day) => day.hard_day);
    const allowedThird = establishedAdvanced
      && options.spacing_valid === true
      && hardDays.length === 3
      && hardDays.some(isUpperTechniqueThirdDay);
    if (hardDays.length > 2 && !allowedThird) {
      violations.push({
        code: 'ROLLING_TOTAL_HARD_DAY_CAP',
        window_start_local: start,
        window_end_local: addDays(start, 6),
        actual: hardDays.length,
        maximum: establishedAdvanced ? 3 : 2,
      });
    }
    const veryHighEventSessions = window.flatMap((day) => day.sessions).filter((session) => session.vector[7] === 4);
    if (veryHighEventSessions.length > 1) {
      violations.push({
        code: 'ROLLING_VERY_HIGH_EVENT_CAP',
        window_start_local: start,
        window_end_local: addDays(start, 6),
        actual: veryHighEventSessions.length,
        maximum: 1,
      });
    }
  }
  if (options.mandatory_hyrox_cluster === true) {
    for (const day of aggregate.days.filter((entry) => (
      entry.sessions.some((session) => session.workout_family === 'hyrox_station_skill') && entry.hard_day
    ))) {
      violations.push({
        code: 'HYROX_STATION_SKILL_HARD_DAY',
        scheduled_local_date: day.scheduled_local_date,
      });
    }
  }
  const eventDate = normalizedLocalDate(options.event_local_date ?? options.event_date ?? options.race_date);
  if (eventDate) {
    for (const day of aggregate.days) {
      const daysToEvent = daysBetween(day.scheduled_local_date, eventDate);
      const veryHighSessions = day.sessions.filter((session) => session.vector[7] === 4);
      if (veryHighSessions.length && daysToEvent !== null && daysToEvent >= 0 && daysToEvent <= 6) {
        violations.push({
          code: 'VERY_HIGH_RACE_MINUS_SIX',
          scheduled_local_date: day.scheduled_local_date,
          event_local_date: eventDate,
          session_ids: veryHighSessions.map((session) => session.session_id),
        });
      }
    }
  }
  const uniqueViolations = [...new Map(violations.map((violation) => [
    [violation.code, violation.window_start_local, violation.scheduled_local_date].join(':'),
    violation,
  ])).values()];
  return {
    valid: uniqueViolations.length === 0,
    days: aggregate.days,
    violations: uniqueViolations,
    reason_codes: uniqueViolations.length ? ['CROSS_MODAL_FATIGUE_LIMIT'] : [],
  };
}

function invalidRunningIntersection(limitingFactors = [], safeIntersection = null) {
  return {
    valid: false,
    selected_running_m: null,
    safe_intersection: safeIntersection,
    limiting_factors: [...new Set(limitingFactors)],
    reason_codes: ['CROSS_MODAL_FATIGUE_LIMIT'],
  };
}

function selectRunningVolumeIntersection(ranges = {}) {
  if (!ranges || typeof ranges !== 'object' || Array.isArray(ranges)) {
    return invalidRunningIntersection(REQUIRED_RUNNING_RANGES);
  }
  const missing = REQUIRED_RUNNING_RANGES.filter((name) => !ranges[name]);
  if (missing.length) return invalidRunningIntersection(missing);
  const entries = Object.entries(ranges);
  const normalized = [];
  for (const [name, range] of entries) {
    const minimum = canonicalFiniteNumber(range?.minimum_m);
    const maximum = canonicalFiniteNumber(range?.maximum_m);
    if (minimum === null || maximum === null || minimum < 0 || maximum < minimum) {
      return invalidRunningIntersection([name]);
    }
    normalized.push({ name, minimum, maximum });
  }
  const intersectionMinimum = Math.max(...normalized.map((range) => range.minimum));
  const intersectionMaximum = Math.min(...normalized.map((range) => range.maximum));
  const safeIntersection = { minimum_m: intersectionMinimum, maximum_m: intersectionMaximum };
  if (intersectionMinimum > intersectionMaximum) {
    const limiting = normalized.filter((range) => (
      range.minimum === intersectionMinimum || range.maximum === intersectionMaximum
    )).map((range) => range.name);
    return invalidRunningIntersection(limiting, safeIntersection);
  }
  const limitingFactors = normalized.filter((range) => range.maximum === intersectionMaximum)
    .map((range) => range.name);
  return {
    valid: true,
    selected_running_m: Math.floor(intersectionMaximum),
    safe_intersection: safeIntersection,
    limiting_factors: limitingFactors,
    reason_codes: [],
  };
}

function buildGoalBackwardWorkloadEvidence(input = {}) {
  const sessions = Array.isArray(input.sessions) ? input.sessions : [];
  const aggregate = aggregateWeeklyStress(sessions);
  const history = input.cross_modal_recent_normal
    ?? input.recent_normal_by_dimension
    ?? input.history
    ?? {};
  const ceilings = calculateFatigueCeilings(history, input);
  const stressBudget = aggregate.valid
    ? evaluateStressBudget(aggregate.weekly_dimension_sum, ceilings)
    : {
      valid: false,
      violations: aggregate.violations,
      overload_dimensions_used: [],
      reason_codes: aggregate.reason_codes,
    };
  const rollingHardDays = validateRollingHardDays(sessions, input);
  const runningVolume = input.running_volume_ranges
    ? selectRunningVolumeIntersection(input.running_volume_ranges)
    : null;
  const components = [aggregate, stressBudget, rollingHardDays, runningVolume].filter(Boolean);
  return {
    planning_policy_version: GOAL_BACKWARD_PLANNING_POLICY_V1.planning_policy_version,
    stress_taxonomy_version: STRESS_TAXONOMY_V1.stress_taxonomy_version,
    valid: components.every((component) => component.valid),
    weekly_stress: aggregate,
    fatigue_ceilings: ceilings,
    stress_budget: stressBudget,
    rolling_hard_days: rollingHardDays,
    running_volume: runningVolume,
    reason_codes: [...new Set(components.flatMap((component) => component.reason_codes || []))],
  };
}

module.exports = {
  aggregateWeeklyStress,
  buildGoalBackwardWorkloadEvidence,
  calculateFatigueCeilings,
  evaluateStressBudget,
  integerMedian,
  resolveSessionStress,
  resolveStressVector,
  selectRunningVolumeIntersection,
  validateRollingHardDays,
};
