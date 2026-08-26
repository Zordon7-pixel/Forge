import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveTodayPlanAccess } from '../src/lib/todayPlanAccess.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontend = path.resolve(here, '..')
const repo = path.resolve(frontend, '..')
const readFrontend = (relative) => fs.readFileSync(path.join(frontend, 'src', relative), 'utf8')

const actions = {
  onStartWorkout: () => 'start',
  onStartUnplannedRun: () => 'extra',
  onDetails: () => 'details',
}

const missing = resolveTodayPlanAccess({ ...actions })
assert.equal(missing.primaryLabel, 'View plan')
assert.equal(missing.primaryAction(), 'details')
assert.equal(missing.hasViewablePlan, false)
assert.equal(missing.showCheckIn, false)

const scheduledUnchecked = resolveTodayPlanAccess({ ...actions, calendarSessions: [{ id: 'run-1' }] })
assert.equal(scheduledUnchecked.primaryLabel, 'Start workout')
assert.equal(scheduledUnchecked.primaryAction(), 'start')
assert.equal(scheduledUnchecked.secondaryLabel, 'Details')

const scheduledChecked = resolveTodayPlanAccess({ ...actions, checkedInToday: true, calendarSessions: [{ id: 'run-1' }] })
assert.equal(scheduledChecked.primaryLabel, 'Start workout')
assert.equal(scheduledChecked.primaryAction(), 'start')
assert.equal(scheduledChecked.secondaryLabel, 'Details')

const hybridRunDone = resolveTodayPlanAccess({
  ...actions,
  checkedInToday: true,
  calendarSessions: [{ id: 'run-1', completed: true }, { id: 'lift-1', completed: false }],
})
assert.equal(hybridRunDone.primaryLabel, 'Start workout')
assert.equal(hybridRunDone.primaryAction(), 'start')

const allDone = resolveTodayPlanAccess({
  ...actions,
  checkedInToday: true,
  calendarSessions: [{ id: 'run-1', completed: true }, { id: 'lift-1', completed: true }],
})
assert.equal(allDone.primaryLabel, 'Review completed workout')
assert.equal(allDone.primaryAction(), 'details')
assert.equal(allDone.secondaryAction, null)

const rest = resolveTodayPlanAccess({ ...actions, isRestDay: true })
assert.equal(rest.primaryLabel, 'View rest day')
assert.equal(rest.primaryAction(), 'details')
assert.equal(rest.secondaryLabel, 'Start extra run')
assert.equal(rest.secondaryAction(), 'extra')
assert.equal(rest.showCheckIn, false)
assert.match(rest.uncheckedSignal, /Recovery is the accepted plan/i)
assert.equal(rest.showStartLog, false)

const checkedRecovery = resolveTodayPlanAccess({
  ...actions,
  checkedInToday: true,
  recommendation: { type: 'rest', recommendationType: 'rest' },
  calendarSessions: [{ id: 'run-1', type: 'rest' }],
  isRestDay: true,
  isPlannedRestDay: false,
})
assert.equal(checkedRecovery.primaryLabel, 'View recovery')
assert.equal(checkedRecovery.primaryAction(), 'details')
assert.equal(checkedRecovery.secondaryAction, null)
assert.equal(checkedRecovery.showCheckIn, false)
assert.equal(checkedRecovery.showStartLog, false)

const restAfterRun = resolveTodayPlanAccess({ ...actions, isRestDay: true, hasRunRecordedToday: true })
assert.equal(restAfterRun.primaryLabel, 'View rest day')
assert.equal(restAfterRun.secondaryAction, null)

