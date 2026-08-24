const {
  EQUIPMENT_KEYS,
  REGISTRY,
  STATION_ORDER,
  normalizeEquipment,
  resolveHyroxStandard,
} = require('./hyroxStandards');
const {
  buildCanonicalHyroxEventState,
  buildPartialRaceOrderCluster: buildCanonicalPartialRaceOrderCluster,
  validatePartialRaceOrderCluster,
} = require('./canonicalWorkout');
const { buildHyroxPerformanceBudget } = require('./goalBackwardTargets');
const { getGoalBackwardV24Mode } = require('./betaPlanRollout');
const {
  aggregateWeeklyStress,
  calculateFatigueCeilings,
  evaluateStressBudget,
  validateRollingHardDays,
} = require('./goalBackwardLoad');
const {
  validateGoalBackwardCandidate,
  validateInterference,
  validatePartialRaceOrderClusterExposure,
} = require('./goalBackwardValidators');
const { eventPolicyFor } = require('./racePlanPolicy');

const DAY_MS = 86400000;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseLocalDate(value) {
  const raw = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const time = Date.parse(`${raw}T00:00:00.000Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== raw) return null;
  return time;
}

function addLocalDays(date, days) {
  const time = parseLocalDate(date);
  if (time == null || !Number.isInteger(days)) throw new Error('invalid_local_date');
  return new Date(time + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetweenLocalDates(later, earlier) {
  const end = parseLocalDate(later);
  const start = parseLocalDate(earlier);
  if (end == null || start == null) throw new Error('invalid_local_date');
  return Math.round((end - start) / DAY_MS);
}

function isRaceSafetyDate(date, eventDate) {
  if (parseLocalDate(date) == null || parseLocalDate(eventDate) == null) return false;
  const daysBeforeRace = daysBetweenLocalDates(eventDate, date);
  return daysBeforeRace >= 0 && daysBeforeRace <= 6;
}

function respectsRollingHardLowerBodyCap(dates, maximum = 2) {
  const uniqueDates = [...new Set(dates.filter((date) => parseLocalDate(date) != null))].sort();
  return uniqueDates.every((start) => uniqueDates.filter((date) => {
    const delta = daysBetweenLocalDates(date, start);
    return delta >= 0 && delta <= 6;
  }).length <= maximum);
}

function mondayForLocalDate(date) {
  const time = parseLocalDate(date);
  if (time == null) throw new Error('invalid_local_date');
  const offset = (new Date(time).getUTCDay() + 6) % 7;
  return addLocalDays(date, -offset);
}

function planWeekWindow(planningLocalDate, eventLocalDate = null) {
  if (parseLocalDate(planningLocalDate) == null) throw new Error('invalid_planning_local_date');
  const startDate = mondayForLocalDate(planningLocalDate);
  if (eventLocalDate == null || eventLocalDate === '') return { startDate, weeks: 8 };
  if (parseLocalDate(eventLocalDate) == null) throw new Error('invalid_event_local_date');
  if (eventLocalDate < planningLocalDate) throw new Error('invalid_days_to_event');
  const eventWeekStart = mondayForLocalDate(eventLocalDate);
  return {
    startDate,
    weeks: Math.floor(daysBetweenLocalDates(eventWeekStart, startDate) / 7) + 1,
  };
}

function finiteNonNegative(value, fallback = 0, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum ? parsed : fallback;
}

function isIanaTimezone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(value || '') }).format(new Date());
    return Boolean(value);
  } catch (error) {
    return false;
  }
}

function localDateInTimeZone(instant, timezone) {
  if (!isIanaTimezone(timezone)) throw new Error('invalid_event_timezone');
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) throw new Error('invalid_instant');
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function daysToEventForEvent(event = {}, options = {}) {
  if (!event.eventLocalDate) return null;
  if (parseLocalDate(event.eventLocalDate) == null) throw new Error('invalid_event_local_date');
  const planningDate = options.planningLocalDate
    || localDateInTimeZone(options.now, event.eventTimezone);
  return daysBetweenLocalDates(event.eventLocalDate, planningDate);
}

function classifyHyroxRunway(daysToEvent) {
  if (daysToEvent === null || daysToEvent === undefined) return 'foundation_only';
  if (!Number.isInteger(daysToEvent) || daysToEvent < 0) throw new Error('invalid_days_to_event');
  if (daysToEvent < 7) return 'race_week';
  if (daysToEvent < 21) return 'readiness_bridge';
  if (daysToEvent < 42) return 'short_runway';
  if (daysToEvent < 84) return 'standard_build';
  if (daysToEvent <= 140) return 'full_build';
  return 'base_then_build';
}

function phaseForShort(index, count) {
  if (index === 0) return 'orientation_assessment';
  if (index === count - 1) return 'taper_race';
  if (count === 3 && index === 1) return 'peak_partial_simulation';
  if (index === count - 3) return 'peak_partial_simulation';
  if (index === count - 2) return 'sharpen_reduce';
  return 'build';
}

function proportionalPhase(index, count, bands) {
  const progress = (index + 0.5) / count;
  let cumulative = 0;
  for (const [phase, share] of bands) {
    cumulative += share;
    if (progress <= cumulative) return phase;
  }
  return bands.at(-1)[0];
}

function allocatePhases(runway, count) {
  return Array.from({ length: count }, (_, index) => {
    if (runway === 'race_week') return 'taper_race';
    if (runway === 'readiness_bridge') {
      if (index === count - 1) return 'taper_race';
      return index === 0 ? 'orientation_assessment' : 'readiness_bridge';
    }
    if (runway === 'short_runway') return phaseForShort(index, count);
    if (runway === 'standard_build') {
      return proportionalPhase(index, count, [
        ['foundation', 0.2], ['build', 0.45], ['specific', 0.2], ['taper_race', 0.15],
      ]);
    }
    if (runway === 'full_build') {
      return proportionalPhase(index, count, [
        ['foundation', 0.25], ['build', 0.35], ['specific', 0.25], ['taper_race', 0.15],
      ]);
    }
    if (runway === 'base_then_build') {
      const specificBlock = Math.min(20, count);
      const baseWeeks = count - specificBlock;
      if (index < baseWeeks) return 'base_development';
      return proportionalPhase(index - baseWeeks, specificBlock, [
        ['foundation', 0.25], ['build', 0.35], ['specific', 0.25], ['taper_race', 0.15],
      ]);
    }
    return proportionalPhase(index, count, [
      ['foundation', 0.4], ['build', 0.35], ['consolidate', 0.25],
    ]);
  });
}

const PHASE_LOAD = Object.freeze({
  orientation_assessment: 0.72,
  readiness_bridge: 0.68,
  foundation: 0.76,
  base_development: 0.74,
  build: 0.88,
  peak_partial_simulation: 1,
  specific: 0.94,
  sharpen_reduce: 0.7,
  consolidate: 0.72,
  taper_race: 0.44,
  post_hyrox_recovery: 0.32,
  running_specific: 0.78,
  running_taper_race: 0.42,
});

function weekday(date) {
  return WEEKDAY[new Date(`${date}T12:00:00.000Z`).getUTCDay()];
}

function normalizeAvailableDays(value) {
  const raw = Array.isArray(value) ? value : WEEKDAY.slice(1).concat('Sun');
  const selected = new Set(raw.map((day) => String(day || '').slice(0, 3).toLowerCase()));
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    .filter((day) => selected.has(day.toLowerCase()));
}

function nearestSlot(target, available, excluded = new Set()) {
  const candidates = available.filter((slot) => !excluded.has(slot));
  const pool = candidates.length ? candidates : available;
  if (!pool.length) throw new Error('no_available_training_days');
  return pool.slice().sort((left, right) => (
    Math.abs(left - target) - Math.abs(right - target) || left - right
  ))[0];
}

function sessionBase(id, sessionType, title, purpose) {
  return {
    id,
    kind: 'hyrox',
    sessionType,
    type: sessionType,
    title,
    purpose,
    warmUp: ['8-10 min easy aerobic work', 'Dynamic ankle, hip, and thoracic mobility', 'Two submaximal movement rehearsals'],
    transitionRest: 'Move deliberately; use 60-120 seconds between station blocks unless a shorter transition is prescribed.',
    stopScaleCriteria: ['Stop for sharp pain, dizziness, or altered running mechanics', 'Reduce load or repetitions when technique breaks', 'Keep two repetitions in reserve on loaded work'],
    evidenceRefs: ['hyrox_official_order', 'forge_concurrent_safety_v1'],
    rulesVersion: REGISTRY.rulesVersion,
    canonicalUnits: 'metric',
  };
}

const SUBSTITUTIONS = Object.freeze({
  ski_erg: 'Tall-kneeling banded double-pole pulls plus easy aerobic intervals',
  sled_push: 'Heavy step-ups or an incline march; pattern training only',
  sled_pull: 'Cable, band, or towel hand-over-hand pulls; pattern training only',
  row: 'Seated band rows paired with easy aerobic work',
  farmers_carry: 'Loaded backpack or suitcase carry; pattern training only',
  sandbag_lunge: 'Controlled reverse lunges with a backpack or available load',
  wall_ball: 'Light thrusters to a safe visual target; accuracy is not verified',
});

function stationForTraining(
  standard,
  equipment,
  intensity = 'RPE 6-7',
  doseFraction = 0.4,
  rulesetExact = true,
  includeReadinessContract = false,
) {
  const hasEquipment = !standard.equipmentKey || equipment.includes(standard.equipmentKey);
  const base = {
    id: standard.id,
    name: standard.name,
    distanceMeters: Number.isFinite(standard.distanceMeters)
      ? Math.max(10, Math.round(standard.distanceMeters * doseFraction / 10) * 10)
      : undefined,
    repetitions: Number.isFinite(standard.repetitions)
      ? Math.max(10, Math.round(standard.repetitions * doseFraction / 5) * 5)
      : undefined,
    exactStation: hasEquipment,
    readinessClaim: !hasEquipment ? 'pattern_only' : rulesetExact ? 'station_specific' : 'relative_technique',
    ...(includeReadinessContract ? { exactStationReadiness: hasEquipment && rulesetExact } : {}),
    loadGuidance: hasEquipment ? `${intensity}; do not chase failure` : null,
    prescribedLoadKg: null,
    provenance: `${REGISTRY.rulesVersion}:${standard.id}`,
  };
  if (!hasEquipment) return { ...base, substitute: SUBSTITUTIONS[standard.id] };
  if (!rulesetExact) return base;
  return {
    ...base,
    officialStandard: officialStandardForStation(standard),
  };
}

function buildHyroxStationPrescription(input = {}) {
  const standard = input.standard || {};
  const rulesetStatus = input.ruleset_status ?? standard.rulesetStatus;
  const exactLoadsAvailable = input.exact_loads_available ?? standard.exactLoads;
  const rulesetExact = rulesetStatus === 'exact' && exactLoadsAvailable === true;
  return stationForTraining(
    standard,
    normalizeEquipment(input.equipment),
    input.intensity || 'RPE 6-7',
    Number.isFinite(input.dose_fraction) ? input.dose_fraction
      : Number.isFinite(input.doseFraction) ? input.doseFraction : 0.4,
    rulesetExact,
    true,
  );
}

function officialStandardForStation(standard = {}) {
  return Object.keys(standard).reduce((result, key) => {
    if (/Kg|Meters|repetitions|implements/.test(key) || key === 'loadsByAthleteCategory') result[key] = standard[key];
    return result;
  }, {});
}

function stationSubset(standards, phase, weekIndex) {
  if (phase === 'peak_partial_simulation' || phase === 'specific') return standards.slice(0, 6);
  if (phase === 'sharpen_reduce' || phase === 'taper_race') return standards.slice(0, 4);
  const groups = [standards.slice(0, 4), standards.slice(4)];
  return groups[weekIndex % groups.length];
}

function buildStationSession({ phase, weekIndex, standards, equipment, heavy }) {
  const type = heavy ? 'hyrox_strength' : 'hyrox_skill';
  const title = heavy ? 'HYROX station strength' : 'HYROX station skill';
  const session = sessionBase(
    `hyrox-${weekIndex + 1}-station`,
    type,
    title,
    heavy ? 'Build station force and control without adding running mileage.' : 'Learn efficient station mechanics at submaximal effort.',
  );
  return {
    ...session,
    durationMin: heavy ? 50 : 35,
    intensityBand: heavy ? 'hard' : 'easy_to_moderate',
    hardLowerBody: heavy,
    heavyStationWork: heavy,
    includesRun: false,
    stationSequence: stationSubset(standards, phase, weekIndex)
      .map((station) => stationForTraining(
        station,
        equipment,
        heavy ? 'RPE 7-8' : 'RPE 5-6',
        heavy ? 0.5 : 0.3,
      )),
    runningTarget: null,
  };
}

function buildCompromisedSession({ phase, weekIndex, standards, equipment, safetyHold }) {
  const pairings = phase === 'peak_partial_simulation' ? 6
    : phase === 'specific' ? 5
      : phase === 'sharpen_reduce' ? 3
        : ['orientation_assessment', 'readiness_bridge', 'foundation', 'base_development'].includes(phase) ? 2 : 4;
  const safePairings = safetyHold ? Math.min(2, pairings) : pairings;
  const session = sessionBase(
    `hyrox-${weekIndex + 1}-compromised`,
    'hyrox_compromised',
    'Controlled compromised running',
    'Practice repeatable 1 km rhythm into race-order station work; this replaces the normal quality run.',
  );
  return {
    ...session,
    durationMin: 48 + safePairings * 4,
    intensityBand: 'hard_controlled',
    hardLowerBody: true,
    heavyStationWork: false,
    includesRun: true,
    replacesQualityRun: true,
    runSequenceMeters: Array(safePairings).fill(1000),
    distanceMeters: safePairings * 1000,
    distance_miles: Number((safePairings / 1.609344).toFixed(2)),
    runningStress: 'hard',
    runningTarget: { zone: 'Zone 3', instruction: 'Controlled 1 km rhythm; never sprint the opening repeat.' },
    stationSequence: standards.slice(0, safePairings)
      .map((station) => stationForTraining(
        station,
        equipment,
        safetyHold ? 'RPE 5-6' : 'RPE 6-7',
        safetyHold ? 0.25 : phase === 'peak_partial_simulation' ? 0.6 : phase === 'specific' ? 0.5 : 0.35,
      )),
  };
}

function buildPartialRaceOrderCluster(input = {}) {
  return buildCanonicalPartialRaceOrderCluster({
    phase: 'EVENT_SPECIFIC_DEVELOPMENT',
    role: 'PRIMARY_KEY',
    purpose_reason_codes: ['EVENT_SPECIFIC_ENTRY'],
    station_start_index: 0,
    pair_count: 3,
    run_distance_m: 750,
    station_dose_fraction: 0.5,
    main_work_duration_s: 36 * 60,
    main_set_rpe_range: { minimum: 6, maximum: 8 },
    warmup_running_m: 0,
    cooldown_running_m: 0,
    ...input,
  });
}

function explicitClusterContributionAvailable(eventState = {}, stationIds = STATION_ORDER.slice(0, 3)) {
  if (eventState.format !== 'doubles') return eventState.ruleset_status === 'exact';
  return eventState.ruleset_status === 'exact' && stationIds.every((stationId) => {
    const contribution = eventState.planned_athlete_station_contribution?.[stationId];
    if (!contribution || typeof contribution !== 'object') return false;
    const raw = contribution.distance_m ?? contribution.distanceMeters ?? contribution.repetitions ?? contribution.reps;
    return raw !== null && raw !== undefined && raw !== '' && Number.isFinite(Number(raw)) && Number(raw) > 0;
  });
}

function completeFullPreTaperWeeks(planningDate, eventDate, taperDays = 7) {
  if (parseLocalDate(planningDate) == null || parseLocalDate(eventDate) == null) return 0;
  const finalPreTaperDate = addLocalDays(eventDate, -(Math.max(0, Number(taperDays)) + 1));
  let weekStart = mondayForLocalDate(planningDate);
  if (weekStart < planningDate) weekStart = addLocalDays(weekStart, 7);
  let count = 0;
  while (addLocalDays(weekStart, 6) <= finalPreTaperDate) {
    count += 1;
    weekStart = addLocalDays(weekStart, 7);
  }
  return count;
}

function clusterWeekSelection({ phases, startDate, planningDate, eventDate, availableDays, required }) {
  if (!eventDate) return phases.indexOf('peak_partial_simulation');
  const earliest = addLocalDays(eventDate, -28);
  const latest = addLocalDays(eventDate, -14);
  const candidates = phases.map((phase, index) => {
    const weekStart = addLocalDays(startDate, index * 7);
    const eligibleDates = Array.from({ length: 7 }, (_, offset) => addLocalDays(weekStart, offset))
      .filter((date) => date >= planningDate && date >= earliest && date <= latest && availableDays.includes(weekday(date)));
    return { index, phase, eligibleDates };
  }).filter((entry) => entry.eligibleDates.length);
  if (!candidates.length) return required ? -1 : phases.indexOf('peak_partial_simulation');
  const peakIndex = phases.indexOf('peak_partial_simulation');
  return candidates.slice().sort((left, right) => (
    (left.phase === 'peak_partial_simulation' ? 0 : left.phase === 'specific' ? 1 : 2)
      - (right.phase === 'peak_partial_simulation' ? 0 : right.phase === 'specific' ? 1 : 2)
    || Math.abs(left.index - peakIndex) - Math.abs(right.index - peakIndex)
    || right.index - left.index
  ))[0].index;
}

function legacyWorkoutFamily(session = {}) {
  if (session.workout_family) return session.workout_family;
  if (session.sessionType === 'hyrox_compromised') return 'hyrox_compromised';
  if (session.sessionType === 'hyrox_race') return 'race';
  if (session.sessionType === 'hyrox_skill') return 'hyrox_station_skill';
  if (session.sessionType === 'hyrox_strength') return 'hyrox_station_strength';
  if (session.sessionType === 'long_run') return 'long_aerobic';
  if (session.sessionType === 'easy_run') return 'easy_run';
  if (session.sessionType === 'recovery_run') return 'recovery_run';
  return null;
}

function annotateGoalBackwardWeek(week, { clusterWeek = false, eventFormat, constrained = false } = {}) {
  const partialRequirement = eventFormat === 'doubles'
    ? 'hyrox_team_partial_simulation' : 'hyrox_partial_simulation';
  const hasCluster = clusterWeek && week.days.some((day) => day.sessions.some((session) => (
    legacyWorkoutFamily(session) === 'hyrox_partial_simulation'
  )));
  return {
    ...week,
    days: week.days.map((day) => ({
      ...day,
      sessions: day.sessions.map((session) => {
        const family = legacyWorkoutFamily(session);
        let role = session.role;
        let requirementId = session.requirement_id;
        let supportsRequirementId = session.supports_requirement_id;
        if (hasCluster && family === 'hyrox_partial_simulation') {
          role = 'PRIMARY_KEY';
          requirementId = partialRequirement;
        } else if (hasCluster && family === 'long_aerobic') {
          role = constrained ? 'SUPPORTING' : 'PRIMARY_KEY';
          requirementId = 'long_aerobic';
          supportsRequirementId = constrained ? partialRequirement : undefined;
        } else if (hasCluster && family === 'hyrox_station_skill') {
          role = 'SUPPORTING';
          requirementId = 'hyrox_station_skill';
          supportsRequirementId = partialRequirement;
        } else if (!role) {
          role = ['long_aerobic', 'hyrox_compromised', 'race'].includes(family) ? 'PRIMARY_KEY' : 'SUPPORTING';
          supportsRequirementId = role === 'SUPPORTING' ? (requirementId || 'aerobic_absorption') : undefined;
        }
        return {
          ...session,
          workout_family: family,
          role,
          ...(requirementId ? { requirement_id: requirementId } : {}),
          ...(supportsRequirementId ? { supports_requirement_id: supportsRequirementId } : {}),
          ...(hasCluster && family === 'long_aerobic' ? { hardLowerBody: true } : {}),
        };
      }),
    })),
  };
}

function buildRunSession(id, type, distanceMiles, loadFactor) {
  const long = type === 'long';
  const recovery = type === 'recovery';
  return {
    id,
    kind: 'run',
    sessionType: type === 'easy' ? 'easy_run' : `${type}_run`,
    type,
    title: long ? 'Long easy run' : recovery ? 'Recovery run' : 'Easy aerobic run',
    purpose: long ? 'Preserve running durability as the aerobic foundation.' : 'Maintain the aerobic base without competing with station recovery.',
    distance_miles: Number(Math.max(1.5, distanceMiles * loadFactor).toFixed(1)),
    duration_min: Math.round(Math.max(20, distanceMiles * loadFactor * 11)),
    target_zone: recovery ? 'Zone 1-2' : 'Zone 2',
    runningStress: long ? 'long' : 'easy',
    hardLowerBody: false,
    canonicalUnits: 'metric',
    distanceIsRunAnalyticsMiles: true,
  };
}

function buildBryanPeakWeekWitness(input = {}) {
  const eventState = input.hyrox_event_state;
  if (!eventState || eventState.format !== 'doubles'
    || !explicitClusterContributionAvailable(eventState, STATION_ORDER.slice(0, 3))) {
    throw new Error('bryan_witness_requires_explicit_doubles_contribution');
  }
  const eventDate = input.event_local_date || '2026-09-06';
  const weekStart = input.week_start || '2026-08-17';
  const dates = {
    monday: weekStart,
    tuesday: addLocalDays(weekStart, 1),
    thursday: addLocalDays(weekStart, 3),
    friday: addLocalDays(weekStart, 4),
    sunday: addLocalDays(weekStart, 6),
  };
  const partial = buildPartialRaceOrderCluster({
    session_id: 'bryan-witness-partial-cluster',
    session_revision: 1,
    plan_id: 'bryan-synthetic-witness',
    plan_revision: 1,
    decision_id: 'bryan-synthetic-witness-decision',
    goal_ids: ['bryan-hyrox-goal'],
    scheduled_local_date: dates.tuesday,
    event_local_date: eventDate,
    timezone: 'America/New_York',
    hyrox_event_state: eventState,
    station_start_index: 0,
    pair_count: 3,
    run_distance_m: 750,
    station_dose_fraction: 0.5,
    main_work_duration_s: 36 * 60,
    main_set_rpe_range: { minimum: 6, maximum: 8 },
    warmup_running_m: 2094,
    cooldown_running_m: 2093,
    training_age_class: 'ESTABLISHED',
    role: 'PRIMARY_KEY',
    requirement_id: 'hyrox_team_partial_simulation',
  });
  const sessions = [
    {
      session_id: 'bryan-witness-easy-monday', scheduled_local_date: dates.monday,
      workout_family: 'easy_run', role: 'SUPPORTING', supports_requirement_id: 'hyrox_team_partial_simulation',
      distance_m: 5633, distance_miles: 3.5, duration_min: 35,
    },
    partial,
    {
      session_id: 'bryan-witness-station-skill', scheduled_local_date: dates.thursday,
      workout_family: 'hyrox_station_skill', role: 'SUPPORTING',
      requirement_id: 'hyrox_station_skill', supports_requirement_id: 'hyrox_team_partial_simulation', duration_min: 35,
    },
    {
      session_id: 'bryan-witness-easy-friday', scheduled_local_date: dates.friday,
      workout_family: 'easy_run', role: 'SUPPORTING', supports_requirement_id: 'long_aerobic',
      distance_m: 5633, distance_miles: 3.5, duration_min: 35,
    },
    {
      session_id: 'bryan-witness-long-sunday', scheduled_local_date: dates.sunday,
      workout_family: 'long_aerobic', role: 'PRIMARY_KEY', requirement_id: 'long_aerobic',
      distance_m: 12875, distance_miles: 8, duration_min: 90,
    },
  ];
  const validationSessions = sessions.map((session) => {
    if (session !== partial) return session;
    const legacy = JSON.parse(JSON.stringify(session));
    delete legacy.canonical_workout_schema_version;
    delete legacy.canonical_session_set;
    return legacy;
  });
  const historyMedian = [11, 10, 7, 2, 2, 6, 7, 3];
  const dimensions = [
    'aerobic', 'running_impact', 'lower_body_muscular', 'upper_body_muscular',
    'grip', 'neuromuscular', 'metabolic', 'event_specific_fatigue',
  ];
  const modalityHistory = Object.fromEntries(dimensions.map((dimension, index) => (
    [dimension, Array(6).fill(historyMedian[index])]
  )));
  const weekly = aggregateWeeklyStress(validationSessions);
  const ceilings = calculateFatigueCeilings(modalityHistory, {
    training_age_class: 'ESTABLISHED',
    event_policy: eventPolicyFor('hyrox_doubles_v1'),
    phase: 'EVENT_SPECIFIC_DEVELOPMENT',
    mandatory_hyrox_cluster: true,
    recovery_state: 'NORMAL',
    safety_restriction: false,
    previous_two_weeks_passed: true,
  });
  const overload = evaluateStressBudget(weekly, ceilings);
  const interference = validateInterference(validationSessions, { training_age_class: 'ESTABLISHED' });
  const rolling = validateRollingHardDays(validationSessions, {
    training_age_class: 'ESTABLISHED', spacing_valid: interference.valid,
  });
  const workloadEvidence = {
    valid: weekly.valid && overload.valid && rolling.valid,
    violations: [...weekly.violations, ...overload.violations, ...rolling.violations],
    reason_codes: [...new Set([...weekly.reason_codes, ...overload.reason_codes, ...rolling.reason_codes])],
  };
  const minimumRunning = Math.floor(33796.224 * 0.9);
  const validation = validateGoalBackwardCandidate({ sessions: validationSessions }, {
    available_local_dates: Object.values(dates),
    available_days_count: 5,
    training_age_class: 'ESTABLISHED',
    consistency_state: 'CONSISTENT',
    recovery_state: 'NORMAL',
    safety_action: 'NORMAL',
    event_local_date: eventDate,
    mandatory_hyrox_cluster: true,
    minimum_weekly_demand: { running_m: minimumRunning, required_exposure_count: 2 },
    required_exposure_ledger: {
      due_roles: [
        { requirement_id: 'hyrox_team_partial_simulation', any_of: ['hyrox_partial_simulation'], role: 'PRIMARY_KEY' },
        { requirement_id: 'long_aerobic', any_of: ['long_aerobic'], role: 'PRIMARY_KEY' },
        { requirement_id: 'hyrox_station_skill', any_of: ['hyrox_station_skill'], role: 'SUPPORTING' },
      ],
      unplaceable_requirement_ids: [],
    },
    workload_evidence: workloadEvidence,
    median_ordinary_easy_duration_min: 35,
  });
  const weeklyRunning = Math.round(sessions.reduce((sum, session) => (
    sum + Number(session.running_distance_m ?? session.distance_m ?? 0)
  ), 0));
  return Object.freeze({
    synthetic_fixture: 'BRYAN_17_10',
    event_local_date: eventDate,
    recent_normal_median_distance_m: 33796.224,
    minimum_weekly_running_m: minimumRunning,
    weekly_running_m: weeklyRunning,
    weekly_running_miles: 19,
    sessions: Object.freeze(sessions),
    roles: Object.freeze({
      hyrox_partial_simulation: 'PRIMARY_KEY',
      long_aerobic: 'PRIMARY_KEY',
      hyrox_station_skill: 'SUPPORTING',
    }),
    weekly_stress_vector: weekly.weekly_dimension_sum,
    normal_ceiling_vector: ceilings.normal_ceiling_vector,
    authorized_ceiling_vector: ceilings.authorized_ceiling_vector,
    hard_day_count: weekly.days.filter((day) => day.hard_day).length,
    overload,
    interference,
    rolling_hard_days: rolling,
    validation,
  });
}

function formatPaceLabel(secondsPerMile) {
  const total = Math.round(Number(secondsPerMile));
  if (!Number.isFinite(total) || total <= 0) return null;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}/mi`;
}

function runningSpecificDistances({ weeklyMiles, runDays, raceDistance, specificityIndex }) {
  const minimumRunMiles = 1.5;
  const easyCount = Math.max(0, runDays - 2);
  const weeklyCap = Math.max(runDays * minimumRunMiles, weeklyMiles);
  const progressionStep = Math.min(1, Math.max(0.4, weeklyMiles * 0.04));
  let easyMiles = Math.max(minimumRunMiles, weeklyMiles / runDays * 0.55);
  let qualityMiles = Math.max(2.5, weeklyMiles * 0.18)
    + specificityIndex * Math.min(0.4, weeklyMiles * 0.02);
  let longMiles = Math.min(
    raceDistance * 0.8,
    Math.max(3, weeklyMiles * 0.3) + specificityIndex * progressionStep,
  );
  let excess = easyMiles * easyCount + qualityMiles + longMiles - weeklyCap;
  const reduce = (value) => {
    const available = Math.max(0, value - minimumRunMiles);
    const reduction = Math.min(available, Math.max(0, excess));
    excess -= reduction;
    return value - reduction;
  };
  if (excess > 0) easyMiles = reduce(easyMiles);
  if (excess > 0) qualityMiles = reduce(qualityMiles);
  if (excess > 0) longMiles = reduce(longMiles);
  return {
    easyMiles: Number(easyMiles.toFixed(1)),
    qualityMiles: Number(qualityMiles.toFixed(1)),
    longMiles: Number(longMiles.toFixed(1)),
    weeklyCap: Number(weeklyCap.toFixed(1)),
  };
}

function buildRunningSpecificSession({ id, distanceMiles, race, specificityIndex, safetyHold }) {
  const goalPace = Number(race.goalPaceSecondsPerMile || 0) || null;
  const goalPaceLabel = goalPace ? (race.goalPaceLabel || formatPaceLabel(goalPace)) : null;
  const raceDistanceLabel = Math.abs(Number(race.distanceMiles) - 10) < 0.05
    ? '10-mile'
    : `${Number(race.distanceMiles.toFixed(1))}-mile`;
  const repeats = safetyHold || distanceMiles < 2.5 ? 2 : 3;
  const recoveryMinutes = Math.max(0, repeats - 1) * 2;
  const availableWorkMinutes = Math.floor((distanceMiles * 11 - 18 - recoveryMinutes) / repeats);
  const workMinutes = Math.max(4, Math.min(8, 6 + specificityIndex, availableWorkMinutes));
  const paceInstruction = goalPaceLabel
    ? `${repeats} x ${workMinutes} min at ${goalPaceLabel}`
    : `${repeats} x ${workMinutes} min at controlled ${raceDistanceLabel} effort (RPE 7/10)`;
  return {
    id,
    kind: 'run',
    sessionType: 'running_specific',
    type: 'quality',
    workout_type: 'run',
    workout_id: goalPace ? 'race_pace_intervals' : 'tempo_threshold',
    workout_family: goalPace ? 'race_pace' : 'threshold',
    prescription_basis: 'time',
    title: goalPace
      ? `Controlled ${raceDistanceLabel} target-pace intervals`
      : `Controlled ${raceDistanceLabel} rhythm intervals`,
    purpose: 'Build retained running-race specificity after HYROX recovery without an all-out test.',
    description: 'Practice repeatable 10-mile rhythm with recoveries that keep the session controlled.',
    distance_miles: Number(distanceMiles.toFixed(1)),
    duration_min: Math.max(25, Math.round(distanceMiles * 11)),
    target_zone: goalPace ? 'Controlled race effort' : 'Upper aerobic to threshold (RPE 7/10)',
    pace_target: goalPaceLabel || `Controlled ${raceDistanceLabel} effort (RPE 7/10)`,
    intensity: safetyHold ? 'Moderate' : 'Controlled hard',
    runningStress: safetyHold ? 'moderate' : 'hard',
    hardLowerBody: !safetyHold,
    warmup: ['8-10 min easy running', '3 x 20 sec relaxed strides'],
    steps: [paceInstruction, 'Jog 2 min easy between repetitions; stop before form or pace fades'],
    cooldown: ['8-10 min easy running'],
    progression: 'Extend controlled work time only when every repetition stays even and recoverable.',
    canonicalUnits: 'metric',
    distanceIsRunAnalyticsMiles: true,
    ...(goalPace ? {
      goal_pace_seconds_per_mile: goalPace,
      goal_pace_label: goalPaceLabel,
    } : {}),
  };
}

function buildRaceSession(standards, goalRaceId, eventFormat) {
  const isRelay = eventFormat === 'relay';
  const session = sessionBase(
    'hyrox-race-day',
    'hyrox_race',
    isRelay ? 'HYROX Relay race' : 'HYROX race',
    isRelay
      ? 'Complete this athlete’s two assigned 1 km legs and two team-assigned stations; the four-person team completes the full official order.'
      : eventFormat === 'doubles'
        ? 'Run all eight 1 km legs together and share the eight official stations with your partner in order.'
        : 'Execute eight 1 km runs and the eight official stations in order.',
  );
  const officialTeamStationSequence = standards.map((station) => ({
    ...station,
    officialStandard: officialStandardForStation(station),
    exactStation: true,
    readinessClaim: 'official_race_standard',
    provenance: `${REGISTRY.rulesVersion}:${station.id}`,
  }));
  const athleteRunCount = isRelay ? 2 : 8;
  const stationSequence = isRelay ? [] : officialTeamStationSequence;
  const officialTeamRaceSequence = officialTeamStationSequence.flatMap((station, index) => [
    { kind: 'run', order: index * 2 + 1, distanceMeters: 1000 },
    { kind: 'station', order: index * 2 + 2, station },
  ]);
  return {
    ...session,
    goalRaceId: goalRaceId || null,
    durationMin: null,
    intensityBand: 'race',
    hardLowerBody: true,
    includesRun: true,
    runningStress: 'race',
    eventFormat,
    participationScope: isRelay ? 'relay_athlete' : eventFormat === 'doubles' ? 'doubles_athlete' : 'individual_athlete',
    runSequenceMeters: Array(athleteRunCount).fill(1000),
    distanceMeters: athleteRunCount * 1000,
    distance_miles: Number((athleteRunCount / 1.609344).toFixed(2)),
    stationSequence,
    athleteStationAssignment: isRelay ? {
      stationCount: 2,
      status: 'team_assignment_required',
      instruction: 'Confirm this athlete’s two stations with the relay team before race day.',
    } : null,
    raceSequence: isRelay ? [] : officialTeamRaceSequence,
    officialTeamStationSequence,
    officialTeamRaceSequence,
  };
}

function prescribedLoadPoints(days) {
  return Math.round(days.flatMap((day) => day.sessions).reduce((total, session) => {
    if (['hyrox_race', 'running_race'].includes(session.sessionType)) return total;
    const duration = Number(session.durationMin ?? session.duration_min ?? 0);
    const intensity = session.hardLowerBody || session.runningStress === 'hard'
      ? 1.5
      : session.runningStress === 'long' ? 1.15 : 1;
    return total + duration * intensity;
  }, 0));
}

function normalizedCurrentWeekActivity(currentLoad, startDate, planningDate, runDays) {
  const recentRunLoad = currentLoad?.recentRunLoad || {};
  const suppliedRunWeek = recentRunLoad.currentWeek || null;
  const suppliedStrengthWeek = currentLoad?.currentWeekStrength || null;
  const runSourceStartDate = String(suppliedRunWeek?.startDate || '').slice(0, 10) || null;
  const strengthSourceStartDate = String(suppliedStrengthWeek?.startDate || '').slice(0, 10) || null;
  const mismatchReasons = [];
  if (runSourceStartDate && runSourceStartDate !== startDate) {
    mismatchReasons.push('RUN_ACTIVITY_WEEK_START_MISMATCH');
  }
  if (strengthSourceStartDate && strengthSourceStartDate !== startDate) {
    mismatchReasons.push('STRENGTH_ACTIVITY_WEEK_START_MISMATCH');
  }
  const runWeek = runSourceStartDate === startDate ? suppliedRunWeek : {};
  const strengthWeek = strengthSourceStartDate === startDate ? suppliedStrengthWeek : {};
  const runDates = [...new Set((Array.isArray(runWeek.runDates) ? runWeek.runDates : [])
    .map((date) => String(date || '').slice(0, 10))
    .filter((date) => parseLocalDate(date) != null && date >= startDate && date <= planningDate))].sort();
  const strengthDates = [...new Set((Array.isArray(strengthWeek.dates) ? strengthWeek.dates : [])
    .map((date) => String(date || '').slice(0, 10))
    .filter((date) => parseLocalDate(date) != null && date >= startDate && date <= planningDate))].sort();
  const completedRunCount = Math.max(
    runDates.length,
    Math.floor(finiteNonNegative(runWeek.runCount, 0, 20)),
  );
  const completedStrengthSessions = Math.max(
    strengthDates.length,
    Math.floor(finiteNonNegative(strengthWeek.count, 0, 20)),
  );
  const protection = recentRunLoad.protection?.active ? recentRunLoad.protection : null;
  return {
    completedRunCount,
    completedRunMiles: finiteNonNegative(runWeek.miles, 0, 500),
    completedStrengthSessions,
    completedStrengthLoadPoints: finiteNonNegative(strengthWeek.loadPoints, 0, 2000),
    longRunCompleted: Boolean(runWeek.longRunCompleted),
    remainingRunQuota: Math.max(0, runDays - Math.min(runDays, completedRunCount)),
    remainingHyroxQuota: Math.max(0, 2 - Math.min(2, completedStrengthSessions)),
    runDates,
    strengthDates,
    protection,
    strengthProvenance: strengthWeek?.provenance || null,
    activityReconciliation: {
      expectedStartDate: startDate,
      runSourceStartDate,
      strengthSourceStartDate,
      mismatch: mismatchReasons.length > 0,
      reasons: mismatchReasons,
    },
  };
}

function fullWeekRunningLoad({
  phase,
  runDays,
  weeklyMiles,
  standards,
  equipment,
  safetyHold,
  eventFormat,
  raceWeek,
}) {
  const loadFactor = PHASE_LOAD[phase] || 0.75;
  const easyMiles = buildRunSession(
    'run-load-reference-easy',
    'easy',
    Math.max(2.5, weeklyMiles / Math.max(3, runDays) * 0.75),
    loadFactor,
  ).distance_miles;
  if (raceWeek) {
    const raceMiles = buildRaceSession(standards, null, eventFormat).distance_miles;
    return Number((raceMiles + Math.max(0, runDays - 1) * easyMiles).toFixed(1));
  }
  const compromisedMiles = buildCompromisedSession({
    phase,
    weekIndex: 0,
    standards,
    equipment,
    safetyHold,
  }).distance_miles;
  const longMiles = buildRunSession(
    'run-load-reference-long',
    'long',
    Math.max(4, weeklyMiles * 0.34),
    loadFactor,
  ).distance_miles;
  return Number((
    compromisedMiles
    + longMiles
    + Math.max(0, runDays - 2) * easyMiles
  ).toFixed(1));
}

function allocatePartialRunMiles(budget, count, longIndex, easyMiles, longMiles) {
  if (count <= 0) return [];
  const minimumTenths = 15;
  const budgetTenths = Math.floor(finiteNonNegative(budget, 0, 500) * 10 + 0.001);
  if (budgetTenths < minimumTenths * count) return [];
  const targets = Array.from({ length: count }, (_, index) => Math.max(
    minimumTenths,
    Math.round((index === longIndex ? longMiles : easyMiles) * 10),
  ));
  const allocations = Array(count).fill(minimumTenths);
  let remaining = Math.min(budgetTenths, targets.reduce((sum, value) => sum + value, 0))
    - minimumTenths * count;
  const priority = [
    ...(longIndex >= 0 ? [longIndex] : []),
    ...Array.from({ length: count }, (_, index) => index).filter((index) => index !== longIndex),
  ];
  while (remaining > 0) {
    let changed = false;
    for (const index of priority) {
      if (remaining <= 0) break;
      if (allocations[index] >= targets[index]) continue;
      allocations[index] += 1;
      remaining -= 1;
      changed = true;
    }
    if (!changed) break;
  }
  return allocations.map((value) => value / 10);
}

function buildCurrentWeek({
  startDate,
  phase,
  weekIndex,
  totalWeeks,
  eventDate,
  goalRaceId,
  runDays,
  availableDays,
  weeklyMiles,
  standards,
  equipment,
  planningDate,
  safetyHold,
  eventFormat,
  currentWeekActivity,
  runningLoadCap,
  usePartialRaceOrderCluster = false,
  hyroxEventState = null,
  trainingAgeClass = 'ESTABLISHED',
  clusterPairCount = 3,
  eventTimezone = 'UTC',
  partialClusterWindow = null,
}) {
  const days = Array.from({ length: 7 }, (_, offset) => {
    const date = addLocalDays(startDate, offset);
    return { date, day: weekday(date), sessions: [] };
  });
  const loadFactor = PHASE_LOAD[phase] || 0.75;
  const allowed = days.map((day, index) => (
    day.date >= planningDate && availableDays.includes(day.day) ? index : null
  )).filter(Number.isInteger);
  const runCompletedDates = new Set(currentWeekActivity.runDates);
  const strengthCompletedDates = new Set(currentWeekActivity.strengthDates);
  const isRaceWeek = Boolean(eventDate && eventDate >= startDate && eventDate <= addLocalDays(startDate, 6));
  const raceSafetyWindow = Boolean(eventDate && days.some((day) => (
    day.date >= planningDate && isRaceSafetyDate(day.date, eventDate)
  )));
  const eventSlot = isRaceWeek ? days.findIndex((day) => day.date === eventDate) : -1;
  let scheduledRunExposures = 0;
  let scheduledHyroxSessions = 0;
  const boundedWeeklyRunningLoad = finiteNonNegative(runningLoadCap, 0, 500);
  const boundedRemainingMileage = Math.max(
    0,
    boundedWeeklyRunningLoad - currentWeekActivity.completedRunMiles,
  );
  let remainingMileageBudget = boundedRemainingMileage;

  if (eventSlot >= 0 && days[eventSlot].date >= planningDate) {
    const race = buildRaceSession(standards, goalRaceId, eventFormat);
    days[eventSlot].sessions.push(race);
    remainingMileageBudget = Math.max(0, remainingMileageBudget - Number(race.distance_miles || 0));
    scheduledRunExposures += 1;
  }

  let remainingRunQuota = Math.max(0, currentWeekActivity.remainingRunQuota - scheduledRunExposures);
  let remainingHyroxQuota = currentWeekActivity.remainingHyroxQuota;
  const protection = currentWeekActivity.protection;
  const hardRunsThrough = parseLocalDate(protection?.hardRunsThrough) == null ? null : protection.hardRunsThrough;
  const sessionFreeSlots = (completedDates = new Set()) => allowed.filter((slot) => (
    slot !== eventSlot && !completedDates.has(days[slot].date)
  ));

  const compromisedCandidates = sessionFreeSlots(new Set([...runCompletedDates, ...strengthCompletedDates]))
    .filter((slot) => (
      !isRaceWeek
      && !isRaceSafetyDate(days[slot].date, eventDate)
      && (!hardRunsThrough || days[slot].date > hardRunsThrough)
      && (!usePartialRaceOrderCluster || !partialClusterWindow
        || (days[slot].date >= partialClusterWindow.earliest_local_date
          && days[slot].date <= partialClusterWindow.latest_local_date))
    ));
  const partialSlot = compromisedCandidates.length ? nearestSlot(3, compromisedCandidates) : null;
  const compromised = usePartialRaceOrderCluster && Number.isInteger(partialSlot)
    ? buildPartialRaceOrderCluster({
      session_id: `hyrox-${weekIndex + 1}-partial-cluster`,
      plan_id: 'hyrox-plan-preview',
      decision_id: 'hyrox-plan-preview-decision',
      goal_ids: goalRaceId ? [String(goalRaceId)] : [],
      scheduled_local_date: days[partialSlot].date,
      event_local_date: eventDate,
      timezone: eventTimezone,
      hyrox_event_state: hyroxEventState,
      requirement_id: hyroxEventState?.format === 'doubles'
        ? 'hyrox_team_partial_simulation' : 'hyrox_partial_simulation',
      pair_count: clusterPairCount,
      run_distance_m: 1000,
      warmup_running_m: 1500,
      cooldown_running_m: 1500,
      training_age_class: trainingAgeClass,
    })
    : buildCompromisedSession({
      phase: phase === 'peak_partial_simulation' && usePartialRaceOrderCluster ? 'specific' : phase,
      weekIndex, standards, equipment, safetyHold,
    });
  if (remainingHyroxQuota > 0
    && remainingRunQuota > 0
    && remainingMileageBudget + 0.001 >= Number(compromised.distance_miles || 0)
    && compromisedCandidates.length) {
    const slot = partialSlot;
    days[slot].sessions.push(compromised);
    remainingMileageBudget = Math.max(0, remainingMileageBudget - Number(compromised.distance_miles || 0));
    remainingHyroxQuota -= 1;
    remainingRunQuota -= 1;
    scheduledHyroxSessions += 1;
    scheduledRunExposures += 1;
  }

  const stationSlots = sessionFreeSlots(strengthCompletedDates);
  const usedStationSlots = new Set();
  const stationLimit = raceSafetyWindow ? Math.min(1, remainingHyroxQuota) : remainingHyroxQuota;
  let remainingStationQuota = stationLimit;
  while (remainingStationQuota > 0 && stationSlots.length) {
    const candidates = stationSlots.filter((slot) => !usedStationSlots.has(slot));
    if (!candidates.length) break;
    const slot = nearestSlot(1 + scheduledHyroxSessions * 3, candidates);
    usedStationSlots.add(slot);
    const station = buildStationSession({ phase, weekIndex, standards, equipment, heavy: false });
    if (scheduledHyroxSessions > 0) station.id = `${station.id}-${scheduledHyroxSessions + 1}`;
    days[slot].sessions.push(station);
    remainingHyroxQuota -= 1;
    remainingStationQuota -= 1;
    scheduledHyroxSessions += 1;
  }

  const occupiedRunSlots = new Set(days.map((day, index) => (
    day.sessions.some((session) => session.kind === 'run' || session.includesRun) ? index : null
  )).filter(Number.isInteger));
  const runSlots = sessionFreeSlots(runCompletedDates).filter((slot) => !occupiedRunSlots.has(slot));
  const affordableRuns = Math.floor((remainingMileageBudget + 0.001) / 1.5);
  const runCount = Math.min(remainingRunQuota, runSlots.length, affordableRuns);
  const selectedRunSlots = runSlots.slice().sort((left, right) => right - left)
    .slice(0, runCount).sort((left, right) => left - right);
  const longIndex = currentWeekActivity.longRunCompleted || isRaceWeek
    ? -1
    : selectedRunSlots.map((slot, index) => ({ slot, index }))
      .filter(({ slot }) => (
        !isRaceSafetyDate(days[slot].date, eventDate)
        && (!hardRunsThrough || days[slot].date > hardRunsThrough)
      ))
      .at(-1)?.index ?? -1;
  const easyMiles = buildRunSession(
    'run-partial-reference-easy',
    'easy',
    Math.max(2.5, weeklyMiles / Math.max(3, runDays) * 0.75),
    loadFactor,
  ).distance_miles;
  const longMiles = buildRunSession(
    'run-partial-reference-long',
    'long',
    Math.max(4, weeklyMiles * 0.34),
    loadFactor,
  ).distance_miles;
  const distances = allocatePartialRunMiles(
    remainingMileageBudget,
    selectedRunSlots.length,
    longIndex,
    easyMiles,
    longMiles,
  );
  selectedRunSlots.forEach((slot, index) => {
    const type = index === longIndex ? 'long' : (protection ? 'recovery' : 'easy');
    const desiredMiles = distances[index];
    days[slot].sessions.push(buildRunSession(
      `run-${weekIndex + 1}-partial-${index + 1}`,
      type,
      desiredMiles,
      1,
    ));
    scheduledRunExposures += 1;
  });

  return {
    week: weekIndex + 1,
    startDate,
    endDate: addLocalDays(startDate, 6),
    phase,
    purpose: phase.replaceAll('_', ' '),
    loadFactor,
    plannedLoadPoints: prescribedLoadPoints(days),
    currentWeekConstraint: {
      status: 'partial_current_week',
      planningDate,
      requestedRunDaysPerWeek: runDays,
      completedRunCount: currentWeekActivity.completedRunCount,
      completedRunMiles: Number(currentWeekActivity.completedRunMiles.toFixed(1)),
      scheduledRunExposures,
      remainingRunQuota: currentWeekActivity.remainingRunQuota,
      requestedHyroxSessionsPerWeek: 2,
      completedStrengthSessions: currentWeekActivity.completedStrengthSessions,
      completedStrengthLoadPoints: currentWeekActivity.completedStrengthLoadPoints,
      scheduledHyroxSessions,
      remainingHyroxQuota: currentWeekActivity.remainingHyroxQuota,
      boundedWeeklyRunningLoad: Number(boundedWeeklyRunningLoad.toFixed(1)),
      remainingMileageBudget: Number(boundedRemainingMileage.toFixed(1)),
      scheduledRunningMiles: Number(days.flatMap((day) => day.sessions).reduce((sum, session) => (
        sum + Number((session.kind === 'run' || session.includesRun) ? session.distance_miles || 0 : 0)
      ), 0).toFixed(1)),
      recentRunProtectionApplied: Boolean(protection),
      raceSafetyWindow,
      activityReconciliation: currentWeekActivity.activityReconciliation,
    },
    days,
    totalWeeks,
  };
}

function buildWeek({
  startDate,
  phase,
  weekIndex,
  totalWeeks,
  eventDate,
  goalRaceId,
  runDays,
  availableDays,
  weeklyMiles,
  standards,
  equipment,
  planningDate,
  safetyHold,
  eventFormat,
  currentWeekActivity = null,
  precedingHardOrLongRunDates = [],
  precedingHardLowerBodyDates = [],
  currentWeekRunningLoadCap = null,
  usePartialRaceOrderCluster = false,
  hyroxEventState = null,
  trainingAgeClass = 'ESTABLISHED',
  clusterPairCount = 3,
  eventTimezone = 'UTC',
  partialClusterWindow = null,
}) {
  if (currentWeekActivity) {
    return buildCurrentWeek({
      startDate,
      phase,
      weekIndex,
      totalWeeks,
      eventDate,
      goalRaceId,
      runDays,
      availableDays,
      weeklyMiles,
      standards,
      equipment,
      planningDate,
      safetyHold,
      eventFormat,
      currentWeekActivity,
      runningLoadCap: currentWeekRunningLoadCap,
      usePartialRaceOrderCluster,
      hyroxEventState,
      trainingAgeClass,
      clusterPairCount,
      eventTimezone,
      partialClusterWindow,
    });
  }
  const days = Array.from({ length: 7 }, (_, offset) => {
    const date = addLocalDays(startDate, offset);
    return { date, day: weekday(date), sessions: [] };
  });
  const allowed = days.map((day, index) => availableDays.includes(day.day) ? index : null).filter(Number.isInteger);
  const isRaceWeek = Boolean(eventDate && eventDate >= startDate && eventDate <= addLocalDays(startDate, 6));
  const loadFactor = PHASE_LOAD[phase] || 0.75;
  const eventSlot = isRaceWeek ? days.findIndex((day) => day.date === eventDate) : -1;
  const hardRunSlots = isRaceWeek
    ? []
    : allowed.filter((slot) => !isRaceSafetyDate(days[slot].date, eventDate));
  const used = new Set();
  let longSlot = hardRunSlots.length ? nearestSlot(6, hardRunSlots, used) : null;
  let compromisedCandidates;
  let compromisedSlot;
  if (usePartialRaceOrderCluster) {
    compromisedCandidates = hardRunSlots.filter((slot) => (
      (!partialClusterWindow
        || (days[slot].date >= partialClusterWindow.earliest_local_date
          && days[slot].date <= partialClusterWindow.latest_local_date))
    ));
    const jointPlacements = compromisedCandidates.flatMap((clusterSlot) => (
      hardRunSlots.filter((candidateLongSlot) => (
        candidateLongSlot !== clusterSlot
        && Math.abs(candidateLongSlot - clusterSlot) >= 2
        && respectsRollingHardLowerBodyCap([
          ...precedingHardLowerBodyDates,
          days[clusterSlot].date,
          days[candidateLongSlot].date,
        ])
      )).map((candidateLongSlot) => ({ clusterSlot, longSlot: candidateLongSlot }))
    )).sort((left, right) => (
      Math.abs(left.clusterSlot - 3) + Math.abs(left.longSlot - 6)
      - Math.abs(right.clusterSlot - 3) - Math.abs(right.longSlot - 6)
      || left.clusterSlot - right.clusterSlot
      || right.longSlot - left.longSlot
    ));
    if (jointPlacements.length) {
      compromisedSlot = jointPlacements[0].clusterSlot;
      longSlot = jointPlacements[0].longSlot;
    } else {
      compromisedSlot = null;
    }
  } else {
    if (Number.isInteger(longSlot)) used.add(longSlot);
    compromisedCandidates = hardRunSlots.filter((slot) => (
      !used.has(slot)
      && respectsRollingHardLowerBodyCap([
        ...precedingHardLowerBodyDates,
        days[slot].date,
      ])
    ));
    compromisedSlot = compromisedCandidates.length
      ? nearestSlot(3, compromisedCandidates, used)
      : null;
  }
  if (Number.isInteger(longSlot)) used.add(longSlot);
  if (Number.isInteger(compromisedSlot)) used.add(compromisedSlot);
  const stationAvailable = isRaceWeek ? allowed.filter((slot) => slot !== eventSlot) : allowed;
  const hardStationPhase = ['build', 'peak_partial_simulation', 'specific'].includes(phase)
    && !usePartialRaceOrderCluster;
  const stationPool = stationAvailable.length ? stationAvailable : allowed;
  const unoccupiedStationSlots = stationPool.filter((slot) => !used.has(slot));
  const stationCandidates = (unoccupiedStationSlots.length ? unoccupiedStationSlots : stationPool)
    .slice()
    .sort((left, right) => Math.abs(left - 1) - Math.abs(right - 1) || left - right);
  const isSafeStationSlot = (slot) => (
    (!Number.isInteger(compromisedSlot) || Math.abs(slot - compromisedSlot) > 1)
    && (!Number.isInteger(longSlot) || Math.abs(slot - longSlot) > 1)
    && precedingHardOrLongRunDates.every((runDate) => (
      Math.abs(daysBetweenLocalDates(days[slot].date, runDate)) > 1
    ))
  );
  const currentWeekHardLowerBodyDates = [
    ...(Number.isInteger(compromisedSlot) ? [days[compromisedSlot].date] : []),
    ...(eventSlot >= 0 ? [days[eventSlot].date] : []),
  ];
  const safeStationSlot = stationCandidates.find(isSafeStationSlot);
  const safeHeavyStationSlot = stationCandidates.find((slot) => (
    isSafeStationSlot(slot)
    && !isRaceSafetyDate(days[slot].date, eventDate)
    && respectsRollingHardLowerBodyCap([
      ...precedingHardLowerBodyDates,
      ...currentWeekHardLowerBodyDates,
      days[slot].date,
    ])
  ));
  const stationSlot = safeHeavyStationSlot ?? safeStationSlot ?? stationCandidates[0];
  const heavyStation = hardStationPhase
    && safeHeavyStationSlot != null
    && !isRaceWeek
    && !safetyHold;

  if (!isRaceWeek) {
    days[stationSlot].sessions.push(buildStationSession({ phase, weekIndex, standards, equipment, heavy: heavyStation }));
    if (Number.isInteger(compromisedSlot)) {
      days[compromisedSlot].sessions.push(usePartialRaceOrderCluster
        ? buildPartialRaceOrderCluster({
          session_id: `hyrox-${weekIndex + 1}-partial-cluster`,
          plan_id: 'hyrox-plan-preview',
          decision_id: 'hyrox-plan-preview-decision',
          goal_ids: goalRaceId ? [String(goalRaceId)] : [],
          scheduled_local_date: days[compromisedSlot].date,
          event_local_date: eventDate,
          timezone: eventTimezone,
          hyrox_event_state: hyroxEventState,
          requirement_id: hyroxEventState?.format === 'doubles'
            ? 'hyrox_team_partial_simulation' : 'hyrox_partial_simulation',
          pair_count: clusterPairCount,
          run_distance_m: 1000,
          warmup_running_m: 1500,
          cooldown_running_m: 1500,
          training_age_class: trainingAgeClass,
        })
        : buildCompromisedSession({
          phase: phase === 'peak_partial_simulation' && hyroxEventState ? 'specific' : phase,
          weekIndex, standards, equipment, safetyHold,
        }));
    }
    if (Number.isInteger(longSlot)) {
      const ordinaryLongBase = Math.max(4, weeklyMiles * 0.34);
      let longBase = ordinaryLongBase;
      if (usePartialRaceOrderCluster) {
        const clusterMiles = days.flatMap((day) => day.sessions)
          .find((session) => session.workout_family === 'hyrox_partial_simulation')?.distance_miles || 0;
        const projectedEasy = buildRunSession(
          'cluster-week-easy-projection',
          'easy',
          Math.max(2.5, weeklyMiles / Math.max(3, runDays) * 0.75),
          loadFactor,
        ).distance_miles;
        const floorMiles = Math.floor(weeklyMiles * 1609.344 * 0.9) / 1609.344;
        const neededLongMiles = Math.max(
          ordinaryLongBase * loadFactor,
          floorMiles - Number(clusterMiles) - Math.max(0, runDays - 2) * projectedEasy,
        );
        longBase = neededLongMiles / loadFactor;
      }
      days[longSlot].sessions.push(buildRunSession(
        `run-${weekIndex + 1}-long`, 'long', longBase, loadFactor,
      ));
    }
  } else {
    days[Math.max(0, eventSlot)].sessions.push(buildRaceSession(standards, goalRaceId, eventFormat));
    days[stationSlot].sessions.push(buildStationSession({ phase, weekIndex, standards, equipment, heavy: false }));
  }

  const existingRunExposures = () => days.flatMap((day) => day.sessions)
    .filter((session) => session.kind === 'run' || session.includesRun).length;
  const easyTargets = [0, 4, 5, 2, 1, 3, 6];
  while (existingRunExposures() < runDays) {
    const target = easyTargets.shift();
    const slot = nearestSlot(target ?? 0, allowed, new Set(days.map((day, index) => (
      day.sessions.some((session) => session.kind === 'run' || session.includesRun) ? index : null
    )).filter(Number.isInteger)));
    const type = phase === 'post_hyrox_recovery' ? 'recovery' : 'easy';
    days[slot].sessions.push(buildRunSession(`run-${weekIndex + 1}-${existingRunExposures() + 1}`, type, Math.max(2.5, weeklyMiles / Math.max(3, runDays) * 0.75), loadFactor));
  }
  for (const day of days) {
    if (day.date < planningDate && !day.sessions.some((session) => session.sessionType === 'hyrox_race')) day.sessions = [];
  }
  return {
    week: weekIndex + 1,
    startDate,
    endDate: addLocalDays(startDate, 6),
    phase,
    purpose: phase.replaceAll('_', ' '),
    loadFactor,
    plannedLoadPoints: prescribedLoadPoints(days),
    days,
    totalWeeks,
  };
}

function buildRunningWeek({
  startDate,
  phase,
  weekIndex,
  runDays,
  availableDays,
  weeklyMiles,
  race,
  specificityIndex = 0,
  safetyHold = false,
}) {
  const days = Array.from({ length: 7 }, (_, offset) => {
    const date = addLocalDays(startDate, offset);
    return { date, day: weekday(date), sessions: [] };
  });
  const allowed = days.map((day, index) => availableDays.includes(day.day) ? index : null).filter(Number.isInteger);
  const raceWeek = race.eventLocalDate >= startDate && race.eventLocalDate <= addLocalDays(startDate, 6);
  const loadFactor = PHASE_LOAD[phase];
  const longSlot = nearestSlot(6, allowed);
  const specificDistances = runningSpecificDistances({
    weeklyMiles,
    runDays,
    raceDistance: race.distanceMiles,
    specificityIndex,
  });
  if (raceWeek) {
    const slot = days.findIndex((day) => day.date === race.eventLocalDate);
    days[slot].sessions.push({
      id: `secondary-race-${weekIndex + 1}`,
      kind: 'run',
      sessionType: 'running_race',
      type: 'race',
      title: race.name,
      purpose: 'Execute the retained running goal after HYROX recovery and bounded specificity.',
      goalRaceId: race.raceId || null,
      distance_miles: race.distanceMiles,
      runningStress: 'race',
      hardLowerBody: true,
      target_zone: 'Race effort',
      pace_target: race.goalPaceLabel || 'Goal race effort',
      ...(race.goalPaceSecondsPerMile ? {
        goal_pace_seconds_per_mile: race.goalPaceSecondsPerMile,
        goal_pace_label: race.goalPaceLabel,
      } : {}),
    });
  } else if (phase !== 'post_hyrox_recovery') {
    const qualityCandidates = allowed.filter((slot) => slot !== longSlot && Math.abs(slot - longSlot) > 1);
    const qualitySlot = nearestSlot(3, qualityCandidates.length ? qualityCandidates : allowed, new Set([longSlot]));
    days[qualitySlot].sessions.push(buildRunningSpecificSession({
      id: `secondary-${weekIndex + 1}-quality`,
      distanceMiles: specificDistances.qualityMiles,
      race,
      specificityIndex,
      safetyHold,
    }));
    days[longSlot].sessions.push(buildRunSession(
      `secondary-${weekIndex + 1}-long`,
      'long',
      specificDistances.longMiles,
      1,
    ));
  }
  const exposures = () => days.flatMap((day) => day.sessions).filter((session) => session.kind === 'run').length;
  const targets = [0, 2, 4, 5, 1, 3, 6];
  while (exposures() < runDays) {
    const occupied = new Set(days.map((day, index) => day.sessions.some((session) => session.kind === 'run') ? index : null).filter(Number.isInteger));
    const slot = nearestSlot(targets.shift() ?? 0, allowed, occupied);
    days[slot].sessions.push(buildRunSession(
      `secondary-${weekIndex + 1}-easy-${exposures() + 1}`,
      phase === 'post_hyrox_recovery' ? 'recovery' : 'easy',
      phase === 'running_specific' ? specificDistances.easyMiles : Math.max(2, weeklyMiles / runDays * 0.65),
      phase === 'running_specific' ? 1 : loadFactor,
    ));
  }
  if (raceWeek) {
    for (const day of days) {
      if (day.date > race.eventLocalDate) day.sessions = [];
    }
  }
  return {
    week: weekIndex + 1,
    startDate,
    endDate: addLocalDays(startDate, 6),
    phase,
    purpose: phase.replaceAll('_', ' '),
    loadFactor,
    plannedLoadPoints: prescribedLoadPoints(days),
    ...(phase === 'running_specific' ? { runningLoadCapMiles: specificDistances.weeklyCap } : {}),
    days,
  };
}

function generateHyroxPlan(input = {}) {
  const includeGoalBackwardV24 = ['preview', 'on'].includes(getGoalBackwardV24Mode());
  const event = input.event || {};
  const planningDate = String(input.planningLocalDate || '');
  if (parseLocalDate(planningDate) == null) throw new Error('invalid_planning_local_date');
  if (!event.eventTimezone || !isIanaTimezone(event.eventTimezone)) throw new Error('invalid_event_timezone');
  const daysToEvent = daysToEventForEvent(event, { planningLocalDate: planningDate });
  const runway = classifyHyroxRunway(daysToEvent);
  const resolved = resolveHyroxStandard({
    format: event.format,
    category: event.category,
    rulesVersion: event.rulesVersion,
  });
  if (resolved.status !== 'exact') throw new Error(`hyrox_standard_${resolved.status}`);
  const athlete = input.athlete || {};
  const requestedRunDays = Number(athlete.runDaysPerWeek ?? athlete.run_days_per_week ?? 3);
  if (![3, 4].includes(requestedRunDays)) throw new Error('hyrox_run_days_must_be_3_or_4');
  const weeklyMiles = Math.max(6, finiteNonNegative(
    // Routes prepare this value from bounded recent history. It is authoritative
    // for direct engine callers too; profile mileage is only the fallback when
    // no prepared current-load baseline is supplied.
    input.currentLoad?.weeklyMiles
      ?? athlete.weeklyMilesCurrent
      ?? athlete.weekly_miles_current,
    12,
    300,
  ));
  const readiness = String(athlete.readiness || input.currentLoad?.readiness || '').toLowerCase();
  const safetyHold = Boolean(
    athlete.comebackMode
    || athlete.comeback_mode
    || ['low', 'recovery'].includes(readiness),
  );
  const effectiveWeeklyMiles = weeklyMiles * (safetyHold ? 0.8 : 1);
  const availableDays = normalizeAvailableDays(input.availableDays);
  if (availableDays.length < requestedRunDays) throw new Error('insufficient_available_days');
  const equipment = normalizeEquipment(input.equipment);
  let hyroxEventState = null;
  let hyroxPerformanceBudget = null;
  if (includeGoalBackwardV24) {
    hyroxEventState = buildCanonicalHyroxEventState({
      ...(event.hyroxEventState || {}),
      ...(input.hyroxEventState || {}),
      athlete_id: input.hyroxEventState?.athlete_id
        ?? event.hyroxEventState?.athlete_id
        ?? athlete.id
        ?? athlete.athleteId
        ?? null,
      format: resolved.format === 'doubles' ? 'doubles' : 'singles',
      event_format: resolved.format,
      registered_division: resolved.category,
      ruleset_id: resolved.rulesetId,
      ruleset_version: resolved.rulesetVersion,
      partner_id: input.hyroxEventState?.partner_id
        ?? event.hyroxEventState?.partner_id
        ?? event.partnerId
        ?? event.partner_id
        ?? null,
      partner_placeholder: input.hyroxEventState?.partner_placeholder
        ?? event.hyroxEventState?.partner_placeholder
        ?? event.partnerPlaceholder
        ?? event.partner_placeholder
        ?? null,
    });
  }
  const window = planWeekWindow(planningDate, event.eventLocalDate || null);
  const totalWeeks = runway === 'foundation_only' ? 8 : window.weeks;
  const startDate = window.startDate;
  const hasElapsedCurrentWeekDays = planningDate > startDate;
  const currentWeekActivity = normalizedCurrentWeekActivity(
    input.currentLoad || {},
    startDate,
    planningDate,
    requestedRunDays,
  );
  const hasCompletedCurrentWeekActivity = currentWeekActivity.completedRunCount > 0
    || currentWeekActivity.completedRunMiles > 0
    || currentWeekActivity.completedStrengthSessions > 0;
  const phases = allocatePhases(runway, totalWeeks);
  const fullPreTaperWeeks = event.eventLocalDate
    ? completeFullPreTaperWeeks(planningDate, event.eventLocalDate, 7) : 0;
  const mandatoryCluster = Boolean(
    includeGoalBackwardV24
    && daysToEvent >= 28
    && fullPreTaperWeeks >= 4
  );
  const trainingAgeClass = String(athlete.training_age_class ?? athlete.trainingAgeClass
    ?? (safetyHold ? 'RETURNING' : 'ESTABLISHED')).toUpperCase();
  const clusterPairCount = ['BEGINNER', 'RETURNING'].includes(trainingAgeClass) ? 2 : 3;
  const clusterStations = STATION_ORDER.slice(0, clusterPairCount);
  const clusterBlockedReason = !includeGoalBackwardV24 ? null
    : safetyHold ? 'SAFETY_RECOVERY_HOLD'
      : !explicitClusterContributionAvailable(hyroxEventState, clusterStations)
        ? 'DOUBLES_CONTRIBUTION_UNKNOWN' : null;
  const clusterWeekIndex = includeGoalBackwardV24 && !clusterBlockedReason
    ? clusterWeekSelection({
      phases,
      startDate,
      planningDate,
      eventDate: event.eventLocalDate,
      availableDays,
      required: mandatoryCluster,
    }) : -1;
  const partialClusterWindow = event.eventLocalDate ? {
    earliest_local_date: addLocalDays(event.eventLocalDate, -28),
    latest_local_date: addLocalDays(event.eventLocalDate, -14),
  } : null;
  const currentWeekRace = Boolean(
    event.eventLocalDate
    && event.eventLocalDate >= startDate
    && event.eventLocalDate <= addLocalDays(startDate, 6)
  );
  const currentFullWeekRunningLoad = fullWeekRunningLoad({
    phase: phases[0],
    runDays: requestedRunDays,
    weeklyMiles: effectiveWeeklyMiles,
    standards: resolved.stations,
    equipment,
    safetyHold,
    eventFormat: resolved.format,
    raceWeek: currentWeekRace,
  });
  const nextWeekStart = addLocalDays(startDate, 7);
  const nextWeekRace = Boolean(
    event.eventLocalDate
    && event.eventLocalDate >= nextWeekStart
    && event.eventLocalDate <= addLocalDays(nextWeekStart, 6)
  );
  const nextFullWeekRunningLoad = phases[1] ? fullWeekRunningLoad({
    phase: phases[1],
    runDays: requestedRunDays,
    weeklyMiles: effectiveWeeklyMiles,
    standards: resolved.stations,
    equipment,
    safetyHold,
    eventFormat: resolved.format,
    raceWeek: nextWeekRace,
  }) : currentFullWeekRunningLoad;
  const currentWeekRunningLoadCap = Math.min(
    currentFullWeekRunningLoad,
    nextFullWeekRunningLoad,
  );
  const weeks = [];
  for (const [weekIndex, phase] of phases.entries()) {
    const precedingHardLowerBodyDates = weeks
      .flatMap((week) => week.days)
      .flatMap((day) => day.sessions
        .filter((session) => session.hardLowerBody)
        .map(() => day.date));
    const precedingHardOrLongRunDates = (weeks.at(-1)?.days || [])
      .flatMap((day) => day.sessions.map((session) => ({ date: day.date, session })))
      .filter(({ session }) => (
        ['hard', 'long', 'race'].includes(session.runningStress)
        && (session.kind === 'run' || session.includesRun)
      ))
      .map(({ date }) => date);
    const builtWeek = buildWeek({
      startDate: addLocalDays(startDate, weekIndex * 7),
      phase,
      weekIndex,
      totalWeeks,
      eventDate: event.eventLocalDate || null,
      goalRaceId: event.raceId || null,
      runDays: requestedRunDays,
      availableDays,
      weeklyMiles: effectiveWeeklyMiles,
      standards: resolved.stations,
      equipment,
      planningDate,
      safetyHold,
      eventFormat: resolved.format,
      currentWeekActivity: weekIndex === 0 && (hasElapsedCurrentWeekDays || hasCompletedCurrentWeekActivity)
        ? currentWeekActivity
        : null,
      precedingHardOrLongRunDates,
      precedingHardLowerBodyDates,
      currentWeekRunningLoadCap: weekIndex === 0 ? currentWeekRunningLoadCap : null,
      usePartialRaceOrderCluster: weekIndex === clusterWeekIndex,
      hyroxEventState,
      trainingAgeClass,
      clusterPairCount,
      eventTimezone: event.eventTimezone,
      partialClusterWindow: weekIndex === clusterWeekIndex ? partialClusterWindow : null,
    });
    weeks.push(includeGoalBackwardV24
      ? annotateGoalBackwardWeek(builtWeek, {
        clusterWeek: weekIndex === clusterWeekIndex,
        eventFormat: resolved.format,
        constrained: availableDays.length <= 4 || ['caution', 'recovery', 'low'].includes(readiness),
      })
      : builtWeek);
  }

  const hyroxGoal = {
    kind: 'hyrox',
    eventKind: 'hyrox',
    raceId: event.raceId || null,
    name: event.name || 'HYROX event',
    location: event.location || null,
    date: event.eventLocalDate || null,
    eventLocalDate: event.eventLocalDate || null,
    eventTimezone: event.eventTimezone,
    division: resolved.format,
    category: resolved.category,
    goalType: Number(event.goalTimeSeconds) > 0 ? 'performance' : 'completion',
    goalTimeSeconds: Number(event.goalTimeSeconds) > 0 ? Math.round(Number(event.goalTimeSeconds)) : null,
    rulesVersion: resolved.rulesVersion,
    ...(includeGoalBackwardV24 ? {
      rulesetId: resolved.rulesetId,
      rulesetVersion: resolved.rulesetVersion,
      priority: 'A',
      feasibility_status: 'unvalidated',
    } : {}),
    runningPriority: event.runningPriority || 'maintain',
  };
  const goals = [hyroxGoal];
  const secondary = input.secondaryRace;
  if (secondary) {
    if (runway === 'foundation_only') throw new Error('secondary_race_requires_dated_hyrox');
    if (parseLocalDate(secondary.eventLocalDate) == null) throw new Error('invalid_secondary_race_date');
    const gapDays = daysBetweenLocalDates(secondary.eventLocalDate, event.eventLocalDate);
    if (gapDays < 21) throw new Error('secondary_race_spacing');
    const secondaryStart = addLocalDays(mondayForLocalDate(event.eventLocalDate), 7);
    const secondaryWeeks = Math.floor(daysBetweenLocalDates(
      mondayForLocalDate(secondary.eventLocalDate),
      secondaryStart,
    ) / 7) + 1;
    const requestedSecondaryDistanceMiles = Number(secondary.distanceMiles);
    const normalizedDistanceMiles = Number.isFinite(requestedSecondaryDistanceMiles)
      && requestedSecondaryDistanceMiles >= 1
      && requestedSecondaryDistanceMiles <= 100
      ? requestedSecondaryDistanceMiles
      : 10;
    const normalizedGoalTimeSeconds = Number.isFinite(Number(secondary.goalTimeSeconds))
      && Number(secondary.goalTimeSeconds) > 0
      ? Math.round(Number(secondary.goalTimeSeconds))
      : null;
    const derivedGoalPace = normalizedGoalTimeSeconds
      ? normalizedGoalTimeSeconds / normalizedDistanceMiles
      : null;
    const normalizedGoalPaceSecondsPerMile = derivedGoalPace >= 180 && derivedGoalPace <= 1800
      ? Math.round(derivedGoalPace)
      : null;
    const normalizedSecondary = {
      kind: 'run_race',
      raceId: secondary.raceId || null,
      name: secondary.name || 'Running race',
      eventLocalDate: secondary.eventLocalDate,
      eventTimezone: secondary.eventTimezone || event.eventTimezone,
      distanceMiles: normalizedDistanceMiles,
      goalType: normalizedGoalTimeSeconds ? 'pr' : (secondary.goalType || 'completion'),
      goalTimeSeconds: normalizedGoalTimeSeconds,
      goalPaceSecondsPerMile: normalizedGoalPaceSecondsPerMile,
      goalPaceLabel: normalizedGoalPaceSecondsPerMile
        ? formatPaceLabel(normalizedGoalPaceSecondsPerMile)
        : null,
    };
    goals.push({
      kind: 'run_race',
      eventKind: 'run_race',
      raceId: normalizedSecondary.raceId,
      name: normalizedSecondary.name,
      date: normalizedSecondary.eventLocalDate,
      eventLocalDate: normalizedSecondary.eventLocalDate,
      eventTimezone: normalizedSecondary.eventTimezone,
      distanceMiles: normalizedSecondary.distanceMiles,
      goalType: normalizedSecondary.goalType,
      goalTimeSeconds: normalizedSecondary.goalTimeSeconds,
      goalPaceSecondsPerMile: normalizedSecondary.goalPaceSecondsPerMile,
      goalPaceLabel: normalizedSecondary.goalPaceLabel,
      ...(includeGoalBackwardV24 ? { priority: 'B', feasibility_status: 'unvalidated' } : {}),
    });
    for (let index = 0; index < secondaryWeeks; index += 1) {
      const phase = index === 0
        ? 'post_hyrox_recovery'
        : index === secondaryWeeks - 1 ? 'running_taper_race' : 'running_specific';
      weeks.push(buildRunningWeek({
        startDate: addLocalDays(secondaryStart, index * 7),
        phase,
        weekIndex: weeks.length,
        runDays: requestedRunDays,
        availableDays,
        weeklyMiles: effectiveWeeklyMiles,
        race: normalizedSecondary,
        specificityIndex: Math.max(0, index - 1),
        safetyHold,
      }));
    }
  }

  const requiredEquipment = [...new Set(resolved.stations.map((station) => station.equipmentKey).filter(Boolean))];
  if (includeGoalBackwardV24) {
    const suppliedPerformanceBudget = input.hyroxPerformanceBudget
      || event.hyroxPerformanceBudget
      || {};
    hyroxPerformanceBudget = buildHyroxPerformanceBudget({
      ...suppliedPerformanceBudget,
      target_total_time_s: Number(event.goalTimeSeconds) > 0
        ? Math.round(Number(event.goalTimeSeconds))
        : (suppliedPerformanceBudget.target_total_time_s ?? suppliedPerformanceBudget.targetTotalTimeSeconds),
      team_budget: suppliedPerformanceBudget.team_budget ?? hyroxEventState.team_performance_burden ?? {},
      individual_training_burden: suppliedPerformanceBudget.individual_training_burden
        ?? hyroxEventState.individual_training_burden,
    });
  }
  const clusterExposure = includeGoalBackwardV24 ? validatePartialRaceOrderClusterExposure(
    { weeks },
    {
      event_local_date: event.eventLocalDate,
      mandatory_hyrox_cluster: mandatoryCluster && !clusterBlockedReason,
      training_age_class: trainingAgeClass,
    },
  ) : null;
  const clusterUnplaceable = Boolean(includeGoalBackwardV24 && mandatoryCluster && (
    clusterBlockedReason || clusterWeekIndex < 0 || clusterExposure?.valid !== true
  ));
  const constrainedClusterWeek = availableDays.length <= 4
    || ['caution', 'recovery', 'low'].includes(readiness);
  const mandatoryLongUnplaceable = Boolean(
    includeGoalBackwardV24 && mandatoryCluster && clusterWeekIndex >= 0 && constrainedClusterWeek
  );
  const goalBackwardAtRisk = clusterUnplaceable || mandatoryLongUnplaceable;
  const plan = {
    schemaVersion: 2,
    planMode: 'hyrox_build',
    policyVersion: 'hyrox-plan-policy-v1',
    engineVersion: 'deterministic-hyrox-v1',
    invariantVersion: 'hyrox-safety-v1',
    planningClock: { planningDateLocal: planningDate, eventTimezone: event.eventTimezone },
    inputSummary: {
      weeklyMileageBaseline: Number(weeklyMiles.toFixed(1)),
      effectiveWeeklyMiles: Number(effectiveWeeklyMiles.toFixed(1)),
      currentWeekRunLoad: {
        startDate,
        sourceStartDate: currentWeekActivity.activityReconciliation.runSourceStartDate,
        runCount: currentWeekActivity.completedRunCount,
        miles: Number(currentWeekActivity.completedRunMiles.toFixed(1)),
        runDates: currentWeekActivity.runDates,
        longRunCompleted: currentWeekActivity.longRunCompleted,
      },
      currentWeekStrengthLoad: {
        startDate,
        sourceStartDate: currentWeekActivity.activityReconciliation.strengthSourceStartDate,
        count: currentWeekActivity.completedStrengthSessions,
        dates: currentWeekActivity.strengthDates,
        loadPoints: currentWeekActivity.completedStrengthLoadPoints,
        provenance: currentWeekActivity.strengthProvenance,
      },
      currentWeekActivityReconciliation: currentWeekActivity.activityReconciliation,
    },
    goal: hyroxGoal,
    goals,
    standardsProvenance: {
      rulesVersion: resolved.rulesVersion,
      reviewedAt: resolved.reviewedAt,
      sourceUrl: resolved.sourceUrl,
      canonicalUnits: resolved.canonicalUnits,
      ...(includeGoalBackwardV24 ? {
        rulesetId: resolved.rulesetId,
        rulesetVersion: resolved.rulesetVersion,
        effectiveFrom: resolved.effectiveFrom,
        effectiveThrough: resolved.effectiveThrough,
        rulebookUrls: resolved.rulebookUrls,
      } : {}),
    },
    ...(includeGoalBackwardV24 ? { hyroxEventState, hyroxPerformanceBudget } : {}),
    schedulePreferences: {
      runDaysPerWeek: requestedRunDays,
      trainingDays: availableDays,
      runDaysSource: 'target',
      trainingDaysSource: 'target',
    },
    hyroxPolicy: {
      runwayClass: runway,
      daysToEventAtGeneration: daysToEvent,
      sessionsPerWeek: 2,
      compromisedRunSessionsPerWeek: 1,
      fullSimulationMinGapDays: 14,
      fullSimulationRequired: false,
      fullSimulationScheduled: false,
      canonicalUnits: 'metric',
      equipment,
      missingEquipment: requiredEquipment.filter((key) => !equipment.includes(key)),
      substitutionsAllowed: true,
      runningFoundation: true,
      maximumHardLowerBodyDaysPerRollingSeven: 2,
      safetyHold,
      ...(includeGoalBackwardV24 ? {
        partialRaceOrderCluster: {
          required: mandatoryCluster,
          fullPreTaperWeeks,
          window: partialClusterWindow,
          selectedWeekIndex: clusterWeekIndex >= 0 ? clusterWeekIndex : null,
          scheduledDates: clusterExposure?.qualifying_cluster_dates || [],
          valid: clusterExposure?.valid === true,
          completionStatus: 'PLANNED',
          unplaceable: clusterUnplaceable,
          unplaceableReason: clusterUnplaceable
            ? (clusterBlockedReason || clusterExposure?.violations?.[0]?.reason || 'SCHEDULE_CONSTRAINT') : null,
          reasonCodes: clusterUnplaceable ? ['REQUIRED_EXPOSURE_UNPLACEABLE'] : [],
          roleVariant: constrainedClusterWeek ? 'CONSTRAINED' : 'ELIGIBLE',
          requiredPrimaryCount: constrainedClusterWeek ? 1 : 2,
          stationSkillRole: 'SUPPORTING',
          unplaceableRequirementIds: mandatoryLongUnplaceable ? ['long_aerobic'] : [],
        },
      } : {}),
    },
    overall_feasibility: includeGoalBackwardV24 ? (goalBackwardAtRisk ? 'at_risk' : 'unvalidated') : 'supported',
    goal_feasibilities: goals.map((goal) => ({
      race_id: goal.raceId,
      feasibility: includeGoalBackwardV24 ? (goalBackwardAtRisk && goal === hyroxGoal ? 'at_risk' : 'unvalidated') : 'supported',
      goal: { date: goal.date },
    })),
    reasons: [
      ...(runway === 'short_runway' ? ['SHORT_RUNWAY_PRESERVE_BASE'] : []),
      ...(goalBackwardAtRisk ? ['REQUIRED_EXPOSURE_UNPLACEABLE'] : []),
    ],
    choices: ['train_for_target', 'adjust_goal'],
    weeks,
  };
  const validation = validateHyroxPlan(plan);
  if (!validation.valid) {
    const error = new Error(`hyrox_plan_invariant:${validation.errors[0].code}`);
    error.validation = validation;
    throw error;
  }
  return plan;
}

function validateHyroxPlan(plan = {}) {
  const errors = [];
  const entries = [];
  const ids = new Set();
  const planningDate = String(plan.planningClock?.planningDateLocal || '');
  const expectedStartDate = parseLocalDate(planningDate) == null ? null : mondayForLocalDate(planningDate);
  for (const [weekIndex, week] of (plan.weeks || []).entries()) {
    const expectedWeekStart = expectedStartDate ? addLocalDays(expectedStartDate, weekIndex * 7) : null;
    if (week.startDate !== expectedWeekStart) {
      errors.push({ code: 'INVALID_WEEK_START', path: `weeks[${weekIndex}].startDate` });
    }
    for (const [dayIndex, day] of (week.days || []).entries()) {
      if (parseLocalDate(day.date) == null) {
        errors.push({ code: 'INVALID_DAY_DATE', path: `weeks[${weekIndex}].days[${dayIndex}]` });
      }
      if (expectedWeekStart && day.date !== addLocalDays(expectedWeekStart, dayIndex)) {
        errors.push({ code: 'INVALID_WEEK_CADENCE', path: `weeks[${weekIndex}].days[${dayIndex}]` });
      }
      for (const [sessionIndex, session] of (day.sessions || []).entries()) {
        const path = `weeks[${weekIndex}].days[${dayIndex}].sessions[${sessionIndex}]`;
        if (parseLocalDate(planningDate) != null && day.date < planningDate) {
          errors.push({ code: 'SESSION_BEFORE_PLANNING_DATE', path });
        }
        if (!session.id || ids.has(session.id)) errors.push({ code: 'SESSION_ID_INVALID', path });
        ids.add(session.id);
        entries.push({ date: day.date, weekIndex, session, path });
        for (const station of session.stationSequence || []) {
          if (station.exactStation === false && (!station.substitute || station.readinessClaim !== 'pattern_only')) {
            errors.push({ code: 'UNTRUTHFUL_EQUIPMENT_SUBSTITUTION', path });
          }
        }
      }
    }
  }
  const hardDates = [...new Set(entries.filter((entry) => entry.session.hardLowerBody).map((entry) => entry.date))].sort();
  for (const start of hardDates) {
    const count = hardDates.filter((date) => {
      const delta = daysBetweenLocalDates(date, start);
      return delta >= 0 && delta <= 6;
    }).length;
    if (count > 2) errors.push({ code: 'HARD_LOWER_BODY_CAP', path: start });
  }
  const hardOrLongRuns = entries.filter((entry) => (
    ['hard', 'long', 'race'].includes(entry.session.runningStress)
    && (entry.session.kind === 'run' || entry.session.includesRun)
  ));
  const eventDate = plan.goal?.eventLocalDate || plan.goal?.date || null;
  if (parseLocalDate(eventDate) != null) {
    for (const entry of entries.filter((item) => isRaceSafetyDate(item.date, eventDate))) {
      const forbidden = entry.session.sessionType === 'hyrox_compromised'
        || entry.session.heavyStationWork
        || entry.session.sessionType === 'long_run'
        || entry.session.runningStress === 'long'
        || entry.session.runningStress === 'hard';
      if (forbidden) errors.push({ code: 'RACE_SAFETY_WINDOW', path: entry.path });
    }
  }
  for (const heavy of entries.filter((entry) => entry.session.heavyStationWork)) {
    for (const run of hardOrLongRuns) {
      if (run.date === heavy.date) continue;
      if (Math.abs(daysBetweenLocalDates(run.date, heavy.date)) <= 1) {
        errors.push({ code: 'HEAVY_STATION_RUN_ADJACENCY', path: `${heavy.date},${run.date}` });
      }
    }
  }
  for (const [weekIndex, week] of (plan.weeks || []).entries()) {
    const weekEntries = entries.filter((entry) => entry.weekIndex === weekIndex);
    const compromised = weekEntries.filter((entry) => entry.session.sessionType === 'hyrox_compromised');
    const extraQuality = weekEntries.filter((entry) => (
      entry.session.kind === 'run' && entry.session.runningStress === 'hard'
    ));
    if (compromised.length && extraQuality.length) {
      errors.push({ code: 'COMPROMISED_RUN_ADDS_QUALITY', path: `weeks[${weekIndex}]` });
    }
    if (weekEntries.filter((entry) => entry.session.sessionType === 'hyrox_simulation').length > 1) {
      errors.push({ code: 'WEEKLY_FULL_SIMULATION', path: `weeks[${weekIndex}]` });
    }
  }
  for (const race of entries.filter((entry) => entry.session.sessionType === 'hyrox_race')) {
    const officialTeamStations = race.session.officialTeamStationSequence || [];
    const order = officialTeamStations.map((station) => station.id);
    if (JSON.stringify(order) !== JSON.stringify(STATION_ORDER)) {
      errors.push({ code: 'OFFICIAL_STATION_ORDER', path: race.path });
    }
    if (officialTeamStations.some((station) => !station.officialStandard)) {
      errors.push({ code: 'OFFICIAL_STATION_STANDARD', path: race.path });
    }
    const officialTeamRaceSequence = race.session.officialTeamRaceSequence || [];
    const expectedTeamKinds = Array.from({ length: 16 }, (_, index) => (index % 2 === 0 ? 'run' : 'station'));
    const officialTeamRaceStationOrder = officialTeamRaceSequence
      .filter((item) => item.kind === 'station')
      .map((item) => item.station?.id);
    if (JSON.stringify(officialTeamRaceSequence.map((item) => item.kind)) !== JSON.stringify(expectedTeamKinds)
      || JSON.stringify(officialTeamRaceStationOrder) !== JSON.stringify(STATION_ORDER)) {
      errors.push({ code: 'OFFICIAL_TEAM_RACE_SEQUENCE', path: race.path });
    }
    const isRelay = race.session.eventFormat === 'relay';
    const expectedRuns = Array(isRelay ? 2 : 8).fill(1000);
    if (JSON.stringify(race.session.runSequenceMeters) !== JSON.stringify(expectedRuns)) {
      errors.push({ code: 'OFFICIAL_RUN_ORDER', path: race.path });
    }
    if (isRelay) {
      if ((race.session.stationSequence || []).length !== 0
        || race.session.athleteStationAssignment?.stationCount !== 2
        || race.session.athleteStationAssignment?.status !== 'team_assignment_required'
        || race.session.distanceMeters !== 2000
        || race.session.distance_miles !== 1.24
        || race.session.participationScope !== 'relay_athlete'
        || (race.session.raceSequence || []).length !== 0) {
        errors.push({ code: 'UNTRUTHFUL_RELAY_ATHLETE_VOLUME', path: race.path });
      }
    } else {
      if (JSON.stringify((race.session.stationSequence || []).map((station) => station.id)) !== JSON.stringify(STATION_ORDER)
        || JSON.stringify((race.session.raceSequence || []).map((item) => item.kind)) !== JSON.stringify(expectedTeamKinds)
        || race.session.distanceMeters !== 8000
        || race.session.distance_miles !== 4.97) {
        errors.push({ code: 'OFFICIAL_ATHLETE_RACE_STRUCTURE', path: race.path });
      }
    }
  }
  const clusterPolicy = plan.hyroxPolicy?.partialRaceOrderCluster;
  if (clusterPolicy) {
    const partialEntries = entries.filter((entry) => (
      entry.session.workout_family === 'hyrox_partial_simulation'
    ));
    for (const entry of partialEntries) {
      const schema = validatePartialRaceOrderCluster(entry.session, {
        training_age_class: plan.hyroxEventState?.training_age_class
          ?? entry.session.training_age_class
          ?? 'ESTABLISHED',
      });
      if (!schema.valid) errors.push({
        code: 'INVALID_PARTIAL_RACE_ORDER_CLUSTER',
        path: entry.path,
        details: schema.violations,
      });
      if (entry.session.role !== 'PRIMARY_KEY') {
        errors.push({ code: 'INVALID_CLUSTER_ROLE', path: entry.path });
      }
    }
    const recordedUnplaceable = clusterPolicy.unplaceable === true;
    const exposure = validatePartialRaceOrderClusterExposure(plan, {
      event_local_date: eventDate,
      mandatory_hyrox_cluster: clusterPolicy.required === true && !recordedUnplaceable,
      training_age_class: partialEntries[0]?.session?.training_age_class ?? 'ESTABLISHED',
    });
    if (!exposure.valid) {
      for (const violation of exposure.violations) {
        if (recordedUnplaceable && violation.reason === 'MANDATORY_CLUSTER_MISSING' && partialEntries.length === 0) continue;
        errors.push({ code: 'PARTIAL_CLUSTER_EXPOSURE', path: 'hyroxPolicy.partialRaceOrderCluster', details: violation });
      }
    }
    if (clusterPolicy.required === true && !recordedUnplaceable && !partialEntries.length) {
      errors.push({ code: 'MANDATORY_PARTIAL_CLUSTER_MISSING', path: 'weeks' });
    }
    if (!recordedUnplaceable && (clusterPolicy.valid === true) !== (exposure.valid === true)) {
      errors.push({ code: 'PARTIAL_CLUSTER_POLICY_MISMATCH', path: 'hyroxPolicy.partialRaceOrderCluster.valid' });
    }
    for (const weekIndex of [...new Set(partialEntries.map((entry) => entry.weekIndex))]) {
      const clusterWeekEntries = entries.filter((entry) => entry.weekIndex === weekIndex);
      const stationSkills = clusterWeekEntries.filter((entry) => (
        entry.session.workout_family === 'hyrox_station_skill'
      ));
      if (!stationSkills.length || stationSkills.some((entry) => (
        entry.session.role !== 'SUPPORTING' || entry.session.hardLowerBody === true
      ))) {
        errors.push({ code: 'MANDATORY_CLUSTER_STATION_SKILL_ROLE', path: `weeks[${weekIndex}]` });
      }
      const longRuns = clusterWeekEntries.filter((entry) => entry.session.workout_family === 'long_aerobic');
      const constrained = clusterPolicy.roleVariant === 'CONSTRAINED';
      if (longRuns.some((entry) => entry.session.role !== (constrained ? 'SUPPORTING' : 'PRIMARY_KEY'))) {
        errors.push({ code: 'MANDATORY_CLUSTER_LONG_ROLE', path: `weeks[${weekIndex}]` });
      }
      if (!constrained && !longRuns.length) {
        errors.push({ code: 'MANDATORY_CLUSTER_LONG_MISSING', path: `weeks[${weekIndex}]` });
      }
      const interference = validateInterference(clusterWeekEntries.map((entry) => ({
        ...entry.session,
        scheduled_local_date: entry.date,
      })), {
        training_age_class: partialEntries.find((entry) => entry.weekIndex === weekIndex)
          ?.session?.training_age_class ?? 'ESTABLISHED',
      });
      if (!interference.valid) errors.push({
        code: 'PARTIAL_CLUSTER_SPACING', path: `weeks[${weekIndex}]`, details: interference.violations,
      });
    }
  }
  if (plan.hyroxPolicy?.runwayClass === 'foundation_only'
    && entries.some((entry) => entry.session.sessionType === 'hyrox_race')) {
    errors.push({ code: 'FOUNDATION_HAS_RACE_DAY', path: 'weeks' });
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  addLocalDays,
  allocatePhases,
  buildBryanPeakWeekWitness,
  buildHyroxEventState: buildCanonicalHyroxEventState,
  buildHyroxPerformanceBudget,
  buildPartialRaceOrderCluster,
  buildHyroxStationPrescription,
  classifyHyroxRunway,
  daysBetweenLocalDates,
  daysToEventForEvent,
  generateHyroxPlan,
  isIanaTimezone,
  localDateInTimeZone,
  mondayForLocalDate,
  planWeekWindow,
  validatePartialRaceOrderCluster,
  validateHyroxPlan,
};
