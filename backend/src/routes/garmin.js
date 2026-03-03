const router = require('express').Router();
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { GarminConnect } = require('garmin-connect');
const { dbGet, dbRun } = require('../db');
const auth = require('../middleware/auth');
const watchSync = require('./watchSync');

const ENCRYPTION_ALGO = 'aes-256-gcm';
const GARMIN_SETTINGS_KEY = 'garmin_credentials';
const GARMIN_LAST_SYNC_KEY = 'garmin_last_sync';
let schemaReadyPromise = null;

function getEncryptionKey() {
  return crypto.createHash('sha256').update(String(process.env.JWT_SECRET)).digest();
}

async function ensureGarminSchema() {
  if (!schemaReadyPromise) {
    schemaReadyPromise = (async () => {
      await dbRun(`
        CREATE TABLE IF NOT EXISTS user_settings (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, key)
        )
      `);
      await dbRun('ALTER TABLE watch_sync ADD COLUMN IF NOT EXISTS garmin_activity_id TEXT');
      await dbRun('CREATE INDEX IF NOT EXISTS idx_watch_sync_user_garmin_id ON watch_sync(user_id, garmin_activity_id)');
    })().catch((err) => {
      schemaReadyPromise = null;
      throw err;
    });
  }
  return schemaReadyPromise;
}

function encryptJson(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGO, getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: authTag.toString('base64'),
    content: encrypted.toString('base64')
  });
}

function decryptJson(encryptedPayload) {
  const parsed = typeof encryptedPayload === 'string' ? JSON.parse(encryptedPayload) : encryptedPayload;
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGO, getEncryptionKey(), Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(parsed.content, 'base64')),
    decipher.final()
  ]).toString('utf8');
  return JSON.parse(decrypted);
}

async function upsertUserSetting(userId, settingKey, settingValue) {
  await ensureGarminSchema();
  const updated = await dbRun(
    'UPDATE user_settings SET value = ?, updated_at = ? WHERE user_id = ? AND key = ?',
    [settingValue, new Date().toISOString(), userId, settingKey]
  );
  if ((updated?.changes || 0) > 0) return;
  await dbRun(
    'INSERT INTO user_settings (id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)',
    [uuidv4(), userId, settingKey, settingValue, new Date().toISOString()]
  );
}

async function getUserSetting(userId, settingKey) {
  await ensureGarminSchema();
  return dbGet('SELECT value, updated_at FROM user_settings WHERE user_id = ? AND key = ?', [userId, settingKey]);
}

function mapGarminType(activity = {}) {
  const typeKey = String(activity?.activityType?.typeKey || '').toLowerCase();
  if (typeKey.includes('running') || typeKey.includes('treadmill')) return 'run';
  if (typeKey.includes('walking')) return 'walk';
  if (typeKey.includes('strength') || typeKey.includes('training')) return 'strength training';
  return typeKey || 'other';
}

function toIngestPayload(activity) {
  const distanceMiles = Number(activity.distance || 0) / 1609.34;
  const durationSeconds = Number(activity.duration || 0);
  return {
    garmin_activity_id: String(activity.activityId),
    activity_type: mapGarminType(activity),
    activity_name: activity.activityName || mapGarminType(activity),
    date: String(activity.startTimeLocal || new Date().toISOString()).slice(0, 10),
    distance_miles: Number(distanceMiles.toFixed(3)),
    duration_seconds: Math.round(durationSeconds),
    avg_pace: distanceMiles > 0 ? durationSeconds / distanceMiles : null,
    avg_heart_rate: Number(activity.averageHR || 0) || null,
    max_heart_rate: Number(activity.maxHR || 0) || null,
    calories: Number(activity.calories || 0) || null,
    cadence_spm: Number(activity.averageRunningCadenceInStepsPerMinute || 0) || null,
    elevation_gain: Number(activity.elevationGain || 0) || null,
    elevation_loss: Number(activity.elevationLoss || 0) || null,
    watch_mode: 'garmin-connect',
    raw_garmin_activity: activity
  };
}

