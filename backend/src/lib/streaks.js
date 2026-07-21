const planSchema = require('./planSchema');
const { addDays, serverUtcAnchorCandidates } = require('./streak');
const { reconciliationKey } = require('./hybridReconciliation');

const HYBRID_STREAK_CONSTANTS = Object.freeze({
  MIN_RUN_MILES: 1,
  MIN_RUN_SECONDS: 10 * 60,
  MIN_LIFT_ROWS: 1,
  MAX_GRACE_DAYS_PER_WEEK: 1,
  FIRST_STREAK_DAYS: 7,
  TEN_MILE_WEEK_MILES: 10,
  CONSISTENT_LIFTING_WEEKS: 4,
  MIN_LIFT_DAYS_PER_WEEK: 1,
  UNPLANNED_REQUIRED_MODALITIES: Object.freeze(['run', 'lift']),
});

function normalizeDate(value) {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : '';
}

function toISODate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
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

function dayToDate(weekStart, dayLabel) {
  const map = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
  const index = map[String(dayLabel || '').slice(0, 3).toLowerCase()];
  if (index === undefined || !weekStart) return null;
  return addDays(weekStart, index);
}

function planStartDate(activePlan, plan) {
  const row = activePlanRow(activePlan);
  return normalizeDate(
    row?.week_start
      || row?.started_at
      || plan?.weeks?.[0]?.startDate
      || plan?.weeks?.[0]?.week_start
  );
}

function firstDate(values) {
  return values.map(normalizeDate).filter(Boolean).sort()[0] || '';
}

function mondayOf(iso) {
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  date.setUTCDate(date.getUTCDate() + mondayOffset);
  return date.toISOString().slice(0, 10);
}

function runDate(row) {
  return normalizeDate(row?.date || row?.started_at || row?.created_at);
}

function liftDate(row) {
  return normalizeDate(row?.date || row?.started_at || row?.created_at);
}

function positiveNumber(value, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.min(number, max) : 0;
}

function buildActivityByDate(runs, lifts) {
  const byDate = new Map();
  const ensure = (date) => {
    if (!byDate.has(date)) {
      byDate.set(date, {
        date,
        runMiles: 0,
        runSeconds: 0,
        liftRows: 0,
      });
    }
    return byDate.get(date);
  };

  for (const row of Array.isArray(runs) ? runs : []) {
    const date = runDate(row);
    if (!date) continue;
    const entry = ensure(date);
    entry.runMiles += positiveNumber(row.distance_miles, 500);
    entry.runSeconds += positiveNumber(row.duration_seconds, 24 * 60 * 60);
  }

  for (const row of Array.isArray(lifts) ? lifts : []) {
    const date = liftDate(row);
    if (!date) continue;
    ensure(date).liftRows += 1;
  }

  for (const entry of byDate.values()) {
    entry.hasRun = entry.runMiles >= HYBRID_STREAK_CONSTANTS.MIN_RUN_MILES
      || entry.runSeconds >= HYBRID_STREAK_CONSTANTS.MIN_RUN_SECONDS;
    entry.hasLift = entry.liftRows >= HYBRID_STREAK_CONSTANTS.MIN_LIFT_ROWS;
  }

  return byDate;
}

function buildPlannedDaysBetween(activePlan, startISO, endISO) {
  const plan = parsePlan(activePlan);
  if (!plan || !Array.isArray(plan.weeks)) return new Map();

  const row = activePlanRow(activePlan);
  const planStart = planStartDate(activePlan, plan) || startISO;
  const progress = parseJsonValue(row?.progress_json, {});
  const completedIds = new Set((Array.isArray(progress?.completedSessionIds) ? progress.completedSessionIds : []).map(String));
  const reconciliations = progress?.hybridSessionReconciliations && typeof progress.hybridSessionReconciliations === 'object'
    ? progress.hybridSessionReconciliations
    : {};
  const byDate = new Map();

  plan.weeks.forEach((week, weekIndex) => {
    const weekStart = normalizeDate(week?.startDate || week?.week_start || addDays(planStart, weekIndex * 7));
    planSchema.getDayEntries(week).forEach((day, dayIndex) => {
      const date = normalizeDate(day?.date || dayToDate(weekStart, day?.day) || addDays(weekStart, dayIndex));
      if (!date || date < startISO || date > endISO) return;
      const sessions = planSchema.plannedSessionsForDay(day, dayIndex, date)
        .filter((session) => session.type === 'run' || session.type === 'lift');
      const existing = byDate.get(date) || {
        date,
        planned: true,
        isRest: true,
        requiredTypes: new Set(),
        completedTypes: new Set(),
      };

      existing.isRest = existing.isRest && sessions.length === 0 && planSchema.isRestEntry(day);
      for (const session of sessions) {
        existing.isRest = false;
        const completed = completedIds.has(String(session.sessionId));
        const reconciliation = session.type === 'lift'
          ? reconciliations[reconciliationKey(date, session.sessionId)]
          : null;
        const excused = !completed && reconciliation && ['life_event', 'skipped'].includes(reconciliation.response);
        if (excused) continue;
        existing.requiredTypes.add(session.type);
        if (completed) existing.completedTypes.add(session.type);
      }
      byDate.set(date, existing);
    });
  });

  return byDate;
}

