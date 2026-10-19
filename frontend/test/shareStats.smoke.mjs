import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { fromRun, fromStrength, fromHybrid, fromPr, fromStreak } from '../src/lib/shareStats.js'

const require = createRequire(import.meta.url)
const { reconciliationKey } = require('../../backend/src/lib/hybridReconciliation.js')
let checks = 0
const outputs = []
function check(name, work) {
  work()
  checks++
  console.log(`PASS ${name}`)
}
function clean(value) {
  if (typeof value === 'string') {
    assert.notEqual(value.trim(), '', 'no empty output strings')
    assert.doesNotMatch(value, /^(--|0:00|NaN|undefined|null|NOT SHARED)$/)
    assert.doesNotMatch(value, /forgedhybrid/i)
  } else if (typeof value === 'number') assert.ok(Number.isFinite(value), 'finite output numbers')
  else if (value && typeof value === 'object') Object.values(value).forEach(clean)
  else assert.notEqual(value, undefined, 'no undefined output values')
}
function output(model, keys) {
  outputs.push(model)
  clean(model)
  clean(JSON.parse(JSON.stringify(model)))
  if (keys) assert.deepEqual(model.stats.map(item => item.key), keys)
  for (const item of model?.stats || []) {
    assert.equal(typeof item.value, 'string')
    assert.deepEqual(Object.keys(item).sort(), (item.unit ? ['key', 'label', 'unit', 'value'] : ['key', 'label', 'value']))
  }
  return model
}
const value = (model, key) => model.stats.find(stat => stat.key === key)?.value
const stat = (model, key) => model.stats.find(stat => stat.key === key)
const mi = Object.freeze({ distance_unit: 'mi', friend_handle: 'abc' })
const km = Object.freeze({ distance_unit: 'km', friend_handle: null })
const run = Object.freeze({
  id: 'run-1', name: 'Morning miles', date: '2026-10-18T23:45:00-04:00',
  distance_miles: 5, duration_seconds: 3000, elevation_gain: 100, calories: 450,
  avg_heart_rate: 145, route_coords: JSON.stringify([[40, -73, 10], [40.1, -73.1, 12]]),
})
const session = Object.freeze({
  id: 'session-1', notes: 'Lower body', started_at: '2026-10-18T08:00:00-04:00',
  ended_at: '2026-10-18T08:40:00-04:00', total_seconds: 2400, calories_burned: 250, avg_heart_rate: 120,
})
const sets = Object.freeze([
  { id: 'set-1', session_id: session.id, exercise_name: 'Squat', set_number: 1, reps: 5, weight_lbs: 225 },
  { id: 'set-2', session_id: session.id, exercise_name: 'Squat', set_number: 2, reps: 5, weight_lbs: 225 },
  { id: 'set-3', session_id: session.id, exercise_name: 'Row', set_number: 3, reps: 10, weight_lbs: 100 },
].map(Object.freeze))
const runKeys = ['distance', 'pace', 'time', 'elevation', 'calories', 'avgHr']
const liftKeys = ['volume', 'sets', 'reps', 'topSet', 'time', 'calories', 'avgHr', 'topLifts']
const runShare = output(fromRun(run, mi), runKeys)
const liftShare = output(fromStrength(session, sets, mi), liftKeys)

function freezeOwn(value) {
  if (value && typeof value === 'object') {
    Reflect.ownKeys(value).forEach(key => freezeOwn(Object.getOwnPropertyDescriptor(value, key).value))
    Object.freeze(value)
  }
  return value
}

// Walk descriptors and symbols, not just enumerable JSON properties. Keep key
// names and descriptor flags in the snapshot so hidden side channels are tested.
function ownSnapshot(value) {
  if (!value || typeof value !== 'object') return value
  return Reflect.ownKeys(value).map(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    assert.equal(descriptor.get, undefined, 'no hidden getter retaining source geometry')
    assert.equal(descriptor.set, undefined, 'no hidden setter retaining source geometry')
    return [String(key), { ...descriptor, value: ownSnapshot(descriptor.value) }]
  })
}

