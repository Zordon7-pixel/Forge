const crypto = require('node:crypto');

const MS_PER_DAY = 86400000;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

const STRESS_DIMENSIONS = Object.freeze([
  'aerobic',
  'running_impact',
  'lower_body_muscular',
  'upper_body_muscular',
  'grip',
  'neuromuscular',
  'metabolic',
  'event_specific_fatigue',
]);

const PHASE_RUNNING_FLOOR_FACTOR = deepFreeze({
  FOUNDATION: 0.7,
  DEVELOPMENT: 0.85,
  EVENT_SPECIFIC_DEVELOPMENT: 0.9,
  SHARPENING: 0.7,
  TAPER_RACE_WEEK: 0.4,
  POST_RACE_TRANSITION: 0,
});

const ZERO_OVERLOAD_ALLOWANCE = deepFreeze(Object.fromEntries(
  STRESS_DIMENSIONS.map((dimension) => [dimension, 0])
));
const HYROX_CLUSTER_OVERLOAD_ALLOWANCE = deepFreeze(Object.fromEntries(
  STRESS_DIMENSIONS.map((dimension, index) => [dimension, [2, 2, 3, 2, 2, 2, 3, 5][index]])
));

function exposure(requirementId, anyOf, role = 'PRIMARY_KEY') {
  return { requirement_id: requirementId, any_of: anyOf, role };
}

const EVENT_EXPOSURES = deepFreeze({
  ROAD_SHORT: {
    DEVELOPMENT: [
      exposure('road_short_quality', ['threshold_run', 'hill_run']),
      exposure('long_aerobic', ['long_aerobic']),
    ],
    EVENT_SPECIFIC_DEVELOPMENT: [
      exposure('road_short_specific', ['interval_run', 'race_rhythm_run']),
      exposure('long_aerobic', ['long_aerobic']),
    ],
    SHARPENING: [exposure('road_short_sharpening', ['race_rhythm_run', 'strides_run'])],
  },
  ROAD_ENDURANCE: {
    DEVELOPMENT: [
      exposure('road_endurance_threshold', ['threshold_run']),
      exposure('long_aerobic', ['long_aerobic']),
    ],
    EVENT_SPECIFIC_DEVELOPMENT: [
      exposure('road_endurance_specific', ['race_rhythm_run', 'threshold_run']),
      exposure('long_aerobic', ['long_aerobic']),
    ],
    SHARPENING: [exposure('road_endurance_sharpening', ['race_rhythm_run', 'strides_run'])],
  },
  MARATHON: {
    DEVELOPMENT: [
      exposure('marathon_development_quality', ['threshold_run', 'steady_run']),
      exposure('long_aerobic', ['long_aerobic']),
    ],
    EVENT_SPECIFIC_DEVELOPMENT: [
      exposure('marathon_rhythm', ['race_rhythm_run']),
      exposure('long_aerobic', ['long_aerobic']),
      exposure('optional_threshold', ['threshold_run'], 'OPTIONAL_KEY'),
    ],
    SHARPENING: [exposure('marathon_sharpening', ['race_rhythm_run'])],
  },
  HYROX_SINGLES: {
    DEVELOPMENT: [
      exposure('hyrox_station_development', ['hyrox_station_strength', 'hyrox_station_skill']),
      exposure('hyrox_running_support', ['threshold_run', 'interval_run', 'long_aerobic']),
    ],
    EVENT_SPECIFIC_DEVELOPMENT: [
      exposure('hyrox_partial_simulation', ['hyrox_partial_simulation']),
      exposure('hyrox_station_skill', ['hyrox_station_skill'], 'SUPPORTING'),
      exposure('long_aerobic', ['long_aerobic']),
    ],
    SHARPENING: [exposure('hyrox_compromised_sharpening', ['hyrox_compromised', 'hyrox_station_skill'])],
  },
  HYROX_DOUBLES: {
    DEVELOPMENT: [
      exposure('hyrox_individual_limiter', ['hyrox_station_strength', 'hyrox_station_skill']),
      exposure('hyrox_running_support', ['threshold_run', 'interval_run', 'long_aerobic']),
    ],
    EVENT_SPECIFIC_DEVELOPMENT: [
      exposure('hyrox_team_partial_simulation', ['hyrox_partial_simulation']),
      exposure('hyrox_station_skill', ['hyrox_station_skill'], 'SUPPORTING'),
      exposure('long_aerobic', ['long_aerobic']),
    ],
    SHARPENING: [exposure('hyrox_split_transition_sharpening', ['hyrox_compromised', 'hyrox_station_skill'])],
  },
});

