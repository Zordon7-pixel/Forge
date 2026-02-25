const router = require('express').Router();
const auth = require('../middleware/auth');
const { dbRun, dbAll } = require('../db');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');

router.post('/', auth, async (req, res) => {
  const { type = 'bug', message, page, severity, category } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });

  try {
    // Save to PostgreSQL — works on Railway
    await dbRun(
      `INSERT INTO app_feedback (id, user_id, type, message, page, severity, category)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uuidv4(), req.user?.id || null, type, message, page || null, severity || null, category || null]
    );

    // Also try local Control Room activity feed (works when running locally)
    try {
      const actPath = '/Users/zordon/.openclaw/workspace/second-brain/data/activity.json';
      if (fs.existsSync(actPath)) {
        const data = JSON.parse(fs.readFileSync(actPath, 'utf8'));
        data.activity.push({
          id: `act-feedback-${Date.now()}`,
          timestamp: new Date().toISOString(),
          type: 'feedback',
          icon: 'feedback',
          message: `FORGE feedback [${type}]: ${message.slice(0, 80)}`,
          detail: `Page: ${page || 'unknown'}${severity ? ` | Severity: ${severity}` : ''}${category ? ` | Category: ${category}` : ''}`
        });
        fs.writeFileSync(actPath, JSON.stringify(data, null, 2));
      }
    } catch (e) {}

    res.json({ ok: true });
  } catch (err) {
    console.error('[Feedback] Error saving:', err.message);
    res.status(500).json({ error: 'Failed to save feedback' });
  }
});

// GET — retrieve all feedback (for Zordon heartbeat checks)
router.get('/', async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT * FROM app_feedback ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ feedback: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