const privateRoute = freezeOwn([[40.7128123, -74.0060456, 123.456789], [40.7138123, -74.0070456, 124.456789]])
function routeAbsent(model) {
  assert.equal(model.run.route, null)
  assert.equal(model.run.elevationProfile, null)
  for (const serialized of [JSON.stringify(model), JSON.stringify(ownSnapshot(model))]) {
    assert.doesNotMatch(serialized, /40\.7128123|74\.0060456|40\.7138123|74\.0070456|123\.456789|124\.456789/)
    assert.doesNotMatch(serialized, /route_coords|"lat"|"lng"|"lon"|geometry|markers|tiles|rawPoints|originalCoordinates/)
  }
}

check('route defaults ON; explicit OFF strips every own descriptor and restores only from caller source', () => {
  const source = { ...run, route_coords: privateRoute, markers: privateRoute, tiles: privateRoute }
  Object.defineProperty(source, 'rawPoints', { value: privateRoute })
  Object.defineProperty(source, Symbol('originalCoordinates'), { value: privateRoute })
  freezeOwn(source)
  const before = ownSnapshot(source)
  const defaultOn = output(fromRun(source, km), runKeys)
  assert.deepEqual(defaultOn.run.route, privateRoute.map(point => point.slice(0, 2)))
  assert.deepEqual(defaultOn.run.elevationProfile, privateRoute.map(point => point[2]))
  for (const options of [undefined, {}, { showRoute: true }, { showRoute: null }, { showRoute: 0 }]) {
    assert.deepEqual(output(fromRun(source, km, options)), defaultOn, 'only explicit false disables route')
  }
  const off = output(fromRun(source, km, Object.freeze({ showRoute: false })), runKeys)
  routeAbsent(off)
  routeAbsent(output(fromPr({ label: 'Longest Run', value: 5, unit: 'mi', run_id: run.id }, off)))
  assert.deepEqual(output(fromRun(source, km, { showRoute: true })), defaultOn)
  assert.deepEqual(ownSnapshot(source), before, 'raw source and its hidden keys stay untouched')
  const unreadable = { ...run, get route_coords() { throw new Error('OFF read raw geometry') } }
  routeAbsent(output(fromRun(unreadable, km, { showRoute: false })))
  for (const options of [undefined, { showRoute: true }, { showRoute: false }]) {
    const treadmill = output(fromRun({ ...run, route_coords: null, elevation_gain: null }, km, options))
    routeAbsent(treadmill)
    assert.equal(value(treadmill, 'elevation'), undefined)
  }
})

check('hybrid OFF sanitizes enabled input without mutation; ON cannot recover absent geometry', () => {
  const enabled = fromRun({ ...run, route_coords: privateRoute }, km)
  // Export-facing extras must not hitch a ride on the run block or root.
  Object.defineProperty(enabled.run, 'rawPoints', { value: privateRoute })
  Object.defineProperty(enabled.run, Symbol('geometry'), { value: privateRoute })
  enabled.route_coords = privateRoute
  const meta = enabled[Object.getOwnPropertySymbols(enabled)[0]]
  Object.defineProperty(meta.runIds, Symbol('originalCoordinates'), { value: privateRoute })
  freezeOwn(enabled)
  const before = ownSnapshot(enabled)
  const lift = freezeOwn(fromStrength(session, sets, km))
  const off = output(fromHybrid(enabled, lift, { showRoute: false }), ['totalTime', 'calories'])
  routeAbsent(off)
  assert.deepEqual(ownSnapshot(enabled), before)
  assert.notEqual(off.run, enabled.run)
  assert.notEqual(off.run.stats, enabled.run.stats)
  for (const options of [undefined, {}, { showRoute: true }]) {
    const on = output(fromHybrid(enabled, lift, options))
    assert.equal(on.run, enabled.run)
    assert.deepEqual(on.run.route, privateRoute.map(point => point.slice(0, 2)))
    routeAbsent(output(fromHybrid(fromRun({ ...run, route_coords: privateRoute }, km, { showRoute: false }), lift, options)))
  }
})

