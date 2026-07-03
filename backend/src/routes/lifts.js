const router = require('express').Router();
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { requestExerciseImageIfMissing } = require('../lib/exerciseImageRequests');

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
    if (weight_lbs !== undefined && weight_lbs !== null) {
      const weight = Number(weight_lbs);
      if (!Number.isFinite(weight) || weight <= 0 || weight > 1500) {
        return res.status(400).json({ error: 'weight_lbs must be greater than 0 and no more than 1500' });
      }
    }
    if (reps !== undefined && reps !== null) {
      const repCount = Number(reps);
      if (!Number.isInteger(repCount) || repCount < 1 || repCount > 100) {
        return res.status(400).json({ error: 'reps must be an integer between 1 and 100' });
      }
    }
    if (sets !== undefined && sets !== null) {
      const setCount = Number(sets);
      if (!Number.isInteger(setCount) || setCount < 1 || setCount > 50) {
        return res.status(400).json({ error: 'sets must be an integer between 1 and 50' });
      }
    }
    const id = uuidv4();
    await dbRun(
      `INSERT INTO lifts (id, user_id, date, muscle_groups, intensity, notes, exercise_name, sets, reps, weight_lbs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.user.id, date, JSON.stringify(muscle_groups || []), intensity || 'moderate', notes || null, exercise_name || null, sets || null, reps || null, weight_lbs || null]
    );
    await requestExerciseImageIfMissing({ userId: req.user.id, exerciseName: exercise_name, source: 'lift_log' });
    const lift = await dbGet('SELECT * FROM lifts WHERE id = ?', [id]);
    res.status(201).json({ ...lift, muscle_groups: JSON.parse(lift.muscle_groups || '[]') });
  } catch (err) { res.status(500).json({ error: 'Failed to save lift' }); }
});

router.put('/:id', auth, async (req, res) => {
  try {
    const lift = await dbGet('SELECT * FROM lifts WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!lift) return res.status(404).json({ error: 'Lift not found' });
    const { exercise_name, sets, reps, weight_lbs, notes, date } = req.body;
    const updates = [];
    const params = [];
    const addUpdate = (column, value) => {
      if (value !== undefined) {
        updates.push(`${column}=?`);
        params.push(value);
      }
    };

    addUpdate('exercise_name', exercise_name);
    addUpdate('sets', sets);
    addUpdate('reps', reps);
    addUpdate('weight_lbs', weight_lbs);
    addUpdate('notes', notes);
    addUpdate('date', date);

    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    await dbRun(`UPDATE lifts SET ${updates.join(', ')} WHERE id=? AND user_id=?`, [...params, req.params.id, req.user.id]);
    await requestExerciseImageIfMissing({ userId: req.user.id, exerciseName: exercise_name, source: 'lift_update' });
    const updated = await dbGet('SELECT * FROM lifts WHERE id=?', [req.params.id]);
    res.json({ ...updated, muscle_groups: JSON.parse(updated.muscle_groups || '[]') });
  } catch (err) {
    console.error('[lifts/update] failed:', err.message);
    res.status(500).json({ error: 'Update failed' });
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    const lift = await dbGet('SELECT * FROM lifts WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!lift) return res.status(404).json({ error: 'Not found' });
    await dbRun('DELETE FROM lifts WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
});

module.exports = router;
