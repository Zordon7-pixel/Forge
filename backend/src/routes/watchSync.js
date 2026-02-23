const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const auth = require('../middleware/auth');

function normalizeActivityType(rawType = '') {
  const v = String(rawType || '').toLowerCase().trim();

  if (['run', 'outdoor run'].includes(v)) return { normalized: 'run_outdoor', section: 'run', runType: 'easy', surface: 'outdoor' };
  if (v === 'indoor run') return { normalized: 'run_indoor', section: 'run', runType: 'easy', surface: 'treadmill' };
  if (v === 'treadmill') return { normalized: 'treadmill', section: 'run', runType: 'treadmill', surface: 'treadmill' };
  if (['walk', 'outdoor walk'].includes(v)) return { normalized: 'walk_outdoor', section: 'run', runType: 'walk', surface: 'outdoor' };
  if (v === 'indoor walk') return { normalized: 'walk_indoor', section: 'run', runType: 'walk', surface: 'treadmill' };
  if (['strength training', 'weightlifting'].includes(v)) return { normalized: 'strength', section: 'lift', liftCategory: 'strength' };
  if (v === 'hiit') return { normalized: 'hiit', section: 'lift', liftCategory: 'hiit' };
  if (['cycling', 'indoor cycling'].includes(v)) return { normalized: 'cycling', section: 'other' };
  if (v === 'swimming') return { normalized: 'swimming', section: 'other' };

  return { normalized: 'other', section: 'other' };
}

function asNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

