const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

function getWeekBounds() {
  const now = new Date();
  const day = now.getDay(); // 0=Sun
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  const nextMonday = new Date(monday);
  nextMonday.setDate(monday.getDate() + 7);
  return {
    start: monday.toISOString().slice(0, 10),
    end: nextMonday.toISOString().slice(0, 10),
  };
}

function getMonthBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString().slice(0, 10);
  return { start, end };
}

function fmtPace(durationSeconds, distanceMiles) {
  if (!durationSeconds || !distanceMiles) return null;
  const paceSec = durationSeconds / distanceMiles;
  const m = Math.floor(paceSec / 60);
  const s = Math.round(paceSec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function buildRecap(userId, start, end, prevStart, prevEnd) {
  const runs = db.prepare(
    'SELECT * FROM runs WHERE user_id=? AND date>=? AND date<? ORDER BY date DESC'
  ).all(userId, start, end);

  const workouts = db.prepare(
    "SELECT * FROM workout_sessions WHERE user_id=? AND started_at>=? AND started_at<? AND ended_at IS NOT NULL"
  ).all(userId, start + 'T00:00:00', end + 'T00:00:00');

  const totalMiles = runs.reduce((s, r) => s + Number(r.distance_miles || 0), 0);
  const totalRuns = runs.length;
  const totalWorkouts = workouts.length;

  const runSeconds = runs.reduce((s, r) => s + Number(r.duration_seconds || 0), 0);
  const workoutSeconds = workouts.reduce((s, w) => s + Number(w.total_seconds || 0), 0);
  const totalMinutes = Math.round((runSeconds + workoutSeconds) / 60);

  // Avg pace from runs with valid data
  const validRuns = runs.filter(r => r.distance_miles && r.duration_seconds);
  let avgPace = null;
  if (validRuns.length) {
    const avgSec = validRuns.reduce((s, r) => s + r.duration_seconds / r.distance_miles, 0) / validRuns.length;
    avgPace = fmtPace(avgSec, 1); // already per-mile
  }

  // Best run by distance
  let bestRun = null;
  if (runs.length) {
    const best = runs.reduce((a, b) => (Number(b.distance_miles || 0) > Number(a.distance_miles || 0) ? b : a));
    bestRun = {
      date: best.date,
      miles: Number(Number(best.distance_miles || 0).toFixed(2)),
      pace: fmtPace(best.duration_seconds, best.distance_miles),
    };
  }

  // Streak: consecutive days with activity up to now
  const allActivityDates = new Set([
    ...db.prepare('SELECT date FROM runs WHERE user_id=?').all(userId).map(r => r.date?.slice(0, 10)),
    ...db.prepare('SELECT started_at FROM workout_sessions WHERE user_id=? AND ended_at IS NOT NULL').all(userId).map(s => s.started_at?.slice(0, 10)),
  ]);
  const todayStr = new Date().toISOString().slice(0, 10);
  const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  let streak = 0;
  if (allActivityDates.has(todayStr) || allActivityDates.has(yesterdayStr)) {
    let check = allActivityDates.has(todayStr) ? todayStr : yesterdayStr;
    while (allActivityDates.has(check)) {
      streak++;
      const d = new Date(check);
      d.setDate(d.getDate() - 1);
      check = d.toISOString().slice(0, 10);
    }
  }

  // Weekly miles goal: use monthly_goal/4.33 if set, else rolling 4-week avg * 1.1, min 10
  let weeklyMilesGoal = 20;
  try {
    const user = db.prepare('SELECT monthly_goal_miles FROM users WHERE id=?').get(userId);
    if (user?.monthly_goal_miles) {
      weeklyMilesGoal = Math.round((user.monthly_goal_miles / 4.33) * 10) / 10;
    } else {
      const fourWeekStart = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
      const oldRuns = db.prepare('SELECT distance_miles FROM runs WHERE user_id=? AND date>=?').all(userId, fourWeekStart);
      const fourWeekMiles = oldRuns.reduce((s, r) => s + Number(r.distance_miles || 0), 0);
      const avgWeekly = fourWeekMiles / 4;
      if (avgWeekly > 0) weeklyMilesGoal = Math.max(10, Math.round(avgWeekly * 1.1 * 10) / 10);
    }
  } catch (_) {}

  // Monthly miles for progress bar
  const { start: monthStart, end: monthEnd } = getMonthBounds();
  const monthRow = db.prepare('SELECT COALESCE(SUM(distance_miles),0) as miles FROM runs WHERE user_id=? AND date>=? AND date<?').get(userId, monthStart, monthEnd);
  const monthlyMiles = Number(Number(monthRow?.miles || 0).toFixed(2));

  // Monthly goal for progress
  let monthlyGoal = 50;
  try {
    const user = db.prepare('SELECT monthly_goal_miles FROM users WHERE id=?').get(userId);
    if (user?.monthly_goal_miles) monthlyGoal = user.monthly_goal_miles;
    else monthlyGoal = Math.max(25, Math.ceil(monthlyMiles / 25) * 25 + (monthlyMiles >= 25 ? 25 : 0));
  } catch (_) {}

  // Weekly calories (sum of calories_burned + fallback to calories)
  const totalCalories = runs.reduce((s, r) => s + Number(r.calories_burned || r.calories || 0), 0)
    + workouts.reduce((s, w) => s + Number(w.calories_burned || 0), 0);

  // vs previous period
  const prevRuns = db.prepare('SELECT distance_miles FROM runs WHERE user_id=? AND date>=? AND date<?').all(userId, prevStart, prevEnd);
  const prevMiles = prevRuns.reduce((s, r) => s + Number(r.distance_miles || 0), 0);
  const milesDiff = totalMiles - prevMiles;
  const milesPct = prevMiles > 0 ? Math.round((milesDiff / prevMiles) * 100) : null;

  return {
    totalMiles: Number(totalMiles.toFixed(2)),
    totalRuns,
    totalWorkouts,
    totalMinutes,
    avgPace,
    bestRun,
    streak,
    weeklyMilesGoal,
    monthlyMiles,
    monthlyGoal,
    totalCalories: Math.round(totalCalories),
    vsLastWeek: {
      miles: Number(milesDiff.toFixed(2)),
      pct: milesPct,
    },
  };
}

// GET /api/recap/weekly
router.get('/weekly', auth, (req, res) => {
  const { start, end } = getWeekBounds();
  const prevStart = new Date(new Date(start).getTime() - 7 * 86400000).toISOString().slice(0, 10);
  const prevEnd = start;
  res.json(buildRecap(req.user.id, start, end, prevStart, prevEnd));
});

// GET /api/recap/monthly
router.get('/monthly', auth, (req, res) => {
  const { start, end } = getMonthBounds();
  const d = new Date(start);
  const prevStart = new Date(d.getFullYear(), d.getMonth() - 1, 1).toISOString().slice(0, 10);
  const prevEnd = start;
  res.json(buildRecap(req.user.id, start, end, prevStart, prevEnd));
});

module.exports = router;
