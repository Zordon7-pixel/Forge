import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8')

let passed = 0
function check(condition, message) {
  assert.ok(condition, message)
  passed += 1
}

check(source.includes("api.get('/plans/adaptation/current', { params: { date: localDateISO() } })"), 'Today requests the phone-local transparent adaptation')
check(source.includes("['run_gap', 'training_gap'].includes(item?.signal)"), 'Today limits the inactivity card to current or legacy training-gap evidence')
check(source.includes('Everything okay?'), 'training-gap card asks before changing the plan')
check(source.includes('Ease my return') && source.includes('Keep original'), 'both consent choices are visible')
check(source.includes('`/plans/adaptation/${trainingGapProposal.id}/${decision}`'), 'choices use the existing owner-scoped adaptation decision route')
check(source.includes('proposal_revision: trainingGapProposal.revision') && source.includes('proposal_plan_version: trainingGapProposal.planVersion'), 'choices are bound to the exact proposal the athlete reviewed')
check(source.indexOf('<TrainingGapPrompt') < source.indexOf('<DailyCoachFlow'), 'training-gap decision appears before the normal Today flow')

console.log(`PASSED: ${passed}  FAILED: 0`)
console.log('TRAINING GAP PROMPT SMOKE OK')
