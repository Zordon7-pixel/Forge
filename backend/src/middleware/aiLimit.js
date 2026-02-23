const { dbGet, dbRun } = require('../db');
const { v4: uuidv4 } = require('uuid');

const DAILY_CAP = 10;
const MONTHLY_FREE_CAP = 5;

function checkAiLimit(callType) {
  return async (req, res, next) => {
    try {
      const userId = req.user.id;
      const today = new Date().toISOString().slice(0, 10);
      const month = new Date().toISOString().slice(0, 7);

      const dailyRow = await dbGet(
        "SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id = ? AND created_at >= ?",
        [userId, today + 'T00:00:00']
      );
      const dailyCount = Number(dailyRow?.cnt || 0);

      if (dailyCount >= DAILY_CAP) {
        return res.status(429).json({
          error: "You've hit today's AI limit (10/day). Come back tomorrow.",
          limit: 'daily',
          limit_reset: 'tomorrow'
        });
      }

      const user = await dbGet("SELECT is_pro FROM users WHERE id = ?", [userId]);
      if (!user?.is_pro) {
        const monthlyRow = await dbGet(
          "SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id = ? AND created_at >= ?",
          [userId, month + '-01T00:00:00']
        );
        const monthlyCount = Number(monthlyRow?.cnt || 0);

        if (monthlyCount >= MONTHLY_FREE_CAP) {
          return res.status(402).json({
            error: "You've used your 5 free AI responses this month. Upgrade to Pro for unlimited coaching.",
            limit: 'monthly',
            limit_reset: 'next month',
            upgrade: true
          });
        }
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
