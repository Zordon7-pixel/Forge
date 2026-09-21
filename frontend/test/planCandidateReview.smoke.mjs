import assert from 'node:assert/strict'
import { adaptivePreviewPublicFixture, adaptivePreviewNow } from './fixtures/adaptivePreviewPublic.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
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
import { planModeLabel, racePlanGenerationTarget } from '../src/lib/planCalendar.js'
import { executeRacePlanGoalRebuild } from '../src/lib/planRebuild.js'
import { previewAndApplyPlan } from '../src/lib/planCandidates.js'
import api from '../src/lib/api.js'

const require = createRequire(import.meta.url)
const { createPlanCandidateLifecycleHarness } = require('../../backend/test/helpers/planCandidateLifecycleHarness.js')

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

// Supported first candidates must still review; a hostile reviewer cannot apply.
for (const marker of [
  { apply_bindings: { feature_mode: 'preview' } },
  { surface_manifest: { feature_mode: 'preview', authoritative_engine: 'adaptive-joint-solver-v1' } },
  { plan: { plan_data: { engineVersion: 'adaptive-joint-solver-v1', overall_feasibility: 'supported' } } },
]) {
  const preview = { requires_apply: false, candidate_id: 'adaptive', candidate_hash: 'hash',
    plan: { plan_data: { overall_feasibility: 'supported' } }, ...marker }
  let reviews = 0, applies = 0
  const stop = registerPlanCandidateReviewer(async () => { reviews++; return 'apply' })
  assert.equal(planCandidateRequiresReview(preview), true)
  await assert.rejects(reviewPlanCandidateBeforeApply(preview, () => { applies++ }), isPlanCandidateReviewCancelled)
  const post = api.post
  api.post = async (url) => { if (url.includes('/apply')) applies++; return { data: preview } }
  try { await assert.rejects(previewAndApplyPlan('/preview'), isPlanCandidateReviewCancelled) }
  finally { api.post = post; stop() }
  assert.equal(reviews, 2)
  assert.equal(applies, 0)
}
assert.equal(planCandidateRequiresReview({ candidate: { status: 'preview', plan_data: { overall_feasibility: 'supported' } } }), false)

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
assert.equal(candidateFeasibilityCanApply({ overall_feasibility: 'stretch', application_path: 'foundation', reasons: ['ANCHOR_EXPIRED'] }), true)
assert.equal(planCandidateRequiresReview({ plan: { plan_data: { overall_feasibility: 'stretch' } } }), true, 'a first-plan stretch target requires athlete review')
assert.equal(planCandidateRequiresReview({ plan: { plan_data: { overall_feasibility: 'supported' } } }), false)
assert.equal(planCandidateRequiresReview({ replaces_active_plan: true, plan: { plan_data: { overall_feasibility: 'supported' } } }), true)
assert.match(helper, /reviewPlanCandidateBeforeApply\([\s\S]*preview\.data/, 'candidate consent gates the apply request')
assert.match(helper, /preview\.data\.apply_bindings[\s\S]*\.\.\.applyBindings[\s\S]*candidate_hash:\s*candidateHash/, 'shared applies retain the reviewed server binding envelope')
assert.ok(
  helper.indexOf('reviewPlanCandidateBeforeApply(')
    < helper.indexOf("`/plans/candidates/${encodeURIComponent(candidateId)}/apply`"),
  'the decision controller owns the apply request',
)
assert.match(sheet, /feasibility === 'unsafe'[\s\S]*canApply = candidateFeasibilityCanApply\(plan\)/, 'unsafe plans never receive an apply action')
assert.match(sheet, /Apply reviewed plan[\s\S]*Review race target[\s\S]*Keep current plan/, 'the athlete sees explicit apply, review, and keep choices')
assert.match(sheet, /foundation[\s\S]*reason/i, 'an unreachable target is presented as a reason-backed foundation plan')
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

assert.match(helper, /previewedChoice[\s\S]*choice: previewedChoice/, 'an edited goal carries its reviewed adjust_goal or completion_first choice into apply')

const preferredHybridTarget = racePlanGenerationTarget(null, {
  run_days_per_week: 4,
  lift_days_per_week: 4,
})
assert.equal(preferredHybridTarget.planMode, 'hybrid_maintain')
assert.equal(preferredHybridTarget.liftingEnabled, true)
assert.equal(preferredHybridTarget.liftDaysPerWeek, 4)
assert.notEqual(preferredHybridTarget.planMode, 'run_only', 'four-run/four-lift preference never emits RUN_ONLY')
assert.notEqual(planModeLabel(preferredHybridTarget.planMode), 'Run only', 'four-run/four-lift preference never renders a Run only header')
assert.match(racesPage, /racePlanGenerationTarget[\s\S]*generateRacePlan/, 'race generation sends the hybrid target contract')
assert.match(planPage, /executeRacePlanGoalRebuild\(/, 'Plan uses the behaviorally tested rebuild executor')
assert.match(racesPage, /saveRaceEdit[\s\S]*executeRacePlanGoalRebuild\(/, 'Races edit-PR uses the behaviorally tested rebuild executor')

const originalApiPost = api.post
const unregisterLifecycleReview = registerPlanCandidateReviewer(async () => 'apply')
try {
  for (const liftDaysPerWeek of [3, 4]) {
    const raceId = `runtime-edit-${liftDaysPerWeek}`
    const harness = createPlanCandidateLifecycleHarness({
      planningDate: '2026-08-03',
      profile: { run_days_per_week: 4, lift_days_per_week: liftDaysPerWeek, weekly_miles_current: 20 },
      races: [{
        id: raceId,
        race_name: `Runtime edit ${liftDaysPerWeek}`,
        race_date: '2026-09-06',
        distance_miles: 10,
        goal_time_seconds: 6000,
      }],
      runs: [{
        id: `recent-anchor-${liftDaysPerWeek}`,
        date: '2026-07-27',
        distance_miles: 10,
        duration_seconds: 5700,
        type: 'run',
      }],
    })
    try {
      api.post = harness.post
      const applied = await executeRacePlanGoalRebuild({
        plan: {
          plan_data: {
            planMode: 'run_only',
            goal: { goalPaceSecondsPerMile: 525 },
            schedulePreferences: { trainingDays: ['Mon', 'Tue', 'Thu', 'Sat'], runDaysPerWeek: null },
            strengthPolicy: { goal: 'maintain', equipment: ['dumbbell'] },
          },
        },
        profile: { run_days_per_week: 4, lift_days_per_week: liftDaysPerWeek },
        raceIds: [raceId],
        choice: 'adjust_goal',
        previewAndApply: previewAndApplyPlan,
      })
      const authoritative = harness.readApplied({ payload: applied.data })
      const persistedPaces = authoritative.plan.weeks.flatMap((week) => week.days)
        .flatMap((day) => day.sessions)
        .map((session) => Number(session.goal_pace_seconds_per_mile || 0))
        .filter((pace) => pace > 0)
      assert.deepEqual(
        harness.transportReceipts.map((receipt) => receipt.pathname),
        ['/plans/generate-for-races', `/plans/candidates/${applied.data.candidate_id}/apply`],
        `${liftDaysPerWeek} lifts executes frontend preview then backend apply`,
      )
      assert.equal(harness.transportReceipts[0].body.choice, 'adjust_goal')
      assert.equal(harness.transportReceipts[0].body.target.runDaysPerWeek, 4, 'profile run preference cannot be shadowed by a null plan value')
      assert.equal(harness.transportReceipts[0].body.target.liftDaysPerWeek, liftDaysPerWeek)
      assert.equal(harness.transportReceipts[0].body.target.planMode, 'hybrid_maintain')
      assert.notEqual(planModeLabel(harness.transportReceipts[0].body.target.planMode), 'Run only')
      assert.equal(applied.data.ok, true)
      assert.equal(authoritative.assignment.status, 'active')
      assert.equal(authoritative.plan.goal.goalTimeSeconds, 6000)
      assert.ok(Math.min(...persistedPaces) > 525, 'production generation and persisted read-back prove an easier pace')
      assert.deepEqual(harness.ownerLockReceipts.slice(-2).map((receipt) => receipt.stage), ['entered', 'committed'])
    } finally {
      harness.cleanup()
    }
  }
} finally {
  api.post = originalApiPost
  unregisterLifecycleReview()
}

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


// Read-only projection must reject missing, stale and mismatched canonical manifests.
const { adaptivePreviewSessions, previewSteps } = await import('../src/lib/adaptivePreviewView.js')
const payload = structuredClone(adaptivePreviewPublicFixture)
const now = Date.parse(adaptivePreviewNow)
assert.equal(adaptivePreviewSessions(payload, now).length, 7)
assert.equal(adaptivePreviewSessions({ ...payload, surface_manifest: null }, now).length, 0)
assert.equal(adaptivePreviewSessions(payload, Date.parse('2026-09-16')).length, 0)
assert.equal(adaptivePreviewSessions({ ...payload, candidate_hash: 'wrong' }, now).length, 0)
const staleBinding = structuredClone(payload)
staleBinding.apply_bindings.athlete_state_revision++
assert.equal(adaptivePreviewSessions(staleBinding, now).length, 0)
const unknown = structuredClone(payload)
unknown.plan.plan_data.overall_feasibility = 'unsupported'
unknown.surface_manifest.feasibility.status = 'unsupported'
assert.equal(adaptivePreviewSessions(unknown, now).length, 0)
const drift = structuredClone(payload)
drift.surface_manifest.sessions[0].steps[0].target.duration_s++
assert.equal(adaptivePreviewSessions(drift, now).length, 0)
const unsupported = structuredClone(payload)
unsupported.surface_manifest.status = 'unsupported'
assert.equal(adaptivePreviewSessions(unsupported, now).length, 0)
assert.ok(previewSteps(payload.surface_manifest.sessions[0].steps).some(text => text.includes('975') || text.includes('16 min 15 sec')))
assert.deepEqual(previewSteps([{ type: 'UNKNOWN_STEP', target: { UNKNOWN_TARGET: 100 }, children: [] }]), ['Training step'])

for (const mode of ['off', 'shadow', 'on']) {
  assert.equal(planCandidateRequiresReview({ candidate: { status: 'preview' },
    surface_manifest: { feature_mode: mode, status: 'preview' },
    plan: { plan_data: { overall_feasibility: 'supported', engineVersion: 'race_plan_candidate_engine' } } }), false)
}

// ON still reviews the same bound seven-day prescription before approval.
const on = structuredClone(payload)
on.requires_apply = true
on.feature_mode = 'on'
on.apply_bindings.feature_mode = 'on'
Object.assign(on.surface_manifest, { feature_mode: 'on', surface_capability: 'EXECUTABLE', apply_disabled: false })
assert.equal(adaptivePreviewSessions(on, now).length, 7)
assert.equal(candidateFeasibilityCanApply(on.plan.plan_data), true)
assert.equal(planCandidateRequiresReview(on), true)
for (const mutate of [
  p => { p.surface_manifest.apply_disabled = true },
  p => { p.surface_manifest.surface_capability = 'PREVIEW_ONLY' },
  p => { p.apply_bindings.feature_mode = 'preview' },
  p => { p.surface_manifest.status = 'accepted' },
  p => { p.surface_manifest.sessions[0].steps[0].target.duration_s++ },
]) {
  const invalid = structuredClone(on)
  mutate(invalid)
  assert.equal(adaptivePreviewSessions(invalid, now).length, 0)
}
const realNow = Date.now
Date.now = () => now
try {
  for (const decision of ['apply', 'cancel']) {
    let reviews = 0, applies = 0
    const stop = registerPlanCandidateReviewer(async value => { reviews++; assert.equal(value, on); return decision })
    try {
      if (decision === 'apply') assert.equal(await reviewPlanCandidateBeforeApply(on, () => { applies++; return 'accepted' }), 'accepted')
      else await assert.rejects(reviewPlanCandidateBeforeApply(on, () => { applies++ }), isPlanCandidateReviewCancelled)
      assert.equal(reviews, 1)
      assert.equal(applies, decision === 'apply' ? 1 : 0)
    } finally { stop() }
  }
  let applies = 0
  await assert.rejects(reviewPlanCandidateBeforeApply({ ...on, surface_manifest: null }, () => { applies++ }), e => e.code === 'ADAPTIVE_CANDIDATE_UNAVAILABLE')
  assert.equal(applies, 0)
} finally { Date.now = realNow }

console.log('PLAN CANDIDATE REVIEW SMOKE OK (runtime preview/apply/read-back and unconditional canonical projection covered)')

// A failed race preview never opens review or reaches apply. Response is mocked here.
{
  const originalPost = api.post
  const calls = []
  const error = Object.assign(new Error('planner limitation'), { response: { status: 409, data: {
    code: 'GOAL_BACKWARD_GENERATION_FAILED', details: { reason_code: 'RACE_CALENDAR_HORIZON_UNSUPPORTED' },
    error: 'The current adaptive planner builds seven days. Your active plan was not changed.',
  } } })
  api.post = async url => { calls.push(url); throw error }
  try {
    await assert.rejects(previewAndApplyPlan('/plans/generate-for-race/army', { target: { runDaysPerWeek: 4, liftDaysPerWeek: 4 } }), e => e === error)
    assert.deepEqual(calls, ['/plans/generate-for-race/army'])
  } finally { api.post = originalPost }
  assert.match(read('frontend/src/pages/PlanCatalog.jsx'), /cannot cover the full period or verify required training data/)
  assert.match(read('frontend/src/pages/PlanCatalog.jsx'), /Your race was saved, but your training plan was not changed/)
  assert.match(sheet, /seven.day/i)
}
