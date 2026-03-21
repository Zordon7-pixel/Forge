const router = require('express').Router();
const { dbGet, dbRun } = require('../db');
const auth = require('../middleware/auth');

let healthSyncSchemaReady = null;

async function ensureHealthSyncSchema() {
  if (!healthSyncSchemaReady) {
    healthSyncSchemaReady = dbRun(`
      CREATE TABLE IF NOT EXISTS health_sync (
        id SERIAL PRIMARY KEY,
        user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        steps_today INTEGER,
        calories_today INTEGER,
        avg_heart_rate_last_run INTEGER,
        total_miles_this_week NUMERIC(10,2),
        synced_at TIMESTAMP DEFAULT NOW()
      )
    `).catch((err) => {
      healthSyncSchemaReady = null;
      throw err;
    });
  }
  return healthSyncSchemaReady;
}

function toIntOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.round(num) : null;
}

function toMilesOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Number(num.toFixed(2)) : null;
}

router.post('/sync', auth, async (req, res) => {
  try {
    await ensureHealthSyncSchema();
    const { steps_today, calories_today, avg_heart_rate_last_run, total_miles_this_week } = req.body || {};

    const row = await dbGet(
      `INSERT INTO health_sync (
        user_id, steps_today, calories_today, avg_heart_rate_last_run, total_miles_this_week, synced_at
      ) VALUES (?, ?, ?, ?, ?, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        steps_today=EXCLUDED.steps_today,
        calories_today=EXCLUDED.calories_today,
        avg_heart_rate_last_run=EXCLUDED.avg_heart_rate_last_run,
        total_miles_this_week=EXCLUDED.total_miles_this_week,
        synced_at=NOW()
      RETURNING synced_at`,
      [
        req.user.id,
        toIntOrNull(steps_today),
        toIntOrNull(calories_today),
        toIntOrNull(avg_heart_rate_last_run),
        toMilesOrNull(total_miles_this_week),
      ]
    );

    res.json({ ok: true, synced_at: row?.synced_at || new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Health sync failed' });
  }
});

router.get('/sync', auth, async (req, res) => {
  try {
    await ensureHealthSyncSchema();
    const row = await dbGet(
      `SELECT steps_today, calories_today, avg_heart_rate_last_run, total_miles_this_week, synced_at
       FROM health_sync
       WHERE user_id=?`,
      [req.user.id]
    );
    res.json(row || null);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch health sync' });
  }
});

module.exports = router;
