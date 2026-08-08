import { candidateFeasibilityCanApply } from './planCandidateFeasibility.js'

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

export function planCandidateRequiresReview(preview = {}) {
  const plan = preview?.plan?.plan_data || preview?.candidate?.plan_data || {}
  const feasibility = String(plan?.overall_feasibility || '').toLowerCase()
  return Boolean(preview?.replaces_active_plan)
    || feasibility === 'stretch'
    || !candidateFeasibilityCanApply(plan)
}

export async function reviewPlanCandidateBeforeApply(preview, apply) {
  if (typeof apply !== 'function') throw new TypeError('Plan apply callback is required.')
  if (planCandidateRequiresReview(preview)) {
    const decision = await requestPlanCandidateReview(preview)
    if (decision !== 'apply') throw new PlanCandidateReviewCancelled(decision)
  }
  return apply()
}

export function isPlanCandidateReviewCancelled(error) {
  return error?.code === 'PLAN_REVIEW_CANCELLED'
}
