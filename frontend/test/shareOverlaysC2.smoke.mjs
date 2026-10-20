// Deterministic contract/draw evidence only. Platform golden acceptance is separate.
import assert from 'node:assert/strict'
import { fromRun, fromStrength, fromHybrid, fromPr, fromStreak } from '../src/lib/shareStats.js'
import { rendererModel } from '../src/lib/shareStudioModel.js'
import { TEMPLATES, availableShareTemplates, resolveShareTemplate, drawShareCard } from '../src/lib/shareTemplates.js'
import { streakLayouts } from '../src/lib/shareOverlaysC2.js'

const legacy = ['route', 'log', 'ember', 'contour', 'overlay', 'photo']
const ids = ['iron-chips', 'strike-pr', 'hybrid-split', 'trace', 'forged-days', 'full-bleed-story']
const prefs = { friend_handle: 'abc', timezone: 'UTC' }
const raw = { id: 'c2-run', name: 'Morning miles', date: '2026-10-18', distance_miles: 5.25, duration_seconds: 2835,
  elevation_gain: 96, calories: 476, avg_heart_rate: 147,
  route_coords: [[40.7128123, -74.0060456, 123.456789], [40.7138123, -74.0070456, 124.456789], [40.715, -74.006, 126]] }
const run = fromRun(raw, prefs)
const lift = fromStrength({ started_at: '2026-10-18', total_seconds: 2526, calories_burned: 326 }, [{ set_number: 1, exercise_name: 'Front Squat', reps: 6, weight_lbs: 155 }], prefs)
const hybrid = fromHybrid(run, lift)
const pr = fromPr({ run_id: raw.id, label: 'Fastest 5 mile', value: 2678, unit: 'seconds', delta: -31 }, run)
const streak = fromStreak({ current_streak: 100,
  week: Array.from({ length: 7 }, (_, i) => ({ hasRun: i % 2 === 0, hasLift: i % 3 === 0 })),
  monthDays: Array.from({ length: 31 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, hasRun: i < 18 && i % 2 === 0, hasLift: i < 18 && i % 3 === 0, isToday: i === 17, isFuture: i > 17 })),
  lifetime: { runs: 83, lifts: 41, distance: { value: 345.67, unit: 'mi' }, volume: { value: 654321, unit: 'lbs' } },
})
const fixtures = { 'iron-chips': run, 'strike-pr': pr, 'hybrid-split': hybrid, trace: run, 'forged-days': { ...run, streak }, 'full-bleed-story': run }
let groups = 0
async function check(name, work) { await work(); groups++; console.log(`PASS ${name}`) }
function capture(id, model, options = {}) {
  const calls = []
  const ctx = new Proxy({
    measureText: value => ({ width: String(value).length * 12 }),
    createLinearGradient: () => ({ addColorStop() {} }),
  }, { get(target, key) { return key in target ? target[key] : (...args) => calls.push([key, ...args]) } })
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
  assert.doesNotMatch(JSON.stringify(ownTree(model)), /40\.7128123|74\.0060456|123\.456789|route_coords|"lat"|"lng"|markers|tiles|rawPoints/)
}
await check('exact six new IDs; every actual legacy ID unreachable in lookup, picker and dispatch', async () => {
  assert.deepEqual(TEMPLATES.map(entry => entry.id), ids)
  const names = ids.slice(3).flatMap(id => ['light', 'dark', 'color'].flatMap(theme => ['feed', 'story'].map(size => `${id}-${theme}-${size}.png`)))
  assert.equal(names.length, 18); assert.equal(new Set(names).size, 18)
  const union = new Set(Object.values(fixtures).flatMap(model => availableShareTemplates(model, { showRoute: true }).map(entry => entry.id)))
  assert.deepEqual([...union].sort(), [...ids].sort())
  for (const id of legacy) {
    assert.equal(TEMPLATES.find(entry => entry.id === id), undefined)
    assert.equal(union.has(id), false)
    await assert.rejects(drawShareCard({}, run, { template: id, size: 'feed', showRoute: true }), /No available template/)
    await assert.rejects(drawShareCard({}, run, { template: id, size: 'feed', showRoute: false }), /No available template/)
  }
})
await check('zero-fit treadmill and sparse lift: no saved preference and each legacy preference safely resolve', () => {
  for (const model of [fromRun({ name: 'Treadmill' }, prefs), fromStrength({}, [], prefs)]) {
    for (const template of [undefined, ...legacy]) for (const showRoute of [true, false]) for (const size of ['feed', 'story']) {
      assert.equal(resolveShareTemplate(model, { template, showRoute, size }), 'full-bleed-story')
      assert.deepEqual(availableShareTemplates(model, { showRoute, size }).map(entry => entry.id), ['full-bleed-story'])
      const result = capture('full-bleed-story', model, { showRoute, size })
      assert.equal(result.markers, 0)
      assert.doesNotMatch(result.text, /DISTANCE|VOLUME|PACE|TIME|ELEVATION|AVG HR|CALORIES|NEW PR|0:00|NaN|undefined|NOT SHARED/)
    }
  }
})
await check('strict route ON/OFF/restoration across exact six designs × three themes × two sizes', () => {
  for (const [id, model] of Object.entries(fixtures)) {
    for (const theme of ['light', 'dark', 'color']) for (const size of ['feed', 'story']) {
      const before = JSON.stringify(model), on = capture(id, model, { theme, size })
      assert.equal(on.markers > 0, ['trace', 'full-bleed-story'].includes(id), id)
      const off = rendererModel(model, false)
      privateAbsent(off)
      const reference = rendererModel({ ...model, run: { ...model.run, route: null, elevationProfile: null } }, true)
      const options = { template: id, showRoute: false, size }
      const selected = resolveShareTemplate(off, options)
      assert.ok(TEMPLATES.find(entry => entry.id === selected)?.supports(off))
      assert.equal(selected === id, id !== 'trace')
      const disabled = capture(selected, off, { theme, size, showRoute: false })
      assert.equal(disabled.markers, 0)
      assert.deepEqual(disabled.calls, capture(selected, reference, { theme, size }).calls)
      assert.deepEqual(capture(id, model, { theme, size }).calls, on.calls)
      assert.equal(JSON.stringify(model), before)
      assert.doesNotMatch(on.text + disabled.text, /^(--|0:00|NaN|undefined|null|NOT SHARED)$/mi)
      if (id === 'trace') assert.throws(() => capture(id, model, { showRoute: false }), /No available template/)
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
  const poison = { ...run, route_coords: raw.route_coords, streak: { ...streak, lat: 40.7128123 } }
  Object.defineProperty(poison, Symbol('route_coords'), { value: raw.route_coords })
  privateAbsent(rendererModel(poison, false))
})
await check('Trace GPS eligibility; real elevation only; every optional stat suppressed; own/null handle', () => {
  const entry = TEMPLATES.find(entry => entry.id === 'trace')
  for (const route of [null, [], [[1, 2]], [[91, 0], [0, 181]], [[true, 0], [0, 0]]]) assert.equal(entry.supports({ ...run, run: { ...run.run, route } }), false)
  assert.equal(entry.supports(run, { showRoute: false }), false)
  assert.equal(entry.supports(hybrid), false)
  assert.equal(entry.supports(run), true)
  assert.match(capture('trace', run, { theme: 'color' }).text, /ELEV GAIN 96 FT/)
  assert.doesNotMatch(capture('trace', { ...run, run: { ...run.run, elevationProfile: null } }, { theme: 'color' }).text, /ELEV GAIN/)
  for (const id of ['trace', 'full-bleed-story']) for (const model of id === 'trace' ? [run] : [run, lift]) {
    for (const stat of model.stats) {
      const reduced = { ...model, stats: model.stats.filter(item => item.key !== stat.key) }
      const result = capture(id, reduced, { theme: 'color' })
      if (stat.key === 'elevation' && id === 'trace') assert.doesNotMatch(result.text, /ELEV GAIN/)
      else assert.ok(!result.text.split('\n').includes(stat.label.toUpperCase()))
    }
    assert.match(capture(id, model).text, /@abc/)
    assert.doesNotMatch(capture(id, { ...model, handle: null }).text, /@/)
  }
})
await check('streak history is allowlisted, real only, cycleable and never inferred from counts/grace', () => {
  const model = fixtures['forged-days']
  assert.deepEqual(streakLayouts(model), ['milestone', 'week', 'month'])
  for (const theme of ['light', 'dark', 'color']) for (const size of ['feed', 'story']) for (const layout of ['milestone', 'week', 'month']) {
    const result = capture('forged-days', model, { theme, size, layout })
    assert.equal(result.markers, 0)
    assert.doesNotMatch(result.text, /^(--|0:00|NaN|undefined|null|NOT SHARED)$/mi)
    assert.match(result.text, layout === 'milestone' ? /MILESTONE/ : layout === 'week' ? /5 OF 7 THIS WEEK/ : /OCTOBER 2026/)
  }
  assert.match(capture('forged-days', model).text, /MILESTONE[\s\S]*100/)
  assert.match(capture('forged-days', model, { layout: 'week' }).text, /5 OF 7 THIS WEEK · 4 RUNS · 3 LIFTS/)
  assert.match(capture('forged-days', model, { layout: 'month' }).text, /OCTOBER 2026/)
  for (const days of [7, 30, 50, 100, 365]) assert.deepEqual(streakLayouts({ ...run, streak: fromStreak({ days }) }), ['milestone'])
  for (const days of [1, 23, 101]) {
    const sparse = { ...run, streak: fromStreak({ days }) }
    assert.deepEqual(streakLayouts(sparse), ['count'])
    const result = capture('forged-days', sparse)
    assert.match(result.text, /FORGED DAYS/)
    assert.doesNotMatch(result.text, /THIS WEEK|RUNS|LIFTS|MILESTONE|OCTOBER/)
    assert.equal(result.calls.filter(call => call[0] === 'arc').length, 0)
  }
  const grace = { ...run, streak: fromStreak({ days: 23, week: Array(7).fill({ qualifies: true, grace: true }) }) }
  assert.deepEqual(streakLayouts(grace), ['count'])
  const partial = { ...run, streak: fromStreak({ days: 23, week: Array(7).fill({ hasRun: false }) }) }
  assert.deepEqual(streakLayouts(partial), ['count'])
  const missing = { ...model, streak: { ...streak, lifetime: null, week: null, monthDays: null } }
  assert.doesNotMatch(capture('forged-days', missing).text, /RUNS|LIFTS|345|654321/)
  for (const days of [0, -1, null, 1.5, NaN, Infinity]) assert.equal(TEMPLATES.find(entry => entry.id === 'forged-days').supports({ ...run, streak: { days } }), false)
})
await check('time PR minute/hour boundaries, invalid suppression, pace and distance/weight unit truth', () => {
  for (const [value, formatted, unit] of [[1, '0:01', 'mm:ss'], [59, '0:59', 'mm:ss'], [60, '1:00', 'mm:ss'], [61, '1:01', 'mm:ss'], [2678, '44:38', 'mm:ss'], [3599, '59:59', 'mm:ss'], [3600, '1:00:00', 'h:mm:ss'], [3601, '1:00:01', 'h:mm:ss'], [3661, '1:01:01', 'h:mm:ss']]) {
    const model = fromPr({ run_id: raw.id, label: 'Fastest 5 mile', value, unit: 'seconds', delta: -31 }, run)
    assert.equal(model.pr.value, formatted); assert.equal(model.pr.unit, unit)
    assert.equal(model.pr.delta, '-0:31')
    const result = capture('strike-pr', model)
    assert.ok(result.text.split('\n').includes(formatted))
    assert.ok(result.text.split('\n').includes(unit))
    // Supplied raw numeric PRs go through the same display boundary.
    assert.equal(rendererModel({ ...run, pr: { label: 'Time PR', value, unit: 'seconds' } }, false).pr.value, formatted)
  }
  for (const value of [undefined, null, '', 'NaN', NaN, Infinity, -1, 0, true, '--', '0:00']) {
    assert.equal(fromPr({ run_id: raw.id, label: 'Time PR', value, unit: 'seconds' }, run).pr, null)
    assert.equal(rendererModel({ ...run, pr: { label: 'Time PR', value, unit: 'seconds' } }, false).pr, null)
  }
  for (const [value, unit, expected, expectedUnit] of [[5.25, 'mi', 5.25, 'mi'], [8.5, 'km', 8.5, 'km'], [155, 'lbs', 155, 'lbs'], [70, 'kg', 70, 'kg'], [7.5, 'min/mi', '7:30', '/mi']]) {
    assert.deepEqual(fromPr({ run_id: raw.id, label: 'Record', value, unit }, run).pr, { label: 'Record', value: expected, unit: expectedUnit, delta: null })
  }
})
console.log(`C2 CONTRACTS OK (${groups} groups; 36 design/theme/size route cases). Browser pixels and platform goldens NOT claimed.`)
