import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { liftRecoveryMovements, liftWarmupMovements } from '../src/data/liftMobility.js'
import { postRunStretches, preRunStretches } from '../src/data/stretches.js'
import {
  getTrustedCatalogExerciseAsset,
  getVettedExerciseGuide,
  isVettedExerciseAsset,
  resolveExerciseGuidePhoto,
  SCREENSHOT_PROVEN_GUIDE_CASES,
} from '../src/lib/exerciseGuidePolicy.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8')
const require = createRequire(import.meta.url)
const serverStretchCatalog = require('../../backend/src/routes/stretches.js')._test.MOVEMENTS

const guide = read('src/components/ExerciseGuideAction.jsx')
const movement = read('src/components/MovementDemo.jsx')
const guidePolicy = read('src/lib/exerciseGuidePolicy.js')
const recommendation = read('src/components/StrengthWorkoutRecommendation.jsx')
const dayView = read('src/components/calendar/ForgedDayView.jsx')
const insights = read('src/components/InsightsSheet.jsx')
const logLift = read('src/pages/LogLift.jsx')
const activeWorkout = read('src/pages/ActiveWorkout.jsx')
const exercisePicker = read('src/components/ExercisePickerModal.jsx')
const exerciseSeed = read('../backend/src/db/exercises-seed.js')

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
check(movement.includes('Follow the written prescription with a controlled range of motion.') && movement.includes('const displayCue = photoConfig.cue || cue || (photoSrc'), 'missing-image exercises without a supplied cue receive truthful non-image guidance')
check(movement.includes('const photoConfig = resolveExerciseGuidePhoto({') && movement.includes('src={photoSrc}'), 'the trusted guide resolver directly controls the rendered image src')
check(movement.includes('imageUrl,') && guidePolicy.includes('getTrustedCatalogExerciseAsset'), 'catalog image URLs pass through an exact name/asset allowlist')
for (const exerciseName of SCREENSHOT_PROVEN_GUIDE_CASES) {
  const policy = getVettedExerciseGuide(exerciseName)
  check(Boolean(policy?.src && policy?.cue), `${exerciseName} has a vetted asset and movement-specific cue`)
  check(isVettedExerciseAsset(exerciseName, policy.src), `${exerciseName} accepts its own exact asset`)
}
check(!isVettedExerciseAsset('Trap Bar Deadlift', '/exercises/deadlift.png'), 'Trap Bar Deadlift rejects the conventional deadlift asset')
check(!isVettedExerciseAsset('Rear-Foot-Elevated Split Squat', '/exercises/squat.png'), 'RFESS rejects the bilateral squat asset')
check(isVettedExerciseAsset('Dumbbell Bulgarian Split Squat', '/exercises/rear-foot-elevated-split-squat.webp'), 'equipment-prefixed RFESS aliases resolve to the exact split-squat guide')
check(isVettedExerciseAsset('Barbell RDL', '/exercises/romanian-deadlift.webp'), 'the catalog barbell-RDL alias resolves to the exact barbell hinge guide')
check(isVettedExerciseAsset('Dumbbell Single-Leg RDL', '/exercises/single-leg-romanian-deadlift.webp'), 'the abbreviated unilateral alias retains its exact implement and movement class')
check(isVettedExerciseAsset('Dumbbell RFESS', '/exercises/rear-foot-elevated-split-squat.webp'), 'the abbreviated RFESS alias retains its exact implement and elevation')
check(!isVettedExerciseAsset('Single-Leg Romanian Deadlift', '/exercises/deadlift.png'), 'single-leg RDL rejects the bilateral conventional deadlift asset')
for (const exerciseName of SCREENSHOT_PROVEN_GUIDE_CASES) {
  const unresolvedProfile = resolveExerciseGuidePhoto({ name: exerciseName, sex: '' })
  check(Boolean(unresolvedProfile.src) && unresolvedProfile.cropToSex === false, `${exerciseName} has a safe uncropped image while profile sex resolves`)
  const maleProfile = resolveExerciseGuidePhoto({ name: exerciseName, sex: 'male' })
  check(Boolean(maleProfile.src) && maleProfile.cropToSex === true, `${exerciseName} uses profile cropping after sex resolves`)
}
const unresolvedPairedComposite = resolveExerciseGuidePhoto({
  name: 'Low Box Jump',
  sex: '',
  localPhotoDemo: { src: '/exercises/low-box-jump.jpg', cropToSex: true, maleSide: 'right' },
})
check(
  unresolvedPairedComposite.src === '/exercises/low-box-jump.jpg' && unresolvedPairedComposite.cropToSex === false,
  'a trusted paired composite remains visible uncropped while profile sex resolves',
)
check(resolveExerciseGuidePhoto({
  name: 'Leg Swings',
  sex: '',
  localPhotoDemo: { male: '/stretches/leg-swings-male.png', female: '/stretches/leg-swings-female.png' },
}).src === '', 'separate sex-specific files do not guess an athlete while profile sex is unknown')
check(resolveExerciseGuidePhoto({
  name: 'Uncatalogued Exercise',
  imageUrl: '/stretches/pigeon-pose.webp',
  sex: '',
}).src === '', 'a trusted local path cannot be substituted for an unrelated exercise name')
check(resolveExerciseGuidePhoto({
  name: 'Pigeon Pose',
  imageUrl: 'https://example.com/pigeon-pose.webp',
  sex: '',
}).src === '', 'external and arbitrary catalog URLs fail closed')

