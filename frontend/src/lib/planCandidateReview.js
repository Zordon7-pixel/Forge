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

export function isPlanCandidateReviewCancelled(error) {
  return error?.code === 'PLAN_REVIEW_CANCELLED'
}
