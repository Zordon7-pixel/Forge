// Synthetic only: real route handlers + disposable SQLite; optional real Chromium components.
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import * as trace from '../src/lib/gpsTrace.js'
import { parseRunRouteSegments, elevationStreamFromRoute } from '../src/lib/runRecap.js'
import { saveActiveRunSession, loadActiveRunSession } from '../src/lib/activeRunSession.js'
import { buildRunCompletionSnapshot, saveRunCompletionHandoff, loadRunCompletionHandoff } from '../src/lib/runCompletionHandoff.js'
import { fromRun } from '../src/lib/shareStats.js'
const require = createRequire(import.meta.url)
const backend = require('../../backend/src/lib/runPostRun.js')
const root = fileURLToPath(new URL('../..', import.meta.url))
const installed = createRequire(process.env.FORGE_TEST_MODULE_ROOT ? `${process.env.FORGE_TEST_MODULE_ROOT}/package.json` : import.meta.url)
const start = 1800000000000
const points = []
let state = trace.createGpsTrace({ startedAtMs: start, autoPauseEnabled: false })
for (const [meters, seconds] of [[0, 0], [6, 2], [500, 17], [506, 19]]) {
  const result = trace.acceptGpsFix(state, { lat: 0, lon: meters / 111194.92664455874, altitudeMeters: 10 + seconds, timestampMs: start + seconds * 1000, accuracy: 3 }, start + seconds * 1000)
  assert.equal(result.accepted, true)
  state = result.state; points.push(result.point)
}
const route = trace.finishedPhoneRoute(points)
assert.ok(Math.abs(state.distanceMeters - 12) < .01, 'cross-gap chord excluded by accepted phone policy')
assert.equal(route.segments.length, 2)
assert.equal(route.segments[1].gap.reason, 'timeout')
// Legacy automatic gap labels still deserialize, but automatic pause controls
// must no longer create a recording boundary (October 20 product contract).
for (const reason of ['auto-resume', 'auto-pause-disabled']) {
  assert.equal(trace.traceBoundary(state, reason), state)
  const legacy = trace.finishedPhoneRoute([[0, 0, null, start, 3, 0, null], [0, .01, null, start + 21000, 3, 1, reason]])
  assert.equal(trace.normalizeSegmentedRoute(legacy).segments[1].gap.reason, reason)
}
for (const reason of trace.GAP_REASONS.filter(reason => !['auto-resume', 'auto-pause-disabled'].includes(reason))) {
  const result = trace.acceptGpsFix(trace.traceBoundary(state, reason), { lat: 0, lon: .01, accuracy: 3, timestampMs: start + 21000 }, start + 21000)
  assert.equal(trace.finishedPhoneRoute([...points, result.point]).segments.at(-1).gap.reason, reason)
}
const memory = () => ({ value: null, getItem() { return this.value }, setItem(k, v) { this.value = v }, removeItem() { this.value = null } })
const storage = memory()
saveActiveRunSession({ phase: 'running', startedAt: start, routeCoords: points, gps_source: 'native_bg', backgroundRefreshStatus: 'restricted' }, 'synthetic', storage, start + 20000)
const restored = loadActiveRunSession('synthetic', storage, start + 20000)
assert.deepEqual(trace.finishedPhoneRoute(restored.routeCoords), route)
assert.equal(restored.gps_source, 'native_bg'); assert.equal(restored.backgroundRefreshStatus, 'restricted')
// More than the previous 5000-point sampling threshold must not erase tiny segments.
const many = Array.from({ length: 5002 }, (_, i) => [0, 0, null, start + i, 3, i, i ? 'timeout' : null])
saveActiveRunSession({ phase: 'running', startedAt: start, routeCoords: many }, 'synthetic', storage, start + 20000)
assert.equal(loadActiveRunSession('synthetic', storage, start + 20000).routeCoords.length, many.length)
for (const status of ['available', 'denied', 'restricted', 'unknown', 'error', 'unavailable', undefined, null, true, 0, 'authorized', { permission: 'granted' }]) {
  const expected = typeof status === 'string' && ['available', 'denied', 'restricted', 'unknown', 'error', 'unavailable'].includes(status) ? status : 'unknown'
  assert.deepEqual(trace.phoneRunDiagnostics({ backgroundRefreshStatus: status }), { gps_source: null, backgroundRefreshStatus: expected })
  assert.deepEqual(backend.phoneRunDiagnostics({ backgroundRefreshStatus: status }), trace.phoneRunDiagnostics({ backgroundRefreshStatus: status }))
}
for (const source of [undefined, null, true, 'available', 'authorized', 'browser', { permission: 'granted' }]) assert.equal(trace.normalizeGpsSource(source), null)
assert.deepEqual(backend.normalizeRouteCoords(route), trace.normalizeSegmentedRoute(route))
const positions = parseRunRouteSegments(JSON.stringify(route))
assert.deepEqual(positions.map(segment => segment.positions.length), [2, 2])
assert.equal(positions.filter(segment => segment.gap).length, 1)
assert.equal(backend.classifyRouteIntegrity({ routeCoords: route }).status, 'partial')
const elevation = elevationStreamFromRoute(route, 'metric')
assert.deepEqual(elevation.map(point => point.v), [10, 12, null, 27, 29])
const missing = structuredClone(route); missing.segments[0].points[1].alt = null
assert.equal(elevationStreamFromRoute(missing)[1].v, null, 'missing altitude is a chart break, never zero')
const legacy = [{ lat: 0, lon: 0 }, { lat: 0, lon: .001 }]
assert.equal(parseRunRouteSegments(backend.normalizeRouteCoords(legacy)).length, 1)
assert.equal(parseRunRouteSegments(legacy)[0].gap, null)
assert.equal(elevationStreamFromRoute(legacy).filter(point => point.v !== null).length, 0)
assert.deepEqual(parseRunRouteSegments({ version: 2, segments: [{ points: [null] }] }), [])
assert.throws(() => backend.normalizeRouteCoords({ version: 2, segments: [{ points: [null] }] }), /Invalid segmented/)
assert.equal(fromRun({ route_coords: route }, {}, { showRoute: true }).run.route, null, 'legacy share renderer fails closed for segmented routes')
assert.equal(fromRun({ get route_coords() { throw Error('OFF read geometry') } }, {}, { showRoute: false }).run.route, null)
console.log('PASS contract: closed diagnostics, gap reasons, active restore, legacy, distance, elevation, share privacy')

