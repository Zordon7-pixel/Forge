import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveTodayPlanAccess, resolveTodayWorkoutLabel } from '../src/lib/todayPlanAccess.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const frontend = path.resolve(here, '..')
const read = (relativePath) => fs.readFileSync(path.join(frontend, relativePath), 'utf8')

let passed = 0
let failed = 0
function assert(condition, message) {
  if (condition) passed += 1
  else {
    failed += 1
    console.error(`  FAIL: ${message}`)
  }
}

const plan = read('src/pages/Plan.jsx')
const insights = read('src/components/InsightsSheet.jsx')
const dashboard = read('src/pages/Dashboard.jsx')
const movement = read('src/components/MovementDemo.jsx')
const guidePolicy = read('src/lib/exerciseGuidePolicy.js')
const dayView = read('src/components/calendar/ForgedDayView.jsx')
const logRun = read('src/pages/LogRun.jsx')

console.log('\n== Calendar day detail ==')
const evidenceDeclaration = plan.indexOf('const trainingEvidence = Array.isArray')
const evidenceUse = plan.indexOf('trainingEvidence: calendarModel.trainingEvidence?.length ? calendarModel.trainingEvidence : trainingEvidence')
assert(evidenceDeclaration >= 0 && evidenceDeclaration < evidenceUse, 'training evidence is declared before the selected-day view uses it')

console.log('\n== Rest-day actions ==')
assert(insights.includes("const isPlannedRestDay = execution?.isPlannedRest === true || execution?.restSource === 'planned'"), 'Today suppresses check-in only for an explicitly scheduled plan rest day')
assert(insights.includes("const isRestDay = isPlannedRestDay || isRestExecutionAuthority(execution) || recommendation?.recommendationType === 'rest' || recommendation?.type === 'rest'"), 'check-in-derived recovery keeps canonical recovery presentation without becoming scheduled rest')
assert(insights.includes("isRestDay ? 'View calendar' : 'Start/log'"), 'Today details route rest days to the calendar')
assert(insights.includes('Recovery is the plan today'), 'rest-day heading is explicit')
assert(!insights.includes("disabled={step.key === 'train' && isRestDay}"), 'Today no longer renders a redundant disabled workflow step on rest days')
assert(insights.includes('isPlannedRestDay && planAccess.secondaryAction') && insights.includes('onStartUnplannedRun'), 'Today authored-rest details expose the guarded extra-run action')
assert(dayView.includes('Choose an extra run or move a missed session onto today.'), 'calendar rest detail explains both rest-day intents')
assert(dayView.includes('{isScheduledToday && !canonicalRestReplacesWorkout && ('), 'future calendar rest days and current safety-rest overrides cannot start an extra run')
assert(plan.includes("navigate('/log-run?tab=manual&intent=rest-day')"), 'Plan wires today rest runs to the intent chooser')
assert(dashboard.includes('onStartUnplannedRun={handleStartUnplannedRun}'), 'Dashboard wires the Today rest action')
assert(dashboard.includes("navigate('/log-run?tab=manual&intent=rest-day')"), 'Dashboard opens the rest-day intent chooser')
assert(logRun.includes("query.get('tab') === 'manual'") && logRun.includes('Choose Run'), 'manual deep link opens the run-intent action')
assert(logRun.includes('api.get(`/plans/compliance?date=') && logRun.includes("api.post('/plans/reschedule-missed'"), 'make-up choices use phone-local, owner-scoped missed-session and reschedule APIs')
assert(logRun.includes('const targetDate = localDateISO()') && logRun.includes('targetDate,'), 'make-up flow targets the phone-local rest date')
assert(logRun.includes('const state = makeupRunRouteState(missed'), 'make-up run carries the exact missed prescription into Active Run')
assert(logRun.includes("const submittedPlanSessionId = activeTab === 'log' ? null : planSessionId"), 'manual run saves cannot inherit plan completion linkage')
const manualSubmit = logRun.slice(logRun.indexOf('const onSubmit = async'), logRun.indexOf('const selectedSplits = useMemo'))
assert(!manualSubmit.includes("if (resolvedSurface === 'treadmill')"), 'completed manual treadmill runs save instead of being redirected into a new live session')

