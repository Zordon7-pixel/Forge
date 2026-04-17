const { dbGet, dbRun } = require('../db');
const { v4: uuidv4 } = require('uuid');

// Free plan: AI available on up to 4 distinct days per week (Mon–Sun).
// Once a free user has used AI on 4 different days this week, they're locked until next week.
// Pro users: unlimited (no weekly day cap, no daily hard cap).
const FREE_DAYS_PER_WEEK_CAP = 4;

function checkAiLimit(callType) {
  return async (req, res, next) => {
    try {
      const userId = req.user.id;

      const user = await dbGet("SELECT is_pro FROM users WHERE id = ?", [userId]);

      // Pro users: no limits
      if (user?.is_pro) {
        await dbRun("INSERT INTO ai_usage (id, user_id, call_type) VALUES (?, ?, ?)", [uuidv4(), userId, callType]);
        return next();
      }

      // Free users: check how many distinct days this week they've used AI
      // Week = Monday–Sunday
      const now = new Date();
      const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon...6=Sat
      const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - daysFromMonday);
      weekStart.setHours(0, 0, 0, 0);
      const weekStartISO = weekStart.toISOString();

      const weeklyRow = await dbGet(
        "SELECT COUNT(DISTINCT DATE(created_at)) as distinct_days FROM ai_usage WHERE user_id = ? AND created_at >= ?",
        [userId, weekStartISO]
      );
      const distinctDaysThisWeek = Number(weeklyRow?.distinct_days || 0);

      // Check if today is already one of those days (if so, usage is still allowed today)
      const today = now.toISOString().slice(0, 10);
      const todayRow = await dbGet(
        "SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id = ? AND created_at >= ?",
        [userId, today + 'T00:00:00']
      );
      const usedToday = Number(todayRow?.cnt || 0) > 0;

      if (!usedToday && distinctDaysThisWeek >= FREE_DAYS_PER_WEEK_CAP) {
        return res.status(402).json({
          error: `You've used AI on ${FREE_DAYS_PER_WEEK_CAP} days this week. Upgrade to Pro for unlimited daily coaching.`,
          limit: 'weekly_days',
          days_used: distinctDaysThisWeek,
          days_cap: FREE_DAYS_PER_WEEK_CAP,
          limit_reset: 'next Monday',
          upgrade: true
        });
      }

      await dbRun("INSERT INTO ai_usage (id, user_id, call_type) VALUES (?, ?, ?)", [uuidv4(), userId, callType]);
      next();
    } catch (err) {
      console.error('AI limit check error:', err);
      next();
    }
  };
}

module.exports = { checkAiLimit };
