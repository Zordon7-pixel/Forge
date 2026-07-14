// Pure recent-run load summary used by plan generation and live adaptation.

const { isRunActivity } = require('./runActivity');

function parseISODate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12));
  return Number.isNaN(date.getTime()) ? null : date;
}

function toISODate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function addDays(iso, amount) {
  const date = parseISODate(iso);
  if (!date) return null;
  date.setUTCDate(date.getUTCDate() + amount);
  return toISODate(date);
}

function daysBetween(laterISO, earlierISO) {
  const later = parseISODate(laterISO);
  const earlier = parseISODate(earlierISO);
  if (!later || !earlier) return null;
  return Math.round((later.getTime() - earlier.getTime()) / 86400000);
}

function finiteNumber(value, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function paceLabel(secondsPerMile) {
  const seconds = Math.round(Number(secondsPerMile || 0));
  if (seconds < 180 || seconds > 2400) return null;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}/mi`;
}

function normalizeRun(row = {}) {
  if (!isRunActivity(row)) return null;
  const date = String(row.date || '').slice(0, 10);
  if (!parseISODate(date)) return null;
  const distanceMiles = finiteNumber(row.distance_miles, 0, 500) || 0;
  const durationSeconds = finiteNumber(row.duration_seconds, 0, 172800) || 0;
  const computedPace = distanceMiles > 0 && durationSeconds > 0 ? durationSeconds / distanceMiles : null;
  const storedPaceRaw = finiteNumber(row.pace_avg, 3, 2400);
  const storedPace = storedPaceRaw && storedPaceRaw < 60 ? storedPaceRaw * 60 : storedPaceRaw;
  const paceSecondsPerMile = computedPace && computedPace >= 180 && computedPace <= 2400 ? computedPace : storedPace;
  return {
    date,
    distanceMiles,
    durationSeconds,
    durationMinutes: durationSeconds > 0 ? round(durationSeconds / 60, 1) : null,
    paceSecondsPerMile: paceSecondsPerMile ? Math.round(paceSecondsPerMile) : null,
    paceLabel: paceLabel(paceSecondsPerMile),
    perceivedEffort: finiteNumber(row.perceived_effort, 1, 10),
    avgHeartRate: finiteNumber(row.avg_heart_rate, 30, 240),
    source: String(row.health_source || row.source || 'logged').slice(0, 40),
    createdAt: row.created_at ? String(row.created_at) : null,
  };
}

function summarizeRecentRunLoad(rows = [], options = {}) {
  const todayISO = parseISODate(options.todayISO) ? options.todayISO : null;
  const weeklyBaseline = Math.max(0, Number(options.weeklyBaseline || 0));
  const recoveryState = String(options.recoveryState || 'unknown').toLowerCase();
  const normalized = (Array.isArray(rows) ? rows : [])
    .map(normalizeRun)
    .filter((run) => run && (!todayISO || run.date <= todayISO));
  const meaningful = normalized.filter((run) => run.distanceMiles >= 1 || run.durationSeconds >= 600 || Number(run.perceivedEffort || 0) >= 7);
  const latestDate = meaningful.reduce((latest, run) => (!latest || run.date > latest ? run.date : latest), null);
  const latestRun = latestDate
    ? meaningful
      .filter((run) => run.date === latestDate)
      .sort((left, right) => right.distanceMiles - left.distanceMiles || String(right.createdAt || '').localeCompare(String(left.createdAt || '')))[0]
    : null;
  const sevenDayStart = todayISO ? addDays(todayISO, -6) : null;
  const sevenDayMiles = round(normalized
    .filter((run) => !sevenDayStart || (run.date >= sevenDayStart && run.date <= todayISO))
    .reduce((sum, run) => sum + run.distanceMiles, 0), 1);

  if (!latestRun || !todayISO) {
    return {
      available: false,
      weeklyBaseline: round(weeklyBaseline, 1),
      sevenDayMiles,
      latestRun: null,
      protection: { active: false },
    };
  }

  const daysSince = daysBetween(todayISO, latestRun.date);
  const longRunThresholdMiles = round(Math.min(8, Math.max(5, weeklyBaseline * 0.35 || 5)), 1);
  const isLong = latestRun.distanceMiles >= longRunThresholdMiles || latestRun.durationSeconds >= 75 * 60;
  const isHard = Number(latestRun.perceivedEffort || 0) >= 7;
  const recoveryCaution = ['low', 'recovery', 'caution'].includes(recoveryState);
  const withinAcuteWindow = daysSince !== null && daysSince >= 0 && daysSince <= 2;
  const protectsFromLoad = withinAcuteWindow && (isLong || isHard);
  const hardProtectionDays = protectsFromLoad ? ((isLong && isHard) || recoveryCaution ? 2 : 1) : 0;
  const lowerProtectionDays = protectsFromLoad ? (recoveryCaution ? 2 : 1) : 0;
  const noAdditionalRunOnDate = daysSince === 0 ? latestRun.date : null;
  const protectionActive = Boolean(noAdditionalRunOnDate || protectsFromLoad);
  const distanceShare = weeklyBaseline > 0 ? round(latestRun.distanceMiles / weeklyBaseline, 2) : null;
  const when = daysSince === 0 ? 'today' : daysSince === 1 ? 'yesterday' : `${daysSince} days ago`;
  const details = [
    `${round(latestRun.distanceMiles, 1)} mi`,
    latestRun.paceLabel,
    latestRun.durationMinutes ? `${Math.round(latestRun.durationMinutes)} min` : null,
    latestRun.avgHeartRate ? `avg HR ${Math.round(latestRun.avgHeartRate)}` : null,
  ].filter(Boolean).join(', ');

  return {
    available: true,
    weeklyBaseline: round(weeklyBaseline, 1),
    sevenDayMiles,
    loadRatio: weeklyBaseline > 0 ? round(sevenDayMiles / weeklyBaseline, 2) : null,
    latestRun: {
      ...latestRun,
      distanceMiles: round(latestRun.distanceMiles, 3),
      daysSince,
      isLong,
      isHard,
      distanceShareOfWeeklyBaseline: distanceShare,
    },
    protection: {
      active: protectionActive,
      noAdditionalRunOnDate,
      hardRunsThrough: protectsFromLoad ? addDays(latestRun.date, hardProtectionDays) : noAdditionalRunOnDate,
      lowerBodyThrough: protectsFromLoad ? addDays(latestRun.date, lowerProtectionDays) : null,
      upperBodyOptionalThrough: protectsFromLoad ? addDays(latestRun.date, 1) : null,
      reason: protectionActive
        ? `${details} was logged ${when}. Protect the next 24-72 hours from duplicate or conflicting load.`
        : null,
    },
  };
}

module.exports = {
  addDays,
  daysBetween,
  normalizeRun,
  summarizeRecentRunLoad,
};
