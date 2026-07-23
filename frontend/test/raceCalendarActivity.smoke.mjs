import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')

const plan = read('frontend/src/pages/Plan.jsx')
const catalog = read('frontend/src/pages/PlanCatalog.jsx')
const calendar = read('frontend/src/components/calendar/ForgedCalendar.jsx')
const dayView = read('frontend/src/components/calendar/ForgedDayView.jsx')
const raceEditor = read('frontend/src/components/calendar/RaceEditSheet.jsx')
const racesRoute = read('backend/src/routes/races.js')

assert.match(plan, /api\.get\('\/races'\)/, 'Train loads the user-owned race row')
assert.match(plan, /api\.get\('\/runs'\)/, 'Train loads recorded activities for calendar overlays')
assert.match(plan, /api\.patch\(`\/races\/\$\{encodeURIComponent\(activeRace\.id\)\}`/, 'race saves target the selected race id')
assert.match(racesRoute, /router\.patch\('\/:id', auth/, 'race editing remains authenticated')
assert.match(racesRoute, /SELECT \* FROM race_events WHERE id=\? AND user_id=\?/, 'race ownership is checked before editing')
assert.match(racesRoute, /UPDATE race_events[\s\S]*WHERE id=\? AND user_id=\?/, 'race mutation is owner scoped')
assert.match(raceEditor, /Goal time/, 'race editor exposes the goal-time control')
assert.match(raceEditor, /race_name:[\s\S]*race_date:[\s\S]*distance_miles:[\s\S]*goal_time_seconds:/, 'race editor submits the editable race identity and goal')
assert.match(raceEditor, /fontSize: 16/, 'race form controls avoid iOS input auto-zoom')
assert.match(plan, /indexRecordedRuns\(runs\)/, 'recorded runs are indexed separately from plan sessions')
assert.match(calendar, /recordedRunsByDate\?\.get\(day\.dateISO\)/, 'week rows receive same-date recorded runs')
assert.match(calendar, /cell\.hasRecordedRun/, 'activity-only month dates remain openable')
assert.match(dayView, /Recorded separately from this plan/, 'off-plan activity is never presented as plan completion')
assert.match(plan, /navigate\(`\/history\?runId=\$\{encodeURIComponent\(activity\.id\)\}`\)/, 'recorded activity opens its existing History recap')
assert.match(catalog, /location\.state\?\.raceId[\s\S]*openRace\(race, 'owned'\)/, 'plan rebuild handoff opens the exact edited race')

console.log('RACE CALENDAR ACTIVITY SMOKE OK (15)')