const clientCatalog = [
  ...preRunStretches,
  ...postRunStretches,
  ...liftWarmupMovements,
  ...liftRecoveryMovements,
]
for (const movementItem of clientCatalog) {
  check(
    getTrustedCatalogExerciseAsset(movementItem.name, movementItem.image_url) === movementItem.image_url,
    `${movementItem.name} keeps its exact client catalog asset`,
  )
  const rendered = resolveExerciseGuidePhoto({
    name: movementItem.name,
    imageUrl: movementItem.image_url,
    sex: '',
  })
  check(rendered.src === movementItem.image_url, `${movementItem.name} maps its catalog asset to the rendered src before profile resolution`)
}
for (const movementItem of Object.values(serverStretchCatalog)) {
  check(
    getTrustedCatalogExerciseAsset(movementItem.name, movementItem.image_url) === movementItem.image_url,
    `${movementItem.name} keeps its exact server catalog asset`,
  )
  const rendered = resolveExerciseGuidePhoto({
    name: movementItem.name,
    imageUrl: movementItem.image_url,
    sex: '',
  })
  check(rendered.src === movementItem.image_url, `${movementItem.name} maps its server catalog asset to the rendered src`)
  check(fs.existsSync(path.join(root, 'public', rendered.src)), `${movementItem.name} rendered src ships in the public bundle`)
}
for (const fallbackOnlyName of [
  'Dumbbell Romanian Deadlift',
  'Kettlebell Romanian Deadlift',
  'Sumo Deadlift',
  'Deficit Trap Bar Deadlift',
  'Barbell Rear-Foot Elevated Split Squat',
  'Front-Foot-Elevated Split Squat',
  'Close-Grip Bench Press',
  'Reverse-Grip Lat Pulldown',
  'Seated Dumbbell Shoulder Press',
  'Single-Arm Dumbbell Shoulder Press',
]) {
  check(getVettedExerciseGuide(fallbackOnlyName) === null, `${fallbackOnlyName} remains on truthful written fallback until its exact mechanics are vetted`)
}
const seededExerciseNames = [...exerciseSeed.matchAll(/\{ name: '([^']+)'/g)].map((match) => match[1])
check(seededExerciseNames.length >= 35, 'the full seeded exercise catalog is included in guide coverage')
check(!exerciseSeed.includes("instructions: ''"), 'every seeded exercise has a written fallback cue')
const referencedAssets = [...`${movement}\n${guidePolicy}`.matchAll(/(?:src|male|female): '([^']+)'/g)]
  .map((match) => match[1])
  .filter((asset) => asset.startsWith('/exercises/') || asset.startsWith('/stretches/'))
check(referencedAssets.length >= 55, 'the exact-name guide catalog covers the repository exercise and stretch media inventory')
check(referencedAssets.every((asset) => fs.existsSync(path.join(root, 'public', asset))), 'every vetted guide asset exists in the shipped public bundle')
check(recommendation.includes('<ExerciseGuideAction exercise={exercise} sex={sex} />'), 'AI and scheduled lift recommendations expose View how')
check(dayView.includes('<ExerciseGuideAction exercise={ex} />'), 'calendar lift prescriptions expose View how')
check(insights.includes('<ExerciseGuideAction exercise={exercise} />'), 'Today lift prescriptions expose View how')
check((logLift.match(/sex=\{userSex\}/g) || []).length >= 3, 'all Log Lift recommendation paths use the profile-matched athlete')
for (const [surface, source] of [
  ['Log Lift', logLift],
  ['Active Workout', activeWorkout],
  ['Exercise Picker', exercisePicker],
]) {
  check(source.includes("const [userSex, setUserSex] = useState('')"), `${surface} does not guess a profile sex before auth resolves`)
  check(!source.includes("sex || 'male'"), `${surface} preserves an unknown profile sex for the safe uncropped guide fallback`)
}

console.log(`EXERCISE GUIDE SMOKE OK (${passed})`)
