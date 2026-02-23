const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');

router.get('/workouts', auth, async (req, res) => {
  try {
    const sort = req.query.sort === 'popular' ? 'popular' : 'newest';
    const target = req.query.target ? String(req.query.target).toLowerCase() : '';
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));
    const offset = (page - 1) * limit;

    const order = sort === 'popular' ? 'usage_count DESC, created_at DESC' : 'created_at DESC';
    const rows = target
      ? await dbAll(`SELECT * FROM community_workouts WHERE lower(target) = ? ORDER BY ${order} LIMIT ? OFFSET ?`, [target, limit, offset])
      : await dbAll(`SELECT * FROM community_workouts ORDER BY ${order} LIMIT ? OFFSET ?`, [limit, offset]);

    res.json({
      workouts: rows.map((w) => ({
        ...w,
        warmup: JSON.parse(w.warmup_json || '[]'),
        main: JSON.parse(w.main_json || '[]'),
        recovery: JSON.parse(w.recovery_json || '[]'),
      })),
      page,
      limit,
    });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch community workouts' }); }
});

router.post('/workouts/:id/use', auth, async (req, res) => {
  try {
    await dbRun('UPDATE community_workouts SET usage_count = usage_count + 1 WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Failed to update usage count' }); }
});

router.post('/workouts/:id/save', auth, async (req, res) => {
  try {
    const row = await dbGet('SELECT * FROM community_workouts WHERE id=?', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Workout not found' });

    const id = uuidv4();
    await dbRun(`INSERT INTO saved_workouts (
      id, user_id, source_workout_id, workout_name, target, warmup_json, main_json, recovery_json, explanation, rest_notes
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`, [
      id, req.user.id, row.id, row.workout_name, row.target,
      row.warmup_json, row.main_json, row.recovery_json, row.explanation, row.rest_notes
    ]);

    await dbRun('UPDATE community_workouts SET usage_count = usage_count + 1 WHERE id=?', [row.id]);
    res.status(201).json({ id, ok: true });
  } catch (err) { res.status(500).json({ error: 'Failed to save workout' }); }
});

router.get('/saved', auth, async (req, res) => {
  try {
    const rows = await dbAll('SELECT * FROM saved_workouts WHERE user_id=? ORDER BY created_at DESC', [req.user.id]);
    res.json({
      workouts: rows.map(w => ({
        ...w,
        warmup: JSON.parse(w.warmup_json || '[]'),
        main: JSON.parse(w.main_json || '[]'),
        recovery: JSON.parse(w.recovery_json || '[]')
      }))
    });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch saved workouts' }); }
});

router.delete('/saved/:id', auth, async (req, res) => {
  try {
    const row = await dbGet('SELECT * FROM saved_workouts WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    await dbRun('DELETE FROM saved_workouts WHERE id=?', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: 'Delete failed' }); }
});

module.exports = router;
