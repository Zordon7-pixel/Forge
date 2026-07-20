// Pure recent-run load summary used by plan generation and live adaptation.

const { isRunActivity } = require('./runActivity');
const { resolveRunEffort } = require('./runEffort');

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

function mondayFor(iso) {
  const date = parseISODate(iso);
  if (!date) return null;
  return addDays(iso, -((date.getUTCDay() + 6) % 7));
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

function normalizedChoice(value, choices) {
  const normalized = String(value || '').toLowerCase();
  return choices.includes(normalized) ? normalized : null;
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
  const effort = resolveRunEffort(row);
  return {
    date,
    distanceMiles,
    durationSeconds,
    durationMinutes: durationSeconds > 0 ? round(durationSeconds / 60, 1) : null,
    paceSecondsPerMile: paceSecondsPerMile ? Math.round(paceSecondsPerMile) : null,
    paceLabel: paceLabel(paceSecondsPerMile),
    perceivedEffort: effort.source === 'user_rated' ? effort.score : null,
    effectiveEffort: effort.score,
    effortSource: effort.source,
    effortCoveragePct: effort.coveragePct || null,
    avgHeartRate: finiteNumber(row.avg_heart_rate, 30, 240),
    postRunPain: normalizedChoice(row.pain_level, ['none', 'mild', 'moderate', 'severe']),
    postRunEnergy: normalizedChoice(row.post_energy, ['low', 'medium', 'high']),
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
  const meaningful = normalized.filter((run) => (
    run.distanceMiles >= 1
    || run.durationSeconds >= 600
    || Number(run.effectiveEffort || 0) >= 7
    || ['moderate', 'severe'].includes(run.postRunPain)
    || run.postRunEnergy === 'low'
  ));
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

  const longRunThresholdMiles = round(Math.min(8, Math.max(5, weeklyBaseline * 0.35 || 5)), 1);
  const annotate = (run) => {
    const daysSince = daysBetween(todayISO, run.date);
    const isLong = run.distanceMiles >= longRunThresholdMiles || run.durationSeconds >= 75 * 60;
    const isHard = Number(run.effectiveEffort || 0) >= 7;
    const postRunCaution = ['moderate', 'severe'].includes(run.postRunPain) || run.postRunEnergy === 'low';
    const postRunSevere = run.postRunPain === 'severe';
    return {
      ...run,
      distanceMiles: round(run.distanceMiles, 3),
      daysSince,
      isLong,
      isHard,
      postRunCaution,
      postRunSevere,
      distanceShareOfWeeklyBaseline: weeklyBaseline > 0 ? round(run.distanceMiles / weeklyBaseline, 2) : null,
    };
  };
  const annotatedLatest = latestRun ? annotate(latestRun) : null;
  const currentWeekStart = todayISO ? mondayFor(todayISO) : null;
  const currentWeekRuns = currentWeekStart
    ? meaningful.filter((run) => run.date >= currentWeekStart && run.date <= todayISO).map(annotate)
    : [];
  const currentWeekLongest = currentWeekRuns
    .slice()
    .sort((left, right) => right.distanceMiles - left.distanceMiles || right.durationSeconds - left.durationSeconds)[0] || null;
  const currentWeek = {
    startDate: currentWeekStart,
    miles: round(normalized
      .filter((run) => currentWeekStart && run.date >= currentWeekStart && run.date <= todayISO)
      .reduce((sum, run) => sum + run.distanceMiles, 0), 1),
    runCount: currentWeekRuns.length,
    runDates: [...new Set(currentWeekRuns.map((run) => run.date))],
    longRunCompleted: Boolean(currentWeekLongest?.isLong),
    longestRun: currentWeekLongest,
  };

  if (!annotatedLatest || !todayISO) {
    return {
      available: false,
      weeklyBaseline: round(weeklyBaseline, 1),
      sevenDayMiles,
      latestRun: null,
      protectiveRun: null,
      currentWeek,
      protection: { active: false },
    };
  }

  const protectiveRun = meaningful
    .map(annotate)
    .filter((run) => run.daysSince !== null && run.daysSince >= 0 && run.daysSince <= 3 && (run.isLong || run.isHard || run.postRunCaution))
    .sort((left, right) => (
      Number(right.postRunSevere) - Number(left.postRunSevere)
      || Number(right.postRunCaution) - Number(left.postRunCaution)
      || Number(right.isLong && right.isHard) - Number(left.isLong && left.isHard)
      || Math.max(right.distanceMiles / longRunThresholdMiles, right.durationSeconds / 4500, Number(right.effectiveEffort || 0) / 7)
        - Math.max(left.distanceMiles / longRunThresholdMiles, left.durationSeconds / 4500, Number(left.effectiveEffort || 0) / 7)
      || right.date.localeCompare(left.date)
    ))[0] || null;
  const recoveryCaution = ['low', 'recovery', 'caution'].includes(recoveryState);
  const protectsFromLoad = Boolean(protectiveRun);
  const hardProtectionDays = protectsFromLoad
    ? protectiveRun.postRunSevere ? 3 : protectiveRun.postRunCaution || (protectiveRun.isLong && protectiveRun.isHard) || recoveryCaution ? 2 : 1
    : 0;
  const lowerProtectionDays = protectsFromLoad
    ? protectiveRun.postRunSevere ? 3 : protectiveRun.postRunCaution || recoveryCaution ? 2 : 1
    : 0;
  const noAdditionalRunOnDate = annotatedLatest.daysSince === 0 ? annotatedLatest.date : null;
  const protectionActive = Boolean(noAdditionalRunOnDate || protectsFromLoad);
  const reasonRun = protectiveRun || annotatedLatest;
  const when = reasonRun.daysSince === 0 ? 'today' : reasonRun.daysSince === 1 ? 'yesterday' : `${reasonRun.daysSince} days ago`;
  const details = [
    `${round(reasonRun.distanceMiles, 1)} mi`,
    reasonRun.paceLabel,
    reasonRun.durationMinutes ? `${Math.round(reasonRun.durationMinutes)} min` : null,
    reasonRun.avgHeartRate ? `avg HR ${Math.round(reasonRun.avgHeartRate)}` : null,
    reasonRun.effectiveEffort ? `${reasonRun.effortSource === 'user_rated' ? 'rated RPE' : 'calculated effort'} ${reasonRun.effectiveEffort}/10` : null,
    reasonRun.postRunPain && reasonRun.postRunPain !== 'none' ? `${reasonRun.postRunPain} post-run pain` : null,
    reasonRun.postRunEnergy === 'low' ? 'low post-run energy' : null,
  ].filter(Boolean).join(', ');

  return {
    available: true,
    weeklyBaseline: round(weeklyBaseline, 1),
    sevenDayMiles,
    loadRatio: weeklyBaseline > 0 ? round(sevenDayMiles / weeklyBaseline, 2) : null,
    latestRun: annotatedLatest,
    protectiveRun,
    currentWeek,
    protection: {
      active: protectionActive,
      anchorDate: protectiveRun?.date || annotatedLatest.date,
      noAdditionalRunOnDate,
      hardRunsThrough: protectsFromLoad ? addDays(protectiveRun.date, hardProtectionDays) : noAdditionalRunOnDate,
      lowerBodyThrough: protectsFromLoad ? addDays(protectiveRun.date, lowerProtectionDays) : null,
      upperBodyOptionalThrough: protectsFromLoad ? addDays(protectiveRun.date, protectiveRun.postRunSevere ? 2 : 1) : null,
      postRunCaution: Boolean(protectiveRun?.postRunCaution),
      postRunSevere: Boolean(protectiveRun?.postRunSevere),
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
