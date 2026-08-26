import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  buildTomorrowPlan,
  localTomorrowDateISO,
  millisecondsUntilTomorrowTransition,
  shouldPromoteTomorrow,
} from '../src/lib/tomorrowPlan.js'
import { buildWeekDays } from '../src/lib/planCalendar.js'

const read = (relativePath) => fs.readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8')

const beforeSix = new Date(2026, 7, 25, 17, 59, 59, 500)
const atSix = new Date(2026, 7, 25, 18, 0, 0, 0)
assert.equal(shouldPromoteTomorrow(beforeSix), false, '17:59 local does not promote Tomorrow')
assert.equal(shouldPromoteTomorrow(atSix), true, '18:00 local promotes Tomorrow')
assert.equal(millisecondsUntilTomorrowTransition(beforeSix), 500, 'the transition timer lands on 18:00 without a reload')

const beforeRollover = new Date(2026, 11, 31, 23, 59, 59, 500)
const afterRollover = new Date(2027, 0, 1, 0, 0, 0, 0)
assert.equal(localTomorrowDateISO(beforeRollover), '2027-01-01', 'local tomorrow crosses the year boundary without UTC math')
assert.equal(localTomorrowDateISO(afterRollover), '2027-01-02', 'local tomorrow advances at device-local midnight')
assert.equal(millisecondsUntilTomorrowTransition(beforeRollover), 500, 'the evening timer re-evaluates at local midnight')
assert.equal(shouldPromoteTomorrow(afterRollover), false, 'the evening promotion closes after local midnight')

const run = {
  id: 'run-accepted-1',
  kind: 'run',
  title: 'Progressive Aerobic Run — exact',
  distance_miles: '4.250',
  duration_min: 47,
  description: 'Build control before the quality day.',
}
const lift = {
  id: 'lift-accepted-1',
  kind: 'lift',
  title: 'Upper Strength / Pull',
  load_summary: '3 x 5 @ 135 lb',
}
const acceptedHybrid = {
  hasPlan: true,
  hasDay: true,
  isRest: false,
  date: '2026-08-26',
  day: 'Wed',
  phase: 'BASE_2',
  sessions: [run, lift],
}
const acceptedBefore = structuredClone(acceptedHybrid)
const hybrid = buildTomorrowPlan(acceptedHybrid, '2026-08-26')
assert.equal(hybrid.status, 'training')
assert.equal(hybrid.identity, 'hybrid', 'run + lift keeps its hybrid identity')
assert.equal(hybrid.dateISO, acceptedHybrid.date)
assert.match(hybrid.dateLabel, /Wednesday/, 'the exact local calendar date receives a localized weekday')
assert.deepEqual(hybrid.sessions.map((session) => session.title), [run.title, lift.title], 'session titles stay byte-for-value')
assert.deepEqual(hybrid.sessions[0].metrics, [
  { key: 'duration', value: run.duration_min, unit: 'min' },
  { key: 'distance', value: run.distance_miles, unit: 'mi' },
], 'run duration and distance retain exact accepted values')
assert.deepEqual(hybrid.sessions[1].metrics, [
  { key: 'load', value: lift.load_summary, unit: null },
], 'lift load retains the exact accepted value')
assert.equal(hybrid.phase, acceptedHybrid.phase)
assert.equal(hybrid.reason, run.description)
assert.deepEqual(acceptedHybrid, acceptedBefore, 'Tomorrow presentation never mutates accepted plan data')

const absentMetrics = buildTomorrowPlan({
  hasPlan: true,
  hasDay: true,
  isRest: false,
  date: '2026-08-26',
  sessions: [{ id: 'run-no-values', kind: 'run', title: 'Easy run' }],
}, '2026-08-26')
assert.deepEqual(absentMetrics.sessions[0].metrics, [], 'absent accepted values stay absent')

const rest = buildTomorrowPlan({
  hasPlan: true,
  hasDay: true,
  isRest: true,
  isPlannedRest: true,
  date: '2026-08-26',
  phase: 'Recovery',
  sessions: [],
}, '2026-08-26')
assert.equal(rest.status, 'rest')
assert.equal(rest.identity, 'rest')
assert.equal(rest.title, 'Rest day', 'authored rest is stated plainly')
assert.deepEqual(rest.sessions, [])

for (const missing of [
  null,
  { hasPlan: false, hasDay: false, sessions: [] },
  { hasPlan: true, hasDay: false, sessions: [] },
  { hasPlan: true, hasDay: true, isRest: false, surface: { status: 'blocked' }, sessions: [] },
  { hasPlan: true, hasDay: true, isRest: true, restSource: 'removed', date: '2026-08-26', sessions: [] },
]) {
  const unavailable = buildTomorrowPlan(missing, '2026-08-26')
  assert.equal(unavailable.status, 'unavailable')
  assert.equal(unavailable.identity, null)
  assert.equal(unavailable.title, 'Plan unavailable')
  assert.deepEqual(unavailable.sessions, [], 'missing plan truth never invents training')
}

const sevenDays = buildWeekDays({
  days: [{ date: '2026-08-24', day: 'Mon', sessions: [run] }],
}, new Date(2026, 7, 24))
assert.equal(sevenDays.length, 7, 'the current Plan week remains a full seven-day surface')
assert.deepEqual(sevenDays.map((day) => day.dateISO), [
  '2026-08-24', '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30',
])

const dashboard = read('src/pages/Dashboard.jsx')
const card = read('src/components/TomorrowPlanCard.jsx')
const plan = read('src/pages/Plan.jsx')
const forgedCalendar = read('src/components/calendar/ForgedCalendar.jsx')
assert.match(dashboard, /fetchDailyExecution\(localTomorrowDateISO\(/, 'Dashboard loads Tomorrow from daily accepted-plan authority')
assert.match(dashboard, /millisecondsUntilTomorrowTransition\(dashboardNow\)/, 'Dashboard calculates the next real transition deadline')
assert.match(dashboard, /const timer = setTimeout\(/, 'Dashboard owns a real boundary timer')
assert.match(dashboard, /visibilitychange/, 'Tomorrow re-evaluates on visibility changes')
assert.match(dashboard, /CapacitorApp\.addListener\('resume'/, 'Tomorrow re-evaluates on app resume')
assert.match(dashboard, /navigate\('\/plan', \{ state: \{ focusDateISO:/, 'Tomorrow has one focused Plan handoff')
assert.match(card, /Tomorrow/, 'the promoted card is explicitly labeled Tomorrow')
assert.match(card, /overflowWrap: 'anywhere'/, 'long accepted titles are bounded on narrow phones')
assert.match(card, /minWidth: 0/, 'Tomorrow content can shrink without horizontal overflow')
assert.match(plan, /useLocation\(\)/, 'Plan accepts the focused-day navigation state')
assert.match(plan, /findDayByDate\(focusDateISO\)/, 'Plan resolves tomorrow against its current calendar')
assert.match(forgedCalendar, /\(week\?\.days \|\| \[\]\)\.map/, 'the selected Plan week still renders every day')
assert.match(forgedCalendar, /view === 'overview'/, 'the whole-plan Overview remains reachable')

console.log('STABLE PLAN TOMORROW SMOKE OK (44)')