console.log('\n== Today calendar completeness ==')
const coachStart = insights.indexOf('export function DailyCoachFlow')
const detailsStart = insights.indexOf('export function TodayDetailSheet')
const coachSource = insights.slice(coachStart, detailsStart)
const detailsSource = insights.slice(detailsStart)
assert(!coachSource.includes("{t('today.workoutBreakdown')}"), 'compact Today card does not duplicate the full workout breakdown')
assert(coachSource.includes("? 'run + lift'"), 'compact Today summary identifies a hybrid run + lift day')
assert(coachSource.includes('resolveTodayPlanAccess({'), 'Today card delegates access-state decisions to the tested resolver')
assert(detailsSource.includes('const recommendationLabel = resolveTodayWorkoutLabel({'), 'Today details use the tested workout-label resolver')
assert(coachSource.includes("calendarSessions.length > 0") && coachSource.includes('Check in only if you want the effort adjusted.'), 'calendar sessions remain truthfully summarized when no daily recommendation is available')
assert(detailsSource.includes("calendarSessions.map((session, index)"), 'Today details render every calendar session instead of only the preferred run')
assert(detailsSource.includes('<TodayCalendarSession') && insights.includes('sessionExercises(session)'), 'Today details render lift exercise prescriptions when present')
assert(insights.includes("{kind === 'lift' ? 'Start lift' : 'Start run'}"), 'each calendar session has an unambiguous start action')
assert(detailsSource.includes('planAccess.showStartLog'), 'calendar days do not repeat an ambiguous generic Start/log action')
assert(dashboard.includes('execution={execution}') && dashboard.includes('onStartRun={handleStartTodayRun}') && dashboard.includes('onStartLift={handleStartTodayLift}'), 'Dashboard passes complete execution and kind-specific start handlers to Today details')
assert(!detailsSource.includes('Check in before training') && !detailsSource.includes('After check-in'), 'Today details never present the scheduled plan as check-in locked')

console.log('\n== Plan access behavior ==')
const calls = []
const handlers = {
  onCheckIn: () => calls.push('checkin'),
  onStartWorkout: () => calls.push('start'),
  onStartUnplannedRun: () => calls.push('extra'),
  onDetails: () => calls.push('details'),
}
const accessFor = (overrides = {}) => resolveTodayPlanAccess({ ...handlers, ...overrides })

const recommendationOnly = accessFor({ recommendation: { type: 'easy' } })
assert(recommendationOnly.hasViewablePlan && recommendationOnly.primaryLabel === 'View workout', 'recommendation-only days expose the workout before check-in')
recommendationOnly.primaryAction()
recommendationOnly.secondaryAction()
recommendationOnly.trainAction()
assert(calls.splice(0).join(',') === 'details,checkin,details', 'recommendation-only plan, check-in, and Train actions route correctly')
assert(recommendationOnly.showStartLog, 'recommendation-only details retain the existing Start/log action')
const checkedRecommendation = accessFor({ checkedInToday: true, recommendation: { type: 'easy' } })
checkedRecommendation.primaryAction()
checkedRecommendation.secondaryAction()
checkedRecommendation.trainAction()
assert(calls.splice(0).join(',') === 'start,details,start', 'checked-in recommendation primary, Details, and Train actions preserve start behavior')

const calendarOnly = accessFor({ calendarSessions: [{ id: 'run-1' }] })
calendarOnly.primaryAction()
calendarOnly.secondaryAction()
calendarOnly.trainAction()
assert(calls.splice(0).join(',') === 'details,checkin,details', 'calendar-only plan, check-in, and Train actions route correctly')
assert(calendarOnly.hasViewablePlan && !calendarOnly.showStartLog, 'calendar-only days use their session-specific start controls')
const checkedCalendar = accessFor({ checkedInToday: true, calendarSessions: [{ id: 'run-1' }] })
checkedCalendar.primaryAction()
checkedCalendar.secondaryAction()
checkedCalendar.trainAction()
assert(calls.splice(0).join(',') === 'start,details,start', 'checked-in calendar primary, Details, and Train actions preserve start behavior')
assert(resolveTodayWorkoutLabel({ calendarKinds: ['run'] }) === 'Run', 'run-only calendar details identify the workout as Run')
assert(resolveTodayWorkoutLabel({ calendarKinds: ['lift'] }) === 'Strength', 'lift-only calendar details identify the workout as Strength')
assert(resolveTodayWorkoutLabel({ calendarKinds: ['run', 'lift'] }) === 'Run + lift', 'hybrid calendar details identify both sessions')

