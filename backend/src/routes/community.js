const router = require('express').Router();
const db = require('../db');
const auth = require('../middleware/auth');

router.get('/workouts', auth, (req, res) => {
  const sort = req.query.sort === 'popular' ? 'popular' : 'recent';
  const rows = db.prepare(`SELECT * FROM community_workouts ORDER BY ${sort === 'popular' ? 'usage_count DESC, created_at DESC' : 'created_at DESC'} LIMIT 50`).all();
  res.json({ workouts: rows.map((w) => ({
    ...w,
    warmup: JSON.parse(w.warmup_json || '[]'),
    main: JSON.parse(w.main_json || '[]'),
    recovery: JSON.parse(w.recovery_json || '[]'),
  })) });
});

router.post('/workouts/:id/use', auth, (req, res) => {
  db.prepare('UPDATE community_workouts SET usage_count = usage_count + 1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
