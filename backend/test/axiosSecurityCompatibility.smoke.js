// Installed Garmin HttpClient and Axios use only this loopback HTTP server.
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRequire } = require('node:module');
const axios = require('axios');
const { GarminConnect } = require('garmin-connect');
async function main() {
  assert.equal(axios.VERSION, '1.20.0');
  assert.equal(createRequire(require.resolve('garmin-connect')).resolve('axios'), require.resolve('axios'));
  const seen = []; let hanging;
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    if (req.url === '/hang') { hanging?.(); return; }
    res.writeHead(req.url === '/401' ? 401 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ activityId: 7, distance: 0 }]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const gc = new GarminConnect({ username: 'synthetic@example.invalid', password: 'not-real' });
  // UrlClass exposes getter-only endpoints; replace the synthetic instance's
  // endpoint object instead of silently assigning to its prototype getters.
  gc.url = { ACTIVITIES: `${base}/activities`, ACTIVITY: `${base}/activity/` };
  gc.client.client.defaults.proxy = false;
  gc.client.client.defaults.timeout = 1000;
  gc.client.client.interceptors.request.use(config => {
    assert.equal(new URL(config.url).origin, base, 'no real provider request'); return config;
  });
  gc.client.oauth2Token = { access_token: 'synthetic-token', expires_at: 9999999999 };
  try {
    assert.deepEqual(await gc.getActivities(0, 2), [{ activityId: 7, distance: 0 }]);
    assert.match(seen[0].url, /^\/activities\?start=0&limit=2/); assert.equal(seen[0].auth, 'Bearer synthetic-token');
    assert.deepEqual(await gc.getActivity({ activityId: 7 }), [{ activityId: 7, distance: 0 }]);
    // Exhausted retry marker tests actual rejection without authorizing OAuth IO.
    await assert.rejects(axios.get(`${base}/401`, { proxy: false }), e => e.response?.status === 401);
    // Garmin's existing handleHttpError intentionally converts AxiosError to Error.
    await assert.rejects(gc.client.get(`${base}/401`, { _retry: true }), /ERROR: \(401\), Unauthorized/);
    const controller = new AbortController(), arrived = new Promise(resolve => { hanging = resolve; });
    const rejected = assert.rejects(gc.client.get(`${base}/hang`, { signal: controller.signal }), e => axios.isCancel(e));
    await arrived; controller.abort(); await rejected;
    await assert.rejects(gc.client.get(`${base}/hang`, { timeout: 25 }), e => e.code === 'ECONNABORTED');
    console.log('Axios installed backend compatibility PASS: actual Garmin list/detail/auth/error/cancel/timeout, no external IO');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
