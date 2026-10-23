// Batch-2 contract/draw evidence. Golden approval is a separate fail-closed gate.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fromRun, fromStrength, fromHybrid, fromPr, fromStreak } from '../src/lib/shareStats.js'
import { rendererModel } from '../src/lib/shareStudioModel.js'
import { TEMPLATES, availableShareTemplates, resolveShareTemplate, drawShareCard } from '../src/lib/shareTemplates.js'

const legacy = ['route', 'log', 'ember', 'contour', 'overlay', 'photo']
const ids = ['iron-chips', 'strike-pr', 'hybrid-split', 'trace', 'forged-days', 'full-bleed-story']
const prefs = { friend_handle: 'abc', timezone: 'UTC' }
const raw = { id: 'release-run', name: 'Morning workout', date: '2026-10-18', distance_miles: 5.25, duration_seconds: 2835,
  elevation_gain: 96, calories: 476, avg_heart_rate: 147,
  route_coords: [[40.7128123, -74.0060456, 123.456789], [40.7138123, -74.0070456, 124.456789], [40.715, -74.006, 126]] }
const run = fromRun(raw, prefs)
const lift = fromStrength({ started_at: '2026-10-18', total_seconds: 2526, calories_burned: 326, avg_heart_rate: 118 },
  [{ set_number: 1, exercise_name: 'Front Squat', reps: 6, weight_lbs: 155 }], prefs)
