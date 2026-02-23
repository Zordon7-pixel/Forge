const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const auth = require('../middleware/auth');
const multer = require('multer');
const { parseStringPromise } = require('xml2js');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

function normalizeActivityType(rawType = '') {
  const v = String(rawType || '').toLowerCase().trim();

  // Meta Ray-Ban glasses
  if (v.includes('meta') || v.includes('ray-ban') || v.includes('meta_glasses')) return { normalized: 'meta_glasses', section: 'devices' };

  if (['run', 'outdoor run'].includes(v)) return { normalized: 'run_outdoor', section: 'run', runType: 'easy', surface: 'outdoor' };
  if (v === 'indoor run') return { normalized: 'run_indoor', section: 'run', runType: 'easy', surface: 'treadmill' };
  if (v === 'treadmill') return { normalized: 'treadmill', section: 'run', runType: 'treadmill', surface: 'treadmill' };
  if (['walk', 'outdoor walk'].includes(v)) return { normalized: 'walk_outdoor', section: 'run', runType: 'walk', surface: 'outdoor' };
  if (v === 'indoor walk') return { normalized: 'walk_indoor', section: 'run', runType: 'walk', surface: 'treadmill' };
  if (['strength training', 'weightlifting', 'lift', 'strength'].includes(v)) return { normalized: 'strength', section: 'lift', liftCategory: 'strength' };
  if (v === 'hiit') return { normalized: 'hiit', section: 'lift', liftCategory: 'hiit' };
  if (['cycling', 'indoor cycling'].includes(v)) return { normalized: 'cycling', section: 'other' };
  if (v === 'swimming') return { normalized: 'swimming', section: 'other' };

  return { normalized: 'other', section: 'other' };
}

function asNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function ingestActivity(userId, payload = {}) {
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
    userId,
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
      runId, userId, runDate, mapped.runType || payload.type || 'easy',
      asNum(payload.distance_miles, 0), asNum(payload.duration_seconds, 0), asNum(payload.perceived_effort, 5), payload.notes || 'Synced from watch',
      resolvedSurface, resolvedSurface, asNum(payload.incline_pct, 0), asNum(payload.belt_speed_mph || payload.treadmill_speed, 0), JSON.stringify(payload.route_coords || []), payload.watch_mode || 'watch-sync',
      watchSyncId, payload.activity_type || null, mapped.normalized,
      asNum(payload.avg_heart_rate), asNum(payload.max_heart_rate), asNum(payload.min_heart_rate), JSON.stringify(payload.heart_rate_zones || []),
      asNum(payload.cadence_spm), asNum(payload.elevation_gain), asNum(payload.elevation_loss), asNum(payload.avg_pace),
      JSON.stringify(payload.pace_splits || []), asNum(payload.vo2_max), asNum(payload.training_effect_aerobic), asNum(payload.training_effect_anaerobic),
      asNum(payload.recovery_time_hours), payload.surface_type || null, asNum(payload.temperature_f), asNum(payload.calories, 0),
      payload.treadmill_brand || null, payload.treadmill_model || null
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
      liftId, userId, payload.date || now.slice(0, 10), JSON.stringify(payload.muscle_groups || []), payload.intensity || 'moderate', payload.notes || 'Synced from watch',
      payload.exercise_name || (mapped.liftCategory === 'hiit' ? 'HIIT Session' : 'Strength Session'), asNum(payload.sets), asNum(payload.reps), asNum(payload.weight_lbs),
      watchSyncId, payload.activity_type || null, mapped.normalized,
      asNum(payload.avg_heart_rate), asNum(payload.max_heart_rate), asNum(payload.min_heart_rate),
      JSON.stringify(payload.set_heart_rate || []), JSON.stringify(payload.rest_heart_rate || []),
      asNum(payload.workout_duration_seconds), asNum(payload.calories),
      asNum(payload.recovery_heart_rate), mapped.liftCategory || 'strength'
    );
  }

  return { id: watchSyncId, created_record_id: createdRecordId, normalized_type: mapped.normalized, routed_section: mapped.section, activity_name: activityName, synced_at: now };
}

router.post('/', auth, (req, res) => {
  const result = ingestActivity(req.user.id, req.body || {});
  res.status(201).json(result);
});

