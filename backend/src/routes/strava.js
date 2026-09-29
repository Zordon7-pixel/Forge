const router = require('express').Router();
const rateLimit = require('express-rate-limit');

const { dbGet, withPlanningInputMutation } = require('../db');
const auth = require('../middleware/auth');
const {
  normalizeStravaRun,
  routeCoordsFromStravaStreams,
} = require('../lib/stravaActivity');
const { captureStravaConnection, persistStravaActivity } = require('../services/stravaPersistence');
const { planningInputUnchanged } = require('../lib/planningRevision');
const { getStravaProviderClient } = require('../services/stravaProviderClient');
const { getStravaConnectionService } = require('../services/stravaConnectionService');
const { getWebhookVerifyToken, normalizeWebhookEvent, verifyWebhookToken } = require('../lib/stravaWebhook');

const STRAVA_AUTH_URL = 'https://www.strava.com/oauth/authorize';
const MAX_STREAM_LOOKUPS_PER_SYNC = 3;
const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: 'Too many webhook events.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function getMissingStravaEnv() {
  const missing = [];
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
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

function requestSignal(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const close = () => { if (!res.writableFinished) abort(); cleanup(); };
  const cleanup = () => { req.removeListener('aborted', abort); res.removeListener('close', close); res.removeListener('finish', cleanup); };
  req.once('aborted', abort); res.once('close', close); res.once('finish', cleanup);
  return controller.signal;
}
async function fetchStravaActivities(accessToken, signal) {
  return getStravaProviderClient().request('activities', { accessToken }, { signal });
}
async function fetchStravaActivity(accessToken, activityId, signal) {
  return getStravaProviderClient().request('activity', { accessToken, activityId }, { signal });
}
async function fetchStravaActivityStreams(accessToken, activityId, signal) {
  return getStravaProviderClient().request('streams', { accessToken, activityId }, { signal });
}

async function hydrateMissingStravaRoutes(activities, accessToken, maxLookups = MAX_STREAM_LOOKUPS_PER_SYNC, signal) {
  const hydrated = Array.isArray(activities) ? [...activities] : [];
  let lookups = 0;
  for (let index = 0; index < hydrated.length && lookups < maxLookups; index += 1) {
    const activity = hydrated[index];
    const activityType = String(activity?.sport_type || activity?.type || '').toLowerCase();
    if (!activityType.includes('run') || activity?.trainer === true) continue;
    const normalized = normalizeStravaRun(activity);
    if (!normalized.activityId || normalized.routeCoords.length >= 2) continue;

    lookups += 1;
    try {
      const streams = await fetchStravaActivityStreams(accessToken, normalized.activityId, signal);
      const routeCoords = routeCoordsFromStravaStreams(streams, normalized.startDate);
      if (routeCoords.length >= 2) hydrated[index] = { ...activity, routeCoords };
    } catch (err) {
      // Optional enrichment never discards valid fetched core activity facts.
      console.warn('[strava/streams] optional route unavailable:', err.code || 'STRAVA_UNAVAILABLE');
      if (Number(err?.status || 0) === 429) break;
    }
  }
  return hydrated;
}

async function fetchStravaActivitiesWithRoutes(accessToken, signal) {
  const activities = await fetchStravaActivities(accessToken, signal);
  return hydrateMissingStravaRoutes(activities, accessToken, MAX_STREAM_LOOKUPS_PER_SYNC, signal);
}

async function fetchStravaActivityWithRoute(accessToken, activityId, signal) {
  const activity = await fetchStravaActivity(accessToken, activityId, signal);
  const hydrated = await hydrateMissingStravaRoutes([activity], accessToken, 1, signal);
  return hydrated[0] || activity;
}