function hasRequiredType(type, activity, planDay) {
  if (planDay?.completedTypes?.has(type)) return true;
  if (type === 'run') return Boolean(activity?.hasRun);
  if (type === 'lift') return Boolean(activity?.hasLift);
  return false;
}

function actualTypeSet(activity) {
  const set = new Set();
  if (activity?.hasRun) set.add('run');
  if (activity?.hasLift) set.add('lift');
  return set;
}

function classifyHybridDay(date, planDay, activity, graceByWeek) {
  const actualTypes = actualTypeSet(activity);
  const plannedTypes = planDay?.requiredTypes || new Set();
  const unplannedTypes = new Set(HYBRID_STREAK_CONSTANTS.UNPLANNED_REQUIRED_MODALITIES);
  const requiredTypes = plannedTypes.size ? plannedTypes : unplannedTypes;
  const isPlannedRest = Boolean(planDay?.planned && planDay?.isRest && plannedTypes.size === 0);
  const metRequired = [...requiredTypes].every((type) => hasRequiredType(type, activity, planDay));

  if (metRequired) {
    return {
      date,
      qualifies: true,
      grace: false,
      reason: plannedTypes.size ? 'scheduled_activity' : 'balanced_default',
      requiredTypes: [...requiredTypes],
      actualTypes: [...actualTypes],
    };
  }

  if (planDay?.planned) {
    const week = mondayOf(date);
    const used = graceByWeek.get(week) || 0;
    if (used < HYBRID_STREAK_CONSTANTS.MAX_GRACE_DAYS_PER_WEEK) {
      graceByWeek.set(week, used + 1);
      return {
        date,
        qualifies: true,
        grace: true,
        reason: isPlannedRest ? 'planned_rest_grace' : 'missed_planned_grace',
        requiredTypes: [...(plannedTypes.size ? plannedTypes : [])],
        actualTypes: [...actualTypes],
      };
    }
  }

  return {
    date,
    qualifies: false,
    grace: false,
    reason: planDay?.planned ? 'missed_required_activity' : 'unbalanced_or_inactive',
    requiredTypes: [...requiredTypes],
    actualTypes: [...actualTypes],
  };
}

