// C1+C2 canonical acceptance (36 cases per actual platform). See SHARE-GOLDENS.md.
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { fromRun, fromStrength, fromHybrid, fromPr, fromStreak } from '../src/lib/shareStats.js'
import { rendererModel } from '../src/lib/shareStudioModel.js'
import { C1_TEMPLATES } from '../src/lib/shareOverlaysC1.js'
import { SIZES } from '../src/lib/shareTheme.js'

import { matrix, parseOptions, readLock, validateProvenance, validateBaselines, goldenRoot, directories,
  receiptPath, newReceipt, validateReceipt, pngRecord, assembleCandidate, sha256 } from './shareGoldenProvenance.mjs'
const ids = ['iron-chips', 'strike-pr', 'hybrid-split']
const options = parseOptions(process.argv.slice(2))
const { mode, key: platformKey, selected, batch } = options
const smoke = mode === 'smoke', filterOnly = mode === 'filter-only', update = mode === 'update'
const themes = ['light', 'dark', 'color'], sizes = ['feed', 'story']
assert.equal(matrix.length, 36)
assert.equal(new Set(matrix.map(item => item.name)).size, 36)
const prefs = { friend_handle: 'abc', distance_unit: 'mi', timezone: 'America/New_York' }
// Independent, production-shaped test records, never copied preview statistics.
// Adapters derive every display value (including pace, volume and top lifts).
const run = fromRun({ id: 'c1-run', name: 'Morning miles', date: '2026-10-18', distance_miles: 5.25,
  duration_seconds: 2835, elevation_gain: 96, calories: 476, avg_heart_rate: 147 }, prefs, { showRoute: false })
const lift = fromStrength({ started_at: '2026-10-18', total_seconds: 2526, calories_burned: 326, avg_heart_rate: 118 }, [
  ...Array.from({ length: 4 }, (_, i) => ({ set_number: i + 1, exercise_name: 'Front Squat', reps: 6, weight_lbs: 155 })),
  ...Array.from({ length: 3 }, (_, i) => ({ set_number: i + 5, exercise_name: 'Romanian DL', reps: 10, weight_lbs: 95 })),
  ...Array.from({ length: 2 }, (_, i) => ({ set_number: i + 8, exercise_name: 'Reverse Lunge', reps: 12, weight_lbs: 30 })),
], prefs)
const hybrid = fromHybrid(run, lift, { showRoute: false })
const pr = fromPr({ run_id: 'c1-run', label: 'Fastest 5 mile', value: 2678, unit: 'seconds', delta: -31 }, run)
// Keep all C1 fixture inputs intact, including the seconds PR whose pixels changed in C2.
const gpsRun = fromRun({ id: 'c2-run', name: 'Morning workout', date: '2026-10-18', distance_miles: 5.25,
  duration_seconds: 2835, elevation_gain: 96, calories: 476, avg_heart_rate: 147,
  route_coords: [[40.7128123, -74.0060456, 123.456789], [40.7138123, -74.0070456, 124.456789], [40.715, -74.006, 126]],
}, prefs, { showRoute: true })
const streak = fromStreak({ current_streak: 100,
  week: Array.from({ length: 7 }, (_, i) => ({ hasRun: i % 2 === 0, hasLift: i % 3 === 0 })),
  monthDays: Array.from({ length: 31 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, hasRun: i < 18 && i % 2 === 0,
    hasLift: i < 18 && i % 3 === 0, isToday: i === 17, isFuture: i > 17 })),
})
const fixtures = { 'iron-chips': lift, 'strike-pr': pr, 'hybrid-split': hybrid,
  trace: gpsRun, 'forged-days': { ...gpsRun, streak }, 'full-bleed-story': gpsRun }