// Reuse the Phase 1 actual ActiveRun hook host without another repository path.
// Only expose its mount and pass a presentational prop; implementation remains real.
let activeHost = readFileSync(new URL('./activeRunGps.smoke.mjs', import.meta.url), 'utf8')
activeHost = activeHost.slice(0, activeHost.indexOf('for(const native of [false,true])'))
  .replace("native = false, restored = null", "native = false, restored = null, refresh = undefined")
  .replace('tree=Component()', 'tree=Component({backgroundRefreshStatus:refresh})')
  .replaceAll('import.meta.url', JSON.stringify(new URL('./activeRunGps.smoke.mjs', import.meta.url).href))
  .replace(/from '(\.\.[^']+)'/g, (_, relative) => `from '${new URL(relative, new URL('./activeRunGps.smoke.mjs', import.meta.url)).href}'`)
const { mount } = await import('data:text/javascript;base64,' + Buffer.from(activeHost + '\nexport { mount }').toString('base64'))
for (const native of [false, true]) {
  const app = mount({ native, refresh: 'denied' }); await app.flush()
  assert.match(app.text(), /GPS source: unknown.*Background refresh: off/)
  // Match the policy fixture above: OFF isolates two-fix legs around a gap.
  // Default-ON warm-up/hysteresis is covered by the actual ActiveRun GPS suite.
  await app.toggle()
  await app.clickText('Start Run'); await app.fix(0)
  await app.tick(2); await app.fix(6)
  await app.tick(17); await app.fix(500)
  await app.tick(19); await app.fix(506)
  await app.find('finish-run').props.onClick(); await app.flush()
  assert.equal(app.payload.gps_source, native ? 'native_bg' : 'web_fallback')
  assert.equal(app.payload.backgroundRefreshStatus, 'denied')
  assert.equal(app.payload.route_coords.segments.length, 2)
  assert.equal(app.payload.route_coords.segments[1].gap.reason, 'timeout')
  assert.ok(Math.abs(app.payload.distance_miles * trace.METERS_PER_MILE - 12) < .01)
  await app.close()
}
for (const refresh of ['available', 'restricted', 'unknown', 'error', 'unavailable', null]) {
  const app = mount({ refresh }); await app.flush()
  assert.equal(app.find('run-settings-diagnostics').props.role, 'status')
  assert.equal(app.nodes().some(node => ['alert', 'dialog'].includes(node.props?.role)), false)
  await app.clickText('Start Run'); assert.equal(app.watches, 1)
  await app.close()
}
console.log('PASS ActiveRun: actual native/web save payloads, filtered distance, gaps, normalized settings seam, no blocking diagnostics')

