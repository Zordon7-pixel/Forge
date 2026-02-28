const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun } = require('../db');
const auth = require('../middleware/auth');

function asNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function classifyType(rawType = '') {
  const value = String(rawType || '').toLowerCase().trim();
  if (value.includes('strength') || value.includes('lift') || value.includes('weight') || value.includes('resistance')) {
    return { section: 'lift', runType: null, liftCategory: 'strength' };
  }
  if (value.includes('walk')) return { section: 'run', runType: 'walk', liftCategory: null };
  if (value.includes('treadmill')) return { section: 'run', runType: 'treadmill', liftCategory: null };
  if (value.includes('run') || value.includes('jog')) return { section: 'run', runType: 'easy', liftCategory: null };
  if (value.includes('workout')) return { section: 'lift', runType: null, liftCategory: 'strength' };
  return { section: 'run', runType: 'easy', liftCategory: null };
}

function normalizeRow(raw = {}) {
  const date = normalizeDate(raw.date || raw.startDate || raw.start_date || raw.activityDate || raw['Activity Date']);
  const type = classifyType(raw.type || raw.activityType || raw['Activity Type']);
  const distanceMiles = Number(asNumber(raw.distanceMiles || raw.distance_miles || raw.distance || 0, 0).toFixed(3));
  const durationSeconds = Math.max(0, Math.round(asNumber(raw.durationSeconds || raw.duration_seconds || raw.duration || raw.elapsedTime || 0, 0)));
  const avgHeartRate = asNumber(raw.avgHeartRate || raw.avg_heart_rate || raw.average_heart_rate || raw['Average Heart Rate'] || null, null);
  return { date, ...type, distanceMiles, durationSeconds, avgHeartRate, raw };
}

async function runExists(userId, date, distanceMiles) {
  const existing = await dbGet(
    'SELECT id FROM runs WHERE user_id=? AND date=? AND ABS(COALESCE(distance_miles,0) - ?) < 0.01 LIMIT 1',
    [userId, date, distanceMiles]
  );
  return Boolean(existing);
}

async function liftExists(userId, date, distanceMiles, durationSeconds) {
  const distanceTag = `[import_distance:${Number(distanceMiles || 0).toFixed(3)}]`;
  const existing = await dbGet(
    'SELECT id FROM lifts WHERE user_id=? AND date=? AND (notes LIKE ? OR ABS(COALESCE(workout_duration_seconds,0) - ?) <= 60) LIMIT 1',
    [userId, date, `%${distanceTag}%`, durationSeconds]
  );
  return Boolean(existing);
}

async function insertRun(userId, item) {
  const runId = uuidv4();
  await dbRun(
    `INSERT INTO runs (
      id, user_id, date, type, distance_miles, duration_seconds, perceived_effort, notes,
      avg_heart_rate, watch_mode, watch_activity_type, watch_normalized_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      runId,
      userId,
      item.date,
      item.runType || 'easy',
      item.distanceMiles,
      item.durationSeconds,
      5,
      'Imported workout',
      item.avgHeartRate,
      'import',
      String(item.raw?.type || item.raw?.activityType || 'imported'),
      'imported',
    ]
  );
}

async function insertLift(userId, item) {
  const liftId = uuidv4();
  const distanceTag = `[import_distance:${Number(item.distanceMiles || 0).toFixed(3)}]`;
  await dbRun(
    `INSERT INTO lifts (
      id, user_id, date, muscle_groups, intensity, notes, exercise_name,
      workout_duration_seconds, avg_heart_rate, category, watch_activity_type, watch_normalized_type
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      liftId,
      userId,
      item.date,
      JSON.stringify([]),
      'moderate',
      `Imported workout ${distanceTag}`,
      'Imported Strength Session',
      item.durationSeconds || null,
      item.avgHeartRate,
      item.liftCategory || 'strength',
      String(item.raw?.type || item.raw?.activityType || 'imported'),
      'imported',
    ]
  );
}

async function importRows(userId, rawRows) {
  const errors = [];
  let imported = 0;
  let skipped = 0;
  const rows = Array.isArray(rawRows) ? rawRows : [];

  for (let i = 0; i < rows.length; i += 1) {
    try {
      const item = normalizeRow(rows[i]);
      if (!item.date) {
        skipped += 1;
        continue;
      }

      if (item.section === 'run') {
        const exists = await runExists(userId, item.date, item.distanceMiles);
        if (exists) {
          skipped += 1;
          continue;
        }
        await insertRun(userId, item);
        imported += 1;
        continue;
      }

      const exists = await liftExists(userId, item.date, item.distanceMiles, item.durationSeconds);
      if (exists) {
        skipped += 1;
        continue;
      }
      await insertLift(userId, item);
      imported += 1;
    } catch (err) {
      errors.push({ index: i, error: err.message || 'Import failed for row' });
    }
  }

  return { imported, skipped, errors };
}

router.post('/health', auth, async (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : req.body?.workouts;
    const result = await importRows(req.user.id, rows);
    res.json(result);
  } catch (err) {
    res.status(500).json({ imported: 0, skipped: 0, errors: [{ error: 'Apple Health import failed' }] });
  }
});

router.post('/workouts', auth, async (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : req.body?.workouts;
    const result = await importRows(req.user.id, rows);
    res.json(result);
  } catch (err) {
    res.status(500).json({ imported: 0, skipped: 0, errors: [{ error: 'Workout import failed' }] });
  }
});

module.exports = router;
