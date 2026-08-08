import api from './api'
import {
  PlanCandidateReviewCancelled,
  requestPlanCandidateReview,
} from './planCandidateReview'

export function phonePlanningClock(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return {
    planning_date_local: `${year}-${month}-${day}`,
    timezone_offset_minutes: date.getTimezoneOffset(),
  }
}

export async function previewAndApplyPlan(path, body = {}, config = {}) {
  const clock = phonePlanningClock()
  const preview = await api.post(path, { ...body, ...clock }, config)
  if (!preview.data?.requires_apply) return preview

  const candidateId = String(preview.data.candidate_id || '').trim()
  const candidateHash = String(preview.data.candidate_hash || '').trim()
  if (!candidateId || !candidateHash) {
    throw new Error('Plan preview did not include an apply token.')
  }

  const plan = preview.data?.plan?.plan_data || preview.data?.candidate?.plan_data || {}
  const feasibility = String(plan?.overall_feasibility || '').toLowerCase()
  const needsReview = Boolean(preview.data?.replaces_active_plan) || feasibility !== 'supported'
  if (needsReview) {
    const decision = await requestPlanCandidateReview(preview.data)
    if (decision !== 'apply') throw new PlanCandidateReviewCancelled(decision)
  }

  const applied = await api.post(
    `/plans/candidates/${encodeURIComponent(candidateId)}/apply`,
    {
      candidate_hash: candidateHash,
      choice: 'train_for_target',
      planning_date_local: clock.planning_date_local,
    },
    config,
  )
  return {
    ...applied,
    data: {
      ...applied.data,
      preview: preview.data,
    },
  }
}
