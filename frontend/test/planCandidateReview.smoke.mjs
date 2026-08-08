import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PlanCandidateReviewCancelled,
  isPlanCandidateReviewCancelled,
  registerPlanCandidateReviewer,
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
assert.match(helper, /preview\.data\?\.replaces_active_plan[\s\S]*!candidateFeasibilityCanApply\(plan\)/, 'active-plan replacements and unsafe or missing feasibility targets require review')
assert.match(helper, /requestPlanCandidateReview\(preview\.data\)/, 'the preview is shown before applying')
assert.ok(
  helper.indexOf('requestPlanCandidateReview(preview.data)')
    < helper.indexOf("`/plans/candidates/${encodeURIComponent(candidateId)}/apply`"),
  'review happens before the apply request',
)
assert.match(helper, /decision !== 'apply'[\s\S]*PlanCandidateReviewCancelled/, 'keeping the current plan cannot fall through to apply')
assert.match(sheet, /feasibility === 'unsafe'[\s\S]*canApply = candidateFeasibilityCanApply\(plan\)/, 'unsafe plans never receive an apply action')
assert.match(sheet, /Apply reviewed plan[\s\S]*Review race target[\s\S]*Keep current plan/, 'the athlete sees explicit apply, review, and keep choices')
assert.match(sheet, /current plan stays in place today[\s\S]*This plan starts/, 'replacement review explains the protected-day cutover before apply')
assert.match(sheet, /activateModalDialog/, 'the review sheet uses the shared focus and scroll-lock controller')
assert.equal((planPage.match(/isPlanCandidateReviewCancelled\(err\)[\s\S]{0,180}current plan was kept/g) || []).length, 3, 'all Plan cancellation paths confirm the current plan was kept')
assert.match(racesPage, /isPlanCandidateReviewCancelled\(err\)[\s\S]{0,180}current plan was kept/, 'Races confirms cancellation without applying')
assert.match(sheet, /role="dialog"[\s\S]*aria-modal="true"/, 'the review sheet exposes modal semantics')
assert.match(app, /<PlanCandidateDecisionSheet \/>/, 'the reviewer is available to every plan-generation surface')
assert.match(route, /replaces_active_plan: Boolean\(candidate\.replacesActivePlan\)/, 'the backend tells the client when a preview replaces an active plan')

for (const page of ['Onboarding.jsx', 'Plan.jsx', 'PlanCatalog.jsx', 'Races.jsx']) {
  assert.match(read(`frontend/src/pages/${page}`), /isPlanCandidateReviewCancelled\(err\)/, `${page} treats an athlete cancellation as a non-error`)
}

console.log('PLAN CANDIDATE REVIEW SMOKE OK (23)')