function eventPolicyRecord(eventPolicyId, eventKind, taperDays) {
  const isHyrox = eventKind === 'HYROX_SINGLES' || eventKind === 'HYROX_DOUBLES';
  return {
    event_policy_id: eventPolicyId,
    registry_version: 1,
    event_kind: eventKind,
    taper_days: taperDays,
    required_exposure_ledger: EVENT_EXPOSURES[eventKind],
    phase_running_floor_factor: PHASE_RUNNING_FLOOR_FACTOR,
    minimum_weekly_demand: { running_m: null, required_exposure_count: 0 },
    overload_dimensions: isHyrox ? [...STRESS_DIMENSIONS] : [],
    overload_allowance_points: isHyrox
      ? HYROX_CLUSTER_OVERLOAD_ALLOWANCE
      : ZERO_OVERLOAD_ALLOWANCE,
    stimulus_priority: EVENT_EXPOSURES[eventKind],
    recovery_buffer_days: 2,
  };
}

const EVENT_POLICY_RECORDS_V1 = deepFreeze({
  road_5k_v1: eventPolicyRecord('road_5k_v1', 'ROAD_SHORT', 7),
  road_10k_v1: eventPolicyRecord('road_10k_v1', 'ROAD_SHORT', 7),
  road_10mile_v1: eventPolicyRecord('road_10mile_v1', 'ROAD_ENDURANCE', 10),
  road_half_marathon_v1: eventPolicyRecord('road_half_marathon_v1', 'ROAD_ENDURANCE', 10),
  road_marathon_v1: eventPolicyRecord('road_marathon_v1', 'MARATHON', 14),
  hyrox_singles_v1: eventPolicyRecord('hyrox_singles_v1', 'HYROX_SINGLES', 7),
  hyrox_doubles_v1: eventPolicyRecord('hyrox_doubles_v1', 'HYROX_DOUBLES', 7),
});

const EVENT_POLICY_REGISTRY_V1 = deepFreeze({
  registry_version: 1,
  event_policy_registry_version: 1,
  policies: EVENT_POLICY_RECORDS_V1,
  event_policies: EVENT_POLICY_RECORDS_V1,
});

const EVENT_POLICY_ALIASES = Object.freeze({
  road_half_v1: 'road_half_marathon_v1',
  half_marathon_v1: 'road_half_marathon_v1',
  marathon_v1: 'road_marathon_v1',
});