const hybrid = fromHybrid(run, lift)
const pr = fromPr({ run_id: raw.id, label: 'Fastest 5 mile', value: 2678, unit: 'seconds', delta: -31 }, run)
const fixtures = { 'iron-chips': run, 'strike-pr': pr, 'hybrid-split': hybrid, trace: run, 'forged-days': { ...run, streak: fromStreak({ days: 7 }) }, 'full-bleed-story': run }
let groups = 0
async function check(name, work) { await work(); groups++; console.log(`PASS ${name}`) }
function context() {
  const calls = []
  const ctx = new Proxy({
    measureText: value => ({ width: String(value).length * 12 }),
    createLinearGradient: () => ({ addColorStop() {} }),
  }, { get(target, key) { return key in target ? target[key] : (...args) => calls.push([key, ...args]) } })
  return { ctx, calls }
}
function capture(id, model, options = {}) {
  const { ctx, calls } = context()
  TEMPLATES.find(entry => entry.id === id).draw(ctx, model, { theme: 'dark', size: 'feed', logo: {}, showRoute: true, ...options })
  return { calls, text: calls.filter(call => call[0] === 'fillText').map(call => call[1]).join('\n'),
    markers: calls.filter(call => call[0] === 'arc' && [13, 15].includes(call[3])).length }
}
function ownTree(value) {
  if (!value || typeof value !== 'object') return value
  return Reflect.ownKeys(value).map(key => [String(key), ownTree(Object.getOwnPropertyDescriptor(value, key).value)])
}
function privateAbsent(model) {
  assert.equal(model.run.route, null); assert.equal(model.run.elevationProfile, null)
  for (const value of [model, ownTree(model)]) assert.doesNotMatch(JSON.stringify(value), /40\.7128123|74\.0060456|123\.456789|124\.456789|route_coords|"lat"|"lng"|markers|tiles|rawPoints|geometry/)
}
await check('exact six new registry IDs; all six legacy IDs absent from lookup/library/picker/export dispatch', async () => {
  assert.deepEqual(TEMPLATES.map(entry => entry.id), ids)
  const source = readFileSync(new URL('../src/lib/shareTemplates.js', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /legacyDraws|LEGACY_TEMPLATES|draw(?:Route|Log|Ember|Contour|Overlay|Photo)Template/)
  const union = new Set(Object.values(fixtures).flatMap(model => availableShareTemplates(model, { showRoute: true }).map(entry => entry.id)))
  assert.deepEqual([...union].sort(), [...ids].sort())
  for (const id of legacy) for (const showRoute of [true, false]) {
    assert.equal(TEMPLATES.find(entry => entry.id === id), undefined)
    assert.equal(union.has(id), false)
    const { ctx, calls } = context(), canvas = { getContext: () => ctx }
    await drawShareCard(canvas, run, { template: id, theme: 'dark', size: 'feed', logo: {}, showRoute })
    assert.equal(resolveShareTemplate(run, { template: id, showRoute }), 'iron-chips')
    assert.deepEqual(calls, capture('iron-chips', run, { showRoute }).calls)
  }
})
await check('never-empty sparse treadmill/lift: absent and every legacy saved preference, ON/OFF, feed/story', async () => {
  for (const model of [fromRun({ name: 'Treadmill' }, prefs), fromStrength({}, [], prefs)]) {
    for (const template of [undefined, ...legacy]) for (const showRoute of [true, false]) for (const size of ['feed', 'story']) {
      assert.equal(resolveShareTemplate(model, { template, showRoute, size }), 'full-bleed-story')
      assert.deepEqual(availableShareTemplates(model, { showRoute, size }).map(entry => entry.id), ['full-bleed-story'])
      const result = capture('full-bleed-story', model, { showRoute, size })
      assert.equal(result.markers, 0)
      assert.doesNotMatch(result.text, /DISTANCE|VOLUME|PACE|TIME|ELEVATION|AVG HR|CALORIES|NEW PR|0:00|NaN|undefined|NOT SHARED/)
      const { ctx } = context(), canvas = { getContext: () => ctx }
      await drawShareCard(canvas, model, { template, theme: 'dark', size, logo: {}, showRoute })
      assert.deepEqual([canvas.width, canvas.height], [1080, size === 'feed' ? 1350 : 1920])
    }
  }
  assert.equal(resolveShareTemplate(pr, { showRoute: true }), 'strike-pr')
  assert.equal(resolveShareTemplate(hybrid, { showRoute: true }), 'hybrid-split')
  assert.equal(resolveShareTemplate(run, { showRoute: true }), 'iron-chips')
})
await check('actual picker handler pins the active fallback without invalidating it; size/theme/privacy keep the chosen renderer', async () => {
  // Execute the component's actual click closure, then its real resolver and draw
  // dispatch. This is an offline state/draw trace, not a React/browser pixel gate.
  const studio = readFileSync(new URL('../src/components/ActivityShareStudio.jsx', import.meta.url), 'utf8')
  const handler = studio.match(/disabled=\{busy\} onClick=\{(\(\) => \{[^\n]*setTemplate\(item\.id\)[^\n]*\})\} className/)
  assert.ok(handler, 'Locate the actual share-design click handler')
  const bindClick = new Function('item', 'template', 'setTemplate', 'invalidateRender', 'setPosted', 'setStatus', `return (${handler[1]})`)
  for (const [id, model] of Object.entries(fixtures)) for (const initial of [null, ...legacy, id]) {
    let requested = initial, invalidations = 0
    const resolved = () => resolveShareTemplate(model, { template: requested, showRoute: true, size: 'feed' })
    const click = () => bindClick({ id }, resolved(), value => { requested = value },
      () => { invalidations++ }, () => {}, () => {})()
    const alreadyActive = resolved() === id
    click()
    assert.equal(requested, id, `${id}/${initial}: even an active fallback records the user's choice`)
    assert.equal(invalidations, alreadyActive ? 0 : 1, 'Only a changed renderer invalidates the completed render')
    click()
    assert.equal(invalidations, alreadyActive ? 0 : 1, 'Reselection keeps the current render ready')
    for (const size of ['feed', 'story', 'feed']) for (const theme of ['light', 'dark', 'color']) for (const showRoute of [false, true]) {
      const safe = rendererModel(model, showRoute)
      const options = { template: requested, size, theme, showRoute, logo: {} }
      const selected = id === 'trace' && !showRoute ? (size === 'story' ? 'full-bleed-story' : 'iron-chips') : id
      assert.equal(resolveShareTemplate(safe, options), selected, `${id}/${initial}/${size}: selection survives controls`)
      const { ctx, calls } = context(), canvas = { getContext: () => ctx }
      await drawShareCard(canvas, safe, options)
      assert.deepEqual(calls, capture(selected, safe, options).calls, `${id}/${size}: actual dispatch matches the requested reference`)
      assert.deepEqual([canvas.width, canvas.height], [1080, size === 'feed' ? 1350 : 1920])
    }
  }
})
await check('route 7a-d: all six designs × three themes × two sizes; zero OFF geometry calls, restoration', () => {
  for (const [id, model] of Object.entries(fixtures)) {
    for (const theme of ['light', 'dark', 'color']) for (const size of ['feed', 'story']) {
      const before = JSON.stringify(model), on = capture(id, model, { theme, size })
      assert.equal(on.markers > 0, ['trace', 'full-bleed-story'].includes(id), id)
      const off = rendererModel(model, false)
      privateAbsent(off)
      const reference = rendererModel({ ...model, run: { ...model.run, route: null, elevationProfile: null } }, true)
      const selected = resolveShareTemplate(off, { template: id, size, showRoute: false })
      const disabled = capture(selected, off, { theme, size, showRoute: false })
      assert.equal(disabled.markers, 0)
      assert.deepEqual(disabled.calls, capture(selected, reference, { theme, size }).calls)
      assert.deepEqual(capture(id, model, { theme, size }).calls, on.calls)
      assert.equal(JSON.stringify(model), before)
      assert.doesNotMatch(on.text + disabled.text, /^(--|0:00|NaN|undefined|null|NOT SHARED)$/mi)
      assert.equal(selected, id === 'trace' ? (size === 'story' ? 'full-bleed-story' : 'iron-chips') : id)
    }
    for (const showRoute of [undefined, null, 'false', 0, {}, new Boolean(false)]) {
      assert.throws(() => capture(id, model, { showRoute }), /boolean/)
      assert.throws(() => availableShareTemplates(model, { showRoute }), /boolean/)
    }
  }
  const unreadable = { ...raw, get route_coords() { throw new Error('OFF read geometry') } }
  privateAbsent(fromRun(unreadable, prefs, { showRoute: false }))
  privateAbsent(fromPr({ run_id: raw.id, label: 'Longest Run', value: 5, unit: 'mi' }, fromRun(raw, prefs, { showRoute: false })))
  privateAbsent(fromHybrid(run, lift, { showRoute: false }))
  const poison = { ...run, route_coords: raw.route_coords }
  Object.defineProperty(poison, Symbol('geometry'), { value: raw.route_coords })
  Object.defineProperty(poison.run, 'rawPoints', { value: raw.route_coords })
  privateAbsent(rendererModel(poison, false))
})
await check('Full-Bleed real run/lift stats, photo composite, every optional stat, and null handle', () => {
  const photo = { width: 32, height: 48 }
  for (const model of [run, lift]) for (const theme of ['light', 'dark', 'color']) for (const size of ['feed', 'story']) {
    const complete = capture('full-bleed-story', model, { theme, size, photo })
    assert.equal(complete.calls.filter(call => call[0] === 'drawImage' && call[1] === photo).length, 1)
    assert.match(complete.text, /@abc/)
    assert.doesNotMatch(capture('full-bleed-story', { ...model, handle: null }).text, /@/)
    const visible = model.kind === 'run' ? ['distance', 'pace', 'time', 'elevation', 'avgHr', 'calories'] : ['volume', 'sets', 'topSet', 'time', 'avgHr', 'calories']
    for (const key of visible) {
      const stat = model.stats.find(stat => stat.key === key)
      assert.ok(stat, key)
      const reduced = { ...model, stats: model.stats.filter(stat => stat.key !== key) }
      const result = capture('full-bleed-story', reduced, { theme, size, photo })
      if (['distance', 'volume'].includes(key)) {
        assert.ok(complete.text.split('\n').includes(stat.value))
        assert.ok(!result.text.split('\n').includes(stat.value))
      } else {
        assert.ok(complete.text.split('\n').includes(stat.label.toUpperCase()))
        assert.ok(!result.text.split('\n').includes(stat.label.toUpperCase()))
      }
    }
  }
})
console.log(`SHARE RELEASE TEMPLATES OK (${groups} groups; golden comparisons NOT RUN)`)
