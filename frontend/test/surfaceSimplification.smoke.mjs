import assert from 'node:assert/strict'
import fs from 'node:fs'

const planSource = fs.readFileSync(new URL('../src/pages/Plan.jsx', import.meta.url), 'utf8')
const bodySource = fs.readFileSync(new URL('../src/pages/HealthData.jsx', import.meta.url), 'utf8')

let passed = 0
function check(condition, message) {
  assert.ok(condition, message)
  passed += 1
}

check(!planSource.includes('Built from your data'), 'Train omits the redundant data summary')
check(!planSource.includes('Research and coaching references'), 'Train omits the page-level research disclosure')
check(planSource.includes('aria-expanded={adaptationOpen}'), 'calendar adaptation is a disclosure')
check(planSource.includes("setAdaptationOpen(Boolean(adaptationProposal.safetyException || hasPendingChanges))"), 'pending or safety adaptations open automatically')

check(!bodySource.includes("api.get('/health/sync')"), 'Body does not fetch the raw health metric strip')
check(!bodySource.includes('How your plan uses this data'), 'Body omits the repeated plan explanation')
check(!bodySource.includes('Apple Health'), 'Body uses source-neutral recovery copy')
check(bodySource.indexOf('Readiness history') < bodySource.indexOf('What may affect today'), 'readiness history precedes the driver cards')
check(bodySource.includes('to="/more"'), 'empty-state action opens Health & data in More')

console.log(`PASSED: ${passed}  FAILED: 0`)
console.log('TRAIN/BODY SIMPLIFICATION SMOKE OK')
