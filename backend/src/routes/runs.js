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

  // Async: generate AI feedback and update the record
  const profile = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  generateRunFeedback(run, profile).then(feedback => {
    if (feedback) db.prepare('UPDATE runs SET ai_feedback = ? WHERE id = ?').run(feedback, id);
  }).catch(() => {});
});

router.delete('/:id', auth, (req, res) => {
  db.prepare('DELETE FROM runs WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

module.exports = router;