const STRESS_TAXONOMY_V1 = deepFreeze({
  stress_taxonomy_version: 1,
  dimensions: STRESS_DIMENSIONS,
  ordinal_levels: { NONE: 0, LOW: 1, MODERATE: 2, HIGH: 3, VERY_HIGH: 4 },
  family_vectors: {
    rest: [0, 0, 0, 0, 0, 0, 0, 0],
    mobility: [0, 0, 1, 0, 0, 0, 0, 0],
    manual_recovery: [0, 0, 1, 0, 0, 0, 0, 0],
    recovery_run: [1, 1, 1, 0, 0, 0, 0, 0],
    easy_run: [2, 2, 1, 0, 0, 1, 1, 0],
    long_aerobic: [3, 3, 2, 0, 0, 1, 2, 1],
    steady_run: [3, 3, 2, 0, 0, 2, 2, 1],
    threshold_run: [3, 3, 2, 0, 0, 3, 3, 1],
    interval_run: [3, 4, 2, 0, 0, 4, 4, 1],
    race_rhythm_run: [3, 3, 2, 0, 0, 3, 3, 2],
    strength_lower: [1, 1, 4, 1, 1, 3, 2, 1],
    strength_upper: [1, 0, 0, 3, 2, 2, 1, 0],
    strength_full_body: [1, 1, 3, 3, 2, 3, 2, 1],
    hyrox_station_skill: [2, 1, 2, 2, 2, 2, 2, 2],
    hyrox_station_strength: [2, 1, 4, 3, 3, 3, 3, 3],
    hyrox_compromised: [4, 4, 4, 2, 3, 3, 4, 4],
    hyrox_partial_simulation: [4, 4, 4, 3, 3, 4, 4, 4],
    hyrox_full_simulation: [4, 4, 4, 4, 4, 4, 4, 4],
  },
  race_vectors: {
    road: [4, 4, 3, 1, 1, 4, 4, 4],
    hyrox: [4, 4, 4, 4, 4, 4, 4, 4],
  },
  assessment: {
    resolution: 'ELEMENT_WISE_MAX_CONTRIBUTING_WORK_FAMILIES',
    event_specific_fatigue_floor: 2,
    excluded_step_roles: ['WARMUP', 'RECOVERY', 'COOLDOWN', 'MOBILITY', 'MANUAL_INSTRUCTION'],
  },
});

const TARGET_CONVERSION_REGISTRY_V1 = deepFreeze({
  target_conversion_registry_version: 1,
  conversion_id: 'nearby-road-race-riegel-v1',
  permitted_target: 'race_rhythm',
  distance_ratio: { minimum: 0.5, maximum: 2 },
  source_duration_seconds: { minimum: 1200, maximum: 10800 },
  exponent: 1.06,
  requires_comparable_course_surface: true,
  target_pace_rounding: 'WHOLE_SECONDS_PER_KM',
  label: 'conversion',
  forbidden_targets: ['threshold', 'interval', 'easy', 'long_run', 'compromised'],
});

const GOAL_BACKWARD_PLANNING_POLICY_V1 = deepFreeze({
  planning_policy_version: 'goal-backward-planning-policy-v1',
  event_policy_registry_version: EVENT_POLICY_REGISTRY_V1.registry_version,
  stress_taxonomy_version: STRESS_TAXONOMY_V1.stress_taxonomy_version,
  target_conversion_registry_version: TARGET_CONVERSION_REGISTRY_V1.target_conversion_registry_version,
  phase_running_floor_factor: PHASE_RUNNING_FLOOR_FACTOR,
  required_primary_exposure_count: {
    FOUNDATION: 1,
    DEVELOPMENT: { constrained: 1, developing_plus: 2 },
    EVENT_SPECIFIC_DEVELOPMENT: { constrained: 1, developing_plus: 2 },
    SHARPENING: 1,
    TAPER_RACE_WEEK: 1,
    POST_RACE_TRANSITION: 0,
  },
  fatigue_budget: {
    lookback_weeks: 8,
    established_minimum_weeks: 4,
    provisional_weeks: 3,
    ceiling_growth_fraction: 0.2,
    minimum_ceiling_increment: 2,
    training_class_fallback: {
      beginner_returning_sparse: [6, 6, 5, 4, 4, 4, 5, 4],
      developing: [10, 9, 8, 7, 6, 8, 9, 7],
      established_advanced: [14, 14, 12, 10, 10, 12, 13, 10],
    },
  },
  rolling_seven_days: {
    maximum_lower_body_running_hard_days: 2,
    maximum_total_hard_days: { default: 2, established_advanced: 3 },
    maximum_very_high_event_specific_sessions: 1,
    very_high_race_exclusion_days: 6,
  },
});

function eventPolicyFor(eventPolicyId) {
  const requested = typeof eventPolicyId === 'object'
    ? eventPolicyId?.event_policy_id
    : eventPolicyId;
  const canonicalId = EVENT_POLICY_ALIASES[requested] || requested;
  return EVENT_POLICY_RECORDS_V1[canonicalId] || null;
}

