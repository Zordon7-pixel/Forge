export const SELF_SERVICE_REMOVAL_TIMEOUT_MS = 45000

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

export async function removeOwnedRace({ api, raceId, planningClock, timeoutMs = SELF_SERVICE_REMOVAL_TIMEOUT_MS }) {
  const encodedRaceId = encodeURIComponent(String(raceId || ''))
  const { data: previewData } = await requestWithDeadline(
    (config) => api.post(`/races/${encodedRaceId}/removal-preview`, planningClock, config),
    timeoutMs,
    'Race removal review',
  )
  const data = ensureImmediateResponse(previewData)
  if (!data?.requires_apply) {
    const directResponse = await requestWithDeadline(
      (config) => api.delete(`/races/${encodedRaceId}`, config),
      timeoutMs,
      'Race removal',
    )
    ensureImmediateResponse(directResponse?.data)
    return { path: 'direct' }
  }

  const candidateId = String(data.candidate_id || '')
  const candidateHash = String(data.candidate_hash || '')
  if (!candidateId || !candidateHash) {
    throw new Error('The safe replacement plan is missing its apply token.')
  }
  const applyResponse = await requestWithDeadline(
    (config) => api.post(`/races/${encodedRaceId}/removal-apply`, {
      candidate_id: candidateId,
      candidate_hash: candidateHash,
      choice: 'train_for_target',
      ...planningClock,
    }, config),
    timeoutMs,
    'Race removal apply',
  )
  ensureImmediateResponse(applyResponse?.data)
  return { path: 'linked', candidateId }
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
