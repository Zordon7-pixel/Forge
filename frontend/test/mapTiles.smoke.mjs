// Offline Phase 1 gate: real map consumers + Leaflet in Chromium, synthetic API.
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import vm from 'node:vm'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium, expect } from '@playwright/test'

const root = fileURLToPath(new URL('..', import.meta.url))
const repo = path.dirname(root)
const key = 'SyntheticTileKey' + '0'.repeat(16)
assert.equal(key.length, 32)
const sentinel = `ORS-${randomUUID()}`
const read = p => readFileSync(path.join(repo, p), 'utf8')
const consumers = ['frontend/src/pages/ActiveRun.jsx', 'frontend/src/components/RoutePlanner.jsx',
  'frontend/src/components/RunDetailModal.jsx', 'frontend/src/components/maps/RoutePreviewMap.jsx']
function walk(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]) }
const build = spawnSync('npm', ['--prefix', 'frontend', 'run', 'build'], { cwd: repo, encoding: 'utf8',
  env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || '/tmp', ORS_API_KEY: sentinel, OPENROUTESERVICE_API_KEY: sentinel } })
assert.equal(build.status, 0, 'No-tile-key build with synthetic server credentials must succeed')
console.log('PASS npm --prefix frontend run build (exit 0, no tile key, synthetic ORS sentinels)')
console.log(build.stdout.trim().split('\n').at(-1))
const oldHost = ['tile', 'openstreetmap', 'org'].join('.')
for (const dir of ['frontend/src', 'backend/src', 'frontend/dist']) {
  for (const file of walk(path.join(repo, dir))) {
    const content = readFileSync(file)
    if (dir === 'frontend/src') assert.equal(content.includes(['VITE', 'THUNDERFOREST_API_KEY'].join('_')), false, 'No build-time tile credential')
    assert.equal(content.includes(oldHost), false, `Old tile source in ${file}`)
    assert.equal(content.includes(sentinel), false, `Server sentinel in ${file}`)
    if (dir.endsWith('dist')) assert.equal(content.includes(key), false, `Baked tile key in ${file}`)
  }
}
const direct = walk(path.join(root, 'src')).filter(f => /\.(js|jsx)$/.test(f) && /\b(?:TileLayer|MapContainer|tileLayer)\b/.test(readFileSync(f, 'utf8')))
assert.deepEqual(direct.map(f => path.relative(repo, f)), ['frontend/src/components/maps/ForgeMap.jsx'])
for (const file of consumers) assert.match(read(file), /<ForgeMap[\s\S]*<\/ForgeMap>/)
assert.match(read('backend/src/app.js'), /imgSrc:.*https:\/\/api\.thunderforest\.com/)
assert.match(read('backend/src/app.js'), /app\.use\('\/api\/meta',\s*require\('\.\/routes\/meta'\)\)/)

// Execute the real endpoint registration/handler with an unreadable env except
// for the intentionally exposed property. No dotenv, DB or actual env access.
let handler, guarded
const auth = Symbol('existing authentication middleware')
const router = { get(route, ...handlers) { if (route === '/map-tiles') { [guarded, handler] = handlers } } }
let configKey
const env = new Proxy({}, { get(_target, prop) {
  assert.equal(prop, 'THUNDERFOREST_API_KEY', 'Endpoint read an unrelated environment value')
  return configKey
} })
vm.runInNewContext(read('backend/src/routes/meta.js'), { process: { env }, module: {}, require(id) {
  if (id === 'express') return { Router: () => router }
  if (id === '../middleware/auth') return auth
  if (id === './diagnostics') return { requireDiagnosticsAdmin() {} }
  if (id === '../../package.json') return { version: 'synthetic' }
  throw new Error('Unexpected endpoint dependency')
} })
assert.equal(guarded, auth)
const invalid = [undefined, null, '', ' ', ` ${key}`, `${key} `, `${key}\n`, `${key}\r\n`, 'short', 'x'.repeat(33), 'x'.repeat(31) + '/', 123, {}, []]
for (const value of [key, ...invalid]) {
  configKey = value
  const headers = {}; let payload
  handler({}, { set(k, v) { headers[k] = v }, json(data) { payload = JSON.parse(JSON.stringify(data)) } })
  assert.deepEqual(payload, { THUNDERFOREST_API_KEY: value === key ? key : null })
  assert.equal(headers['Cache-Control'], 'no-store')
  assert.equal(JSON.stringify(payload).includes(sentinel), false)
}
// Real service worker must not intercept, fetch or cache provider tiles.
const events = {}
vm.runInNewContext(read('frontend/public/sw.js'), { URL, self: { addEventListener(name, fn) { events[name] = fn } } })
for (const suffix of ['?apikey=' + key, '?apikey=invalid']) {
  events.fetch({ request: { url: 'https://api.thunderforest.com/outdoors/1/0/0.png' + suffix }, respondWith() { assert.fail('Provider tile intercepted by service worker') } })
}
console.log('PASS inventory, source/build leakage, allowlisted runtime endpoint, service worker bypass')

