const router = require('express').Router();
const { dbAll } = require('../db');
const auth = require('../middleware/auth');
const { runActivitySql } = require('../lib/runActivity');
const {
  MAX_HISTORY_ROWS,
  MAX_ROUTE_BYTES,
  classifyTravelContext,
  validateTravelContextInput,
} = require('../lib/travelContext');

router.post('/', auth, async (req, res) => {
  const normalized = validateTravelContextInput(req.body);
  if (normalized.error) return res.status(400).json({ error: normalized.error });

  try {
    const rows = await dbAll(
      `SELECT route_coords
       FROM runs
       WHERE user_id=? AND date<? AND duration_seconds>0 AND distance_miles>0
         AND route_coords IS NOT NULL AND LENGTH(route_coords)<=? AND ${runActivitySql()}
       ORDER BY date DESC, created_at DESC
       LIMIT ?`,
      [req.user.id, normalized.value.date, MAX_ROUTE_BYTES, MAX_HISTORY_ROWS]
    );
    return res.json(classifyTravelContext(normalized.value, rows));
  } catch (error) {
    console.error('[travel-context] inference failed:', error?.message || error);
    return res.status(500).json({ error: 'Travel context is unavailable' });
  }
});

module.exports = router;