async function syncStravaActivitiesForUser(userId, activities = [], expectedConnection) {
  const runs = activities.filter((activity) => String(activity?.type || activity?.sport_type || '').toLowerCase().includes('run'));
  const result = await withPlanningInputMutation(userId, async (tx) => {
    let imported=0,enriched=0; const runIds=[];
    for(const activity of runs) {
      const saved=await persistStravaActivity(tx,userId,activity,expectedConnection);
      imported+=saved.imported;enriched+=saved.enriched;
      if(saved.runId)runIds.push(saved.runId);
    }
    const connectionUpdate=await tx.run('UPDATE strava_tokens SET connected_at = NOW() WHERE user_id = ? AND connection_generation = ?', [userId,expectedConnection.generation]);
    if(connectionUpdate.changes!==1)throw Object.assign(new Error('Strava connection changed'),{code:'STRAVA_CONNECTION_STALE'});
    const syncResult={imported,enriched,runIds};
    return runs.length ? syncResult : planningInputUnchanged(syncResult);
  });
  return {...result,total:runs.length};
}

async function processWebhookEvent(event) {
  const row = await dbGet('SELECT user_id FROM strava_tokens WHERE athlete_id = ?', [event.ownerId]);
  if (!row) return { ignored: 'unknown_athlete' };
  const connections = getStravaConnectionService();
  let connected = await connections.connection(row.user_id);
  if (event.objectType === 'athlete' && String(event.updates?.authorized) === 'false') {
    return { disconnected: await connections.verifyRevocation(connected) };
  }
  if (event.objectType !== 'activity' || event.aspectType === 'delete') return { ignored: 'unsupported_event' };
  const expectedConnection = captureStravaConnection(row.user_id, connected.row);
  connected = await connections.refresh(connected);
  let activity;
  try { activity = await fetchStravaActivityWithRoute(connected.row.access_token, event.objectId); }
  catch (err) {
    if (Number(err?.status) !== 401) throw err;
    connected = await connections.refresh(connected, { force: true });
    activity = await fetchStravaActivityWithRoute(connected.row.access_token, event.objectId);
  }
  return syncStravaActivitiesForUser(row.user_id, [activity], expectedConnection);
}

router.get('/webhook', (req, res) => {
  const mode = String(req.query['hub.mode'] || '');
  const challenge = String(req.query['hub.challenge'] || '');
  const token = String(req.query['hub.verify_token'] || '');
  if (mode !== 'subscribe' || !challenge || !verifyWebhookToken(token)) {
    return res.status(403).json({ error: 'Webhook verification failed' });
  }
  return res.json({ 'hub.challenge': challenge });
});

router.post('/webhook', webhookLimiter, (req, res) => {
  const event = normalizeWebhookEvent(req.body);
  if (!event) return res.status(400).json({ error: 'Invalid webhook event' });
  res.status(200).json({ received: true });
  setImmediate(() => {
    processWebhookEvent(event).catch((err) => console.error('[strava/webhook] processing failed:', err.message));
  });
});

router.get('/auth', auth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const missing = getMissingStravaEnv();
  if (missing.length) return res.status(503).json({ error: 'Strava connection is unavailable' });
  const deepLink = normalizeDeepLink(req.query?.deeplink);
  if (req.query?.deeplink !== undefined && !deepLink) return res.status(400).json({ error: 'Invalid return link' });
  try {
    const state = await getStravaConnectionService().start(req.user.id, { returnLink: deepLink });
    const authUrl = `${STRAVA_AUTH_URL}?${new URLSearchParams({
      client_id: process.env.STRAVA_CLIENT_ID, redirect_uri: process.env.STRAVA_REDIRECT_URI,
      response_type: 'code', scope: 'activity:read_all,profile:read_all', state,
    }).toString()}`;
    return wantsJsonResponse(req) ? res.json({ url: authUrl }) : res.redirect(authUrl);
  } catch (err) { return res.status(err.status || 503).json({ error: 'Strava connection is unavailable', code: err.code || 'STRAVA_UNAVAILABLE' }); }
});