check('full run and explicit public contract', () => {
  assert.deepEqual(Object.keys(runShare).sort(), ['dateLabel', 'handle', 'hero', 'kind', 'pr', 'run', 'stats', 'title', 'unit'])
  assert.equal(runShare.title, run.name)
  assert.equal(runShare.dateLabel, '2026-10-18')
  assert.equal(runShare.handle, '@abc')
  assert.equal(runShare.hero, stat(runShare, 'distance'))
  assert.equal(value(runShare, 'distance'), '5')
  assert.equal(value(runShare, 'pace'), '10:00')
  assert.equal(value(runShare, 'time'), '50:00')
  assert.deepEqual(runShare.run.route, [[40, -73], [40.1, -73.1]])
  assert.equal(runShare.run.elevationProfile.length, 2)
  assert.equal(runShare.run.stats, runShare.stats)
  assert.equal(runShare.pr, null)
})

check('treadmill without route/elevation and no-HR run', () => {
  const treadmill = output(fromRun({ ...run, route_coords: null, elevation_gain: null }, mi), ['distance', 'pace', 'time', 'calories', 'avgHr'])
  assert.equal(treadmill.run.route, null)
  assert.equal(treadmill.run.elevationProfile, null)
  output(fromRun({ ...run, avg_heart_rate: null }, mi), ['distance', 'pace', 'time', 'elevation', 'calories'])
  assert.equal(value(output(fromRun({ ...run, avg_heart_rate: null, avg_hr: 140 }, mi), runKeys), 'avgHr'), '140')
})

check('mi/km distance, pace, elevation and handle semantics', () => {
  const model = output(fromRun(run, km), runKeys)
  assert.equal(model.unit, 'km')
  assert.equal(value(model, 'distance'), '8.05')
  assert.equal(value(model, 'pace'), '6:13')
  assert.equal(stat(model, 'pace').unit, '/km')
  assert.equal(value(model, 'elevation'), '30')
  assert.equal(stat(model, 'elevation').unit, 'm')
  assert.deepEqual(model.run.elevationProfile, [10, 12])
  assert.equal(model.handle, null)
  assert.ok(!JSON.stringify(model).includes('@'))
  for (const friend_handle of ['abc', '@abc', '@@@abc', ' @@abc ']) {
    assert.equal(output(fromRun(run, { ...mi, friend_handle })).handle, '@abc')
  }
  for (const friend_handle of [null, undefined, '', '@', 'a@b', 'forgedhybrid', '@FORGEDHYBRID']) {
    assert.equal(output(fromRun({}, { friend_handle, handle: 'not-an-own-handle', email: 'private@example.com' }), []).handle, null)
  }
  assert.equal(output(fromRun(run, { units: 'metric' })).unit, 'km')
  assert.equal(output(fromRun(run, { distance_unit: 'mi', units: 'metric' })).unit, 'mi')
  output(fromRun({ ...run, elevation_gain: 3 }, km), ['distance', 'pace', 'time', 'calories', 'avgHr'])
  output(fromRun({ ...run, elevation_gain: 0.99 }, mi), ['distance', 'pace', 'time', 'calories', 'avgHr'])
  output(fromRun({ ...run, elevation_gain: 1 }, mi), runKeys)
})

check('numeric filtering, tiny measurements and malformed route data', () => {
  for (const bad of [null, undefined, '', ' ', 0, -1, NaN, Infinity, 'NaN', 'bad', true, [], {}]) {
    output(fromRun({ distance_miles: bad, duration_seconds: bad, elevation_gain: bad, calories: bad, avg_hr: bad }), [])
  }
  output(fromRun({ distance_miles: 0.00001, duration_seconds: 0.001, calories: 0.001 }), ['distance', 'pace', 'time', 'calories'])
  output(fromRun({ distance_miles: '2', duration_seconds: '1200' }), ['distance', 'pace', 'time'])
  for (const raw of ['bad json', '{}', null, [[null, null]], [[true, 0]], [[91, 0]]]) {
    assert.equal(output(fromRun({ ...run, route_coords: raw })).run.route, null)
  }
  assert.deepEqual(output(fromRun({ ...run, route_coords: [{ lat: 0, lng: 0, alt: 0 }] })).run.route, [[0, 0]])
  assert.equal(output(fromRun({ date: '2026-02-30', name: '--' }), []).dateLabel, null)
  assert.equal(output(fromRun({ name: 'NOT SHARED' }), []).title, null)
})

