const { computeZones, zoneForHr } = require('./hrZones');
const { isRunActivity } = require('./runActivity');

function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function getRunDate(run = {}) {
  const raw = run.date || run.created_at;
  const date = raw ? new Date(raw) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function isoDate(value) {
  const direct = String(value || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

function addDays(dateISO, amount) {
  const date = new Date(`${dateISO}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function completedWeeklyMileageHistory(runs = [], options = {}) {
  const requestedWeeks = Number(options.weeks || 4);
  const weeks = Number.isInteger(requestedWeeks) && requestedWeeks > 0 ? requestedWeeks : 4;
  const asOfISO = isoDate(options.asOfDate || options.now || new Date());
  if (!asOfISO) return [];

  const asOf = new Date(`${asOfISO}T12:00:00`);
  const daysSinceMonday = (asOf.getDay() + 6) % 7;
  const currentWeekStart = addDays(asOfISO, -daysSinceMonday);
  const historyStart = addDays(currentWeekStart, -(weeks * 7));
  const totals = Array.from({ length: weeks }, () => 0);
  let hasMileage = false;

  for (const run of (Array.isArray(runs) ? runs : []).filter(isRunActivity)) {
    const date = isoDate(run?.date || run?.created_at);
    const miles = toNumber(run?.distance_miles ?? run?.distanceMiles);
    if (!date || miles === null || miles < 0 || date < historyStart || date >= currentWeekStart) continue;
    for (let index = 0; index < weeks; index += 1) {
      const weekStart = addDays(historyStart, index * 7);
      const weekEnd = addDays(weekStart, 7);
      if (date < weekStart || date >= weekEnd) continue;
      totals[index] += miles;
      if (miles > 0) hasMileage = true;
      break;
    }
  }

  return hasMileage ? totals.map((miles) => round(miles, 2)) : [];
}

function computeHrZones(maxHr) {
  const max = toNumber(maxHr);
  if (max === null || max <= 0) return null;

  return {
    Z1: { min: Math.round(max * 0.5), max: Math.round(max * 0.6) },
    Z2: { min: Math.round(max * 0.6), max: Math.round(max * 0.7) },
    Z3: { min: Math.round(max * 0.7), max: Math.round(max * 0.8) },
    Z4: { min: Math.round(max * 0.8), max: Math.round(max * 0.9) },
    Z5: { min: Math.round(max * 0.9), max: Math.round(max) },
  };
}

function classifyRunZone(avgHr, maxHr) {
  const avg = toNumber(avgHr);
  const max = toNumber(maxHr);
  if (avg === null || avg <= 0 || max === null || max <= 0) return null;

  const pct = avg / max;
  if (pct < 0.5) return 'below_z1';
  if (pct < 0.6) return 'Z1';
  if (pct < 0.7) return 'Z2';
  if (pct < 0.8) return 'Z3';
  if (pct < 0.9) return 'Z4';
  return 'Z5';
}

function parseZoneSeconds(value) {
  if (!value) return null;
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const zoneSeconds = {
    Z1: toNumber(parsed.z1 ?? parsed.Z1) || 0,
    Z2: toNumber(parsed.z2 ?? parsed.Z2) || 0,
    Z3: toNumber(parsed.z3 ?? parsed.Z3) || 0,
    Z4: toNumber(parsed.z4 ?? parsed.Z4) || 0,
    Z5: toNumber(parsed.z5 ?? parsed.Z5) || 0,
  };
  const total = Object.values(zoneSeconds).reduce((sum, seconds) => sum + Math.max(0, seconds), 0);
  return total > 0 ? zoneSeconds : null;
}

function dominantZone(zoneSeconds) {
  if (!zoneSeconds) return null;
  return Object.entries(zoneSeconds).reduce((best, [zone, seconds]) => (
    seconds > best.seconds ? { zone, seconds } : best
  ), { zone: null, seconds: 0 }).zone;
}

function buildEmptyDistribution() {
  return ['below_z1', 'Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'unknown'].reduce((acc, zone) => {
    acc[zone] = { count: 0, percent: 0 };
    return acc;
  }, {});
}

function getRunIntent(run = {}) {
  return String(
    run.workout_type
    || run.type
    || run.run_type
    || run.watch_normalized_type
    || run.watch_activity_type
    || ''
  ).trim().toLowerCase();
}

function isIntentionalHardRun(run = {}) {
  const intent = getRunIntent(run);
  return /\b(tempo|intervals?|speed|races?|workouts?)\b/.test(intent);
}

function hasRunIntent(run = {}) {
  return getRunIntent(run).length > 0;
}

function isEasyAerobicRun(run = {}) {
  const intent = getRunIntent(run);
  if (!intent) return false;
  if (isIntentionalHardRun(run)) return false;
  return /\b(easy|aerobic|base|recovery|long|run)\b/.test(intent);
}

function analyzeRunHistory(runs = [], maxHr, opts = {}) {
  const history = (Array.isArray(runs) ? runs : []).filter(isRunActivity);
  const hrProfile = opts.hrProfile || null;
  const effectiveMaxHr = toNumber(maxHr) || toNumber(hrProfile?.max_hr) || null;
  const profileZones = hrProfile ? computeZones({
    maxHr: hrProfile.max_hr,
    restingHr: hrProfile.resting_hr,
    lthr: hrProfile.lthr,
    model: hrProfile.zone_model,
    customMinimums: hrProfile.custom_zones_json,
  }).zones : [];
  const zones = profileZones.length === 5
    ? profileZones.reduce((acc, zone) => {
      acc[`Z${zone.zone}`] = { min: zone.minBpm, max: zone.maxBpm };
      return acc;
    }, {})
    : computeHrZones(effectiveMaxHr);
  if (!zones) {
    return {
      available: false,
      reason: 'missing_heart_rate_profile',
      weeklyVolumeMiles: 0,
      zoneDistribution: buildEmptyDistribution(),
      acuteChronicMiles: null,
      driftCount: 0,
      notes: ['Add heart-rate zones to enable intensity analysis.'],
    };
  }

  if (history.length === 0) {
    return {
      available: false,
      reason: 'no_recent_runs',
      weeklyVolumeMiles: 0,
      zoneDistribution: buildEmptyDistribution(),
      acuteChronicMiles: null,
      driftCount: 0,
      notes: ['No recent runs available for trend analysis.'],
      zones,
    };
  }

  const now = opts.now ? new Date(opts.now) : new Date();
  const recentDays = Number(opts.recentDays || 7);
  const chronicDays = Number(opts.chronicDays || 28);
  const recentCutoff = new Date(now.getTime() - recentDays * 24 * 60 * 60 * 1000);
  const chronicCutoff = new Date(now.getTime() - chronicDays * 24 * 60 * 60 * 1000);

  const distribution = buildEmptyDistribution();
  let classifiedCount = 0;
  let weeklyMiles = 0;
  let chronicMiles = 0;
  let driftCount = 0;
  let hasAnyRunIntent = false;

  for (const run of history) {
    const runDate = getRunDate(run);
    const miles = toNumber(run.distance_miles) || 0;
    const isRecent = runDate ? runDate >= recentCutoff : false;
    const isChronic = runDate ? runDate >= chronicCutoff : true;
    if (hasRunIntent(run)) hasAnyRunIntent = true;

    if (isRecent) weeklyMiles += miles;
    if (isChronic) chronicMiles += miles;

    const parsedZoneSeconds = parseZoneSeconds(run.heart_rate_zones ?? run.zoneSeconds ?? run.zone_seconds);
    const coveredSeconds = parsedZoneSeconds
      ? Object.values(parsedZoneSeconds).reduce((sum, seconds) => sum + Math.max(0, seconds), 0)
      : 0;
    const durationSeconds = toNumber(run.duration_seconds ?? run.durationSeconds) || 0;
    const zoneSeconds = durationSeconds > 0 && coveredSeconds / durationSeconds < 0.7 ? null : parsedZoneSeconds;
    let zone = null;
    if (zoneSeconds) {
      for (const [zoneKey, seconds] of Object.entries(zoneSeconds)) {
        const safeSeconds = Math.max(0, seconds);
        distribution[zoneKey].count += safeSeconds;
        classifiedCount += safeSeconds;
      }
      zone = dominantZone(zoneSeconds);
    } else {
      zone = zoneForHr(run.avg_heart_rate, hrProfile)
        || classifyRunZone(run.avg_heart_rate, effectiveMaxHr)
        || 'unknown';
      distribution[zone].count += 1;
      if (zone !== 'unknown') classifiedCount += 1;
    }
    if (isRecent && isEasyAerobicRun(run) && ['Z3', 'Z4', 'Z5'].includes(zone)) driftCount += 1;
  }

  for (const zone of Object.keys(distribution)) {
    distribution[zone].percent = zone !== 'unknown' && classifiedCount > 0
      ? round((distribution[zone].count / classifiedCount) * 100, 1)
      : 0;
  }

  const acuteChronicMiles = chronicMiles > 0
    ? round(weeklyMiles / (chronicMiles / (chronicDays / 7)), 2)
    : null;

  const notes = [];
  notes.push(`${round(weeklyMiles)} mi in the last ${recentDays} days.`);
  if (acuteChronicMiles !== null) {
    if (acuteChronicMiles > 1.5) notes.push('Recent mileage is above the 4-week baseline.');
    else if (acuteChronicMiles < 0.75) notes.push('Recent mileage is below the 4-week baseline.');
    else notes.push('Recent mileage is near the 4-week baseline.');
  }
  if (driftCount >= 3) {
    notes.push(`${driftCount} recent runs drifted into Z3 or higher against a Z2 base target.`);
  } else if (!hasAnyRunIntent && distribution.Z3.count + distribution.Z4.count + distribution.Z5.count > 0) {
    notes.push('Recent runs are frequently Z3 or higher.');
  } else if (classifiedCount > 0) {
    notes.push('Recent intensity distribution is not showing repeated Z2 drift.');
  }

  return {
    available: true,
    weeklyVolumeMiles: round(weeklyMiles),
    zoneDistribution: distribution,
    acuteChronicMiles,
    driftCount,
    hasRunIntent: hasAnyRunIntent,
    notes,
    zones,
    maxHeartRate: effectiveMaxHr,
  };
}

module.exports = {
  computeHrZones,
  classifyRunZone,
  parseZoneSeconds,
  completedWeeklyMileageHistory,
  analyzeRunHistory,
};
