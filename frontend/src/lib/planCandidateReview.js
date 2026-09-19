import { candidateFeasibilityCanApply } from './planCandidateFeasibility.js'
import { adaptivePreviewSessions } from './adaptivePreviewView.js'

let activeReviewer = null

export class PlanCandidateReviewCancelled extends Error {
  constructor(decision = 'cancel') {
    super('Plan change was not applied.')
    this.name = 'PlanCandidateReviewCancelled'
    this.code = 'PLAN_REVIEW_CANCELLED'
    this.decision = decision
  }
}

export function registerPlanCandidateReviewer(reviewer) {
  activeReviewer = typeof reviewer === 'function' ? reviewer : null
  return () => {
    if (activeReviewer === reviewer) activeReviewer = null
  }
}

export async function requestPlanCandidateReview(preview) {
  if (!activeReviewer) {
    const error = new Error('Plan review is unavailable. Your current plan was not changed.')
    error.code = 'PLAN_REVIEW_UNAVAILABLE'
    throw error
  }
  return activeReviewer(preview)
}

export function isAdaptiveCandidate(preview = {}) {
  const plan = preview?.plan?.plan_data || preview?.candidate?.plan_data || {}
  return [plan.engineVersion, plan.goal_backward_engine_version,
    preview?.surface_manifest?.authoritative_engine, preview?.generation_source].includes('adaptive-joint-solver-v1')
}

export function isAdaptivePreview(preview = {}) {
  const plan = preview?.plan?.plan_data || preview?.candidate?.plan_data || {}
  const manifest = preview?.surface_manifest
  const modes = [preview?.feature_mode, preview?.apply_bindings?.feature_mode, manifest?.feature_mode]
  // Status=preview alone is also used by legacy, apply-capable candidates.
  return modes.includes('preview')
    || manifest?.surface_capability === 'PREVIEW_ONLY'
    || (!modes.some(mode => ['off', 'shadow', 'on'].includes(mode)) && [plan.engineVersion, plan.goal_backward_engine_version, manifest?.authoritative_engine,
      preview?.generation_source].includes('adaptive-joint-solver-v1'))
}

export function planCandidateRequiresReview(preview = {}) {
  const plan = preview?.plan?.plan_data || preview?.candidate?.plan_data || {}
  const feasibility = String(plan?.overall_feasibility || '').toLowerCase()
  return isAdaptiveCandidate(preview) || isAdaptivePreview(preview) || Boolean(preview?.replaces_active_plan)
    || (plan.programReconciliation || []).some(week => week.entries?.some(entry => entry.outcome !== 'EXACT'))
    || ['stretch', 'unvalidated', 'at_risk'].includes(feasibility)
    || !candidateFeasibilityCanApply(plan)
}

export async function reviewPlanCandidateBeforeApply(preview, apply) {
  if (typeof apply !== 'function') throw new TypeError('Plan apply callback is required.')
  if (isAdaptivePreview(preview)) {
    const decision = await requestPlanCandidateReview(preview)
    throw new PlanCandidateReviewCancelled(decision === 'apply' ? 'cancel' : decision)
  }
  if (isAdaptiveCandidate(preview) && !adaptivePreviewSessions(preview).length) {
    const error = new Error('This candidate is unavailable or out of date. Generate a fresh plan review.')
    error.code = 'ADAPTIVE_CANDIDATE_UNAVAILABLE'
    throw error
  }
  const plan = preview?.plan?.plan_data || preview?.candidate?.plan_data || {}
  if ((plan.programReconciliation || []).some(week => !week.valid || week.entries?.some(entry => entry.outcome === 'UNSATISFIABLE'))) {
    const error = new Error('The generated program does not fulfill the requested schedule. Your plan was not changed.')
    error.code = 'PROGRAM_FREQUENCY_UNSATISFIABLE'
    throw error
  }
  if (planCandidateRequiresReview(preview)) {
    const decision = await requestPlanCandidateReview(preview)
    if (decision !== 'apply') throw new PlanCandidateReviewCancelled(decision)
  }
  return apply()
}

export function isPlanCandidateReviewCancelled(error) {
  return error?.code === 'PLAN_REVIEW_CANCELLED'
}
