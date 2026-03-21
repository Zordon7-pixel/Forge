const router = require('express').Router();
const { dbGet, dbRun } = require('../db');
const auth = require('../middleware/auth');

dbRun(`CREATE TABLE IF NOT EXISTS health_sync (
  id SERIAL PRIMARY KEY,
  user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  steps_today INTEGER,
  calories_today INTEGER,
  avg_heart_rate_last_run INTEGER,
  total_miles_this_week NUMERIC(10,2),
  synced_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
)`).catch(err => console.error('[health] schema init failed:', err.message));

router.post('/sync', auth, async (req, res) => {
  try {
    const {
      steps_today = null,
      calories_today = null,
      avg_heart_rate_last_run = null,
      total_miles_this_week = null,
    } = req.body || {};

    const row = await dbGet(
      `INSERT INTO health_sync (
        user_id,
        steps_today,
        calories_today,
        avg_heart_rate_last_run,
        total_miles_this_week,
        synced_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        steps_today = EXCLUDED.steps_today,
        calories_today = EXCLUDED.calories_today,
        avg_heart_rate_last_run = EXCLUDED.avg_heart_rate_last_run,
        total_miles_this_week = EXCLUDED.total_miles_this_week,
        synced_at = NOW()
      RETURNING synced_at`,
      [
        req.user.id,
        steps_today,
        calories_today,
        avg_heart_rate_last_run,
        total_miles_this_week,
      ]
    );

    res.json({ ok: true, synced_at: row?.synced_at || new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Failed to sync health metrics' });
  }
});

router.get('/sync', auth, async (req, res) => {
  try {
    const row = await dbGet(
      `SELECT
        steps_today,
        calories_today,
        avg_heart_rate_last_run,
        total_miles_this_week,
        synced_at
      FROM health_sync
      WHERE user_id=$1`,
      [req.user.id]
    );
    res.json(row || null);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch health sync' });
  }
});

module.exports = router;
