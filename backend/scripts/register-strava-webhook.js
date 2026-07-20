const { getWebhookVerifyToken } = require('../src/lib/stravaWebhook');

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function parseResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch (error) {
    throw new Error(`Strava returned an invalid response (${response.status})`);
  }
}

function responseDetail(payload) {
  const message = String(payload?.message || payload?.error || '').trim();
  const errors = Array.isArray(payload?.errors)
    ? payload.errors.map((error) => [error?.resource, error?.field, error?.code].filter(Boolean).join('.')).filter(Boolean)
    : [];
  return [message, ...errors].filter(Boolean).join(': ');
}

async function main() {
  const clientId = required('STRAVA_CLIENT_ID');
  const clientSecret = required('STRAVA_CLIENT_SECRET');
  const jwtSecret = required('JWT_SECRET');
  const configuredOrigin = String(process.env.APP_URL || process.env.STRAVA_REDIRECT_URI || '').trim();
  if (!configuredOrigin) throw new Error('APP_URL or STRAVA_REDIRECT_URI is required');
  const callbackUrl = new URL('/api/strava/webhook', configuredOrigin).toString();
  const listUrl = new URL('https://www.strava.com/api/v3/push_subscriptions');
  listUrl.searchParams.set('client_id', clientId);
  listUrl.searchParams.set('client_secret', clientSecret);

  const listResponse = await fetch(listUrl);
  const subscriptions = await parseResponse(listResponse);
  if (!listResponse.ok) {
    const detail = responseDetail(subscriptions);
    throw new Error(`Strava subscription lookup failed (${listResponse.status}${detail ? `: ${detail}` : ''})`);
  }
  const rows = Array.isArray(subscriptions) ? subscriptions : [];
  if (rows.some((row) => row.callback_url === callbackUrl)) {
    console.log('Strava webhook already registered for Forged Hybrid.');
    return;
  }
  if (rows.length > 0) {
    throw new Error(`Strava already has a different webhook subscription. Existing subscription id: ${rows[0].id}`);
  }

  const createResponse = await fetch('https://www.strava.com/api/v3/push_subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      callback_url: callbackUrl,
      verify_token: getWebhookVerifyToken(jwtSecret),
    }).toString(),
  });
  const result = await parseResponse(createResponse);
  if (!createResponse.ok || !result?.id) {
    const detail = responseDetail(result);
    throw new Error(`Strava webhook registration failed (${createResponse.status}${detail ? `: ${detail}` : ''})`);
  }
  console.log(`Strava webhook registered. Subscription id: ${result.id}`);
}

main().catch((error) => {
  console.error('[register-strava-webhook] failed:', error.message);
  process.exitCode = 1;
});
