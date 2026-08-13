export const ADAPTATION_DECISION_RETRY_CODE = 'ADAPTATION_DECISION_NOT_COMMITTED'
export const ADAPTATION_DECISION_RETRY_MESSAGE = 'Forge did not save this choice immediately. Reconnect, refresh the proposal, and choose again.'

export function ensureCommittedAdaptationDecision(response, expectedDecision) {
  const data = response?.data
  const responseStatus = Number(response?.status || 0)
  const queuedOrOffline = responseStatus === 202 || data?.queued === true || data?.offline === true
  const expectedStatus = expectedDecision === 'accept'
    ? 'accepted'
    : expectedDecision === 'keep'
      ? 'kept'
      : String(expectedDecision || '')
  const committed = data?.ok === true && String(data?.status || '') === expectedStatus
  if (queuedOrOffline || !committed) {
    const error = new Error(ADAPTATION_DECISION_RETRY_MESSAGE)
    error.code = ADAPTATION_DECISION_RETRY_CODE
    error.refreshRequired = true
    throw error
  }
  return data
}

export function isAdaptationDecisionRetryRequired(error) {
  return error?.code === ADAPTATION_DECISION_RETRY_CODE
}
