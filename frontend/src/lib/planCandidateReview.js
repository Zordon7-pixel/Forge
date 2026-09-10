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
    || (plan.programReconciliation || []).some(week => week.entries?.some(entry => entry.outcome !== 'EXACT'))
    || ['stretch', 'unvalidated', 'at_risk'].includes(feasibility)
    || !candidateFeasibilityCanApply(plan)
}

export async function reviewPlanCandidateBeforeApply(preview, apply) {
  if (typeof apply !== 'function') throw new TypeError('Plan apply callback is required.')
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
