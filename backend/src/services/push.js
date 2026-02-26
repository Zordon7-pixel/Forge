const webpush = require('web-push');
const { dbAll, dbRun } = require('../db');

const publicKey = process.env.VAPID_PUBLIC_KEY || '';
const privateKey = process.env.VAPID_PRIVATE_KEY || '';
const subject = process.env.VAPID_SUBJECT || 'mailto:support@forgeathlete.app';
const configured = Boolean(publicKey && privateKey);

if (configured) {
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

function getPublicKey() {
  return publicKey;
}

function isConfigured() {
  return configured;
}

async function sendToUser(userId, payload = {}) {
  if (!configured || !userId) return { sent: 0, skipped: true };
  const subs = await dbAll(
    'SELECT id, endpoint, keys_p256dh, keys_auth FROM push_subscriptions WHERE user_id = ?',
    [userId]
  );
  if (!subs.length) return { sent: 0 };

  let sent = 0;
  for (const sub of subs) {
    try {
      await webpush.sendNotification({
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth },
      }, JSON.stringify(payload));
      sent += 1;
    } catch (err) {
      const code = Number(err?.statusCode || 0);
      if (code === 404 || code === 410) {
        await dbRun('DELETE FROM push_subscriptions WHERE id = ?', [sub.id]);
      }
    }
  }
  return { sent };
}

module.exports = { getPublicKey, isConfigured, sendToUser };
