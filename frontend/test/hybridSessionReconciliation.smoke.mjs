import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../src/pages/Dashboard.jsx', import.meta.url), 'utf8')
let checks = 0
function check(value, message) {
  assert.ok(value, message)
  checks += 1
}

check(source.includes("api.get('/plans/reconciliation/current'"), 'Today fetches hybrid reconciliation after sync and resume')
check(source.includes("api.post('/plans/reconciliation/respond'"), 'Today sends the selected reconciliation outcome')
check(source.includes('Completed it — forgot to track'), 'untracked completion is an explicit choice')
check(source.includes('Doing it later'), 'later completion is an explicit choice')
check(source.includes('Life got in the way'), 'life event is an explicit choice')
check(source.includes('Skipped this one'), 'intentional skip is an explicit choice')
check(source.includes('This is schedule context, not a failure score.'), 'prompt avoids failure language')
check(source.includes('consider fewer double days or a different strength frequency'), 'recurring pattern offers a plan-fit review')
check(source.indexOf('<HybridSessionPrompt') < source.indexOf('<DailyCoachFlow'), 'reconciliation appears before the normal Today flow')
check(source.includes('setTrainingGapProposal(!nextReconciliation && pendingGap ? nextProposal : null)'), 'specific hybrid prompt suppresses the generic training-gap prompt')
check(source.includes('timezone: localTimezone()'), 'phone timezone accompanies reconciliation evidence and decisions')

console.log(`HYBRID SESSION RECONCILIATION UI SMOKE OK (${checks})`)
