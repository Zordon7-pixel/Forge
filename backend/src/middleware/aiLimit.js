const { dbGet, dbRun } = require('../db');
const { v4: uuidv4 } = require('uuid');

// Free plan: 3 AI calls per week (Mon–Sun).
// Pro users: unlimited.
const FREE_CALLS_PER_WEEK_CAP = 3;

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

      // Free users: check total AI calls this week (Mon–Sun)
      const now = new Date();
      const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon...6=Sat
      const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - daysFromMonday);
      weekStart.setHours(0, 0, 0, 0);
      const weekStartISO = weekStart.toISOString();

      const weeklyRow = await dbGet(
        "SELECT COUNT(*) as call_count FROM ai_usage WHERE user_id = ? AND created_at >= ?",
        [userId, weekStartISO]
      );
      const callsThisWeek = Number(weeklyRow?.call_count || 0);

      if (callsThisWeek >= FREE_CALLS_PER_WEEK_CAP) {
        return res.status(402).json({
          error: `You've used all ${FREE_CALLS_PER_WEEK_CAP} free AI coaching calls this week. Upgrade to Pro for unlimited coaching.`,
          limit: 'weekly_calls',
          calls_used: callsThisWeek,
          calls_cap: FREE_CALLS_PER_WEEK_CAP,
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
