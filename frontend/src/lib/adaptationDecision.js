export const ADAPTATION_DECISION_RETRY_CODE = 'ADAPTATION_DECISION_NOT_COMMITTED'
export const ADAPTATION_DECISION_RETRY_MESSAGE = 'Forge did not save this choice immediately. Reconnect, refresh the proposal, and choose again.'

export function adaptationProposalDecisionIdentity(proposal) {
  if (!proposal || typeof proposal !== 'object') return null
  const revision = String(proposal.revision || '').trim()
  const planVersion = String(proposal.planVersion || '').trim()
  if (!revision || !planVersion) return null

  const proposalId = String(proposal.id || '').trim()
  if (proposalId) return JSON.stringify(['persisted', proposalId, revision, planVersion])

  const previewFingerprint = String(proposal.previewFingerprint || '').trim()
  const planningDate = String(proposal.planningDate || '').trim()
  if (!previewFingerprint || !planningDate) return null
  return JSON.stringify(['preview', previewFingerprint, revision, planVersion, planningDate])
}

export function isSettledAdaptationProposal(proposal, settledDecisionIdentities) {
  const identity = adaptationProposalDecisionIdentity(proposal)
  return Boolean(identity && settledDecisionIdentities?.has(identity))
}

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
