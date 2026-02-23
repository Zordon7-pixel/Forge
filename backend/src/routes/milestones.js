const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');

async function getStreak(userId) {
  const [runRows, liftRows] = await Promise.all([
    dbAll('SELECT date, created_at FROM runs WHERE user_id=?', [userId]),
    dbAll('SELECT started_at FROM workout_sessions WHERE user_id=? AND ended_at IS NOT NULL', [userId])
  ]);
  const runDates = runRows.map(r => (r.date || r.created_at || '').slice(0,10)).filter(Boolean);
  const liftDates = liftRows.map(s => (s.started_at || '').slice(0,10)).filter(Boolean);
  const uniqueDates = [...new Set([...runDates, ...liftDates])].sort();
  let best = 0, cur = 0, current = 0;
  const today = new Date().toISOString().slice(0,10);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);
  const dateSet = new Set(uniqueDates);
  let checkDay = dateSet.has(today) ? today : (dateSet.has(yesterday) ? yesterday : null);
  while (checkDay && dateSet.has(checkDay)) {
    current += 1;
    const d = new Date(checkDay);
    d.setDate(d.getDate() - 1);
    checkDay = d.toISOString().slice(0,10);
  }
  for (let i=0;i<uniqueDates.length;i++) {
    if (i === 0) { cur = 1; best = 1; continue; }
    const d1 = new Date(uniqueDates[i-1]);
    const d2 = new Date(uniqueDates[i]);
    const diff = Math.round((d2-d1)/86400000);
    cur = diff === 1 ? cur + 1 : 1;
    if (cur > best) best = cur;
  }
  return { best, currentStreak: current };
}

router.get('/new', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const [runs, lifts, seenRows] = await Promise.all([
      dbAll('SELECT * FROM runs WHERE user_id=? ORDER BY date ASC, created_at ASC', [userId]),
      dbAll('SELECT * FROM workout_sessions WHERE user_id=? AND ended_at IS NOT NULL ORDER BY started_at ASC', [userId]),
      dbAll('SELECT milestone_key FROM milestones_seen WHERE user_id=?', [userId])
    ]);
    const seen = new Set(seenRows.map(x => x.milestone_key));

    const totalMiles = runs.reduce((s,r)=>s+Number(r.distance_miles||0),0);
    const liftCount = lifts.length;
    const { best, currentStreak } = await getStreak(userId);

    const milestones = [];
    const add = (key, title, description) => { if (!seen.has(key)) milestones.push({ key, title, description }); };

    if (runs.length >= 1) add('first_run', 'First Run Logged', 'You logged your first run.');
    if (runs.some(r => Number(r.distance_miles) >= 3.1)) add('first_5k', 'First 5K', 'Completed your first 5K distance run.');
    if (runs.some(r => Number(r.distance_miles) >= 6.2)) add('first_10k', 'First 10K', 'Completed your first 10K distance run.');
    if (runs.some(r => Number(r.distance_miles) >= 13.1)) add('first_half', 'First Half Marathon', 'Completed your first half marathon distance.');
    if (currentStreak >= 7) add('streak_7', '7-Day Streak', 'You reached a 7-day activity streak.');
    if (currentStreak >= 30) add('streak_30', '30-Day Streak', 'You reached a 30-day activity streak.');
    if (totalMiles >= 100) add('miles_100', '100 Miles Total', 'You have logged 100 total running miles.');
    if (totalMiles >= 500) add('miles_500', '500 Miles Total', 'You have logged 500 total running miles.');
    if (runs.length > 0) {
      const lastRun = runs[runs.length - 1];
      const prevRuns = runs.slice(0, -1);
      const maxPrevDistance = prevRuns.length > 0 ? Math.max(...prevRuns.map(r => Number(r.distance_miles || 0))) : 0;
      if (lastRun.distance_miles > maxPrevDistance) add('distance_pr', 'New Distance PR', 'You set a new single-run distance best.');
    }
    if (runs.length > 1) {
      const lastRun = runs[runs.length - 1];
      const lastDate = new Date(lastRun.date || lastRun.created_at);
      const sevenDaysAgo = new Date(Date.now() - 7 * 86400000);
      if (lastDate >= sevenDaysAgo) {
        const lastDist = Number(lastRun.distance_miles || 0);
        const similarRuns = runs.slice(0, -1).filter(r => {
          const rDist = Number(r.distance_miles || 0);
          return rDist >= lastDist * 0.8 && rDist <= lastDist * 1.2;
        });
        if (similarRuns.length > 0) {
          const lastPace = lastRun.duration_seconds / lastDist;
          const minPrevPace = Math.min(...similarRuns.map(r => Number(r.duration_seconds || 0) / Number(r.distance_miles || 1)));
          if (lastPace < minPrevPace) add('pace_pr', 'New Pace PR', 'You set a pace PR versus similar distance runs.');
        }
      }
    }
    if (liftCount >= 10) add('lifts_10', '10 Lifts Completed', 'You completed 10 lift sessions.');
    if (liftCount >= 50) add('lifts_50', '50 Lifts Completed', 'You completed 50 lift sessions.');

    await Promise.all(milestones.map(m =>
      dbRun(
        'INSERT INTO milestones_seen (id, user_id, milestone_key) VALUES (?,?,?) ON CONFLICT (user_id, milestone_key) DO NOTHING',
        [uuidv4(), userId, m.key]
      )
    ));

    res.json({ milestones });
  } catch (err) { res.status(500).json({ error: 'Milestones fetch failed' }); }
});

module.exports = router;