const entryFor = id => C1_TEMPLATES.find(entry => entry.id === id)
let passed = 0
async function check(name, work) { await work(); passed++; console.log(`PASS ${name}`) }
await check('registry, deterministic fixtures and supports negatives', () => {
  assert.deepEqual(C1_TEMPLATES.map(entry => entry.id), ids)
  for (const entry of C1_TEMPLATES) {
    assert.deepEqual(entry.themes, themes); assert.deepEqual(entry.sizes, sizes)
    assert.equal(entry.supports(fixtures[entry.id]), true)
    assert.equal(entry.supports(null), false)
  }
  for (const model of [run, lift, hybrid]) assert.equal(entryFor('iron-chips').supports(model), true)
  assert.equal(entryFor('iron-chips').supports({ kind: 'run', stats: [] }), false)
  for (const missing of [null, {}, { label: 'PR', value: 0, unit: 'lbs' }, { label: 'PR', value: 'NaN', unit: 'lbs' }]) {
    assert.equal(entryFor('strike-pr').supports({ ...run, pr: missing }), false)
  }
  for (const model of [run, lift, { ...hybrid, run: { stats: [] } }, { ...hybrid, lift: { ...hybrid.lift, stats: [] } }]) {
    assert.equal(entryFor('hybrid-split').supports(model), false)
  }
  const bodyweight = fromStrength({ started_at: '2026-10-18' }, [{ set_number: 1, reps: 8, exercise_name: 'Pull-up' }], prefs)
  assert.equal(entryFor('iron-chips').supports(bodyweight), true)
  assert.equal(entryFor('hybrid-split').supports(fromHybrid(run, bodyweight)), true)
  for (const model of Object.values(fixtures)) assert.doesNotMatch(JSON.stringify(model), /"(?:--|0:00|NaN|undefined|null|NOT SHARED)"|forgedhybrid/i)
})

