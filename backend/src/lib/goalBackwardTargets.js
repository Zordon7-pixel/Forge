const {
  CONFIDENCE_CLASSES,
  TARGET_CONVERSION_REGISTRY_VERSION,
  TARGET_POLICY_VERSION,
} = require('./goalBackwardContracts');
const {
  TARGET_CONVERSION_REGISTRY_V1,
  TARGET_POLICY_V1,
} = require('./racePlanPolicy');

const CONFIDENCE_SET = new Set(CONFIDENCE_CLASSES);
const HARD_WORK_TARGETS = new Set(['threshold', 'interval', 'compromised']);
const EASY_STEADY_LONG_TARGETS = new Set(['easy', 'recovery', 'steady', 'long_run']);
const VALID_TARGET_TYPES = new Set(Object.keys(TARGET_POLICY_V1.fallback_rpe_ranges));
const FRESHNESS_REJECTIONS = new Set(['STALE', 'EXPIRED']);
const TARGET_TYPE_BY_WORKOUT_FAMILY = Object.freeze({
  recovery_run: 'recovery',
  easy_run: 'easy',
  long_aerobic: 'long_run',
  steady_run: 'steady',
  threshold_run: 'threshold',
  interval_run: 'interval',
  race_rhythm_run: 'race_rhythm',
  assessment: 'interval',
  race: 'race_rhythm',
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function finitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function dateOnly(value) {
  const raw = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const parsed = new Date(`${raw}T12:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw ? null : raw;
}

function ageDays(observation, planningInstant) {
  const observed = Date.parse(observation.observed_at ?? observation.completed_at ?? observation.recorded_at ?? '');
  const observedLocal = dateOnly(observation.observed_local_date ?? observation.local_date ?? observation.date);
  const planning = Date.parse(planningInstant || '');
  if (Number.isFinite(observed) && Number.isFinite(planning)) return Math.floor((planning - observed) / 86400000);
  const planningLocal = dateOnly(planningInstant);
  if (!observedLocal || !planningLocal) return null;
  return Math.floor((Date.parse(`${planningLocal}T12:00:00.000Z`) - Date.parse(`${observedLocal}T12:00:00.000Z`)) / 86400000);
}

function rType7Quantile(values, percentile) {
  if (!Array.isArray(values) || !values.length || typeof percentile !== 'number'
    || !Number.isFinite(percentile) || percentile < 0 || percentile > 1) return null;
  const sorted = values.map(Number).filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length !== values.length || !sorted.length) return null;
  const h = (sorted.length - 1) * percentile;
  const j = Math.floor(h);
  const g = h - j;
  return ((1 - g) * sorted[j]) + (g * sorted[Math.min(j + 1, sorted.length - 1)]);
}

function benchmarkPaceRange(paceSecondsPerKm, targetType) {
  const pace = finitePositive(paceSecondsPerKm);
  const fraction = TARGET_POLICY_V1.benchmark_range_fraction[targetType];
  if (pace === null || typeof fraction !== 'number') return null;
  return {
    minimum: Math.floor(pace * (1 - fraction)),
    maximum: Math.ceil(pace * (1 + fraction)),
  };
}

function levelOneFreshDays(targetType, evidence = {}) {
  if (targetType === 'compromised') return 28;
  if (targetType === 'race_rhythm'
    && (evidence.same_distance_race === true || evidence.evidence_type === 'race_result')) return 180;
  if (HARD_WORK_TARGETS.has(targetType)) return 42;
  return 56;
}

function evidenceConflict(evidence = {}) {
  return evidence.unresolved_conflict === true
    || evidence.conflict === true
    || String(evidence.conflict_state || '').toUpperCase() === 'CONFLICT'
    || String(evidence.quality_state || '').toUpperCase() === 'CONFLICT';
}

function evidenceGate(evidence, options = {}) {
  const reasons = [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { valid: false, reasons: ['MISSING'] };
  }
  if (String(evidence.quality_state || '').toUpperCase() !== 'COMPLETE') reasons.push('QUALITY');
  if (evidenceConflict(evidence)) reasons.push('CONFLICT');
  const freshness = String(evidence.freshness_class ?? evidence.freshness_state ?? '').toUpperCase();
  if (FRESHNESS_REJECTIONS.has(freshness)) reasons.push('STALE');
  const age = ageDays(evidence, options.planning_instant);
  if (age !== null && (age < 0 || (Number.isFinite(options.maximum_age_days) && age > options.maximum_age_days))) {
    reasons.push('STALE');
  }
  const permitted = evidence.permitted_target_types ?? evidence.permitted_targets;
  if (Array.isArray(permitted) && !permitted.includes(options.target_type)) reasons.push('POLICY');
  if (evidence.target_policy_version !== undefined
    && evidence.target_policy_version !== TARGET_POLICY_VERSION) reasons.push('POLICY');
  if (options.reject_environment_override && (
    evidence.environmental_effort_override === true
    || evidence.environment_effort_override === true
    || (evidence.reason_codes || []).includes('ENVIRONMENT_EFFORT_OVERRIDE')
  )) reasons.push('ENVIRONMENT');
  return { valid: reasons.length === 0, reasons: [...new Set(reasons)], age_days: age };
}

function evidenceId(evidence, index = 0) {
  return String(evidence.evidence_id ?? evidence.id ?? `evidence-${index + 1}`);
}

function derivedAt(input) {
  const raw = input.planning_instant;
  return Number.isFinite(Date.parse(raw || '')) ? new Date(raw).toISOString() : '1970-01-01T00:00:00.000Z';
}

function provenance(input, evidenceIds, units, overrides = {}) {
  return {
    source_evidence_ids: evidenceIds,
    derived_athlete_state_field: overrides.derived_athlete_state_field || 'target_authority',
    policy_id: TARGET_POLICY_V1.target_policy_id,
    policy_version: TARGET_POLICY_V1.target_policy_version,
    confidence: CONFIDENCE_SET.has(overrides.confidence) ? overrides.confidence : 'MEDIUM',
    derived_at: derivedAt(input),
    decision_id: String(input.decision_id || 'decision-unknown'),
    canonical_units: units,
    ...overrides,
  };
}

function targetShell(overrides = {}) {
  return {
    duration_s: null,
    repetitions: null,
    pace_range_s_per_km: null,
    reference_pace_range_s_per_km: null,
    heart_rate_range_bpm: null,
    rpe_range: null,
    ...overrides,
  };
}

function targetResult(input, level, target, targetProvenance, reasonCodes = [], authority = null) {
  const pace = target.pace_range_s_per_km;
  return {
    valid: true,
    target_policy_version: TARGET_POLICY_V1.target_policy_version,
    target_conversion_registry_version: TARGET_CONVERSION_REGISTRY_VERSION,
    target_type: input.target_type,
    workout_family: input.workout_family,
    authority_level: level,
    authority: authority || (pace ? 'PACE' : 'EFFORT'),
    target,
    provenance: targetProvenance,
    target_provenance: targetProvenance,
    reason_codes: [...new Set(reasonCodes)],
  };
}

function samePurposeLevelOne(input, diagnostics) {
  const candidates = Array.isArray(input.level_1_evidence) ? input.level_1_evidence : [];
  const valid = candidates.filter((entry) => {
    const gate = evidenceGate(entry, {
      planning_instant: input.planning_instant,
      maximum_age_days: levelOneFreshDays(input.target_type, entry),
      target_type: input.target_type,
    });
    diagnostics.push(...gate.reasons);
    return gate.valid
      && entry.successful === true
      && String(entry.target_type || '') === input.target_type
      && (!input.workout_family || entry.workout_family === input.workout_family)
      && (!input.benchmark_protocol_id || entry.benchmark_protocol_id === input.benchmark_protocol_id)
      && (!input.benchmark_success_criteria_id
        || entry.benchmark_success_criteria_id === input.benchmark_success_criteria_id)
      && finitePositive(entry.pace_s_per_km ?? entry.work_segment_pace_s_per_km) !== null;
  }).sort((left, right) => {
    const dateComparison = String(right.observed_at ?? right.observed_local_date ?? '')
      .localeCompare(String(left.observed_at ?? left.observed_local_date ?? ''));
    return dateComparison || evidenceId(left).localeCompare(evidenceId(right));
  });
  if (!valid.length) return null;
  const selected = valid[0];
  const range = benchmarkPaceRange(
    finitePositive(selected.pace_s_per_km ?? selected.work_segment_pace_s_per_km),
    input.target_type,
  );
  if (!range) return null;
  return targetResult(
    input,
    1,
    targetShell({ pace_range_s_per_km: range }),
    [provenance(input, [evidenceId(selected)], ['s/km'], {
      confidence: selected.confidence || 'HIGH',
      derived_athlete_state_field: 'target_evidence.same_purpose_benchmark',
      benchmark_protocol_id: selected.benchmark_protocol_id,
    })],
  );
}

function workSegmentPaces(session) {
  const direct = session.work_segment_paces_s_per_km;
  if (Array.isArray(direct)) return direct.map(finitePositive).filter((value) => value !== null);
  const segments = session.work_segments ?? session.segments;
  if (Array.isArray(segments)) {
    return segments.filter((segment) => {
      const role = String(segment.step_role ?? segment.role ?? segment.type ?? '').toUpperCase();
      return !['WARMUP', 'COOLDOWN', 'RECOVERY', 'PAUSED', 'FAILED'].includes(role)
        && segment.failed !== true && segment.paused !== true;
    }).map((segment) => finitePositive(segment.pace_s_per_km ?? segment.pace_seconds_per_km))
      .filter((value) => value !== null);
  }
  const single = finitePositive(session.work_segment_pace_s_per_km);
  return single === null ? [] : [single];
}

function comparableFreshDays(targetType) {
  return EASY_STEADY_LONG_TARGETS.has(targetType)
    ? TARGET_POLICY_V1.comparable.easy_steady_long_fresh_days
    : TARGET_POLICY_V1.comparable.hard_work_fresh_days;
}

function surfaceClass(value) {
  const normalized = String(value || '').toLowerCase();
  if (['indoor', 'treadmill'].includes(normalized)) return 'indoor';
  if (['outdoor', 'road', 'track', 'trail'].includes(normalized)) return 'outdoor';
  return null;
}

function comparableLevelTwo(input, diagnostics) {
  const candidates = Array.isArray(input.comparable_sessions) ? input.comparable_sessions : [];
  const eligible = candidates.filter((entry) => {
    const gate = evidenceGate(entry, {
      planning_instant: input.planning_instant,
      maximum_age_days: comparableFreshDays(input.target_type),
      target_type: input.target_type,
      reject_environment_override: true,
    });
    diagnostics.push(...gate.reasons);
    return gate.valid
      && String(entry.target_type || '') === input.target_type
      && entry.workout_family === input.workout_family
      && surfaceClass(entry.surface_class) !== null
      && entry.completed !== false
      && !['FAILED', 'INCOMPLETE', 'PAUSED'].includes(String(entry.completion_state ?? entry.status ?? '').toUpperCase())
      && workSegmentPaces(entry).length > 0;
  });
  const requestedSurface = surfaceClass(input.surface_class);
  let accepted = requestedSurface
    ? eligible.filter((entry) => surfaceClass(entry.surface_class) === requestedSurface)
    : [];
  if (!input.surface_class) {
    const groups = new Map();
    for (const entry of eligible) {
      const classification = surfaceClass(entry.surface_class);
      if (!groups.has(classification)) groups.set(classification, []);
      groups.get(classification).push(entry);
    }
    accepted = [...groups.entries()].sort((left, right) => (
      right[1].length - left[1].length || left[0].localeCompare(right[0])
    ))[0]?.[1] || [];
  }
  const dates = new Set(accepted.map((entry) => dateOnly(
    entry.observed_local_date ?? entry.local_date ?? entry.observed_at ?? entry.completed_at
  )).filter(Boolean));
  if (accepted.length < TARGET_POLICY_V1.comparable.minimum_sessions
    || dates.size < TARGET_POLICY_V1.comparable.minimum_dates) return null;
  const paces = accepted.flatMap(workSegmentPaces);
  const lower = rType7Quantile(paces, TARGET_POLICY_V1.comparable.percentile_lower);
  const upper = rType7Quantile(paces, TARGET_POLICY_V1.comparable.percentile_upper);
  if (lower === null || upper === null) return null;
  const range = { minimum: Math.floor(lower), maximum: Math.ceil(upper) };
  return targetResult(
    input,
    2,
    targetShell({ pace_range_s_per_km: range }),
    [provenance(input, accepted.map(evidenceId).sort(), ['s/km'], {
      confidence: accepted.length >= 6 ? 'HIGH' : 'MEDIUM',
      derived_athlete_state_field: 'completed_sessions.canonical_work_segment_pace',
      estimator: 'R_TYPE_7',
    })],
  );
}

function suppliedPaceRange(evidence = {}) {
  const range = evidence.pace_range_s_per_km;
  const minimum = Number(range?.minimum);
  const maximum = Number(range?.maximum);
  return Number.isSafeInteger(minimum) && Number.isSafeInteger(maximum) && minimum > 0 && maximum >= minimum
    ? { minimum, maximum }
    : null;
}

function freshThresholdLevelThree(input, diagnostics) {
  if (input.target_type !== 'threshold') return null;
  const candidates = Array.isArray(input.threshold_evidence)
    ? input.threshold_evidence
    : Array.isArray(input.level_3_evidence) ? input.level_3_evidence : [];
  const accepted = candidates.filter((entry) => {
    const gate = evidenceGate(entry, {
      planning_instant: input.planning_instant,
      maximum_age_days: 42,
      target_type: 'threshold',
    });
    diagnostics.push(...gate.reasons);
    return gate.valid && String(entry.target_type || 'threshold') === 'threshold'
      && suppliedPaceRange(entry) !== null;
  }).sort((left, right) => String(right.observed_at || '').localeCompare(String(left.observed_at || '')));
  if (!accepted.length) return null;
  const selected = accepted[0];
  return targetResult(
    input,
    3,
    targetShell({ pace_range_s_per_km: suppliedPaceRange(selected) }),
    [provenance(input, [evidenceId(selected)], ['s/km'], {
      confidence: selected.confidence || 'MEDIUM',
      derived_athlete_state_field: 'threshold_evidence.canonical_pace_range',
      derivation: 'fresh-threshold-direct-v1',
    })],
  );
}

function convertNearbyRoadRace(input = {}) {
  const sourceDistance = finitePositive(input.source_distance_m);
  const targetDistance = finitePositive(input.target_distance_m);
  const sourceDuration = finitePositive(input.source_duration_s);
  if (sourceDistance === null || targetDistance === null || sourceDuration === null
    || input.comparable_course_surface !== true) return null;
  const ratio = targetDistance / sourceDistance;
  const registry = TARGET_CONVERSION_REGISTRY_V1;
  if (ratio < registry.distance_ratio.minimum || ratio > registry.distance_ratio.maximum
    || sourceDuration < registry.source_duration_seconds.minimum
    || sourceDuration > registry.source_duration_seconds.maximum) return null;
  const rawTargetDuration = sourceDuration * (ratio ** registry.exponent);
  return deepFreeze({
    conversion_id: registry.conversion_id,
    target_conversion_registry_version: registry.target_conversion_registry_version,
    label: registry.label,
    distance_ratio: ratio,
    target_duration_s: Math.round(rawTargetDuration),
    target_pace_s_per_km: Math.round(rawTargetDuration / (targetDistance / 1000)),
  });
}

function conversionLevelThree(input, diagnostics) {
  if (input.target_type !== TARGET_CONVERSION_REGISTRY_V1.permitted_target) return null;
  const candidates = Array.isArray(input.conversion_evidence) ? input.conversion_evidence : [];
  for (const [index, entry] of candidates.entries()) {
    const gate = evidenceGate(entry, {
      planning_instant: input.planning_instant,
      maximum_age_days: TARGET_POLICY_V1.nearby_road_race_fresh_days,
      target_type: input.target_type,
    });
    diagnostics.push(...gate.reasons);
    if (!gate.valid) continue;
    const conversion = convertNearbyRoadRace({
      source_distance_m: entry.source_distance_m ?? entry.distance_m,
      source_duration_s: entry.source_duration_s ?? entry.duration_s,
      target_distance_m: input.target_distance_m,
      comparable_course_surface: entry.comparable_course_surface === true,
    });
    if (!conversion) continue;
    const range = { minimum: conversion.target_pace_s_per_km, maximum: conversion.target_pace_s_per_km };
    return targetResult(
      input,
      3,
      targetShell({ pace_range_s_per_km: range, duration_s: conversion.target_duration_s }),
      [provenance(input, [evidenceId(entry, index)], ['s/km', 's'], {
        confidence: entry.confidence || 'MEDIUM',
        derived_athlete_state_field: 'race_performance.nearby_road_conversion',
        derivation: conversion.conversion_id,
        conversion_label: conversion.label,
      })],
    );
  }
  return null;
}

function rpeRange(targetType) {
  const range = TARGET_POLICY_V1.fallback_rpe_ranges[targetType];
  return range ? { minimum: range[0], maximum: range[1] } : null;
}

function zoneRange(zones, input) {
  const ranges = zones.hr_ranges_bpm ?? zones.heart_rate_ranges_bpm ?? {};
  const candidate = ranges[input.target_type] ?? ranges[input.workout_family]
    ?? zones.hr_range_bpm ?? zones.heart_rate_range_bpm;
  if (!candidate || typeof candidate !== 'object') return null;
  const minimum = Number(candidate.minimum);
  const maximum = Number(candidate.maximum);
  return Number.isSafeInteger(minimum) && Number.isSafeInteger(maximum) && minimum > 0 && maximum >= minimum
    ? { minimum, maximum } : null;
}

function zoneLevelFour(input) {
  const zones = input.athlete_zones;
  const freshness = String(zones?.freshness_class ?? zones?.freshness_state ?? '').toUpperCase();
  if (!zones || zones.valid !== true || evidenceConflict(zones)
    || (zones.quality_state !== undefined && String(zones.quality_state).toUpperCase() !== 'COMPLETE')
    || FRESHNESS_REJECTIONS.has(freshness)
    || (zones.target_policy_version !== undefined && zones.target_policy_version !== TARGET_POLICY_VERSION)) return null;
  const hr = zoneRange(zones, input);
  if (!hr) return null;
  const ids = Array.isArray(zones.evidence_ids) ? zones.evidence_ids.map(String) : [];
  if (!ids.length || ids.some((id) => !id)) return null;
  return targetResult(
    input,
    4,
    targetShell({ heart_rate_range_bpm: hr, rpe_range: rpeRange(input.target_type) }),
    [provenance(input, ids, ['bpm', 'rpe'], {
      confidence: zones.confidence || 'MEDIUM',
      derived_athlete_state_field: `heart_rate_zones.${input.target_type}`,
    })],
    ['HR_RPE_FALLBACK'],
    'EFFORT',
  );
}

function effortOnlyLevelFour(input) {
  if (!['easy', 'recovery', 'steady', 'race_rhythm', 'long_run', 'compromised'].includes(input.target_type)) {
    return null;
  }
  const assessment = input.assessment && typeof input.assessment === 'object' ? input.assessment : {};
  const duration = nonnegativeInteger(assessment.duration_s);
  return targetResult(
    input,
    4,
    targetShell({ duration_s: duration, rpe_range: rpeRange(input.target_type) }),
    [provenance(input, [], duration === null ? ['rpe'] : ['rpe', 's'], {
      confidence: 'INSUFFICIENT',
      derived_athlete_state_field: 'UNKNOWN_PACE_EVIDENCE',
    })],
    ['HR_RPE_FALLBACK'],
    'EFFORT',
  );
}

function assessmentLevelFive(input) {
  const assessment = input.assessment && typeof input.assessment === 'object' ? input.assessment : {};
  const duration = nonnegativeInteger(assessment.duration_s);
  const repetitions = nonnegativeInteger(assessment.repetitions);
  const units = ['rpe'];
  if (duration !== null) units.push('s');
  if (repetitions !== null) units.push('count');
  return targetResult(
    input,
    5,
    targetShell({
      duration_s: duration,
      repetitions,
      rpe_range: rpeRange(input.target_type) || { minimum: 6, maximum: 8 },
    }),
    [provenance(input, [], units, {
      confidence: 'INSUFFICIENT',
      derived_athlete_state_field: 'UNKNOWN_TARGET_EVIDENCE',
    })],
    ['ASSESSMENT_REQUIRED'],
    'EFFORT',
  );
}

function environmentRequiresEffortOverride(environment = {}) {
  const policy = TARGET_POLICY_V1.environment_effort_override;
  const reasons = [];
  if (Number(environment.temperature_f) >= policy.temperature_f_minimum
    || Number(environment.temperature_c) >= policy.temperature_c_minimum) reasons.push('TEMPERATURE');
  if (Number(environment.dew_point_f) >= policy.dew_point_f_minimum
    || Number(environment.dew_point_c) >= policy.dew_point_c_minimum) reasons.push('DEW_POINT');
  if (Math.abs(Number(environment.altitude_difference_m)) >= policy.altitude_difference_m_minimum) reasons.push('ALTITUDE');
  if (environment.sustained_hills === true || environment.terrain_mismatch === true) reasons.push('TERRAIN');
  if (environment.treadmill_outdoor_mismatch === true) reasons.push('SURFACE');
  return deepFreeze({ required: reasons.length > 0, reasons });
}

function validEnvironmentEvidence(environment) {
  if (!environment || typeof environment !== 'object') return false;
  const freshness = String(environment.freshness_class ?? environment.freshness_state ?? '').toUpperCase();
  return String(environment.quality_state || '').toUpperCase() === 'COMPLETE'
    && freshness === 'FRESH'
    && Boolean(environment.evidence_id)
    && !evidenceConflict(environment);
}

function applyEnvironmentOverride(input, result) {
  const environment = input.environment;
  const gate = environmentRequiresEffortOverride(environment);
  if (!gate.required || !validEnvironmentEvidence(environment)) return result;
  const target = {
    ...result.target,
    reference_pace_range_s_per_km: result.target.pace_range_s_per_km,
    pace_range_s_per_km: null,
    rpe_range: result.target.rpe_range || rpeRange(input.target_type) || { minimum: 6, maximum: 8 },
  };
  const evidenceIds = environment.evidence_id ? [String(environment.evidence_id)] : [];
  const environmentProvenance = provenance(input, evidenceIds, ['rpe'], {
    confidence: environment.confidence || 'MEDIUM',
    derived_athlete_state_field: 'environment.effort_override',
    trigger_conditions: gate.reasons,
  });
  return {
    ...result,
    authority: 'EFFORT',
    target,
    provenance: [...result.provenance, environmentProvenance],
    target_provenance: [...result.provenance, environmentProvenance],
    reason_codes: [...new Set([...result.reason_codes, 'ENVIRONMENT_EFFORT_OVERRIDE'])],
  };
}

function resolveGoalBackwardTarget(input = {}) {
  const normalized = {
    ...input,
    target_type: String(input.target_type ?? input.targetType ?? ''),
    workout_family: String(input.workout_family ?? input.workoutFamily ?? ''),
  };
  if (!VALID_TARGET_TYPES.has(normalized.target_type)) {
    return deepFreeze({
      valid: false,
      target_policy_version: TARGET_POLICY_VERSION,
      authority_level: null,
      target: targetShell(),
      provenance: [],
      target_provenance: [],
      reason_codes: ['PACE_EVIDENCE_MISSING', 'ASSESSMENT_REQUIRED'],
      violations: [{ code: 'TARGET_TYPE_UNSUPPORTED', target_type: normalized.target_type }],
    });
  }
  const diagnostics = [];
  let result = samePurposeLevelOne(normalized, diagnostics)
    || comparableLevelTwo(normalized, diagnostics)
    || freshThresholdLevelThree(normalized, diagnostics)
    || conversionLevelThree(normalized, diagnostics)
    || zoneLevelFour(normalized)
    || effortOnlyLevelFour(normalized)
    || assessmentLevelFive(normalized);
  if (result.authority_level >= 4) {
    const evidenceReason = diagnostics.includes('STALE') ? 'PACE_EVIDENCE_STALE' : 'PACE_EVIDENCE_MISSING';
    result = { ...result, reason_codes: [...new Set([evidenceReason, ...result.reason_codes])] };
  }
  result = applyEnvironmentOverride(normalized, result);
  return deepFreeze(result);
}

function targetTypeForWorkoutFamily(workoutFamily) {
  return TARGET_TYPE_BY_WORKOUT_FAMILY[String(workoutFamily || '')] || null;
}

function compactCanonicalTarget(target = {}) {
  return Object.fromEntries(Object.entries(target).filter(([, value]) => value !== null && value !== undefined));
}

function buildCanonicalMaterialTarget(input = {}) {
  const targetType = input.target_type || targetTypeForWorkoutFamily(input.workout_family);
  const authority = resolveGoalBackwardTarget({
    ...input,
    target_type: targetType,
    workout_family: input.workout_family,
  });
  if (!authority.valid) return authority;
  const dosage = {};
  if (Number.isSafeInteger(input.duration_s) && input.duration_s >= 0) dosage.duration_s = input.duration_s;
  if (Number.isSafeInteger(input.distance_m) && input.distance_m >= 0) dosage.distance_m = input.distance_m;
  if (Number.isSafeInteger(input.repetitions) && input.repetitions >= 0) dosage.repetitions = input.repetitions;
  const target = compactCanonicalTarget({ ...authority.target, ...dosage });
  const dosageUnits = [
    Object.hasOwn(dosage, 'distance_m') ? 'm' : null,
    Object.hasOwn(dosage, 'duration_s') ? 's' : null,
    Object.hasOwn(dosage, 'repetitions') ? 'count' : null,
  ].filter(Boolean);
  const covered = new Set((authority.provenance || []).flatMap((entry) => entry.canonical_units || []));
  const uncovered = dosageUnits.filter((unit) => !covered.has(unit));
  const dosageProvenance = uncovered.length ? [provenance(
    input,
    (input.source_evidence_ids || []).map(String).filter(Boolean),
    uncovered,
    {
      confidence: input.dosage_confidence || (input.source_evidence_ids?.length ? 'MEDIUM' : 'INSUFFICIENT'),
      derived_athlete_state_field: input.derived_athlete_state_field || 'UNKNOWN_LEGACY_CANDIDATE_DOSAGE',
      derivation: 'canonical-materialization-v1',
    },
  )] : [];
  const targetProvenance = [...(authority.provenance || []), ...dosageProvenance];
  return deepFreeze({
    ...authority,
    target,
    provenance: targetProvenance,
    target_provenance: targetProvenance,
  });
}

module.exports = {
  TARGET_POLICY_V1,
  benchmarkPaceRange,
  buildCanonicalMaterialTarget,
  convertNearbyRoadRace,
  environmentRequiresEffortOverride,
  evidenceGate,
  quantileRType7: rType7Quantile,
  rType7Quantile,
  resolveTargetAuthority: resolveGoalBackwardTarget,
  resolveGoalBackwardTarget,
  resolveTarget: resolveGoalBackwardTarget,
  roadRaceConversionV1: convertNearbyRoadRace,
  selectTargetAuthority: resolveGoalBackwardTarget,
  targetTypeForWorkoutFamily,
  workSegmentPaces,
};
