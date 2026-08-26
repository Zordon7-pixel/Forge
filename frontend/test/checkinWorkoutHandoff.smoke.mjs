import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const app = read('src/App.jsx')
const logRun = read('src/pages/LogRun.jsx')
const warmup = read('src/pages/Warmup.jsx')
const activeRun = read('src/pages/ActiveRun.jsx')
const dashboard = read('src/pages/Dashboard.jsx')

let passed = 0
function check(condition, message) {
  if (!condition) throw new Error(message)
  passed += 1
}

check(!app.includes("import('./pages/DailyCheckIn')") && !app.includes('path="/checkin"'), 'the current app registers no Daily Check-In route')
check(!logRun.includes("api.get('/checkin/today'") && !logRun.includes('Morning Check-In Required'), 'Log Run has no morning questionnaire gate')
check(!warmup.includes("api.get('/checkin/today'") && !warmup.includes('Morning Check-In Required'), 'warm-up has no morning questionnaire gate')
check(warmup.includes('Warm-up complete') && warmup.includes('Start Run checks Location, then begins the timer and route recording.'), 'warm-up completion explains the single-tap location and run-start handoff')
const autoStartSanitizedAt = activeRun.indexOf('state: autoStart.state')
const autoStartReplayGuardAt = activeRun.indexOf('if (autoStartExecutedRef.current) return')
const autoStartConsumedAt = activeRun.indexOf('autoStartExecutedRef.current = true')
const restoredSessionGuardAt = activeRun.indexOf('if (restoredSession || running || pausedRun || countingDown || awaitingManualDistance) return')
check(
  autoStartSanitizedAt >= 0
    && autoStartReplayGuardAt > autoStartSanitizedAt
    && autoStartConsumedAt > autoStartReplayGuardAt
    && restoredSessionGuardAt > autoStartConsumedAt,
  'one-shot start state is always sanitized while execution stays guarded before restored-session checks',
)
check(
  warmup.includes("navigate('/run/active', { state: { ...nextState, autoStart: true } })")
    && activeRun.includes('consumeRunAutoStartState(location.state)')
    && activeRun.includes('autoStartExecutedRef.current = true')
    && activeRun.includes('planSessionIdFromState(navigationState)')
    && activeRun.includes('markSessionComplete(planSessionId, planCurrentWeek)'),
  'plan session id survives warm-up and active-run completion handoff',
)
check(!logRun.includes('if (!w) return'), 'Log Run does not discard recommendation-only workouts')
check(logRun.includes("source: w ? 'legacy-plan' : 'recommendation'"), 'recommendation-only workouts are normalized into the Today card')
check(logRun.includes("todayWorkout.source === 'calendar' ? 'Start Scheduled Run' : 'Start Run'"), 'every executable Today run exposes a start action')
check(logRun.includes('authorizeWorkoutStart') && logRun.includes('workoutStartDecision'), 'existing run safety authorization remains in every start flow')
check(logRun.includes('const startScheduledRun = async') && logRun.includes('const startUnplannedRun = async') && logRun.includes('const onSubmit = async'), 'planned, unplanned, and manual run paths remain available')
check(dashboard.includes('HybridSessionPrompt') && dashboard.includes("api.get('/plans/reconciliation/current'"), 'factual workout reconciliation remains available')
check(app.includes('path="/injury"'), 'voluntary injury reporting remains independently routed')

console.log(`QUESTIONNAIRE-FREE WORKOUT HANDOFF SMOKE OK (${passed})`)
