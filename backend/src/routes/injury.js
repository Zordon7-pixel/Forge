const router = require('express').Router();
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// POST /api/injury — log a new injury entry
router.post('/', auth, async (req, res) => {
  try {
    const { body_part, pain_level, notes, date } = req.body || {};
    if (!body_part || pain_level === undefined || pain_level === null) {
      return res.status(400).json({ error: 'body_part and pain_level are required' });
    }
    const id = uuidv4();
    const created_at = new Date().toISOString();
    const entryDate = date || new Date().toISOString().slice(0, 10);
    await dbRun(
      `INSERT INTO injury_logs (id, user_id, date, body_part, pain_level, notes, cleared, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      [id, req.user.id, entryDate, body_part, Number(pain_level), notes || null, created_at]
    );
    const entry = await dbGet('SELECT * FROM injury_logs WHERE id=?', [id]);
    res.status(201).json({ injury: entry });
  } catch (err) { res.status(500).json({ error: 'Failed to log injury' }); }
});

// GET /api/injury — get all injury logs for authenticated user, ordered by date desc
router.get('/', auth, async (req, res) => {
  try {
    const injuries = await dbAll('SELECT * FROM injury_logs WHERE user_id=? ORDER BY date DESC', [req.user.id]);
    res.json({ injuries });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch injuries' }); }
});

// GET /api/injury/active — returns active (not cleared) injuries for user
router.get('/active', auth, async (req, res) => {
  try {
    const injuries = await dbAll('SELECT * FROM injury_logs WHERE user_id=? AND cleared=0 ORDER BY date DESC', [req.user.id]);
    res.json({ injuries });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch active injuries' }); }
});

const resolveActiveInjuriesForUser = async (userId) => {
  const countRow = await dbGet('SELECT COUNT(*) AS count FROM injury_logs WHERE user_id=? AND cleared=0', [userId]);
  const clearedCount = Number(countRow?.count || 0);
  await dbRun('UPDATE injury_logs SET cleared=1 WHERE user_id=? AND cleared=0', [userId]);
  return clearedCount;
};

// DELETE /api/injury/active — clear all active injuries for authenticated user
router.delete('/active', auth, async (req, res) => {
  try {
    const cleared = await resolveActiveInjuriesForUser(req.user.id);
    res.json({ ok: true, cleared });
  } catch (err) { res.status(500).json({ error: 'Failed to clear active injuries' }); }
});

// POST /api/injury/resolve — alias for clearing all active injuries
router.post('/resolve', auth, async (req, res) => {
  try {
    const cleared = await resolveActiveInjuriesForUser(req.user.id);
    res.json({ ok: true, cleared });
  } catch (err) { res.status(500).json({ error: 'Failed to resolve injuries' }); }
});

// PUT /api/injury/:id/clear — mark injury as cleared
router.put('/:id/clear', auth, async (req, res) => {
  try {
    const injury = await dbGet('SELECT * FROM injury_logs WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!injury) return res.status(404).json({ error: 'Injury not found' });
    await dbRun('UPDATE injury_logs SET cleared=1 WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    const updated = await dbGet('SELECT * FROM injury_logs WHERE id=?', [req.params.id]);
    res.json({ injury: updated });
  } catch (err) { res.status(500).json({ error: 'Failed to clear injury' }); }
});

module.exports = router;
