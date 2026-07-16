const crypto = require('crypto');
const router = require('express').Router();

const { dbGet, dbRun, withUserMutation } = require('../db');
const auth = require('../middleware/auth');

const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize';
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token';
const STRAVA_ACTIVITIES_URL = 'https://www.strava.com/api/v3/athlete/activities';
const OAUTH_STATE_TTL_SECONDS = 10 * 60;
const ENCRYPTION_ALGO = 'aes-256-gcm';

const STRAVA_TOKEN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS strava_tokens (
  id SERIAL PRIMARY KEY,
  user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  expires_at BIGINT,
  athlete_id BIGINT,
  athlete_name TEXT,
  connected_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
)
`;

dbRun(STRAVA_TOKEN_SCHEMA_SQL)
  .catch((err) => console.error('[strava] schema init failed:', err.message));

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

function isEncryptedToken(value) {
  if (typeof value === 'string' && !value.trim().startsWith('{')) return false;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Boolean(parsed?.v === 1 && parsed?.iv && parsed?.tag && parsed?.content);
  } catch (err) {
    console.error('[strava] failed to inspect encrypted token payload:', err.message);
    return false;
  }
}

function encryptToken(value) {
  return encryptJson({ token: String(value || '') });
}

function decryptToken(value) {
  if (!value) return '';
  if (!isEncryptedToken(value)) return String(value);
  const decrypted = decryptJson(value);
  return String(decrypted?.token || '');
}

function decodeStravaTokenRow(row) {
  if (!row) return null;
  return {
    ...row,
    access_token: decryptToken(row.access_token),
    refresh_token: decryptToken(row.refresh_token),
    token_storage_encrypted: isEncryptedToken(row.access_token) && isEncryptedToken(row.refresh_token),
  };
}

function getMissingStravaEnv() {
  const missing = [];
  if (!process.env.STRAVA_CLIENT_ID) missing.push('STRAVA_CLIENT_ID');
  if (!process.env.STRAVA_CLIENT_SECRET) missing.push('STRAVA_CLIENT_SECRET');
  if (!process.env.STRAVA_REDIRECT_URI) missing.push('STRAVA_REDIRECT_URI');
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
    a { display: inline-flex; align-items: center; justify-content: center; min-height: 48px; padding: 0 22px; border-radius: 14px; background: #f5bd02; color: #111; font-weight: 900; text-decoration: none; }
  </style>
</head>
<body>
  <main>
    <div class="mark">${ok ? '✓' : '!'}</div>
    <h1>${safeTitle}</h1>
    <p>${safeMessage}</p>
    <a href="https://forge-production-773f.up.railway.app/settings">Return to Forged Hybrid</a>
  </main>
</body>
</html>`);
}

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
  } catch (err) {
    console.error('[strava] invalid OAuth state payload:', err.message);
    return null;
  }
}

function buildAthleteName(athlete = {}) {
  const first = String(athlete?.firstname || '').trim();
  const last = String(athlete?.lastname || '').trim();
  const fullName = `${first} ${last}`.trim();
  return fullName || null;
}

function toDateString(value) {
  const raw = String(value || '').trim();
  if (!raw) return new Date().toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 10);
  return parsed.toISOString().slice(0, 10);
}

function metersToMilesRounded(meters) {
  const miles = Number(meters || 0) / 1609.34;
  return Number(miles.toFixed(2));
}

async function callStravaTokenEndpoint(params = {}) {
  const response = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (err) {
    console.error('[strava] failed to parse token response:', err.message);
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.message || payload?.error || 'Strava token exchange failed';
    const err = new Error(String(message));
    err.status = response.status;
    throw err;
  }

  if (!payload?.access_token || !payload?.refresh_token) {
    const err = new Error('Invalid token payload from Strava');
    err.status = 502;
    throw err;
  }

  return payload;
}

async function fetchStravaActivities(accessToken) {
  const url = new URL(STRAVA_ACTIVITIES_URL);
  url.searchParams.set('per_page', '20');
  url.searchParams.set('access_token', String(accessToken || ''));

  const response = await fetch(url.toString());
  let payload = null;
  try {
    payload = await response.json();
  } catch (err) {
    console.error('[strava] failed to parse activities response:', err.message);
    payload = null;
  }

  if (!response.ok) {
    const message = payload?.message || payload?.error || 'Failed to fetch Strava activities';
    const err = new Error(String(message));
    err.status = response.status;
    throw err;
  }

  return Array.isArray(payload) ? payload : [];
}