// The same production POST/GET handler and SQL mutations, with synthetic user context.
// Auth middleware HTTP behavior remains covered by runActualShoe; no listening socket needed here.
const { createDb } = require('../../backend/test/helpers/adaptiveShadowDb.js')
const fixture = createDb(), { db } = fixture
const schema = readFileSync(path.join(root, 'backend/src/db/schema.pg.sql'), 'utf8')
const startup = readFileSync(path.join(root, 'backend/src/db/index.js'), 'utf8')
for (const name of ['shoe_catalog', 'gear_shoes', 'personal_records', 'ai_usage', 'user_hr_profile']) {
  const ddl = `${schema}\n${startup}`.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${name} \\([\\s\\S]*?\\n\\s*\\);`))
  assert.ok(ddl); db.exec(ddl[0].replace(/NOW\(\)/g, 'CURRENT_TIMESTAMP'))
}
for (const [table, columns] of Object.entries({ runs: ['shoe_id TEXT', 'gps_available INTEGER DEFAULT 1', 'calories_burned INTEGER'], users: ['weight_lbs REAL', 'max_heart_rate INTEGER', 'resting_hr INTEGER'] })) {
  for (const column of columns) if (!db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column.split(' ')[0])) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`)
}
fixture.exports.runWithUserContext = (_id, next) => next()
function mockModule(name, exports) { const id = require.resolve(name); require.cache[id] = { id, filename: id, loaded: true, exports } }
mockModule('../../backend/src/db', fixture.exports)
mockModule('../../backend/src/services/ai', { generateRunFeedback() { throw Error('Unexpected AI call') } })
mockModule('../../backend/src/services/weather', { getWeather() { throw Error('Unexpected weather call') } })
process.env.JWT_SECRET = 'synthetic-phase2-only'
const router = require('../../backend/src/routes/runs.js')
async function call(method, routePath, body = {}, id, user = owner) {
  const layer = router.stack.find(layer => layer.route?.path === routePath && layer.route.methods[method])
  assert.ok(layer)
  const req = { body, params: { id }, user: { id: user }, query: {} }
  const res = { code: 200, status(code) { this.code = code; return this }, json(value) { this.value = value; return this } }
  await layer.route.stack.at(-1).handle(req, res)
  return res
}
const owner = randomUUID(), foreign = randomUUID()
for (const id of [owner, foreign]) {
  db.prepare("INSERT INTO users(id,name,email,password_hash,planning_input_revision) VALUES (?,'Synthetic',?,'',7)").run(id, `${id}@example.invalid`)
  for (let n = 0; n < 10; n++) db.prepare("INSERT INTO ai_usage(id,user_id,call_type) VALUES (?,?,'run_feedback')").run(randomUUID(), id)
}
let savedRun
const statuses = ['available', 'denied', 'restricted', 'unknown', 'error', 'unavailable']
for (const [index, backgroundRefreshStatus] of statuses.entries()) {
  const gps_source = index % 2 ? 'web_fallback' : 'native_bg'
  const body = { id: randomUUID(), date: '2026-10-20', type: 'easy', distance_miles: state.distanceMeters / trace.METERS_PER_MILE,
    duration_seconds: 19, activity_start_at: new Date(start).toISOString(), activity_end_at: new Date(start + 19000).toISOString(),
    target_zone: 'Zone 2', plan_session_id: null, route_coords: route, gps_source, backgroundRefreshStatus }
  const created = await call('post', '/', body)
  assert.equal(created.code, 201, 'real run POST must succeed')
  const reloaded = await call('get', '/:id', {}, body.id)
  assert.equal(reloaded.code, 200)
  savedRun = reloaded.value.run
  assert.deepEqual(JSON.parse(savedRun.route_coords), trace.normalizeSegmentedRoute(route))
  assert.equal(savedRun.distance_miles, Number(body.distance_miles.toFixed(6)))
  const metrics = JSON.parse(savedRun.workout_metrics_json)
  assert.equal(metrics.gps_source, gps_source); assert.equal(metrics.backgroundRefreshStatus, backgroundRefreshStatus)
  assert.equal(metrics.route_status, 'partial'); assert.equal(metrics.route_point_count, 4)
  const handoffStorage = memory()
  saveRunCompletionHandoff({ runId: body.id, queued: true, snapshot: buildRunCompletionSnapshot(body), provenance: 'live_tracked' }, owner, handoffStorage, start)
  const handoff = loadRunCompletionHandoff(body.id, owner, handoffStorage, start)
  assert.deepEqual(handoff.snapshot.route_coords, trace.normalizeSegmentedRoute(route))
  assert.equal(handoff.snapshot.workout_metrics_json.gps_source, gps_source)
  assert.equal(handoff.snapshot.workout_metrics_json.backgroundRefreshStatus, backgroundRefreshStatus)
  const replay = await call('post', '/', { ...body, distance_miles: 99, gps_source: 'wrong' })
  assert.equal(replay.code, 200); assert.equal(replay.value.run.distance_miles, Number(body.distance_miles.toFixed(6)))
  assert.equal((await call('get', '/:id', {}, body.id, foreign)).code, 404)
}
assert.equal(db.prepare('SELECT COUNT(*) n FROM runs').get().n, statuses.length, 'one row per manual run, no duplicate on retry')
assert.equal(db.prepare('SELECT planning_input_revision n FROM users WHERE id=?').get(owner).n, 7 + statuses.length)
const unknown = await call('post', '/', { id: randomUUID(), date: '2026-10-20', type: 'easy', target_zone: 'Zone 2', plan_session_id: null, gps_available: true, route_coords: legacy })
assert.equal(unknown.code, 201)
assert.equal(JSON.parse(unknown.value.run.workout_metrics_json).gps_source, null)
assert.equal(JSON.parse(unknown.value.run.workout_metrics_json).backgroundRefreshStatus, 'unknown')
assert.equal(parseRunRouteSegments(unknown.value.run.route_coords)[0].gap, null)
db.close()
console.log('PASS persistence: six manual POST/GET round trips, replay, totals/revision, owner boundary, queued handoff, unknown source')


