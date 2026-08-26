import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')
const executableSource = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

const app = read('src/App.jsx')
const activeRun = read('src/pages/ActiveRun.jsx')
const logRun = read('src/pages/LogRun.jsx')
const recap = read('src/pages/RunRecap.jsx')
const history = read('src/pages/History.jsx')
const warmup = read('src/pages/Warmup.jsx')
const dashboard = read('src/pages/Dashboard.jsx')
const more = read('src/pages/More.jsx')

let passed = 0
function check(condition, message) {
  assert.ok(condition, message)
  passed += 1
}

console.log('\n== retired current questionnaire routes and gates ==')
check(!app.includes("import('./pages/DailyCheckIn')") && !app.includes('path="/checkin"'), 'the current /checkin page is neither imported nor routed')
check(!logRun.includes("api.get('/checkin/today'") && !logRun.includes('Morning Check-In Required') && !logRun.includes("navigate('/checkin')"), 'Log Run never waits on or links to a morning check-in')
check(!warmup.includes("api.get('/checkin/today'") && !warmup.includes('Morning Check-In Required') && !warmup.includes("navigate('/checkin')"), 'warm-up never waits on or links to a morning check-in')
check(!logRun.includes('checkinCompleted: true') && !logRun.includes('checkinDate: todayISO()'), 'Log Run injects no retired check-in proof into warm-up state')
check(!warmup.includes('checkinConfirmed') && !warmup.includes('checkInCompleted'), 'warm-up has no retired questionnaire state gate')

console.log('\n== start safety and execution handoffs ==')
check(logRun.includes('authorizeWorkoutStart') && logRun.includes('workoutStartDecision'), 'existing workout-start safety authorization is preserved')
check(logRun.includes('const startScheduledRun = async') && logRun.includes('const startCalendarRun = async'), 'planned Today and calendar runs remain executable')
check(logRun.includes('const startUnplannedRun = async') && logRun.includes('unplannedRunRouteState'), 'unplanned runs remain executable')
check(logRun.includes('const onSubmit = async') && logRun.includes('perceived_effort: effort'), 'manual run logging remains available without inventing effort')
check(warmup.includes("navigate('/run/active', { state: { ...nextState, autoStart: true } })"), 'warm-up still hands the exact authorized run to Active Run')

console.log('\n== direct durable recap completion ==')
check(!executableSource(activeRun).includes('savePostRunCheckInDraft') && !activeRun.includes('<PostRunCheckIn'), 'tracked completion creates and mounts no questionnaire')
check(activeRun.includes('checkInPending: false') && activeRun.includes('heatDrift: heatDrift || null'), 'tracked completion marks recap ready while retaining heat-drift truth')
check(logRun.includes('saveRunCompletionHandoff({') && logRun.includes('buildRunCompletionSnapshot('), 'manual online/offline completion persists a factual recap snapshot')
check((logRun.match(/navigate\(completion\.destination, \{ replace: true \}\)/g) || []).length >= 2, 'online and offline manual saves replace-navigate directly to recap')
check(!logRun.includes('<PostRunCheckIn') && !logRun.includes('loadPostRunCheckInDraft'), 'manual lifecycle mounts no questionnaire and restores no retired draft')
check(!recap.includes('<PostRunCheckIn') && !recap.includes('onAddCheckIn='), 'durable recap neither mounts nor offers a questionnaire')
check(!history.includes('<PostRunCheckIn') && !history.includes('onAddCheckIn='), 'History neither mounts nor offers a questionnaire')

console.log('\n== stale-state, passive truth, and retained safety surfaces ==')
check(app.includes('clearPostRunCheckInDraft()') && recap.includes('clearPostRunCheckInDraft()'), 'retired post-run draft state is cleared at app and recap boundaries')
check(recap.includes('checkInPending: false') && recap.includes('RUN_COMPLETION_PHASE.RECAP_READY'), 'a stale questionnaire-pending handoff is normalized to recap-ready')
check(recap.includes('handoff?.heatDrift?.drifted') && recap.includes('handoff.heatDrift.label') && recap.includes('handoff.heatDrift.reason'), 'heat drift remains passive factual recap information')
check(dashboard.includes('HybridSessionPrompt') && dashboard.includes("api.get('/plans/reconciliation/current'"), 'factual hybrid reconciliation prompts remain available')
check(app.includes('path="/injury"') && more.includes("to: '/injury'"), 'voluntary injury reporting remains a separate reachable capability')

console.log(`\nSTABLE PLAN NO CHECK-IN SMOKE OK (${passed})`)
