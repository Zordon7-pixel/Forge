import assert from 'node:assert/strict'
import { fromRun, fromPr, fromStrength } from '../src/lib/shareStats.js'
import { activityShareModels, rendererModel, sharePreferences, studioModel } from '../src/lib/shareStudioModel.js'
import { C1_TEMPLATES } from '../src/lib/shareOverlaysC1.js'

const prefs = { timezone: 'America/New_York', friend_handle: 'self', distance_unit: 'mi' }
const run = { id: 'run-a', user_id: 'owner', date: '2026-10-19T03:30:00Z', distance_miles: 5, duration_seconds: 3000,
  route_coords: [[40, -74, 12], [40.01, -74.01, 14]] }
const pr = { id: 'pr-a', user_id: 'owner', run_id: run.id, category: 'time_pr', label: 'Time PR: 5K', value: 2678, unit: 'seconds' }
const session = { id: 'session-a', user_id: 'owner', started_at: '2026-10-18T23:45:00-04:00', ended_at: '2026-10-19T00:05:00-04:00', total_seconds: 1200 }
const set = { id: 'set-a', user_id: 'owner', session_id: session.id, set_number: 1, exercise_name: 'Squat', reps: 5, weight_lbs: 100 }
const context = { run_id: run.id, user_id: 'owner', local_date: '2026-10-18', prs: [pr], sessions: [session], sets: [set], lifts: [] }
const models = (changes = {}, activity = run, preferences = prefs) => activityShareModels(activity, { ...context, ...changes }, preferences, true)
const supports = (id, model) => C1_TEMPLATES.find(item => item.id === id).supports(model)

assert.equal(models().run.pr.value, '44:38')
assert.equal(supports('strike-pr', models().run), true)
for (const row of [null, { ...pr, run_id: 'other' }, { ...pr, user_id: 'foreign' }, { ...pr, run_id: null, lift_id: 'session-a' }, { ...pr, value: null }]) {
  const result = models({ prs: [row] })
  assert.equal(result.run.pr, null)
  assert.equal(supports('strike-pr', result.run), false)
  assert.equal(supports('iron-chips', result.run), true)
}
assert.equal(models({ prs: [{ ...pr, run_id: 'latest-unrelated' }, pr] }).run.pr.value, '44:38')
for (const changes of [{ user_id: 'foreign' }, { run_id: 'other' }, { local_date: '2026-10-19' }]) {
  assert.equal(models(changes).run.pr, null)
  assert.equal(models(changes).hybrid, null)
}
const runShare = fromRun(run, prefs)
for (const [value, expected, unit] of [[59, '00:59', 'mm:ss'], [60, '01:00', 'mm:ss'], [2678, '44:38', 'mm:ss'], [3599, '59:59', 'mm:ss'], [3600, '1:00:00', 'h:mm:ss'], [7325, '2:02:05', 'h:mm:ss'], [36000, '10:00:00', 'h:mm:ss']]) {
  const result = fromPr({ ...pr, value }, runShare)
  assert.deepEqual(result.pr, { label: pr.label, value: expected, unit, delta: null })
  assert.deepEqual(rendererModel(result, true).pr, result.pr, 'preview/export boundary is idempotent')
  assert.equal(rendererModel({ ...runShare, pr: { ...pr, value } }, true).pr.value, expected, 'raw supplied model is formatted too')
}
for (const value of [undefined, null, '', ' ', NaN, Infinity, -Infinity, 'Infinity', 'NaN', 0, -1, false, {}, 'bad', 0.001]) {
  assert.equal(fromPr({ ...pr, value }, runShare).pr, null)
  assert.equal(rendererModel({ ...runShare, pr: { ...pr, value } }, true).pr, null)
}
for (const [unit, value] of [['mi', 6.2], ['km', 10], ['lbs', 225], ['kg', 100], ['reps', 12], ['min/mi', 7.25]]) {
  assert.deepEqual(fromPr({ ...pr, unit, value }, runShare).pr, { label: pr.label, value, unit, delta: null })
}
assert.equal(fromPr({ ...pr, delta: -42 }, runShare).pr.delta, '-0:42')
const legacy = { id: 'lift-a', user_id: 'owner', date: context.local_date, sets: 3, reps: 5, weight_lbs: 100 }
assert.equal(fromPr({ ...pr, run_id: null, lift_id: legacy.id, unit: 'lbs', value: 100 }, fromStrength(legacy, [legacy], prefs)).pr.value, 100)

