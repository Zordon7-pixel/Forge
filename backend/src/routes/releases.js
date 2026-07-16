const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const auth = require('../middleware/auth');
const { dbGet, withUserMutation } = require('../db');

const SEEN_SETTING_KEY = 'whats_new_seen_sequence';
const MAX_SEEN_SEQUENCE = 1000000;

function parseStoredSequence(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_SEEN_SEQUENCE ? parsed : 0;
}

function validateIncomingSequence(value) {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= 0
    && value <= MAX_SEEN_SEQUENCE;
}

router.get('/state', auth, async (req, res) => {
  try {
    const row = await dbGet(
      'SELECT value FROM user_settings WHERE user_id=? AND key=?',
      [req.user.id, SEEN_SETTING_KEY]
    );
    res.json({ seenSequence: parseStoredSequence(row?.value) });
  } catch (err) {
    console.error('[releases/state] read failed:', err.message);
    res.status(500).json({ error: 'Release state is unavailable' });
  }
});

router.put('/state', auth, async (req, res) => {
  const { seenSequence } = req.body || {};
  if (!validateIncomingSequence(seenSequence)) {
    return res.status(400).json({ error: 'seenSequence must be an integer from 0 to 1000000' });
  }

  try {
    const nextSequence = await withUserMutation(req.user.id, async (tx) => {
      const existing = await tx.get(
        'SELECT id, value FROM user_settings WHERE user_id=? AND key=? FOR UPDATE',
        [req.user.id, SEEN_SETTING_KEY]
      );
      const next = Math.max(parseStoredSequence(existing?.value), seenSequence);

      if (existing) {
        const result = await tx.run(
          `UPDATE user_settings
           SET value=?, updated_at=to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
           WHERE id=? AND user_id=? AND key=?`,
          [String(next), existing.id, req.user.id, SEEN_SETTING_KEY]
        );
        if (result.changes !== 1) throw new Error('Release state update lost ownership');
      } else {
        await tx.run(
          `INSERT INTO user_settings (id, user_id, key, value, updated_at)
           VALUES (?, ?, ?, ?, to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))`,
          [uuidv4(), req.user.id, SEEN_SETTING_KEY, String(next)]
        );
      }

      return next;
    });

    res.json({ seenSequence: nextSequence });
  } catch (err) {
    console.error('[releases/state] write failed:', err.message);
    res.status(500).json({ error: 'Release state could not be saved' });
  }
});

module.exports = router;
module.exports._test = {
  MAX_SEEN_SEQUENCE,
  SEEN_SETTING_KEY,
  parseStoredSequence,
  validateIncomingSequence,
};
