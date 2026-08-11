import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')

const guide = read('src/components/ExerciseGuideAction.jsx')
const movement = read('src/components/MovementDemo.jsx')
const recommendation = read('src/components/StrengthWorkoutRecommendation.jsx')
const dayView = read('src/components/calendar/ForgedDayView.jsx')
const insights = read('src/components/InsightsSheet.jsx')
const logLift = read('src/pages/LogLift.jsx')

let passed = 0
function check(condition, message) {
  if (!condition) throw new Error(message)
  passed += 1
}

check(guide.includes('aria-haspopup="dialog"') && guide.includes('aria-expanded={open}') && guide.includes('onClick={() => setOpen(true)}'), 'View how opens an explicitly identified dialog')
check(guide.includes('aria-label="Close exercise guide"') && guide.includes('onClose={() => setOpen(false)}'), 'close control dismisses the guide')
check(guide.includes("event.key !== 'Escape'") && guide.includes("document.addEventListener('keydown', closeOnEscape, true)") && guide.includes("event.key !== 'Tab'") && guide.includes('previousFocus?.focus'), 'guide supports Escape, focus trapping, and focus restoration')
check(guide.includes("onClick={(event) => { if (event.target === event.currentTarget) onClose() }}"), 'backdrop dismisses after pointer focus settles without treating panel taps as dismissals')
check(guide.includes('<MovementDemo name={guide.name} cue={guide.cue} imageUrl={guide.imageUrl} sex={sex} />'), 'exercise fields map directly into the established movement visual')
check(guide.includes("source.name || source.exercise || source.exercise_name") && guide.includes("source.cue || source.formCue || source.instructions"), 'guide normalizes current exercise name and cue shapes')
const photoTable = movement.slice(movement.indexOf('const PHOTO_DEMOS'), movement.indexOf('function getDemoKind'))
check(photoTable.includes('/^low box jumps?$/') && photoTable.includes("src: '/exercises/low-box-jump.jpg'"), 'Low Box Jump maps to its vetted local form image')
check(photoTable.includes('/^pallof press$/') && photoTable.includes("src: '/exercises/pallof-press.jpg'"), 'Pallof Press maps to its vetted local form image')
check(!photoTable.includes('.includes('), 'all repository photo matchers use explicit vetted names rather than broad substring matches')
check(!movement.includes("lower.includes('leg press') ||") && !movement.includes("lower.includes('dumbbell row')") && !movement.includes("lower.includes('skull crusher')"), 'different exercise mechanics do not reuse a merely similar image')
check(movement.includes("/^barbell (?:bent[- ]over )?row$/.test(lower)") && movement.includes("/^(?:standing )?dumbbell (?:overhead|shoulder) press$/.test(lower)") && movement.includes("/^lat pulldown$/.test(lower)"), 'modifier variants cannot inherit a mechanically different generic visual')
check(movement.includes("src: '/exercises/squat.png'") && movement.includes("src: '/exercises/deadlift.png'") && movement.includes("cropToSex: true"), 'paired strength images crop to the profile-matched athlete')
check(photoTable.includes('/^walking lunges$/') && photoTable.includes('/^(?:flat )?(?:barbell )?bench press$/'), 'walking-lunge and standard-bench images are limited to their vetted mechanics')
check(movement.includes('Visual guide pending review') && movement.includes('No substitute image is shown.'), 'unknown exercises use a truthful non-image fallback')
check(movement.includes('Follow the written prescription with a controlled range of motion.') && movement.includes('const displayCue = cue || (photoSrc'), 'missing-image exercises without a supplied cue receive truthful non-image guidance')
check(recommendation.includes('<ExerciseGuideAction exercise={exercise} sex={sex} />'), 'AI and scheduled lift recommendations expose View how')
check(dayView.includes('<ExerciseGuideAction exercise={ex} />'), 'calendar lift prescriptions expose View how')
check(insights.includes('<ExerciseGuideAction exercise={exercise} />'), 'Today lift prescriptions expose View how')
check((logLift.match(/sex=\{userSex\}/g) || []).length >= 3, 'all Log Lift recommendation paths use the profile-matched athlete')

console.log(`EXERCISE GUIDE SMOKE OK (${passed})`)
