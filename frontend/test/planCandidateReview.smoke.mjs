import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PlanCandidateReviewCancelled,
  isPlanCandidateReviewCancelled,
  planCandidateRequiresReview,
  registerPlanCandidateReviewer,
  reviewPlanCandidateBeforeApply,
  requestPlanCandidateReview,
} from '../src/lib/planCandidateReview.js'
import { candidateFeasibilityCanApply } from '../src/lib/planCandidateFeasibility.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8')

await assert.rejects(
  requestPlanCandidateReview({}),
  (error) => error?.code === 'PLAN_REVIEW_UNAVAILABLE',
  'missing review host fails closed instead of applying a plan',
)

let reviewed = null
const unregister = registerPlanCandidateReviewer(async (preview) => {
  reviewed = preview
  return 'apply'
})
assert.equal(await requestPlanCandidateReview({ candidate_id: 'candidate-1' }), 'apply')
assert.deepEqual(reviewed, { candidate_id: 'candidate-1' })
unregister()
await assert.rejects(requestPlanCandidateReview({}), (error) => error?.code === 'PLAN_REVIEW_UNAVAILABLE')

const cancellation = new PlanCandidateReviewCancelled('cancel')
assert.equal(isPlanCandidateReviewCancelled(cancellation), true)
assert.equal(cancellation.decision, 'cancel')

const helper = read('frontend/src/lib/planCandidates.js')
const sheet = read('frontend/src/components/PlanCandidateDecisionSheet.jsx')
const app = read('frontend/src/App.jsx')
const route = read('backend/src/routes/plans.js')
const planPage = read('frontend/src/pages/Plan.jsx')
const racesPage = read('frontend/src/pages/Races.jsx')

assert.equal(candidateFeasibilityCanApply({ overall_feasibility: 'supported' }), true)
assert.equal(candidateFeasibilityCanApply({ overall_feasibility: 'stretch' }), true)
assert.equal(candidateFeasibilityCanApply({ overall_feasibility: 'not_applicable', goals: [] }), true, 'non-race blocks do not require a race feasibility verdict')
assert.equal(candidateFeasibilityCanApply({ overall_feasibility: 'not_applicable', goals: [{ date: '2026-10-11' }] }), false, 'dated race plans cannot bypass feasibility')
assert.equal(candidateFeasibilityCanApply({ overall_feasibility: '' }), false)
assert.equal(planCandidateRequiresReview({ plan: { plan_data: { overall_feasibility: 'stretch' } } }), true, 'a first-plan stretch target requires athlete review')
assert.equal(planCandidateRequiresReview({ plan: { plan_data: { overall_feasibility: 'supported' } } }), false)
assert.equal(planCandidateRequiresReview({ replaces_active_plan: true, plan: { plan_data: { overall_feasibility: 'supported' } } }), true)
assert.match(helper, /reviewPlanCandidateBeforeApply\([\s\S]*preview\.data/, 'candidate consent gates the apply request')
assert.ok(
  helper.indexOf('reviewPlanCandidateBeforeApply(')
    < helper.indexOf("`/plans/candidates/${encodeURIComponent(candidateId)}/apply`"),
  'the decision controller owns the apply request',
)
assert.match(sheet, /feasibility === 'unsafe'[\s\S]*canApply = candidateFeasibilityCanApply\(plan\)/, 'unsafe plans never receive an apply action')
assert.match(sheet, /Apply reviewed plan[\s\S]*Review race target[\s\S]*Keep current plan/, 'the athlete sees explicit apply, review, and keep choices')
assert.match(sheet, /current plan stays in place today[\s\S]*This plan starts/, 'replacement review explains the protected-day cutover before apply')
assert.match(sheet, /activateModalDialog/, 'the review sheet uses the shared focus and scroll-lock controller')
assert.equal((planPage.match(/isPlanCandidateReviewCancelled\(err\)[\s\S]{0,180}current plan was kept/g) || []).length, 3, 'all Plan cancellation paths confirm the current plan was kept')
assert.match(racesPage, /isPlanCandidateReviewCancelled\(err\)[\s\S]{0,180}current plan was kept/, 'Races confirms cancellation without applying')
assert.match(sheet, /role="dialog"[\s\S]*aria-modal="true"/, 'the review sheet exposes modal semantics')
assert.match(app, /<PlanCandidateDecisionSheet \/>/, 'the reviewer is available to every plan-generation surface')
assert.match(route, /replaces_active_plan: Boolean\(candidate\.replacesActivePlan\)/, 'the backend tells the client when a preview replaces an active plan')

let releaseStretchReview
let stretchApplyCalls = 0
const unregisterStretch = registerPlanCandidateReviewer(() => new Promise((resolve) => {
  releaseStretchReview = resolve
}))
const pendingStretchApply = reviewPlanCandidateBeforeApply(
  { candidate_id: 'stretch-1', plan: { plan_data: { overall_feasibility: 'stretch' } } },
  async () => {
    stretchApplyCalls += 1
    return { applied: true }
  },
)
await Promise.resolve()
assert.equal(stretchApplyCalls, 0, 'stretch apply waits for the athlete decision')
releaseStretchReview('apply')
assert.deepEqual(await pendingStretchApply, { applied: true })
assert.equal(stretchApplyCalls, 1, 'explicit athlete approval applies exactly once')
unregisterStretch()

for (const decision of ['cancel', 'review_goal']) {
  let cancelledApplyCalls = 0
  const unregisterCancellation = registerPlanCandidateReviewer(async () => decision)
  await assert.rejects(
    reviewPlanCandidateBeforeApply(
      { candidate_id: `stretch-${decision}`, plan: { plan_data: { overall_feasibility: 'stretch' } } },
      async () => {
        cancelledApplyCalls += 1
        return { applied: true }
      },
    ),
    (error) => isPlanCandidateReviewCancelled(error) && error.decision === decision,
  )
  assert.equal(cancelledApplyCalls, 0, `${decision} leaves the athlete without a new assignment`)
  unregisterCancellation()
}

for (const page of ['Onboarding.jsx', 'Plan.jsx', 'PlanCatalog.jsx', 'Races.jsx']) {
  assert.match(read(`frontend/src/pages/${page}`), /isPlanCandidateReviewCancelled\(err\)/, `${page} treats an athlete cancellation as a non-error`)
}

console.log('PLAN CANDIDATE REVIEW SMOKE OK (34)')
