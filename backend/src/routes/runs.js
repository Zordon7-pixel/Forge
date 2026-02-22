const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const { generateRunFeedback } = require('../services/ai');

router.get('/', auth, (req, res) => {
  const runs = db.prepare('SELECT * FROM runs WHERE user_id = ? ORDER BY date DESC, created_at DESC LIMIT 50').all(req.user.id);
  res.json({ runs });
});

router.post('/', auth, (req, res) => {
  const { date, type, distance_miles, duration_seconds, perceived_effort, notes } = req.body;
  if (!date || !type) return res.status(400).json({ error: 'date and type required' });
  const id = uuidv4();
  db.prepare(`INSERT INTO runs (id, user_id, date, type, distance_miles, duration_seconds, perceived_effort, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, req.user.id, date, type, distance_miles || 0, duration_seconds || 0, perceived_effort || 5, notes || null
  );
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
  res.status(201).json(run);

  // Async: generate AI feedback — check limits first
  const today = new Date().toISOString().slice(0, 10);
  const month = new Date().toISOString().slice(0, 7);
  const dailyCount = db.prepare(
    "SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id = ? AND created_at >= ?"
  ).get(req.user.id, today + 'T00:00:00').cnt;
  const userRow = db.prepare("SELECT is_pro FROM users WHERE id = ?").get(req.user.id);
  const monthlyCount = !userRow?.is_pro ? db.prepare(
    "SELECT COUNT(*) as cnt FROM ai_usage WHERE user_id = ? AND created_at >= ?"
  ).get(req.user.id, month + '-01T00:00:00').cnt : 0;

  const canCallAI = dailyCount < 10 && (userRow?.is_pro || monthlyCount < 5);

  if (canCallAI) {
    db.prepare("INSERT INTO ai_usage (id, user_id, call_type) VALUES (?, ?, ?)")
      .run(uuidv4(), req.user.id, 'run_feedback');
    const profile = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    generateRunFeedback(run, profile).then(feedback => {
      if (feedback) db.prepare('UPDATE runs SET ai_feedback = ? WHERE id = ?').run(feedback, id);
    }).catch(() => {});
  }
});

router.delete('/:id', auth, (req, res) => {
  const run = db.prepare('SELECT * FROM runs WHERE id=? AND user_id=?').get(req.params.id, req.user.id);
  if (!run) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM runs WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
