const { v4: uuidv4 } = require('uuid');
const { dbGet, dbRun } = require('../db');
const push = require('./push');

function cleanText(value, maxLength) {
  return String(value || '').replace(/[\r\n]+/g, ' ').trim().slice(0, maxLength);
}

function normalizeNotification(payload = {}) {
  const type = cleanText(payload.type || 'update', 40) || 'update';
  const title = cleanText(payload.title, 80);
  const body = cleanText(payload.body, 240);
  const href = cleanText(payload.href, 300) || null;
  const sourceKey = cleanText(payload.sourceKey, 180) || `notification:${uuidv4()}`;
  if (!title || !body) throw new Error('Notification title and body are required');
  return { type, title, body, href, sourceKey };
}

function notificationSourceFromKey(sourceKey) {
  const key = cleanText(sourceKey, 180).toLowerCase();
  if (key.startsWith('strava:')) return 'strava';
  if (key.startsWith('apple_health:')) return 'apple_health';
  return 'forged_hybrid';
}

async function createUserNotification(userId, payload = {}) {
  if (!userId) throw new Error('Notification user is required');
  const normalized = normalizeNotification(payload);
  const id = uuidv4();
  const insertResult = await dbRun(
    `INSERT INTO user_notifications (id, user_id, type, title, body, href, source_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, source_key) DO NOTHING`,
    [id, userId, normalized.type, normalized.title, normalized.body, normalized.href, normalized.sourceKey]
  );
  const notification = await dbGet(
    `SELECT id, type, title, body, href, source_key, read_at, created_at
     FROM user_notifications
     WHERE user_id = ? AND source_key = ?`,
    [userId, normalized.sourceKey]
  );
  const pushResult = Number(insertResult?.changes || 0) > 0
    ? await push.sendToUser(userId, {
      title: normalized.title,
      body: normalized.body,
      url: normalized.href || '/',
      notificationId: notification?.id || id,
      type: normalized.type,
      source: notificationSourceFromKey(normalized.sourceKey),
    })
    : { sent: 0, duplicate: true };
  return { notification, push: pushResult };
}

module.exports = { createUserNotification, normalizeNotification, notificationSourceFromKey };
