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
const movement = read('src/components/MovementDemo.jsx')

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
