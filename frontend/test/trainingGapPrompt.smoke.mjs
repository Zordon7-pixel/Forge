import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8')

let passed = 0
function check(condition, message) {
  assert.ok(condition, message)
  passed += 1
}

check(source.includes("api.get('/plans/adaptation/current', { params: { date: localDateISO() } })"), 'Today requests the phone-local transparent adaptation')
check(source.includes("item?.signal === 'training_gap'"), 'Today limits the inactivity card to a real training-gap signal')
check(source.includes('Everything okay?'), 'training-gap card asks before changing the plan')
check(source.includes('Adjust plan') && source.includes('Leave as is'), 'both consent choices are visible')
check(source.includes('`/plans/adaptation/${trainingGapProposal.id}/${decision}`'), 'choices use the existing owner-scoped adaptation decision route')
check(source.indexOf('<TrainingGapPrompt') < source.indexOf('<DailyCoachFlow'), 'training-gap decision appears before the normal Today flow')

console.log(`PASSED: ${passed}  FAILED: 0`)
console.log('TRAINING GAP PROMPT SMOKE OK')