router.post('/', auth, (req, res) => {
  const payload = req.body || {};
  const mapped = normalizeActivityType(payload.activity_type);
  const now = new Date().toISOString();
  const watchSyncId = uuidv4();

  const activityName = payload.activity_name || payload.activity_type || 'Watch activity';

  db.prepare(`INSERT INTO watch_sync (
    id, user_id, activity_type, activity_name, normalized_type, routed_section,
    distance_miles, duration_seconds, avg_pace, pace_splits_json,
    avg_heart_rate, max_heart_rate, min_heart_rate, heart_rate_zones_json,
    cadence_spm, elevation_gain, elevation_loss, route_coords,
    vo2_max, training_effect_aerobic, training_effect_anaerobic,
    recovery_time_hours, detected_surface_type, temperature_f,
    calories, exercise_name, sets, reps, weight_lbs,
    set_heart_rate_json, rest_heart_rate_json, workout_duration_seconds,
    recovery_heart_rate, incline_pct, belt_speed_mph,
    treadmill_brand, treadmill_model, watch_mode, raw_payload, synced_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    watchSyncId,
    req.user.id,
    payload.activity_type || null,
    activityName,
    mapped.normalized,
    mapped.section,
    asNum(payload.distance_miles, 0),
    asNum(payload.duration_seconds, 0),
    asNum(payload.avg_pace),
    JSON.stringify(payload.pace_splits || []),
    asNum(payload.avg_heart_rate),
    asNum(payload.max_heart_rate),
    asNum(payload.min_heart_rate),
    JSON.stringify(payload.heart_rate_zones || []),
    asNum(payload.cadence_spm),
    asNum(payload.elevation_gain),
    asNum(payload.elevation_loss),
    JSON.stringify(payload.route_coords || []),
    asNum(payload.vo2_max),
    asNum(payload.training_effect_aerobic),
    asNum(payload.training_effect_anaerobic),
    asNum(payload.recovery_time_hours),
    payload.surface_type || null,
    asNum(payload.temperature_f),
    asNum(payload.calories),
    payload.exercise_name || null,
    asNum(payload.sets),
    asNum(payload.reps),
    asNum(payload.weight_lbs),
    JSON.stringify(payload.set_heart_rate || []),
    JSON.stringify(payload.rest_heart_rate || []),
    asNum(payload.workout_duration_seconds),
    asNum(payload.recovery_heart_rate),
    asNum(payload.incline_pct),
    asNum(payload.belt_speed_mph),
    payload.treadmill_brand || null,
    payload.treadmill_model || null,
    payload.watch_mode || null,
    JSON.stringify(payload),
    now
  );

  let createdRecordId = null;

  if (mapped.section === 'run') {
    const runId = uuidv4();
    createdRecordId = runId;
    const runDate = payload.date || now.slice(0, 10);
    const resolvedSurface = mapped.surface || payload.surface_type || 'road';
    db.prepare(`INSERT INTO runs (
      id, user_id, date, type, distance_miles, duration_seconds, perceived_effort, notes,
      run_surface, surface, incline_pct, treadmill_speed, route_coords, watch_mode,
      watch_sync_id, watch_activity_type, watch_normalized_type,
      avg_heart_rate, max_heart_rate, min_heart_rate, heart_rate_zones,
      cadence_spm, elevation_gain, elevation_loss, pace_avg,
      pace_splits, vo2_max, training_effect_aerobic, training_effect_anaerobic,
      recovery_time_hours, detected_surface_type, temperature_f, calories,
      treadmill_brand, treadmill_model
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      runId,
      req.user.id,
      runDate,
      mapped.runType || payload.type || 'easy',
      asNum(payload.distance_miles, 0),
      asNum(payload.duration_seconds, 0),
      asNum(payload.perceived_effort, 5),
      payload.notes || 'Synced from watch',
      resolvedSurface,
      resolvedSurface,
      asNum(payload.incline_pct, 0),
      asNum(payload.belt_speed_mph || payload.treadmill_speed, 0),
      JSON.stringify(payload.route_coords || []),
      payload.watch_mode || 'watch-sync',
      watchSyncId,
      payload.activity_type || null,
      mapped.normalized,
      asNum(payload.avg_heart_rate),
      asNum(payload.max_heart_rate),
      asNum(payload.min_heart_rate),
      JSON.stringify(payload.heart_rate_zones || []),
      asNum(payload.cadence_spm),
      asNum(payload.elevation_gain),
      asNum(payload.elevation_loss),
      asNum(payload.avg_pace),
      JSON.stringify(payload.pace_splits || []),
      asNum(payload.vo2_max),
      asNum(payload.training_effect_aerobic),
      asNum(payload.training_effect_anaerobic),
      asNum(payload.recovery_time_hours),
      payload.surface_type || null,
      asNum(payload.temperature_f),
      asNum(payload.calories, 0),
      payload.treadmill_brand || null,
      payload.treadmill_model || null
    );
  } else if (mapped.section === 'lift') {
    const liftId = uuidv4();
    createdRecordId = liftId;
    db.prepare(`INSERT INTO lifts (
      id, user_id, date, muscle_groups, intensity, notes,
      exercise_name, sets, reps, weight_lbs,
      watch_sync_id, watch_activity_type, watch_normalized_type,
      avg_heart_rate, max_heart_rate, min_heart_rate,
      set_heart_rate, rest_heart_rate,
      workout_duration_seconds, calories,
      recovery_heart_rate, category
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      liftId,
      req.user.id,
      payload.date || now.slice(0, 10),
      JSON.stringify(payload.muscle_groups || []),
      payload.intensity || 'moderate',
      payload.notes || 'Synced from watch',
      payload.exercise_name || (mapped.liftCategory === 'hiit' ? 'HIIT Session' : 'Strength Session'),
      asNum(payload.sets),
      asNum(payload.reps),
      asNum(payload.weight_lbs),
      watchSyncId,
      payload.activity_type || null,
      mapped.normalized,
      asNum(payload.avg_heart_rate),
      asNum(payload.max_heart_rate),
      asNum(payload.min_heart_rate),
      JSON.stringify(payload.set_heart_rate || []),
      JSON.stringify(payload.rest_heart_rate || []),
      asNum(payload.workout_duration_seconds),
      asNum(payload.calories),
      asNum(payload.recovery_heart_rate),
      mapped.liftCategory || 'strength'
    );
  }

  res.status(201).json({
    id: watchSyncId,
    created_record_id: createdRecordId,
    normalized_type: mapped.normalized,
    routed_section: mapped.section,
    activity_name: activityName,
    synced_at: now,
  });
});

router.get('/recent', auth, (req, res) => {
  const since = req.query.since || '1970-01-01T00:00:00';
  const rows = db.prepare(`SELECT * FROM watch_sync WHERE user_id=? AND synced_at > ? ORDER BY synced_at DESC LIMIT 20`).all(req.user.id, since);
  res.json({ items: rows });
});

router.get('/status', auth, (req, res) => {
  const lastSync = db.prepare(`SELECT synced_at FROM watch_sync WHERE user_id=? ORDER BY synced_at DESC LIMIT 1`).get(req.user.id);
  const activityCount = db.prepare(`SELECT COUNT(*) as count FROM watch_sync WHERE user_id=?`).get(req.user.id);
  
  res.json({
    lastSynced: lastSync?.synced_at || null,
    activityCount: activityCount?.count || 0
  });
});

module.exports = router;
