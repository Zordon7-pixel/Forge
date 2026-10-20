// Real Express app + normal freshly built SPA. Only DB/bootstrap and API data
// unrelated to tile config are synthetic. No header/server/HTML stand-ins.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { fork, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import { chromium, expect } from '@playwright/test'

const filename = fileURLToPath(import.meta.url)
const repo = path.resolve(path.dirname(filename), '../..')
const backendRequire = createRequire(path.join(repo, 'backend/src/app.js'))
const key = 'SyntheticTileKey' + '0'.repeat(16)
const secret = 'synthetic-map-header-smoke-only'
const user = { id: 'tile-test', onboarded: true, waiver_current: true }
const policyLine = "  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },\n"

if (process.argv[2] === '--serve') {
  // Child gets an allowlisted environment, never dotenv or a real database.
  const stub = (id, exports) => {
    const resolved = backendRequire.resolve(id)
    backendRequire.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports }
  }
  stub('dotenv', { config() {} })
  stub('./db', {
    initDb: async () => {},
    dbRun: async sql => {
      assert.match(sql, /^\s*CREATE TABLE IF NOT EXISTS strava_tokens \(/)
      return { changes: 0 }
    },
    dbGet: async (sql, params) => {
      assert.equal(sql, 'SELECT id FROM users WHERE id = ?')
      assert.deepEqual(params, [user.id])
      return { id: user.id }
    },
    runWithUserContext: (_id, fn) => fn(),
  })
  stub('./db/migrate', { runAlwaysMigrations: async () => {} })
  stub('./db/seed', { runSeed: async () => {} })
  stub('./db/exercises-seed', { seedExercises: async () => {} })
  const forbidNetwork = () => { throw new Error('Unexpected backend outbound request') }
  globalThis.fetch = forbidNetwork
  for (const id of ['node:http', 'node:https']) {
    const transport = backendRequire(id)
    transport.request = forbidNetwork
    transport.get = forbidNetwork
  }
  let source = readFileSync(path.join(repo, 'backend/src/app.js'), 'utf8')
  if (process.argv[4] === 'prior') {
    assert.ok(source.includes(policyLine), 'Prior-policy witness must remove only the new option')
    source = source.replace(policyLine, '')
  }
  const module = { exports: {} }
  // Relocate only __dirname so the app's unchanged static/fallback wiring sees
  // the temporary frontend/dist. All actual routes/middleware load from repo.
  vm.runInNewContext(source + '\nmodule.exports = app;', {
    require: backendRequire, __dirname: path.join(process.argv[3], 'backend/src'),
    process, console, module,
  }, { filename: path.join(repo, 'backend/src/app.js') })
  const app = module.exports
  const listen = app.listen
  app.listen = function (...args) {
    const server = listen.apply(this, args)
    server.once('listening', () => process.send({ port: server.address().port }))
    return server
  }
} else {
  const isolated = mkdtempSync(path.join(os.tmpdir(), 'forge-map-referrer-'))
  const frontend = path.join(repo, 'frontend')
  const dist = path.join(isolated, 'frontend/dist')
  const envDir = path.join(isolated, 'empty-env')
  mkdirSync(envDir)
  const cleanEnv = { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR || '/tmp' }
  const build = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { build } from 'vite'; import config from './vite.config.js'; await build({ ...config, configFile: false, envDir: ${JSON.stringify(envDir)}, build: { ...config.build, outDir: ${JSON.stringify(dist)}, emptyOutDir: true } });`],
  { cwd: frontend, env: cleanEnv, encoding: 'utf8' })
  assert.equal(build.status, 0, build.stderr)
  console.log(`PASS fresh normal Vite build, empty envDir, temporary output: ${dist}`)
  if (build.stderr) console.log(build.stderr.trim())
  const token = backendRequire('jsonwebtoken').sign(user, secret, { expiresIn: '1h' })
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  })
  const witnesses = {}
  try {
    for (const mode of ['prior', 'current']) {
      const child = fork(filename, ['--serve', isolated, mode], {
        cwd: isolated, env: { ...cleanEnv, JWT_SECRET: secret, THUNDERFOREST_API_KEY: key, PORT: '0', HOST: '127.0.0.1', NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      })
      let output = ''
      child.stdout.on('data', data => { output += data })
      child.stderr.on('data', data => { output += data })
      let context
      try {
        const receipt = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Express startup timeout: ${output}`)), 20000)
          child.once('message', value => { clearTimeout(timer); resolve(value) })
          child.once('exit', code => { clearTimeout(timer); reject(new Error(`Express exited ${code}: ${output}`)) })
          child.once('error', error => { clearTimeout(timer); reject(error) })
        })
        const origin = `http://127.0.0.1:${receipt.port}`
        context = await browser.newContext({ viewport: { width: 393, height: 874 }, serviceWorkers: 'block' })
        const page = await context.newPage()
        const tiles = [], external = [], errors = [], assets = []
        let configResponses = 0
        page.on('pageerror', error => errors.push(error.message))
        page.on('response', response => {
          if (new URL(response.url()).pathname === '/api/meta/map-tiles') configResponses++
          if (new URL(response.url()).pathname.startsWith('/assets/')) assets.push(response)
        })
        await page.addInitScript(({ token, user }) => {
          localStorage.setItem('forge_token', token)
          localStorage.setItem('forged_hybrid_active_run_v1', JSON.stringify({
            ownerUserId: user.id, phase: 'running', startedAt: Date.now() - 42000,
            savedAt: Date.now(), elapsed: 42, distanceMiles: 0.2, mapMyRun: true,
            routeCoords: [[40, -73], [40.001, -73.001], [40.002, -73]],
            gpsStarted: true, gpsAvailable: true, clientRunId: 'referrer-smoke',
            navigationState: { countdown: 0 },
          }))
          navigator.geolocation.getCurrentPosition = success => success({ coords: { latitude: 40, longitude: -73, accuracy: 5 }, timestamp: Date.now() })
          navigator.geolocation.watchPosition = () => 1
          navigator.geolocation.clearWatch = () => {}
        }, { token, user })
        await context.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url())
          if (url.origin === 'https://api.thunderforest.com') {
            // Read Chromium's issued headers. Never set Referer or User-Agent.
            tiles.push({ url, headers: await request.allHeaders() })
            return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=', 'base64') })
          }
          if (url.origin === 'https://fonts.googleapis.com' && url.pathname === '/css2') {
            return route.fulfill({ contentType: 'text/css', body: '' })
          }
          if (url.origin !== origin) { external.push(url.origin); return route.abort() }
          // Runtime tile config goes through the real endpoint and JWT auth.
          if (url.pathname === '/api/meta/map-tiles') return route.continue()
          if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { user, units: 'imperial', zones: [] } })
          return route.continue()
        })
        const response = await page.goto(`${origin}/run/active?private-route=must-not-leak`)
        assert.equal(response.status(), 200)
        assert.equal(await response.text(), readFileSync(path.join(dist, 'index.html'), 'utf8'), 'Actual built index from Express SPA fallback')
        const headers = await response.allHeaders()
        await expect(page.getByTestId('forge-map')).toHaveAttribute('data-map-state', 'ready')
        await expect(page.locator('.leaflet-tile-loaded').first()).toBeVisible()
        await expect.poll(() => tiles.length).toBeGreaterThan(0)
        assert.ok(configResponses > 0, 'Actual authenticated config response')
        assert.ok(assets.some(asset => asset.url().endsWith('.js') && asset.status() === 200), 'Built JS served by Express')
        const ua = await page.evaluate(() => navigator.userAgent)
        for (const tile of tiles) {
          assert.equal(tile.url.searchParams.get('apikey'), key)
          assert.match(tile.url.pathname, /^\/outdoors\/\d+\/\d+\/\d+\.png$/)
          assert.equal(tile.headers['user-agent'], ua, 'Honest browser User-Agent')
          assert.equal(tile.headers.referer || '', mode === 'prior' ? '' : `${origin}/`)
        }
        assert.equal(headers['referrer-policy'], mode === 'prior' ? 'no-referrer' : 'strict-origin-when-cross-origin')
        assert.deepEqual(external, [])
        assert.deepEqual(errors, [])
        const security = Object.fromEntries(Object.entries(headers).filter(([name]) =>
          /^(content-security-policy|cross-origin-|origin-agent-cluster|strict-transport-security|x-)/.test(name)))
        assert.ok(security['content-security-policy-report-only'].includes('https://api.thunderforest.com'))
        assert.equal(security['x-content-type-options'], 'nosniff')
        witnesses[mode] = security
        console.log(`PASS ${mode}: actual Express header ${headers['referrer-policy']}; ${tiles.length} mocked Chromium tiles; Referer ${mode === 'prior' ? 'blank (rejects required origin contract)' : 'origin only, no SPA path/query'}; native UA unchanged`)
      } finally {
        await context?.close()
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, 'exit')
          child.kill('SIGTERM')
          await exited
        }
      }
    }
    assert.deepEqual(witnesses.current, witnesses.prior, 'All other served security headers/CSP unchanged')
  } finally {
    await browser.close()
  }
  console.log('MAP REFERRER SMOKE OK — prior-policy negative witness + current contract; zero live provider requests')
}
