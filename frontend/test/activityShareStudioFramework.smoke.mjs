// Real React controls + Canvas/PNG/JPEG in local Chromium. No account, backend,
// provider, production URL or fixture route tiles are contacted.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium, expect } from '@playwright/test'
import { fromRun, fromStrength, fromHybrid, fromPr } from '../src/lib/shareStats.js'
import { sharePreferences, rendererModel, studioModel } from '../src/lib/shareStudioModel.js'
import { BRAND, SIZES } from '../src/lib/shareTheme.js'

let passed = 0
async function check(name, work) { await work(); passed++; console.log(`PASS ${name}`) }
const route = [[40.7128123, -74.0060456, 123.456789], [40.7138123, -74.0070456, 124.456789], [40.715, -74.006, 126]]
const run = { id: 'share-test-run', name: 'Morning miles', date: '2026-10-19T03:45:00Z', distance_miles: 5,
  duration_seconds: 3000, elevation_gain: 100, calories: 450, avg_heart_rate: 145, route_coords: route,
  email: 'private@example.test', real_name: 'Private identity', location: 'Private place', heart_rate_zones: [1, 2, 3, 4, 5] }
const prefs = { friend_handle: 'abc', units: 'imperial', timezone: 'America/New_York' }
function ownTree(value) {
  if (!value || typeof value !== 'object') return value
  return Reflect.ownKeys(value).map(key => [String(key), ownTree(Object.getOwnPropertyDescriptor(value, key).value)])
}
function absent(model) {
  assert.equal(model.run.route, null)
  assert.equal(model.run.elevationProfile, null)
  for (const text of [JSON.stringify(model), JSON.stringify(ownTree(model))]) {
    assert.doesNotMatch(text, /40\.7128123|74\.0060456|123\.456789|124\.456789|route_coords|"lat"|"lng"|markers|tiles|geometry|private@example|Private identity|Private place/)
  }
}
await check('exact brand and size contracts', () => {
  assert.deepEqual(SIZES, { feed: { w: 1080, h: 1350 }, story: { w: 1080, h: 1920 } })
  assert.equal(sharePreferences({ timezone: 'invalid', distance_unit: 'mi', units: 'metric' }, 'Asia/Tokyo').timezone, 'Asia/Tokyo')
  assert.equal(sharePreferences({ distance_unit: 'mi', units: 'metric' }).distance_unit, 'mi')
  assert.deepEqual(BRAND, { gold: '#EAB308', ember: '#F97316', coal: '#0C0A07', steel: '#16130D', whiteHot: '#FFF6DC' })
})
await check('strict route state, adapter OFF/META, renderer allowlist, and restoration', () => {
  const enabled = studioModel({ run, prefs, showRoute: true })
  assert.deepEqual(enabled.run.route, route.map(point => point.slice(0, 2)))
  assert.equal(enabled.run.elevationProfile.length, 3)
  const off = studioModel({ run, prefs, showRoute: false })
  absent(off)
  absent(fromRun(run, prefs, { showRoute: false }))
  const unreadable = { ...run, get route_coords() { throw new Error('OFF touched raw coordinates') } }
  absent(studioModel({ run: unreadable, prefs, showRoute: false }))
  const poison = fromRun(run, prefs, { showRoute: true })
  Object.defineProperty(poison, Symbol('hidden geometry'), { value: route })
  Object.defineProperty(poison.run, 'rawPoints', { value: route })
  poison.route_coords = route
  absent(rendererModel(poison, false))
  absent(studioModel({ model: poison, showRoute: false }))
  assert.deepEqual(studioModel({ run, prefs, showRoute: true }), enabled)
  for (const invalid of [undefined, {}, { showRoute: false }, 0, 1, 'false', null]) {
    assert.throws(() => studioModel({ run, prefs, showRoute: invalid }), /boolean/)
    assert.throws(() => rendererModel(enabled, invalid), /boolean/)
  }
  const lift = fromStrength({ started_at: '2026-10-18', total_seconds: 1200 }, [{ set_number: 1, reps: 5, weight_lbs: 100 }], prefs)
  const hybrid = fromHybrid(fromRun(run, prefs, { showRoute: true }), lift, { showRoute: false })
  absent(hybrid)
  absent(studioModel({ model: fromHybrid(fromRun(run, prefs, { showRoute: true }), lift, { showRoute: true }), showRoute: false }))
})

