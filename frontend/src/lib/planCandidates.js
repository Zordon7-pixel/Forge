import api from './api'
import {
  reviewPlanCandidateBeforeApply,
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
  const applyBindings = preview.data?.apply_bindings && typeof preview.data.apply_bindings === 'object'
    && !Array.isArray(preview.data.apply_bindings) ? preview.data.apply_bindings : {}

  const applied = await reviewPlanCandidateBeforeApply(
    preview.data,
    () => api.post(
      `/plans/candidates/${encodeURIComponent(candidateId)}/apply`,
      {
        ...applyBindings,
        candidate_hash: candidateHash,
        choice: 'train_for_target',
        ...clock,
      },
      config,
    ),
  )
  return {
    ...applied,
    data: {
      ...applied.data,
      preview: preview.data,
    },
  }
}
