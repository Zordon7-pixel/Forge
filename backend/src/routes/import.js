const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { dbAll, dbGet, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { activityKind } = require('../lib/runActivity');
const { buildRunImportKeys } = require('../lib/runImportKey');
const { normalizeWorkoutMetrics } = require('../lib/workoutMetrics');
const { findPlannedRunForDate, hasMeaningfulPlannedRun } = require('../lib/plannedRunMatch');

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

function normalizeDateTime(value) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function normalizeZoneSeconds(value) {
  let raw = value;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      raw = JSON.parse(raw);
    } catch (err) {
      console.error('[import] heart-rate zones JSON parse failed:', err.message);
      raw = null;
    }
  }
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return ['z1', 'z2', 'z3', 'z4', 'z5'].reduce((acc, zone) => {
    const upper = zone.toUpperCase();
    acc[zone] = Math.max(0, Math.round(asNumber(source[zone] ?? source[upper] ?? 0, 0)));
    return acc;
  }, {});
}

function normalizeHeartRate(value) {
  const bpm = asNumber(value, null);
  return bpm >= 30 && bpm <= 250 ? bpm : null;
}

function firstValue(raw, keys) {
  for (const key of keys) {
    if (raw[key] !== null && raw[key] !== undefined && raw[key] !== '') return raw[key];
  }
  return null;
}

function optionalNumber(raw, keys, min, max) {
  const value = firstValue(raw, keys);
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}

