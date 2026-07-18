import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const checkin = read('src/pages/DailyCheckIn.jsx')
const logRun = read('src/pages/LogRun.jsx')
const warmup = read('src/pages/Warmup.jsx')
const activeRun = read('src/pages/ActiveRun.jsx')

let passed = 0
function check(condition, message) {
  if (!condition) throw new Error(message)
  passed += 1
}

check(checkin.includes('normalizeExecution(planRes.data)') && checkin.includes('runRouteState(execution)'), 'check-in resolves the canonical daily execution')
check(checkin.includes("api.get('/runs/next-recommendation')"), 'check-in has a recommendation fallback for users without a calendar plan')
check(!checkin.includes("navigate('/stretches/session?type=pre')"), 'check-in no longer loses the workout in the generic stretch flow')
check(checkin.includes("navigate(withWarmup ? '/warmup' : '/run/active'"), 'warm-up and skip actions preserve the exact run handoff')
check(
  checkin.includes('...runState')
    && warmup.includes("navigate('/run/active', { state: nextState })")
    && activeRun.includes('planSessionIdFromState(navigationState)')
    && activeRun.includes('markSessionComplete(planSessionId, planCurrentWeek)'),
  'plan session id survives check-in, warm-up, and active-run completion handoff',
)
check(checkin.includes('No workout is scheduled') && checkin.includes('View Today'), 'rest and no-workout check-ins do not launch an empty run')
check(!logRun.includes('if (!w) return'), 'Log Run does not discard recommendation-only workouts')
check(logRun.includes("source: w ? 'legacy-plan' : 'recommendation'"), 'recommendation-only workouts are normalized into the Today card')
check(logRun.includes("todayWorkout.source === 'calendar' ? 'Start Scheduled Run' : 'Start Run'"), 'every executable Today run exposes a start action')

console.log(`CHECK-IN WORKOUT HANDOFF SMOKE OK (${passed})`)
