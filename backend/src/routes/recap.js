const router = require('express').Router();
const { dbGet, dbAll } = require('../db');
const auth = require('../middleware/auth');

function getWeekBounds() {
  const now = new Date();
  const day = now.getDay();
  const monday = new Date(now);
  monday.setHours(0, 0, 0, 0);
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
  const nextMonday = new Date(monday);
  nextMonday.setDate(monday.getDate() + 7);
  return { start: monday.toISOString().slice(0, 10), end: nextMonday.toISOString().slice(0, 10) };
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

async function buildRecap(userId, start, end, prevStart, prevEnd) {
  const [runs, workouts, allRunDates, allLiftDates, user, monthRow, prevRuns] = await Promise.all([
    dbAll('SELECT * FROM runs WHERE user_id=? AND date>=? AND date<? ORDER BY date DESC', [userId, start, end]),
    dbAll("SELECT * FROM workout_sessions WHERE user_id=? AND started_at>=? AND started_at<? AND ended_at IS NOT NULL", [userId, start + 'T00:00:00', end + 'T00:00:00']),
    dbAll('SELECT date FROM runs WHERE user_id=?', [userId]),
    dbAll('SELECT started_at FROM workout_sessions WHERE user_id=? AND ended_at IS NOT NULL', [userId]),
    dbGet('SELECT monthly_goal_miles FROM users WHERE id=?', [userId]),
    dbGet('SELECT COALESCE(SUM(distance_miles),0) as miles FROM runs WHERE user_id=? AND date>=? AND date<?', [userId, getMonthBounds().start, getMonthBounds().end]),
    dbAll('SELECT distance_miles FROM runs WHERE user_id=? AND date>=? AND date<?', [userId, prevStart, prevEnd])
  ]);

  const totalMiles = runs.reduce((s, r) => s + Number(r.distance_miles || 0), 0);
  const totalRuns = runs.length;
  const totalWorkouts = workouts.length;
  const runSeconds = runs.reduce((s, r) => s + Number(r.duration_seconds || 0), 0);
  const workoutSeconds = workouts.reduce((s, w) => s + Number(w.total_seconds || 0), 0);
  const totalMinutes = Math.round((runSeconds + workoutSeconds) / 60);

  const validRuns = runs.filter(r => r.distance_miles && r.duration_seconds);
  let avgPace = null;
  if (validRuns.length) {
    const avgSec = validRuns.reduce((s, r) => s + r.duration_seconds / r.distance_miles, 0) / validRuns.length;
    avgPace = fmtPace(avgSec, 1);
  }

  let bestRun = null;
  if (runs.length) {
    const best = runs.reduce((a, b) => (Number(b.distance_miles || 0) > Number(a.distance_miles || 0) ? b : a));
    bestRun = { date: best.date, miles: Number(Number(best.distance_miles || 0).toFixed(2)), pace: fmtPace(best.duration_seconds, best.distance_miles) };
  }

  const allActivityDates = new Set([
    ...allRunDates.map(r => r.date?.slice(0, 10)).filter(Boolean),
    ...allLiftDates.map(s => s.started_at?.slice(0, 10)).filter(Boolean),
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

  let weeklyMilesGoal = 20;
  if (user?.monthly_goal_miles) {
    weeklyMilesGoal = Math.round((user.monthly_goal_miles / 4.33) * 10) / 10;
  } else {
    const fourWeekStart = new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
    const oldRuns = await dbAll('SELECT distance_miles FROM runs WHERE user_id=? AND date>=?', [userId, fourWeekStart]);
    const fourWeekMiles = oldRuns.reduce((s, r) => s + Number(r.distance_miles || 0), 0);
    const avgWeekly = fourWeekMiles / 4;
    if (avgWeekly > 0) weeklyMilesGoal = Math.max(10, Math.round(avgWeekly * 1.1 * 10) / 10);
  }

  const monthlyMiles = Number(Number(monthRow?.miles || 0).toFixed(2));
  let monthlyGoal = 50;
  if (user?.monthly_goal_miles) monthlyGoal = user.monthly_goal_miles;
  else monthlyGoal = Math.max(25, Math.ceil(monthlyMiles / 25) * 25 + (monthlyMiles >= 25 ? 25 : 0));

  const totalCalories = runs.reduce((s, r) => s + Number(r.calories_burned || r.calories || 0), 0)
    + workouts.reduce((s, w) => s + Number(w.calories_burned || 0), 0);

  const prevMiles = prevRuns.reduce((s, r) => s + Number(r.distance_miles || 0), 0);
  const milesDiff = totalMiles - prevMiles;
  const milesPct = prevMiles > 0 ? Math.round((milesDiff / prevMiles) * 100) : null;

  return {
    totalMiles: Number(totalMiles.toFixed(2)),
    totalRuns, totalWorkouts, totalMinutes, avgPace, bestRun, streak,
    weeklyMilesGoal, monthlyMiles, monthlyGoal,
    totalCalories: Math.round(totalCalories),
    vsLastWeek: { miles: Number(milesDiff.toFixed(2)), pct: milesPct },
  };
}

// GET /api/recap/weekly
router.get('/weekly', auth, async (req, res) => {
  try {
    const { start, end } = getWeekBounds();
    const prevStart = new Date(new Date(start).getTime() - 7 * 86400000).toISOString().slice(0, 10);
    res.json(await buildRecap(req.user.id, start, end, prevStart, start));
  } catch (err) { res.status(500).json({ error: 'Weekly recap failed' }); }
});

// GET /api/recap/monthly
router.get('/monthly', auth, async (req, res) => {
  try {
    const { start, end } = getMonthBounds();
    const d = new Date(start);
    const prevStart = new Date(d.getFullYear(), d.getMonth() - 1, 1).toISOString().slice(0, 10);
    res.json(await buildRecap(req.user.id, start, end, prevStart, start));
  } catch (err) { res.status(500).json({ error: 'Monthly recap failed' }); }
});

module.exports = router;