function normalizeRouteCoords(value) {
  let parsed = value;
  if (typeof parsed === 'string' && parsed.trim()) {
    try {
      parsed = JSON.parse(parsed);
    } catch (err) {
      console.error('[import] route coordinates JSON parse failed:', err.message);
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 5000).map((point) => {
    const coordinate = {
      lat: Number(point?.lat ?? point?.latitude),
      lon: Number(point?.lon ?? point?.lng ?? point?.longitude),
    };
    const altitude = Number(point?.alt ?? point?.altitude);
    if (Number.isFinite(altitude) && altitude >= -500 && altitude <= 30000) coordinate.alt = altitude;
    const timestampValue = point?.time ?? point?.timestamp;
    if (timestampValue) {
      const timestamp = new Date(timestampValue);
      if (!Number.isNaN(timestamp.getTime())) coordinate.time = timestamp.toISOString();
    }
    return coordinate;
  }).filter((point) => Number.isFinite(point.lat) && point.lat >= -90 && point.lat <= 90 && Number.isFinite(point.lon) && point.lon >= -180 && point.lon <= 180);
}

function classifyType(rawType = '') {
  const value = String(rawType || '').toLowerCase().trim();
  if (value.includes('strength') || value.includes('lift') || value.includes('weight') || value.includes('resistance')) {
    return { section: 'lift', runType: null, liftCategory: 'strength' };
  }
  if (value.includes('walk')) return { section: 'activity', runType: 'walk', liftCategory: null };
  if (value.includes('treadmill')) return { section: 'run', runType: 'treadmill', liftCategory: null };
  if (value.includes('run') || value.includes('jog')) return { section: 'run', runType: 'easy', liftCategory: null };
  if (value.includes('cycl') || value.includes('bike')) return { section: 'activity', runType: 'cycling', liftCategory: null };
  if (value.includes('swim')) return { section: 'activity', runType: 'swimming', liftCategory: null };
  if (value.includes('hik')) return { section: 'activity', runType: 'hiking', liftCategory: null };
  if (value.includes('row')) return { section: 'activity', runType: 'rowing', liftCategory: null };
  if (value.includes('elliptical')) return { section: 'activity', runType: 'elliptical', liftCategory: null };
  if (value.includes('workout') || value === 'other' || !value) return { section: 'activity', runType: 'workout', liftCategory: null };
  return { section: 'activity', runType: value.slice(0, 40), liftCategory: null };
}

function normalizeRow(raw = {}) {
  const startDate = normalizeDateTime(raw.startDate || raw.start_date || raw.start || raw.activityStartDate);
  const endDate = normalizeDateTime(raw.endDate || raw.end_date || raw.end || raw.activityEndDate);
  const date = normalizeDate(raw.date || startDate || raw.startDate || raw.start_date || raw.activityDate || raw['Activity Date']);
  const type = classifyType(raw.type || raw.activityType || raw['Activity Type']);
  const distanceMiles = Number(asNumber(raw.distanceMiles || raw.distance_miles || raw.distance || 0, 0).toFixed(3));
  const durationSeconds = Math.max(0, Math.round(asNumber(raw.durationSeconds || raw.duration_seconds || raw.duration || raw.elapsedTime || 0, 0)));
  const avgHeartRate = normalizeHeartRate(raw.avgHR || raw.avgHeartRate || raw.avg_heart_rate || raw.average_heart_rate || raw['Average Heart Rate'] || null);
  const maxHeartRate = normalizeHeartRate(raw.maxHR || raw.maxHeartRate || raw.max_heart_rate || raw.maximum_heart_rate || raw['Max Heart Rate'] || null);
  const zoneSeconds = normalizeZoneSeconds(raw.zoneSeconds || raw.zone_seconds || raw.heart_rate_zones);
  const source = String(raw.source || 'imported').slice(0, 40);
  const sourceWorkoutId = String(raw.sourceWorkoutId || raw.source_workout_id || raw.id || raw.uuid || '').trim().slice(0, 200) || null;
  const workoutMetrics = normalizeWorkoutMetrics({ ...raw, metric_source: source });
  const totalZoneSeconds = Object.values(zoneSeconds).reduce((sum, seconds) => sum + seconds, 0);
  if (durationSeconds > 0 && totalZoneSeconds > 0 && workoutMetrics.metrics.hr_sample_coverage_pct === undefined) {
    workoutMetrics.metrics.hr_sample_coverage_pct = Math.min(100, Math.round((totalZoneSeconds / durationSeconds) * 1000) / 10);
  }
  return {
    date,
    startDate,
    endDate,
    ...type,
    distanceMiles,
    durationSeconds,
    avgHeartRate,
    maxHeartRate,
    zoneSeconds,
    source,
    sourceWorkoutId,
    calories: optionalNumber(raw, ['calories', 'Calories'], 0, 30000),
    perceivedEffort: optionalNumber(raw, ['perceivedEffort', 'perceived_effort', 'rpe', 'RPE'], 1, 10),
    cadenceSpm: optionalNumber(raw, ['cadenceSpm', 'cadence_spm', 'avgCadence', 'averageCadence', 'Avg Run Cadence'], 0, 300),
    elevationGain: optionalNumber(raw, ['elevationGain', 'elevation_gain', 'elevationGainFeet', 'totalAscent', 'Total Ascent'], 0, 100000),
    elevationLoss: optionalNumber(raw, ['elevationLoss', 'elevation_loss', 'elevationLossFeet', 'totalDescent', 'Total Descent'], 0, 100000),
    vo2Max: optionalNumber(raw, ['vo2Max', 'vo2_max', 'VO2 Max'], 5, 100),
    trainingEffectAerobic: optionalNumber(raw, ['trainingEffectAerobic', 'training_effect_aerobic', 'aerobicTrainingEffect', 'Aerobic TE'], 0, 10),
    trainingEffectAnaerobic: optionalNumber(raw, ['trainingEffectAnaerobic', 'training_effect_anaerobic', 'anaerobicTrainingEffect', 'Anaerobic TE'], 0, 10),
    recoveryTimeHours: optionalNumber(raw, ['recoveryTimeHours', 'recovery_time_hours', 'Recovery Time'], 0, 1000),
    temperatureF: optionalNumber(raw, ['temperatureF', 'temperature_f', 'avgTemperatureF', 'Average Temperature'], -100, 150),
    routeCoords: normalizeRouteCoords(raw.routeCoords || raw.route_coords || raw.route),
    workoutMetrics: workoutMetrics.metrics,
    droppedMetricFields: workoutMetrics.droppedFields,
    raw,
  };
}

function startsMatch(existingStart, importedStart) {
  if (!existingStart || !importedStart) return false;
  const existingTime = new Date(existingStart).getTime();
  const importedTime = new Date(importedStart).getTime();
  if (Number.isNaN(existingTime) || Number.isNaN(importedTime)) return false;
  return Math.abs(existingTime - importedTime) <= 30 * 60 * 1000;
}

async function findExistingRun(userId, item) {
  if (item.sourceWorkoutId) {
    const exact = await dbGet(
      `SELECT id, date, type, watch_activity_type, watch_normalized_type, health_start_at, planned_session_json
       FROM runs
       WHERE user_id=? AND health_source=? AND health_source_workout_id=?
       LIMIT 1`,
      [userId, item.source, item.sourceWorkoutId]
    );
    if (exact) return exact;
  }

  const candidates = await dbAll(
    `SELECT id, date, type, watch_activity_type, watch_normalized_type, health_start_at, planned_session_json
     FROM runs
     WHERE user_id=? AND date=? AND ABS(COALESCE(distance_miles,0) - ?) < 0.05
     LIMIT 25`,
    [userId, item.date, item.distanceMiles]
  );
  const incomingKind = activityKind({ type: item.runType });
  const sameActivity = candidates.filter((row) => activityKind(row) === incomingKind);
  return sameActivity.find((row) => startsMatch(row.health_start_at, item.startDate))
    || sameActivity.find((row) => !row.health_start_at)
    || null;
}

function importKeysForItem(item) {
  return buildRunImportKeys({
    healthSource: item.source,
    sourceWorkoutId: item.sourceWorkoutId,
    startDate: item.startDate,
    type: item.runType,
    watchActivityType: String(item.raw?.type || item.raw?.activityType || 'imported'),
    watchNormalizedType: item.runType,
    distanceMiles: item.distanceMiles,
    durationSeconds: item.durationSeconds,
  });
}

async function isDeletedImport(userId, item) {
  const keys = importKeysForItem(item);
  for (const key of keys) {
    const tombstone = await dbGet(
      'SELECT id FROM run_import_tombstones WHERE user_id=? AND source_key=? LIMIT 1',
      [userId, key]
    );
    if (tombstone) return true;
  }
  return false;
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
  const planned = item.section === 'run' ? await findPlannedRunForDate(userId, item.date) : null;
  await dbRun(
    `INSERT INTO runs (
      id, user_id, date, type, distance_miles, duration_seconds, perceived_effort, notes,
      avg_heart_rate, max_heart_rate, heart_rate_zones, calories, watch_mode, watch_activity_type,
      watch_normalized_type, health_source, health_source_workout_id, health_start_at, health_end_at, cadence_spm,
      elevation_gain, elevation_loss, route_coords, vo2_max, training_effect_aerobic,
      training_effect_anaerobic, recovery_time_hours, temperature_f, workout_metrics_json,
      plan_session_id, planned_session_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      runId,
      userId,
      item.date,
      item.runType || 'easy',
      item.distanceMiles,
      item.durationSeconds,
      item.perceivedEffort,
      'Imported workout',
      item.avgHeartRate,
      item.maxHeartRate,
      JSON.stringify(item.zoneSeconds),
      Math.round(asNumber(item.calories, 0)),
      'import',
      String(item.raw?.type || item.raw?.activityType || 'imported'),
      item.runType || 'imported',
      item.source,
      item.sourceWorkoutId,
      item.startDate,
      item.endDate,
      item.cadenceSpm,
      item.elevationGain,
      item.elevationLoss,
      JSON.stringify(item.routeCoords),
      item.vo2Max,
      item.trainingEffectAerobic,
      item.trainingEffectAnaerobic,
      item.recoveryTimeHours,
      item.temperatureF,
      JSON.stringify(item.workoutMetrics),
      planned?.sessionId || null,
      JSON.stringify(planned || {}),
    ]
  );
}

async function updateExistingRunHealth(userId, existingRun, item) {
  const normalizedZones = item.zoneSeconds || normalizeZoneSeconds();
  const totalZoneSeconds = ['z1', 'z2', 'z3', 'z4', 'z5'].reduce((sum, zone) => sum + asNumber(normalizedZones[zone], 0), 0);
  const zoneParam = totalZoneSeconds > 0 ? JSON.stringify(normalizedZones) : null;
  const planned = item.section === 'run' && !hasMeaningfulPlannedRun(existingRun.planned_session_json)
    ? await findPlannedRunForDate(userId, item.date)
    : null;

  await dbRun(
    `UPDATE runs SET
      avg_heart_rate = COALESCE(?, avg_heart_rate),
      max_heart_rate = COALESCE(?, max_heart_rate),
      heart_rate_zones = COALESCE(?, heart_rate_zones),
      health_source = COALESCE(?, health_source),
      health_source_workout_id = COALESCE(?, health_source_workout_id),
      health_start_at = COALESCE(?, health_start_at),
      health_end_at = COALESCE(?, health_end_at),
      type = COALESCE(?, type),
      watch_activity_type = COALESCE(?, watch_activity_type),
      watch_normalized_type = COALESCE(?, watch_normalized_type),
      cadence_spm = COALESCE(?, cadence_spm),
      elevation_gain = COALESCE(?, elevation_gain),
      elevation_loss = COALESCE(?, elevation_loss),
      route_coords = COALESCE(NULLIF(?, '[]'), route_coords),
      vo2_max = COALESCE(?, vo2_max),
      training_effect_aerobic = COALESCE(?, training_effect_aerobic),
      training_effect_anaerobic = COALESCE(?, training_effect_anaerobic),
      recovery_time_hours = COALESCE(?, recovery_time_hours),
      temperature_f = COALESCE(?, temperature_f),
      calories = CASE WHEN ?>0 THEN ? ELSE calories END,
      workout_metrics_json = COALESCE(NULLIF(?, '{}'), workout_metrics_json),
      plan_session_id = COALESCE(NULLIF(plan_session_id, ''), ?),
      planned_session_json = CASE
        WHEN planned_session_json IS NULL OR planned_session_json='' OR planned_session_json='{}'
          THEN COALESCE(?, '{}')
        ELSE planned_session_json
      END
     WHERE id=? AND user_id=?`,
    [
      item.avgHeartRate,
      item.maxHeartRate,
      zoneParam,
      item.source,
      item.sourceWorkoutId,
      item.startDate,
      item.endDate,
      item.section === 'activity' ? item.runType : null,
      String(item.raw?.type || item.raw?.activityType || 'imported'),
      item.runType,
      item.cadenceSpm,
      item.elevationGain,
      item.elevationLoss,
      JSON.stringify(item.routeCoords),
      item.vo2Max,
      item.trainingEffectAerobic,
      item.trainingEffectAnaerobic,
      item.recoveryTimeHours,
      item.temperatureF,
      asNumber(item.calories, 0),
      Math.round(asNumber(item.calories, 0)),
      JSON.stringify(item.workoutMetrics),
      planned?.sessionId || null,
      planned ? JSON.stringify(planned) : null,
      existingRun.id,
      userId,
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

      if (item.section === 'run' || item.section === 'activity') {
        if (await isDeletedImport(userId, item)) {
          skipped += 1;
          continue;
        }
        const existing = await findExistingRun(userId, item);
        if (existing) {
          await updateExistingRunHealth(userId, existing, item);
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
      console.error(`[import] row ${i} failed:`, err.message);
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
    console.error('[import/health] failed:', err.message);
    res.status(500).json({ imported: 0, skipped: 0, errors: [{ error: 'Apple Health import failed' }] });
  }
});

router.post('/workouts', auth, async (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : req.body?.workouts;
    const result = await importRows(req.user.id, rows);
    res.json(result);
  } catch (err) {
    console.error('[import/workouts] failed:', err.message);
    res.status(500).json({ imported: 0, skipped: 0, errors: [{ error: 'Workout import failed' }] });
  }
});

module.exports = router;
module.exports._test = {
  classifyType,
  normalizeRouteCoords,
  normalizeRow,
  importKeysForItem,
};