// Execute the actual recap JSX and its local chart renderer. Leaflet is a synthetic
// host here (browser gate below owns real Leaflet/layout); component props are real.
const { transformSync } = createRequire(installed.resolve('vite'))('esbuild')
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
const componentCode = transformSync(readFileSync(path.join(root, 'frontend/src/components/RunDetailModal.jsx'), 'utf8'), { loader: 'jsx', format: 'cjs', jsx: 'automatic' }).code
const componentModules = {
  react: { useState: value => [value, () => {}], useEffect: () => {} }, 'react/jsx-runtime': jsx,
  'react-leaflet': { CircleMarker: 'CircleMarker', Polyline: 'Polyline', Tooltip: 'Tooltip', useMap: () => ({ fitBounds() {} }) },
  'react-router': { Link: 'Link' }, 'lucide-react': new Proxy({}, { get: (_, name) => String(name) }),
  './maps/ForgeMap': { default: 'ForgeMap' }, '../lib/api': { default: {} },
  '../context/UnitsContext': { useUnits: () => ({ units: 'metric', fmt: new Proxy({}, { get: () => value => String(value) }) }) },
}
const componentContext = { module: { exports: {} }, console, require(id) {
  if (componentModules[id]) return { ...componentModules[id], __esModule: true }
  if (id.startsWith('../lib/')) return require(path.join(root, 'frontend/src', id.slice(3) + '.js'))
  if (id.startsWith('./')) return { __esModule: true, default: id }
  throw Error('Unexpected recap import')
} }
vm.runInNewContext(componentCode, componentContext)
function componentNodes(run) {
  const all = []
  const walk = node => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object') return
    all.push(node)
    if (typeof node.type === 'function') walk(node.type(node.props))
    else walk(node.props?.children)
  }
  walk(componentContext.module.exports.default({ run, standalone: true, activePanel: 'route' }))
  return all
}
const nodeText = node => Array.isArray(node) ? node.map(nodeText).join('') : node && typeof node === 'object' ? nodeText(node.props?.children) : String(node ?? '')
const componentRun = { ...savedRun, planned_session_json: { geometry: [[50, 50], [51, 51]] } }
const nodes = componentNodes(componentRun)
const lines = nodes.filter(node => node.type === 'Polyline')
assert.equal(lines.length, 2)
assert.equal(JSON.stringify(lines.map(node => node.props.positions)), JSON.stringify(positions.map(segment => segment.positions)))
assert.equal(nodes.filter(node => node.type === 'CircleMarker' && node.props.className === 'recap-gps-gap').length, 1)
assert.match(nodeText(nodes.find(node => node.type === 'Tooltip')), /GPS gap 1/)
assert.equal(nodes.filter(node => node.type === 'polyline').length, 2, 'real chart renderer has two separate elevation paths')
assert.equal(nodes.filter(node => node.type === 'ForgeMap').length, 1)
const diagnostic = nodes.find(node => node.props?.['data-testid'] === 'recap-gps-diagnostics')
assert.equal(diagnostic.props.role, 'status'); assert.match(nodeText(diagnostic), /web fallback.*unavailable/)
assert.equal(nodes.filter(node => ['alert', 'dialog'].includes(node.props?.role)).length, 0)
assert.equal(componentNodes({ ...componentRun, route_coords: { version: 2, segments: [] } }).filter(node => node.type === 'ForgeMap').length, 0)
assert.equal(componentNodes({ ...componentRun, route_coords: legacy }).filter(node => node.type === 'Tooltip').length, 0)
const missingNodes = componentNodes({ ...componentRun, route_coords: missing })
assert.equal(missingNodes.filter(node => node.type === 'polyline').length, 2)
const mapSource = readFileSync(path.join(root, 'frontend/src/components/maps/ForgeMap.jsx'), 'utf8')
assert.match(mapSource, /https:\/\/api.thunderforest.com\/outdoors/)
assert.match(mapSource, /Maps ©.*Thunderforest.*Data ©.*OpenStreetMap contributors/s)
assert.doesNotMatch(readFileSync(path.join(root, 'frontend/src/components/RunDetailModal.jsx'), 'utf8'), /openrouteservice|route-planning|tile.openstreetmap/)
console.log('PASS component: actual recap and chart JSX, separate polylines, one visible gap marker, nonmodal diagnostics, ForgeMap, no planned fill')

