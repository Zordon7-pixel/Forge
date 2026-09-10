export function ensureRecordedMissedSession(response) {
  const data = response?.data
  if (response?.status === 202 || data?.queued || data?.offline || data?.outcome !== 'recorded'
    || data?.ok !== true || !data?.record?.fingerprint || data?.plan_changed !== false) {
    throw new Error('This missed session has not been saved. Reconnect and try again.')
  }
  return data
}