async function upsertStravaTokens({ userId, accessToken, refreshToken, expiresAt, athleteId, athleteName, query = null }) {
  const run = query?.run || dbRun;
  await run(
    `INSERT INTO strava_tokens (
      user_id,
      access_token,
      refresh_token,
      expires_at,
      athlete_id,
      athlete_name,
      connected_at
    ) VALUES (?, ?, ?, ?, ?, ?, NOW())
    ON CONFLICT (user_id) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = EXCLUDED.refresh_token,
      expires_at = EXCLUDED.expires_at,
      athlete_id = EXCLUDED.athlete_id,
      athlete_name = EXCLUDED.athlete_name,
      connected_at = NOW()`,
    [
      userId,
      encryptToken(accessToken),
      encryptToken(refreshToken),
      Number(expiresAt || 0),
      athleteId ? Number(athleteId) : null,
      athleteName || null,
    ]
  );
}

async function maybeRefreshAccessToken(userId, tokens) {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Number(tokens?.expires_at || 0);
  if (expiresAt > now + 30) return tokens;

  const refreshed = await callStravaTokenEndpoint({
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: String(tokens?.refresh_token || ''),
  });

  const nextAthleteId = Number(refreshed?.athlete?.id || tokens?.athlete_id || 0) || null;
  const nextAthleteName = buildAthleteName(refreshed?.athlete) || tokens?.athlete_name || null;

  await upsertStravaTokens({
    userId,
    accessToken: String(refreshed.access_token),
    refreshToken: String(refreshed.refresh_token || tokens?.refresh_token || ''),
    expiresAt: Number(refreshed.expires_at || 0),
    athleteId: nextAthleteId,
    athleteName: nextAthleteName,
  });

  return {
    ...tokens,
    access_token: String(refreshed.access_token),
    refresh_token: String(refreshed.refresh_token || tokens?.refresh_token || ''),
    expires_at: Number(refreshed.expires_at || 0),
    athlete_id: nextAthleteId,
    athlete_name: nextAthleteName,
  };
}

router.get('/auth', auth, async (req, res) => {
  const missing = getMissingStravaEnv();
  if (missing.length) {
    return res.status(500).json({ error: `Missing env vars: ${missing.join(', ')}` });
  }

  const deepLink = normalizeDeepLink(req.query?.deeplink);
  const state = signOAuthState({
    user_id: req.user.id,
    deeplink: deepLink,
    exp: Math.floor(Date.now() / 1000) + OAUTH_STATE_TTL_SECONDS,
  });

  const authUrl = `${STRAVA_AUTH_URL}?${new URLSearchParams({
    client_id: String(process.env.STRAVA_CLIENT_ID),
    redirect_uri: String(process.env.STRAVA_REDIRECT_URI),
    response_type: 'code',
    scope: 'activity:read_all,profile:read_all',
    state,
  }).toString()}`;

  if (wantsJsonResponse(req)) {
    return res.json({ url: authUrl });
  }

  return res.redirect(authUrl);
});

