const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { WAIVER_VERSION, WAIVER_TEXT } = require('../lib/waiverText');

router.get('/version', async (req, res) => {
  res.json({ version: WAIVER_VERSION });
});

router.get('/current', auth, async (req, res) => {
  try {
    const row = await dbGet(
      `SELECT id FROM user_consents
       WHERE user_id = ? AND consent_type = ? AND version = ?
       LIMIT 1`,
      [req.user.id, 'medical_waiver', WAIVER_VERSION]
    );

    res.json({ version: WAIVER_VERSION, text: WAIVER_TEXT, accepted: !!row });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch consent status' });
  }
});

router.post('/accept', auth, async (req, res) => {
  try {
    const { version } = req.body;
    if (version !== WAIVER_VERSION) {
      return res.status(400).json({ error: 'Waiver version is out of date.' });
    }

    const existing = await dbGet(
      `SELECT id FROM user_consents
       WHERE user_id = ? AND consent_type = ? AND version = ?
       LIMIT 1`,
      [req.user.id, 'medical_waiver', WAIVER_VERSION]
    );

    if (!existing) {
      await dbRun(
        `INSERT INTO user_consents (id, user_id, consent_type, version, ip)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (user_id, consent_type, version) DO NOTHING`,
        [uuidv4(), req.user.id, 'medical_waiver', WAIVER_VERSION, req.ip]
      );
    }

    res.json({ accepted: true, version: WAIVER_VERSION });
  } catch (err) {
    res.status(500).json({ error: 'Failed to accept consent' });
  }
});

module.exports = router;