// Canvas-call capture is deliberately runnable without a browser/server. It checks
// data filtering, not font metrics, actual pixels or golden acceptance.
function captured(id, model) {
  const texts = [], plates = []
  let points = []
  const ctx = new Proxy({
    measureText: value => ({ width: String(value).length * 12 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    beginPath() { points = [] }, moveTo(x, y) { points.push([x, y]) }, lineTo(x, y) { points.push([x, y]) },
    closePath() { if ([6, 8].includes(points.length)) plates.push(points) },
    fillText(value, x, y) { texts.push({ value: String(value), x, y }) },
  }, { get(target, key) { return key in target ? target[key] : () => {} } })
  entryFor(id).draw(ctx, model, { theme: 'dark', size: 'feed', logo: {}, showRoute: false })
  return { texts, plates, text: texts.map(item => item.value).join('\n') }
}
await check('offline draw capture: every optional chip, PR delta and hybrid stat/row is omitted and reflows', () => {
  for (const model of [run, lift]) {
    const full = captured('iron-chips', model)
    for (const stat of model.stats) {
      const reduced = structuredClone(model)
      reduced.stats = reduced.stats.filter(item => item.key !== stat.key)
      const result = captured('iron-chips', reduced)
      assert.ok(!result.texts.some(item => item.value === stat.label.toUpperCase()), `${model.kind}/${stat.key}`)
      assert.equal(result.plates.length, full.plates.length - 1, 'no empty stat chip')
    }
  }
  const noLifts = { ...lift, lift: { ...lift.lift, topLifts: [] } }
  assert.doesNotMatch(captured('iron-chips', noLifts).text, /TOP LIFTS/)
  const full = captured('strike-pr', pr)
  const reduced = captured('strike-pr', { ...pr, pr: { ...pr.pr, delta: null } })
  assert.match(full.text, /-0:31 vs prev best/)
  assert.doesNotMatch(reduced.text, /vs prev best/)
  assert.ok(reduced.texts.find(item => item.value.includes('STRUCK WHILE HOT')).y < full.texts.find(item => item.value.includes('STRUCK WHILE HOT')).y)
  for (const [block, keys] of [['stats', ['totalTime', 'calories']], ['run', ['distance', 'pace', 'time']], ['lift', ['volume', 'sets', 'time', 'topLifts']]]) {
    for (const key of keys) {
      const model = structuredClone(hybrid), stats = block === 'stats' ? model.stats : model[block].stats
      const removed = stats.find(item => item.key === key)
      if (block === 'stats') model.stats = stats.filter(item => item.key !== key)
      else model[block].stats = stats.filter(item => item.key !== key)
      const result = captured('hybrid-split', model)
      const text = result.texts.filter(item => block === 'stats' || (block === 'run' ? item.x < 540 : item.x > 540)).map(item => item.value).join('\n')
      if (key === 'totalTime') assert.doesNotMatch(text, / TOTAL/)
      else if (key === 'topLifts') for (const lift of hybrid.lift.topLifts) assert.ok(!text.includes(lift.name))
      else assert.ok(!text.includes(removed.label.toUpperCase()), `${block}/${key}`)
    }
  }
  for (const id of ids) {
    assert.match(captured(id, fixtures[id]).text, /@abc \/ RUN \+ LIFT/)
    assert.doesNotMatch(captured(id, { ...fixtures[id], handle: null }).texts.find(item => item.value.includes('BUILT IN FORGED HYBRID.')).value, /@/)
    assert.doesNotMatch(captured(id, fixtures[id]).text, /^(--|0:00|NaN|undefined|null|NOT SHARED)$/mi)
    for (const invalid of [undefined, null, 'false', 0, {}, new Boolean(false)]) assert.throws(() => entryFor(id).draw({}, fixtures[id], { showRoute: invalid }), /boolean/)
  }
  for (const value of ['--', '0:00', 'NaN', 'undefined', 'null', 'NOT SHARED', '']) assert.equal(entryFor('iron-chips').supports({ ...run, stats: [{ key: 'time', label: 'Time', value }] }), false)
})
if (filterOnly) {
  console.log(`C1 FILTERING OK (${passed} groups; 36-case manifest validated). Browser/pixels/goldens NOT RUN.`)
  process.exit(0)
}

const root = fileURLToPath(new URL('..', import.meta.url))
const approved = readLock()
validateProvenance(approved, approved.runtime)
if (mode === 'candidate') {
  const path = resolve(options.candidate), rel = relative(join(root, '..'), path)
  assert.ok(isAbsolute(options.candidate) && rel.startsWith('..' + '/') && !existsSync(path), 'Candidate output must be a new absolute path outside the repository')
  const candidate = assembleCandidate(approved), bytes = JSON.stringify(candidate, null, 2) + '\n'
  writeFileSync(path, bytes, { flag: 'wx' })
  console.log(`CANDIDATE ONLY ${path} sha256=${sha256(bytes)}; compare/review both platforms before pinning acceptance`)
  process.exit(0)
}
const launchArgs = approved.runtime.args, contextOptions = approved.runtime.context
const goldenDir = join(goldenRoot, directories[platformKey])
let receipt, baselineBytes
if (update) {
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).trim(), '',
    'One batch per clean serialized session; commit/checkpoint existing work first')
  receipt = existsSync(receiptPath(platformKey)) ? JSON.parse(readFileSync(receiptPath(platformKey), 'utf8')) : newReceipt(approved, platformKey, approved.runtime)
  validateReceipt(receipt, approved, platformKey)
  assert.ok(!Object.hasOwn(receipt.batches, String(batch)), 'Batch already generated; do not silently overwrite evidence')
} else if (!smoke) baselineBytes = validateBaselines(approved)[platformKey]
const { createServer } = await import('vite')
const { chromium } = await import('@playwright/test')
const require = createRequire(import.meta.url)
const browserDescriptors = JSON.parse(readFileSync(join(root, 'node_modules/playwright-core/browsers.json'), 'utf8')).browsers
const scratch = mkdtempSync(join(tmpdir(), 'forge-c1-'))
const entry = `
import { drawShareCard, TEMPLATES } from '/src/lib/shareTemplates.js';
import { loadShareFonts } from '/src/lib/shareTheme.js';
window.harness = { drawShareCard, TEMPLATES, loadShareFonts };
`
const server = await createServer({ root, configFile: false, envDir: join(scratch, 'no-env'), cacheDir: join(scratch, 'cache'),
  optimizeDeps: { noDiscovery: true }, plugins: [{ name: 'c1-harness',
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== '/c1') return next()
      res.setHeader('Content-Type', 'text/html')
      res.end('<html><body><script type="module" src="/c1-entry.js"></script></body></html>')
    }) },
    resolveId(id) { if (id === '/c1-entry.js') return id }, load(id) { if (id === '/c1-entry.js') return entry },
  }], server: { host: '127.0.0.1', port: 0 } })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ headless: true, args: launchArgs })
  const runtime = { browser: browser.browserType().name(), version: browser.version(),
    playwright: require('@playwright/test/package.json').version,
    playwrightCore: require('playwright-core/package.json').version,
    browsers: ['chromium', 'chromium-headless-shell'].map(name => {
      const descriptor = browserDescriptors.find(item => item.name === name)
      return { name, revision: descriptor?.revision, version: descriptor?.browserVersion }
    }), args: launchArgs, context: contextOptions }
  validateProvenance(approved, runtime)
  const page = await browser.newPage(contextOptions)
  const errors = [], external = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => {
    if (new URL(route.request().url()).hostname !== '127.0.0.1') { external.push(route.request().url()); return route.abort() }
    return route.continue()
  })
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/c1`)
  await page.waitForFunction(() => Boolean(window.harness))
  await page.evaluate(async () => {
    await window.harness.loadShareFonts()
    window.logo = new Image(); window.logo.src = '/icon-192.png'; await window.logo.decode()
    // Locally drawn, fixed background: no network photo, randomness or wall clock.
    window.photo = document.createElement('canvas'); photo.width = 1080; photo.height = 1920
    const p = photo.getContext('2d'), gradient = p.createLinearGradient(0, 0, 1080, 1920)
    gradient.addColorStop(0, 'rgb(60,70,90)'); gradient.addColorStop(1, 'rgb(100,70,40)')
    p.fillStyle = gradient; p.fillRect(0, 0, 1080, 1920)
    p.fillStyle = 'rgb(40,40,40)'; p.fillRect(0, 1300, 1080, 620)
    window.render = async (id, model, theme = 'dark', size = 'feed', withPhoto = false) => {
      const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d'), calls = [], plates = []
      const fillText = ctx.fillText.bind(ctx), drawImage = ctx.drawImage.bind(ctx), closePath = ctx.closePath.bind(ctx)
      const moveTo = ctx.moveTo.bind(ctx), lineTo = ctx.lineTo.bind(ctx), beginPath = ctx.beginPath.bind(ctx)
      let points = []
      ctx.beginPath = () => { points = []; beginPath() }
      ctx.moveTo = (x, y) => { points.push([x, y]); moveTo(x, y) }
      ctx.lineTo = (x, y) => { points.push([x, y]); lineTo(x, y) }
      ctx.closePath = () => {
        if ([6, 8].includes(points.length)) plates.push(points.map(([x, y]) => {
          const point = new DOMPoint(x, y).matrixTransform(ctx.getTransform())
          return [point.x, point.y]
        }))
        closePath()
      }
      ctx.fillText = (value, x, y, ...rest) => {
        const m = ctx.measureText(value), transform = ctx.getTransform()
        const a = new DOMPoint(x - m.actualBoundingBoxLeft, y - m.actualBoundingBoxAscent).matrixTransform(transform)
        const b = new DOMPoint(x + m.actualBoundingBoxRight, y + m.actualBoundingBoxDescent).matrixTransform(transform)
        calls.push({ text: String(value), x: a.x, right: b.x, top: a.y, bottom: b.y })
        fillText(value, x, y, ...rest)
      }
      ctx.drawImage = (image, x, y, w, h) => {
        if (image === window.logo) {
          const transform = ctx.getTransform(), a = new DOMPoint(x, y).matrixTransform(transform), b = new DOMPoint(x + w, y + h).matrixTransform(transform)
          calls.push({ brand: true, x: a.x, right: b.x, top: a.y, bottom: b.y })
        }
        drawImage(image, x, y, w, h)
      }
      await window.harness.drawShareCard(canvas, model, { template: id, theme, size, logo: window.logo, photo: withPhoto ? window.photo : null, showRoute: ['trace', 'full-bleed-story'].includes(id),
        layout: id === 'forged-days' ? ({ light: 'week', dark: 'month', color: 'milestone' })[theme] : undefined })
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let transparent = 0
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] < 255) transparent++
      const blob = await new Promise(resolve => canvas.toBlob(resolve, withPhoto ? 'image/jpeg' : 'image/png', 0.95))
      const decoded = await createImageBitmap(blob)
      const exported = { type: blob.type, width: decoded.width, height: decoded.height }; decoded.close()
      return { calls, plates, transparent, exported, width: canvas.width, height: canvas.height, png: canvas.toDataURL('image/png').split(',')[1] }
    }
    window.compare = async (actual, expected, size) => {
      const decode = async data => {
        const image = new Image(); image.src = 'data:image/png;base64,' + data; await image.decode()
        if (image.width !== 1080 || image.height !== (size === 'story' ? 1920 : 1350)) throw new Error('Golden dimensions differ')
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0)
        return ctx.getImageData(0, 0, canvas.width, canvas.height).data
      }
      const a = await decode(actual), b = await decode(expected)
      let different = 0
      for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) different++
      return different / (a.length / 4)
    }
  })
  const render = (id, model, theme = 'dark', size = 'feed', photo = false) => page.evaluate(({ id, model, theme, size, photo }) => window.render(id, model, theme, size, photo), { id, model, theme, size, photo })
  const texts = result => result.calls.filter(call => call.text).map(call => call.text)
  const bounds = (result, size) => {
    for (const call of result.calls) {
      assert.ok(call.x >= 0 && call.right <= 1080, JSON.stringify(call))
      assert.ok(call.top >= (size === 'story' ? 250 : 0) && call.bottom <= (size === 'story' ? 1580 : 1350), JSON.stringify(call))
    }
    for (const plate of result.plates) for (const [x, y] of plate) {
      assert.ok(x >= 1 && x <= 1079 && y >= (size === 'story' ? 251 : 1) && y <= (size === 'story' ? 1579 : 1349), `Plate outside safe bounds: ${x}, ${y}`)
    }
    assert.equal(result.calls.filter(call => call.brand).length, 1)
    assert.ok(texts(result).includes('FORGED'))
    assert.doesNotMatch(texts(result).join('\n'), /^(--|0:00|NaN|undefined|null|NOT SHARED)$/mi)
  }
  await check('four bundled font faces loaded (no system fallback in golden renders)', async () => {
    assert.deepEqual(await page.evaluate(() => [...document.fonts].map(face => [face.family.replaceAll('"', ''), face.weight, face.status]).sort()),
      [['Anton', '400', 'loaded'], ['Barlow Condensed', '600', 'loaded'], ['Barlow Condensed', '800', 'loaded'], ['JetBrains Mono', '100 900', 'loaded']].sort())
    assert.deepEqual(await page.evaluate(() => [...document.fonts].map(face => [face.family.replaceAll('"', ''), face.status]).sort()),
      [['Anton', 'loaded'], ['Barlow Condensed', 'loaded'], ['Barlow Condensed', 'loaded'], ['JetBrains Mono', 'loaded']].sort())
  })
  await check('Iron Chips: each optional stat removes its chip, ordering, full-width top lifts, compact reflow', async () => {
    for (const model of [run, lift]) {
      const full = await render('iron-chips', model)
      const expected = model.kind === 'run' ? ['DISTANCE', 'PACE', 'TIME', 'ELEVATION', 'CALORIES', 'AVG HR']
        : ['VOLUME', 'SETS', 'TOP SET', 'TIME', 'CALORIES', 'AVG HR', 'REPS', 'TOP LIFTS']
      assert.deepEqual(texts(full).filter(text => expected.includes(text)), expected)
      for (const stat of model.stats.filter(stat => stat.key !== 'topLifts')) {
        const caption = full.calls.find(call => call.text === stat.label.toUpperCase())
        const value = full.calls.find(call => call.text === [stat.value, stat.unit].filter(Boolean).join(' ').toUpperCase())
        assert.ok(caption.right < value.x && caption.top > value.top, `${stat.key}: inline label beside larger value`)
        assert.ok(full.plates.some(plate => {
          const xs = plate.map(([x]) => x), ys = plate.map(([, y]) => y)
          return [caption, value].every(call => call.x > Math.min(...xs) && call.right < Math.max(...xs)
            && call.top > Math.min(...ys) && call.bottom < Math.max(...ys))
        }), `${stat.key}: both texts contained by the same chip`)
      }
      assert.ok(new Set(full.plates.slice(3, 3 + model.stats.length - 1).map(plate => Math.round(Math.max(...plate.map(([x]) => x)) - Math.min(...plate.map(([x]) => x))))).size > 1,
        'stat chips fit their content instead of using equal-width columns')
      for (const stat of model.stats) {
        const reduced = structuredClone(model)
        reduced.stats = reduced.stats.filter(item => item.key !== stat.key)
        const result = await render('iron-chips', reduced)
        assert.ok(!texts(result).includes(stat.label.toUpperCase()), `${model.kind}/${stat.key}`)
        assert.equal(result.plates.length, full.plates.length - 1, 'no empty chip remains')
        bounds(result, 'feed')
      }
      if (model.kind === 'lift') {
        const topPlate = full.plates.at(-1)
        assert.equal(Math.max(...topPlate.map(([x]) => x)) - Math.min(...topPlate.map(([x]) => x)), 898)
      }
    }
    const minimal = { ...run, stats: run.stats.filter(stat => stat.key === 'time'), dateLabel: null, handle: null }
    const result = await render('iron-chips', minimal)
    assert.equal(result.plates.length, 3, 'brand, kind, one real stat')
    assert.doesNotMatch(texts(result).join('\n'), /@|DISTANCE|PACE|ELEVATION|CALORIES|AVG HR/)
    for (const size of sizes) bounds(await render('iron-chips', hybrid, 'dark', size), size)
  })
  await check('Strike PR: no absent delta/unit/label invention; date/kind micro line and numeric truth', async () => {
    const full = await render('strike-pr', pr), without = await render('strike-pr', { ...pr, pr: { ...pr.pr, delta: null } })
    assert.ok(texts(full).includes('44:38')); assert.ok(texts(full).includes('mm:ss'))
    assert.ok(texts(full).includes('-0:31 vs prev best'))
    assert.doesNotMatch(texts(without).join('\n'), /vs prev best/)
    assert.ok(without.calls.find(call => call.text?.includes('STRUCK WHILE HOT')).top < full.calls.find(call => call.text?.includes('STRUCK WHILE HOT')).top)
    assert.match(texts(full).join('\n'), /2026-10-18 · RUN · STRUCK WHILE HOT/)
    const lifted = { ...lift, pr: { label: 'Front squat 6RM', value: '155', unit: 'lbs', delta: null } }
    assert.match(texts(await render('strike-pr', lifted)).join('\n'), /LIFT · STRUCK WHILE HOT/)
  })
  await check('Hybrid Split: each optional stat/side/top-lift removal; labels and rows reflow', async () => {
    const full = await render('hybrid-split', hybrid)
    assert.deepEqual(full.plates, [[[100, 430], [1010, 430], [1010, 1180], [980, 1210], [70, 1210], [70, 460]]])
    const distance = full.calls.find(call => call.text === [hybrid.run.stats.find(stat => stat.key === 'distance').value, hybrid.unit].join(' ').toUpperCase())
    const pace = full.calls.find(call => call.text === [hybrid.run.stats.find(stat => stat.key === 'pace').value, hybrid.run.stats.find(stat => stat.key === 'pace').unit].filter(Boolean).join(' ').toUpperCase())
    assert.ok(distance.bottom - distance.top > pace.bottom - pace.top, 'distance remains the run hero')
    for (const [block, keys] of [['stats', ['totalTime', 'calories']], ['run', ['distance', 'pace', 'time']], ['lift', ['volume', 'sets', 'time', 'topLifts']]]) {
      for (const key of keys) {
        const reduced = structuredClone(hybrid), stats = block === 'stats' ? reduced.stats : reduced[block].stats
        const stat = stats.find(item => item.key === key)
        if (block === 'stats') reduced.stats = stats.filter(item => item.key !== key)
        else reduced[block].stats = stats.filter(item => item.key !== key)
        const result = await render('hybrid-split', reduced), relevant = result.calls.filter(call => call.text && (block === 'stats' || (block === 'run' ? call.x < 540 : call.x > 540)))
        const text = relevant.map(call => call.text).join('\n')
        if (key === 'totalTime') assert.doesNotMatch(text, / TOTAL/)
        else if (key === 'topLifts') for (const lift of hybrid.lift.topLifts) assert.ok(!text.includes(lift.name))
        else assert.ok(!text.includes(stat.label.toUpperCase()), `${block}/${key}: ${text}`)
        bounds(result, 'feed')
        if (key === 'volume') assert.ok(result.calls.find(call => call.text === 'SETS · TIME').top < full.calls.find(call => call.text === 'SETS · TIME').top)
      }
    }
    for (let index = 0; index < 3; index++) {
      const reduced = structuredClone(hybrid), removed = reduced.lift.topLifts.splice(index, 1)[0]
      assert.ok(!texts(await render('hybrid-split', reduced)).join('\n').includes(removed.name))
    }
    const sparse = structuredClone(hybrid)
    sparse.run.stats = [run.stats.find(stat => stat.key === 'avgHr')]
    sparse.lift.stats = [lift.stats.find(stat => stat.key === 'reps')]; sparse.lift.topLifts = []
    const result = await render('hybrid-split', sparse)
    assert.ok(texts(result).includes('AVG HR')); assert.ok(texts(result).includes('REPS'))
  })
  await check('real/null handles, poisoned placeholders, no mutation, strict route boolean and allowlist', async () => {
    for (const id of ids) {
      const model = structuredClone(fixtures[id]), before = JSON.stringify(model)
      assert.match(texts(await render(id, model)).join('\n'), /@abc \/ RUN \+ LIFT/)
      assert.equal(JSON.stringify(model), before)
      model.handle = null
      assert.doesNotMatch(texts(await render(id, model)).find(text => text.includes('BUILT IN FORGED HYBRID.')), /@/)
      model.email = 'private@example.test'; model.route_coords = [[40.123, -70.123]]
      const safe = rendererModel(model, false)
      assert.doesNotMatch(JSON.stringify(safe), /private@example|route_coords|40\.123/)
      for (const invalid of [undefined, null, 'false', 0, {}, new Boolean(false)]) {
        assert.throws(() => entryFor(id).draw({}, model, { showRoute: invalid }), /boolean/)
      }
    }
    for (const value of ['--', '0:00', 'NaN', 'undefined', 'null', 'NOT SHARED', '']) {
      const model = { ...run, stats: [{ key: 'time', label: 'Time', value }] }
      assert.equal(entryFor('iron-chips').supports(model), false)
    }
  })
  const pending = new Map()
  await check('36-case matrix: exact PNG/JPEG dimensions, alpha, deterministic pixels, Story safe zones', async () => {
    let written = 0, compared = 0
    for (const item of (update ? selected : matrix)) {
      const result = await render(item.id, fixtures[item.id], item.theme, item.size, true)
      bounds(result, item.size)
      assert.deepEqual([result.width, result.height], [SIZES[item.size].w, SIZES[item.size].h])
      assert.deepEqual(result.exported, { type: 'image/jpeg', width: item.width, height: item.height })
      assert.equal(result.transparent, 0, 'Photo composite must be opaque')
      const bare = await render(item.id, fixtures[item.id], item.theme, item.size, false)
      assert.deepEqual(bare.exported, { type: 'image/png', width: item.width, height: item.height })
      assert.equal(bare.transparent > 0, item.id !== 'full-bleed-story', 'Transparent overlays retain alpha; Full-Bleed is opaque')
      bounds(bare, item.size)
      const repeat = await render(item.id, fixtures[item.id], item.theme, item.size, true)
      assert.equal(result.png, repeat.png, item.name)
      assert.equal(await page.evaluate(({ a, size }) => window.compare(a, a, size), { a: result.png, size: item.size }), 0)
      if (update) {
        const tops = [...result.calls.map(call => call.top), ...result.plates.flatMap(plate => plate.map(([, y]) => y - 1))]
        const bottoms = [...result.calls.map(call => call.bottom), ...result.plates.flatMap(plate => plate.map(([, y]) => y + 1))]
        console.log(`PNG ${item.name}: ${result.width}x${result.height}; content y=${Math.min(...tops).toFixed(2)}..${Math.max(...bottoms).toFixed(2)}`)
      }
      if (update) {
        pending.set(item.name, Buffer.from(result.png, 'base64'))
        written++
      } else if (!smoke && selected.some(entry => entry.name === item.name)) {
        const expected = baselineBytes.get(item.name).toString('base64')
        const ratio = await page.evaluate(({ a, b, size }) => window.compare(a, b, size), { a: result.png, b: expected, size: item.size })
        assert.ok(ratio <= 0.001, `${item.name}: ${(ratio * 100).toFixed(4)}% pixels differ (maximum 0.1%)`)
        console.log(`COMPARE ${item.name}: ${(ratio * 100).toFixed(4)}% pixels differ`)
        compared++
      }
    }
    assert.equal(written, update ? 9 : 0)
    assert.equal(compared, smoke || update ? 0 : selected.length)
  })
  await check('pixel comparator detects a changed image and dimension mismatch', async () => {
    const result = await render('iron-chips', lift)
    const altered = await render('iron-chips', { ...lift, stats: lift.stats.filter(stat => stat.key !== 'volume') })
    assert.ok(await page.evaluate(({ a, b }) => window.compare(a, b, 'feed'), { a: result.png, b: altered.png }) > 0.001)
    await assert.rejects(page.evaluate(a => window.compare(a, a, 'story'), result.png), /dimensions differ/)
  })
  await check('no browser errors or external requests', () => { assert.deepEqual(errors, []); assert.deepEqual(external, []) })
  if (update) {
    // Write only after every render/contract passes. A partial write cannot create acceptance.
    assert.equal(pending.size, 9)
    validateProvenance(approved, runtime)
    assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).trim(), '',
      'Checkout changed during generation; no batch written')
    receipt.batches[batch] = selected.map(item => pngRecord(item, pending.get(item.name)))
    mkdirSync(goldenDir, { recursive: true })
    for (const [name, bytes] of pending) writeFileSync(join(goldenDir, name), bytes)
    writeFileSync(receiptPath(platformKey), JSON.stringify(receipt, null, 2) + '\n')
    validateReceipt(receipt, approved, platformKey)
  }
  console.log(`C1+C2 OK (${passed} groups). ${smoke ? 'SMOKE ONLY: 36 cases; no golden acceptance.' : update ? `GENERATED ${platformKey} batch ${batch}: 9 PNGs + 1 receipt; acceptance unchanged.` : `${selected.length} comparisons <=0.1%; both complete platform manifests verified.`}`)

} finally { await browser?.close(); await server.close(); rmSync(scratch, { recursive: true, force: true }) }
