import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  calendarMonthView,
  motivationalRunName,
  normalizePlanSchedule,
  shiftCalendarMonth,
} from '../src/lib/planRunCalendar.js'

const canonical = {
  schemaVersion: 2,
  weeks: [
    {
      week: 1,
      startDate: '2026-08-03',
      days: [
        {
          day: 'Mon',
          date: '2026-08-03',
          sessions: [
            { id: 'easy-1', kind: 'run', type: 'easy', title: 'Easy aerobic run', distance_miles: 4, pace_target: '10:00/mi', target_zone: 'Zone 2' },
            { id: 'lift-1', kind: 'lift', type: 'strength', title: 'Strength maintenance', duration_min: 40 },
          ],
        },
        { day: 'Tue', date: '2026-08-04', sessions: [] },
        { day: 'Wed', date: '2026-08-05', sessions: [{ id: 'hill-1', kind: 'run', type: 'hills', title: 'Hill repeats', distance_miles: 5 }] },
      ],
    },
    {
      week: 2,
      startDate: '2026-09-07',
      days: [
        { day: 'Mon', date: '2026-09-07', sessions: [{ id: 'long-1', kind: 'run', type: 'long', title: 'Long aerobic run', distance_miles: 10 }] },
      ],
    },
  ],
}

const model = normalizePlanSchedule(canonical, { currentWeek: 1, todayISO: '2026-08-03' })
assert.equal(model.status, 'ready')
assert.equal(model.weeks[0].entries[0].sessions.length, 2, 'canonical multi-session days retain every real session')
assert.equal(model.weeks[0].entries[0].classification, 'Run + Lift')
assert.equal(model.weeks[0].entries[1].classification, 'Rest')
assert.equal(model.weeks[0].entries[0].isToday, true)
assert.equal(model.weeks[0].entries[0].sessions[0].id, 'easy-1', 'run session IDs survive normalization')
assert.ok(model.entries.filter((entry) => entry.sessions.some((session) => session.kind === 'run')).every((entry) => (
  entry.sessions.filter((session) => session.kind === 'run').every((session) => session.displayName)
)), 'every normalized run receives a display name')
assert.equal(model.weeks[0].entries[0].sessions[1].displayName, '', 'strength is excluded from run naming')

const hills = { id: 'hill-1', kind: 'run', type: 'hill_repeats', title: 'Hill repeats' }
assert.equal(motivationalRunName(hills, { date: '2026-08-05' }), 'Hills Pay the Bills')
assert.equal(
  motivationalRunName(hills, { date: '2026-08-05' }),
  motivationalRunName(hills, { date: '2026-08-05' }),
  'run names are deterministic',
)
assert.equal(motivationalRunName({ kind: 'run', display_name: 'Sunrise Swagger', type: 'easy' }), 'Sunrise Swagger')
assert.equal(motivationalRunName({ kind: 'lift', type: 'strength', title: 'Heavy day' }), '')

for (const type of ['easy', 'recovery', 'shakeout', 'long', 'hills', 'intervals', 'speed', 'track', 'tempo', 'threshold', 'race_pace', 'progression', 'run']) {
  assert.ok(motivationalRunName({ id: `run-${type}`, kind: 'run', type }, { date: '2026-08-06' }), `${type} has a curated fallback`)
}

const legacy = normalizePlanSchedule({
  weeks: [{
    startDate: '2026-08-03',
    sessions: [
      { id: 'legacy-run', day: 'Thu', type: 'tempo', distance_miles: 6, title: 'Threshold Thursday' },
      { day: 'Fri', type: 'rest', rest: true },
    ],
  }],
}, { todayISO: '2026-08-06' })
assert.equal(legacy.status, 'ready')
assert.equal(legacy.entries[0].date, '2026-08-06', 'legacy dates derive from the week start and weekday')
assert.equal(legacy.entries[0].sessions[0].displayName, 'Threshold Thursday', 'explicit legacy names survive')
assert.equal(legacy.entries[1].classification, 'Rest')

const august = calendarMonthView(model, '2026-08', { todayISO: '2026-08-03' })
assert.equal(august.mode, 'month')
assert.equal(august.canPrevious, false)
assert.equal(august.canNext, true)
assert.ok(august.label.includes('August 2026'))
assert.equal(calendarMonthView(model, shiftCalendarMonth('2026-08', 1)).canPrevious, true)

const fallback = calendarMonthView(model, '2026-07', { todayISO: '2026-07-01' })
assert.equal(fallback.mode, 'next_four_weeks')
assert.match(fallback.label, /Next four plan weeks/)
assert.ok(fallback.entries.length > 0)

assert.equal(normalizePlanSchedule({ weeks: [] }).status, 'empty')
assert.equal(normalizePlanSchedule({ weeks: [{ days: [null, { day: 'Nope', sessions: 'bad' }] }] }).status, 'malformed')

const logRunSource = fs.readFileSync(fileURLToPath(new URL('../src/pages/LogRun.jsx', import.meta.url)), 'utf8')
assert.match(logRunSource, /label: 'Month'/, 'Log Run exposes the Month tab')
assert.match(logRunSource, /normalizePlanSchedule/, 'Week and Month use the shared normalized payload')
assert.match(logRunSource, /entry\.sessions\.map\(\(session\) => <ScheduledSessionDetails/, 'the UI renders every session on a canonical day')
assert.match(logRunSource, /planSessionId: session\.id/, 'Start This Run preserves the normalized run session ID')
assert.match(logRunSource, /planScheduleState === 'loading'[\s\S]*planScheduleState === 'empty'[\s\S]*planScheduleState === 'malformed'[\s\S]*planScheduleState === 'error'/, 'calendar loading, empty, malformed, and API error states stay distinct')
assert.doesNotMatch(logRunSource, /day\.(?:type|distance_miles|rest)/, 'JSX never reinterprets canonical days as legacy flat workouts')
assert.ok(!logRunSource.includes('Undefined'), 'the schedule UI never renders the literal Undefined')

console.log('PLAN RUN CALENDAR SMOKE OK (canonical, legacy, multi-session, rest, month, malformed, names)')