check('workout_sets totals, heaviest set and top lifts', () => {
  assert.equal(value(liftShare, 'volume'), '3250')
  assert.equal(value(liftShare, 'sets'), '3')
  assert.equal(value(liftShare, 'reps'), '20')
  assert.equal(value(liftShare, 'topSet'), '225 × 5')
  assert.equal(value(liftShare, 'time'), '40:00')
  assert.equal(liftShare.hero, stat(liftShare, 'volume'))
  assert.equal(liftShare.lift.stats, liftShare.stats)
  assert.deepEqual(liftShare.lift.topLifts, [
    { name: 'Squat', scheme: '2 × 5', weight: '225 lbs' },
    { name: 'Row', scheme: '1 × 10', weight: '100 lbs' },
  ])
  const model = output(fromStrength(session, sets, km), liftKeys)
  assert.equal(value(model, 'volume'), '1474.2')
  assert.equal(value(model, 'topSet'), '102.1 × 5')
  assert.equal(stat(model, 'volume').unit, 'kg')
  assert.equal(stat(model, 'topSet').unit, 'kg')
  assert.equal(model.lift.topLifts[0].weight, '102.1 kg')
})

check('lift title uses explicit name/title only, never free-text notes', () => {
  assert.equal(liftShare.title, null)
  assert.equal(output(fromStrength({ ...session, notes: 'Private recovery notes' }, sets, mi)).title, null)
  assert.equal(output(fromStrength({ ...session, name: 'Leg day' }, sets, mi)).title, 'Leg day')
  assert.equal(output(fromStrength({ ...session, title: 'Upper body' }, sets, mi)).title, 'Upper body')
  assert.doesNotMatch(JSON.stringify(fromHybrid(runShare, liftShare)), /Lower body/)
})

check('bodyweight/missing/nonpositive weights retain real reps', () => {
  const rows = [null, undefined, 0, -10, '', NaN].map(weight_lbs => ({ exercise_name: 'Push-up', reps: 10, weight_lbs }))
  const model = output(fromStrength({}, rows), ['sets', 'reps'])
  assert.equal(value(model, 'sets'), '6')
  assert.equal(value(model, 'reps'), '60')
  assert.equal(model.hero, null)
  assert.deepEqual(model.lift.topLifts, [])
  const mixed = output(fromStrength({}, [...sets, ...rows]), ['volume', 'sets', 'reps', 'topSet', 'topLifts'])
  assert.equal(value(mixed, 'volume'), '3250')
  assert.equal(value(mixed, 'reps'), '80')
  output(fromStrength({}, [{ exercise_name: 'Squat', weight_lbs: 300, reps: null }]), ['sets'])
})

check('top lifts rank by exercise volume, cap at three, preserve actual schemes', () => {
  const rows = [
    { exercise_name: 'Squat', reps: 5, weight_lbs: 225 },
    { exercise_name: 'Squat', reps: 8, weight_lbs: 100 },
    { exercise_name: 'Row', reps: 20, weight_lbs: 100 },
    { exercise_name: 'Press', reps: 10, weight_lbs: 80 },
    { exercise_name: 'Curl', reps: 10, weight_lbs: 20 },
    { exercise_name: 'No reps', reps: 0, weight_lbs: 900 },
  ]
  const model = output(fromStrength({}, rows), ['volume', 'sets', 'reps', 'topSet', 'topLifts'])
  assert.deepEqual(model.lift.topLifts.map(lift => lift.name), ['Row', 'Squat', 'Press'])
  assert.deepEqual(model.lift.topLifts[1], { name: 'Squat', scheme: '1 × 5', weight: '225 lbs' })
  assert.equal(value(model, 'topSet'), '225 × 5')
})

