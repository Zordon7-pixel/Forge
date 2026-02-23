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
    const days = Array.isArray(week.days) ? week.days : [];
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
  try { return typeof plan.plan_json === 'string' ? JSON.parse(plan.plan_json) : plan.plan_json; } catch { return null; }
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

router.get('/', auth, async (req, res) => {
  try {
    const plan = await dbGet('SELECT * FROM training_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [req.user.id]);
    if (!plan) return res.json({ plan: null, today: null });
    const parsed = JSON.parse(plan.plan_json);
    res.json({ plan: { ...plan, plan_json: parsed }, today: normalizeTodayEntry(parsed) });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch plan' }); }
});

router.get('/today', auth, async (req, res) => {
  try {
    const plan = await dbGet('SELECT * FROM training_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [req.user.id]);
    if (!plan) return res.json({ today: null });
    const parsed = JSON.parse(plan.plan_json);
    res.json({ today: normalizeTodayEntry(parsed) });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch today' }); }
});

router.get('/current', auth, async (req, res) => {
  try {
    const plan = await dbGet('SELECT * FROM training_plans WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [req.user.id]);
    if (!plan) return res.json({ plan: null });
    res.json({ plan: { ...plan, plan_json: JSON.parse(plan.plan_json) } });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch current plan' }); }
});

router.get('/compliance', auth, async (req, res) => {
  try {
    const weekStart = getMonday();
    const weekEndDate = new Date(`${weekStart}T12:00:00`);
    weekEndDate.setDate(weekEndDate.getDate() + 7);
    const weekEnd = weekEndDate.toISOString().slice(0, 10);

    const plan = await dbGet('SELECT * FROM training_plans WHERE user_id=? ORDER BY created_at DESC LIMIT 1', [req.user.id]);
    if (!plan) return res.json({ week: weekStart, planned: 0, completed: 0, score: 0, missed: [], streak: { current: 0, best: 0 } });

    const parsed = parsePlan(plan) || { weeks: [] };
    const days = parsed?.weeks?.[0]?.days || [];
    const plannedSessions = days
      .map((d, idx) => ({
        sessionId: d.id || `${idx}`, day: d.day || `Day ${idx + 1}`,
        date: dayToDate(plan.week_start || weekStart, d.day),
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

    const plan = await dbGet('SELECT * FROM training_plans WHERE user_id=? ORDER BY created_at DESC LIMIT 1', [req.user.id]);
    if (!plan) return res.status(404).json({ error: 'No plan found' });

    const parsed = parsePlan(plan);
    const week = parsed?.weeks?.[0];
    if (!week?.days?.length) return res.status(400).json({ error: 'Invalid plan format' });

    const dayMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
    const sourceIdx = week.days.findIndex((d, idx) => `${d.id || idx}` === `${sessionId}`);
    if (sourceIdx < 0) return res.status(404).json({ error: 'Session not found in plan' });

    const source = week.days[sourceIdx];
    let nextIdx = sourceIdx + 1;
    while (nextIdx < week.days.length) {
      const t = mapType(week.days[nextIdx]);
      if (t === 'rest') break;
      nextIdx += 1;
    }
    if (nextIdx >= week.days.length) nextIdx = week.days.length - 1;

    const oldDay = source.day;
    source.day = Object.keys(dayMap)[nextIdx];
    source.description = `${source.description || ''} (rescheduled)`;
    week.days[sourceIdx] = { ...week.days[sourceIdx], type: 'rest', workout_type: 'rest', distance_miles: 0, description: 'Rescheduled recovery day', rest: true };

    await dbRun('UPDATE training_plans SET plan_json=? WHERE id=?', [JSON.stringify(parsed), plan.id]);
    res.json({ ok: true, movedFrom: oldDay, movedTo: source.day, plan: parsed, aiSuggestion: 'Week rebalanced after missed session. Keep next run easy and preserve long run.' });
  } catch (err) { res.status(500).json({ error: 'Reschedule failed' }); }
});

router.post('/race-adjust', auth, async (req, res) => {
  try {
    const { raceId } = req.body || {};
    if (!raceId) return res.status(400).json({ error: 'raceId required' });

    const [race, plan, profile] = await Promise.all([
      dbGet('SELECT * FROM race_events WHERE id=? AND user_id=?', [raceId, req.user.id]),
      dbGet('SELECT * FROM training_plans WHERE user_id=? ORDER BY created_at DESC LIMIT 1', [req.user.id]),
      dbGet('SELECT * FROM users WHERE id=?', [req.user.id])
    ]);

    if (!race) return res.status(404).json({ error: 'Race not found' });
    if (!plan) return res.status(404).json({ error: 'No plan found' });

    const parsed = parsePlan(plan) || { weeks: [] };
    const adjusted = await generateRaceAdjustment({ profile, race, currentPlan: parsed });
    const nextPlan = adjusted?.weeks ? adjusted : parsed;
    await dbRun('UPDATE training_plans SET plan_json=? WHERE id=?', [JSON.stringify(nextPlan), plan.id]);
    res.json({ ok: true, plan: nextPlan });
  } catch (err) { res.status(500).json({ error: 'Race adjust failed' }); }
});

router.post('/generate', auth, checkAiLimit('plan_generate'), async (req, res) => {
  try {
    const profile = await dbGet('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!profile) return res.status(404).json({ error: 'User not found' });

    const planData = await generateTrainingPlan(profile);
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