const root = fileURLToPath(new URL('..', import.meta.url))
const artifactDir = fileURLToPath(new URL('../test-results/share-framework/', import.meta.url))
mkdirSync(artifactDir, { recursive: true })
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import Studio, { canvasBlob, cardDataForPost, resizedCanvas, shareSummaryCard } from '/src/components/ActivityShareStudio.jsx';
import RunDetailModal from '/src/components/RunDetailModal.jsx';
import { UnitsProvider } from '/src/context/UnitsContext.jsx';
import { TEMPLATES, drawShareCard } from '/src/lib/shareTemplates.js';
import { studioModel, rendererModel, sharePreferences } from '/src/lib/shareStudioModel.js';
import { loadShareFonts } from '/src/lib/shareTheme.js';
import PhotoLibraryService from '/src/services/PhotoLibraryService.js';
import '/src/index.css';
const root = createRoot(document.getElementById('root'));
let key = 0;
const run = ${JSON.stringify(run)};
const prefs = ${JSON.stringify(prefs)};
window.harness = { run, prefs, TEMPLATES, drawShareCard, canvasBlob, cardDataForPost, resizedCanvas, shareSummaryCard, studioModel, rendererModel, sharePreferences, loadShareFonts, PhotoLibraryService };
window.openStudio = (props = {}) => root.render(React.createElement(MemoryRouter, {key: ++key}, React.createElement(Studio, { run, prefs, ...props, onClose: () => root.render(null) })));
window.openRunDetail = (activity = run) => root.render(React.createElement(MemoryRouter, {key: ++key}, React.createElement(UnitsProvider, null,
  React.createElement(RunDetailModal, { run: activity, activePanel: 'media', onClose: () => root.render(null) }))));