check('session duration only comes from total_seconds, including null/absent/empty/zero', () => {
  const { total_seconds, ...absent } = session
  for (const input of [absent, ...[null, undefined, '', ' ', 0, -1, Infinity, NaN].map(total_seconds => ({ ...session, total_seconds }))]) {
    const model = output(fromStrength({ ...input, completed_at: session.ended_at, created_at: session.started_at, workout_duration_seconds: 3000 }, sets, mi), ['volume', 'sets', 'reps', 'topSet', 'calories', 'avgHr', 'topLifts'])
    assert.equal(value(model, 'time'), undefined)
    const hybrid = output(fromHybrid(runShare, model), ['calories'])
    assert.equal(hybrid.hero, null)
  }
})

const legacyRows = Object.freeze([
  { id: 'lift-1', date: '2026-10-18', exercise_name: 'Squat', sets: 3, reps: 5, weight_lbs: 200, workout_duration_seconds: 1800, calories: 200, avg_heart_rate: 110 },
  { id: 'lift-2', date: '2026-10-18', exercise_name: 'Press', sets: 2, reps: 10, weight_lbs: 50, workout_duration_seconds: 1800, calories: 200, avg_heart_rate: 110 },
  { id: 'lift-3', date: '2026-10-18', exercise_name: 'Pull-up', sets: 2, reps: 6, weight_lbs: null, workout_duration_seconds: 1800, calories: 200, avg_heart_rate: 110 },
].map(Object.freeze))
const legacy = output(fromStrength(null, legacyRows, mi), liftKeys)
check('legacy lifts multiply sets × reps × weight without duplicating workout totals', () => {
  assert.equal(value(legacy, 'volume'), '4000')
  assert.equal(value(legacy, 'sets'), '7')
  assert.equal(value(legacy, 'reps'), '47')
  assert.equal(value(legacy, 'time'), '30:00')
  assert.equal(value(legacy, 'calories'), '200')
  assert.equal(value(legacy, 'topSet'), '200 × 5')
  const metric = output(fromStrength(legacyRows[0], legacyRows, km), liftKeys)
  assert.equal(value(metric, 'volume'), '1814.4')
  assert.equal(value(metric, 'topSet'), '90.7 × 5')
  assert.deepEqual(metric.lift.topLifts[0], { name: 'Squat', scheme: '3 × 5', weight: '90.7 kg' })
  output(fromStrength(null, [legacyRows[0], { ...legacyRows[1], workout_duration_seconds: 900, calories: null, avg_heart_rate: 120 }]), ['volume', 'sets', 'reps', 'topSet', 'topLifts'])
})

check('hybrid keeps both blocks, real totals and metadata private', () => {
  const model = output(fromHybrid(runShare, liftShare), ['totalTime', 'calories'])
  assert.equal(model.kind, 'hybrid')
  assert.equal(model.run, runShare.run)
  assert.equal(model.lift, liftShare.lift)
  assert.equal(value(model, 'totalTime'), '1:30:00')
  assert.equal(value(model, 'calories'), '700')
  assert.equal(model.hero, stat(model, 'totalTime'))
  assert.equal(output(fromHybrid(runShare, output(fromStrength({ ...session, calories_burned: null }, sets, mi))), ['totalTime']).stats.length, 1)
  const unknownRun = output(fromRun({ ...run, duration_seconds: null, calories: null }, mi))
  assert.equal(output(fromHybrid(unknownRun, liftShare), []).hero, null)
  for (const activity of [runShare, liftShare, legacy, model]) {
    assert.equal(Object.getOwnPropertySymbols(activity).length, 1)
    const symbol = Object.getOwnPropertySymbols(activity)[0]
    assert.equal(Object.getOwnPropertyDescriptor(activity, symbol).enumerable, false)
    assert.equal(Object.getOwnPropertySymbols({ ...activity }).length, 0)
    assert.doesNotMatch(JSON.stringify(activity), /runIds|liftIds|seconds|run-1|session-1|lift-1/)
  }
})

