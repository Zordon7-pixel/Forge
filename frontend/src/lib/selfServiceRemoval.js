export async function removeOwnedRace({ api, raceId, planningClock }) {
  const encodedRaceId = encodeURIComponent(String(raceId || ''))
  const { data } = await api.post(`/races/${encodedRaceId}/removal-preview`, planningClock)
  if (!data?.requires_apply) {
    await api.delete(`/races/${encodedRaceId}`)
    return { path: 'direct' }
  }

  const candidateId = String(data.candidate_id || '')
  const candidateHash = String(data.candidate_hash || '')
  if (!candidateId || !candidateHash) {
    throw new Error('The safe replacement plan is missing its apply token.')
  }
  await api.post(`/races/${encodedRaceId}/removal-apply`, {
    candidate_id: candidateId,
    candidate_hash: candidateHash,
    choice: 'train_for_target',
    ...planningClock,
  })
  return { path: 'linked', candidateId }
}

export async function removeScheduledWorkout({ api, sessionId }) {
  const encodedSessionId = encodeURIComponent(String(sessionId || ''))
  const { data } = await api.delete(`/plans/my/sessions/${encodedSessionId}`)
  return data
}
