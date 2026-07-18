import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const activeWorkout = read('src/pages/ActiveWorkout.jsx')
const exercisePicker = read('src/components/ExercisePickerModal.jsx')
const movementDemo = read('src/components/MovementDemo.jsx')
const logLift = read('src/pages/LogLift.jsx')
const recommendation = read('src/components/StrengthWorkoutRecommendation.jsx')
const boxJumpAsset = path.join(root, 'public/exercises/box-jump.jpg')

let passed = 0
function check(condition, message) {
  if (!condition) throw new Error(message)
  passed += 1
}

check(exercisePicker.includes("'full', 'full body', 'full-body', 'full_body'"), 'aggregate full-body labels load the complete exercise library')
check(exercisePicker.includes("const params = filterGroup ? { muscle_group: filterGroup } : {}"), 'aggregate groups are omitted from the API filter')
check(!exercisePicker.includes('autoFocus'), 'exercise picker does not focus and zoom as soon as it opens')
check((exercisePicker.match(/fontSize: 16/g) || []).length >= 3, 'all exercise-picker text fields use the iOS-safe 16px minimum')
check(activeWorkout.includes('const DEFAULT_REST_SECONDS = 90'), 'rest timer has an explicit 90-second default')
check(activeWorkout.includes('aria-pressed={selectedRestPreset === s}'), 'selected rest preset stays highlighted when extra time is added')
check(activeWorkout.includes('role="dialog"') && activeWorkout.includes('Open large timer'), 'rest countdown has a large accessible timer dialog')
check(!activeWorkout.includes('aria-live="assertive"'), 'per-second countdown does not interrupt screen readers')
check(activeWorkout.includes("event.key === 'Escape'") && activeWorkout.includes("event.key !== 'Tab'"), 'rest dialog supports Escape and traps keyboard focus')
check((activeWorkout.match(/document\.body\.style\.overflow = 'hidden'/g) || []).length >= 1, 'rest dialog locks background scrolling')
check(movementDemo.includes("src: '/exercises/box-jump.jpg'"), 'Box Jump resolves to a local form image')
check(fs.statSync(boxJumpAsset).size > 0, 'Box Jump form image exists and is non-empty')
check(recommendation.includes('function GuidanceDetails') && recommendation.indexOf('<GuidanceDetails title="Warm-up"') < recommendation.indexOf('>Workout</h4>'), 'lift recommendation puts a compact warm-up disclosure before exercises')
check(
  logLift.includes('warmup: aiRecommendation?.warmup || []')
    && logLift.includes('warmup: scheduledLiftPlan.warmup || []')
    && logLift.includes('warmup: manualAiPlan?.warmup || []'),
  'all recommended lift start paths carry warm-up guidance',
)
check(activeWorkout.includes("normalizeWarmupItems(location.state?.warmup)") && activeWorkout.includes('{plannedWarmup.length > 0 && ('), 'active lift preserves and displays its warm-up before the exercise queue')

console.log(`ACTIVE WORKOUT MOBILE SMOKE OK (${passed})`)
