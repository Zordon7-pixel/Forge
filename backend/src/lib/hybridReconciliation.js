const planSchema = require('./planSchema');

const PROMPT_HOUR = 20;
const LOOKBACK_DAYS = 7;
const PATTERN_WINDOW_DAYS = 28;
const PATTERN_REVIEW_THRESHOLD = 3;
const TERMINAL_RESPONSES = new Set(['completed_untracked', 'life_event', 'skipped']);
const VALID_RESPONSES = new Set([...TERMINAL_RESPONSES, 'later']);

function parseISODate(value) {
  const text = String(value || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function addDays(value, amount) {
  const date = parseISODate(value);
  if (!date) return null;
  date.setUTCDate(date.getUTCDate() + Number(amount || 0));
  return date.toISOString().slice(0, 10);
}

function daysBetween(laterISO, earlierISO) {
  const later = parseISODate(laterISO);
  const earlier = parseISODate(earlierISO);
  if (!later || !earlier) return null;
  return Math.round((later.getTime() - earlier.getTime()) / 86400000);
}

function reconciliationKey(sessionDate, liftSessionId) {
  return `${String(sessionDate || '').slice(0, 10)}:${String(liftSessionId || '')}`;
}

function hybridCandidates(plan, startISO, endISO) {
  const candidates = [];
  const weeks = Array.isArray(plan?.weeks) ? plan.weeks : [];
  weeks.forEach((week, weekIndex) => {
    planSchema.getDayEntries(week).forEach((day, dayIndex) => {
      const date = String(day?.date || '').slice(0, 10);
      if (!parseISODate(date) || date < startISO || date > endISO) return;
      const sessions = planSchema.daySessions(day);
      const runs = sessions.filter((session) => planSchema.kindFromSession(session) === 'run');
      const lifts = sessions.filter((session) => planSchema.kindFromSession(session) === 'lift');
      if (!runs.length || !lifts.length) return;

      const runIds = runs.map((session, index) => (
        planSchema.sessionIdentifier(day, session, sessions.indexOf(session), dayIndex)
          || `${date}-run-${index}`
      ));
      lifts.forEach((lift, liftIndex) => {
        const sessionIndex = sessions.indexOf(lift);
        const liftSessionId = planSchema.sessionIdentifier(day, lift, sessionIndex, dayIndex)
          || `${date}-lift-${liftIndex}`;
        candidates.push({
          key: reconciliationKey(date, liftSessionId),
          date,
          weekIndex,
          dayIndex,
          runSessionIds: runIds.map(String),
          liftSessionId: String(liftSessionId),
          run: runs[0],
          lift,
        });
      });
    });
  });
  return candidates.sort((left, right) => left.date.localeCompare(right.date));
}

function normalizeRecords(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function patternSummary(records, planningDateISO) {
  const decisions = Object.values(normalizeRecords(records)).filter((record) => {
    if (!record || !['life_event', 'skipped'].includes(record.response)) return false;
    const age = daysBetween(planningDateISO, record.sessionDate);
    return age !== null && age >= 0 && age <= PATTERN_WINDOW_DAYS;
  });
  return {
    count: decisions.length,
    windowDays: PATTERN_WINDOW_DAYS,
    reviewRecommended: decisions.length >= PATTERN_REVIEW_THRESHOLD,
  };
}

function buildCurrentPrompt({
  plan,
  planningDateISO,
  localHour,
  completedSessionIds = [],
  reconciliations = {},
  runDates = [],
  liftDates = [],
}) {
  const hour = Number(localHour);
  const completed = new Set(completedSessionIds.map(String));
  const runDateSet = new Set(runDates.map((date) => String(date || '').slice(0, 10)));
  const records = normalizeRecords(reconciliations);
  const startISO = addDays(planningDateISO, -LOOKBACK_DAYS);
  if (!startISO) return null;
  const candidates = hybridCandidates(plan, startISO, planningDateISO);
  const availableLiftEvidence = liftDates.reduce((counts, value) => {
    const date = String(value || '').slice(0, 10);
    if (parseISODate(date)) counts.set(date, (counts.get(date) || 0) + 1);
    return counts;
  }, new Map());
  const completedByLog = new Set();

  // Allocate exact-date lift evidence first so one recorded workout can satisfy
  // only one planned lift. Unused next-day evidence may then satisfy a session
  // the athlete explicitly said they would complete later.
  for (const candidate of candidates) {
    if (completed.has(candidate.liftSessionId)) continue;
    const available = availableLiftEvidence.get(candidate.date) || 0;
    if (available > 0) {
      completedByLog.add(candidate.key);
      availableLiftEvidence.set(candidate.date, available - 1);
    }
  }
  for (const candidate of candidates) {
    if (completed.has(candidate.liftSessionId) || completedByLog.has(candidate.key)) continue;
    const prior = records[candidate.key];
    if (prior?.response !== 'later') continue;
    const nextDate = addDays(candidate.date, 1);
    const available = availableLiftEvidence.get(nextDate) || 0;
    if (available > 0) {
      completedByLog.add(candidate.key);
      availableLiftEvidence.set(nextDate, available - 1);
    }
  }

  for (const candidate of candidates) {
    if (candidate.date === planningDateISO && (!Number.isInteger(hour) || hour < PROMPT_HOUR)) continue;
    const runComplete = candidate.runSessionIds.some((id) => completed.has(id)) || runDateSet.has(candidate.date);
    const liftComplete = completed.has(candidate.liftSessionId) || completedByLog.has(candidate.key);
    if (!runComplete || liftComplete) continue;

    const prior = records[candidate.key];
    if (prior && TERMINAL_RESPONSES.has(prior.response)) continue;
    if (prior?.response === 'later' && prior.respondedDate === planningDateISO) continue;

    return {
      id: candidate.key,
      sessionDate: candidate.date,
      runSessionIds: candidate.runSessionIds,
      liftSessionId: candidate.liftSessionId,
      runTitle: candidate.run?.title || candidate.run?.description || 'Planned run',
      liftTitle: candidate.lift?.title || candidate.lift?.description || 'Planned strength session',
      liftFocus: candidate.lift?.focus || null,
      orderGuidance: 'The run was detected, but the paired strength session was not.',
      pattern: patternSummary(records, planningDateISO),
    };
  }
  return null;
}

function findCandidate(plan, sessionDate, liftSessionId) {
  return hybridCandidates(plan, sessionDate, sessionDate)
    .find((candidate) => candidate.liftSessionId === String(liftSessionId)) || null;
}

function moveLiftToNextAvailableRestDay(plan, candidate, planningDateISO) {
  const weeks = Array.isArray(plan?.weeks) ? plan.weeks : [];
  const sourceWeek = weeks[candidate.weekIndex];
  if (!sourceWeek) return { adjusted: false, reason: 'week_not_found' };
  const moved = planSchema.rescheduleSessionInWeek(sourceWeek, candidate.liftSessionId);
  if (moved.error) return { adjusted: false, reason: moved.error };

  const targetDay = planSchema.getDayEntries(moved.week).find((day) => (
    planSchema.daySessions(day).some((session, index) => (
      planSchema.sessionIdentifier(day, session, index) === candidate.liftSessionId
    ))
  ));
  const targetDate = String(targetDay?.date || '').slice(0, 10);
  if (!parseISODate(targetDate) || targetDate <= planningDateISO) {
    return { adjusted: false, reason: 'no_future_target' };
  }

  const nextWeeks = weeks.slice();
  nextWeeks[candidate.weekIndex] = moved.week;
  return {
    adjusted: true,
    plan: { ...plan, weeks: nextWeeks },
    movedFrom: moved.movedFrom,
    movedTo: moved.movedTo,
  };
}

module.exports = {
  PROMPT_HOUR,
  LOOKBACK_DAYS,
  PATTERN_WINDOW_DAYS,
  PATTERN_REVIEW_THRESHOLD,
  VALID_RESPONSES,
  addDays,
  daysBetween,
  reconciliationKey,
  hybridCandidates,
  patternSummary,
  buildCurrentPrompt,
  findCandidate,
  moveLiftToNextAvailableRestDay,
};
