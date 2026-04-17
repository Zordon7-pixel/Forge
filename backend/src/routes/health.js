const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { dbGet } = require('../db');
const auth = require('../middleware/auth');

const healthSyncLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many health sync requests. Try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function coerceMetric(value, options = {}) {
  const { label, integer = false, min = 0, max = Number.POSITIVE_INFINITY } = options;

  if (value === null || value === undefined || value === '') {
    return { value: null };
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return { error: `${label} must be a number` };
  }
  if (integer && !Number.isInteger(parsed)) {
    return { error: `${label} must be a whole number` };
  }
  if (parsed < min || parsed > max) {
    return { error: `${label} must be between ${min} and ${max}` };
  }

  return { value: parsed };
}

router.post('/sync', auth, healthSyncLimiter, async (req, res) => {
  try {
    const {
      steps_today = null,
      calories_today = null,
      avg_hr_bpm_last_workout = null,
      avg_heart_rate_last_run = avg_hr_bpm_last_workout,
      total_miles_this_week = null,
    } = req.body || {};

    const steps = coerceMetric(steps_today, { label: 'steps_today', integer: true, max: 250000 });
    const calories = coerceMetric(calories_today, { label: 'calories_today', integer: true, max: 20000 });
    const avgHeartRate = coerceMetric(avg_heart_rate_last_run, { label: 'avg_heart_rate_last_run', integer: true, min: 30, max: 240 });
    const totalMiles = coerceMetric(total_miles_this_week, { label: 'total_miles_this_week', max: 500 });

    const validationError = [steps, calories, avgHeartRate, totalMiles].find((result) => result.error)?.error;
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

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
        steps.value,
        calories.value,
        avgHeartRate.value,
        totalMiles.value,
      ]
    );

    res.json({ ok: true, synced_at: row?.synced_at || new Date().toISOString() });
  } catch (err) {
    console.error('[health] sync failed:', err.message);
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
    if (!row) return res.json(null);

    res.json({
      ...row,
      avg_hr_bpm_last_workout: row.avg_heart_rate_last_run,
    });
  } catch (err) {
    console.error('[health] fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch health sync' });
  }
});

module.exports = router;
