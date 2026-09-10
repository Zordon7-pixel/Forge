import assert from 'node:assert/strict'
import { planCandidateRequiresReview, registerPlanCandidateReviewer, reviewPlanCandidateBeforeApply } from '../src/lib/planCandidateReview.js'
import { candidateFeasibilityCanApply } from '../src/lib/planCandidateFeasibility.js'
for (const status of ['unvalidated', 'at_risk']) {
  const canonical = { overall_feasibility: status, goal_backward_engine_version: 'goal-backward-coaching-v2.4',
    canonical_workout_schema_version: 1, canonical_session_set_hash: 'a'.repeat(64) }
  assert.equal(candidateFeasibilityCanApply(canonical), true, 'Uncertainty is not a block on a validated canonical program')
  assert.equal(planCandidateRequiresReview({ plan: { plan_data: canonical } }), true, 'Assessment authority must be disclosed before acceptance')
  assert.equal(candidateFeasibilityCanApply({ overall_feasibility: status }), false, 'A status string alone cannot authorize a legacy candidate')
}
const adjusted = { plan: { plan_data: { overall_feasibility: 'supported', programReconciliation: [{ valid: true, entries: [{ modality: 'lift', requested: 4, delivered: 2, outcome: 'DISCLOSED_ADJUSTMENT' }] }] } } }
assert.equal(planCandidateRequiresReview(adjusted), true)
let release, calls = 0
const unregister = registerPlanCandidateReviewer(() => new Promise(resolve => { release = resolve }))
const pending = reviewPlanCandidateBeforeApply(adjusted, async () => { calls++; return true })
await Promise.resolve()
assert.equal(calls, 0, 'Supported first plan with an adjustment cannot auto-apply')
release('apply')
await pending
assert.equal(calls, 1)
unregister()
const invalid = structuredClone(adjusted)
invalid.plan.plan_data.programReconciliation[0].entries[0].outcome = 'UNSATISFIABLE'
await assert.rejects(reviewPlanCandidateBeforeApply(invalid, async () => { calls++ }), error => error.code === 'PROGRAM_FREQUENCY_UNSATISFIABLE')
assert.equal(calls, 1)
console.log('PROGRAM DISCLOSURE OK: first-plan adjustment requires consent; unsatisfiable never applies')