router.get('/callback', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const connections = getStravaConnectionService();
  let proof;
  try { proof = connections.verify(req.query?.state); }
  catch (err) { return res.status(err.code === 'STRAVA_CONFIG_UNAVAILABLE' ? 503 : 400).json({ error: 'Invalid or expired OAuth state' }); }
  const deepLink = normalizeDeepLink(proof.deeplink);
  const signal = requestSignal(req, res);
  try {
    if (req.query?.error) {
      await connections.cancel(proof);
      if (deepLink) return res.redirect(appendQueryParams(deepLink, { ok: 0, error: 'authorization_cancelled' }));
      res.status(400);
      return sendOAuthResultPage(res, { ok: false, title: 'Strava Connection Cancelled', message: 'Strava was not connected. Return to Forged Hybrid whenever you are ready to try again.' });
    }
    const code = typeof req.query?.code === 'string' ? req.query.code.trim() : '';
    if (!code) return res.status(400).json({ error: 'Missing Strava authorization code' });
    const { athleteName } = await connections.callback(proof, code, { signal });
    if (deepLink) return res.redirect(appendQueryParams(deepLink, { ok: 1, athlete_name: athleteName || '' }));
    return sendOAuthResultPage(res, { ok: true, title: 'Strava Connected',
      message: `${athleteName || 'Your Strava account'} is connected. Tap Forged Hybrid or Back at the top-left to return; the Devices section will refresh.` });
  } catch (err) {
    const stale = ['STRAVA_CONNECTION_ATTEMPT_STALE','STRAVA_CONNECTION_STALE'].includes(err.code);
    if (deepLink) return res.redirect(appendQueryParams(deepLink, { ok: 0, error: stale ? 'connection_attempt_stale' : 'token_exchange_failed' }));
    console.error('[strava/callback] failed:', err.code || 'STRAVA_UNAVAILABLE');
    res.status(err.status || 503);
    return sendOAuthResultPage(res, { ok: false, title: 'Strava Connection Failed',
      message: stale ? 'This connection attempt is no longer current. Return to Forge and start again.' : 'Forged Hybrid could not finish the Strava connection. Return to the app and try again.' });
  }
});

router.get('/status', auth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const row = await dbGet(
      `SELECT athlete_name, connected_at
       FROM strava_tokens
       WHERE user_id = ?`,
      [req.user.id]
    );

    return res.json({
      connected: Boolean(row),
      available: getMissingStravaEnv().length === 0,
      athlete_name: row?.athlete_name || null,
      last_sync: row?.connected_at || null,
    });
  } catch (err) {
    console.error('[strava/status] failed:', err.message);
    return res.status(500).json({ error: 'Failed to fetch Strava status' });
  }
});

router.post('/sync', auth, async (req, res) => {
  const signal = requestSignal(req, res);
  try {
    const connections = getStravaConnectionService();
    let connected = await connections.connection(req.user.id);
    const expectedConnection = captureStravaConnection(req.user.id, connected.row);
    connected = await connections.refresh(connected, { signal });
    let activities;
    try { activities = await fetchStravaActivitiesWithRoutes(connected.row.access_token, signal); }
    catch (err) {
      if (Number(err?.status) !== 401) throw err;
      connected = await connections.refresh(connected, { force: true, signal });
      activities = await fetchStravaActivitiesWithRoutes(connected.row.access_token, signal);
    }
    const { imported, enriched, total } = await syncStravaActivitiesForUser(req.user.id, activities, expectedConnection);
    return res.json({ imported, enriched, total });
  } catch (err) {
    console.error('[strava/sync] failed:', err.code || 'STRAVA_UNAVAILABLE');
    return res.status(err.code === 'STRAVA_NOT_CONNECTED' ? 400 : 503).json({ error: 'Failed to sync Strava activities', code: err.code || 'STRAVA_UNAVAILABLE' });
  }
});

router.delete('/disconnect', auth, async (req, res) => {
  try {
    await getStravaConnectionService().disconnect(req.user.id);
    return res.json({ connected: false });
  } catch (err) {
    console.error('[strava/disconnect] failed:', err.code || 'STRAVA_UNAVAILABLE');
    return res.status(503).json({ error: 'Failed to disconnect Strava' });
  }
});

module.exports = router;
