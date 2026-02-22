const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

router.get('/', auth, (req, res) => {
  const lifts = db.prepare('SELECT * FROM lifts WHERE user_id = ? ORDER BY date DESC, created_at DESC LIMIT 30').all(req.user.id);
  res.json({ lifts: lifts.map(l => ({ ...l, muscle_groups: JSON.parse(l.muscle_groups || '[]') })) });
});

router.post('/', auth, (req, res) => {
  const { date, muscle_groups, intensity, notes } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });
  const id = uuidv4();
  db.prepare(`INSERT INTO lifts (id, user_id, date, muscle_groups, intensity, notes) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, req.user.id, date, JSON.stringify(muscle_groups || []), intensity || 'moderate', notes || null);
  const lift = db.prepare('SELECT * FROM lifts WHERE id = ?').get(id);
  res.status(201).json({ ...lift, muscle_groups: JSON.parse(lift.muscle_groups || '[]') });
});

router.delete('/:id', auth, (req, res) => {
  const lift = db.prepare('SELECT * FROM lifts WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!lift) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM lifts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
