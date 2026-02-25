const router = require('express').Router();
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { checkAiLimit } = require('../middleware/aiLimit');
const { v4: uuidv4 } = require('uuid');
const { generateTrainingPlan, generateRaceAdjustment } = require('../services/ai');

function getDayShort() {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date().getDay()];
}

function normalizeTodayEntry(planJson) {
  if (!planJson?.weeks?.length) return null;
  const today = getDayShort();
  for (const week of planJson.weeks) {
    const days = Array.isArray(week.days) ? week.days : Array.isArray(week.sessions) ? week.sessions : [];
    const hit = days.find(d => d?.day === today);
    if (hit) return hit;
  }
  return null;
}

function getMonday(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  d.setDate(diff);
  return d.toISOString().split('T')[0];
}

function parsePlan(plan) {
  try {
    if (plan?.plan_data) {
      return typeof plan.plan_data === 'string' ? JSON.parse(plan.plan_data) : plan.plan_data;
    }
    return typeof plan?.plan_json === 'string' ? JSON.parse(plan.plan_json) : plan?.plan_json;
  } catch { return null; }
}

function mapType(day = {}) {
  const t = String(day.workout_type || day.type || '').toLowerCase();
  if (t.includes('rest')) return 'rest';
  if (t.includes('strength') || t.includes('lift') || t.includes('cross')) return 'lift';
  return 'run';
}

function dayToDate(weekStart, dayLabel) {
  const map = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
  const idx = map[String(dayLabel || '').slice(0, 3).toLowerCase()];
  if (idx === undefined) return null;
  const d = new Date(`${weekStart}T12:00:00`);
  d.setDate(d.getDate() + idx);
  return d.toISOString().slice(0, 10);
}

