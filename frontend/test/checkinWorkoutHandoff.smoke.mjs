import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const checkin = read('src/pages/DailyCheckIn.jsx')
const logRun = read('src/pages/LogRun.jsx')
const warmup = read('src/pages/Warmup.jsx')
const activeRun = read('src/pages/ActiveRun.jsx')
const dashboard = read('src/pages/Dashboard.jsx')

let passed = 0
function check(condition, message) {
  if (!condition) throw new Error(message)
  passed += 1
}

check(checkin.includes('normalizeExecution(planRes.data)') && checkin.includes('runRouteState(execution)'), 'check-in resolves the canonical daily execution')
check(checkin.includes("api.get('/runs/next-recommendation')"), 'check-in has a recommendation fallback for users without a calendar plan')
check(!checkin.includes("navigate('/stretches/session?type=pre')"), 'check-in no longer loses the workout in the generic stretch flow')
check(checkin.includes("navigate(withWarmup ? '/warmup' : '/run/active'"), 'warm-up and skip actions preserve the exact run handoff')
check(checkin.includes("api.get('/checkin/today', { params: { date: todayISO() } })"), 'check-in status uses the phone-local calendar date')
check(dashboard.includes("api.get('/checkin/today', { params: { date: localDateISO() } })"), 'Today status uses the phone-local calendar date')
check(warmup.includes("params: { date: checkinDate || localDateISO() }"), 'warm-up confirmation uses the same phone-local calendar date')
check(checkin.includes('checkinCompleted: true') && checkin.includes('checkinDate: todayISO()'), 'a successful check-in remains confirmed through warm-up')
check(checkin.includes("}, '/')"), 'the completed run returns to Today instead of restarting Check-In')
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
  checkin.includes('...runState')
    && warmup.includes("navigate('/run/active', { state: { ...nextState, autoStart: true } })")
    && activeRun.includes('consumeRunAutoStartState(location.state)')
    && activeRun.includes('autoStartExecutedRef.current = true')
    && activeRun.includes('planSessionIdFromState(navigationState)')
    && activeRun.includes('markSessionComplete(planSessionId, planCurrentWeek)'),
  'plan session id survives check-in, warm-up, and active-run completion handoff',
)
check(checkin.includes('No workout is scheduled') && checkin.includes('View Today'), 'rest and no-workout check-ins do not launch an empty run')
check(!logRun.includes('if (!w) return'), 'Log Run does not discard recommendation-only workouts')
check(logRun.includes("source: w ? 'legacy-plan' : 'recommendation'"), 'recommendation-only workouts are normalized into the Today card')
check(logRun.includes("todayWorkout.source === 'calendar' ? 'Start Scheduled Run' : 'Start Run'"), 'every executable Today run exposes a start action')

console.log(`CHECK-IN WORKOUT HANDOFF SMOKE OK (${passed})`)