router.post('/upload', auth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const filename = req.file.originalname || 'activity';
    const lower = filename.toLowerCase();
    let payload;

    if (lower.endsWith('.gpx')) {
      const xml = req.file.buffer.toString('utf8');
      const parsed = await parseStringPromise(xml);
      const points = parsed?.gpx?.trk?.[0]?.trkseg?.[0]?.trkpt || [];
      if (!points.length) return res.status(400).json({ error: 'No track points found in GPX' });

      const route = [];
      let distance = 0;
      let elevationGain = 0;
      let elevationLoss = 0;
      let prev = null;

      for (const p of points) {
        const lat = Number(p.$?.lat);
        const lon = Number(p.$?.lon);
        const ele = Number(p.ele?.[0] || 0);
        const time = p.time?.[0] || null;
        if (Number.isFinite(lat) && Number.isFinite(lon)) route.push({ lat, lng: lon, ele, time });
        if (prev && Number.isFinite(lat) && Number.isFinite(lon)) {
          distance += haversineMiles(prev.lat, prev.lon, lat, lon);
          const diff = ele - prev.ele;
          if (diff > 0) elevationGain += diff;
          if (diff < 0) elevationLoss += Math.abs(diff);
        }
        prev = { lat, lon, ele };
      }

      const startTime = new Date(points[0]?.time?.[0] || Date.now());
      const endTime = new Date(points[points.length - 1]?.time?.[0] || Date.now());
      const durationSeconds = Math.max(0, Math.round((endTime.getTime() - startTime.getTime()) / 1000));

      payload = {
        activity_type: 'run',
        activity_name: filename.replace(/\.gpx$/i, ''),
        date: startTime.toISOString().slice(0, 10),
        distance_miles: Number(distance.toFixed(2)),
        duration_seconds: durationSeconds,
        avg_pace: distance > 0 ? durationSeconds / distance : null,
        elevation_gain: Number(elevationGain.toFixed(1)),
        elevation_loss: Number(elevationLoss.toFixed(1)),
        route_coords: route,
        watch_mode: 'file-upload',
      };
    } else if (lower.endsWith('.json')) {
      const raw = JSON.parse(req.file.buffer.toString('utf8'));
      const type = raw.type || raw.activity_type || raw.sport || 'run';
      const distanceMeters = Number(raw.distance || raw.distance_m || raw.distanceMeters || 0);
      const distanceMiles = distanceMeters > 0 ? distanceMeters / 1609.34 : Number(raw.distance_miles || 0);
      const duration = Number(raw.duration || raw.duration_seconds || raw.elapsed_time || 0);

      payload = {
        activity_type: String(type),
        activity_name: raw.name || raw.activity_name || filename.replace(/\.json$/i, ''),
        date: (raw.date || raw.start_date || new Date().toISOString()).slice(0, 10),
        distance_miles: Number(distanceMiles.toFixed(2)),
        duration_seconds: duration,
        avg_heart_rate: Number(raw.avg_heart_rate || raw.hr_avg || 0) || null,
        cadence_spm: Number(raw.cadence || raw.avg_cadence || 0) || null,
        calories: Number(raw.calories || 0) || null,
        watch_mode: 'file-upload',
      };
    } else {
      return res.status(400).json({ error: "We couldn't parse this file. Supported: GPX, Garmin JSON export" });
    }

    const result = ingestActivity(req.user.id, payload);
    res.status(201).json({ ...result, message: `Activity imported — ${result.activity_name} added to your ${result.routed_section === 'lift' ? 'Lift' : 'Run'} history` });
  } catch (e) {
    res.status(400).json({ error: "We couldn't parse this file. Supported: GPX, Garmin JSON export" });
  }
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

router.get('/meta/status', auth, (req, res) => {
  const lastSync = db.prepare(`SELECT * FROM watch_sync WHERE user_id=? AND (normalized_type='meta_glasses' OR activity_type LIKE '%meta%') ORDER BY synced_at DESC LIMIT 1`).get(req.user.id);
  res.json({
    connected: false,
    api_status: 'coming_soon',
    last_sync: lastSync || null,
    capabilities: ['step_count', 'ambient_audio', 'voice_coaching', 'camera_pov', 'activity_detection'],
    note: 'Meta Ray-Ban API integration is ready — connect when Meta opens developer access'
  });
});

module.exports = router;