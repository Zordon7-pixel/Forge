const crypto = require('crypto');
const router = require('express').Router();
const { v4: uuidv4 } = require('uuid');
const { dbGet, dbAll, dbRun, withUserMutation, withPlanningInputMutation } = require('../db');
const auth = require('../middleware/auth');
const { requirePremium } = require('../middleware/premiumGate');

// ── Oura API v2 endpoints ────────────────────────────────────────────────────
const OURA_AUTH_URL = 'https://cloud.ouraring.com/oauth/authorize';
const OURA_TOKEN_URL = 'https://api.ouraring.com/oauth/token';
const OURA_API_BASE = 'https://api.ouraring.com/v2/usercollection';
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
        CREATE TABLE IF NOT EXISTS oura_tokens (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL UNIQUE,
          encrypted_tokens TEXT NOT NULL,
          display_name TEXT,
          connected_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await dbRun(`
        CREATE TABLE IF NOT EXISTS oura_data (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          date TEXT NOT NULL,
          data_type TEXT NOT NULL,
          sleep_score INTEGER,
          total_sleep_seconds INTEGER,
          rem_sleep_seconds INTEGER,
          deep_sleep_seconds INTEGER,
          light_sleep_seconds INTEGER,
          awake_seconds INTEGER,
          sleep_efficiency INTEGER,
          sleep_latency_seconds INTEGER,
          readiness_score INTEGER,
          readiness_temperature_deviation REAL,
          readiness_hrv_balance INTEGER,
          readiness_body_temperature REAL,
          readiness_resting_heart_rate REAL,
          hrv_avg REAL,
          hrv_max REAL,
          hrv_min REAL,
          body_temperature_deviation REAL,
          raw_payload TEXT,
          synced_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      await dbRun('CREATE UNIQUE INDEX IF NOT EXISTS idx_oura_data_user_date_type ON oura_data(user_id, date, data_type)');
      await dbRun('CREATE INDEX IF NOT EXISTS idx_oura_data_user_synced ON oura_data(user_id, synced_at DESC)');
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

// ── OAuth state signing (matches Strava/WHOOP pattern) ──────────────────────
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
  if (!process.env.OURA_CLIENT_ID) missing.push('OURA_CLIENT_ID');
  if (!process.env.OURA_CLIENT_SECRET) missing.push('OURA_CLIENT_SECRET');
  if (!process.env.OURA_REDIRECT_URI) missing.push('OURA_REDIRECT_URI');
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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sendOAuthResultPage(res, { ok, title, message }) {
  const accent = ok ? '#22c55e' : '#ef4444';
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  return res.type('html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${safeTitle}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #050505; color: #f9fafb; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(88vw, 420px); text-align: center; }
    .mark { width: 64px; height: 64px; border-radius: 50%; margin: 0 auto 22px; display: grid; place-items: center; background: ${accent}; color: #050505; font-size: 34px; font-weight: 900; }
    h1 { margin: 0 0 12px; font-size: 30px; line-height: 1.1; }
    p { margin: 0 0 24px; color: #9ca3af; font-size: 16px; line-height: 1.55; }
    .return { display: inline-flex; align-items: center; justify-content: center; min-height: 48px; padding: 0 22px; border-radius: 14px; background: #f5bd02; color: #111; font-weight: 900; }
  </style>
</head>
<body>
  <main>
    <div class="mark">${ok ? '✓' : '!'}</div>
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
    <div class="return">Use Forged Hybrid / Back at top-left</div>
  </main>
</body>
</html>`);
}

