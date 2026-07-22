import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
const dayView = read('src/components/calendar/ForgedDayView.jsx')
const logRun = read('src/pages/LogRun.jsx')

console.log('\n== Calendar day detail ==')
const evidenceDeclaration = plan.indexOf('const trainingEvidence = Array.isArray')
const evidenceUse = plan.indexOf('inputSummary: planInputs, trainingEvidence')
assert(evidenceDeclaration >= 0 && evidenceDeclaration < evidenceUse, 'training evidence is declared before the selected-day view uses it')

console.log('\n== Rest-day actions ==')
assert(insights.includes("const isRestDay = recommendation?.recommendationType === 'rest' || recommendation?.type === 'rest'"), 'Today surfaces identify explicit rest recommendations')
assert(insights.includes("isRestDay ? 'View week' : 'Start'"), 'Today primary action never labels a rest day Start')
assert(insights.includes("isRestDay ? 'View calendar' : 'Start/log'"), 'Today details route rest days to the calendar')
assert(insights.includes('Recovery is the plan today'), 'rest-day heading is explicit')
assert(insights.includes("disabled={step.key === 'train' && isRestDay}"), 'completed rest step is not a redundant interactive control')
assert(insights.includes('Start a run') && insights.includes('onStartUnplannedRun'), 'Today rest details expose a separate run-intent action')
assert(dayView.includes('Choose an extra run or move a missed session onto today.'), 'calendar rest detail explains both rest-day intents')
assert(dayView.includes('{isScheduledToday && ('), 'future calendar rest days cannot start a run today')
assert(plan.includes("navigate('/log-run?tab=manual&intent=rest-day')"), 'Plan wires today rest runs to the intent chooser')
assert(dashboard.includes('onStartUnplannedRun={handleStartUnplannedRun}'), 'Dashboard wires the Today rest action')
assert(dashboard.includes("navigate('/log-run?tab=manual&intent=rest-day')"), 'Dashboard opens the rest-day intent chooser')
assert(logRun.includes("query.get('tab') === 'manual'") && logRun.includes('Choose Run'), 'manual deep link opens the run-intent action')
assert(logRun.includes("api.get('/plans/compliance')") && logRun.includes("api.post('/plans/reschedule-missed'"), 'make-up choices use owner-scoped missed-session and reschedule APIs')
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
assert(detailsSource.includes("calendarSessions.map((session, index)"), 'Today details render every calendar session instead of only the preferred run')
assert(detailsSource.includes('<TodayCalendarSession') && insights.includes('sessionExercises(session)'), 'Today details render lift exercise prescriptions when present')
assert(insights.includes("{kind === 'lift' ? 'Start lift' : 'Start run'}"), 'each calendar session has an unambiguous start action')
assert(detailsSource.includes('(calendarSessions.length === 0 || isRestDay)'), 'calendar days do not repeat an ambiguous generic Start/log action')
assert(dashboard.includes('execution={execution}') && dashboard.includes('onStartRun={handleStartTodayRun}') && dashboard.includes('onStartLift={handleStartTodayLift}'), 'Dashboard passes complete execution and kind-specific start handlers to Today details')

console.log('\n== Profile-matched form images ==')
assert(movement.includes("male: '/stretches/leg-swings-male.png'") && movement.includes("female: '/stretches/leg-swings-female.png'"), 'leg swings use one profile-matched athlete')
assert(movement.includes("male: '/stretches/trunk-rotation-male.png'") && movement.includes("female: '/stretches/trunk-rotation-female.png'"), 'trunk rotations use one profile-matched athlete')
assert(movement.includes('const hasProfilePair = Boolean(photoDemo?.male || photoDemo?.female)'), 'profile pairs override legacy generic image URLs')

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
