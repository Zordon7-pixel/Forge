const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { dbGet } = require('../db');
const { coerceMetric, hydrateHealthRow, normalizeTrainingMetrics } = require('../lib/healthSyncMetrics');
const auth = require('../middleware/auth');

const healthSyncLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many health sync requests. Try again in a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/sync', auth, healthSyncLimiter, async (req, res) => {
  try {
    const {
      steps_today = null,
      calories_today = null,
      avg_hr_bpm_last_workout = null,
      avg_heart_rate_last_run = avg_hr_bpm_last_workout,
      total_miles_this_week = null,
      resting_heart_rate = null,
      hrv_ms = null,
      sleep_hours_last_night = null,
      active_minutes_this_week = null,
      workout_count_this_week = null,
      last_workout_type = null,
      last_workout_duration_seconds = null,
      last_workout_calories = null,
    } = req.body || {};

    const steps = coerceMetric(steps_today, { label: 'steps_today', integer: true, max: 250000 });
    const calories = coerceMetric(calories_today, { label: 'calories_today', integer: true, max: 20000 });
    const avgHeartRate = coerceMetric(avg_heart_rate_last_run, { label: 'avg_heart_rate_last_run', integer: true, min: 30, max: 240 });
    const totalMiles = coerceMetric(total_miles_this_week, { label: 'total_miles_this_week', max: 500 });
    const restingHeartRate = coerceMetric(resting_heart_rate, { label: 'resting_heart_rate', integer: true, min: 30, max: 240 });
    const hrv = coerceMetric(hrv_ms, { label: 'hrv_ms', integer: true, min: 1, max: 500 });
    const sleepHours = coerceMetric(sleep_hours_last_night, { label: 'sleep_hours_last_night', min: 0, max: 16, dropAboveMax: true });
    const activeMinutes = coerceMetric(active_minutes_this_week, { label: 'active_minutes_this_week', integer: true, min: 0, max: 10080 });
    const workoutCount = coerceMetric(workout_count_this_week, { label: 'workout_count_this_week', integer: true, min: 0, max: 200 });
    const lastWorkoutSeconds = coerceMetric(last_workout_duration_seconds, { label: 'last_workout_duration_seconds', integer: true, min: 0, max: 86400 });
    const lastWorkoutCaloriesValue = coerceMetric(last_workout_calories, { label: 'last_workout_calories', integer: true, min: 0, max: 20000 });
    const lastWorkoutType = String(last_workout_type || '').trim().slice(0, 40) || null;
    const trainingMetrics = normalizeTrainingMetrics(req.body || {});

    const validationError = trainingMetrics.error
      || [steps, calories, avgHeartRate, totalMiles, restingHeartRate, hrv, sleepHours, activeMinutes, workoutCount, lastWorkoutSeconds, lastWorkoutCaloriesValue].find((result) => result.error)?.error;
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }
    const droppedFields = [steps, calories, avgHeartRate, totalMiles, restingHeartRate, hrv, sleepHours, activeMinutes, workoutCount, lastWorkoutSeconds, lastWorkoutCaloriesValue]
      .filter((result) => result.dropped && result.field)
      .map((result) => result.field);

    const row = await dbGet(
      `INSERT INTO health_sync (
        user_id,
        steps_today,
        calories_today,
        avg_heart_rate_last_run,
        total_miles_this_week,
        resting_heart_rate,
        hrv_ms,
        sleep_hours_last_night,
        active_minutes_this_week,
        workout_count_this_week,
        last_workout_type,
        last_workout_duration_seconds,
        last_workout_calories,
        training_metrics_json,
        synced_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        steps_today = EXCLUDED.steps_today,
        calories_today = EXCLUDED.calories_today,
        avg_heart_rate_last_run = EXCLUDED.avg_heart_rate_last_run,
        total_miles_this_week = EXCLUDED.total_miles_this_week,
        resting_heart_rate = EXCLUDED.resting_heart_rate,
        hrv_ms = EXCLUDED.hrv_ms,
        sleep_hours_last_night = EXCLUDED.sleep_hours_last_night,
        active_minutes_this_week = EXCLUDED.active_minutes_this_week,
        workout_count_this_week = EXCLUDED.workout_count_this_week,
        last_workout_type = EXCLUDED.last_workout_type,
        last_workout_duration_seconds = EXCLUDED.last_workout_duration_seconds,
        last_workout_calories = EXCLUDED.last_workout_calories,
        training_metrics_json = COALESCE(health_sync.training_metrics_json, '{}'::jsonb) || EXCLUDED.training_metrics_json,
        synced_at = NOW()
      RETURNING synced_at`,
      [
        req.user.id,
        steps.value,
        calories.value,
        avgHeartRate.value,
        totalMiles.value,
        restingHeartRate.value,
        hrv.value,
        sleepHours.value,
        activeMinutes.value,
        workoutCount.value,
        lastWorkoutType,
        lastWorkoutSeconds.value,
        lastWorkoutCaloriesValue.value,
        JSON.stringify(trainingMetrics.metrics),
      ]
    );

    res.json({ ok: true, synced_at: row?.synced_at || new Date().toISOString(), ...(droppedFields.length ? { droppedFields } : {}) });
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
        resting_heart_rate,
        hrv_ms,
        sleep_hours_last_night,
        active_minutes_this_week,
        workout_count_this_week,
        last_workout_type,
        last_workout_duration_seconds,
        last_workout_calories,
        training_metrics_json,
        synced_at
      FROM health_sync
      WHERE user_id=$1`,
      [req.user.id]
    );
    if (!row) return res.json(null);

    const hydrated = hydrateHealthRow(row);
    delete hydrated.training_metrics_json;
    res.json({ ...hydrated, avg_hr_bpm_last_workout: row.avg_heart_rate_last_run });
  } catch (err) {
    console.error('[health] fetch failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch health sync' });
  }
});

module.exports = router;
