const router = require('express').Router();
const { dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');
const push = require('../services/push');
const { notificationSourceFromKey } = require('../services/notifications');

router.get('/', auth, async (req, res) => {
  try {
    const requestedLimit = Number(req.query.limit || 10);
    const limit = Number.isInteger(requestedLimit) ? Math.min(50, Math.max(1, requestedLimit)) : 10;
    const unreadOnly = String(req.query.unread || '') === '1';
    const rows = await dbAll(
      `SELECT id, type, title, body, href, source_key, read_at, created_at
       FROM user_notifications
       WHERE user_id = ?${unreadOnly ? ' AND read_at IS NULL' : ''}
       ORDER BY created_at DESC
       LIMIT ?`,
      [req.user.id, limit]
    );
    return res.json({
      notifications: rows.map(({ source_key: sourceKey, ...notification }) => ({
        ...notification,
        source: notificationSourceFromKey(sourceKey),
      })),
    });
  } catch (err) {
    console.error('[notifications/list] failed:', err.message);
    return res.status(500).json({ error: 'Failed to load notifications' });
  }
});

router.get('/push/config', auth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.json({ configured: push.isConfigured(), publicKey: push.getPublicKey() || null });
});

const setupRequired=(_req,res)=>res.set('Cache-Control','no-store').status(409).json({error:'PUSH_SETUP_REQUIRED'});
router.post('/push/subscribe',auth,setupRequired);
router.delete('/push/subscribe',auth,setupRequired);

router.patch('/:id/read', auth, async (req, res) => {
  const id = String(req.params.id || '').trim();
  if (!id || id.length > 100) return res.status(400).json({ error: 'Invalid notification id' });
  try {
    const result = await dbRun(
      'UPDATE user_notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );
    if (Number(result?.changes || 0) === 0) return res.status(404).json({ error: 'Notification not found' });
    return res.json({ read: true });
  } catch (err) {
    console.error('[notifications/read] failed:', err.message);
    return res.status(500).json({ error: 'Failed to update notification' });
  }
});

module.exports = router;
