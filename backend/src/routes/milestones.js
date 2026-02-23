const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const auth = require('../middleware/auth');

function getStreak(userId) {
  const runDates = db.prepare('SELECT date, created_at FROM runs WHERE user_id=?').all(userId).map(r => (r.date || r.created_at || '').slice(0,10)).filter(Boolean);
  const liftDates = db.prepare('SELECT started_at FROM workout_sessions WHERE user_id=? AND ended_at IS NOT NULL').all(userId).map(s => (s.started_at || '').slice(0,10)).filter(Boolean);
  const uniqueDates = [...new Set([...runDates, ...liftDates])].sort();
  let best = 0, cur = 0;
  for (let i=0;i<uniqueDates.length;i++) {
    if (i === 0) { cur = 1; best = 1; continue; }
    const d1 = new Date(uniqueDates[i-1]);
    const d2 = new Date(uniqueDates[i]);
    const diff = Math.round((d2-d1)/86400000);
    cur = diff === 1 ? cur + 1 : 1;
    if (cur > best) best = cur;
  }
  return { best };
}

router.get('/new', auth, (req, res) => {
  const userId = req.user.id;
  const runs = db.prepare('SELECT * FROM runs WHERE user_id=? ORDER BY date ASC, created_at ASC').all(userId);
  const lifts = db.prepare('SELECT * FROM workout_sessions WHERE user_id=? AND ended_at IS NOT NULL ORDER BY started_at ASC').all(userId);
  const seen = new Set(db.prepare('SELECT milestone_key FROM milestones_seen WHERE user_id=?').all(userId).map(x => x.milestone_key));

  const totalMiles = runs.reduce((s,r)=>s+Number(r.distance_miles||0),0);
  const longest = runs.reduce((m,r)=>Math.max(m, Number(r.distance_miles||0)),0);
  const liftCount = lifts.length;
  const { best } = getStreak(userId);

  const milestones = [];
  const add = (key, title, description) => { if (!seen.has(key)) milestones.push({ key, title, description }); };

  if (runs.length >= 1) add('first_run', 'First Run Logged', 'You logged your first run.');
  if (runs.some(r => Number(r.distance_miles) >= 3.1)) add('first_5k', 'First 5K', 'Completed your first 5K distance run.');
  if (runs.some(r => Number(r.distance_miles) >= 6.2)) add('first_10k', 'First 10K', 'Completed your first 10K distance run.');
  if (runs.some(r => Number(r.distance_miles) >= 13.1)) add('first_half', 'First Half Marathon', 'Completed your first half marathon distance.');
  if (best >= 7) add('streak_7', '7-Day Streak', 'You reached a 7-day activity streak.');
  if (best >= 30) add('streak_30', '30-Day Streak', 'You reached a 30-day activity streak.');
  if (totalMiles >= 100) add('miles_100', '100 Miles Total', 'You have logged 100 total running miles.');
  if (totalMiles >= 500) add('miles_500', '500 Miles Total', 'You have logged 500 total running miles.');
  if (longest > 0) add('distance_pr', 'New Distance PR', 'You set a new single-run distance best.');
  if (runs.length > 2) add('pace_pr', 'New Pace PR', 'You set a pace PR versus similar distance runs.');
  if (liftCount >= 10) add('lifts_10', '10 Lifts Completed', 'You completed 10 lift sessions.');
  if (liftCount >= 50) add('lifts_50', '50 Lifts Completed', 'You completed 50 lift sessions.');

  const stmt = db.prepare('INSERT OR IGNORE INTO milestones_seen (id, user_id, milestone_key, seen_at) VALUES (?,?,?,datetime(\'now\'))');
  milestones.forEach(m => stmt.run(uuidv4(), userId, m.key));

  res.json({ milestones });
});

module.exports = router;
