'use strict';
const { dbAll, dbGet, dbRun } = require('../db');
const transport = require('./webPushTransport');

const publicKey = process.env.VAPID_PUBLIC_KEY || '';
const privateKey = process.env.VAPID_PRIVATE_KEY || '';
const subject = process.env.VAPID_SUBJECT || 'mailto:support@forgeathlete.app';
const configured = Boolean(publicKey && privateKey);

const GENERIC_PAYLOAD = JSON.stringify({ title: 'Forge update', body: 'Open Forge to review.', url: '/' });
async function storage(operation) {
  try { return await operation(); }
  catch { throw new Error('WEB_PUSH_STORAGE_UNAVAILABLE'); }
}

function getPublicKey() {
  return publicKey;
}

function isConfigured() {
  return configured;
}

function createLegacyPushSender({ all = dbAll, get = dbGet, run = dbRun, send = transport.send,
  vapidDetails = { publicKey, privateKey, subject }, log = code => console.error('[push/send]', code) } = {}) {
  return async function sendToUser(userId) {
    if (!vapidDetails.publicKey || !vapidDetails.privateKey || !userId) return { sent: 0, skipped: true };
    const subs = await storage(() => all(`SELECT id, endpoint, keys_p256dh, keys_auth, generation
      FROM push_subscriptions WHERE user_id = ? AND active = TRUE`, [userId]));
    let sent = 0, configurationFailed = false;
    for (const sub of subs) {
      if (typeof sub.generation !== 'string' || !sub.generation) continue;
      try {
        await send({ endpoint: sub.endpoint, keys: { p256dh: sub.keys_p256dh, auth: sub.keys_auth } }, GENERIC_PAYLOAD, {
          vapidDetails,
          // Recheck after DNS, just before IO. No network is performed under DB locks.
          beforeSend: async () => Boolean(await get(`SELECT id FROM push_subscriptions
            WHERE id = ? AND user_id = ? AND generation = ? AND active = TRUE
              AND endpoint = ? AND keys_p256dh = ? AND keys_auth = ?`,
          [sub.id, userId, sub.generation, sub.endpoint, sub.keys_p256dh, sub.keys_auth])),
        });
        sent += 1;
      } catch (error) {
        if (transport.expiredEndpoint(error)) {
          await storage(() => run(`UPDATE push_subscriptions SET active = FALSE
            WHERE id = ? AND user_id = ? AND generation = ? AND active = TRUE`, [sub.id, userId, sub.generation]));
        } else {
          if (transport.configurationFailure(error)) configurationFailed = true;
          log(transport.configurationFailure(error) ? 'WEB_PUSH_CONFIGURATION_FAILED' : 'WEB_PUSH_DELIVERY_FAILED');
        }
      }
    }
    // Aggregate provider acceptance is not durable delivery or device display.
    return configurationFailed ? { sent, configurationFailed: true } : { sent };
  };
}

module.exports = { getPublicKey, isConfigured, sendToUser: createLegacyPushSender(), createLegacyPushSender };
