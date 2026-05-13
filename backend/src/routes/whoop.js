const crypto = require('crypto');
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { requirePremium } = require('../middleware/premiumGate');

// ── WHOOP API endpoints ──────────────────────────────────────────────────────
const WHOOP_AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_API_BASE = 'https://api.prod.whoop.com/developer/v1';
const OAUTH_STATE_TTL_SECONDS = 10 * 60;

// ── Encryption (matches Garmin pattern — AES-256-GCM with JWT_SECRET) ────────
const ENCRYPTION_ALGO = 'aes-256-gcm';

function getEncryptionKey() {
  return crypto.createHash('sha256').update(String(process.env.JWT_SECRET)).digest();
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
    content: encrypted.toString('base64'),
  });
}

function decryptJson(encryptedPayload) {
  const parsed = typeof encryptedPayload === 'string' ? JSON.parse(encryptedPayload) : encryptedPayload;
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGO, getEncryptionKey(), Buffer.from(parsed.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(parsed.content, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(decrypted);
}

// ── Schema ───────────────────────────────────────────────────────────────────
let schemaReady = null;

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await dbRun(`
        CREATE TABLE IF NOT EXISTS whoop_tokens (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL UNIQUE,
          encrypted_tokens TEXT NOT NULL,
          whoop_user_id TEXT,
          display_name TEXT,
          connected_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await dbRun(`
        CREATE TABLE IF NOT EXISTS whoop_data (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          date TEXT NOT NULL,
          data_type TEXT NOT NULL,
          recovery_score REAL,
          resting_heart_rate REAL,
          hrv_rmssd REAL,
          spo2_pct REAL,
          skin_temp_celsius REAL,
          strain_score REAL,
          kilojoules REAL,
          avg_heart_rate REAL,
          max_heart_rate REAL,
          sleep_performance_pct REAL,
          sleep_consistency_pct REAL,
          sleep_efficiency_pct REAL,
          total_sleep_seconds INTEGER,
          rem_sleep_seconds INTEGER,
          deep_sleep_seconds INTEGER,
          light_sleep_seconds INTEGER,
          awake_seconds INTEGER,
          raw_payload TEXT,
          synced_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await dbRun('CREATE UNIQUE INDEX IF NOT EXISTS idx_whoop_data_user_date_type ON whoop_data(user_id, date, data_type)');
      await dbRun('CREATE INDEX IF NOT EXISTS idx_whoop_data_user_synced ON whoop_data(user_id, synced_at DESC)');
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

// ── OAuth state signing (matches Strava pattern) ─────────────────────────────
function signOAuthState(payload = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = crypto
    .createHmac('sha256', String(process.env.JWT_SECRET || ''))
    .update(body)
    .digest('base64url');
  return `${body}.${signature}`;
}

function verifyOAuthState(rawState) {
  if (!rawState || typeof rawState !== 'string') return null;
  const [body, signature] = rawState.split('.');
  if (!body || !signature) return null;

  const expectedSignature = crypto
    .createHmac('sha256', String(process.env.JWT_SECRET || ''))
    .update(body)
    .digest('base64url');

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const expiresAt = Number(parsed?.exp || 0);
    const userId = String(parsed?.user_id || '');
    if (!userId || !Number.isFinite(expiresAt)) return null;
    if (expiresAt < Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function getMissingEnv() {
  const missing = [];
  if (!process.env.WHOOP_CLIENT_ID) missing.push('WHOOP_CLIENT_ID');
  if (!process.env.WHOOP_CLIENT_SECRET) missing.push('WHOOP_CLIENT_SECRET');
  if (!process.env.WHOOP_REDIRECT_URI) missing.push('WHOOP_REDIRECT_URI');
  return missing;
}

function normalizeDeepLink(value) {
  const link = String(value || '').trim();
  if (!link || link.length > 512) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(link)) return null;
  return link;
}

function wantsJsonResponse(req) {
  return String(req.query?.format || '').toLowerCase() === 'json'
    || String(req.query?.json || '') === '1';
}

function appendQueryParams(url, params = {}) {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === null || value === undefined || value === '') return;
    search.set(key, String(value));
  });
  const prefix = url.includes('?') ? '&' : '?';
  return `${url}${search.toString() ? `${prefix}${search.toString()}` : ''}`;
}

async function callTokenEndpoint(params = {}) {
  const response = await fetch(WHOOP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });

  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }

  if (!response.ok) {
    const message = payload?.message || payload?.error || 'WHOOP token exchange failed';
    const err = new Error(String(message));
    err.status = response.status;
    throw err;
  }

  if (!payload?.access_token || !payload?.refresh_token) {
    const err = new Error('Invalid token payload from WHOOP');
    err.status = 502;
    throw err;
  }

  return payload;
}