check('hybrid rejects empty sides, missing dates, mismatched local dates and units', () => {
  const emptyRun = output(fromRun({ date: run.date }, mi), [])
  const emptyLift = output(fromStrength({ started_at: session.started_at }, [], mi), [])
  for (const pair of [[emptyRun, liftShare], [runShare, emptyLift], [null, liftShare], [runShare, null], [liftShare, runShare], [fromRun({ distance_miles: 1 }), liftShare], [runShare, fromStrength(session, sets, km)]]) {
    assert.equal(output(fromHybrid(...pair)), null)
  }
  const nextDay = output(fromStrength({ ...session, started_at: '2026-10-19T03:45:00Z' }, sets, mi))
  assert.equal(output(fromHybrid(runShare, nextDay)), null, 'same UTC instant is not the same local-date key')
  assert.equal(runShare.dateLabel, reconciliationKey(run.date, 'lift').slice(0, 10))
  const sameLocalDay = output(fromStrength({ ...session, started_at: '2026-10-18T00:10:00+14:00' }, sets, mi))
  assert.ok(output(fromHybrid(runShare, sameLocalDay), ['totalTime', 'calories']))
  const mixedDates = output(fromStrength(null, [legacyRows[0], { ...legacyRows[1], date: '2026-10-19' }], mi))
  assert.equal(output(fromHybrid(runShare, mixedDates)), null)
})

function dateWitness() {
  const prefs = { timezone: 'America/New_York' }
  const rows = [{ session_id: 's', reps: 5, weight_lbs: 100 }]
  const pair = (runDate, liftDate, preferences = prefs) => {
    const run = fromRun({ date: runDate, distance_miles: 1 }, preferences)
    const lift = fromStrength({ started_at: liftDate }, rows, preferences)
    return [run.dateLabel, lift.dateLabel, Boolean(fromHybrid(run, lift))]
  }
  return [
    pair('2026-10-18T23:45:00-04:00', '2026-10-19T03:45:00Z'),
    pair('2026-10-19T03:45:00Z', '2026-10-18'),
    pair('2026-10-19T03:45:00Z', '2026-10-19T04:00:00Z'),
    pair('2026-10-18', '2026-10-18T00:10:00+14:00'),
    pair('2026-10-18T00:10:00+14:00', '2026-10-18T23:50:00-12:00'),
    pair('2026-10-18T23:45:00-04:00', '2026-10-19T03:45:00Z', { timezone: 'invalid/timezone' }),
    pair('2026-10-18T23:45:00-04:00', '2026-10-19T03:45:00Z', {}),
    pair('2026-10-18', '2026-10-18T03:45:00Z', { timezone: '' }),
    pair('2026-01-18T23:45:00-05:00', '2026-01-19T04:45:00Z'),
  ]
}

check('hybrid uses explicit user-local calendar dates with deterministic prefix fallback', () => {
  const same = ['2026-10-18', '2026-10-18', true]
  const different = ['2026-10-18', '2026-10-19', false]
  assert.deepEqual(dateWitness(), [same, same, different, same, same, different, different, same, ['2026-01-18', '2026-01-18', true]])
  for (const date of ['2026-10-18', '2026-10-18T00:10:00+14:00']) {
    assert.equal(fromRun({ date }, { timezone: 'America/New_York' }).dateLabel, reconciliationKey(date, 'lift').slice(0, 10))
  }
  assert.equal(fromRun({ date: '2026-10-19T03:45:00Z' }, { local_date: '2026-10-18' }).dateLabel, '2026-10-18')
  assert.equal(fromRun({ local_date: '2026-10-18', date: '2026-10-19T03:45:00Z' }).dateLabel, '2026-10-18')
  assert.equal(fromRun({ date: '2026-10-19T03:45:00Z' }, { local_date: '2026-02-30' }).dateLabel, '2026-10-19')
  const prefs = { timezone: 'America/New_York' }
  const localLegacy = fromStrength(null, [
    { ...legacyRows[0], date: '2026-10-18' },
    { ...legacyRows[1], date: '2026-10-19T03:45:00Z' },
  ], prefs)
  assert.ok(fromHybrid(fromRun(run, prefs), localLegacy))
  assert.equal(fromStrength(null, [
    { ...legacyRows[0], date: '2026-10-18' },
    { ...legacyRows[1], date: '2026-10-19T04:00:00Z' },
  ], prefs).dateLabel, null)
})