window.openStudio();
`
// Resolve Tailwind relative to the frontend even when the gate starts at repo root.
process.chdir(root)
const server = await createServer({ root, configFile: false, envDir: `${artifactDir}/no-env`,
  cacheDir: `${artifactDir}/vite-cache`, optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react-router', 'lucide-react', 'axios', '@capacitor/core'] }, plugins: [react({ exclude: /node_modules|test-results/ }), {
    name: 'share-framework-harness', configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url === '/share-test') {
          res.setHeader('Content-Type', 'text/html')
          res.end(await server.transformIndexHtml(req.url, '<html><body><div id="root"></div><script type="module" src="/@vite/client"></script><script type="module" src="/share-entry.jsx"></script></body></html>'))
        } else next()
      })
    }, resolveId(id) { if (id === '/share-entry.jsx') return id }, load(id) { if (id === '/share-entry.jsx') return entry },
  }], server: { host: '127.0.0.1', port: 0 } })
let browser
try {
  await server.listen()
  const address = server.httpServer.address()
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined })
  const context = await browser.newContext({ viewport: { width: 393, height: 874 }, timezoneId: 'America/Los_Angeles', serviceWorkers: 'block' })
  const page = await context.newPage()
  const errors = [], unexpected = []
  page.on('pageerror', error => errors.push(error.message))
  const apiPosts = []
  let shareContext = { prs: [], sessions: [], sets: [], lifts: [] }
  const contextReads = []
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.hostname !== '127.0.0.1') { unexpected.push(url.origin); return route.abort() }
    if (url.pathname === '/api/auth/me') return route.fulfill({ json: { user: { friend_handle: 'self', units: 'metric' } } })
    if (url.pathname === '/api/users/settings') return route.fulfill({ json: { units: 'metric', timezone: 'invalid/timezone' } })
    if (/^\/api\/runs\/[^/]+\/share-context$/.test(url.pathname)) {
      const data = { run_id: decodeURIComponent(url.pathname.split('/')[3]), user_id: 'share-owner', local_date: url.searchParams.get('local_date'), ...shareContext }
      contextReads.push(data)
      return route.fulfill({ json: data })
    }
    if (url.pathname === '/api/social/activity-posts') {
      apiPosts.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } })
    }
    return route.continue()
  })
  await page.addInitScript(() => {
    window.shared = []; window.records = new WeakMap()
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true })
    Object.defineProperty(navigator, 'share', { configurable: true, value: async data => { window.shared.push(data) } })
    const proto = CanvasRenderingContext2D.prototype
    for (const method of ['fillText', 'drawImage', 'arc', 'stroke']) {
      const original = proto[method]
      proto[method] = function (...args) {
        const records = window.records.get(this.canvas) || []
        const transform = this.getTransform()
        let bounds = null
        if (method === 'fillText') {
          const m = this.measureText(args[0]), x = args[1], y = args[2]
          const corners = [[x - m.actualBoundingBoxLeft, y - m.actualBoundingBoxAscent], [x + m.actualBoundingBoxRight, y + m.actualBoundingBoxDescent]]
            .map(([x, y]) => new DOMPoint(x, y).matrixTransform(transform))
          bounds = { top: Math.min(...corners.map(p => p.y)), bottom: Math.max(...corners.map(p => p.y)) }
        }
        if (method === 'drawImage' && args.length === 5) {
          const top = new DOMPoint(args[1], args[2]).matrixTransform(transform).y
          const bottom = new DOMPoint(args[1] + args[3], args[2] + args[4]).matrixTransform(transform).y
          bounds = { top, bottom }
        }
        records.push({ method, text: method === 'fillText' ? String(args[0]) : null, bounds,
          radius: method === 'arc' ? args[2] : null, color: this.fillStyle, width: this.lineWidth, cap: this.lineCap })
        window.records.set(this.canvas, records)
        return original.apply(this, args)
      }
    }
  })
  await page.goto(`http://127.0.0.1:${address.port}/share-test`)
  const preview = page.getByLabel('Share card preview')
  const ready = () => expect(preview).toHaveAttribute('aria-busy', 'false')
  const reopen = async props => { await page.evaluate(props => window.openStudio(props), props); await ready() }
  const share = async () => {
    await ready()
    const count = await page.evaluate(() => window.shared.length)
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.shared.length)).toBe(count + 1)
    return page.evaluate(async () => {
      const file = window.shared.at(-1).files[0], bitmap = await createImageBitmap(file)
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height
      canvas.getContext('2d').drawImage(bitmap, 0, 0)
      const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
      let alpha = false
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 255) { alpha = true; break }
      const bytes = new Uint8Array(await file.arrayBuffer())
      const text = new TextDecoder('latin1').decode(bytes)
      return { width: bitmap.width, height: bitmap.height, type: file.type, name: file.name, alpha,
        leaked: /40\.7128123|74\.0060456|123\.456789|route_coords|elevationProfile|Private identity|private@example/.test(text) }
    })
  }
  await check('real UI default ON and bundled fonts loaded before drawing', async () => {
    await ready()
    await expect(page.getByRole('checkbox', { name: 'Show route' })).toBeChecked()
    assert.deepEqual(await page.evaluate(() => [...document.fonts].map(face => [face.family.replaceAll('"', ''), face.status]).sort()),
      [['Anton', 'loaded'], ['Barlow Condensed', 'loaded'], ['Barlow Condensed', 'loaded'], ['JetBrains Mono', 'loaded']].sort())
    assert.deepEqual(await page.evaluate(() => window.harness.TEMPLATES.map(item => Object.keys(item).sort())), Array(4).fill(['draw', 'id', 'label', 'sizes', 'supports', 'themes']))
    assert.deepEqual(await page.evaluate(() => window.harness.TEMPLATES.map(item => item.id)), ['iron-chips', 'strike-pr', 'hybrid-split', 'full-bleed-story'])
  })
  await check('reselecting the active template keeps exports ready', async () => {
    await page.getByRole('radio', { name: 'Full-Bleed Story', exact: true }).click()
    await ready()
    await page.getByRole('radio', { name: 'Full-Bleed Story', exact: true }).click()
    await ready()
    await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeEnabled()
  })
  await check('timezone boundary prefers valid preference, falls back to device for missing/invalid preferences', async () => {
    const dates = await page.evaluate(() => [
      { timezone: 'Asia/Tokyo' }, { timezone: 'America/New_York' }, { timezone: 'invalid/timezone' }, {}, { timezone: ' ' },
    ].map(prefs => {
      const normalized = window.harness.sharePreferences(prefs)
      return [normalized.timezone, window.harness.studioModel({ run: window.harness.run, prefs: normalized, showRoute: true }).dateLabel]
    }))
    assert.deepEqual(dates, [['Asia/Tokyo', '2026-10-19'], ['America/New_York', '2026-10-18'],
      ...Array(3).fill(['America/Los_Angeles', '2026-10-18'])])
  })
  const runModel = fromRun(run, prefs)
  const liftModel = fromStrength({ started_at: '2026-10-18', total_seconds: 1200 }, [{ set_number: 1, exercise_name: 'Front Squat', reps: 5, weight_lbs: 100 }], prefs)
  const templates = [
    ['iron-chips', 'Iron Chips', runModel],
    ['strike-pr', 'Strike PR', fromPr({ run_id: run.id, label: 'Time PR: 5K', value: 2678, unit: 'seconds' }, runModel)],
    ['hybrid-split', 'Hybrid Split', fromHybrid(runModel, liftModel)],
    ['full-bleed-story', 'Full-Bleed Story', runModel],
  ]
  for (const [id, label, model] of templates) await check(`${label}: 3 themes × 2 sizes, UI exports, safe bounds, OFF pixels and draw calls`, async () => {
    await reopen({ run: undefined, model })
    await page.getByRole('radio', { name: label, exact: true }).click()
    for (const theme of ['light', 'dark', 'color']) {
      await page.getByRole('radio', { name: theme, exact: true }).check()
      for (const size of ['Feed', 'Story']) {
        await page.getByRole('radio', { name: size, exact: true }).check()
        await page.getByRole('checkbox', { name: 'Show route' }).uncheck()
        const file = await share()
        assert.deepEqual([file.width, file.height], [1080, size === 'Feed' ? 1350 : 1920])
        assert.equal(file.type, 'image/jpeg')
        assert.equal(file.alpha, false)
        assert.equal(file.name, `forged-hybrid-${model.kind}-2026-10-18-${size.toLowerCase()}.jpg`)
        assert.equal(file.leaked, false)
        const evidence = await page.evaluate(async ({ id, theme, size, model }) => {
          const h = window.harness, logo = new Image(); logo.src = '/icon-192.png'; await logo.decode()
          const disabled = h.rendererModel(model, false)
          const noRoute = h.rendererModel({ ...model, run: { ...model.run, route: null, elevationProfile: null } }, true)
          const off = document.createElement('canvas'), reference = document.createElement('canvas')
          const options = { template: id, theme, size: size.toLowerCase(), logo, showRoute: false }
          await h.drawShareCard(off, disabled, options)
          await h.drawShareCard(reference, noRoute, { ...options, showRoute: true })
          const records = window.records.get(off)
          const actualFile = window.shared.at(-1).files[0]
          const referenceFile = await h.canvasBlob(off, actualFile.type, 0.92)
          const actualBytes = new Uint8Array(await actualFile.arrayBuffer())
          const referenceBytes = new Uint8Array(await referenceFile.arrayBuffer())
          const exportMatchesOff = actualBytes.length === referenceBytes.length && actualBytes.every((byte, i) => byte === referenceBytes[i])
          const post = h.cardDataForPost(off, false)
          const image = new Image(); image.src = post.data; await image.decode()
          const scaled = [720, 600, 480].map(width => {
            const c = h.resizedCanvas(off, width); return [c.width, c.height]
          })
          const on = document.createElement('canvas')
          await h.drawShareCard(on, h.rendererModel(model, true), { ...options, showRoute: true })
          return { exportMatchesOff, identical: off.toDataURL() === reference.toDataURL(),
            routeStrokes: records.filter(r => r.method === 'stroke' && r.width >= 9 && r.cap === 'round').length,
            markers: records.filter(r => r.method === 'arc' && [13, 15].includes(r.radius)).length,
            changedOn: on.toDataURL() !== off.toDataURL(),
            text: records.filter(r => r.text).map(r => r.text).join(''),
            bounds: records.filter(r => r.bounds && (r.text || r.method === 'drawImage')).map(r => r.bounds),
            post: [image.width, image.height], scaled }
        }, { id, theme, size, model })
        assert.equal(evidence.exportMatchesOff, true, `${id}/${theme}/${size}: actual UI export matches OFF reference bytes`)
        assert.equal(evidence.identical, true, `${id}/${theme}/${size}: OFF equals no-route pixels`)
        assert.equal(evidence.routeStrokes, 0)
        assert.equal(evidence.markers, 0)
        assert.equal(evidence.changedOn, id === 'full-bleed-story')
        assert.match(evidence.text, /@abc \/ RUN \+ LIFT\. BUILT IN FORGED HYBRID\./)
        assert.doesNotMatch(evidence.text, /NOT SHARED|--|Private identity|Private place|Z[1-5]/)
        if (size === 'Story') for (const bounds of evidence.bounds) {
          assert.ok(bounds.top >= 250 && bounds.bottom <= 1580, `${id}: ${JSON.stringify(bounds)}`)
        }
        for (const [width, height] of [evidence.post, ...evidence.scaled]) assert.equal(width * file.height, height * file.width)
      }
    }
  })
  await check('user OFF → ON restores route pixels; closing/reopening resets ON', async () => {
    await page.getByRole('radio', { name: 'Full-Bleed Story', exact: true }).click(); await ready()
    const off = await preview.evaluate(canvas => canvas.toDataURL())
    await page.getByRole('checkbox', { name: 'Show route' }).check(); await ready()
    assert.notEqual(await preview.evaluate(canvas => canvas.toDataURL()), off)
    await page.getByRole('checkbox', { name: 'Show route' }).uncheck(); await ready()
    assert.equal(await preview.evaluate(canvas => canvas.toDataURL()), off)
    await page.getByRole('button', { name: 'Close share studio' }).click()
    await reopen({})
    await expect(page.getByRole('checkbox', { name: 'Show route' })).toBeChecked()
  })
  await check('same-tick route OFF then Share cannot export the old ON image', async () => {
    await page.getByRole('radio', { name: 'Full-Bleed Story', exact: true }).click(); await ready()
    const count = await page.evaluate(() => window.shared.length)
    await page.evaluate(() => {
      document.querySelector('input[type="checkbox"]').click()
      Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Share').click()
    })
    await ready()
    // Either the click was disabled or export rejected until the OFF render finished.
    assert.equal(await page.evaluate(() => window.shared.length), count)
    assert.equal((await share()).leaked, false)
  })
  await check('actual Save single-flight keeps one canvas/file while native save is pending', async () => {
    await page.evaluate(() => {
      window.savedFiles = []
      window.harness.PhotoLibraryService.saveImage = async file => {
        window.savedFiles.push(file)
        return new Promise(resolve => { window.releaseSave = () => resolve({ saved: true }) })
      }
      const button = Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Save')
      button.click(); button.click()
    })
    await expect.poll(() => page.evaluate(() => window.savedFiles.length)).toBe(1)
    await expect(page.getByRole('checkbox', { name: 'Show route' })).toBeDisabled()
    await page.evaluate(() => window.releaseSave())
    await expect(page.getByText('Saved to Photos.', { exact: true })).toBeVisible()
    assert.equal(await page.evaluate(() => window.savedFiles.length), 1)
  })
  await check('null handle and missing stats omit labels, reflow and never manufacture values', async () => {
    const evidence = await page.evaluate(async () => {
      const h = window.harness, result = []
      for (const entry of h.TEMPLATES.filter(entry => ['iron-chips', 'full-bleed-story'].includes(entry.id))) {
        const canvas = document.createElement('canvas')
        const model = h.studioModel({ run: { name: 'Treadmill', date: '2026-10-18', duration_seconds: 900 }, prefs: {}, showRoute: false })
        await h.drawShareCard(canvas, model, { template: entry.id, theme: 'dark', size: 'feed', showRoute: false })
        result.push(window.records.get(canvas).filter(r => r.text).map(r => r.text).join(''))
      }
      return result
    })
    for (const text of evidence) {
      assert.doesNotMatch(text, /@|DISTANCE|PACE|AVG HR|ELEVATION|CALORIES|MILES|NOT SHARED|--|0:00/)
      assert.match(text, /15:00/)
      assert.match(text, /RUN \+ LIFT\. BUILT IN FORGED HYBRID\./)
    }
    await reopen({ prefs: { ...prefs, friend_handle: null } })
    assert.equal((await share()).leaked, false)
  })
  await check('each absent optional stat drops its label from every applicable stat template', async () => {
    const evidence = await page.evaluate(async () => {
      const h = window.harness, result = []
      for (const key of ['distance', 'time', 'pace', 'avgHr', 'elevation', 'calories']) {
        // Avoid title/unit collisions while retaining the broad missing-label oracle.
        const model = h.studioModel({ run: { ...h.run, name: 'Morning workout' }, prefs: h.prefs, showRoute: false })
        const complete = structuredClone(model)
        model.stats = model.stats.filter(item => item.key !== key)
        model.run.stats = model.stats
        if (model.hero?.key === key) model.hero = null
        for (const entry of h.TEMPLATES.filter(entry => ['iron-chips', 'full-bleed-story'].includes(entry.id))) {
          const canvas = document.createElement('canvas')
          await h.drawShareCard(canvas, model, { template: entry.id, theme: 'dark', size: 'feed', showRoute: false })
          const text = window.records.get(canvas).filter(r => r.text).map(r => r.text).join('\n')
          const fullCanvas = document.createElement('canvas')
          await h.drawShareCard(fullCanvas, complete, { template: entry.id, theme: 'dark', size: 'feed', showRoute: false })
          const present = window.records.get(fullCanvas).filter(r => r.text).map(r => r.text).join('\n')
          result.push({ key, id: entry.id, text, present })
        }
      }
      return result
    })
    const labels = { distance: /DISTANCE|MILES|KILOMETERS|^(?:MI|KM)$/m, time: /TIME/, pace: /PACE/, avgHr: /AVG HR/, elevation: /ELEVATION/, calories: /CALORIES/ }
    for (const { key, id, text, present } of evidence) {
      assert.match(present, labels[key], `${id}/${key}: positive control must expose the label/unit`)
      assert.doesNotMatch(text, labels[key], `${id}/${key}`)
    }
  })
  await check('model prop preserves display and sanitizes private/hidden route input', async () => {
    await page.evaluate(() => {
      const h = window.harness
      const model = h.studioModel({ run: h.run, prefs: h.prefs, showRoute: true })
      model.route_coords = h.run.route_coords
      Object.defineProperty(model, Symbol('geometry'), { value: h.run.route_coords })
      window.openStudio({ run: undefined, model })
    })
    await ready(); await page.getByRole('checkbox', { name: 'Show route' }).uncheck()
    assert.equal((await share()).leaked, false)
    await expect(page.getByRole('button', { name: 'Post to Forged Hybrid' })).toBeDisabled()
  })
  await check('run shim fetches own handle/settings, honors device timezone and preserves social post payload', async () => {
    await reopen({ prefs: undefined })
    await page.getByRole('radio', { name: 'Story', exact: true }).check()
    await page.getByRole('checkbox', { name: 'Show route' }).uncheck(); await ready()
    await page.getByRole('button', { name: 'Post to Forged Hybrid', exact: true }).click()
    await expect.poll(() => apiPosts.length).toBe(1)
    const post = apiPosts[0]
    assert.deepEqual(Object.keys(post).sort(), ['caption', 'card_data', 'mime_type', 'run_id', 'template'])
    assert.equal(post.run_id, run.id); assert.equal(post.template, 'full-bleed-story'); assert.equal(post.mime_type, 'image/jpeg')
    await expect(page.getByText('Posted to your accepted friends in Forged Hybrid.', { exact: true })).toBeVisible()
    const dimensions = await page.evaluate(async data => { const img = new Image(); img.src = data; await img.decode(); return [img.width, img.height] }, post.card_data)
    assert.deepEqual(dimensions, [720, 1280])
  })
  await check('legacy preferences and empty treadmill remain preview/export-safe on every mount and route transition', async () => {
    for (const template of [undefined, 'route', 'log', 'ember', 'contour', 'overlay', 'photo']) {
      await reopen({ run: { name: 'Treadmill' }, prefs: { ...prefs, template } })
      await expect(page.getByRole('radiogroup', { name: 'Share design' }).getByRole('radio')).toHaveCount(1)
      await expect(page.getByRole('radio', { name: 'Full-Bleed Story', exact: true })).toHaveAttribute('aria-checked', 'true')
      for (const on of [true, false, true]) {
        await page.getByRole('checkbox', { name: 'Show route' }).setChecked(on)
        assert.equal((await share()).leaked, false)
      }
    }
  })
  await check('local File picker → Full-Bleed preview/export: run/lift × 3 themes × 2 sizes × route ON/OFF', async () => {
    const photoData = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 48
      const ctx = canvas.getContext('2d'); ctx.fillStyle = 'rgb(30,100,170)'; ctx.fillRect(0, 0, 32, 48)
      ctx.fillStyle = 'rgb(170,60,30)'; ctx.fillRect(0, 0, 16, 24)
      return canvas.toDataURL().split(',')[1]
    })
    for (const model of [runModel, liftModel]) {
      await reopen({ run: undefined, model })
      await page.getByRole('radio', { name: 'Full-Bleed Story', exact: true }).click()
      const chooser = page.waitForEvent('filechooser')
      await page.getByTestId('photo-canvas-picker').click()
      await (await chooser).setFiles({ name: 'synthetic-photo.png', mimeType: 'image/png', buffer: Buffer.from(photoData, 'base64') })
      await expect(page.getByTestId('photo-control-picker')).toHaveText('Change photo')
      await expect(page.getByText('Photo selected: synthetic-photo.png.', { exact: true })).toBeVisible()
      await expect(page.getByRole('radio', { name: 'Full-Bleed Story', exact: true })).toHaveAttribute('aria-checked', 'true')
      for (const theme of ['light', 'dark', 'color']) for (const size of ['feed', 'story']) {
        await page.getByRole('radio', { name: theme, exact: true }).check()
        await page.getByRole('radio', { name: size === 'feed' ? 'Feed' : 'Story', exact: true }).check()
        const snapshots = []
        for (const showRoute of [true, false, true]) {
          await page.getByRole('checkbox', { name: 'Show route' }).setChecked(showRoute)
          await ready()
          const previewData = await preview.evaluate(canvas => canvas.toDataURL())
          snapshots.push(previewData)
          if (snapshots.length === 3) continue // restoration is compared below; two actual exports per case
          const file = await share()
          assert.deepEqual([file.width, file.height, file.type, file.alpha], [1080, size === 'feed' ? 1350 : 1920, 'image/jpeg', false])
          assert.equal(file.leaked, false)
          const evidence = await page.evaluate(async ({ model, theme, size, showRoute, photoData }) => {
            const h = window.harness, photo = new Image(); photo.src = 'data:image/png;base64,' + photoData; await photo.decode()
            const reference = document.createElement('canvas'), withoutPhoto = document.createElement('canvas'), noRoute = document.createElement('canvas')
            const options = { template: 'full-bleed-story', theme, size, showRoute }
            await h.drawShareCard(reference, model, { ...options, photo })
            await h.drawShareCard(withoutPhoto, model, options)
            const stripped = h.rendererModel(model, false)
            await h.drawShareCard(noRoute, stripped, { ...options, photo })
            const expected = new Uint8Array(await (await h.canvasBlob(reference, 'image/jpeg', 0.92)).arrayBuffer())
            const actual = new Uint8Array(await window.shared.at(-1).files[0].arrayBuffer())
            return {
              previewMatches: document.querySelector('canvas[aria-label="Share card preview"]').toDataURL() === reference.toDataURL(),
              photoVisible: reference.toDataURL() !== withoutPhoto.toDataURL(),
              routeVisible: reference.toDataURL() !== noRoute.toDataURL(),
              exportMatches: actual.length === expected.length && actual.every((byte, i) => byte === expected[i]),
            }
          }, { model, theme, size, showRoute, photoData })
          assert.equal(evidence.previewMatches, true)
          assert.equal(evidence.exportMatches, true)
          assert.equal(evidence.photoVisible, true)
          assert.equal(evidence.routeVisible, showRoute && model.kind === 'run')
        }
        assert.equal(snapshots[0], snapshots[2], 'OFF → ON restores exactly the permitted thumbnail')
        assert.equal(snapshots[0] !== snapshots[1], model.kind === 'run')
      }
    }
    await page.screenshot({ path: `${artifactDir}/full-bleed-photo-story.png`, fullPage: true })
  })
  await check('shareSummaryCard retains image share and download behavior', async () => {
    const result = await page.evaluate(async () => {
      const summary = { eyebrow: 'Hybrid Score', primary: '84', subtitle: 'Run and lift balance', metrics: [{ label: 'Running', value: 90 }, { label: 'Strength', value: 78 }] }
      const share = await window.harness.shareSummaryCard(summary)
      const file = window.shared.at(-1).files[0], bitmap = await createImageBitmap(file)
      const nativeShare = navigator.share
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined })
      let clicked = null
      const click = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function () { clicked = this.download }
      try { return { share, dimensions: [bitmap.width, bitmap.height], type: file.type,
        download: await window.harness.shareSummaryCard(summary), filename: clicked } }
      finally { HTMLAnchorElement.prototype.click = click; Object.defineProperty(navigator, 'share', { configurable: true, value: nativeShare }) }
    })
    assert.deepEqual(result, { share: { method: 'share' }, dimensions: [1080, 1350], type: 'image/jpeg', download: { method: 'download' }, filename: 'forged-hybrid-score.jpg' })
  })
  const linkedPr = { id: 'linked-pr', user_id: 'share-owner', run_id: run.id, category: 'time_pr', label: 'Time PR: 5K', value: 2678, unit: 'seconds' }
  const sameDaySession = { id: 'same-day-session', user_id: 'share-owner', started_at: '2026-10-19T06:30:00Z', ended_at: '2026-10-19T06:50:00Z', total_seconds: 1200 }
  const sameDaySets = [{ id: 'same-day-set', user_id: 'share-owner', session_id: sameDaySession.id, set_number: 1, exercise_name: 'Front Squat', reps: 5, weight_lbs: 100 }]
  const enterFromRun = async data => {
    shareContext = data
    const previous = contextReads.length
    await page.evaluate(activity => window.openRunDetail(activity), { ...run, user_id: 'share-owner', type: 'easy' })
    await page.getByRole('button', { name: 'Share run recap', exact: true }).click()
    await expect.poll(() => contextReads.length).toBeGreaterThan(previous)
    await ready()
    assert.equal(contextReads.at(-1).run_id, run.id)
    assert.equal(contextReads.at(-1).local_date, '2026-10-18', 'invalid preference falls back to LA device day')
    await expect(page.getByRole('checkbox', { name: 'Show route' })).toBeChecked()
  }
  for (const [id, label, hybrid] of [['strike-pr', 'Strike PR', false], ['hybrid-split', 'Hybrid Split', true]]) {
    await check(`real RunDetail entry: ${label}, 3 themes × 2 sizes, preview/export equality and route OFF/ON`, async () => {
      await enterFromRun({ prs: [linkedPr], sessions: [sameDaySession], sets: sameDaySets, lifts: [] })
      if (!hybrid) await expect(page.getByRole('radio', { name: 'Strike PR', exact: true })).toHaveAttribute('aria-checked', 'true')
      if (hybrid) {
        await page.getByRole('button', { name: 'Share run + lift', exact: true }).click()
        await expect(page.getByRole('radio', { name: label, exact: true })).toHaveAttribute('aria-checked', 'true')
        await expect(page.getByRole('button', { name: 'Post to Forged Hybrid', exact: true })).toBeDisabled()
      }
      await page.getByRole('radio', { name: label, exact: true }).click()
      for (const theme of ['light', 'dark', 'color']) for (const size of ['Feed', 'Story']) {
        await page.getByRole('radio', { name: theme, exact: true }).check()
        await page.getByRole('radio', { name: size, exact: true }).check()
        for (const showRoute of [false, true]) {
          await page.getByRole('checkbox', { name: 'Show route' }).setChecked(showRoute)
          const file = await share()
          assert.deepEqual([file.width, file.height, file.type], [1080, size === 'Feed' ? 1350 : 1920, 'image/jpeg'])
          assert.equal(file.name, `forged-hybrid-${hybrid ? 'hybrid' : 'run'}-2026-10-18-${size.toLowerCase()}.jpg`)
          assert.equal(file.leaked, false)
          const evidence = await page.evaluate(async ({ id, theme, size, hybrid, showRoute, context }) => {
            const h = window.harness, logo = new Image(); logo.src = '/icon-192.png'; await logo.decode()
            const model = h.studioModel({ run: h.run, context, prefs: { units: 'metric', timezone: 'America/Los_Angeles', friend_handle: 'self' }, hybrid, showRoute })
            const reference = document.createElement('canvas')
            await h.drawShareCard(reference, model, { template: id, theme, size: size.toLowerCase(), logo, showRoute })
            const expected = new Uint8Array(await (await h.canvasBlob(reference, 'image/jpeg', 0.92)).arrayBuffer())
            const actual = new Uint8Array(await window.shared.at(-1).files[0].arrayBuffer())
            return { previewMatches: document.querySelector('canvas[aria-label="Share card preview"]').toDataURL() === reference.toDataURL(),
              exportMatches: actual.length === expected.length && actual.every((byte, i) => byte === expected[i]),
              text: window.records.get(reference).filter(record => record.text).map(record => record.text).join('\n'),
              privateModel: !showRoute && /route_coords|40\.7128123|74\.0060456|123\.456789/.test(JSON.stringify(model)) }
          }, { id, theme, size, hybrid, showRoute, context: contextReads.at(-1) })
          assert.equal(evidence.previewMatches, true)
          assert.equal(evidence.exportMatches, true)
          assert.equal(evidence.privateModel, false)
          assert.match(evidence.text, hybrid ? /Front Squat/ : /44:38/)
          assert.match(evidence.text, /@self/)
          assert.doesNotMatch(evidence.text, /2678|NaN|NOT SHARED/)
        }
      }
      if (hybrid) {
        await page.getByRole('button', { name: 'Share run only', exact: true }).click()
        await expect(page.getByRole('radio', { name: 'Hybrid Split', exact: true })).toHaveCount(0)
      }
    })
  }
  await check('real entry negatives: plain/run-only, unrelated/foreign/invalid PR, nonmatching or empty lift; no fabricated hybrid', async () => {
    for (const data of [
      { prs: [], sessions: [], sets: [], lifts: [] },
      { prs: [{ ...linkedPr, run_id: 'another-run' }], sessions: [], sets: [], lifts: [] },
      { prs: [{ ...linkedPr, user_id: 'foreign' }], sessions: [], sets: [], lifts: [] },
      { prs: [{ ...linkedPr, value: 0 }], sessions: [], sets: [], lifts: [] },
      { prs: [], sessions: [{ ...sameDaySession, started_at: '2026-10-19T07:00:00Z' }], sets: sameDaySets, lifts: [] },
      { prs: [], sessions: [{ ...sameDaySession, total_seconds: null }], sets: [], lifts: [] },
    ]) {
      await enterFromRun(data)
      await expect(page.getByRole('radio', { name: 'Iron Chips', exact: true })).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByRole('radio', { name: 'Strike PR', exact: true })).toHaveCount(0)
      await expect(page.getByRole('button', { name: 'Share run + lift', exact: true })).toHaveCount(0)
      await expect(page.getByRole('radio', { name: 'Hybrid Split', exact: true })).toHaveCount(0)
    }
    // The real run-detail media entry is absent on a lift-only activity.
    await page.evaluate(activity => window.openRunDetail(activity), { id: 'lift-only', type: 'strength', date: '2026-10-18' })
    await expect(page.getByRole('button', { name: 'Share run recap', exact: true })).toHaveCount(0)
    await expect(page.getByLabel('Share card preview')).toHaveCount(0)
    await enterFromRun({ prs: [], sessions: [], sets: [], lifts: [] })
  })
  await page.screenshot({ path: `${artifactDir}/studio-story.png`, fullPage: true })
  await check('no runtime errors or external map/tile requests', () => { assert.deepEqual(errors, []); assert.deepEqual(unexpected, []) })
  await context.close()
  await check('font load failure falls back and still exports through the UI', async () => {
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.addInitScript(() => {
      window.FontFace = class { load() { return Promise.reject(new Error('deliberate font failure')) } }
      window.files = []
      Object.defineProperty(navigator, 'canShare', { value: () => true })
      Object.defineProperty(navigator, 'share', { value: async data => { window.files.push(data.files[0]) } })
    })
    await page.goto(`http://127.0.0.1:${address.port}/share-test`)
    await expect(page.getByLabel('Share card preview')).toHaveAttribute('aria-busy', 'false')
    await page.getByRole('button', { name: 'Share', exact: true }).click()
    await expect.poll(() => page.evaluate(() => window.files.length)).toBe(1)
    assert.deepEqual(await page.evaluate(async () => { const bitmap = await createImageBitmap(window.files[0]); return [bitmap.width, bitmap.height] }), [1080, 1350])
    await context.close()
  })
  console.log(`ACTIVITY SHARE STUDIO FRAMEWORK OK (${passed} groups, 24 registry + 24 actual-entry + 24 photo UI matrix exports; 0 failed)`)
} finally { await browser?.close(); await server.close() }
