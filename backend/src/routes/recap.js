const router = require('express').Router();
const { dbGet, dbAll } = require('../db');
const auth = require('../middleware/auth');
const { generateWeeklyInsight } = require('../services/ai');

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

function formatMonthDay(dateString) {
  if (!dateString) return '';
  const d = new Date(`${dateString}T12:00:00`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getConsecutiveRunStreak(runDates) {
  if (!runDates.length) return 0;
  const sortedUnique = [...new Set(runDates)].sort((a, b) => a.localeCompare(b));
  let best = 1;
  let current = 1;
  for (let i = 1; i < sortedUnique.length; i++) {
    const prev = new Date(`${sortedUnique[i - 1]}T12:00:00`);
    const cur = new Date(`${sortedUnique[i]}T12:00:00`);
    const diff = Math.round((cur.getTime() - prev.getTime()) / 86400000);
    if (diff === 1) {
      current += 1;
      best = Math.max(best, current);
    } else {
      current = 1;
    }
  }
  return best;
}

function deterministicWeeklyInsight(summary) {
  if (!summary.totalRuns) {
    return 'No runs logged in the last 7 days. Start with a short easy run and rebuild consistency this week.';
  }
  if (summary.injuryRiskFlag) {
    return `Strong effort this week, but load is elevated (${summary.injuryRiskReason.toLowerCase()}). Keep your next 1-2 runs easy so fitness keeps building without adding injury risk.`;
  }
  if (summary.prsThisWeek.length > 0) {
    return `You set ${summary.prsThisWeek.length} PR${summary.prsThisWeek.length > 1 ? 's' : ''} this week and still held consistent mileage. Prioritize an easy recovery run next to lock in adaptation.`;
  }
  if ((summary.mileageVsLastWeek || 0) >= 10) {
    return 'Mileage climbed this week and your running frequency stayed solid. Hold this level for another week before adding more distance.';
  }
  return 'Your training load looks steady and sustainable. Keep stacking easy miles and use strength sessions as injury-prevention support.';
}

async function buildWeeklyRecap(userId) {
  const today = new Date();
  const weekStartDate = new Date(today);
  weekStartDate.setDate(today.getDate() - 6);
  weekStartDate.setHours(0, 0, 0, 0);
  const weekStart = weekStartDate.toISOString().slice(0, 10);
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  const weekEndExclusive = tomorrow.toISOString().slice(0, 10);

  const prevStartDate = new Date(weekStartDate);
  prevStartDate.setDate(prevStartDate.getDate() - 7);
  const prevStart = prevStartDate.toISOString().slice(0, 10);
  const prevEndExclusive = weekStart;

  const [runs, lifts, prevWeekMilesRow, prs] = await Promise.all([
    dbAll('SELECT * FROM runs WHERE user_id=? AND date>=? AND date<? ORDER BY date DESC, created_at DESC', [userId, weekStart, weekEndExclusive]),
    dbAll('SELECT * FROM lifts WHERE user_id=? AND date>=? AND date<? ORDER BY date DESC, created_at DESC', [userId, weekStart, weekEndExclusive]),
    dbGet('SELECT COALESCE(SUM(distance_miles),0) as miles FROM runs WHERE user_id=? AND date>=? AND date<?', [userId, prevStart, prevEndExclusive]),
    dbAll('SELECT label, achieved_at FROM personal_records WHERE user_id=? AND achieved_at>=? AND achieved_at<? ORDER BY achieved_at DESC', [userId, weekStart, weekEndExclusive]),
  ]);

  const totalMiles = runs.reduce((sum, r) => sum + Number(r.distance_miles || 0), 0);
  const totalRuns = runs.length;
  const totalRunSeconds = runs.reduce((sum, r) => sum + Number(r.duration_seconds || 0), 0);
  const avgPace = totalMiles > 0 ? fmtPace(totalRunSeconds, totalMiles) : null;
  const totalElevationGain = runs.reduce((sum, r) => sum + Number(r.elevation_gain || 0), 0);
  const longestRun = runs.reduce((max, r) => Math.max(max, Number(r.distance_miles || 0)), 0);

  const liftSessions = lifts.length;
  const totalLiftVolume = lifts.reduce((sum, l) => {
    const sets = Number(l.sets || 0);
    const reps = Number(l.reps || 0);
    const weight = Number(l.weight_lbs || 0);
    return sum + sets * reps * weight;
  }, 0);

  const prevWeekMiles = Number(prevWeekMilesRow?.miles || 0);
  const rawMileageChange = prevWeekMiles > 0
    ? ((totalMiles - prevWeekMiles) / prevWeekMiles) * 100
    : (totalMiles > 0 ? 100 : 0);
  const mileageVsLastWeek = Number(rawMileageChange.toFixed(1));

  const uniqueRunDates = [...new Set(runs.map(r => (r.date || '').slice(0, 10)).filter(Boolean))];
  const consecutiveRunDays = getConsecutiveRunStreak(uniqueRunDates);
  const riskReasons = [];
  if (prevWeekMiles > 0 && mileageVsLastWeek > 10) riskReasons.push(`mileage up ${mileageVsLastWeek}% week-over-week`);
  if (consecutiveRunDays >= 5) riskReasons.push(`${consecutiveRunDays} consecutive run days`);
  const injuryRiskFlag = riskReasons.length > 0;
  const injuryRiskReason = injuryRiskFlag ? riskReasons.join('; ') : '';

  const prsThisWeek = prs.map(pr => pr.label).filter(Boolean);
  const weekLabel = `${formatMonthDay(weekStart)} - ${formatMonthDay(new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString().slice(0, 10))}`;

  const summary = {
    weekLabel,
    totalMiles: Number(totalMiles.toFixed(2)),
    totalRuns,
    avgPace,
    totalElevationGain: Number(totalElevationGain.toFixed(0)),
    longestRun: Number(longestRun.toFixed(2)),
    liftSessions,
    totalLiftVolume: Math.round(totalLiftVolume),
    totalVolume: Math.round(totalLiftVolume),
    prsThisWeek,
    injuryRiskFlag,
    injuryRiskReason,
    mileageVsLastWeek,
  };

  const aiInsight = await generateWeeklyInsight({ userId, weekLabel, summary });
  const insight = aiInsight || deterministicWeeklyInsight(summary);

  return {
    ...summary,
    insight,
    // Legacy compatibility for existing dashboard recap surfaces
    totalWorkouts: liftSessions,
    totalMinutes: Math.round((totalRunSeconds + lifts.reduce((s, l) => s + Number(l.workout_duration_seconds || 0), 0)) / 60),
    bestRun: runs.length
      ? {
        date: runs.reduce((a, b) => (Number(b.distance_miles || 0) > Number(a.distance_miles || 0) ? b : a)).date,
        miles: Number(longestRun.toFixed(2)),
        pace: (() => {
          const longest = runs.reduce((a, b) => (Number(b.distance_miles || 0) > Number(a.distance_miles || 0) ? b : a));
          return fmtPace(longest.duration_seconds, longest.distance_miles);
        })(),
      }
      : null,
    totalCalories: Math.round(runs.reduce((s, r) => s + Number(r.calories_burned || r.calories || 0), 0) + lifts.reduce((s, l) => s + Number(l.calories || 0), 0)),
    vsLastWeek: { miles: Number((totalMiles - prevWeekMiles).toFixed(2)), pct: prevWeekMiles > 0 ? Math.round(rawMileageChange) : null },
    streak: getConsecutiveRunStreak(uniqueRunDates),
  };
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
    res.json(await buildWeeklyRecap(req.user.id));
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