function requiredPrimaryExposureCount(phase, options = {}) {
  const normalizedPhase = String(phase || '').toUpperCase();
  if (normalizedPhase === 'POST_RACE_TRANSITION') return 0;
  if (!Object.hasOwn(PHASE_RUNNING_FLOOR_FACTOR, normalizedPhase)) return null;
  if (!['DEVELOPMENT', 'EVENT_SPECIFIC_DEVELOPMENT'].includes(normalizedPhase)) return 1;
  const trainingAge = String(options.training_age_class || '').toUpperCase();
  const consistency = String(options.consistency_state || '').toUpperCase();
  const recovery = String(options.recovery_state || '').toUpperCase();
  const availableDays = Number(options.available_days_count ?? options.available_days?.length ?? 0);
  const constrained = ['BEGINNER', 'RETURNING'].includes(trainingAge)
    || ['RETURNING', 'SPARSE_DATA'].includes(consistency)
    || recovery === 'CAUTION'
    || (normalizedPhase === 'EVENT_SPECIFIC_DEVELOPMENT' && !['READY', 'NORMAL'].includes(recovery))
    || availableDays <= 4;
  return constrained ? 1 : 2;
}

function minimumWeeklyDemandFor(eventPolicyId, options = {}) {
  const policy = eventPolicyFor(eventPolicyId);
  const phase = String(options.phase || '').toUpperCase();
  if (!policy || !Object.hasOwn(policy.phase_running_floor_factor, phase)) return null;
  const status = String(options.recent_normal_status || '').toUpperCase();
  const rawMedianDistance = options.recent_normal_median_distance_m;
  const medianDistance = typeof rawMedianDistance === 'number' ? rawMedianDistance : NaN;
  const runningM = ['ESTABLISHED', 'PROVISIONAL'].includes(status)
    && Number.isFinite(medianDistance) && medianDistance >= 0
    ? Math.floor(medianDistance * policy.phase_running_floor_factor[phase])
    : null;
  return {
    running_m: runningM,
    required_exposure_count: requiredPrimaryExposureCount(phase, options),
  };
}

