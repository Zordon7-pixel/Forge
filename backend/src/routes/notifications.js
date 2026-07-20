const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');
const push = require('../services/push');
const { notificationSourceFromKey } = require('../services/notifications');

function validPushSubscription(body = {}) {
  const endpoint = String(body.endpoint || '').trim();
  const p256dh = String(body.keys?.p256dh || '').trim();
  const authKey = String(body.keys?.auth || '').trim();
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:') return null;
  } catch (error) {
    return null;
  }
  if (endpoint.length > 2048 || !p256dh || p256dh.length > 1024 || !authKey || authKey.length > 512) return null;
  return { endpoint, p256dh, authKey };
}

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

router.post('/push/subscribe', auth, async (req, res) => {
  const subscription = validPushSubscription(req.body);
  if (!subscription) return res.status(400).json({ error: 'Invalid push subscription' });
  try {
    await dbRun(
      `INSERT INTO push_subscriptions (id, user_id, endpoint, keys_p256dh, keys_auth)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, endpoint) DO UPDATE SET
         keys_p256dh = EXCLUDED.keys_p256dh,
         keys_auth = EXCLUDED.keys_auth`,
      [uuidv4(), req.user.id, subscription.endpoint, subscription.p256dh, subscription.authKey]
    );
    return res.json({ subscribed: true });
  } catch (err) {
    console.error('[notifications/subscribe] failed:', err.message);
    return res.status(500).json({ error: 'Failed to enable notifications' });
  }
});

router.delete('/push/subscribe', auth, async (req, res) => {
  const endpoint = String(req.body?.endpoint || '').trim();
  if (!endpoint || endpoint.length > 2048) return res.status(400).json({ error: 'Push endpoint is required' });
  try {
    await dbRun('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [endpoint, req.user.id]);
    return res.json({ subscribed: false });
  } catch (err) {
    console.error('[notifications/unsubscribe] failed:', err.message);
    return res.status(500).json({ error: 'Failed to disable notifications' });
  }
});

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
