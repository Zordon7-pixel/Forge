const crypto = require('node:crypto');

const MS_PER_DAY = 86400000;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
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

function acceptPlanningClock(input = {}, serverDateISO) {
  const planningDateLocal = String(input.planningDateLocal || input.planning_date_local || '').trim();
  const timezoneOffsetMinutes = Number(input.timezoneOffsetMinutes ?? input.timezone_offset_minutes);
  const serverDate = parseISODate(serverDateISO) ? serverDateISO : toISODate(new Date());
  if (!parseISODate(planningDateLocal)) return { valid: false, reason: 'INVALID_PLANNING_DATE' };
  if (!Number.isInteger(timezoneOffsetMinutes)
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
  RACE_PLAN_POLICY_V1,
  acceptPlanningClock,
  addDays,
  canonicalHash,
  canonicalStringify,
  daysBetween,
  firstFullMonday,
  longRunIdentityFloor,
  mondayFor,
  peakLongRunDemand,
  raceCategory,
  requiredPeakWeeklyMiles,
  taperWeeksForDistance,
};
