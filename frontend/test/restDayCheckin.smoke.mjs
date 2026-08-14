import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveTodayPlanAccess } from '../src/lib/todayPlanAccess.js'
import { normalizeExecution, recommendationFromExecution } from '../src/lib/dailyExecutionCore.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontend = path.resolve(here, '..')
const insights = fs.readFileSync(path.join(frontend, 'src/components/InsightsSheet.jsx'), 'utf8')
const dailyCheckIn = fs.readFileSync(path.join(frontend, 'src/pages/DailyCheckIn.jsx'), 'utf8')

const actions = {
  onCheckIn: () => 'checkin',
  onStartWorkout: () => 'start',
  onStartUnplannedRun: () => 'extra',
  onDetails: () => 'details',
}

const rest = resolveTodayPlanAccess({ ...actions, isRestDay: true })
assert.equal(rest.primaryLabel, 'View rest day')
assert.equal(rest.primaryAction(), 'details')
assert.equal(rest.showCheckIn, false, 'scheduled rest suppresses the readiness check-in prompt')
assert.equal(rest.secondaryLabel, 'Start extra run', 'intentional training and missed-run options remain explicit')
assert.equal(rest.secondaryAction(), 'extra')
assert.match(rest.uncheckedSignal, /No check-in is needed/i)
assert.match(rest.readinessFallback, /Feeling fresh keeps the rest day in place/i)
assert.match(rest.readinessFallback, /make up a missed run/i)
assert.match(rest.readinessFallback, /safety check-in before starting/i)

const scheduled = resolveTodayPlanAccess({ ...actions, calendarSessions: [{ id: 'run-1' }] })
assert.equal(scheduled.showCheckIn, true, 'scheduled training can still ask for a readiness adjustment')
assert.equal(scheduled.secondaryLabel, 'Check in')

const noPlan = resolveTodayPlanAccess({ ...actions })
assert.equal(noPlan.showCheckIn, true, 'a true no-plan state still uses check-in to build guidance')
assert.equal(noPlan.primaryLabel, 'Check in')

const unscheduledRest = resolveTodayPlanAccess({ ...actions, recommendation: { type: 'rest', recommendationType: 'rest' } })
assert.equal(unscheduledRest.showCheckIn, true, 'a non-calendar rest recommendation still asks how the athlete feels')
assert.equal(unscheduledRest.primaryLabel, 'Check in')
assert.match(unscheduledRest.uncheckedSignal, /not a scheduled plan rest day/i)

const removedExecution = normalizeExecution({ execution: {
  hasPlan: true,
  hasDay: true,
  isRest: true,
  isPlannedRest: false,
  restSource: 'removed',
  sessions: [],
} })
assert.equal(recommendationFromExecution(removedExecution), null, 'an emptied-by-removal day is not relabeled as a planned rest day')
const removedAccess = resolveTodayPlanAccess({ ...actions, recommendation: recommendationFromExecution(removedExecution) })
assert.equal(removedAccess.showCheckIn, true, 'an emptied-by-removal day keeps check-in reachable')
assert.equal(removedAccess.primaryLabel, 'Check in')

const detailsStart = insights.indexOf('export function TodayDetailSheet')
const detailsSource = insights.slice(detailsStart)
assert(detailsSource.includes("{isRestDay ? 'Recovery tools' : 'Check-in and recovery tools'}"), 'rest details use recovery-only labeling')
assert(detailsSource.includes('{planAccess.showCheckIn && ('), 'rest details suppress the check-in control through the tested resolver')
assert(insights.includes('Rest and recovery are scheduled today. No check-in is needed unless you choose to train.'), 'Today explains the rest-day behavior and intentional-training exception directly')
assert(dailyCheckIn.includes('headline && adjustment !== headline'), 'a manually opened rest-day check-in explains why the rest plan stays in place')

console.log('REST-DAY CHECK-IN FRONTEND SMOKE OK (25)')