function dateRange(startISO, endISO) {
  const dates = [];
  let cursor = startISO;
  while (cursor && cursor <= endISO) {
    dates.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return dates;
}

function computeLongest(states) {
  let longest = 0;
  let current = 0;
  for (const state of states) {
    if (state.qualifies) {
      current += 1;
      longest = Math.max(longest, current);
    } else {
      current = 0;
    }
  }
  return longest;
}

function computeCurrent(states, anchorCandidates) {
  const byDate = new Map(states.map((state) => [state.date, state]));
  const anchors = [...new Set((anchorCandidates || []).map(normalizeDate).filter(Boolean))]
    .sort()
    .reverse();
  const start = anchors.find((anchor) => byDate.get(anchor)?.qualifies);
  if (!start) return { currentStreak: 0, graceUsed: false };

  let currentStreak = 0;
  let graceUsed = false;
  let cursor = start;
  while (byDate.get(cursor)?.qualifies) {
    const state = byDate.get(cursor);
    currentStreak += 1;
    graceUsed = graceUsed || Boolean(state.grace);
    cursor = addDays(cursor, -1);
  }
  return { currentStreak, graceUsed };
}

function computeHybridStreak({ runs, lifts, activePlan, now = new Date(), anchorCandidates } = {}) {
  const todayISO = toISODate(now);
  const tomorrowISO = addDays(todayISO, 1);
  const activityByDate = buildActivityByDate(runs, lifts);
  const endISO = activityByDate.has(tomorrowISO) ? tomorrowISO : todayISO;
  const plan = parsePlan(activePlan);
  const startISO = firstDate([
    ...activityByDate.keys(),
    planStartDate(activePlan, plan),
    todayISO,
  ]);
  const plannedDays = buildPlannedDaysBetween(activePlan, startISO, endISO);
  const graceByWeek = new Map();
  const states = dateRange(startISO, endISO).map((date) => (
    classifyHybridDay(date, plannedDays.get(date), activityByDate.get(date), graceByWeek)
  ));
  const current = computeCurrent(states, anchorCandidates || serverUtcAnchorCandidates(now));

  return {
    currentStreak: current.currentStreak,
    longestStreak: computeLongest(states),
    unit: 'day',
    graceUsed: current.graceUsed,
    states,
  };
}

function hasTenMileWeek(runs) {
  const milesByWeek = new Map();
  for (const row of Array.isArray(runs) ? runs : []) {
    const date = runDate(row);
    if (!date) continue;
    const week = mondayOf(date);
    milesByWeek.set(week, (milesByWeek.get(week) || 0) + positiveNumber(row.distance_miles, 500));
  }
  return [...milesByWeek.values()].some((miles) => miles >= HYBRID_STREAK_CONSTANTS.TEN_MILE_WEEK_MILES);
}

function hasConsistentLiftingMonth(lifts) {
  const liftDaysByWeek = new Map();
  for (const row of Array.isArray(lifts) ? lifts : []) {
    const date = liftDate(row);
    if (!date) continue;
    const week = mondayOf(date);
    if (!liftDaysByWeek.has(week)) liftDaysByWeek.set(week, new Set());
    liftDaysByWeek.get(week).add(date);
  }

  const weeks = [...liftDaysByWeek.entries()]
    .filter(([, dates]) => dates.size >= HYBRID_STREAK_CONSTANTS.MIN_LIFT_DAYS_PER_WEEK)
    .map(([week]) => week)
    .sort();
  let streak = 0;
  let previous = '';
  for (const week of weeks) {
    streak = previous && addDays(previous, 7) === week ? streak + 1 : 1;
    previous = week;
    if (streak >= HYBRID_STREAK_CONSTANTS.CONSISTENT_LIFTING_WEEKS) return true;
  }
  return false;
}

function phaseLabel(value) {
  const cleaned = String(value || '').trim().replace(/[_-]+/g, ' ');
  if (!cleaned) return '';
  return cleaned.replace(/\b\w/g, (char) => char.toUpperCase());
}

function planRef(row) {
  return String(row?.user_plan_id || row?.plan_id || row?.id || 'active')
    .replace(/[^a-zA-Z0-9_-]/g, '')
    .slice(0, 48) || 'active';
}

function completedPlanPhaseMilestones(activePlan) {
  const row = activePlanRow(activePlan);
  const plan = parsePlan(activePlan);
  const currentWeek = Number(row?.current_week || 1);
  if (!row || !plan || !Array.isArray(plan.weeks) || currentWeek <= 1) return [];

  const milestones = [];
  let index = 0;
  while (index < plan.weeks.length) {
    const phase = String(plan.weeks[index]?.phase || '').trim().toLowerCase();
    if (!phase) {
      index += 1;
      continue;
    }
    let end = index;
    while (end + 1 < plan.weeks.length && String(plan.weeks[end + 1]?.phase || '').trim().toLowerCase() === phase) {
      end += 1;
    }
    const endWeek = end + 1;
    if (currentWeek > endWeek) {
      const label = phaseLabel(phase);
      milestones.push({
        key: `hybrid_phase_complete_${planRef(row)}_${phase}_${endWeek}`,
        title: `${label} Phase Complete`,
        description: `You completed the ${label.toLowerCase()} phase of your hybrid plan.`,
      });
    }
    index = end + 1;
  }
  return milestones;
}

function detectHybridMilestones({ streak, runs, lifts, activePlan } = {}) {
  const milestones = [];
  const add = (key, title, description) => milestones.push({ key, title, description });

  if (Number(streak?.longestStreak || 0) >= HYBRID_STREAK_CONSTANTS.FIRST_STREAK_DAYS) {
    add(
      'hybrid_streak_7',
      '7-Day Hybrid Streak',
      'You kept the run and lift rhythm alive for 7 straight days.'
    );
  }
  if (hasTenMileWeek(runs)) {
    add(
      'hybrid_10_mile_week',
      'First 10-Mile Week',
      'You crossed 10 running miles in a week.'
    );
  }
  if (hasConsistentLiftingMonth(lifts)) {
    add(
      'hybrid_lifting_month',
      'Consistent Lifting Month',
      'You logged lifting in 4 straight weeks.'
    );
  }
  milestones.push(...completedPlanPhaseMilestones(activePlan));

  return milestones;
}

function filterNewHybridMilestones(candidates, seenKeys) {
  const seen = seenKeys instanceof Set ? seenKeys : new Set(seenKeys || []);
  const added = new Set();
  return (Array.isArray(candidates) ? candidates : []).filter((milestone) => {
    const key = String(milestone?.key || '');
    if (!key || seen.has(key) || added.has(key)) return false;
    added.add(key);
    return true;
  });
}

module.exports = {
  HYBRID_STREAK_CONSTANTS,
  buildActivityByDate,
  computeHybridStreak,
  detectHybridMilestones,
  filterNewHybridMilestones,
  normalizeDate,
  toISODate,
};
