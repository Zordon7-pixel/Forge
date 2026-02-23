const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db');
const auth = require('../middleware/auth');

router.post('/', auth, (req, res) => {
  const { source = 'manual', content, session_id = null } = req.body || {};
  if (!content || !String(content).trim()) return res.status(400).json({ error: 'content is required' });
  const id = uuidv4();
  db.prepare('INSERT INTO journal_entries (id, user_id, source, content, session_id) VALUES (?,?,?,?,?)')
    .run(id, req.user.id, source, String(content).trim(), session_id);
  const entry = db.prepare('SELECT * FROM journal_entries WHERE id=?').get(id);
  res.status(201).json({ entry });
});

router.get('/', auth, (req, res) => {
  const page = Math.max(1, Number(req.query.page || 1));
  const limit = Math.min(50, Math.max(1, Number(req.query.limit || 20)));
  const offset = (page - 1) * limit;
  const entries = db.prepare('SELECT * FROM journal_entries WHERE user_id=? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(req.user.id, limit, offset);
  res.json({ entries, page, limit });
});

module.exports = router;
