const router = require('express').Router();
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

router.get('/', auth, async (req, res) => {
  try {
    const lifts = await dbAll('SELECT * FROM lifts WHERE user_id = ? ORDER BY date DESC, created_at DESC LIMIT 50', [req.user.id]);
    res.json({ lifts: lifts.map(l => ({ ...l, muscle_groups: JSON.parse(l.muscle_groups || '[]') })) });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch lifts' }); }
});

router.post('/', auth, async (req, res) => {
  try {
    const { date, muscle_groups, intensity, notes, exercise_name, sets, reps, weight_lbs } = req.body;
    if (!date) return res.status(400).json({ error: 'date required' });
    const id = uuidv4();
    await dbRun(
      `INSERT INTO lifts (id, user_id, date, muscle_groups, intensity, notes, exercise_name, sets, reps, weight_lbs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.id, date, JSON.stringify(muscle_groups || []), intensity || 'moderate', notes || null, exercise_name || null, sets || null, reps || null, weight_lbs || null]
    );
    const lift = await dbGet('SELECT * FROM lifts WHERE id = ?', [id]);
    res.status(201).json({ ...lift, muscle_groups: JSON.parse(lift.muscle_groups || '[]') });
  } catch (err) { res.status(500).json({ error: 'Failed to save lift' }); }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const lift = await dbGet('SELECT * FROM lifts WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!lift) return res.status(404).json({ error: 'Lift not found' });
    const { exercise_name, sets, reps, weight_lbs, notes, date } = req.body;
    await dbRun(`UPDATE lifts SET
      exercise_name = COALESCE(?, exercise_name),
      sets = COALESCE(?, sets),
      reps = COALESCE(?, reps),
      weight_lbs = COALESCE(?, weight_lbs),
      notes = COALESCE(?, notes),
      date = COALESCE(?, date)
      WHERE id=? AND user_id=?`, [exercise_name ?? null, sets ?? null, reps ?? null, weight_lbs ?? null, notes ?? null, date ?? null, req.params.id, req.user.id]);
    const updated = await dbGet('SELECT * FROM lifts WHERE id=?', [req.params.id]);
    res.json(updated);
  } catch (err) { res.status(500).json({ error: 'Update failed' }); }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    const lift = await dbGet('SELECT * FROM lifts WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!lift) return res.status(404).json({ error: 'Not found' });
    await dbRun('DELETE FROM lifts WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
});

module.exports = router;