// Phase 4: source labels remain separate from phone permission diagnostics.
for (const watchRoute of [false, true]) {
  const merged = componentNodes({ ...componentRun, health_source: 'apple_health',
    route_coords: watchRoute ? legacy : route,
    workout_metrics_json: { ...JSON.parse(savedRun.workout_metrics_json), forged_recording_id: 'synthetic',
      summary_source: 'apple_health', route_source: watchRoute ? 'apple_health' : 'forged_phone' } })
  const label = merged.find(node => node.props?.['data-testid'] === 'recap-merged-sources')
  assert.equal(label.props.role, 'status')
  assert.match(nodeText(label), watchRoute ? /Synced workout metrics.*Synced workout route/ : /Synced workout metrics.*iPhone route fallback/)
  assert.equal(merged.filter(node => node.type === 'Polyline').length, watchRoute ? 1 : 2)
}

if (process.argv.includes('--browser') || process.argv.includes('--compile-browser')) {
  const { build } = createRequire(installed.resolve('vite'))('esbuild')
  const { chromium } = installed('@playwright/test')
  const artifacts = mkdtempSync(path.join(os.tmpdir(), 'forge-phone-phase2-'))
  let browser
  try {
    const fixtureRun = { ...savedRun, planned_session_json: { title: 'Planned only', geometry: [[50, 50], [51, 51]] } }
    const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {MemoryRouter} from 'react-router';
      import RunDetailModal from './frontend/src/components/RunDetailModal.jsx'; import ActiveRun from './frontend/src/pages/ActiveRun.jsx';
      import {UnitsProvider} from './frontend/src/context/UnitsContext.jsx';
      const root=createRoot(document.getElementById('root')); window.renderFixture=(surface,status,run)=>root.render(<MemoryRouter><UnitsProvider>{surface==='settings' ? <ActiveRun backgroundRefreshStatus={status}/> : <RunDetailModal standalone activePanel="route" run={run || ${JSON.stringify(fixtureRun)}}/>}</UnitsProvider></MemoryRouter>);`
    const buildResult = await build({ stdin: { contents: entry, resolveDir: root, loader: 'jsx' }, bundle: true, write: false, format: 'iife', jsx: 'automatic',
      nodePaths: [path.dirname(installed.resolve('react/package.json')).replace(/\/react$/, '')], define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env': '{}' },
      plugins: [{ name: 'synthetic-api', setup(b) { b.onResolve({ filter: /\/lib\/api(?:\.js)?$/ }, () => ({ path: 'api', namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export default { get:async(path)=>({data:path==='/meta/map-tiles'?{THUNDERFOREST_API_KEY:'SYNTHETIC000000000000000000000000'}:path==='/user-routes'?{routes:[],limit:20,offset:0}:{}}),post:async()=>({data:{}}) }` })) } }], logLevel: 'silent' })
    const postcss = installed('postcss'), tailwind = installed('tailwindcss')
    const config = (await import('../tailwind.config.js')).default
    const css = await postcss([tailwind({ ...config, content: [path.join(root, 'frontend/src/**/*.{js,jsx}')] })]).process(readFileSync(path.join(root, 'frontend/src/index.css'), 'utf8'), { from: undefined })
    if (process.argv.includes('--compile-browser')) { console.log('PASS browser bundle/CSS compilation (layout not executed)'); process.exit(0) }
    browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--host-resolver-rules=MAP * ~NOTFOUND'] })
    const page = await browser.newPage({ viewport: { width: 393, height: 852 } })
    const errors = [], requests = []
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/*', request => { requests.push(new URL(request.request().url()).hostname); return request.abort() })
    // An intercepted document gives real localStorage without starting a server.
    await page.route('http://forge.test/', request => request.fulfill({ contentType: 'text/html', body: '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div></body></html>' }))
    await page.goto('http://forge.test/')
    await page.addStyleTag({ content: css.css + readFileSync(installed.resolve('leaflet/dist/leaflet.css'), 'utf8') })
    await page.evaluate(() => { localStorage.setItem('forge_token', 'synthetic.' + btoa(JSON.stringify({ id: 'phase2', exp: 9999999999 })) + '.synthetic'); navigator.geolocation.watchPosition = () => 1; navigator.geolocation.clearWatch = () => {} })
    await page.addScriptTag({ content: buildResult.outputFiles[0].text })
    for (const width of [320, 393]) {
      await page.setViewportSize({ width, height: 852 })
      await page.evaluate(() => window.renderFixture('recap'))
      await page.locator('.recap-recorded-segment').first().waitFor({ state: 'attached' })
      assert.equal(await page.getByTestId('forge-map').isVisible(), true)
      assert.equal(await page.locator('.recap-recorded-segment').evaluateAll(paths => paths.every(path => path.getTotalLength() > 0 && Number(path.getAttribute('stroke-width')) > 0)), true)
      assert.equal(await page.locator('.leaflet-tooltip').isVisible(), true)
      assert.equal(await page.locator('.recap-recorded-segment').count(), 2)
      assert.equal(await page.locator('.recap-gps-gap').count(), 1)
      assert.equal(await page.locator('.leaflet-tooltip').textContent(), 'GPS gap 1')
      assert.equal(await page.locator('.leaflet-tooltip span').getAttribute('title'), 'GPS gap 1 · timeout')
      const labelBox = await page.locator('.leaflet-tooltip').boundingBox()
      assert.ok(labelBox.x >= 0 && labelBox.x + labelBox.width <= width, 'gap label stays within the compact map')
      assert.match(await page.getByTestId('recap-gps-diagnostics').textContent(), /web fallback.*Background refresh: unavailable/)
      assert.equal(await page.locator('[data-metric-trace="Elevation"] polyline').count(), 2)
      assert.equal(await page.getByTestId('forge-map').count(), 1)
      assert.equal(await page.getByTestId('map-attribution').textContent(), 'Maps © Thunderforest, Data © OpenStreetMap contributors')
      assert.equal(await page.locator('[role="alert"], [role="dialog"]').count(), 0)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.screenshot({ path: path.join(artifacts, `recap-${width}.png`) })
      for (const status of statuses) {
        await page.evaluate(status => window.renderFixture('settings', status), status)
        await page.getByTestId('run-settings-diagnostics').waitFor()
        assert.equal(await page.getByRole('button', { name: 'Start Run', exact: true }).isEnabled(), true)
        assert.equal(await page.locator('[role="alert"], [role="dialog"]').count(), 0)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      }
      await page.screenshot({ path: path.join(artifacts, `settings-${width}.png`) })
    }
    const noRoute = { ...fixtureRun, route_coords: { version: 2, segments: [] } }
    await page.evaluate(run => window.renderFixture('recap', null, run), noRoute)
    await page.getByTestId('recap-gps-diagnostics').waitFor()
    assert.equal(await page.getByTestId('forge-map').count(), 0, 'planned geometry never fills missing recording')
    assert.deepEqual(errors, [])
    assert.ok(requests.every(host => ['api.thunderforest.com', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(host)), 'no ORS or public tile fallback')
    console.log(`PASS browser: actual recap/ActiveRun/ForgeMap at 320/393, segmented polylines/markers/elevation, diagnostics, planned isolation; artifacts ${artifacts}`)
  } finally { await browser?.close() }
}
