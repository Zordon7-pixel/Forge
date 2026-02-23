const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const auth = require('../middleware/auth');

router.get('/workouts', auth, (req, res) => {
  const sort = req.query.sort === 'popular' ? 'popular' : 'newest';
  const target = req.query.target ? String(req.query.target).toLowerCase() : '';
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));
  const offset = (page - 1) * limit;

  const where = target ? 'WHERE lower(target) = ?' : '';
  const order = sort === 'popular' ? 'usage_count DESC, created_at DESC' : 'created_at DESC';
  const rows = target
    ? db.prepare(`SELECT * FROM community_workouts ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(target, limit, offset)
    : db.prepare(`SELECT * FROM community_workouts ORDER BY ${order} LIMIT ? OFFSET ?`).all(limit, offset);

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
});

router.post('/workouts/:id/use', auth, (req, res) => {
  db.prepare('UPDATE community_workouts SET usage_count = usage_count + 1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

router.post('/workouts/:id/save', auth, (req, res) => {
  const row = db.prepare('SELECT * FROM community_workouts WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Workout not found' });

  const id = uuidv4();
  db.prepare(`INSERT INTO saved_workouts (
    id, user_id, source_workout_id, workout_name, target, warmup_json, main_json, recovery_json, explanation, rest_notes
  ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    id,
    req.user.id,
    row.id,
    row.workout_name,
    row.target,
    row.warmup_json,
    row.main_json,
    row.recovery_json,
    row.explanation,
    row.rest_notes
  );

  db.prepare('UPDATE community_workouts SET usage_count = usage_count + 1 WHERE id=?').run(row.id);
  res.status(201).json({ id, ok: true });
});

module.exports = router;
