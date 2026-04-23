const router = require('express').Router();
const { dbGet } = require('../db');
const auth = require('../middleware/auth');
const { generateExerciseSubstitutions } = require('../services/ai');

// GET /warning — check if dangerous training combo exists
router.get('/warning', auth, async (req, res) => {
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString().split('T')[0];
    const heavyLegs = await dbGet(
      `SELECT id FROM lifts WHERE user_id = ? AND date >= ? AND intensity = 'heavy' AND muscle_groups LIKE '%legs%'`,
      [req.user.id, cutoff]
    );

    if (!heavyLegs) return res.json({ warning: false });

    res.json({
      warning: true,
      message: "You logged a heavy leg day recently. Running tempo or intervals today risks injury — your muscles haven't fully recovered. Consider an easy recovery run instead, or rest."
    });
  } catch (err) { res.status(500).json({ error: 'Warning check failed' }); }
});

// GET /feedback/:run_id — return AI feedback for a run (generate if missing)
router.get('/feedback/:run_id', auth, async (req, res) => {
  try {
    const run = await dbGet('SELECT * FROM runs WHERE id = ? AND user_id = ?', [req.params.run_id, req.user.id]);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    if (run.ai_feedback) return res.json({ feedback: run.ai_feedback });

    // Not generated yet — return empty (frontend polls)
    res.json({ feedback: null, pending: true });
  } catch (err) { res.status(500).json({ error: 'Feedback fetch failed' }); }
});

// POST /substitute — get exercise substitution suggestions
router.post('/substitute', auth, async (req, res) => {
  try {
    const { exercise_name, reason, equipment_available } = req.body;

    if (!exercise_name || typeof exercise_name !== 'string' || !exercise_name.trim()) {
      return res.status(400).json({ error: 'exercise_name is required' });
    }
    if (exercise_name.length > 100) {
      return res.status(400).json({ error: 'exercise_name must be 100 characters or less' });
    }
    if (reason && typeof reason === 'string' && reason.length > 200) {
      return res.status(400).json({ error: 'reason must be 200 characters or less' });
    }
    if (equipment_available && typeof equipment_available === 'string' && equipment_available.length > 200) {
      return res.status(400).json({ error: 'equipment_available must be 200 characters or less' });
    }

    const result = await generateExerciseSubstitutions(
      exercise_name.trim(),
      reason || '',
      equipment_available || ''
    );

    if (!result) {
      return res.status(500).json({ error: 'Failed to generate substitutions' });
    }

    res.json(result);
  } catch (err) {
    console.error('Substitute route error:', err.message);
    res.status(500).json({ error: 'Substitution failed' });
  }
});

module.exports = router;