async function callTokenEndpoint(params = {}) {
  const response = await fetch(OURA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (err) {
    console.error('[oura/token] failed to parse response:', err.message);
  }

  if (!response.ok) {
    const message = payload?.message || payload?.error || 'Oura token exchange failed';
    const err = new Error(String(message));
    err.status = response.status;
    throw err;
  }

  if (!payload?.access_token || !payload?.refresh_token) {
    const err = new Error('Invalid token payload from Oura');
    err.status = 502;
    throw err;
  }

  return payload;
}

async function ouraApiFetch(accessToken, path) {
  const response = await fetch(`${OURA_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  let payload = null;
  try { payload = await response.json(); } catch { payload = null; }

  if (!response.ok) {
    const err = new Error(payload?.message || 'Oura API request failed');
    err.status = response.status;
    throw err;
  }

  return payload;
}

async function getStoredTokens(userId) {
  await ensureSchema();
  const row = await dbGet('SELECT encrypted_tokens, display_name FROM oura_tokens WHERE user_id = ?', [userId]);
  if (!row?.encrypted_tokens) return null;
  const tokens = decryptJson(row.encrypted_tokens);
  return { ...tokens, display_name: row.display_name };
}

async function upsertTokens(userId, tokens, displayName, query = null) {
  await ensureSchema();
  const encrypted = encryptJson({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at,
  });
  const now = new Date().toISOString();

  const run = query?.run || dbRun;
  const updated = await run(
    'UPDATE oura_tokens SET encrypted_tokens = ?, display_name = ?, updated_at = ? WHERE user_id = ?',
    [encrypted, displayName, now, userId]
  );

  if ((updated?.changes || 0) > 0) return;

  await run(
    'INSERT INTO oura_tokens (id, user_id, encrypted_tokens, display_name, connected_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [uuidv4(), userId, encrypted, displayName, now, now]
  );
}

async function maybeRefreshToken(userId, tokens) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Number(tokens?.expires_at || 0);
  if (expiresAt > now + 60) return tokens;

  const refreshed = await callTokenEndpoint({
    client_id: process.env.OURA_CLIENT_ID,
    client_secret: process.env.OURA_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: String(tokens.refresh_token),
  });

  const nextTokens = {
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token || tokens.refresh_token,
    expires_at: refreshed.expires_at || (now + Number(refreshed.expires_in || 86400)),
  };

  await upsertTokens(userId, nextTokens, tokens.display_name);
  return { ...tokens, ...nextTokens };
}

async function getAuthenticatedTokens(userId) {
  const stored = await getStoredTokens(userId);
  if (!stored) return null;
  return maybeRefreshToken(userId, stored);
}

// ── Routes ───────────────────────────────────────────────────────────────────

// GET /oura/auth — redirect user to Oura OAuth consent screen (Premium only)
router.get('/auth', auth, requirePremium('Oura sync'), async (req, res) => {
  const missing = getMissingEnv();
  if (missing.length) return res.status(500).json({ error: `Missing env vars: ${missing.join(', ')}` });

  const deepLink = normalizeDeepLink(req.query?.deeplink);
  const state = signOAuthState({
    user_id: req.user.id,
    deeplink: deepLink,
    exp: Math.floor(Date.now() / 1000) + OAUTH_STATE_TTL_SECONDS,
  });

  const authUrl = `${OURA_AUTH_URL}?${new URLSearchParams({
    client_id: String(process.env.OURA_CLIENT_ID),
    redirect_uri: String(process.env.OURA_REDIRECT_URI),
    response_type: 'code',
    scope: 'daily personal heartrate',
    state,
  }).toString()}`;

  if (wantsJsonResponse(req)) {
    return res.json({ url: authUrl });
  }
  return res.redirect(authUrl);
});

// GET /oura/callback — handle OAuth callback from Oura
router.get('/callback', async (req, res) => {
  const missing = getMissingEnv();
  if (missing.length) return res.status(500).json({ error: `Missing env vars: ${missing.join(', ')}` });

  const statePayload = verifyOAuthState(String(req.query?.state || ''));
  if (!statePayload?.user_id) return res.status(400).json({ error: 'Invalid or expired OAuth state' });

  const deepLink = normalizeDeepLink(statePayload.deeplink);

  if (req.query?.error) {
    if (deepLink) return res.redirect(appendQueryParams(deepLink, { ok: 0, error: String(req.query.error) }));
    res.status(400);
    return sendOAuthResultPage(res, {
      ok: false,
      title: 'Oura Connection Cancelled',
      message: 'Oura was not connected. Return to Forged Hybrid whenever you are ready to try again.',
    });
  }

  const code = String(req.query?.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Missing Oura authorization code' });

  try {
    await ensureSchema();
    const tokenPayload = await callTokenEndpoint({
      client_id: process.env.OURA_CLIENT_ID,
      client_secret: process.env.OURA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: process.env.OURA_REDIRECT_URI,
    });

    const now = Math.floor(Date.now() / 1000);
    const tokens = {
      access_token: tokenPayload.access_token,
      refresh_token: tokenPayload.refresh_token,
      expires_at: tokenPayload.expires_at || (now + Number(tokenPayload.expires_in || 86400)),
    };

    // Fetch personal info for display name
    let displayName = null;
    try {
      const info = await ouraApiFetch(tokens.access_token, '/personal_info');
      displayName = info?.email || 'Oura User';
    } catch (err) {
      console.error('[oura/callback] personal info fetch failed:', err.message);
      displayName = 'Oura User';
    }

    await withUserMutation(
      statePayload.user_id,
      (tx) => upsertTokens(statePayload.user_id, tokens, displayName, tx)
    );

    if (deepLink) return res.redirect(appendQueryParams(deepLink, { ok: 1, display_name: displayName || '' }));
    return sendOAuthResultPage(res, {
      ok: true,
      title: 'Oura Connected',
      message: `${displayName || 'Your Oura account'} is connected. Tap Forged Hybrid or Back at the top-left to return; the Devices section will refresh.`,
    });
  } catch (err) {
    if (deepLink) return res.redirect(appendQueryParams(deepLink, { ok: 0, error: 'token_exchange_failed' }));
    console.error('[oura/callback] failed:', err.message);
    res.status(Number(err.status || 500));
    return sendOAuthResultPage(res, {
      ok: false,
      title: 'Oura Connection Failed',
      message: 'Forged Hybrid could not finish the Oura connection. Return to the app and try again.',
    });
  }
});

// GET /oura/status — check connection status
router.get('/status', auth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await ensureSchema();
    const row = await dbGet(
      'SELECT display_name, connected_at, updated_at FROM oura_tokens WHERE user_id = ?',
      [req.user.id]
    );

    const dataCount = await dbGet(
      'SELECT COUNT(*) as count FROM oura_data WHERE user_id = ?',
      [req.user.id]
    );

    return res.json({
      connected: Boolean(row),
      available: getMissingEnv().length === 0,
      displayName: row?.display_name || null,
      lastSync: row?.updated_at || null,
      dataCount: Number(dataCount?.count || 0),
    });
  } catch (err) {
    console.error('[oura/status] failed:', err.message);
    return res.status(500).json({ error: 'Failed to fetch Oura status' });
  }
});

// POST /oura/sync — pull sleep, readiness, and HRV data (Premium only)
router.post('/sync', auth, requirePremium('Oura sync'), async (req, res) => {
  try {
    await ensureSchema();
    const tokens = await getAuthenticatedTokens(req.user.id);
    if (!tokens) return res.status(400).json({ error: 'Oura is not connected' });

    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const endDate = new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();
    let synced = 0;
    const syncPayloads = [];

    // Sync daily sleep scores
    try {
      const sleepData = await ouraApiFetch(tokens.access_token, `/daily_sleep?start_date=${startDate}&end_date=${endDate}`);
      const records = Array.isArray(sleepData?.data) ? sleepData.data : [];

      for (const record of records) {
        const date = record?.day;
        if (!date) continue;

        const contributors = record?.contributors || {};
        syncPayloads.push({
          date,
          data_type: 'sleep',
          sleep_score: Number(record.score || 0),
          total_sleep_seconds: Number(contributors.total_sleep || 0),
          deep_sleep_seconds: Number(contributors.deep_sleep || 0),
          sleep_efficiency: Number(contributors.efficiency || 0),
          sleep_latency_seconds: Number(contributors.latency || 0),
          raw_payload: record,
        });
        synced += 1;
      }
    } catch (err) {
      console.error('[oura/sync] sleep fetch failed:', err.message);
      // Sleep fetch failed, continue
    }

    // Sync readiness scores
    try {
      const readinessData = await ouraApiFetch(tokens.access_token, `/daily_readiness?start_date=${startDate}&end_date=${endDate}`);
      const records = Array.isArray(readinessData?.data) ? readinessData.data : [];

      for (const record of records) {
        const date = record?.day;
        if (!date) continue;

        const contributors = record?.contributors || {};
        syncPayloads.push({
          date,
          data_type: 'readiness',
          readiness_score: Number(record.score || 0),
          readiness_temperature_deviation: Number(record.temperature_deviation || contributors.body_temperature || 0),
          readiness_hrv_balance: Number(contributors.hrv_balance || 0),
          readiness_resting_heart_rate: Number(contributors.resting_heart_rate || 0),
          body_temperature_deviation: Number(record.temperature_deviation || 0),
          raw_payload: record,
        });
        synced += 1;
      }
    } catch (err) {
      console.error('[oura/sync] readiness fetch failed:', err.message);
      // Readiness fetch failed, continue
    }

    // Sync heart rate / HRV
    try {
      const heartData = await ouraApiFetch(tokens.access_token, `/heartrate?start_date=${startDate}&end_date=${endDate}`);
      const records = Array.isArray(heartData?.data) ? heartData.data : [];

      // Group by date and calculate daily averages
      const dailyHrv = {};
      for (const record of records) {
        const date = String(record?.timestamp || '').slice(0, 10);
        if (!date || !record?.bpm) continue;
        if (!dailyHrv[date]) dailyHrv[date] = { sum: 0, count: 0, max: 0, min: Infinity };
        const bpm = Number(record.bpm);
        dailyHrv[date].sum += bpm;
        dailyHrv[date].count += 1;
        dailyHrv[date].max = Math.max(dailyHrv[date].max, bpm);
        dailyHrv[date].min = Math.min(dailyHrv[date].min, bpm);
      }

      for (const [date, stats] of Object.entries(dailyHrv)) {
        syncPayloads.push({
          date,
          data_type: 'heartrate',
          hrv_avg: stats.count > 0 ? stats.sum / stats.count : null,
          hrv_max: stats.max || null,
          hrv_min: stats.min < Infinity ? stats.min : null,
          raw_payload: { date, ...stats },
        });
        synced += 1;
      }
    } catch (err) {
      console.error('[oura/sync] heart rate fetch failed:', err.message);
      // Heart rate fetch failed, continue
    }

    if (syncPayloads.length) {
      await withPlanningInputMutation(req.user.id, async (tx) => {
        for (const payload of syncPayloads) await upsertOuraData(req.user.id, payload, tx);
        await tx.run('UPDATE oura_tokens SET updated_at = ? WHERE user_id = ?', [now, req.user.id]);
      });
    } else {
      await dbRun('UPDATE oura_tokens SET updated_at = ? WHERE user_id = ?', [now, req.user.id]);
    }

    return res.json({ synced });
  } catch (err) {
    console.error('[oura/sync] failed:', err.message);
    return res.status(500).json({ error: 'Oura sync failed' });
  }
});

// GET /oura/data — fetch stored Oura data
router.get('/data', auth, async (req, res) => {
  try {
    await ensureSchema();
    const dataType = req.query?.type || null;
    const limit = Math.min(Number(req.query?.limit || 30), 90);

    let query = 'SELECT * FROM oura_data WHERE user_id = ?';
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
    return res.status(500).json({ error: 'Failed to fetch Oura data' });
  }
});

// DELETE /oura/disconnect — remove Oura connection
router.delete('/disconnect', auth, async (req, res) => {
  try {
    await ensureSchema();
    await dbRun('DELETE FROM oura_tokens WHERE user_id = ?', [req.user.id]);
    return res.json({ connected: false });
  } catch {
    return res.status(500).json({ error: 'Failed to disconnect Oura' });
  }
});

// ── Data upsert helper ──────────────────────────────────────────────────────
async function upsertOuraData(userId, payload, db = { run: dbRun }) {
  const now = new Date().toISOString();

  const updated = await db.run(
    `UPDATE oura_data SET
      sleep_score = ?, total_sleep_seconds = ?, rem_sleep_seconds = ?,
      deep_sleep_seconds = ?, light_sleep_seconds = ?, awake_seconds = ?,
      sleep_efficiency = ?, sleep_latency_seconds = ?,
      readiness_score = ?, readiness_temperature_deviation = ?,
      readiness_hrv_balance = ?, readiness_body_temperature = ?,
      readiness_resting_heart_rate = ?,
      hrv_avg = ?, hrv_max = ?, hrv_min = ?,
      body_temperature_deviation = ?,
      raw_payload = ?, synced_at = ?
    WHERE user_id = ? AND date = ? AND data_type = ?`,
    [
      payload.sleep_score || null, payload.total_sleep_seconds || null, payload.rem_sleep_seconds || null,
      payload.deep_sleep_seconds || null, payload.light_sleep_seconds || null, payload.awake_seconds || null,
      payload.sleep_efficiency || null, payload.sleep_latency_seconds || null,
      payload.readiness_score || null, payload.readiness_temperature_deviation || null,
      payload.readiness_hrv_balance || null, payload.readiness_body_temperature || null,
      payload.readiness_resting_heart_rate || null,
      payload.hrv_avg || null, payload.hrv_max || null, payload.hrv_min || null,
      payload.body_temperature_deviation || null,
      JSON.stringify(payload.raw_payload || {}), now,
      userId, payload.date, payload.data_type,
    ]
  );

  if ((updated?.changes || 0) > 0) return;

  await db.run(
    `INSERT INTO oura_data (
      id, user_id, date, data_type,
      sleep_score, total_sleep_seconds, rem_sleep_seconds,
      deep_sleep_seconds, light_sleep_seconds, awake_seconds,
      sleep_efficiency, sleep_latency_seconds,
      readiness_score, readiness_temperature_deviation,
      readiness_hrv_balance, readiness_body_temperature,
      readiness_resting_heart_rate,
      hrv_avg, hrv_max, hrv_min,
      body_temperature_deviation,
      raw_payload, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuidv4(), userId, payload.date, payload.data_type,
      payload.sleep_score || null, payload.total_sleep_seconds || null, payload.rem_sleep_seconds || null,
      payload.deep_sleep_seconds || null, payload.light_sleep_seconds || null, payload.awake_seconds || null,
      payload.sleep_efficiency || null, payload.sleep_latency_seconds || null,
      payload.readiness_score || null, payload.readiness_temperature_deviation || null,
      payload.readiness_hrv_balance || null, payload.readiness_body_temperature || null,
      payload.readiness_resting_heart_rate || null,
      payload.hrv_avg || null, payload.hrv_max || null, payload.hrv_min || null,
      payload.body_temperature_deviation || null,
      JSON.stringify(payload.raw_payload || {}), now,
    ]
  );
}

module.exports = router;
