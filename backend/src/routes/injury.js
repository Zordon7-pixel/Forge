const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

// POST /api/injury — log a new injury entry
router.post('/', auth, (req, res) => {
  const { body_part, pain_level, notes, date } = req.body || {};
  if (!body_part || pain_level === undefined || pain_level === null) {
    return res.status(400).json({ error: 'body_part and pain_level are required' });
  }

  const id = uuidv4();
  const created_at = new Date().toISOString();
  const entryDate = date || new Date().toISOString().slice(0, 10);

  db.prepare(
    `INSERT INTO injury_logs (id, user_id, date, body_part, pain_level, notes, cleared, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(id, req.user.id, entryDate, body_part, Number(pain_level), notes || null, created_at);

  const entry = db.prepare('SELECT * FROM injury_logs WHERE id=?').get(id);
  res.status(201).json({ injury: entry });
});

// GET /api/injury — get all injury logs for authenticated user, ordered by date desc
router.get('/', auth, (req, res) => {
  const injuries = db.prepare(
    'SELECT * FROM injury_logs WHERE user_id=? ORDER BY date DESC'
  ).all(req.user.id);
  res.json({ injuries });
});

// GET /api/injury/active — returns active (not cleared) injuries for user
router.get('/active', auth, (req, res) => {
  const injuries = db.prepare(
    'SELECT * FROM injury_logs WHERE user_id=? AND cleared=0 ORDER BY date DESC'
  ).all(req.user.id);
  res.json({ injuries });
});

// PUT /api/injury/:id/clear — mark injury as cleared
router.put('/:id/clear', auth, (req, res) => {
  const injury = db.prepare(
    'SELECT * FROM injury_logs WHERE id=? AND user_id=?'
  ).get(req.params.id, req.user.id);
  if (!injury) return res.status(404).json({ error: 'Injury not found' });

  db.prepare(
    'UPDATE injury_logs SET cleared=1 WHERE id=? AND user_id=?'
  ).run(req.params.id, req.user.id);

  const updated = db.prepare('SELECT * FROM injury_logs WHERE id=?').get(req.params.id);
  res.json({ injury: updated });
});

module.exports = router;
