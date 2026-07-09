const router = require('express').Router();
const { dbGet } = require('../db');
const auth = require('../middleware/auth');
const { computeZones } = require('../lib/hrZones');

const ZONE_MODELS = new Set(['hrr', 'maxhr', 'lthr']);

function profileFromRow(row) {
  if (!row) return null;
  return {
    maxHr: row.max_hr,
    restingHr: row.resting_hr,
    lthr: row.lthr,
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
      }).zones
      : [],
  };
}

function validateHrField(value, field) {
  if (value === null) return { value: null };
  if (!Number.isInteger(value) || value < 30 || value > 230) {
    return { error: `${field} must be an integer between 30 and 230, or null` };
  }
  return { value };
}

router.get('/', auth, async (req, res) => {
  try {
    const row = await dbGet(
      `SELECT max_hr, resting_hr, lthr, zone_model, source, updated_at
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

router.put('/', auth, async (req, res) => {
  try {
    const { maxHr, restingHr, lthr, zoneModel } = req.body || {};
    const maxHrResult = validateHrField(maxHr, 'maxHr');
    const restingHrResult = validateHrField(restingHr, 'restingHr');
    const lthrResult = validateHrField(lthr, 'lthr');

    const error = maxHrResult.error || restingHrResult.error || lthrResult.error;
    if (error) return res.status(400).json({ error });
    if (!ZONE_MODELS.has(zoneModel)) {
      return res.status(400).json({ error: 'zoneModel must be one of hrr, maxhr, lthr' });
    }

    const row = await dbGet(
      `INSERT INTO user_hr_profile (user_id, max_hr, resting_hr, lthr, zone_model, source, updated_at)
       VALUES (?, ?, ?, ?, ?, 'manual', now())
       ON CONFLICT (user_id) DO UPDATE SET
         max_hr = excluded.max_hr,
         resting_hr = excluded.resting_hr,
         lthr = excluded.lthr,
         zone_model = excluded.zone_model,
         source = 'manual',
         updated_at = now()
       RETURNING max_hr, resting_hr, lthr, zone_model, source, updated_at`,
      [req.user.id, maxHrResult.value, restingHrResult.value, lthrResult.value, zoneModel]
    );

    res.json(responseFromRow(row));
  } catch (err) {
    console.error('[hrProfile] PUT failed:', err.message);
    res.status(500).json({ error: 'Failed to save HR profile' });
  }
});

module.exports = router;