assert.equal(models().hybrid.kind, 'hybrid')
assert.equal(models().hybrid.dateLabel, '2026-10-18')
assert.equal(supports('hybrid-split', models().hybrid), true)
assert.equal(models().hybrid.lift.stats.find(s => s.key === 'volume').value, '500')
assert.equal(models().hybrid.hero.value, '1:10:00')
assert.equal(models({ sessions: [{ ...session, id: 'another-day', started_at: '2026-10-19T07:00:00Z' }, session] }).hybrid.hero.value, '1:10:00')
for (const changes of [
  { sessions: [], sets: [] },
  { sessions: [{ ...session, started_at: '2026-10-19T05:00:00Z' }] },
  { sessions: [{ ...session, started_at: null }] },
  { sessions: [{ ...session, user_id: 'foreign' }] },
  { sessions: [{ ...session, ended_at: null }] },
  { sessions: [{ ...session, total_seconds: null }], sets: [] },
  { sessions: [{ ...session, total_seconds: null }], sets: [{ ...set, user_id: 'foreign' }] },
  { sessions: [{ ...session, total_seconds: null }], sets: [{ ...set, session_id: 'other' }] },
]) assert.equal(models(changes).hybrid, null)
assert.equal(models({}, null).hybrid, null, 'lift only')
assert.equal(models({}, { ...run, distance_miles: null, duration_seconds: null }).hybrid, null, 'empty run')
assert.equal(models({ sessions: [], sets: [], lifts: [legacy] }).hybrid.kind, 'hybrid')
assert.equal(models({ sessions: [], sets: [], lifts: [{ ...legacy, date: '2026-10-19' }] }).hybrid, null)
assert.equal(models({ sessions: [{ ...session, started_at: '2026-10-19T03:59:59Z' }] }).hybrid.kind, 'hybrid')
assert.equal(models({ sessions: [{ ...session, started_at: '2026-10-19T04:00:00Z' }] }).hybrid, null)
const tokyo = { ...prefs, timezone: 'Asia/Tokyo' }
assert.equal(models({ local_date: '2026-10-19', sessions: [{ ...session, started_at: '2026-10-18T15:00:00Z' }] }, run, tokyo).hybrid.kind, 'hybrid')
assert.equal(models({ local_date: '2026-10-19', sessions: [{ ...session, started_at: '2026-10-18T14:59:59Z' }] }, run, tokyo).hybrid, null)
assert.equal(sharePreferences({ timezone: 'invalid' }, 'Asia/Tokyo').timezone, 'Asia/Tokyo')
const originalIntl = Intl.DateTimeFormat
try {
  Intl.DateTimeFormat = function (...args) { if (!args.length) return { resolvedOptions: () => ({ timeZone: 'America/New_York' }) }; return new originalIntl(...args) }
  assert.equal(models({}, run, { timezone: 'invalid' }).hybrid.kind, 'hybrid', 'device fallback')
  Intl.DateTimeFormat = function (...args) { if (!args.length) return { resolvedOptions: () => ({}) }; return new originalIntl(...args) }
  assert.equal(sharePreferences({ timezone: 'invalid' }).timezone, 'UTC')
} finally { Intl.DateTimeFormat = originalIntl }
for (const invalid of [null, undefined, 'false', 0, new Boolean(false)]) assert.throws(() => activityShareModels(run, context, prefs, invalid), /boolean/)
const off = studioModel({ run, context, prefs, hybrid: true, showRoute: false })
assert.equal(off.run.route, null)
assert.equal(off.run.elevationProfile, null)
assert.deepEqual(Reflect.ownKeys(off), Object.keys(off))
assert.doesNotMatch(JSON.stringify(off), /user_id|run_id|session_id|route_coords|40\.01|-74/)
assert.equal(studioModel({ run, context, prefs, hybrid: true, showRoute: true }).run.route.length, 2)
console.log('ACTIVITY SHARE ENTRY OK (exact linkage/owner, time boundaries, non-time units, same-local-day/empty-side/timezone/privacy negatives)')