check('local calendar pairing is independent of host TZ', () => {
  const moduleUrl = new URL('../src/lib/shareStats.js', import.meta.url).href
  const script = `import { fromRun, fromStrength, fromHybrid } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify((${dateWitness.toString()})()))`
  for (const TZ of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
    const result = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { TZ }, encoding: 'utf8' })
    assert.deepEqual(JSON.parse(result), dateWitness(), TZ)
  }
})

const pr = Object.freeze({ label: 'Longest Run', value: 5, unit: 'mi', run_id: run.id, delta: 0.5 })
check('PR requires exact linked row; copies retain all non-enumerable metadata', () => {
  const model = output(fromPr(pr, runShare), runKeys)
  assert.notEqual(model, runShare)
  assert.deepEqual(model.pr, { label: pr.label, value: 5, unit: 'mi', delta: 0.5 })
  assert.equal(runShare.pr, null)
  const symbol = Object.getOwnPropertySymbols(runShare)[0]
  assert.deepEqual(Object.getOwnPropertyDescriptor(model, symbol), Object.getOwnPropertyDescriptor(runShare, symbol))
  output(fromHybrid(model, liftShare), ['totalTime', 'calories'])
  for (const row of [null, undefined, { ...pr, run_id: null }, { ...pr, run_id: 'other' }, { ...pr, value: 0 }, { ...pr, label: '--' }, { ...pr, unit: '' }]) {
    assert.equal(output(fromPr(row, model)).pr, null)
  }
  const liftPr = { label: 'Squat', value: 200, unit: 'lbs', lift_id: 'lift-1' }
  assert.deepEqual(output(fromPr(liftPr, legacy)).pr, { label: 'Squat', value: 200, unit: 'lbs', delta: null })
  for (const lift_id of ['session-1', 'set-1', 'lift-1']) assert.equal(output(fromPr({ ...liftPr, lift_id }, liftShare)).pr, null)
  assert.equal(output(fromPr(liftPr, runShare)).pr, null)
  assert.ok(output(fromPr(liftPr, fromHybrid(runShare, legacy))).pr)
  assert.equal(output(fromPr({ ...pr, delta: '-0:42' }, runShare)).pr.delta, '-0:42')
  assert.equal(output(fromPr({ ...pr, delta: 'NOT SHARED' }, runShare)).pr.delta, null)
  assert.equal(output(fromPr(pr, null)), null)
})

check('streak 0/23/100, exact attained milestones, no fabricated history', () => {
  assert.equal(output(fromStreak({ current_streak: 0 })), null)
  assert.deepEqual(output(fromStreak({ current_streak: 23, next_milestone: 30 })), { days: 23, week: null, monthDays: null, milestone: null })
  assert.deepEqual(output(fromStreak({ current_streak: 100 })), { days: 100, week: null, monthDays: null, milestone: 100 })
  for (const days of [7, 30, 50, 100, 365]) assert.equal(output(fromStreak({ current_streak: days })).milestone, days)
  assert.equal(output(fromStreak({ current_streak: 101 })).milestone, null)
  assert.equal(output(fromStreak({ current_streak: 23, milestone_just_hit: 14 })).milestone, 14)
  assert.equal(output(fromStreak({ current_streak: 23, milestone_just_hit: 30 })).milestone, null)
  for (const current_streak of [null, '', -1, NaN, Infinity, true, 1.5]) assert.equal(output(fromStreak({ current_streak })), null)
})

check('streak preserves only supplied per-day flags; week must have seven real entries', () => {
  const week = Object.freeze([true, false, true, false, false, true, false])
  const monthDays = Object.freeze([
    Object.freeze({ date: '2026-10-01', hasRun: true, hasLift: false }),
    Object.freeze({ date: '2026-10-02', hasRun: false, hasLift: true }),
  ])
  const model = output(fromStreak({ current_streak: 23, week, monthDays }))
  assert.deepEqual(model.week, week)
  assert.deepEqual(model.monthDays, monthDays)
  assert.notEqual(model.week, week)
  assert.notEqual(model.monthDays[0], monthDays[0])
  for (const invalid of [[], [true], [...week, true], [true, true, true, true, true, true, null], Array(7), Array(7).fill({ date: '2026-10-01' })]) {
    assert.equal(output(fromStreak({ current_streak: 23, week: invalid })).week, null)
  }
  const history = output(fromStreak({ currentStreak: 23, monthDays: [{ date: '2026-10-01', actualTypes: [], qualifies: true, grace: true }] }))
  assert.deepEqual(history.monthDays, [{ date: '2026-10-01', qualifies: true, grace: true, hasRun: false, hasLift: false }])
  assert.equal(output(fromStreak({ current_streak: 23, monthDays: [{ actualTypes: Array(1) }] })).monthDays, null)
  const attached = output({ ...runShare, streak: model })
  assert.equal(attached.streak.days, 23)
})

