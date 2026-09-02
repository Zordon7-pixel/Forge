export const SELF_SERVICE_REMOVAL_TIMEOUT_MS = 45000
export const PLAN_RESET_CONFIRMATION = 'CLEAR_ACTIVE_PLAN_AND_REMOVE_RACE'
export const ACTIVE_PLAN_DELETE_CONFIRMATION = 'DELETE_ACTIVE_PLAN'

const RESET_REQUIRED_RESPONSES = new Set([
  'GOAL_BACKWARD_GENERATION_FAILED',
  'ACTIVE_PLAN_LINKAGE_UNVERIFIED',
])

function removalError(message, code, cause = null) {
  const error = new Error(message)
  error.code = code
  if (cause) error.cause = cause
  return error
}

function ensureImmediateResponse(data) {
  if (data?.queued === true || data?.offline === true) {
    throw removalError(
      'Race removal needs a live connection and was not queued. Reconnect, refresh, and try again.',
      'REMOVAL_OFFLINE',
    )
  }
  return data
}

async function requestWithDeadline(request, timeoutMs, label) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  let timer = null
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller?.abort()
      reject(removalError(
        `${label} took too long. Forge stopped waiting so the screen cannot stay stuck.`,
        'REMOVAL_TIMEOUT',
      ))
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      Promise.resolve().then(() => request({ timeout: timeoutMs, signal: controller?.signal })),
      deadline,
    ])
  } catch (error) {
    if (error?.code === 'REMOVAL_TIMEOUT') throw error
    if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT' || error?.name === 'AbortError') {
      throw removalError(
        `${label} took too long. Forge stopped waiting so the screen cannot stay stuck.`,
        'REMOVAL_TIMEOUT',
        error,
      )
    }
    throw error
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function asPlanResetRequired(error, allowedCode) {
  const status = Number(error?.response?.status)
  const code = String(error?.response?.data?.code || '')
  if (status !== 409 || code !== allowedCode || !RESET_REQUIRED_RESPONSES.has(code)) return error
  return removalError(
    'This race cannot be removed safely because the current plan cannot be rebuilt safely. Review the plan-clearing option to continue.',
    'PLAN_RESET_REQUIRED',
    error,
  )
}

export async function removeOwnedRace({ api, raceId, planningClock, timeoutMs = SELF_SERVICE_REMOVAL_TIMEOUT_MS }) {
  const encodedRaceId = encodeURIComponent(String(raceId || ''))
  let previewData
  try {
    const response = await requestWithDeadline(
      (config) => api.post(`/races/${encodedRaceId}/removal-preview`, planningClock, config),
      timeoutMs,
      'Race removal review',
    )
    previewData = response.data
  } catch (error) {
    throw asPlanResetRequired(error, 'GOAL_BACKWARD_GENERATION_FAILED')
  }
  const data = ensureImmediateResponse(previewData)
  if (!data?.requires_apply) {
    let directResponse
    try {
      directResponse = await requestWithDeadline(
        (config) => api.delete(`/races/${encodedRaceId}`, config),
        timeoutMs,
        'Race removal',
      )
    } catch (error) {
      throw asPlanResetRequired(error, 'ACTIVE_PLAN_LINKAGE_UNVERIFIED')
    }
    ensureImmediateResponse(directResponse?.data)
    return { path: 'direct', expectedRemainingRaceIds: null }
  }

  const candidateId = String(data.candidate_id || '')
  const candidateHash = String(data.candidate_hash || '')
  if (!candidateId || !candidateHash) {
    throw new Error('The safe replacement plan is missing its apply token.')
  }
  const expectedRemainingRaceIds = Array.isArray(data?.removal?.remaining_race_ids)
    ? data.removal.remaining_race_ids.map(String)
    : null
  const applyBindings = data?.apply_bindings && typeof data.apply_bindings === 'object'
    && !Array.isArray(data.apply_bindings) ? data.apply_bindings : {}
  let applyResponse
  try {
    applyResponse = await requestWithDeadline(
      (config) => api.post(`/races/${encodedRaceId}/removal-apply`, {
        ...applyBindings,
        candidate_id: candidateId,
        candidate_hash: candidateHash,
        choice: 'train_for_target',
        ...planningClock,
      }, config),
      timeoutMs,
      'Race removal apply',
    )
  } catch (error) {
    error.expectedRemainingRaceIds = expectedRemainingRaceIds
    throw error
  }
  ensureImmediateResponse(applyResponse?.data)
  return { path: 'linked', candidateId, expectedRemainingRaceIds }
}

export async function resetOwnedRace({ api, raceId, timeoutMs = SELF_SERVICE_REMOVAL_TIMEOUT_MS }) {
  const encodedRaceId = encodeURIComponent(String(raceId || ''))
  const { data } = await requestWithDeadline(
    (config) => api.post(`/races/${encodedRaceId}/removal-reset`, {
      confirmation: PLAN_RESET_CONFIRMATION,
    }, config),
    timeoutMs,
    'Plan clear and race removal',
  )
  return ensureImmediateResponse(data)
}

export async function removeScheduledWorkout({ api, sessionId, timeoutMs = SELF_SERVICE_REMOVAL_TIMEOUT_MS }) {
  const encodedSessionId = encodeURIComponent(String(sessionId || ''))
  const { data } = await requestWithDeadline(
    (config) => api.delete(`/plans/my/sessions/${encodedSessionId}`, config),
    timeoutMs,
    'Workout removal',
  )
  ensureImmediateResponse(data)
  return data
}

export async function deleteActivePlan({ api, timeoutMs = SELF_SERVICE_REMOVAL_TIMEOUT_MS }) {
  const { data } = await requestWithDeadline(
    (config) => api.delete('/plans/my', {
      ...config,
      data: { confirmation: ACTIVE_PLAN_DELETE_CONFIRMATION },
    }),
    timeoutMs,
    'Training plan deletion',
  )
  ensureImmediateResponse(data)
  return data
}