const RACE_PLAN_POLICY_V1 = deepFreeze({
  version: 'race-plan-policy-v1',
  engineVersion: 'race-plan-candidate-v1',
  invariantVersion: 'race-plan-invariants-v1',
  generationTraceSchemaVersion: 1,
  epsilonMiles: 0.05,
  calendar: {
    maximumTimezoneOffsetMinutes: 840,
    taperWeeks: {
      upTo10K: 1,
      throughHalfMarathon: 2,
      throughMarathon: 3,
    },
    postA1RecoveryDays: 7,
  },
  baseline: {
    completeWeeks: 6,
    trustedWeekMinimumRuns: 2,
    trustedWeekMinimumMiles: 2,
    trustedWeekMinimumMinutes: 30,
    enduranceLookbackDays: 56,
  },
  longRun: {
    identityFloorMiles: {
      upTo5K: 3,
      through10K: 4,
      through10Miles: 5,
      throughHalfMarathon: 6,
      throughMarathon: 8,
    },
    phaseFraction: {
      bridge: 0.3,
      base: 0.3,
      build: 0.4,
      peak: 0.55,
      taper: 0.3,
    },
    ordinaryEasyDistanceMultiplier: 1.25,
    ordinaryEasyDurationMultiplier: 1.2,
    minimumDurationMinutes: 45,
    maximumDurationMinutes: 180,
  },
  raceDemand: {
    peakLongRunMiles: {
      fiveK: { completion: 3, pr: 5 },
      tenK: { completion: 5, pr: 6 },
      tenMiles: { completion: 7, pr: 8 },
      halfMarathon: { completion: 8, pr: 10 },
      marathon: { completion: 16, pr: 18 },
    },
    peakLongRunWeeklyShare: 0.45,
  },
  progression: {
    maximumWeeklyGrowth: 0.08,
    maximumLongRunGrowth: 0.1,
    minimumLongRunGrowthMiles: 0.5,
    stretchDemandFloor: 0.9,
  },
  paceFeasibility: {
    supportedMaximum: 0.04,
    supportedPerFullWeek: 0.005,
    stretchMaximum: 0.08,
    stretchPerFullWeek: 0.01,
  },
  qualityExposure: {
    fiveK: { hillsOrStrides: 1, thresholdOrIntervals: 2, racePace: 1 },
    tenK: { hillsOrStrides: 1, thresholdOrIntervals: 2, racePace: 2 },
    tenMiles: { hillsOrStrides: 1, thresholdOrIntervals: 2, racePace: 2 },
    halfMarathon: { hillsOrStrides: 1, thresholdOrIntervals: 2, racePace: 2 },
    marathon: { hillsOrStrides: 1, thresholdOrIntervals: 2, racePace: 3 },
  },
  demandingSessions: {
    maximumInRollingSevenDays: 2,
    minimumInterveningCalendarDates: 2,
  },
  candidate: {
    ttlHours: 24,
    maximumPlanBytes: 512 * 1024,
    maximumInputBytes: 128 * 1024,
    maximumTraceBytes: 128 * 1024,
    maximumReplayBytes: 16 * 1024,
  },
  diagnostics: {
    maximumResponseBytes: 256 * 1024,
    retentionDays: 365,
  },
  rollout: {
    engineMode: 'preview_shadow',
    automaticActiveReplacement: false,
    betaApplyConfirmation: 'APPLY_FUTURE_BETA_PLANS',
  },
  reasonCodes: [
    'NO_WEEKLY_BASELINE',
    'NO_LONG_RUN_ANCHOR',
    'NO_PERFORMANCE_ANCHOR',
    'ANCHOR_EXPIRED',
    'PACE_EQUIVALENCY_USED',
    'BROAD_EQUIVALENCY_ONLY',
    'BRIDGE_WEEK',
    'LONG_SEMANTIC_MINIMUM',
    'TIME_DISTANCE_MISMATCH',
    'STRUCTURE_UNQUANTIFIED',
    'PEAK_DEMAND_UNREACHABLE',
    'QUALITY_EXPOSURE_MISSING',
    'DEMANDING_SESSION_SPACING',
    'CHECKPOINT_UNPLACEABLE',
    'DELOAD_VOLUME_REDUCTION',
    'POST_A1_RECOVERY',
    'RACE_SPACING_CONFLICT',
    'CANDIDATE_STALE',
  ],
});

function parseISODate(value) {
  const raw = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T12:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw ? null : date;
}

