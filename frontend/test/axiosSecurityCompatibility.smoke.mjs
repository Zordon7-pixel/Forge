// Actual installed Axios + Forge interceptors over loopback, never a mock adapter.
import assert from 'node:assert/strict'
import http from 'node:http'
import axios from 'axios'
class Storage { values = new Map(); getItem(k) { return this.values.get(k) ?? null } setItem(k, v) { this.values.set(k, String(v)) } removeItem(k) { this.values.delete(k) } }
globalThis.localStorage = new Storage()
globalThis.window = new EventTarget()
window.localStorage = localStorage
let redirects = 0
window.location = { pathname: '/', assign(path) { assert.equal(path, '/login'); redirects++ } }
globalThis.CustomEvent ||= class extends Event { constructor(type, options) { super(type); this.detail = options?.detail } }
const token = await import('../src/lib/tokenStore.js')
const { default: api, hasPendingApiMutation } = await import('../src/lib/api.js')
const requests = [], held = new Map(), arrivals = new Map()
const server = http.createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk
  requests.push({ url: req.url, headers: req.headers, body })
  if (req.url.startsWith('/held')) { held.set(req.url, res); arrivals.get(req.url)?.(); return }
  res.writeHead(req.url.includes('401') ? 401 : 200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ ok: true, body: body ? JSON.parse(body) : null }))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
api.defaults.baseURL = `http://127.0.0.1:${server.address().port}`
api.defaults.proxy = false
api.defaults.adapter = 'http'
const waitFor = path => new Promise(resolve => arrivals.set(path, resolve))
const unauthorized = path => { held.get(path).writeHead(401, { 'Content-Type': 'application/json' }); held.get(path).end('{}') }
try {
  assert.equal(axios.VERSION, '1.20.0')
  token.setToken('synthetic-a')
  const result = await api.post('/save', { zero: 0 }, { forgeAuthSession: token.getAuthSession() })
  assert.deepEqual(result.data.body, { zero: 0 }); assert.equal(hasPendingApiMutation(), false)
  assert.equal(requests[0].headers.authorization, 'Bearer synthetic-a')
  assert.match(requests[0].headers['x-forged-local-date'], /^\d{4}-\d{2}-\d{2}$/)
  assert.match(requests[0].headers['x-forged-timezone-offset-minutes'], /^-?\d+$/)
  const stale = token.getAuthSession(); token.setToken('synthetic-b'); const count = requests.length
  await assert.rejects(api.post('/never', {}, { forgeAuthSession: stale }), e => axios.isCancel(e))
  assert.equal(requests.length, count); assert.equal(hasPendingApiMutation(), false)
  for (const sameAccount of [false, true]) {
    token.setToken('synthetic-a'); const session = token.getAuthSession(), path = `/held401-${sameAccount}`
    const arrived = waitFor(path)
    const checked = assert.rejects(api.post(path, {}, { forgeAuthSession: session }), e => e.response?.status === 401)
    await arrived; assert.equal(hasPendingApiMutation(), true)
    if (sameAccount) { token.clearToken(); token.setToken('synthetic-a') } else token.setToken('synthetic-b')
    unauthorized(path); await checked
    assert.equal(token.getToken(), sameAccount ? 'synthetic-a' : 'synthetic-b'); assert.equal(redirects, 0)
    assert.equal(hasPendingApiMutation(), false)
  }
  const arrived = waitFor('/held-cancel'), controller = new AbortController()
  const cancelled = assert.rejects(api.post('/held-cancel', {}, { signal: controller.signal, forgeAuthSession: token.getAuthSession() }), e => axios.isCancel(e))
  await arrived; controller.abort(); await cancelled; assert.equal(hasPendingApiMutation(), false)
  await assert.rejects(api.get('/held-timeout', { timeout: 30 }), e => e.code === 'ECONNABORTED')
  await assert.rejects(api.post('/auth/login401', {}), e => e.response?.status === 401)
  assert.ok(token.getToken()); assert.equal(redirects, 0)
  await assert.rejects(api.get('/401', { forgeAuthSession: token.getAuthSession() }), e => e.response?.status === 401)
  assert.equal(token.getToken(), null); assert.equal(redirects, 1); assert.equal(hasPendingApiMutation(), false)
  console.log('Axios installed frontend compatibility PASS: HTTP auth, JSON/zero, cancellation, timeout, mutation settlement, stale401 and relogin fencing')
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