router.get('/callback', async (req, res) => {
  const missing = getMissingStravaEnv();
  if (missing.length) {
    return res.status(500).json({ error: `Missing env vars: ${missing.join(', ')}` });
  }

  const statePayload = verifyOAuthState(String(req.query?.state || ''));
  if (!statePayload?.user_id) {
    return res.status(400).json({ error: 'Invalid or expired OAuth state' });
  }

  const deepLink = normalizeDeepLink(statePayload.deeplink);

  if (req.query?.error) {
    if (deepLink) {
      return res.redirect(appendQueryParams(deepLink, { ok: 0, error: String(req.query.error) }));
    }
    return res.status(400).json({ ok: false, error: String(req.query.error) });
  }

  const code = String(req.query?.code || '').trim();
  if (!code) {
    return res.status(400).json({ error: 'Missing Strava authorization code' });
  }

  try {
    const tokenPayload = await callStravaTokenEndpoint({
      client_id: process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
    });

    const athleteId = Number(tokenPayload?.athlete?.id || 0) || null;
    const athleteName = buildAthleteName(tokenPayload?.athlete);

    await withUserMutation(statePayload.user_id, (tx) => upsertStravaTokens({
      userId: statePayload.user_id,
      accessToken: String(tokenPayload.access_token),
      refreshToken: String(tokenPayload.refresh_token),
      expiresAt: Number(tokenPayload.expires_at || 0),
      athleteId,
      athleteName,
      query: tx,
    }));

    if (deepLink) {
      return res.redirect(appendQueryParams(deepLink, { ok: 1, athlete_name: athleteName || '' }));
    }

    return sendOAuthResultPage(res, {
      ok: true,
      title: 'Strava Connected',
      message: `${athleteName || 'Your Strava account'} is connected. Return to Forged Hybrid and the Devices section will refresh automatically.`,
    });
  } catch (err) {
    if (deepLink) {
      return res.redirect(appendQueryParams(deepLink, { ok: 0, error: 'token_exchange_failed' }));
    }
    return res.status(Number(err.status || 500)).type('html').send(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Strava Connection Failed</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#050505;color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <main style="width:min(88vw,420px);text-align:center">
    <h1 style="font-size:30px;margin:0 0 12px">Strava Connection Failed</h1>
    <p style="color:#9ca3af;line-height:1.55">Forged Hybrid could not finish the Strava connection. Return to Forged Hybrid and try again.</p>
    <a style="display:inline-flex;align-items:center;justify-content:center;min-height:48px;padding:0 22px;border-radius:14px;background:#f5bd02;color:#111;font-weight:900;text-decoration:none" href="https://forge-production-773f.up.railway.app/settings">Return to Forged Hybrid</a>
  </main>
</body>
</html>`);
  }
});

router.get('/status', auth, async (req, res) => {
  try {
    const row = await dbGet(
      `SELECT athlete_name, connected_at
       FROM strava_tokens
       WHERE user_id = ?`,
      [req.user.id]
    );

    return res.json({
      connected: Boolean(row),
      athlete_name: row?.athlete_name || null,
      last_sync: row?.connected_at || null,
    });
  } catch (err) {
    console.error('[strava/status] failed:', err.message);
    return res.status(500).json({ error: 'Failed to fetch Strava status' });
  }
});

router.post('/sync', auth, async (req, res) => {
  try {
    const row = await dbGet(
      `SELECT access_token, refresh_token, expires_at, athlete_id, athlete_name
       FROM strava_tokens
       WHERE user_id = ?`,
      [req.user.id]
    );
    const connected = decodeStravaTokenRow(row);

    if (!connected?.access_token || !connected?.refresh_token) {
      return res.status(400).json({ error: 'Strava not connected' });
    }
    if (!connected.token_storage_encrypted) {
      await upsertStravaTokens({
        userId: req.user.id,
        accessToken: connected.access_token,
        refreshToken: connected.refresh_token,
        expiresAt: connected.expires_at,
        athleteId: connected.athlete_id,
        athleteName: connected.athlete_name,
      });
    }

    let tokens = await maybeRefreshAccessToken(req.user.id, connected);
    let activities = [];

    try {
      activities = await fetchStravaActivities(tokens.access_token);
    } catch (err) {
      if (Number(err?.status || 0) === 401) {
        tokens = await maybeRefreshAccessToken(req.user.id, { ...tokens, expires_at: 0 });
        activities = await fetchStravaActivities(tokens.access_token);
      } else {
        throw err;
      }
    }

    const runs = activities.filter((activity) => String(activity?.type || '').toLowerCase() === 'run');
    let imported = 0;

    for (const activity of runs) {
      const activityId = String(activity?.id || '').trim();
      if (!activityId) continue;

      const runId = `strava_${req.user.id}_${activityId}`;
      const distanceMiles = metersToMilesRounded(activity?.distance);
      const durationSeconds = Math.max(0, Math.round(Number(activity?.moving_time || 0)));
      const calories = Number(activity?.calories || 0) || 0;
      const noteLabel = String(activity?.name || 'Run').trim() || 'Run';

      const insertResult = await dbRun(
        `INSERT INTO runs (
          id,
          user_id,
          date,
          type,
          distance_miles,
          duration_seconds,
          calories,
          notes,
          watch_mode,
          watch_activity_type,
          watch_normalized_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING`,
        [
          runId,
          req.user.id,
          toDateString(activity?.start_date_local || activity?.start_date),
          'easy',
          distanceMiles,
          durationSeconds,
          calories,
          `Imported from Strava: ${noteLabel}`,
          'strava',
          String(activity?.type || 'Run'),
          'strava_run',
        ]
      );

      if (Number(insertResult?.changes || 0) > 0) {
        imported += 1;
      }
    }

    await dbRun('UPDATE strava_tokens SET connected_at = NOW() WHERE user_id = ?', [req.user.id]);

    return res.json({ imported, total: runs.length });
  } catch (err) {
    console.error('[strava/sync] failed:', err.message);
    return res.status(500).json({ error: 'Failed to sync Strava activities' });
  }
});

router.delete('/disconnect', auth, async (req, res) => {
  try {
    await dbRun('DELETE FROM strava_tokens WHERE user_id = ?', [req.user.id]);
    return res.json({ connected: false });
  } catch (err) {
    console.error('[strava/disconnect] failed:', err.message);
    return res.status(500).json({ error: 'Failed to disconnect Strava' });
  }
});

module.exports = router;