function toISODate(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function addDays(value, days) {
  const date = parseISODate(value);
  if (!date) return null;
  return toISODate(date.getTime() + (Number(days) * MS_PER_DAY));
}

function daysBetween(left, right) {
  const a = parseISODate(left);
  const b = parseISODate(right);
  return a && b ? Math.round((b.getTime() - a.getTime()) / MS_PER_DAY) : null;
}

function mondayFor(value) {
  const date = parseISODate(value);
  if (!date) return null;
  const offset = (date.getUTCDay() + 6) % 7;
  return addDays(value, -offset);
}

function parseStrictInteger(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!/^[+-]?\d+$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function acceptPlanningClock(input = {}, serverDateISO) {
  const planningDateLocal = String(input.planningDateLocal || input.planning_date_local || '').trim();
  const rawTimezoneOffset = input.timezoneOffsetMinutes ?? input.timezone_offset_minutes;
  const timezoneOffsetMinutes = parseStrictInteger(rawTimezoneOffset);
  const serverDate = parseISODate(serverDateISO) ? serverDateISO : toISODate(new Date());
  if (!parseISODate(planningDateLocal)) return { valid: false, reason: 'INVALID_PLANNING_DATE' };
  if (timezoneOffsetMinutes === null
    || Math.abs(timezoneOffsetMinutes) > RACE_PLAN_POLICY_V1.calendar.maximumTimezoneOffsetMinutes) {
    return { valid: false, reason: 'INVALID_TIMEZONE_OFFSET' };
  }
  const driftDays = daysBetween(serverDate, planningDateLocal);
  if (driftDays === null || Math.abs(driftDays) > 1) return { valid: false, reason: 'STALE_PLANNING_DATE' };
  return { valid: true, planningDateLocal, timezoneOffsetMinutes };
}

function firstFullMonday(planningDateLocal, trustedActivityDates = []) {
  const currentMonday = mondayFor(planningDateLocal);
  if (!currentMonday) return null;
  const planningDate = parseISODate(planningDateLocal);
  const isMonday = planningDate.getUTCDay() === 1;
  const activityToday = new Set(trustedActivityDates.map((value) => String(value || '').slice(0, 10)))
    .has(planningDateLocal);
  return isMonday && !activityToday ? currentMonday : addDays(currentMonday, 7);
}

function raceCategory(distanceMiles) {
  const distance = Number(distanceMiles);
  if (!(distance > 0)) return null;
  if (distance <= 3.107 + RACE_PLAN_POLICY_V1.epsilonMiles) return 'fiveK';
  if (distance <= 6.214 + RACE_PLAN_POLICY_V1.epsilonMiles) return 'tenK';
  if (distance <= 10 + RACE_PLAN_POLICY_V1.epsilonMiles) return 'tenMiles';
  if (distance <= 13.109 + RACE_PLAN_POLICY_V1.epsilonMiles) return 'halfMarathon';
  return 'marathon';
}

function taperWeeksForDistance(distanceMiles) {
  const category = raceCategory(distanceMiles);
  if (category === 'fiveK' || category === 'tenK') return RACE_PLAN_POLICY_V1.calendar.taperWeeks.upTo10K;
  if (category === 'tenMiles' || category === 'halfMarathon') return RACE_PLAN_POLICY_V1.calendar.taperWeeks.throughHalfMarathon;
  return RACE_PLAN_POLICY_V1.calendar.taperWeeks.throughMarathon;
}

function longRunIdentityFloor(distanceMiles) {
  const category = raceCategory(distanceMiles);
  return RACE_PLAN_POLICY_V1.longRun.identityFloorMiles[
    category === 'fiveK' ? 'upTo5K'
      : category === 'tenK' ? 'through10K'
        : category === 'tenMiles' ? 'through10Miles'
          : category === 'halfMarathon' ? 'throughHalfMarathon'
            : 'throughMarathon'
  ];
}

function peakLongRunDemand(distanceMiles, goalType = 'completion') {
  const category = raceCategory(distanceMiles);
  const mode = String(goalType).toLowerCase() === 'pr' ? 'pr' : 'completion';
  return RACE_PLAN_POLICY_V1.raceDemand.peakLongRunMiles[category][mode];
}

function roundUpHalfMile(value) {
  return Math.ceil((Number(value) - Number.EPSILON) * 2) / 2;
}

function requiredPeakWeeklyMiles(distanceMiles, goalType) {
  return roundUpHalfMile(
    peakLongRunDemand(distanceMiles, goalType) / RACE_PLAN_POLICY_V1.raceDemand.peakLongRunWeeklyShare
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    if (value[key] !== undefined) result[key] = canonicalize(value[key]);
    return result;
  }, {});
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalHash(value) {
  return crypto.createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

module.exports = {
  EVENT_POLICY_REGISTRY_V1,
  GOAL_BACKWARD_PLANNING_POLICY_V1,
  RACE_PLAN_POLICY_V1,
  STRESS_TAXONOMY_V1,
  TARGET_CONVERSION_REGISTRY_V1,
  acceptPlanningClock,
  addDays,
  canonicalHash,
  canonicalStringify,
  daysBetween,
  eventPolicyFor,
  firstFullMonday,
  longRunIdentityFloor,
  minimumWeeklyDemandFor,
  mondayFor,
  peakLongRunDemand,
  parseStrictInteger,
  raceCategory,
  requiredPrimaryExposureCount,
  requiredPeakWeeklyMiles,
  taperWeeksForDistance,
};