const insights = readFrontend('components/InsightsSheet.jsx')
const dailyFlow = insights.slice(insights.indexOf('export function DailyCoachFlow'), insights.indexOf('export function WatchSyncWidget'))
const todayDetail = insights.slice(insights.indexOf('export function TodayDetailSheet'), insights.indexOf('export function RecentActivityCard'))
const renderedSource = `${dailyFlow}\n${todayDetail}`.replace(/\/\*[\s\S]*?\*\//g, '')
assert(!dailyFlow.includes('todayWatchWorkout'), 'Today card must not duplicate watch delivery')
assert(!dailyFlow.includes('steps.map'), 'Today card must not duplicate the three-step workflow strip')
assert(!dailyFlow.includes('thirdPartyWatchSync'), 'Today card must not advertise unavailable watch partners')
assert(insights.includes('Map route'), 'Today details must expose contextual route planning for outdoor runs')
assert.doesNotMatch(renderedSource, /Check in|Edit check-in|Check in for today's guidance/i, 'changed Today surfaces contain no rendered check-in instruction or action')
assert.match(todayDetail, />Recovery tools</, 'secondary recovery actions stay available under a neutral disclosure')

const dashboard = readFrontend('pages/Dashboard.jsx')
assert(dashboard.includes("openRoutePlanner: true"), 'Today route action opens the existing planner directly')
assert(!dashboard.includes('todayWatchWorkout'), 'Dashboard no longer constructs duplicate watch content for Today')
assert(dashboard.includes('hasRunRecordedToday={hasRunRecordedToday}'), 'Today suppresses another extra-run action after a recorded run')
assert(dashboard.includes('isRunningActivity(run) && runOccurredOnDate(run, todayISO)'), 'Today run detection excludes walks and other non-running activities')
assert.equal((dashboard.match(/hasRunRecordedToday=\{hasRunRecordedToday\}/g) || []).length, 2, 'recorded-run state reaches both the Today card and detail sheet')
assert(insights.includes('hasRunRecordedToday = false'), 'Today detail accepts recorded-run state')
assert(insights.includes('isPlannedRestDay && planAccess.secondaryAction'), 'Today detail uses the guarded extra-run action only for authored rest days')
assert(insights.includes('{planAccess.secondaryLabel}'), 'Today detail preserves the explicit Start extra run label')
assert(!dashboard.includes("onCheckIn={() => navigate('/checkin')}"), 'Dashboard passes no check-in action into Today')
assert(dashboard.includes('authorizeWorkoutStart({ sessionId, activity, expectedAccess })'), 'existing safety start authorization remains in place')

const logRun = readFrontend('pages/LogRun.jsx')
assert(logRun.includes('initialExpanded={Boolean(location.state?.openRoutePlanner)}'), 'route handoff opens the planner without another tap')

const calendar = readFrontend('components/calendar/ForgedCalendar.jsx')
assert(!calendar.includes('Open today'), 'Train does not repeat an Open today button beneath the clickable today row')
assert(calendar.includes('onClick={() => onOpen(day)}'), 'calendar rows remain directly actionable')

const routePlanner = readFrontend('components/RoutePlanner.jsx')
assert(routePlanner.includes('Current location') && routePlanner.includes('Another place'), 'route planner supports here and travel starts')
assert(routePlanner.includes("api.post('/routes/search-start'"), 'travel starts use the authenticated server proxy')
assert(routePlanner.includes("fillColor: '#22C55E'") && routePlanner.includes("fillColor: '#EF4444'"), 'route preview distinguishes green start and red finish')
assert(routePlanner.includes('setPlaceResults([])') && routePlanner.includes('setSelectedPlace(null)') && routePlanner.includes('setRoute(null)'), 'editing a travel query invalidates stale results, coordinates, and route')
assert(!routePlanner.includes('role="listbox"') && !routePlanner.includes('role="option"'), 'place results use accurate button semantics without an incomplete listbox contract')
assert(routePlanner.includes('className="route-planner-controls pt-3"'), 'expanded route controls reserve fixed-nav clearance')

const routeSource = fs.readFileSync(path.join(repo, 'backend', 'src', 'routes', 'routes.js'), 'utf8')
assert(/router\.post\('\/search-start', auth, placeSearchLimiter/.test(routeSource), 'place search is authenticated and rate limited')
assert(/searchRouteStartPlaces\(req\.body\?\.query\)/.test(routeSource), 'place query crosses the validated service boundary')

console.log('TODAY/TRAIN FLOW SMOKE OK (45)')
