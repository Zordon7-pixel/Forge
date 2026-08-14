import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { resolveTodayPlanAccess } from '../src/lib/todayPlanAccess.js'
import {
  hasExecutableSession,
  normalizeExecution,
  recommendationFromExecution,
  runRouteState,
  scheduledLiftFromExecution,
  scheduledRunFromExecution,
} from '../src/lib/dailyExecutionCore.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontend = path.resolve(here, '..')
const require = createRequire(import.meta.url)
const checkinOverride = require('../../backend/src/lib/checkinOverride')
const backendExecution = require('../../backend/src/lib/dailyExecution')
const insights = fs.readFileSync(path.join(frontend, 'src/components/InsightsSheet.jsx'), 'utf8')
const dailyCheckIn = fs.readFileSync(path.join(frontend, 'src/pages/DailyCheckIn.jsx'), 'utf8')
const logRun = fs.readFileSync(path.join(frontend, 'src/pages/LogRun.jsx'), 'utf8')

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

const scheduledRunPlan = {
  schemaVersion: 2,
  weeks: [{ week: 1, days: [{
    date: '2026-08-14',
    day: 'Fri',
    sessions: [{ id: 'scheduled-run', kind: 'run', type: 'easy_run', duration_minutes: 35 }],
  }] }],
}
const sickBaseDay = scheduledRunPlan.weeks[0].days[0]
function safetyExecution(checkin) {
  const action = checkinOverride.deriveAction(checkin)
  const patch = checkinOverride.buildPatch(action, sickBaseDay.sessions[0], checkin)
  const resolved = backendExecution.resolvePlanDayForDate({ plan: scheduledRunPlan, dateISO: '2026-08-14', patch })
  const execution = normalizeExecution({ execution: backendExecution.buildDailyExecution({
    plan: scheduledRunPlan,
    dateISO: '2026-08-14',
    selectedEntry: resolved.selectedEntry,
    selectedWeek: resolved.selectedWeek,
    selectedDayIndex: resolved.selectedDayIndex,
    completedSessionIds: [],
    restSource: null,
  }) })
  return { action, execution }
}

const safetyCases = [
  ['sick', { feeling: 3, legs: 3, drive: 3, time_available: 60, life_flags: ['sick'] }],
  ['injured', { feeling: 3, legs: 3, drive: 3, time_available: 60, life_flags: ['injured'] }],
  ['low sleep', { feeling: 3, legs: 3, drive: 3, time_available: 60, sleep_hours: 3.5, life_flags: [] }],
]
for (const [label, checkin] of safetyCases) {
  const safety = safetyExecution(checkin)
  assert.equal(safety.action, 'rest', `${label} follows the real safety override path`)
  assert.equal(hasExecutableSession(safety.execution), false, `${label} recovery is not executable`)
  assert.equal(scheduledRunFromExecution(safety.execution), null, `${label} cannot schedule a run`)
  assert.equal(scheduledLiftFromExecution(safety.execution), null, `${label} cannot schedule a lift`)
  assert.equal(runRouteState(safety.execution), null, `${label} cannot create a warm-up or active-run route`)
  assert.equal(recommendationFromExecution(safety.execution)?.type, 'rest', `${label} remains recovery guidance`)
}

const { action: sickAction, execution: sickExecution } = safetyExecution(safetyCases[0][1])
const sickRecommendation = recommendationFromExecution(sickExecution)
const sickAccess = resolveTodayPlanAccess({
  ...actions,
  checkedInToday: true,
  recommendation: sickRecommendation,
  calendarSessions: sickExecution.sessions,
  isRestDay: sickRecommendation?.type === 'rest',
  isPlannedRestDay: false,
})
assert.equal(sickAction, 'rest', 'sick check-in follows the real safety override path')
assert.equal(sickRecommendation?.type, 'rest', 'the real backend execution reaches the frontend as recovery')
assert.equal(sickAccess.primaryLabel, 'View recovery', 'check-in-derived recovery never invites Start workout')
assert.equal(sickAccess.primaryAction(), 'details')
assert.equal(sickAccess.secondaryLabel, 'Edit check-in')
assert.equal(sickAccess.showStartLog, false)

const liftOnlyPlan = {
  schemaVersion: 2,
  weeks: [{ week: 1, days: [{
    date: '2026-08-14',
    day: 'Fri',
    sessions: [{ id: 'scheduled-lift', kind: 'lift', type: 'strength', title: 'Strength maintenance' }],
  }] }],
}
const liftOnlyDay = liftOnlyPlan.weeks[0].days[0]
const liftRestPatch = checkinOverride.buildPatch('rest', liftOnlyDay.sessions[0], safetyCases[0][1])
const liftResolved = backendExecution.resolvePlanDayForDate({ plan: liftOnlyPlan, dateISO: '2026-08-14', patch: liftRestPatch })
const liftRestExecution = normalizeExecution({ execution: backendExecution.buildDailyExecution({
  plan: liftOnlyPlan,
  dateISO: '2026-08-14',
  selectedEntry: liftResolved.selectedEntry,
  selectedWeek: liftResolved.selectedWeek,
  selectedDayIndex: liftResolved.selectedDayIndex,
  completedSessionIds: [],
  restSource: null,
}) })
assert.equal(liftRestExecution.lift?.type, 'rest', 'backend safety rest neutralizes a retained lift session')
assert.equal(liftRestExecution.checkinOverride?.action, 'rest', 'day-level safety directive survives canonical execution')
assert.equal(hasExecutableSession(liftRestExecution), false, 'lift-only safety rest is non-executable across the shared frontend contract')
assert.equal(scheduledLiftFromExecution(liftRestExecution), null, 'lift-only safety rest cannot hand off to /log-lift')
assert.equal(recommendationFromExecution(liftRestExecution)?.type, 'rest', 'lift-only safety rest renders as recovery guidance')

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
assert(dailyCheckIn.includes("calendarRecommendation?.type === 'rest'"), 'post-submit routing honors recovery guidance before any retained run slot')
assert(logRun.includes('execution?.hasDay && execution?.isPlannedRest'), 'run-intent choices use authored-rest provenance instead of treating removed-empty days as scheduled rest')

console.log('REST-DAY CHECK-IN FRONTEND SMOKE OK (57)')
