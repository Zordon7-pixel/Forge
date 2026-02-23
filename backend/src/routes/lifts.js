const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

router.get('/', auth, (req, res) => {
  const lifts = db.prepare('SELECT * FROM lifts WHERE user_id = ? ORDER BY date DESC, created_at DESC LIMIT 30').all(req.user.id);
  res.json({ lifts: lifts.map(l => ({ ...l, muscle_groups: JSON.parse(l.muscle_groups || '[]') })) });
});

router.post('/', auth, (req, res) => {
  const { date, muscle_groups, intensity, notes, exercise_name, sets, reps, weight_lbs } = req.body;
  if (!date) return res.status(400).json({ error: 'date required' });
  const id = uuidv4();
  db.prepare(`INSERT INTO lifts (id, user_id, date, muscle_groups, intensity, notes, exercise_name, sets, reps, weight_lbs)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      id,
      req.user.id,
      date,
      JSON.stringify(muscle_groups || []),
      intensity || 'moderate',
      notes || null,
      exercise_name || null,
      sets || null,
      reps || null,
      weight_lbs || null
    );
  const lift = db.prepare('SELECT * FROM lifts WHERE id = ?').get(id);
  res.status(201).json({ ...lift, muscle_groups: JSON.parse(lift.muscle_groups || '[]') });
});

// PUT /api/lifts/:id — edit a lift
router.put('/:id', auth, (req, res) => {
  const lift = db.prepare('SELECT * FROM lifts WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!lift) return res.status(404).json({ error: 'Lift not found' });

  const { exercise_name, sets, reps, weight_lbs, notes, date } = req.body;

  db.prepare(`UPDATE lifts SET
    exercise_name = COALESCE(?, exercise_name),
    sets = COALESCE(?, sets),
    reps = COALESCE(?, reps),
    weight_lbs = COALESCE(?, weight_lbs),
    notes = COALESCE(?, notes),
    date = COALESCE(?, date)
    WHERE id=? AND user_id=?
  `).run(exercise_name, sets, reps, weight_lbs, notes, date, req.params.id, req.user.id);

  const updated = db.prepare('SELECT * FROM lifts WHERE id=?').get(req.params.id);
  res.json(updated);
});

router.delete('/:id', auth, (req, res) => {
  const lift = db.prepare('SELECT * FROM lifts WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!lift) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM lifts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
