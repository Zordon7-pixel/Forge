const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { computeStreak, serverUtcAnchorCandidates } = require('../lib/streak');
const { runActivitySql } = require('../lib/runActivity');

async function getStreak(userId) {
  const [runRows, liftRows] = await Promise.all([
    dbAll(`SELECT date, created_at FROM runs WHERE user_id=? AND ${runActivitySql()}`, [userId]),
    dbAll('SELECT started_at FROM workout_sessions WHERE user_id=? AND ended_at IS NOT NULL', [userId])
  ]);
  const runDates = runRows.map(r => (r.date || r.created_at || '').slice(0,10)).filter(Boolean);
  const liftDates = liftRows.map(s => (s.started_at || '').slice(0,10)).filter(Boolean);
  const uniqueDates = [...new Set([...runDates, ...liftDates])].sort();
  const { current, best } = computeStreak(uniqueDates, serverUtcAnchorCandidates());
  return { best, currentStreak: current };
}

router.get('/new', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const [runs, lifts, seenRows] = await Promise.all([
      dbAll(`SELECT * FROM runs WHERE user_id=? AND ${runActivitySql()} ORDER BY date ASC, created_at ASC`, [userId]),
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
    // Extended streak milestones
    const STREAK_THRESHOLDS = [7, 14, 30, 60, 90, 180, 365];
    const streakLabels = { 7: '7-Day', 14: '14-Day', 30: '30-Day', 60: '60-Day', 90: '90-Day', 180: '180-Day', 365: '365-Day' };
    for (const threshold of STREAK_THRESHOLDS) {
      if (currentStreak >= threshold) {
        add(`streak_${threshold}`, `${streakLabels[threshold]} Streak`, `You reached a ${streakLabels[threshold].toLowerCase()} activity streak!`);
      }
    }
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

    // Persist streak data to user profile
    const earnedStreakMilestones = STREAK_THRESHOLDS.filter(t => currentStreak >= t);
    await dbRun(
      'UPDATE users SET current_streak=?, longest_streak=GREATEST(COALESCE(longest_streak,0),?), streak_milestones=?, streak_updated_at=? WHERE id=?',
      [currentStreak, best, JSON.stringify(earnedStreakMilestones), new Date().toISOString(), userId]
    );

    res.json({ milestones, streak: { current: currentStreak, best, milestones: earnedStreakMilestones } });
  } catch (err) { res.status(500).json({ error: 'Milestones fetch failed' }); }
});

// GET /api/milestones/streak — current streak data for dashboard display
router.get('/streak', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { best, currentStreak } = await getStreak(userId);
    const user = await dbGet('SELECT longest_streak, streak_milestones FROM users WHERE id=?', [userId]);

    const STREAK_THRESHOLDS = [7, 14, 30, 60, 90, 180, 365];
    const nextMilestone = STREAK_THRESHOLDS.find(t => t > currentStreak) || null;
    const daysToNext = nextMilestone ? nextMilestone - currentStreak : null;

    // Check if streak just hit a milestone threshold
    let milestoneJustHit = null;
    const earnedMilestones = STREAK_THRESHOLDS.filter(t => currentStreak >= t);
    let previousMilestones = [];
    try {
      previousMilestones = JSON.parse(user?.streak_milestones || '[]');
    } catch (err) {
      console.error('[milestones/streak] Failed to parse streak milestones:', err.message);
    }
    const newMilestones = earnedMilestones.filter(t => !previousMilestones.includes(t));
    if (newMilestones.length > 0) {
      milestoneJustHit = Math.max(...newMilestones);
    }

    res.json({
      current_streak: currentStreak,
      longest_streak: Math.max(best, user?.longest_streak || 0),
      next_milestone: nextMilestone,
      days_to_next: daysToNext,
      milestone_just_hit: milestoneJustHit,
      earned_milestones: earnedMilestones,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch streak data' });
  }
});

module.exports = router;