check('streak lifetime exposes only explicitly supplied positive totals with known source units', () => {
  // Current endpoint shape: no lifetime payload. Extra totals below are an
  // explicit optional adapter input contract, not fields claimed from the API.
  const endpoint = freezeOwn({ current_streak: 100, longest_streak: 100, next_milestone: 180,
    days_to_next: 80, milestone_just_hit: 100, earned_milestones: [7, 14, 30, 60, 90] })
  assert.equal('lifetime' in output(fromStreak(endpoint)), false)
  const totals = freezeOwn({ runs: 83, lifts: '41', distance: { value: 345.67, unit: 'mi' }, volume: { value: 654321, unit: 'lbs' } })
  const before = ownSnapshot(totals)
  const model = output(fromStreak({ ...endpoint, lifetime: totals }))
  assert.deepEqual(model.lifetime, [
    { key: 'runs', label: 'Runs', value: '83' },
    { key: 'lifts', label: 'Lifts', value: '41' },
    { key: 'distance', label: 'Distance', value: '345.67', unit: 'mi' },
    { key: 'volume', label: 'Volume', value: '654321', unit: 'lbs' },
  ])
  assert.deepEqual(ownSnapshot(totals), before)
  assert.deepEqual(output(fromStreak({ ...endpoint, lifetime: {
    runs: 7, lifts: 0, distance: { value: 21.1, unit: 'km' }, volume: { value: null, unit: 'kg' },
  } })).lifetime, [
    { key: 'runs', label: 'Runs', value: '7' },
    { key: 'distance', label: 'Distance', value: '21.1', unit: 'km' },
  ])
  assert.deepEqual(output(fromStreak({ ...endpoint, lifetime: { volume: { value: 452.5, unit: 'kg' } } })).lifetime,
    [{ key: 'volume', label: 'Volume', value: '452.5', unit: 'kg' }])
  for (const bad of [null, undefined, '', ' ', 0, -1, NaN, Infinity, 'NaN', 'bad', true, [], {}]) {
    const lifetime = { runs: bad, lifts: bad, distance: { value: bad, unit: 'mi' }, volume: { value: bad, unit: 'lbs' } }
    assert.equal('lifetime' in output(fromStreak({ ...endpoint, lifetime })), false)
    const partial = output(fromStreak({ ...endpoint, lifetime: { ...lifetime, lifts: 3 } }))
    assert.deepEqual(partial.lifetime, [{ key: 'lifts', label: 'Lifts', value: '3' }])
  }
  for (const lifetime of [null, {}, { runs: 1.5, lifts: 0.2 }, { distance: 12, volume: 123 },
    { distance: { value: 12 }, volume: { value: 123, unit: 'unknown' } }]) {
    assert.equal('lifetime' in output(fromStreak({ ...endpoint, lifetime })), false)
  }
  assert.equal('lifetime' in output(fromStreak({ ...endpoint,
    week: Array(7).fill(true), monthDays: [{ hasRun: true, hasLift: true }],
    total_runs: 99, total_volume: 999, // Unsupported aliases must not invent endpoint fields/units.
  })), false)
})

check('all fixtures are recursively clean, deterministic and leave frozen inputs intact', () => {
  outputs.forEach(clean)
  assert.deepEqual(fromRun(run, mi), runShare)
  assert.deepEqual(fromStrength(session, sets, mi), liftShare)
  assert.deepEqual(fromStrength(null, legacyRows, mi), legacy)
})

console.log(`SHARE STATS SMOKE OK (${checks} groups, ${outputs.length} recursively checked outputs)`)
