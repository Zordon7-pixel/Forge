const router = require('express').Router();
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { computeZones, parseCustomMinimums } = require('../lib/hrZones');
const { deriveHrProfileFromHistory, computeFieldTestLthr } = require('../lib/hrCalibration');

const ZONE_MODELS = new Set(['hrr', 'maxhr', 'lthr', 'custom']);

function profileFromRow(row) {
  if (!row) return null;
  return {
    maxHr: row.max_hr,
    restingHr: row.resting_hr,
    lthr: row.lthr,
    customMinimums: parseCustomMinimums(row.custom_zones_json),
    zoneModel: row.zone_model,
    source: row.source,
    updatedAt: row.updated_at,
  };
}

function responseFromRow(row) {
  const profile = profileFromRow(row);
  return {
    profile,
    zones: profile
      ? computeZones({
        maxHr: profile.maxHr,
        restingHr: profile.restingHr,
        lthr: profile.lthr,
        model: profile.zoneModel,
        customMinimums: profile.customMinimums,
      }).zones
      : [],
  };
}

function validateHrField(value, field) {
  if (value === null || value === undefined || value === '') return { value: null };
  if (!Number.isInteger(value) || value < 30 || value > 230) {
    return { error: `${field} must be an integer between 30 and 230, or null` };
  }
  return { value };
}

router.get('/', auth, async (req, res) => {
  try {
    const row = await dbGet(
      `SELECT max_hr, resting_hr, lthr, custom_zones_json, zone_model, source, updated_at
       FROM user_hr_profile
       WHERE user_id = ?`,
      [req.user.id]
    );

    res.json(responseFromRow(row));
  } catch (err) {
    console.error('[hrProfile] GET failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch HR profile' });
  }
});

router.post('/derive', auth, async (req, res) => {
  try {
    const suggestion = await deriveHrProfileFromHistory(req.user.id, { dbGet, dbAll });
    res.json(suggestion);
  } catch (err) {
    console.error('[hrProfile] derive failed:', err.message);
    res.status(500).json({ error: 'Failed to derive HR profile' });
  }
});

router.post('/field-test', auth, async (req, res) => {
  try {
    const { avgHr, durationMinutes } = req.body || {};

    if (typeof durationMinutes !== 'number' || !Number.isFinite(durationMinutes) || durationMinutes < 15) {
      return res.status(400).json({ error: 'field test must be at least 15 minutes' });
    }
    if (!Number.isInteger(avgHr) || avgHr < 60 || avgHr > 230) {
      return res.status(400).json({ error: 'avgHr must be between 60 and 230' });
    }

    const result = computeFieldTestLthr(avgHr);
    if (result.error) {
      return res.status(400).json({ error: result.error });
    }

    await dbRun(
      `INSERT INTO user_hr_profile (user_id, lthr, zone_model, source, updated_at)
       VALUES (?, ?, 'lthr', 'field_test', now())
       ON CONFLICT (user_id) DO UPDATE SET
         lthr = EXCLUDED.lthr,
         zone_model = 'lthr',
         source = 'field_test',
         updated_at = now()`,
      [req.user.id, result.lthr]
    );

    const row = await dbGet(
      `SELECT max_hr, resting_hr, lthr, custom_zones_json, zone_model, source, updated_at
       FROM user_hr_profile
       WHERE user_id = ?`,
      [req.user.id]
    );

    res.json({ profile: profileFromRow(row), zones: result.zones });
  } catch (err) {
    console.error('[hrProfile] field-test failed:', err.message);
    res.status(500).json({ error: 'Failed to save field test HR profile' });
  }
});

router.put('/', auth, async (req, res) => {
  try {
    const { maxHr, restingHr, lthr, zoneModel, customMinimums } = req.body || {};
    const maxHrResult = validateHrField(maxHr, 'maxHr');
    const restingHrResult = validateHrField(restingHr, 'restingHr');
    const lthrResult = validateHrField(lthr, 'lthr');

    const error = maxHrResult.error || restingHrResult.error || lthrResult.error;
    if (error) return res.status(400).json({ error });
    if (!ZONE_MODELS.has(zoneModel)) {
      return res.status(400).json({ error: 'zoneModel must be one of hrr, maxhr, lthr, custom' });
    }
    if (restingHrResult.value !== null && maxHrResult.value !== null && restingHrResult.value >= maxHrResult.value) {
      return res.status(400).json({ error: 'resting_hr must be less than max_hr' });
    }
    if (lthrResult.value !== null && maxHrResult.value !== null && lthrResult.value >= maxHrResult.value) {
      return res.status(400).json({ error: 'lthr must be less than max_hr' });
    }
    if (lthrResult.value !== null && restingHrResult.value !== null && lthrResult.value <= restingHrResult.value) {
      return res.status(400).json({ error: 'lthr must be greater than resting_hr' });
    }
    if (zoneModel === 'lthr' && lthrResult.value === null) {
      return res.status(400).json({ error: 'lthr is required for the lthr model' });
    }
    if (zoneModel === 'maxhr' && maxHrResult.value === null) {
      return res.status(400).json({ error: 'maxHr is required for the maxhr model' });
    }
    if (zoneModel === 'hrr' && (maxHrResult.value === null || restingHrResult.value === null)) {
      return res.status(400).json({ error: 'maxHr and restingHr are required for the hrr model' });
    }
    const normalizedCustomMinimums = parseCustomMinimums(customMinimums);
    if (zoneModel === 'custom' && normalizedCustomMinimums.length !== 5) {
      return res.status(400).json({ error: 'customMinimums must contain five strictly increasing bpm values between 30 and 230' });
    }

    const row = await dbGet(
      `INSERT INTO user_hr_profile (user_id, max_hr, resting_hr, lthr, custom_zones_json, zone_model, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, now())
       ON CONFLICT (user_id) DO UPDATE SET
         max_hr = excluded.max_hr,
         resting_hr = excluded.resting_hr,
         lthr = excluded.lthr,
         custom_zones_json = excluded.custom_zones_json,
         zone_model = excluded.zone_model,
         source = excluded.source,
         updated_at = now()
       RETURNING max_hr, resting_hr, lthr, custom_zones_json, zone_model, source, updated_at`,
      [
        req.user.id,
        maxHrResult.value,
        restingHrResult.value,
        lthrResult.value,
        JSON.stringify(normalizedCustomMinimums),
        zoneModel,
        zoneModel === 'custom' ? 'manual_watch' : 'manual',
      ]
    );

    res.json(responseFromRow(row));
  } catch (err) {
    console.error('[hrProfile] PUT failed:', err.message);
    res.status(500).json({ error: 'Failed to save HR profile' });
  }
});

module.exports = router;
