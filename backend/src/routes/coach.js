const router = require('express').Router();
const db     = require('../db');
const auth   = require('../middleware/auth');

// GET /warning — check if dangerous training combo exists
router.get('/warning', auth, (req, res) => {
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().split('T')[0];
  const heavyLegs = db.prepare(`
    SELECT id FROM lifts
    WHERE user_id = ? AND date >= ? AND intensity = 'heavy' AND muscle_groups LIKE '%legs%'
  `).get(req.user.id, cutoff);

  if (!heavyLegs) return res.json({ warning: false });

  res.json({
    warning: true,
    message: "You logged a heavy leg day recently. Running tempo or intervals today risks injury — your muscles haven't fully recovered. Consider an easy recovery run instead, or rest."
  });
});

// GET /feedback/:run_id — return AI feedback for a run (generate if missing)
router.get('/feedback/:run_id', auth, async (req, res) => {
  const run = db.prepare('SELECT * FROM runs WHERE id = ? AND user_id = ?').get(req.params.run_id, req.user.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  if (run.ai_feedback) return res.json({ feedback: run.ai_feedback });

  // Not generated yet — return empty (frontend polls)
  res.json({ feedback: null, pending: true });
});

module.exports = router;
