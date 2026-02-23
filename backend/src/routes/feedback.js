const router = require('express').Router();
const auth = require('../middleware/auth');
const fs = require('fs');
const path = require('path');

router.post('/', auth, (req, res) => {
  const { type = 'bug', message, page, severity, category } = req.body || {};
  if (!message) return res.status(400).json({ error: 'message required' });

  // Log to Control Room
  try {
    const actPath = '/Users/zordon/.openclaw/workspace/second-brain/data/activity.json';
    const data = JSON.parse(fs.readFileSync(actPath, 'utf8'));
    data.activity.push({
      id: `act-feedback-${Date.now()}`,
      timestamp: new Date().toISOString(),
      type: 'feedback',
      icon: 'feedback',
      message: `FORGE feedback [${type}]: ${message.slice(0,80)}`,
      detail: `Page: ${page || 'unknown'}${severity ? ` | Severity: ${severity}` : ''}${category ? ` | Category: ${category}` : ''}`
    });
    fs.writeFileSync(actPath, JSON.stringify(data, null, 2));
  } catch(e) {}

  res.json({ ok: true });
});

module.exports = router;
