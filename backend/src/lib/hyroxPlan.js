const {
  EQUIPMENT_KEYS,
  REGISTRY,
  STATION_ORDER,
  normalizeEquipment,
  resolveHyroxStandard,
} = require('./hyroxStandards');

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
  const progress = index / Math.max(1, count - 1);
  if (progress <= 0.35) return 'build';
  if (progress <= 0.65) return 'peak_partial_simulation';
  return 'sharpen_reduce';
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

function stationForTraining(standard, equipment, intensity = 'RPE 6-7', doseFraction = 0.4) {
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
    readinessClaim: hasEquipment ? 'station_specific' : 'pattern_only',
    loadGuidance: hasEquipment ? `${intensity}; do not chase failure` : null,
    prescribedLoadKg: null,
    provenance: `${REGISTRY.rulesVersion}:${standard.id}`,
  };
  if (!hasEquipment) return { ...base, substitute: SUBSTITUTIONS[standard.id] };
  return {
    ...base,
    officialStandard: officialStandardForStation(standard),
  };
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
  const raceSafetyWindow = Boolean(
    eventDate
    && eventDate >= planningDate
    && eventDate <= addLocalDays(startDate, 7)
  );
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
    .filter((slot) => !hardRunsThrough || days[slot].date > hardRunsThrough);
  const compromised = buildCompromisedSession({ phase, weekIndex, standards, equipment, safetyHold });
  if (!raceSafetyWindow
    && remainingHyroxQuota > 0
    && remainingRunQuota > 0
    && remainingMileageBudget + 0.001 >= Number(compromised.distance_miles || 0)
    && compromisedCandidates.length) {
    const slot = nearestSlot(3, compromisedCandidates);
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
  let longIndex = currentWeekActivity.longRunCompleted || !selectedRunSlots.length
    ? -1
    : selectedRunSlots.length - 1;
  if (raceSafetyWindow) longIndex = -1;
  if (longIndex >= 0 && hardRunsThrough && days[selectedRunSlots[longIndex]].date <= hardRunsThrough) longIndex = -1;
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
  currentWeekRunningLoadCap = null,
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
    });
  }
  const days = Array.from({ length: 7 }, (_, offset) => {
    const date = addLocalDays(startDate, offset);
    return { date, day: weekday(date), sessions: [] };
  });
  const allowed = days.map((day, index) => availableDays.includes(day.day) ? index : null).filter(Number.isInteger);
  const isRaceWeek = Boolean(eventDate && eventDate >= startDate && eventDate <= addLocalDays(startDate, 6));
  const loadFactor = PHASE_LOAD[phase] || 0.75;
  const used = new Set();
  const longSlot = nearestSlot(6, allowed, used);
  used.add(longSlot);
  const compromisedSlot = nearestSlot(3, allowed, used);
  used.add(compromisedSlot);
  const eventSlot = isRaceWeek ? days.findIndex((day) => day.date === eventDate) : -1;
  const stationAvailable = isRaceWeek ? allowed.filter((slot) => slot !== eventSlot) : allowed;
  const hardStationPhase = ['build', 'peak_partial_simulation', 'specific'].includes(phase);
  const stationPool = stationAvailable.length ? stationAvailable : allowed;
  const unoccupiedStationSlots = stationPool.filter((slot) => !used.has(slot));
  const stationCandidates = (unoccupiedStationSlots.length ? unoccupiedStationSlots : stationPool)
    .slice()
    .sort((left, right) => Math.abs(left - 1) - Math.abs(right - 1) || left - right);
  const isSafeStationSlot = (slot) => (
    Math.abs(slot - compromisedSlot) > 1
    && Math.abs(slot - longSlot) > 1
    && precedingHardOrLongRunDates.every((runDate) => (
      Math.abs(daysBetweenLocalDates(days[slot].date, runDate)) > 1
    ))
  );
  const safeStationSlot = stationCandidates.find(isSafeStationSlot);
  const stationSlot = safeStationSlot ?? stationCandidates[0];
  const safeStationGap = safeStationSlot != null;
  const outsideRaceRecoveryWindow = !eventDate
    || Math.abs(daysBetweenLocalDates(eventDate, days[stationSlot].date)) > 6;
  const heavyStation = hardStationPhase
    && safeStationGap
    && outsideRaceRecoveryWindow
    && !isRaceWeek
    && !safetyHold;

  if (!isRaceWeek) {
    days[stationSlot].sessions.push(buildStationSession({ phase, weekIndex, standards, equipment, heavy: heavyStation }));
    days[compromisedSlot].sessions.push(buildCompromisedSession({ phase, weekIndex, standards, equipment, safetyHold }));
    days[longSlot].sessions.push(buildRunSession(`run-${weekIndex + 1}-long`, 'long', Math.max(4, weeklyMiles * 0.34), loadFactor));
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

function buildRunningWeek({ startDate, phase, weekIndex, runDays, availableDays, weeklyMiles, race }) {
  const days = Array.from({ length: 7 }, (_, offset) => {
    const date = addLocalDays(startDate, offset);
    return { date, day: weekday(date), sessions: [] };
  });
  const allowed = days.map((day, index) => availableDays.includes(day.day) ? index : null).filter(Number.isInteger);
  const raceWeek = race.eventLocalDate >= startDate && race.eventLocalDate <= addLocalDays(startDate, 6);
  const loadFactor = PHASE_LOAD[phase];
  const longSlot = nearestSlot(6, allowed);
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
      hardLowerBody: false,
    });
  } else if (phase !== 'post_hyrox_recovery') {
    const qualitySlot = nearestSlot(3, allowed, new Set([longSlot]));
    days[qualitySlot].sessions.push({
      ...buildRunSession(`secondary-${weekIndex + 1}-quality`, 'easy', Math.max(3, weeklyMiles * 0.22), loadFactor),
      sessionType: 'running_specific',
      type: 'quality',
      title: 'Controlled running-race rhythm',
      runningStress: 'hard',
      hardLowerBody: false,
    });
    days[longSlot].sessions.push(buildRunSession(`secondary-${weekIndex + 1}-long`, 'long', Math.max(5, weeklyMiles * 0.36), loadFactor));
  }
  const exposures = () => days.flatMap((day) => day.sessions).filter((session) => session.kind === 'run').length;
  const targets = [0, 2, 4, 5, 1, 3, 6];
  while (exposures() < runDays) {
    const occupied = new Set(days.map((day, index) => day.sessions.some((session) => session.kind === 'run') ? index : null).filter(Number.isInteger));
    const slot = nearestSlot(targets.shift() ?? 0, allowed, occupied);
    days[slot].sessions.push(buildRunSession(
      `secondary-${weekIndex + 1}-easy-${exposures() + 1}`,
      phase === 'post_hyrox_recovery' ? 'recovery' : 'easy',
      Math.max(2, weeklyMiles / runDays * 0.65),
      loadFactor,
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
    days,
  };
}

function generateHyroxPlan(input = {}) {
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
    const precedingHardOrLongRunDates = (weeks.at(-1)?.days || [])
      .flatMap((day) => day.sessions.map((session) => ({ date: day.date, session })))
      .filter(({ session }) => (
        ['hard', 'long', 'race'].includes(session.runningStress)
        && (session.kind === 'run' || session.includesRun)
      ))
      .map(({ date }) => date);
    weeks.push(buildWeek({
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
      currentWeekRunningLoadCap: weekIndex === 0 ? currentWeekRunningLoadCap : null,
    }));
  }

  const hyroxGoal = {
    kind: 'hyrox',
    eventKind: 'hyrox',
    raceId: event.raceId || null,
    name: event.name || 'HYROX event',
    date: event.eventLocalDate || null,
    eventLocalDate: event.eventLocalDate || null,
    eventTimezone: event.eventTimezone,
    division: resolved.format,
    category: resolved.category,
    rulesVersion: resolved.rulesVersion,
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
    const normalizedSecondary = {
      kind: 'run_race',
      raceId: secondary.raceId || null,
      name: secondary.name || 'Running race',
      eventLocalDate: secondary.eventLocalDate,
      eventTimezone: secondary.eventTimezone || event.eventTimezone,
      distanceMiles: Math.max(1, Number(secondary.distanceMiles || 10)),
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
      }));
    }
  }

  const requiredEquipment = [...new Set(resolved.stations.map((station) => station.equipmentKey).filter(Boolean))];
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
    },
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
    },
    overall_feasibility: 'supported',
    goal_feasibilities: goals.map((goal) => ({ race_id: goal.raceId, feasibility: 'supported', goal: { date: goal.date } })),
    reasons: runway === 'short_runway' ? ['SHORT_RUNWAY_PRESERVE_BASE'] : [],
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
  if (plan.hyroxPolicy?.runwayClass === 'foundation_only'
    && entries.some((entry) => entry.session.sessionType === 'hyrox_race')) {
    errors.push({ code: 'FOUNDATION_HAS_RACE_DAY', path: 'weeks' });
  }
  return { valid: errors.length === 0, errors };
}

module.exports = {
  addLocalDays,
  allocatePhases,
  classifyHyroxRunway,
  daysBetweenLocalDates,
  daysToEventForEvent,
  generateHyroxPlan,
  isIanaTimezone,
  localDateInTimeZone,
  mondayForLocalDate,
  planWeekWindow,
  validateHyroxPlan,
};
