const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { dbAll, dbGet, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { computeHybridScore } = require('../lib/hybridScore');
const { computeHybridStreak, detectHybridMilestones, filterNewHybridMilestones } = require('../lib/streaks');
const { computeBadges, buildYouVsLastMonth } = require('../lib/badges');
const planSchema = require('../lib/planSchema');
const { runActivitySql } = require('../lib/runActivity');
const {
  reconciliationKey,
  sessionEvidenceKey,
  allocateSessionEvidence,
} = require('../lib/hybridReconciliation');

function toISODate(value) {
  const date = value instanceof Date ? value : new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function addDays(iso, amount) {
  const date = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + amount);
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

function parsePlan(row) {
  if (!row) return null;
  return parseJsonValue(row.plan_data, null) || parseJsonValue(row.plan_json, null);
}

function dayToDate(weekStart, dayLabel) {
  const map = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
  const index = map[String(dayLabel || '').slice(0, 3).toLowerCase()];
  if (index === undefined || !weekStart) return null;
  return addDays(weekStart, index);
}

function plannedSessionsBetween(active, startISO, endISO) {
  const plan = parsePlan(active?.row);
  if (!plan || !Array.isArray(plan.weeks)) return [];
  const rows = [];
  const planStart = active?.row?.week_start || active?.row?.started_at || plan.weeks[0]?.startDate || startISO;

  plan.weeks.forEach((week, weekIndex) => {
    const weekStart = week.startDate || week.week_start || addDays(planStart, weekIndex * 7);
    planSchema.getDayEntries(week).forEach((day, dayIndex) => {
      const date = String(day?.date || dayToDate(weekStart, day?.day) || addDays(weekStart, dayIndex) || '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < startISO || date > endISO) return;
      planSchema.plannedSessionsForDay(day, dayIndex, date)
        .filter((session) => session.type === 'run' || session.type === 'lift')
        .forEach((session) => rows.push(session));
    });
  });

  return rows;
}

function rowDate(row) {
  const raw = String(row?.date || row?.started_at || row?.created_at || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function buildPlanCompletion(active, runs, lifts, startISO, endISO) {
  const planned = plannedSessionsBetween(active, startISO, endISO);
  if (!planned.length) return { planned: 0, completed: 0, adherenceRate: null };

  const progress = parseJsonValue(active?.row?.progress_json, {});
  const completedIds = new Set((Array.isArray(progress?.completedSessionIds) ? progress.completedSessionIds : []).map(String));
  const reconciliations = progress?.hybridSessionReconciliations && typeof progress.hybridSessionReconciliations === 'object'
    ? progress.hybridSessionReconciliations
    : {};
  const completionAllocation = allocateSessionEvidence({
    sessions: planned,
    completedSessionIds: Array.from(completedIds),
    reconciliations,
    evidence: [
      ...(Array.isArray(runs) ? runs : []).map((row) => ({ date: rowDate(row), kind: 'run' })),
      ...(Array.isArray(lifts) ? lifts : []).map((row) => ({ date: rowDate(row), kind: 'lift' })),
    ],
    maxDayDistance: 1,
  });
  let completed = 0;
  let excused = 0;

  planned.forEach((session) => {
    if (completionAllocation.completedKeys.has(sessionEvidenceKey(session))) {
      completed += 1;
      return;
    }
    const reconciliation = session.type === 'lift'
      ? reconciliations[reconciliationKey(session.date, session.sessionId)]
      : null;
    if (reconciliation && ['life_event', 'skipped'].includes(reconciliation.response)) excused += 1;
  });

  const eligiblePlanned = Math.max(0, planned.length - excused);

  return {
    planned: eligiblePlanned,
    scheduled: planned.length,
    completed,
    excused,
    adherenceRate: eligiblePlanned ? completed / eligiblePlanned : null,
  };
}

async function getActivePlanForUser(userId) {
  const assigned = await dbGet(`
    SELECT up.id as user_plan_id, up.plan_id, up.progress_json, up.started_at, up.current_week,
           tp.week_start, tp.plan_json, tp.plan_data
    FROM user_plans up
    JOIN training_plans tp ON tp.id = up.plan_id
    WHERE up.user_id = ? AND up.status = 'active'
    ORDER BY up.created_at DESC
    LIMIT 1
  `, [userId]);
  if (assigned) return { row: assigned };

  const legacy = await dbGet(
    'SELECT id as plan_id, week_start, plan_json, plan_data FROM training_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
    [userId]
  );
  return legacy ? { row: legacy } : null;
}

async function persistNewMilestones(userId, candidates) {
  const seenRows = await dbAll('SELECT milestone_key FROM milestones_seen WHERE user_id = ?', [userId]);
  const unseen = filterNewHybridMilestones(candidates, new Set(seenRows.map((row) => row.milestone_key)));
  const inserted = [];
  for (const milestone of unseen) {
    const result = await dbRun(
      'INSERT INTO milestones_seen (id, user_id, milestone_key) VALUES (?, ?, ?) ON CONFLICT (user_id, milestone_key) DO NOTHING',
      [uuidv4(), userId, milestone.key]
    );
    if (result.changes > 0) inserted.push(milestone);
  }
  return inserted;
}

router.get('/hybrid-score', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const todayISO = toISODate(now);
    const currentStart = addDays(todayISO, -27);
    const baselineStart = addDays(currentStart, -28);

    const [runs, lifts, activePlan] = await Promise.all([
      dbAll(
        `SELECT date, distance_miles, duration_seconds, perceived_effort, avg_heart_rate,
                pain_level, post_energy, pace_avg, health_source, created_at,
                type, watch_activity_type, watch_normalized_type, watch_mode
         FROM runs
         WHERE user_id = ? AND date >= ? AND date <= ? AND ${runActivitySql()}
         ORDER BY date ASC, created_at ASC`,
        [userId, baselineStart, todayISO]
      ),
      dbAll(
        `SELECT date, muscle_groups, intensity, exercise_name, sets, reps, weight_lbs,
                category, workout_duration_seconds, created_at
         FROM lifts
         WHERE user_id = ? AND date >= ? AND date <= ?
         ORDER BY date ASC, created_at ASC`,
        [userId, baselineStart, todayISO]
      ),
      getActivePlanForUser(userId),
    ]);

    const planCompletion = buildPlanCompletion(activePlan, runs, lifts, currentStart, todayISO);
    res.json(computeHybridScore({ userId, runs, lifts, planCompletion, now }));
  } catch (err) {
    console.error('[stats/hybrid-score] failed:', err.message);
    res.status(500).json({ error: 'Hybrid score fetch failed' });
  }
});

router.get('/hybrid-streak', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();

    const [runs, lifts, activePlan] = await Promise.all([
      dbAll(
        `SELECT date, distance_miles, duration_seconds, created_at,
                type, watch_activity_type, watch_normalized_type, watch_mode
         FROM runs
         WHERE user_id = ? AND ${runActivitySql()}
         ORDER BY date ASC, created_at ASC`,
        [userId]
      ),
      dbAll(
        `SELECT date, exercise_name, sets, reps, weight_lbs, workout_duration_seconds, created_at
         FROM lifts
         WHERE user_id = ?
         ORDER BY date ASC, created_at ASC`,
        [userId]
      ),
      getActivePlanForUser(userId),
    ]);

    const streak = computeHybridStreak({ runs, lifts, activePlan, now });
    const candidates = detectHybridMilestones({ streak, runs, lifts, activePlan, now });
    const milestones = await persistNewMilestones(userId, candidates);

    res.json({
      currentStreak: streak.currentStreak,
      longestStreak: streak.longestStreak,
      unit: streak.unit,
      graceUsed: streak.graceUsed,
      milestones,
    });
  } catch (err) {
    console.error('[stats/hybrid-streak] failed:', err.message);
    res.status(500).json({ error: 'Hybrid streak fetch failed' });
  }
});

router.get('/engagement', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const now = new Date();
    const todayISO = toISODate(now);
    const currentStart = addDays(todayISO, -27);
    const priorEnd = addDays(currentStart, -1);
    const priorStart = addDays(priorEnd, -27);
    const requestedPrLimit = Number(req.query.prLimit || 5);
    const prLimit = Number.isFinite(requestedPrLimit)
      ? Math.max(1, Math.min(10, Math.round(requestedPrLimit)))
      : 5;

    const [runs, lifts, prs, activePlan] = await Promise.all([
      dbAll(
        `SELECT date, distance_miles, duration_seconds, perceived_effort, avg_heart_rate,
                pain_level, post_energy, pace_avg, health_source, created_at,
                type, watch_activity_type, watch_normalized_type, watch_mode
         FROM runs
         WHERE user_id = ? AND ${runActivitySql()}
         ORDER BY date ASC, created_at ASC`,
        [userId]
      ),
      dbAll(
        `SELECT date, muscle_groups, intensity, exercise_name, sets, reps, weight_lbs,
                category, workout_duration_seconds, created_at
         FROM lifts
         WHERE user_id = ?
         ORDER BY date ASC, created_at ASC`,
        [userId]
      ),
      dbAll(
        `SELECT id, category, label, value, unit, run_id, lift_id, achieved_at, source
         FROM personal_records
         WHERE user_id = ?
         ORDER BY achieved_at DESC, id DESC`,
        [userId]
      ),
      getActivePlanForUser(userId),
    ]);

    const currentPlanCompletion = buildPlanCompletion(activePlan, runs, lifts, currentStart, todayISO);
    const priorPlanCompletion = buildPlanCompletion(activePlan, runs, lifts, priorStart, priorEnd);
    const currentHybridScore = computeHybridScore({ userId, runs, lifts, planCompletion: currentPlanCompletion, now });
    const priorHybridScore = computeHybridScore({
      userId,
      runs,
      lifts,
      planCompletion: priorPlanCompletion,
      now: new Date(`${priorEnd}T12:00:00Z`),
    });
    const badges = computeBadges({
      userId,
      runs,
      lifts,
      prs,
      activePlan,
      hybridScore: currentHybridScore,
      now,
    });
    const earnedBadges = badges
      .filter((badge) => badge.earned)
      .sort((left, right) => String(right.earnedAt || '').localeCompare(String(left.earnedAt || '')))
      .slice(0, 4);
    const nextBadges = badges
      .filter((badge) => !badge.earned)
      .sort((left, right) => Number(right.progress?.percent || 0) - Number(left.progress?.percent || 0))
      .slice(0, 4);

    res.json({
      recentPrs: prs.slice(0, prLimit),
      badges,
      earnedBadges,
      nextBadges,
      youVsLastMonth: buildYouVsLastMonth({
        runs,
        lifts,
        now,
        currentHybridScore,
        priorHybridScore,
      }),
    });
  } catch (err) {
    console.error('[stats/engagement] failed:', err.message);
    res.status(500).json({ error: 'Engagement stats fetch failed' });
  }
});

module.exports = router;
