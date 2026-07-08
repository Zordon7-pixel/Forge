const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const { dbRun, dbAll } = require('../db');
const { v4: uuidv4 } = require('uuid');

const VALID_TYPES = new Set(['bug', 'feature_request']);
const VALID_SEVERITIES = new Set(['low', 'medium', 'high']);
const VALID_CATEGORIES = new Set(['Runs', 'Lifting', 'AI Coach', 'Profile', 'Other']);
const MAX_MESSAGE_LENGTH = 4000;
const MAX_PAGE_LENGTH = 240;
const feedbackLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many feedback submissions. Try again later.' },
});

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

router.post('/', auth, feedbackLimiter, async (req, res) => {
  const body = req.body || {};
  const type = VALID_TYPES.has(body.type) ? body.type : 'bug';
  const message = cleanText(body.message, MAX_MESSAGE_LENGTH);
  const page = cleanText(body.page, MAX_PAGE_LENGTH) || null;
  const severity = type === 'bug' && VALID_SEVERITIES.has(body.severity) ? body.severity : null;
  const category = type === 'feature_request' && VALID_CATEGORIES.has(body.category) ? body.category : null;
  if (!message) return res.status(400).json({ error: 'message required' });

  try {
    // Save to PostgreSQL — works on Railway
    await dbRun(
      `INSERT INTO app_feedback (id, user_id, type, message, page, severity, category)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uuidv4(), req.user.id, type, message, page, severity, category]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('[Feedback] Error saving:', err.message);
    res.status(500).json({ error: 'Failed to save feedback' });
  }
});

// GET — retrieve all feedback (for Zordon heartbeat checks)
router.get('/', auth, async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT * FROM app_feedback WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ feedback: rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

module.exports = router;