const artifactDir = path.join(root, 'test-results/map-tiles')
mkdirSync(artifactDir, { recursive: true })
const coords = [[40, -73], [40.001, -73.001], [40.002, -73]]
const planned = [[40, -73], [40.003, -73.002]]
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { UnitsProvider } from '/src/context/UnitsContext.jsx';
import ActiveRun from '/src/pages/ActiveRun.jsx';
import RoutePlanner from '/src/components/RoutePlanner.jsx';
import RunDetailModal from '/src/components/RunDetailModal.jsx';
import RoutePreviewMap from '/src/components/maps/RoutePreviewMap.jsx';
import { tileUrl } from '/src/components/maps/ForgeMap.jsx';
import '/src/index.css';
import 'leaflet/dist/leaflet.css';
const coords = ${JSON.stringify(coords)}, planned = ${JSON.stringify(planned)};
const root = createRoot(document.getElementById('root'));
window.tileUrl = tileUrl;
window.mount = (kind, recording = false) => {
  localStorage.removeItem('forged_hybrid_active_run_v1');
  localStorage.removeItem('forge_active_run_map_layout_v1');
  const navigationState = { plannedRoute: { coordinates: planned }, countdown: 0 };
  if (recording) localStorage.setItem('forged_hybrid_active_run_v1', JSON.stringify({
    ownerUserId: 'tile-test', phase: 'running', startedAt: Date.now() - 42000, savedAt: Date.now(), elapsed: 42,
    distanceMiles: 0.2, routeCoords: coords, mapMyRun: true, gpsStarted: true, gpsAvailable: true,
    clientRunId: 'canonical-tile-test', navigationState,
  }));
  const component = kind === 'ActiveRun' ? React.createElement(ActiveRun)
    : kind === 'RoutePlanner' ? React.createElement(RoutePlanner, { workout: { distanceMiles: 4 }, initialExpanded: true, onStart: route => window.startedRoute = route })
    : kind === 'RunDetailModal' ? React.createElement(RunDetailModal, { run: { id: 'tile-run', date: '2026-10-20', distance_miles: 4, duration_seconds: 2400, route_coords: coords }, activePanel: 'route', onClose() {} })
    : React.createElement(RoutePreviewMap, { route: { coordinates: planned } });
  root.render(React.createElement(MemoryRouter, { key: Math.random(), initialEntries: [{ pathname: '/active-run', state: navigationState }] }, React.createElement(UnitsProvider, null, component)));
};
`
process.chdir(root)
const server = await createServer({ root, configFile: false, envDir: path.join(artifactDir, 'no-env'), cacheDir: path.join(artifactDir, 'vite-cache'),
  optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react-router', 'react-leaflet', 'leaflet', 'lucide-react', 'axios', '@capacitor/core', '@capacitor/app', 'recharts'] },
  plugins: [react({ exclude: /node_modules|test-results/ }), {
    name: 'tile-harness', configureServer(s) { s.middlewares.use(async (req, res, next) => {
      if (req.url !== '/tile-test') return next()
      res.setHeader('Content-Type', 'text/html')
      res.end(await s.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module" src="/tile-entry.jsx"></script></body></html>'))
    }) }, resolveId(id) { if (id === '/tile-entry.jsx') return id }, load(id) { if (id === '/tile-entry.jsx') return entry },
  }], server: { host: '127.0.0.1', port: 0 } })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined })
  const context = await browser.newContext({ viewport: { width: 320, height: 568 }, serviceWorkers: 'block' })
  const page = await context.newPage()
  let config = { THUNDERFOREST_API_KEY: key }, configStatus = 200, tileFailure = false, tileRequests = [], configReads = 0, totalTiles = 0
  const errors = [], external = [], consoleMessages = []
  page.on('pageerror', err => errors.push(err.stack || err.message))
  page.on('console', msg => consoleMessages.push(msg.text()))
  await page.addInitScript(() => {
    localStorage.setItem('forge_token', 'synthetic.' + btoa(JSON.stringify({ id: 'tile-test', exp: 9999999999 })) + '.synthetic')
    window.watchStarts = 0; window.watchStops = 0
    navigator.geolocation.getCurrentPosition = success => success({ coords: { latitude: 40, longitude: -73, accuracy: 5 }, timestamp: Date.now() })
    navigator.geolocation.watchPosition = () => { window.watchStarts++; return 1 }
    navigator.geolocation.clearWatch = () => { window.watchStops++ }
  })
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin === 'https://api.thunderforest.com') {
      tileRequests.push(url); totalTiles++
      if (tileFailure) return route.abort()
      return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=', 'base64') })
    }
    if (url.hostname !== '127.0.0.1') { external.push(url.origin); return route.abort() }
    if (url.pathname === '/api/meta/map-tiles') { configReads++; return route.fulfill({ status: configStatus, json: config }) }
    if (url.pathname === '/api/routes/generate') return route.fulfill({ json: { route: { coordinates: planned, distanceMiles: 4, elevationPreference: 'flat' } } })
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { user: { id: 'tile-test' }, zones: [], units: 'imperial' } })
    return route.continue()
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/tile-test`)
  await page.waitForFunction(() => typeof window.mount === 'function')
  for (const value of invalid) assert.equal(await page.evaluate(value => window.tileUrl({ THUNDERFOREST_API_KEY: value }), value ?? null), null)
  assert.equal(await page.evaluate(config => window.tileUrl(config), { THUNDERFOREST_API_KEY: key, host: 'https://invalid.test', style: 'other' }), `https://api.thunderforest.com/outdoors/{z}/{x}/{y}.png?apikey=${key}`)
  async function mount(kind, recording = false) {
    const before = configReads
    await page.evaluate(({ kind, recording }) => window.mount(kind, recording), { kind, recording })
    if (kind === 'RoutePlanner') await page.getByRole('button', { name: 'Generate route', exact: true }).click()
    await expect.poll(() => configReads).toBeGreaterThan(before)
    await expect(page.getByTestId('forge-map')).toBeVisible()
    await expect(page.getByTestId('forge-map')).not.toHaveAttribute('data-map-state', 'loading')
  }
  async function attribution() {
    const footer = page.getByTestId('map-attribution')
    await expect(footer).toHaveText('Maps © Thunderforest, Data © OpenStreetMap contributors')
    for (const [name, href] of [['Thunderforest', 'https://www.thunderforest.com/'], ['OpenStreetMap contributors', 'https://www.openstreetmap.org/copyright']]) {
      const link = footer.getByRole('link', { name, exact: true })
      await expect(link).toHaveAttribute('href', href)
      await link.scrollIntoViewIfNeeded()
      const visibility = await link.evaluate(el => {
        return [...el.getClientRects()].every(rect => {
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
            && parseFloat(getComputedStyle(el).fontSize) >= 12 && (hit === el || el.contains(hit))
        })
      })
      assert.equal(visibility, true, `${name}: every text fragment is visible, legible and unobscured`)
    }
  }
  const kinds = ['ActiveRun', 'RoutePlanner', 'RunDetailModal', 'RoutePreviewMap']
  for (const width of [320, 393]) {
    await page.setViewportSize({ width, height: 874 })
    for (const kind of kinds) {
      config = { THUNDERFOREST_API_KEY: key }; tileFailure = false; tileRequests = []
      await mount(kind)
      await expect(page.locator('.leaflet-tile-loaded').first()).toBeVisible()
      const rendered = await page.locator('.leaflet-tile').evaluateAll(images => images.map(image => image.src))
      assert.ok(rendered.length > 0, kind)
      for (const url of [...rendered.map(value => new URL(value)), ...tileRequests]) {
        assert.match(url.pathname, /^\/outdoors\/\d+\/\d+\/\d+\.png$/)
        assert.equal(url.search, `?apikey=${key}`)
      }
      await attribution()
      await page.getByTestId('forge-map').screenshot({ path: path.join(artifactDir, `${kind}-${width}.png`) })
    }
  }
  console.log('PASS all four real consumers: fixed HTTPS outdoors tiles, exact attribution/hrefs, unobscured 320/393px screenshots')
  for (const kind of kinds) {
    for (const bad of [{}, { THUNDERFOREST_API_KEY: '' }, { THUNDERFOREST_API_KEY: ' ' }, { THUNDERFOREST_API_KEY: 'bad&host=evil' }, null]) {
      config = bad; tileRequests = []
      await mount(kind)
      await expect(page.getByTestId('forge-map').getByRole('status')).toHaveText('Map unavailable.')
      await expect(page.locator('.leaflet-container')).toHaveCount(0)
      assert.equal(tileRequests.length, 0)
      await attribution()
    }
    configStatus = 503; config = { error: sentinel }; tileRequests = []
    await mount(kind)
    await expect(page.getByTestId('forge-map').getByRole('status')).toHaveText('Map unavailable.')
    assert.equal(tileRequests.length, 0)
    configStatus = 200; config = { THUNDERFOREST_API_KEY: 'F' + key.slice(1) }; tileFailure = true
    await mount(kind)
    await expect(page.getByTestId('forge-map').getByRole('status')).toHaveText('Map unavailable.')
    await expect(page.locator('.leaflet-container')).toHaveCount(0)
    await attribution()
  }
  console.log('PASS each surface: absent/blank/malformed/config failure and provider tile failure close without fallback')
  config = { THUNDERFOREST_API_KEY: key }; tileFailure = false
  await mount('ActiveRun', true)
  await expect(page.locator('.leaflet-tile-loaded').first()).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.watchStarts)).toBeGreaterThan(0)
  const snapshot = () => page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('forged_hybrid_active_run_v1'))
    return { coords: s.routeCoords, id: s.clientRunId, distance: s.distanceMiles, phase: s.phase, starts: window.watchStarts, stops: window.watchStops }
  })
  const before = await snapshot()
  const lines = await page.locator('.leaflet-overlay-pane path').evaluateAll(paths => paths.map(p => ({ color: p.getAttribute('stroke'), dash: p.getAttribute('stroke-dasharray') })))
  assert.ok(lines.some(p => p.color === '#D1D5DB' && p.dash))
  assert.ok(lines.some(p => p.color === '#EAB308' && !p.dash))
  await page.getByTestId('map-layout-overview').click()
  assert.deepEqual(await snapshot(), before)
  await page.getByTestId('map-layout-stats').click()
  await expect(page.getByTestId('forge-map')).toHaveCount(0)
  assert.deepEqual(await snapshot(), before)
  config = {}
  await page.getByTestId('map-layout-follow').click()
  await expect(page.getByTestId('forge-map').getByRole('status')).toHaveText('Map unavailable.')
  assert.deepEqual(await snapshot(), before)
  assert.deepEqual(before.coords.map(p => p.slice(0, 2)), coords)
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300))) // Flush Leaflet's former 250ms teardown timer.
  assert.ok(totalTiles > 0, 'Real tile loads were intercepted')
  assert.deepEqual(errors, [])
  assert.deepEqual(external, [])
  assert.ok(consoleMessages.every(msg => !msg.includes(key) && !msg.includes('F' + key.slice(1)) && !msg.includes(sentinel)), 'No keys/raw provider errors logged')
  console.log('PASS live recorder watcher/session preserved across Overview/Stats/Follow and missing config; planned/recorded paths distinct; no external network or leaked telemetry')
} finally {
  await browser?.close()
  await server.close()
}
console.log('MAP TILES SMOKE OK')