async function whoopApiFetch(accessToken, path) {
  const response = await fetch(`${WHOOP_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }

  if (!response.ok) {
    const err = new Error(payload?.message || 'WHOOP API request failed');
    err.status = response.status;
    throw err;
  }

  return payload;
}

async function getStoredTokens(userId) {
  await ensureSchema();
  const row = await dbGet('SELECT encrypted_tokens, display_name, whoop_user_id FROM whoop_tokens WHERE user_id = ?', [userId]);
  if (!row?.encrypted_tokens) return null;
  const tokens = decryptJson(row.encrypted_tokens);
  return { ...tokens, display_name: row.display_name, whoop_user_id: row.whoop_user_id };
}

async function upsertTokens(userId, tokens, displayName, whoopUserId) {
  await ensureSchema();
  const encrypted = encryptJson({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at,
  });
  const now = new Date().toISOString();

  const updated = await dbRun(
    'UPDATE whoop_tokens SET encrypted_tokens = ?, display_name = ?, whoop_user_id = ?, updated_at = ? WHERE user_id = ?',
    [encrypted, displayName, whoopUserId, now, userId]
  );

  if ((updated?.changes || 0) > 0) return;

  await dbRun(
    'INSERT INTO whoop_tokens (id, user_id, encrypted_tokens, display_name, whoop_user_id, connected_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [uuidv4(), userId, encrypted, displayName, whoopUserId, now, now]
  );
}

async function maybeRefreshToken(userId, tokens) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Number(tokens?.expires_at || 0);
  if (expiresAt > now + 60) return tokens;

  const refreshed = await callTokenEndpoint({
    client_id: process.env.WHOOP_CLIENT_ID,
    client_secret: process.env.WHOOP_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: String(tokens.refresh_token),
  });

  const nextTokens = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token || tokens.refresh_token,
    expires_at: refreshed.expires_at || (now + Number(refreshed.expires_in || 3600)),
  };

  await upsertTokens(userId, nextTokens, tokens.display_name, tokens.whoop_user_id);
  return { ...tokens, ...nextTokens };
}

async function getAuthenticatedTokens(userId) {
  const stored = await getStoredTokens(userId);
  if (!stored) return null;
  return maybeRefreshToken(userId, stored);
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /whoop/auth — redirect user to WHOOP OAuth consent screen (Premium only)
router.get('/auth', auth, requirePremium('WHOOP sync'), async (req, res) => {
  const missing = getMissingEnv();
  if (missing.length) return res.status(500).json({ error: `Missing env vars: ${missing.join(', ')}` });

  const deepLink = normalizeDeepLink(req.query?.deeplink);
  const state = signOAuthState({
    user_id: req.user.id,
    deeplink: deepLink,
    exp: Math.floor(Date.now() / 1000) + OAUTH_STATE_TTL_SECONDS,
  });

  const authUrl = `${WHOOP_AUTH_URL}?${new URLSearchParams({
    client_id: String(process.env.WHOOP_CLIENT_ID),
    redirect_uri: String(process.env.WHOOP_REDIRECT_URI),
    response_type: 'code',
    scope: 'read:recovery read:cycles read:sleep read:profile',
    state,
  }).toString()}`;

  if (wantsJsonResponse(req)) {
    return res.json({ url: authUrl });
  }
  return res.redirect(authUrl);
});

// GET /whoop/callback — handle OAuth callback from WHOOP
router.get('/callback', async (req, res) => {
  const missing = getMissingEnv();
  if (missing.length) return res.status(500).json({ error: `Missing env vars: ${missing.join(', ')}` });

  const statePayload = verifyOAuthState(String(req.query?.state || ''));
  if (!statePayload?.user_id) return res.status(400).json({ error: 'Invalid or expired OAuth state' });

  const deepLink = normalizeDeepLink(statePayload.deeplink);

  if (req.query?.error) {
    if (deepLink) return res.redirect(appendQueryParams(deepLink, { ok: 0, error: String(req.query.error) }));
    return res.status(400).json({ ok: false, error: String(req.query.error) });
  }

  const code = String(req.query?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Missing WHOOP authorization code' });

  try {
    await ensureSchema();
    const tokenPayload = await callTokenEndpoint({
      client_id: process.env.WHOOP_CLIENT_ID,
      client_secret: process.env.WHOOP_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: process.env.WHOOP_REDIRECT_URI,
    });

    const now = Math.floor(Date.now() / 1000);
    const tokens = {
      access_token: tokenPayload.access_token,
      refresh_token: tokenPayload.refresh_token,
      expires_at: tokenPayload.expires_at || (now + Number(tokenPayload.expires_in || 3600)),
    };

    // Fetch user profile for display name
    let displayName = null;
    let whoopUserId = null;
    try {
      const profile = await whoopApiFetch(tokens.access_token, '/user/profile/basic');
      displayName = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || null;
      whoopUserId = String(profile?.user_id || '');
    } catch {
      displayName = null;
    }

    await upsertTokens(statePayload.user_id, tokens, displayName, whoopUserId);

    if (deepLink) return res.redirect(appendQueryParams(deepLink, { ok: 1, display_name: displayName || '' }));
    return res.json({ ok: true, display_name: displayName });
  } catch (err) {
    if (deepLink) return res.redirect(appendQueryParams(deepLink, { ok: 0, error: 'token_exchange_failed' }));
    return res.status(Number(err.status || 500)).json({ ok: false, error: 'WHOOP callback failed' });
  }
});

// GET /whoop/status — check connection status
router.get('/status', auth, async (req, res) => {
  try {
    await ensureSchema();
    const row = await dbGet(
      'SELECT display_name, connected_at, updated_at FROM whoop_tokens WHERE user_id = ?',
      [req.user.id]
    );

    const dataCount = await dbGet(
      'SELECT COUNT(*) as count FROM whoop_data WHERE user_id = ?',
      [req.user.id]
    );

    return res.json({
      connected: Boolean(row),
      displayName: row?.display_name || null,
      lastSync: row?.updated_at || null,
      dataCount: Number(dataCount?.count || 0),
    });
  } catch {
    return res.status(500).json({ error: 'Failed to fetch WHOOP status' });
  }
});

// POST /whoop/sync — pull recovery, strain, sleep data (Premium only)
router.post('/sync', auth, requirePremium('WHOOP sync'), async (req, res) => {
  try {
    await ensureSchema();
    const tokens = await getAuthenticatedTokens(req.user.id);
    if (!tokens) return res.status(400).json({ error: 'WHOOP is not connected' });

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();
    let synced = 0;

    // Sync recovery data
    try {
      const recoveryData = await whoopApiFetch(tokens.access_token, `/recovery?start=${thirtyDaysAgo}&limit=30`);
      const records = Array.isArray(recoveryData?.records) ? recoveryData.records : [];

      for (const record of records) {
        const score = record?.score;
        if (!score) continue;
        const date = String(record?.created_at || '').slice(0, 10);
        if (!date) continue;

        await upsertWhoopData(req.user.id, {
          date,
          data_type: 'recovery',
          recovery_score: Number(score.recovery_score || 0),
          resting_heart_rate: Number(score.resting_heart_rate || 0),
          hrv_rmssd: Number(score.hrv_rmssd_milli || 0),
          spo2_pct: Number(score.spo2_percentage || 0),
          skin_temp_celsius: Number(score.skin_temp_celsius || 0),
          raw_payload: record,
        });
        synced += 1;
      }
    } catch (err) {
      console.error('[whoop/sync] recovery fetch failed:', err.message);
      // Recovery fetch failed, continue with other data types
    }

    // Sync cycle (strain) data
    try {
      const cycleData = await whoopApiFetch(tokens.access_token, `/cycle?start=${thirtyDaysAgo}&limit=30`);
      const records = Array.isArray(cycleData?.records) ? cycleData.records : [];

      for (const record of records) {
        const score = record?.score;
        if (!score) continue;
        const date = String(record?.start || record?.created_at || '').slice(0, 10);
        if (!date) continue;

        await upsertWhoopData(req.user.id, {
          date,
          data_type: 'strain',
          strain_score: Number(score.strain || 0),
          kilojoules: Number(score.kilojoule || 0),
          avg_heart_rate: Number(score.average_heart_rate || 0),
          max_heart_rate: Number(score.max_heart_rate || 0),
          raw_payload: record,
        });
        synced += 1;
      }
    } catch (err) {
      console.error('[whoop/sync] strain fetch failed:', err.message);
      // Strain fetch failed, continue
    }

    // Sync sleep data
    try {
      const sleepData = await whoopApiFetch(tokens.access_token, `/activity/sleep?start=${thirtyDaysAgo}&limit=30`);
      const records = Array.isArray(sleepData?.records) ? sleepData.records : [];

      for (const record of records) {
        const score = record?.score;
        if (!score) continue;
        const date = String(record?.start || record?.created_at || '').slice(0, 10);
        if (!date) continue;

        const stages = score?.stage_summary || {};
        await upsertWhoopData(req.user.id, {
          date,
          data_type: 'sleep',
          sleep_performance_pct: Number(score.sleep_performance_percentage || 0),
          sleep_consistency_pct: Number(score.sleep_consistency_percentage || 0),
          sleep_efficiency_pct: Number(score.sleep_efficiency_percentage || 0),
          total_sleep_seconds: Number(stages.total_in_bed_time_milli || 0) / 1000,
          rem_sleep_seconds: Number(stages.total_rem_sleep_time_milli || 0) / 1000,
          deep_sleep_seconds: Number(stages.total_slow_wave_sleep_time_milli || 0) / 1000,
          light_sleep_seconds: Number(stages.total_light_sleep_time_milli || 0) / 1000,
          awake_seconds: Number(stages.total_awake_time_milli || 0) / 1000,
          raw_payload: record,
        });
        synced += 1;
      }
    } catch (err) {
      console.error('[whoop/sync] sleep fetch failed:', err.message);
      // Sleep fetch failed, continue
    }

    // Update last sync timestamp
    await dbRun('UPDATE whoop_tokens SET updated_at = ? WHERE user_id = ?', [now, req.user.id]);

    return res.json({ synced });
  } catch {
    return res.status(500).json({ error: 'WHOOP sync failed' });
  }
});

// GET /whoop/data — fetch stored WHOOP data
router.get('/data', auth, async (req, res) => {
  try {
    await ensureSchema();
    const dataType = req.query?.type || null;
    const limit = Math.min(Number(req.query?.limit || 30), 90);

    let query = 'SELECT * FROM whoop_data WHERE user_id = ?';
    const params = [req.user.id];

    if (dataType) {
      query += ' AND data_type = ?';
      params.push(dataType);
    }

    query += ' ORDER BY date DESC LIMIT ?';
    params.push(limit);

    const rows = await dbAll(query, params);
    return res.json({ data: rows || [] });
  } catch {
    return res.status(500).json({ error: 'Failed to fetch WHOOP data' });
  }
});

// DELETE /whoop/disconnect — remove WHOOP connection
router.delete('/disconnect', auth, async (req, res) => {
  try {
    await ensureSchema();
    await dbRun('DELETE FROM whoop_tokens WHERE user_id = ?', [req.user.id]);
    return res.json({ connected: false });
  } catch {
    return res.status(500).json({ error: 'Failed to disconnect WHOOP' });
  }
});

// ── Data upsert helper ──────────────────────────────────────────────────────
async function upsertWhoopData(userId, payload) {
  const now = new Date().toISOString();

  const updated = await dbRun(
    `UPDATE whoop_data SET
      recovery_score = ?, resting_heart_rate = ?, hrv_rmssd = ?,
      spo2_pct = ?, skin_temp_celsius = ?,
      strain_score = ?, kilojoules = ?, avg_heart_rate = ?, max_heart_rate = ?,
      sleep_performance_pct = ?, sleep_consistency_pct = ?, sleep_efficiency_pct = ?,
      total_sleep_seconds = ?, rem_sleep_seconds = ?, deep_sleep_seconds = ?,
      light_sleep_seconds = ?, awake_seconds = ?,
      raw_payload = ?, synced_at = ?
    WHERE user_id = ? AND date = ? AND data_type = ?`,
    [
      payload.recovery_score || null, payload.resting_heart_rate || null, payload.hrv_rmssd || null,
      payload.spo2_pct || null, payload.skin_temp_celsius || null,
      payload.strain_score || null, payload.kilojoules || null, payload.avg_heart_rate || null, payload.max_heart_rate || null,
      payload.sleep_performance_pct || null, payload.sleep_consistency_pct || null, payload.sleep_efficiency_pct || null,
      payload.total_sleep_seconds || null, payload.rem_sleep_seconds || null, payload.deep_sleep_seconds || null,
      payload.light_sleep_seconds || null, payload.awake_seconds || null,
      JSON.stringify(payload.raw_payload || {}), now,
      userId, payload.date, payload.data_type,
    ]
  );

  if ((updated?.changes || 0) > 0) return;

  await dbRun(
    `INSERT INTO whoop_data (
      id, user_id, date, data_type,
      recovery_score, resting_heart_rate, hrv_rmssd, spo2_pct, skin_temp_celsius,
      strain_score, kilojoules, avg_heart_rate, max_heart_rate,
      sleep_performance_pct, sleep_consistency_pct, sleep_efficiency_pct,
      total_sleep_seconds, rem_sleep_seconds, deep_sleep_seconds, light_sleep_seconds, awake_seconds,
      raw_payload, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidv4(), userId, payload.date, payload.data_type,
      payload.recovery_score || null, payload.resting_heart_rate || null, payload.hrv_rmssd || null,
      payload.spo2_pct || null, payload.skin_temp_celsius || null,
      payload.strain_score || null, payload.kilojoules || null, payload.avg_heart_rate || null, payload.max_heart_rate || null,
      payload.sleep_performance_pct || null, payload.sleep_consistency_pct || null, payload.sleep_efficiency_pct || null,
      payload.total_sleep_seconds || null, payload.rem_sleep_seconds || null, payload.deep_sleep_seconds || null,
      payload.light_sleep_seconds || null, payload.awake_seconds || null,
      JSON.stringify(payload.raw_payload || {}), now,
    ]
  );
}

module.exports = router;
