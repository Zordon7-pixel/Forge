const db = require('../db');
const { v4: uuidv4 } = require('uuid');

const DAILY_CAP = 10;        // all users
const MONTHLY_FREE_CAP = 5;  // free users only

function checkAiLimit(callType) {
  return (req, res, next) => {
    const userId = req.user.id;
    const today = new Date().toISOString().slice(0, 10);
    const month = new Date().toISOString().slice(0, 7);

    // Daily cap (all users)
    const dailyCount = db.prepare(
      "SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id = ? AND created_at >= ?"
    ).get(userId, today + 'T00:00:00').cnt;

    if (dailyCount >= DAILY_CAP) {
      return res.status(429).json({
        error: "You've hit today's AI limit (10/day). Come back tomorrow.",
        limit: 'daily',
        limit_reset: 'tomorrow'
      });
    }

    // Monthly cap (free users only)
    const user = db.prepare("SELECT is_pro FROM users WHERE id = ?").get(userId);
    if (!user?.is_pro) {
      const monthlyCount = db.prepare(
        "SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id = ? AND created_at >= ?"
      ).get(userId, month + '-01T00:00:00').cnt;

      if (monthlyCount >= MONTHLY_FREE_CAP) {
        return res.status(402).json({
          error: "You've used your 5 free AI responses this month. Upgrade to Pro for unlimited coaching.",
          limit: 'monthly',
          limit_reset: 'next month',
          upgrade: true
        });
      }
    }

    // Log this call
    db.prepare("INSERT INTO ai_usage (id, user_id, call_type) VALUES (?, ?, ?)")
      .run(uuidv4(), userId, callType);

    next();
  };
}

module.exports = { checkAiLimit };
