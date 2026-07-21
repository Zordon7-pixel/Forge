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

function sessionEvidenceKey(session, index = 0) {
  const explicit = String(session?.key || '').trim();
  if (explicit) return explicit;
  const date = String(session?.date || '').slice(0, 10);
  const sessionId = String(session?.sessionId || session?.liftSessionId || '').trim();
  const kind = String(session?.kind || session?.type || 'session').trim().toLowerCase();
  return `${kind}:${date}:${sessionId || index}`;
}

function allocateSessionEvidence({
  sessions = [],
  completedSessionIds = [],
  reconciliations = {},
  evidence = [],
  maxDayDistance = 0,
  allowNextDayForLater = false,
} = {}) {
  const records = normalizeRecords(reconciliations);
  const completedIds = new Set(completedSessionIds.map(String));
  const normalizedSessions = (Array.isArray(sessions) ? sessions : []).map((session, index) => {
    const date = String(session?.date || '').slice(0, 10);
    const sessionId = String(session?.sessionId || session?.liftSessionId || '').trim();
    const key = sessionEvidenceKey(session, index);
    const record = records[reconciliationKey(date, sessionId)];
    const completedUntracked = record?.response === 'completed_untracked';
    return {
      ...session,
      date,
      sessionId,
      key,
      kind: String(session?.kind || session?.type || '').trim().toLowerCase(),
      record,
      completedUntracked,
      completedByProgress: completedIds.has(sessionId) || completedUntracked,
    };
  }).filter((session) => parseISODate(session.date) && session.sessionId);
  const normalizedEvidence = (Array.isArray(evidence) ? evidence : []).map((item, index) => ({
    index,
    date: String(typeof item === 'string' ? item : item?.date || '').slice(0, 10),
    kind: String(typeof item === 'string' ? '' : item?.kind || item?.type || '').trim().toLowerCase(),
  })).filter((item) => parseISODate(item.date));
  const completedKeys = new Set();
  const usedEvidenceIndexes = new Set();
  const sourceByKey = new Map();

  for (const session of normalizedSessions) {
    if (!session.completedByProgress) continue;
    completedKeys.add(session.key);
    sourceByKey.set(session.key, session.completedUntracked ? 'completed_untracked' : 'progress');
  }

  const compatibleKind = (session, item) => !session.kind || !item.kind || session.kind === item.kind;
  const distance = (session, item) => Math.abs(daysBetween(item.date, session.date));
  const consume = (session, predicate, markComplete) => {
    const item = normalizedEvidence.find((candidate) => (
      !usedEvidenceIndexes.has(candidate.index)
      && compatibleKind(session, candidate)
      && predicate(candidate)
    ));
    if (!item) return false;
    usedEvidenceIndexes.add(item.index);
    if (markComplete) completedKeys.add(session.key);
    sourceByKey.set(session.key, session.completedByProgress ? 'progress_and_log' : 'log');
    return true;
  };

  const progressSessions = normalizedSessions.filter((session) => (
    session.completedByProgress && !session.completedUntracked
  ));
  const incompleteSessions = () => normalizedSessions.filter((session) => !completedKeys.has(session.key));

  // Consume exact-date logs that overlap a tracked completion before those logs
  // are offered to another planned session. Explicit untracked completion never
  // consumes a real activity row.
  progressSessions.forEach((session) => consume(session, (item) => item.date === session.date, false));
  incompleteSessions().forEach((session) => consume(session, (item) => item.date === session.date, true));

  const dayWindow = Math.max(0, Math.floor(Number(maxDayDistance) || 0));
  if (dayWindow > 0) {
    progressSessions.forEach((session) => consume(session, (item) => {
      const dayDistance = distance(session, item);
      return dayDistance > 0 && dayDistance <= dayWindow;
    }, false));
    incompleteSessions().forEach((session) => consume(session, (item) => {
      const dayDistance = distance(session, item);
      return dayDistance > 0 && dayDistance <= dayWindow;
    }, true));
  }

  if (allowNextDayForLater) {
    incompleteSessions()
      .filter((session) => session.record?.response === 'later')
      .forEach((session) => consume(session, (item) => item.date === addDays(session.date, 1), true));
  }

  return {
    completedKeys,
    usedEvidenceIndexes,
    sourceByKey,
  };
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
  const liftAllocation = allocateSessionEvidence({
    sessions: candidates.map((candidate) => ({
      key: candidate.key,
      date: candidate.date,
      sessionId: candidate.liftSessionId,
      kind: 'lift',
    })),
    completedSessionIds,
    reconciliations: records,
    evidence: liftDates.map((date) => ({ date, kind: 'lift' })),
    allowNextDayForLater: true,
  });

  for (const candidate of candidates) {
    if (candidate.date === planningDateISO && (!Number.isInteger(hour) || hour < PROMPT_HOUR)) continue;
    const runComplete = candidate.runSessionIds.some((id) => completed.has(id)) || runDateSet.has(candidate.date);
    const liftComplete = liftAllocation.completedKeys.has(candidate.key);
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
  sessionEvidenceKey,
  allocateSessionEvidence,
  hybridCandidates,
  patternSummary,
  buildCurrentPrompt,
  findCandidate,
  moveLiftToNextAvailableRestDay,
};
