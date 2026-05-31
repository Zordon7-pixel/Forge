const router = require('express').Router();
const { dbAll } = require('../db');
const auth = require('../middleware/auth');

function dayKey(value) {
  return String(value || '').slice(0, 10);
}

function toDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function weekStartKey(value) {
  const date = toDate(`${dayKey(value)}T12:00:00Z`);
  if (!date) return null;
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  return date.toISOString().slice(0, 10);
}

function addDays(dateValue, days) {
  const date = toDate(`${dateValue}T12:00:00Z`);
  if (!date) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDate(value) {
  if (!value) return 'Recent';
  return new Date(`${value}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatPace(run) {
  const seconds = Number(run.duration_seconds || 0);
  const miles = Number(run.distance_miles || 0);
  if (!seconds || !miles) return '--';
  const pace = seconds / miles;
  const mins = Math.floor(pace / 60);
  const secs = Math.round(pace % 60);
  return `${mins}:${String(secs).padStart(2, '0')}/mi`;
}

function parseFocus(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) && parsed.length ? parsed.slice(0, 2).join(', ') : 'Strength';
  } catch {
    return 'Strength';
  }
}

function byWeek(runs, lifts) {
  const weeks = new Map();
  const ensure = (weekStart) => {
    if (!weeks.has(weekStart)) weeks.set(weekStart, { weekStart, weekEnd: addDays(weekStart, 6), runMiles: 0, liftVolumeLbs: 0, runCount: 0, liftCount: 0 });
    return weeks.get(weekStart);
  };
  runs.forEach((run) => {
    const key = weekStartKey(run.date);
    if (!key) return;
    const week = ensure(key);
    week.runMiles += Number(run.distance_miles || 0);
    week.runCount += 1;
  });
  lifts.forEach((lift) => {
    const key = weekStartKey(lift.started_at);
    if (!key) return;
    const week = ensure(key);
    week.liftVolumeLbs += Number(lift.lift_volume_lbs || 0);
    week.liftCount += 1;
  });
  return [...weeks.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
}

function monthKey(value) {
  return dayKey(value).slice(0, 7);
}

function toPr(key, label, primary, secondary, achieved, plainEnglish) {
  return { key, label, primary, secondary, achieved, plainEnglish };
}

router.get('/', auth, async (req, res) => {
  try {
    const [runs, lifts] = await Promise.all([
      dbAll(
        'SELECT date, distance_miles, duration_seconds, perceived_effort FROM runs WHERE user_id=? AND distance_miles>0 ORDER BY date ASC',
        [req.user.id]
      ),
      dbAll(
        `SELECT ws.id, ws.started_at, ws.muscle_groups,
                COALESCE(SUM(COALESCE(wset.weight_lbs,0) * COALESCE(wset.reps,0)),0) as lift_volume_lbs
         FROM workout_sessions ws
         LEFT JOIN workout_sets wset ON wset.session_id=ws.id AND wset.user_id=?
         WHERE ws.user_id=? AND ws.ended_at IS NOT NULL
         GROUP BY ws.id, ws.started_at, ws.muscle_groups
         ORDER BY ws.started_at ASC`,
        [req.user.id, req.user.id]
      ),
    ]);

    const prs = [];
    const weeks = byWeek(runs, lifts);
    const strongestWeek = weeks
      .map((week) => ({ ...week, score: week.runMiles + (week.liftVolumeLbs / 1000) }))
      .filter((week) => week.runMiles > 0 || week.liftVolumeLbs > 0)
      .sort((a, b) => b.score - a.score)[0];
    if (strongestWeek) {
      prs.push(toPr(
        'strongestWeek',
        'Strongest Week',
        `${strongestWeek.runMiles.toFixed(1)} mi + ${Math.round(strongestWeek.liftVolumeLbs).toLocaleString()} lbs`,
        `Week of ${formatDate(strongestWeek.weekStart)}-${formatDate(strongestWeek.weekEnd)}`,
        strongestWeek.weekEnd,
        `Your highest combined training load: ${strongestWeek.runMiles.toFixed(1)} miles run plus ${Math.round(strongestWeek.liftVolumeLbs).toLocaleString()} lbs lifted.`
      ));
    }

    let bestStreak = null;
    let current = null;
    weeks.filter((week) => week.runCount > 0 && week.liftCount > 0).forEach((week) => {
      if (!current || addDays(current.endWeek, 7) !== week.weekStart) current = { weeks: 1, startWeek: week.weekStart, endWeek: week.weekStart };
      else current = { ...current, weeks: current.weeks + 1, endWeek: week.weekStart };
      if (!bestStreak || current.weeks > bestStreak.weeks) bestStreak = current;
    });
    if (bestStreak) {
      prs.push(toPr(
        'longestHybridStreak',
        'Longest Hybrid Streak',
        `${bestStreak.weeks} week${bestStreak.weeks === 1 ? '' : 's'}`,
        `${formatDate(bestStreak.startWeek)}-${formatDate(addDays(bestStreak.endWeek, 6))}`,
        bestStreak.endWeek,
        `Your longest streak with at least one run and one lift in the same week.`
      ));
    }

    const months = new Map();
    runs.forEach((run) => {
      const key = monthKey(run.date);
      if (!key) return;
      if (!months.has(key)) months.set(key, { month: key, runMiles: 0, liftSessions: 0 });
      months.get(key).runMiles += Number(run.distance_miles || 0);
    });
    lifts.forEach((lift) => {
      const key = monthKey(lift.started_at);
      if (!key) return;
      if (!months.has(key)) months.set(key, { month: key, runMiles: 0, liftSessions: 0 });
      months.get(key).liftSessions += 1;
    });
    const biggestMonth = [...months.values()].sort((a, b) => (b.runMiles + b.liftSessions) - (a.runMiles + a.liftSessions))[0];
    if (biggestMonth) {
      const [year, month] = biggestMonth.month.split('-');
      prs.push(toPr(
        'biggestMonth',
        'Biggest Month',
        `${biggestMonth.runMiles.toFixed(1)} mi + ${biggestMonth.liftSessions} lifts`,
        new Date(`${biggestMonth.month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
        `${biggestMonth.month}-01`,
        `Your biggest combined month: ${biggestMonth.runMiles.toFixed(1)} miles and ${biggestMonth.liftSessions} lift sessions in ${month}/${year}.`
      ));
    }

    const volumes = lifts.map((lift) => Number(lift.lift_volume_lbs || 0)).filter((volume) => volume > 0).sort((a, b) => a - b);
    const heavyThreshold = volumes.length ? volumes[Math.floor(volumes.length * 0.75)] : null;
    const heavyLifts = heavyThreshold ? lifts.filter((lift) => Number(lift.lift_volume_lbs || 0) >= heavyThreshold) : [];
    const easiest = runs
      .filter((run) => Number(run.perceived_effort || 0) > 0)
      .flatMap((run) => heavyLifts.map((lift) => ({ run, lift, diff: toDate(`${run.date}T12:00:00Z`) - toDate(lift.started_at) })))
      .filter((item) => item.diff >= 0 && item.diff <= 86400000)
      .sort((a, b) => Number(a.run.perceived_effort) - Number(b.run.perceived_effort))[0];
    if (easiest) {
      prs.push(toPr(
        'easiestRunAfterHeavyLift',
        'Easiest Run After Heavy Lift',
        `${easiest.run.distance_miles} mi @ RPE ${easiest.run.perceived_effort}`,
        `${formatPace(easiest.run)} after ${Math.round(easiest.lift.lift_volume_lbs).toLocaleString()} lbs lifted`,
        easiest.run.date,
        `Your lowest-effort run within 24 hours after a top-quartile lift block.`
      ));
    }

    const runByDay = new Map();
    runs.forEach((run) => {
      const key = dayKey(run.date);
      if (!runByDay.has(key)) runByDay.set(key, []);
      runByDay.get(key).push(run);
    });
    const bestCombo = lifts.flatMap((lift) => {
      const sameDayRuns = (runByDay.get(dayKey(lift.started_at)) || []).filter((run) => Number(run.distance_miles || 0) >= 3);
      return sameDayRuns.map((run) => ({ run, lift, comboScore: Number(run.distance_miles || 0) + (Number(lift.lift_volume_lbs || 0) / 500) }));
    }).sort((a, b) => b.comboScore - a.comboScore)[0];
    if (bestCombo) {
      prs.push(toPr(
        'bestLiftRunCombo',
        'Best Lift+Run Combo',
        `${Number(bestCombo.run.distance_miles).toFixed(1)} mi + ${Math.round(bestCombo.lift.lift_volume_lbs).toLocaleString()} lbs`,
        `${formatPace(bestCombo.run)} · ${parseFocus(bestCombo.lift.muscle_groups)}`,
        bestCombo.run.date,
        `Your strongest single-day run and lift combo, scored at ${bestCombo.comboScore.toFixed(1)}.`
      ));
    }

    res.json({ prs });
  } catch (err) {
    console.error('[hybrid-prs] failed:', err.message);
    res.status(500).json({ error: 'Hybrid PRs failed' });
  }
});

module.exports = router;
