const router = require('express').Router();
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');

// ─── Helper: compute user stats ──────────────────────────────────────────────
async function getUserStats(userId) {
  const [runCountRow, milesRow, runDates, prCountRow, newYearRow] = await Promise.all([
    dbGet('SELECT COUNT(*) as cnt FROM runs WHERE user_id = ?', [userId]),
    dbGet('SELECT COALESCE(SUM(distance_miles),0) as total FROM runs WHERE user_id = ?', [userId]),
    dbAll(`SELECT DISTINCT date as d FROM runs WHERE user_id = ? ORDER BY date DESC`, [userId]),
    dbGet('SELECT COUNT(*) as cnt FROM personal_records WHERE user_id = ?', [userId]),
    dbGet(`SELECT COUNT(*) as cnt FROM runs WHERE user_id = ? AND SUBSTRING(date, 6, 5) = '01-01'`, [userId])
  ]);

  const runCount = runCountRow?.cnt || 0;
  const totalMiles = milesRow?.total || 0;
  const prCount = prCountRow?.cnt || 0;
  const newYearRun = (newYearRow?.cnt || 0) > 0;

  const dates = runDates.map(r => r.d?.slice(0, 10)).filter(Boolean);
  let streak = 0;
  if (dates.length > 0) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const latest = new Date(dates[0]);
    latest.setHours(0, 0, 0, 0);
    const diffDays = Math.floor((today - latest) / 86400000);
    if (diffDays <= 1) {
      let cursor = new Date(latest);
      for (const d of dates) {
        const day = new Date(d);
        day.setHours(0, 0, 0, 0);
        const diff = Math.floor((cursor - day) / 86400000);
        if (diff === 0) { streak++; cursor = new Date(day); }
        else if (diff === 1) { streak++; cursor = new Date(day); }
        else break;
      }
    }
  }

  return { runCount, totalMiles, streak, prCount, newYearRun };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/badges — all badges with earned status for current user
router.get('/', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const badges = await dbAll(`
      SELECT b.*,
        ub.earned_at,
        CASE WHEN ub.id IS NOT NULL THEN 1 ELSE 0 END as earned
      FROM badges b
      LEFT JOIN user_badges ub ON b.id = ub.badge_id AND ub.user_id = ?
      ORDER BY b.category, b.id
    `, [userId]);
    res.json({ badges });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch badges' }); }
});

// POST /api/badges/check — auto-award earned badges
router.post('/check', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const [stats, allBadges] = await Promise.all([
      getUserStats(userId),
      dbAll('SELECT * FROM badges')
    ]);

    const newlyEarned = [];
    for (const badge of allBadges) {
      let earned = false;
      switch (badge.requirement_type) {
        case 'run_count': earned = stats.runCount >= badge.requirement_value; break;
        case 'total_miles': earned = stats.totalMiles >= badge.requirement_value; break;
        case 'streak': earned = stats.streak >= badge.requirement_value; break;
        case 'pr': earned = stats.prCount >= badge.requirement_value; break;
        case 'new_year': earned = stats.newYearRun; break;
        default: earned = false;
      }
      if (earned) {
        const result = await dbRun('INSERT INTO user_badges (user_id, badge_id) VALUES (?, ?) ON CONFLICT (user_id, badge_id) DO NOTHING', [userId, badge.id]);
        if (result.changes > 0) newlyEarned.push(badge);
      }
    }

    res.json({ awarded: newlyEarned, stats });
  } catch (err) { res.status(500).json({ error: 'Badge check failed' }); }
});

// GET /api/badges/leaderboard — top 10 users by total miles
router.get('/leaderboard', auth, async (req, res) => {
  try {
    const top = await dbAll(`
      SELECT
        u.id,
        COALESCE(u.username, u.name) as runner,
        COALESCE(SUM(r.distance_miles), 0) as total_miles,
        COUNT(DISTINCT ub.badge_id) as badge_count
      FROM users u
      LEFT JOIN runs r ON r.user_id = u.id
      LEFT JOIN user_badges ub ON ub.user_id = u.id
      GROUP BY u.id, u.username, u.name
      ORDER BY total_miles DESC
      LIMIT 10
    `);
    res.json({ leaderboard: top });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch leaderboard' }); }
});

// GET /api/badges/seasonal — seasonal badges with progress and earned status
router.get('/seasonal', auth, async (req, res) => {
  try {
    const now = new Date();
    const year = now.getFullYear();

    const badges = await dbAll("SELECT * FROM badges WHERE category='seasonal' ORDER BY window_start ASC");

    const enriched = await Promise.all(badges.map(async badge => {
      const start = `${year}-${badge.window_start}`;
      const end = `${year}-${badge.window_end}`;
      const startDate = new Date(start);
      const endDate = new Date(end);
      endDate.setHours(23, 59, 59);

      let status = 'upcoming';
      let daysRemaining = null;
      let daysUntilStart = null;
      if (now >= startDate && now <= endDate) {
        status = 'active';
        daysRemaining = Math.ceil((endDate - now) / (1000 * 60 * 60 * 24));
      } else if (now > endDate) {
        status = 'past';
      } else {
        daysUntilStart = Math.ceil((startDate - now) / (1000 * 60 * 60 * 24));
      }

      const userBadge = await dbGet("SELECT * FROM user_badges WHERE user_id=? AND badge_id=?", [req.user.id, badge.id]);
      if (userBadge) status = 'earned';

      let progress = 0;
      if (badge.requirement_type === 'miles_in_window') {
        const result = await dbGet("SELECT COALESCE(SUM(distance_miles),0) as total FROM runs WHERE user_id=? AND date >= ? AND date <= ?", [req.user.id, start, end]);
        progress = result?.total || 0;
      } else if (badge.requirement_type === 'workouts_in_window') {
        const result = await dbGet("SELECT COUNT(*) as cnt FROM workout_sessions WHERE user_id=? AND started_at >= ? AND started_at <= ? AND ended_at IS NOT NULL", [req.user.id, start, end]);
        progress = result?.cnt || 0;
      }

      if (!userBadge && progress >= badge.requirement_value) {
        try {
          await dbRun("INSERT INTO user_badges (user_id, badge_id) VALUES (?,?) ON CONFLICT (user_id, badge_id) DO NOTHING", [req.user.id, badge.id]);
          status = 'earned';
        } catch {}
      }

      return {
        ...badge,
        window_start_full: start, window_end_full: end, status,
        progress: Math.min(progress, badge.requirement_value),
        days_remaining: daysRemaining, days_until_start: daysUntilStart,
        earned: status === 'earned', earned_at: userBadge?.earned_at || null,
      };
    }));

    const order = { active: 0, upcoming: 1, earned: 2, past: 3 };
    enriched.sort((a, b) => (order[a.status] ?? 4) - (order[b.status] ?? 4));

    res.json({ badges: enriched });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch seasonal badges' }); }
});

module.exports = router;