async function getActivePlanForUser(userId) {
  const assigned = await dbGet(`
    SELECT up.id as user_plan_id, up.current_week, up.started_at, up.status, up.progress_json,
           tp.*
    FROM user_plans up
    JOIN training_plans tp ON tp.id = up.plan_id
    WHERE up.user_id = ? AND up.status = 'active'
    ORDER BY up.created_at DESC
    LIMIT 1
  `, [userId]);
  if (assigned) return { source: 'assigned', row: assigned };

  const legacy = await dbGet('SELECT * FROM training_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [userId]);
  if (legacy) return { source: 'legacy', row: legacy };
  return null;
}

router.get('/', auth, async (req, res) => {
  try {
    const rows = await dbAll(`
      SELECT id, name, type, weeks, description, plan_data, created_at
      FROM training_plans
      WHERE user_id IS NULL AND plan_data IS NOT NULL
      ORDER BY created_at ASC
    `);
    const plans = rows.map((row) => ({ ...row, plan_data: parsePlan(row) || { weeks: [] } }));
    res.json({ plans });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch plan' }); }
});

router.post('/assign/:planId', auth, async (req, res) => {
  try {
    const plan = await dbGet('SELECT * FROM training_plans WHERE id = ? AND user_id IS NULL', [req.params.planId]);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    await dbRun("UPDATE user_plans SET status = 'inactive' WHERE user_id = ? AND status = 'active'", [req.user.id]);
    const id = uuidv4();
    await dbRun(
      `INSERT INTO user_plans (id, user_id, plan_id, started_at, current_week, status, progress_json)
       VALUES (?,?,?,?,?,?,?)`,
      [id, req.user.id, plan.id, new Date().toISOString().slice(0, 10), 1, 'active', JSON.stringify({ completedSessionIds: [] })]
    );
    res.status(201).json({ ok: true, assignment_id: id });
  } catch {
    res.status(500).json({ error: 'Failed to assign plan' });
  }
});

router.get('/my', auth, async (req, res) => {
  try {
    const row = await dbGet(`
      SELECT up.*, tp.name, tp.type, tp.weeks, tp.description, tp.plan_data
      FROM user_plans up
      JOIN training_plans tp ON tp.id = up.plan_id
      WHERE up.user_id = ? AND up.status = 'active'
      ORDER BY up.created_at DESC
      LIMIT 1
    `, [req.user.id]);

    if (!row) return res.json({ plan: null });
    let progress = {};
    try { progress = JSON.parse(row.progress_json || '{}'); } catch {}
    res.json({
      plan: {
        id: row.plan_id,
        name: row.name,
        type: row.type,
        weeks: row.weeks,
        description: row.description,
        plan_data: parsePlan(row) || { weeks: [] },
      },
      user_plan: {
        id: row.id,
        started_at: row.started_at,
        current_week: Number(row.current_week || 1),
        status: row.status,
        progress,
      },
    });
  } catch {
    res.status(500).json({ error: 'Failed to fetch user plan' });
  }
});

router.put('/my/progress', auth, async (req, res) => {
  try {
    const { current_week, completed_session_id, unset_session_id } = req.body || {};
    const row = await dbGet(`
      SELECT id, progress_json, current_week
      FROM user_plans
      WHERE user_id = ? AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `, [req.user.id]);
    if (!row) return res.status(404).json({ error: 'No assigned plan' });

    let progress = {};
    try { progress = JSON.parse(row.progress_json || '{}'); } catch { progress = {}; }
    const completed = new Set(Array.isArray(progress.completedSessionIds) ? progress.completedSessionIds : []);
    if (completed_session_id) completed.add(String(completed_session_id));
    if (unset_session_id) completed.delete(String(unset_session_id));
    const nextWeek = Number.isFinite(Number(current_week)) ? Number(current_week) : Number(row.current_week || 1);

    await dbRun(
      'UPDATE user_plans SET current_week = ?, progress_json = ? WHERE id = ?',
      [nextWeek, JSON.stringify({ ...progress, completedSessionIds: Array.from(completed) }), row.id]
    );
    res.json({ ok: true, current_week: nextWeek, completedSessionIds: Array.from(completed) });
  } catch {
    res.status(500).json({ error: 'Failed to update progress' });
  }
});

router.get('/today', auth, async (req, res) => {
  try {
    const active = await getActivePlanForUser(req.user.id);
    if (!active) return res.json({ today: null });
    const parsed = parsePlan(active.row);
    res.json({ today: normalizeTodayEntry(parsed) });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch today' }); }
});

router.get('/current', auth, async (req, res) => {
  try {
    const active = await getActivePlanForUser(req.user.id);
    if (!active) return res.json({ plan: null });
    const parsed = parsePlan(active.row) || { weeks: [] };
    res.json({
      plan: {
        ...active.row,
        plan_json: parsed,
        plan_data: parsed,
        current_week: Number(active.row.current_week || 1),
      },
    });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch current plan' }); }
});

router.get('/compliance', auth, async (req, res) => {
  try {
    const weekStart = getMonday();
    const weekEndDate = new Date(`${weekStart}T12:00:00`);
    weekEndDate.setDate(weekEndDate.getDate() + 7);
    const weekEnd = weekEndDate.toISOString().slice(0, 10);

    const active = await getActivePlanForUser(req.user.id);
    if (!active) return res.json({ week: weekStart, planned: 0, completed: 0, score: 0, missed: [], streak: { current: 0, best: 0 } });

    const parsed = parsePlan(active.row) || { weeks: [] };
    const currentWeek = Number(active.row.current_week || 1);
    const weekBucket = parsed?.weeks?.[Math.max(0, currentWeek - 1)] || parsed?.weeks?.[0] || {};
    const days = weekBucket?.days || weekBucket?.sessions || [];
    const plannedSessions = days
      .map((d, idx) => ({
        sessionId: d.id || `${idx}`, day: d.day || `Day ${idx + 1}`,
        date: dayToDate(active.row.week_start || active.row.started_at || weekStart, d.day),
        type: mapType(d), distance: Number(d.distance_miles || 0), raw: d,
      }))
      .filter((d) => d.type !== 'rest' && d.date && d.date >= weekStart && d.date < weekEnd);

    const [runs, lifts] = await Promise.all([
      dbAll('SELECT id, date, distance_miles FROM runs WHERE user_id=? AND date>=? AND date<?', [req.user.id, weekStart, weekEnd]),
      dbAll('SELECT id, date FROM lifts WHERE user_id=? AND date>=? AND date<?', [req.user.id, weekStart, weekEnd])
    ]);

    const usedRunIds = new Set();
    const usedLiftIds = new Set();

    const statusItems = plannedSessions.map((s) => {
      const target = new Date(`${s.date}T12:00:00`).getTime();
      const bucket = s.type === 'lift' ? lifts : runs;
      const used = s.type === 'lift' ? usedLiftIds : usedRunIds;
      let hit = null;
      for (const item of bucket) {
        if (used.has(item.id)) continue;
        const t = new Date(`${item.date}T12:00:00`).getTime();
        if (Math.abs(t - target) <= 24 * 60 * 60 * 1000) { hit = item; used.add(item.id); break; }
      }
      return { ...s, completed: !!hit };
    });

    const completed = statusItems.filter((s) => s.completed).length;
    const planned = statusItems.length;
    const score = planned > 0 ? Math.round((completed / planned) * 100) : 0;

    let current = 0, best = 0;
    for (const item of statusItems) {
      if (item.completed) { current += 1; best = Math.max(best, current); }
      else { current = 0; }
    }

    const today = new Date().toISOString().slice(0, 10);
    const missed = statusItems
      .filter((s) => !s.completed && s.date < today)
      .map((s) => ({ sessionId: s.sessionId, day: s.day, date: s.date, type: s.type, distance: s.distance }));

    const week = (() => {
      const d = new Date(`${weekStart}T12:00:00`);
      const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
      const weekNo = Math.ceil((((d - yearStart) / 86400000) + yearStart.getUTCDay() + 1) / 7);
      return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
    })();

    res.json({ week, planned, completed, score, missed, streak: { current, best }, sessions: statusItems });
  } catch (err) { res.status(500).json({ error: 'Compliance fetch failed' }); }
});

router.post('/reschedule-missed', auth, async (req, res) => {
  try {
    const { sessionId, originalDate } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

    const active = await getActivePlanForUser(req.user.id);
    if (!active) return res.status(404).json({ error: 'No plan found' });

    const parsed = parsePlan(active.row);
    const currentWeek = Math.max(0, Number(active.row.current_week || 1) - 1);
    const week = parsed?.weeks?.[currentWeek];
    const dayList = week?.days || week?.sessions;
    if (!dayList?.length) return res.status(400).json({ error: 'Invalid plan format' });

    const dayMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
    const sourceIdx = dayList.findIndex((d, idx) => `${d.id || idx}` === `${sessionId}`);
    if (sourceIdx < 0) return res.status(404).json({ error: 'Session not found in plan' });

    const source = dayList[sourceIdx];
    let nextIdx = sourceIdx + 1;
    while (nextIdx < dayList.length) {
      const t = mapType(dayList[nextIdx]);
      if (t === 'rest') break;
      nextIdx += 1;
    }
    if (nextIdx >= dayList.length) nextIdx = dayList.length - 1;

    const oldDay = source.day;
    source.day = Object.keys(dayMap)[nextIdx];
    source.description = `${source.description || ''} (rescheduled)`;
    dayList[sourceIdx] = { ...dayList[sourceIdx], type: 'rest', workout_type: 'rest', distance_miles: 0, description: 'Rescheduled recovery day', rest: true };
    if (week.days) week.days = dayList;
    if (week.sessions) week.sessions = dayList;

    if (active.source === 'assigned') {
      await dbRun('UPDATE training_plans SET plan_data=? WHERE id=?', [JSON.stringify(parsed), active.row.id]);
    } else {
      await dbRun('UPDATE training_plans SET plan_json=? WHERE id=?', [JSON.stringify(parsed), active.row.id]);
    }
    res.json({ ok: true, movedFrom: oldDay, movedTo: source.day, plan: parsed, aiSuggestion: 'Week rebalanced after missed session. Keep next run easy and preserve long run.' });
  } catch (err) { res.status(500).json({ error: 'Reschedule failed' }); }
});

router.post('/race-adjust', auth, async (req, res) => {
  try {
    const { raceId } = req.body || {};
    if (!raceId) return res.status(400).json({ error: 'raceId required' });

    const [race, plan, profile] = await Promise.all([
      dbGet('SELECT * FROM race_events WHERE id=? AND user_id=?', [raceId, req.user.id]),
      getActivePlanForUser(req.user.id),
      dbGet('SELECT * FROM users WHERE id=?', [req.user.id])
    ]);

    if (!race) return res.status(404).json({ error: 'Race not found' });
    if (!plan) return res.status(404).json({ error: 'No plan found' });

    const parsed = parsePlan(plan.row) || { weeks: [] };
    const adjusted = await generateRaceAdjustment({ profile, race, currentPlan: parsed });
    const nextPlan = adjusted?.weeks ? adjusted : parsed;
    if (plan.source === 'assigned') {
      await dbRun('UPDATE training_plans SET plan_data=? WHERE id=?', [JSON.stringify(nextPlan), plan.row.id]);
    } else {
      await dbRun('UPDATE training_plans SET plan_json=? WHERE id=?', [JSON.stringify(nextPlan), plan.row.id]);
    }
    res.json({ ok: true, plan: nextPlan });
  } catch (err) { res.status(500).json({ error: 'Race adjust failed' }); }
});

router.post('/generate', auth, checkAiLimit('plan_generate'), async (req, res) => {
  try {
    const profile = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!profile) return res.status(404).json({ error: 'User not found' });
    const target = req.body?.target || null;
    const planData = await generateTrainingPlan(profile, target);
    const id = uuidv4();
    const weekStart = getMonday();

    if (!planData) {
      const fallback = generateFallbackPlan(profile);
      await dbRun('INSERT INTO training_plans (id, user_id, week_start, plan_json) VALUES (?, ?, ?, ?)',
        [id, req.user.id, weekStart, JSON.stringify(fallback)]);
      return res.json({ plan: { id, user_id: req.user.id, week_start: weekStart, plan_json: fallback } });
    }

    await dbRun('INSERT INTO training_plans (id, user_id, week_start, plan_json) VALUES (?, ?, ?, ?)',
      [id, req.user.id, weekStart, JSON.stringify(planData)]);
    res.json({ plan: { id, user_id: req.user.id, week_start: weekStart, plan_json: planData } });
  } catch (err) { res.status(500).json({ error: 'Plan generation failed' }); }
});

function generateFallbackPlan(profile) {
  const base = profile.weekly_miles_current || 10;
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const weeks = [1, 2, 3, 4].map(w => ({
    week: w,
    theme: w === 4 ? 'Recovery Week' : w === 1 ? 'Foundation' : w === 2 ? 'Build' : 'Peak',
    total_miles: w === 4 ? Math.round(base * 0.8) : Math.round(base * (1 + (w - 1) * 0.1)),
    days: days.map(day => {
      const isRest = ['Tue', 'Thu', 'Sun'].includes(day);
      const isLong = day === 'Sat';
      if (isRest) return { day, type: 'rest', distance_miles: 0, duration_min: 0, description: 'Rest and recovery', rest: true };
      if (isLong) return { day, type: 'long', distance_miles: Math.round(base * 0.35 * (w === 4 ? 0.8 : 1) * 10) / 10, duration_min: 0, description: 'Long easy run — conversational pace', rest: false };
      return { day, type: day === 'Wed' ? 'strength' : 'easy', workout_type: day === 'Wed' ? 'strength' : 'run', distance_miles: Math.round(base * 0.2 * (w === 4 ? 0.8 : 1) * 10) / 10, duration_min: 0, description: day === 'Wed' ? 'Strength session' : 'Easy effort run', rest: false };
    }),
  }));
  return { weeks };
}

module.exports = router;