const restDay = accessFor({ isRestDay: true })
restDay.primaryAction()
restDay.secondaryAction()
assert(calls.splice(0).join(',') === 'details,extra', 'rest-day review and explicit extra-run actions route correctly')
assert(restDay.primaryLabel === 'View rest day' && !restDay.showStartLog, 'rest days remain viewable without an ambiguous generic Start/log action')
assert(!restDay.showCheckIn && restDay.uncheckedSignal.includes('No check-in is needed'), 'rest days do not prompt for a readiness check-in')
const checkedRestDay = accessFor({ checkedInToday: true, isRestDay: true })
checkedRestDay.primaryAction()
assert(calls.splice(0).join(',') === 'details' && checkedRestDay.primaryLabel === 'View rest day', 'checked-in rest days stay reviewable without using a Start label')

const noPlan = accessFor()
noPlan.primaryAction()
noPlan.trainAction()
assert(calls.splice(0).join(',') === 'checkin,checkin', 'no-plan primary and Train actions route to check-in')
assert(!noPlan.hasViewablePlan && noPlan.secondaryAction === null && !noPlan.showStartLog, 'no-plan state exposes no false Details or Start/log actions')
assert(noPlan.uncheckedSignal === "Check in for today's guidance." && !noPlan.readinessFallback.includes('remains visible'), 'no-plan details never claim that a schedule exists')
const checkedNoPlan = accessFor({ checkedInToday: true })
checkedNoPlan.primaryAction()
checkedNoPlan.trainAction()
assert(calls.splice(0).join(',') === 'checkin,checkin', 'checked-in/no-plan primary and Train actions return to check-in instead of starting a false workout')
assert(checkedNoPlan.primaryLabel === 'Edit check-in' && checkedNoPlan.secondaryAction === null && !checkedNoPlan.showStartLog, 'checked-in/no-plan state exposes no false Start, Details, or Start/log controls')
assert(checkedNoPlan.readinessFallback.includes('No recommendation is available yet.'), 'checked-in/no-plan details explain the missing recommendation truthfully')

console.log('\n== Profile-matched form images ==')
assert(movement.includes("male: '/stretches/leg-swings-male.png'") && movement.includes("female: '/stretches/leg-swings-female.png'"), 'leg swings use one profile-matched athlete')
assert(movement.includes("male: '/stretches/trunk-rotation-male.png'") && movement.includes("female: '/stretches/trunk-rotation-female.png'"), 'trunk rotations use one profile-matched athlete')
assert(
  guidePolicy.includes('if (photoDemo?.[normalizedSex])')
    && guidePolicy.includes('getTrustedCatalogExerciseAsset(name, imageUrl)')
    && movement.includes('resolveExerciseGuidePhoto({'),
  'profile pairs stay profile-matched while catalog media passes through the exact name-and-asset policy',
)

for (const asset of [
  'public/stretches/leg-swings-male.png',
  'public/stretches/leg-swings-female.png',
  'public/stretches/trunk-rotation-male.png',
  'public/stretches/trunk-rotation-female.png',
]) {
  const fullPath = path.join(frontend, asset)
  assert(fs.existsSync(fullPath) && fs.statSync(fullPath).size > 100_000, `${asset} is a non-placeholder image`)
}

console.log(`\nPASSED: ${passed}  FAILED: ${failed}`)
if (failed) process.exit(1)
console.log('PLAN FEEDBACK REMEDIATION SMOKE OK')
