const planSchema = require('./planSchema');

const WINDOW_DAYS = 28;
const HYBRID_WEEK_TARGET = 4;
const MIN_RUN_MILES = 1;
const MIN_RUN_SECONDS = 10 * 60;

const BENCHMARK_RUN_LABELS = new Set([
  '1 Mile PR',
  '5K PR',
  '10K PR',
  '15K PR',
  '10 Mile PR',
  'Half Marathon PR',
  'Marathon PR',
  'Fastest Mile',
  'Fastest Pace',
  'Best Avg Pace',
  'Longest Run',
]);

function normalizeDate(value) {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function toISODate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function addDays(iso, amount) {
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function daysBetween(startISO, endISO) {
  const start = new Date(`${startISO}T12:00:00Z`);
  const end = new Date(`${endISO}T12:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.round((end.getTime() - start.getTime()) / 86400000);
}

function rowDate(row) {
  return normalizeDate(row?.date || row?.started_at || row?.created_at || row?.achieved_at);
}

function positiveNumber(value, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(number, max) : 0;
}

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(Number(value || 0) * factor) / factor;
}

function maxDate(dates) {
  return dates.map(normalizeDate).filter(Boolean).sort().slice(-1)[0] || null;
}

function mondayOf(iso) {
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + mondayOffset);
  return date.toISOString().slice(0, 10);
}

function parseJsonValue(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function activePlanRow(activePlan) {
  return activePlan?.row || activePlan || null;
}

function parsePlan(activePlan) {
  const row = activePlanRow(activePlan);
  if (!row) return null;
  return parseJsonValue(row.plan_data, null) || parseJsonValue(row.plan_json, null);
}

function planStartDate(activePlan, plan, fallback) {
  const row = activePlanRow(activePlan);
  return normalizeDate(
    row?.week_start
      || row?.started_at
      || plan?.weeks?.[0]?.startDate
      || plan?.weeks?.[0]?.week_start
      || fallback
  );
}

function dayToDate(weekStart, dayLabel) {
  const map = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
  const index = map[String(dayLabel || '').slice(0, 3).toLowerCase()];
  if (index === undefined || !weekStart) return null;
  return addDays(weekStart, index);
}

function dateWithinOneDay(actualISO, targetISO) {
  const actual = new Date(`${actualISO}T12:00:00Z`);
  const target = new Date(`${targetISO}T12:00:00Z`);
  if (Number.isNaN(actual.getTime()) || Number.isNaN(target.getTime())) return false;
  return Math.abs(actual.getTime() - target.getTime()) <= 86400000;
}

function isQualifyingRun(row) {
  return positiveNumber(row?.distance_miles, 500) >= MIN_RUN_MILES
    || positiveNumber(row?.duration_seconds, 24 * 60 * 60) >= MIN_RUN_SECONDS;
}

function isQualifyingLift(row) {
  return Boolean(rowDate(row));
}

function liftTonnage(rows) {
  return (Array.isArray(rows) ? rows : []).reduce((sum, row) => (
    sum
      + positiveNumber(row?.sets, 100)
      * positiveNumber(row?.reps, 500)
      * positiveNumber(row?.weight_lbs, 5000)
  ), 0);
}

function runMiles(rows) {
  return (Array.isArray(rows) ? rows : []).reduce((sum, row) => (
    sum + positiveNumber(row?.distance_miles, 500)
  ), 0);
}

function rowsBetween(rows, startISO, endISO) {
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    const date = rowDate(row);
    return date && date >= startISO && date <= endISO;
  });
}

function distinctDateCount(rows) {
  return new Set((Array.isArray(rows) ? rows : []).map(rowDate).filter(Boolean)).size;
}

function buildHybridWeeks(runs, lifts) {
  const byWeek = new Map();
  const ensure = (week) => {
    if (!byWeek.has(week)) {
      byWeek.set(week, { week, runDates: new Set(), liftDates: new Set() });
    }
    return byWeek.get(week);
  };

  for (const run of Array.isArray(runs) ? runs : []) {
    const date = rowDate(run);
    if (!date || !isQualifyingRun(run)) continue;
    ensure(mondayOf(date)).runDates.add(date);
  }
  for (const lift of Array.isArray(lifts) ? lifts : []) {
    const date = rowDate(lift);
    if (!date || !isQualifyingLift(lift)) continue;
    ensure(mondayOf(date)).liftDates.add(date);
  }

  return [...byWeek.values()]
    .map((week) => ({
      week: week.week,
      runCount: week.runDates.size,
      liftCount: week.liftDates.size,
      latestDate: maxDate([...week.runDates, ...week.liftDates]),
      hasRun: week.runDates.size > 0,
      hasLift: week.liftDates.size > 0,
    }))
    .sort((left, right) => left.week.localeCompare(right.week));
}

function progress(current, target, unit, label) {
  const bounded = Math.max(0, Math.min(target, current));
  return {
    current: bounded,
    target,
    unit,
    percent: target > 0 ? Math.round((bounded / target) * 100) : 0,
    label: label || `${bounded}/${target} ${unit}`,
  };
}

function hybridWeekBadge(id, label, target, hybridWeeks) {
  const earned = hybridWeeks.length >= target;
  return {
    id,
    label,
    earned,
    earnedAt: earned ? hybridWeeks[target - 1].latestDate : null,
    progress: progress(hybridWeeks.length, target, 'weeks', `${Math.min(hybridWeeks.length, target)}/${target} hybrid weeks`),
  };
}

function consecutiveHybridProgress(hybridWeeks, target) {
  let current = [];
  let best = [];
  let previous = '';

  for (const week of hybridWeeks) {
    current = previous && addDays(previous, 7) === week.week ? current.concat(week) : [week];
    previous = week.week;
    if (current.length > best.length) best = current;
    if (current.length >= target) return { earnedBlock: current.slice(current.length - target), bestCount: target };
  }

  return { earnedBlock: null, bestCount: best.length };
}

function balancedMonthBadge(hybridWeeks) {
  const result = consecutiveHybridProgress(hybridWeeks, HYBRID_WEEK_TARGET);
  const earned = Array.isArray(result.earnedBlock);
  return {
    id: 'balanced_month',
    label: 'Balanced Month',
    earned,
    earnedAt: earned ? result.earnedBlock[result.earnedBlock.length - 1].latestDate : null,
    progress: progress(result.bestCount, HYBRID_WEEK_TARGET, 'weeks', `${result.bestCount}/${HYBRID_WEEK_TARGET} straight hybrid weeks`),
  };
}

function isBenchmarkRunPr(row) {
  const category = String(row?.category || '').toLowerCase();
  const label = String(row?.label || '');
  return category === 'time_pr'
    || (category === 'run' && BENCHMARK_RUN_LABELS.has(label))
    || /^Time PR[:(]/.test(label);
}

function benchmarkPlusStrengthBadge(prs, lifts) {
  const benchmarkPrs = (Array.isArray(prs) ? prs : [])
    .filter((row) => isBenchmarkRunPr(row) && normalizeDate(row?.achieved_at))
    .sort((left, right) => normalizeDate(left.achieved_at).localeCompare(normalizeDate(right.achieved_at)));
  const liftDates = (Array.isArray(lifts) ? lifts : [])
    .map(rowDate)
    .filter(Boolean)
    .sort();

  for (const pr of benchmarkPrs) {
    const prDate = normalizeDate(pr.achieved_at);
    const pairedLift = liftDates.find((date) => Math.abs(daysBetween(prDate, date)) <= 27);
    if (pairedLift) {
      return {
        id: 'benchmark_plus_strength',
        label: 'Benchmark Plus Strength',
        earned: true,
        earnedAt: maxDate([prDate, pairedLift]),
        progress: progress(2, 2, 'signals', 'Benchmark run + lift logged'),
      };
    }
  }

  const current = benchmarkPrs.length && liftDates.length
    ? 1
    : Math.min(1, (benchmarkPrs.length ? 1 : 0) + (liftDates.length ? 1 : 0));
  return {
    id: 'benchmark_plus_strength',
    label: 'Benchmark Plus Strength',
    earned: false,
    earnedAt: null,
    progress: progress(current, 2, 'signals', `${current}/2 paired benchmark + lift`),
  };
}

function isDeloadWeek(week) {
  const text = [
    week?.phase,
    week?.title,
    week?.type,
    week?.focus,
    week?.description,
  ].map((value) => String(value || '').toLowerCase()).join(' ');
  return week?.deload === true
    || week?.recovery === true
    || /\b(deload|recovery|cutback|down week|lighter)\b/.test(text);
}

function completedSession(session, runs, lifts, completedIds, usedRunIndexes, usedLiftIndexes) {
  if (completedIds.has(String(session.sessionId))) return { done: true, date: session.date };
  const bucket = session.type === 'lift' ? lifts : runs;
  const used = session.type === 'lift' ? usedLiftIndexes : usedRunIndexes;
  const hitIndex = (Array.isArray(bucket) ? bucket : []).findIndex((row, index) => (
    !used.has(index) && dateWithinOneDay(rowDate(row), session.date)
  ));
  if (hitIndex < 0) return { done: false, date: null };
  used.add(hitIndex);
  return { done: true, date: rowDate(bucket[hitIndex]) || session.date };
}

function deloadDoneRightBadge({ activePlan, runs, lifts }) {
  const plan = parsePlan(activePlan);
  const row = activePlanRow(activePlan);
  if (!plan || !Array.isArray(plan.weeks)) {
    return {
      id: 'deload_done_right',
      label: 'Deload Done Right',
      earned: false,
      earnedAt: null,
      progress: progress(0, 1, 'weeks', '0/1 planned hybrid deload weeks'),
    };
  }

  const planStart = planStartDate(activePlan, plan, toISODate());
  const progressJson = parseJsonValue(row?.progress_json, {});
  const completedIds = new Set(
    (Array.isArray(progressJson?.completedSessionIds) ? progressJson.completedSessionIds : []).map(String)
  );
  let bestCompleted = 0;
  let bestPlanned = 1;

  for (let weekIndex = 0; weekIndex < plan.weeks.length; weekIndex += 1) {
    const week = plan.weeks[weekIndex] || {};
    if (!isDeloadWeek(week)) continue;
    const weekStart = normalizeDate(week.startDate || week.week_start || addDays(planStart, weekIndex * 7));
    const planned = [];
    planSchema.getDayEntries(week).forEach((day, dayIndex) => {
      const date = normalizeDate(day?.date || dayToDate(weekStart, day?.day) || addDays(weekStart, dayIndex));
      planSchema.plannedSessionsForDay(day, dayIndex, date)
        .filter((session) => session.type === 'run' || session.type === 'lift')
        .forEach((session) => planned.push(session));
    });
    const plannedTypes = new Set(planned.map((session) => session.type));
    if (!planned.length || !plannedTypes.has('run') || !plannedTypes.has('lift')) continue;

    const usedRunIndexes = new Set();
    const usedLiftIndexes = new Set();
    const completed = planned.map((session) => (
      completedSession(session, runs, lifts, completedIds, usedRunIndexes, usedLiftIndexes)
    ));
    const completedCount = completed.filter((item) => item.done).length;
    if (completedCount > bestCompleted) {
      bestCompleted = completedCount;
      bestPlanned = planned.length;
    }
    if (completedCount === planned.length) {
      return {
        id: 'deload_done_right',
        label: 'Deload Done Right',
        earned: true,
        earnedAt: maxDate(completed.map((item) => item.date).filter(Boolean)) || addDays(weekStart, 6),
        progress: progress(planned.length, planned.length, 'sessions', `${planned.length}/${planned.length} planned deload sessions`),
      };
    }
  }

  return {
    id: 'deload_done_right',
    label: 'Deload Done Right',
    earned: false,
    earnedAt: null,
    progress: progress(bestCompleted, bestPlanned, 'sessions', `${bestCompleted}/${bestPlanned} planned deload sessions`),
  };
}

function hybridScoreBadge(hybridScore, hybridWeeks, now) {
  const score = Math.round(Number(hybridScore?.score ?? hybridScore ?? 0));
  const hasHybridWeek = hybridWeeks.length > 0;
  const earned = score >= 70 && hasHybridWeek;
  return {
    id: 'hybrid_score_70',
    label: 'Hybrid Score 70',
    earned,
    earnedAt: earned ? toISODate(now) : null,
    progress: progress(Math.min(score, 70), 70, 'points', `${Math.min(score, 70)}/70 Hybrid Score`),
  };
}

function computeBadges({ userId, runs, lifts, prs, activePlan, hybridScore, now = new Date() } = {}) {
  void userId;
  const hybridWeeks = buildHybridWeeks(runs, lifts).filter((week) => week.hasRun && week.hasLift);
  const todayISO = toISODate(now);
  const currentStart = addDays(todayISO, -(WINDOW_DAYS - 1));
  const recentHybridWeeks = buildHybridWeeks(
    rowsBetween(runs, currentStart, todayISO),
    rowsBetween(lifts, currentStart, todayISO)
  ).filter((week) => week.hasRun && week.hasLift);
  return [
    hybridWeekBadge('hybrid_week_2', 'Two Hybrid Weeks', 2, hybridWeeks),
    hybridWeekBadge('hybrid_week_4', 'Four Hybrid Weeks', 4, hybridWeeks),
    balancedMonthBadge(hybridWeeks),
    benchmarkPlusStrengthBadge(prs, lifts),
    deloadDoneRightBadge({ activePlan, runs, lifts }),
    hybridScoreBadge(hybridScore, recentHybridWeeks, now),
  ];
}

function bucketHybridWeeks(runs, lifts, startISO, endISO) {
  const bucketCount = Math.max(1, Math.ceil((daysBetween(startISO, endISO) + 1) / 7));
  const buckets = Array.from({ length: bucketCount }, () => ({ hasRun: false, hasLift: false }));
  const mark = (date, key) => {
    const index = Math.floor(daysBetween(startISO, date) / 7);
    if (index >= 0 && index < buckets.length) buckets[index][key] = true;
  };

  for (const run of runs) {
    const date = rowDate(run);
    if (date && isQualifyingRun(run)) mark(date, 'hasRun');
  }
  for (const lift of lifts) {
    const date = rowDate(lift);
    if (date && isQualifyingLift(lift)) mark(date, 'hasLift');
  }

  return buckets.filter((bucket) => bucket.hasRun && bucket.hasLift).length;
}

function summarizeWindow(runs, lifts, startISO, endISO) {
  const windowRuns = rowsBetween(runs, startISO, endISO);
  const windowLifts = rowsBetween(lifts, startISO, endISO);
  const targetWeeks = Math.max(1, Math.ceil((daysBetween(startISO, endISO) + 1) / 7));
  const hybridWeeks = bucketHybridWeeks(windowRuns, windowLifts, startISO, endISO);
  return {
    mileage: round(runMiles(windowRuns), 1),
    liftTonnage: Math.round(liftTonnage(windowLifts)),
    liftSessions: distinctDateCount(windowLifts),
    consistency: Math.round((hybridWeeks / targetWeeks) * 100),
    hybridWeeks,
    targetWeeks,
  };
}

function percentDelta(current, prior) {
  if (prior === 0) return current === 0 ? 0 : null;
  return round(((current - prior) / prior) * 100, 1);
}

function metric(current, prior, decimals = 1) {
  const roundedCurrent = round(current, decimals);
  const roundedPrior = round(prior, decimals);
  return {
    current: roundedCurrent,
    prior: roundedPrior,
    delta: round(roundedCurrent - roundedPrior, decimals),
    percentDelta: percentDelta(roundedCurrent, roundedPrior),
  };
}

function buildYouVsLastMonth({ runs, lifts, now = new Date(), currentHybridScore, priorHybridScore } = {}) {
  const todayISO = toISODate(now);
  const currentStart = addDays(todayISO, -(WINDOW_DAYS - 1));
  const priorEnd = addDays(currentStart, -1);
  const priorStart = addDays(priorEnd, -(WINDOW_DAYS - 1));
  const current = summarizeWindow(runs, lifts, currentStart, todayISO);
  const prior = summarizeWindow(runs, lifts, priorStart, priorEnd);
  const currentScore = Math.round(Number(currentHybridScore?.score ?? currentHybridScore ?? 0));
  const priorScore = Math.round(Number(priorHybridScore?.score ?? priorHybridScore ?? 0));

  return {
    windowDays: WINDOW_DAYS,
    currentWindow: { start: currentStart, end: todayISO },
    priorWindow: { start: priorStart, end: priorEnd },
    mileage: metric(current.mileage, prior.mileage, 1),
    liftTonnage: metric(current.liftTonnage, prior.liftTonnage, 0),
    liftSessions: metric(current.liftSessions, prior.liftSessions, 0),
    consistency: {
      ...metric(current.consistency, prior.consistency, 0),
      currentHybridWeeks: current.hybridWeeks,
      priorHybridWeeks: prior.hybridWeeks,
      targetWeeks: current.targetWeeks,
    },
    hybridScore: metric(currentScore, priorScore, 0),
  };
}

module.exports = {
  computeBadges,
  buildYouVsLastMonth,
  _test: {
    buildHybridWeeks,
    summarizeWindow,
    isQualifyingRun,
    isQualifyingLift,
  },
};
