const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');

router.post('/', auth, async (req, res) => {
  try {
    const { source = 'manual', content, session_id = null } = req.body || {};
    if (!content || !String(content).trim()) return res.status(400).json({ error: 'content is required' });
    const id = uuidv4();
    await dbRun('INSERT INTO journal_entries (id, user_id, source, content, session_id) VALUES (?,?,?,?,?)',
      [id, req.user.id, source, String(content).trim(), session_id]);
    const entry = await dbGet('SELECT * FROM journal_entries WHERE id=?', [id]);
    res.status(201).json({ entry });
  } catch (err) { res.status(500).json({ error: 'Failed to save journal entry' }); }
});

router.get('/', auth, async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));
    const offset = (page - 1) * limit;
    const entries = await dbAll('SELECT * FROM journal_entries WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [req.user.id, limit, offset]);
    res.json({ entries, page, limit });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch journal entries' }); }
});

module.exports = router;
