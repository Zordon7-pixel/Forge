const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const { dbAll, withTransaction } = require('../db');
const { v4: uuidv4 } = require('uuid');

const VALID_TYPES = new Set(['bug', 'feature_request']);
const VALID_SEVERITIES = new Set(['low', 'medium', 'high']);
const VALID_CATEGORIES = new Set(['Runs', 'Lifting', 'AI Coach', 'Profile', 'Other']);
const MIN_MESSAGE_LENGTH = 20;
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
  if (!VALID_TYPES.has(body.type)) return res.status(400).json({ error: 'Invalid feedback type.' });
  const type = body.type;
  const message = cleanText(body.message, MAX_MESSAGE_LENGTH);
  const page = cleanText(body.page, MAX_PAGE_LENGTH) || null;
  const severity = type === 'bug' && VALID_SEVERITIES.has(body.severity) ? body.severity : null;
  const category = type === 'feature_request' && VALID_CATEGORIES.has(body.category) ? body.category : null;
  if (message.length < MIN_MESSAGE_LENGTH) {
    return res.status(400).json({ error: `Please add more detail (at least ${MIN_MESSAGE_LENGTH} characters).` });
  }
  if (type === 'bug' && !severity) return res.status(400).json({ error: 'Invalid bug severity.' });
  if (type === 'feature_request' && !category) return res.status(400).json({ error: 'Invalid feature category.' });

  try {
    const result = await withTransaction(async (tx) => {
      const existing = await tx.get(
        `SELECT id, status FROM app_feedback
         WHERE user_id=? AND type=? AND message=? AND page IS NOT DISTINCT FROM ?
           AND created_at >= CURRENT_TIMESTAMP - INTERVAL '5 minutes'
         ORDER BY created_at DESC LIMIT 1`,
        [req.user.id, type, message, page]
      );
      if (existing) {
        return { id: existing.id, status: existing.status || 'new', duplicate: true };
      }

      const id = uuidv4();
      await tx.run(
        `INSERT INTO app_feedback (id, user_id, type, message, page, severity, category)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [id, req.user.id, type, message, page, severity, category]
      );
      return { id, status: 'new', duplicate: false };
    }, {
      userIds: [req.user.id],
      requireUserIds: [req.user.id],
      userLock: 'update',
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[feedback] save failed:', err.message);
    res.status(500).json({ error: 'Failed to save feedback' });
  }
});

// GET — retrieve only the signed-in user's feedback.
router.get('/', auth, async (req, res) => {
  try {
    const rows = await dbAll(
      `SELECT id, type, message, page, severity, category, status, created_at, updated_at
       FROM app_feedback
       WHERE user_id = ? AND type IN ('bug', 'feature_request')
       ORDER BY created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ feedback: rows });
  } catch (err) {
    console.error('[feedback] user list failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch feedback' });
  }
});

module.exports = router;