async function loadConnectedClient(userId) {
  const row = await getUserSetting(userId, GARMIN_SETTINGS_KEY);
  if (!row?.value) return null;
  const creds = decryptJson(row.value);
  const client = new GarminConnect({ username: creds.username, password: creds.password });
  await client.login();
  return { client, displayName: creds.displayName || null };
}

router.post('/connect', auth, async (req, res) => {
  try {
    await ensureGarminSchema();
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) return res.status(400).json({ error: 'username and password are required' });

    const client = new GarminConnect({ username, password });
    await client.login();
    const profile = await client.getUserProfile();
    const displayName = profile?.displayName || profile?.fullName || profile?.userName || username;

    const encrypted = encryptJson({ username, password, displayName });
    await upsertUserSetting(req.user.id, GARMIN_SETTINGS_KEY, encrypted);
    res.json({ connected: true, displayName });
  } catch (err) {
    res.status(401).json({ error: 'Unable to connect Garmin Connect account' });
  }
});

router.post('/sync', auth, async (req, res) => {
  try {
    await ensureGarminSchema();
    const session = await loadConnectedClient(req.user.id);
    if (!session) return res.status(400).json({ error: 'Garmin is not connected' });

    const activities = await session.client.getActivities(0, 200);
    const since = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const recent = (Array.isArray(activities) ? activities : []).filter((a) => {
      const started = new Date(a.startTimeLocal || a.startTimeGMT || 0).getTime();
      return Number.isFinite(started) && started >= since;
    });

    let synced = 0;
    const imported = [];

    for (const activity of recent) {
      const garminActivityId = String(activity.activityId || '');
      if (!garminActivityId) continue;

      const existing = await dbGet(
        'SELECT id FROM watch_sync WHERE user_id = ? AND garmin_activity_id = ? LIMIT 1',
        [req.user.id, garminActivityId]
      );
      if (existing?.id) continue;

      const result = await watchSync.ingestActivity(req.user.id, toIngestPayload(activity));
      synced += 1;
      imported.push({
        id: result.id,
        garminActivityId,
        activityName: activity.activityName || result.activity_name,
        startTimeLocal: activity.startTimeLocal || null
      });
    }

    const now = new Date().toISOString();
    await upsertUserSetting(req.user.id, GARMIN_LAST_SYNC_KEY, now);
    res.json({ synced, activities: imported });
  } catch (err) {
    res.status(500).json({ error: 'Garmin sync failed' });
  }
});

router.get('/status', auth, async (req, res) => {
  try {
    await ensureGarminSchema();
    const [credentials, lastSyncRow, activityCount] = await Promise.all([
      getUserSetting(req.user.id, GARMIN_SETTINGS_KEY),
      getUserSetting(req.user.id, GARMIN_LAST_SYNC_KEY),
      dbGet('SELECT COUNT(*) as count FROM watch_sync WHERE user_id = ? AND garmin_activity_id IS NOT NULL', [req.user.id])
    ]);

    let displayName = null;
    if (credentials?.value) {
      try {
        displayName = decryptJson(credentials.value)?.displayName || null;
      } catch (err) {
        displayName = null;
      }
    }

    const fallbackLastSync = await dbGet(
      'SELECT synced_at FROM watch_sync WHERE user_id = ? AND garmin_activity_id IS NOT NULL ORDER BY synced_at DESC LIMIT 1',
      [req.user.id]
    );

    res.json({
      connected: Boolean(credentials?.value),
      lastSync: lastSyncRow?.value || fallbackLastSync?.synced_at || null,
      activityCount: Number(activityCount?.count || 0),
      displayName
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch Garmin status' });
  }
});

router.delete('/disconnect', auth, async (req, res) => {
  try {
    await ensureGarminSchema();
    await dbRun('DELETE FROM user_settings WHERE user_id = ? AND key IN (?, ?)', [
      req.user.id,
      GARMIN_SETTINGS_KEY,
      GARMIN_LAST_SYNC_KEY
    ]);
    res.json({ connected: false });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect Garmin' });
  }
});

module.exports = router;
