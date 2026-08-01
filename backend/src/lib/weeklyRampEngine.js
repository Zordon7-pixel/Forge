// Deterministic week-level mileage gate. Pure: no DB, network, or clock access.

const ACWR_HOLD_THRESHOLD = 1.3;
const ACWR_DELOAD_THRESHOLD = 1.5;
const MAX_WEEKLY_INCREASE_PCT = 0.10;
const DELOAD_MULTIPLIER = 0.90;
const REQUIRED_HISTORY_WEEKS = 4;
const ACWR_DECIMAL_PLACES = 2;

const DECISIONS = Object.freeze({
  ADVANCE: 'ADVANCE',
  HOLD: 'HOLD',
  DELOAD: 'DELOAD',
  PASSTHROUGH: 'PASSTHROUGH',
});

function round(value, decimalPlaces = ACWR_DECIMAL_PLACES) {
  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
}

function mileageFromEntry(entry) {
  const raw = entry && typeof entry === 'object' && !Array.isArray(entry)
    ? entry.miles
      ?? entry.weeklyMiles
      ?? entry.weekly_miles
      ?? entry.totalMiles
      ?? entry.total_miles
      ?? entry.load
    : entry;
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return null;
  const miles = Number(raw);
  return Number.isFinite(miles) && miles >= 0 ? miles : null;
}

function normalizeReadinessTrend(readinessTrend) {
  if (readinessTrend && typeof readinessTrend === 'object' && !Array.isArray(readinessTrend)) {
    if (readinessTrend.redTrend === true || readinessTrend.isRedTrend === true) return 'red-trend';
    return normalizeReadinessTrend(
      readinessTrend.trend
      ?? readinessTrend.status
      ?? readinessTrend.state
      ?? readinessTrend.value
      ?? readinessTrend.band
    );
  }

  const trend = String(readinessTrend || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-');
  if ((trend.includes('red') && trend.includes('trend')) || trend === 'red') return 'red-trend';
  if (trend.includes('declin') || trend === 'down' || trend === 'worsening') return 'declining';
  if (trend.includes('flat')) return 'flat';
  if (trend.includes('improv') || trend === 'up' || trend === 'rising') return 'improving';
  if (trend.includes('stable') || trend === 'steady') return 'stable';
  return null;
}

function passthrough(plannedNextWeekMiles, reason) {
  return {
    decision: DECISIONS.PASSTHROUGH,
    targetMiles: plannedNextWeekMiles,
    acwr: null,
    reason: [reason],
    drivers: [],
  };
}

function decideWeeklyRamp({ weeklyMileageHistory, plannedNextWeekMiles, readinessTrend } = {}) {
  if (!Array.isArray(weeklyMileageHistory) || weeklyMileageHistory.length < REQUIRED_HISTORY_WEEKS) {
    return passthrough(plannedNextWeekMiles, 'Insufficient 28-day mileage history.');
  }

  const recentWeeks = weeklyMileageHistory.slice(-REQUIRED_HISTORY_WEEKS).map(mileageFromEntry);
  if (recentWeeks.some((miles) => miles === null)) {
    return passthrough(plannedNextWeekMiles, 'Insufficient 28-day mileage history.');
  }

  const chronicMiles = recentWeeks.reduce((sum, miles) => sum + miles, 0);
  if (chronicMiles <= 0) {
    return passthrough(plannedNextWeekMiles, 'Mileage history has no usable training load.');
  }

  const plannedMiles = Number(plannedNextWeekMiles);
  if (!Number.isFinite(plannedMiles)) {
    return passthrough(plannedNextWeekMiles, 'Planned mileage is unavailable.');
  }

  const currentWeekMiles = recentWeeks[recentWeeks.length - 1];
  const acuteDailyLoad = currentWeekMiles / 7;
  const chronicDailyLoad = chronicMiles / 28;
  const rawAcwr = chronicDailyLoad > 0 ? acuteDailyLoad / chronicDailyLoad : null;
  if (!Number.isFinite(rawAcwr)) {
    return passthrough(plannedNextWeekMiles, 'Mileage history has no usable training load.');
  }

  const trend = normalizeReadinessTrend(readinessTrend);
  if (!trend) {
    return passthrough(plannedNextWeekMiles, 'Readiness trend is unavailable.');
  }

  const hardCapMiles = currentWeekMiles * (1 + MAX_WEEKLY_INCREASE_PCT);
  const acwr = round(rawAcwr);
  let decision;
  let targetMiles;
  const reason = [];
  const drivers = [];

  if (rawAcwr > ACWR_DELOAD_THRESHOLD || trend === 'red-trend') {
    decision = DECISIONS.DELOAD;
    targetMiles = Math.min(plannedMiles, currentWeekMiles * DELOAD_MULTIPLIER);
    if (rawAcwr > ACWR_DELOAD_THRESHOLD) {
      reason.push(`ACWR ${acwr} is above ${ACWR_DELOAD_THRESHOLD}.`);
      drivers.push('acwr');
    }
    if (trend === 'red-trend') {
      reason.push('Readiness is red-trending.');
      drivers.push('readiness');
    }
  } else if (
    (rawAcwr >= ACWR_HOLD_THRESHOLD && rawAcwr <= ACWR_DELOAD_THRESHOLD)
    || trend === 'flat'
    || trend === 'declining'
  ) {
    decision = DECISIONS.HOLD;
    targetMiles = currentWeekMiles;
    if (rawAcwr >= ACWR_HOLD_THRESHOLD && rawAcwr <= ACWR_DELOAD_THRESHOLD) {
      reason.push(`ACWR ${acwr} is in the hold range.`);
      drivers.push('acwr');
    }
    if (trend === 'flat' || trend === 'declining') {
      reason.push(`Readiness is ${trend}.`);
      drivers.push('readiness');
    }
  } else {
    decision = DECISIONS.ADVANCE;
    targetMiles = Math.min(plannedMiles, hardCapMiles);
    reason.push(`ACWR ${acwr} supports a controlled advance.`);
    reason.push(`Readiness is ${trend}.`);
    drivers.push('acwr', 'readiness');
  }

  targetMiles = Math.min(targetMiles, hardCapMiles);
  return { decision, targetMiles, acwr, reason, drivers };
}

module.exports = {
  ACWR_HOLD_THRESHOLD,
  ACWR_DELOAD_THRESHOLD,
  MAX_WEEKLY_INCREASE_PCT,
  DELOAD_MULTIPLIER,
  REQUIRED_HISTORY_WEEKS,
  DECISIONS,
  decideWeeklyRamp,
};
