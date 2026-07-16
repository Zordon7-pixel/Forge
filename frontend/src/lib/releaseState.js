import api from './api'

const MAX_SEQUENCE = 1000000

export function normalizeSeenSequence(value) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 && number <= MAX_SEQUENCE ? number : 0
}

function storageKey(userId) {
  return `forge_whats_new_seen:${String(userId || '').trim()}`
}

export function readLocalReleaseState(userId) {
  if (!userId) return { seenSequence: 0, pending: false }
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(userId)) || 'null')
    return {
      seenSequence: normalizeSeenSequence(parsed?.seenSequence),
      pending: parsed?.pending === true,
    }
  } catch (error) {
    console.warn('[releaseState] local read failed:', error?.message || error)
    return { seenSequence: 0, pending: false }
  }
}

export function writeLocalReleaseState(userId, seenSequence, pending = false) {
  if (!userId) return
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify({
      seenSequence: normalizeSeenSequence(seenSequence),
      pending: Boolean(pending),
    }))
  } catch (error) {
    console.warn('[releaseState] local write failed:', error?.message || error)
  }
}

export async function loadReleaseState(userId) {
  const local = readLocalReleaseState(userId)
  try {
    const response = await api.get('/releases/state')
    const serverSeen = normalizeSeenSequence(response.data?.seenSequence)
    const seenSequence = local.pending ? serverSeen : Math.max(serverSeen, local.seenSequence)
    if (serverSeen >= local.seenSequence) writeLocalReleaseState(userId, serverSeen, false)
    return { seenSequence, serverAvailable: true }
  } catch (error) {
    console.error('[releaseState] server read failed:', error?.message || error)
    return { seenSequence: local.seenSequence, serverAvailable: false }
  }
}

export async function acknowledgeRelease(userId, seenSequence) {
  const next = normalizeSeenSequence(seenSequence)
  const previous = readLocalReleaseState(userId)
  const optimistic = Math.max(previous.seenSequence, next)
  writeLocalReleaseState(userId, optimistic, true)
  try {
    const response = await api.put('/releases/state', { seenSequence: optimistic })
    const persisted = Math.max(optimistic, normalizeSeenSequence(response.data?.seenSequence))
    writeLocalReleaseState(userId, persisted, false)
    return { seenSequence: persisted, persisted: true }
  } catch (error) {
    console.error('[releaseState] server write failed:', error?.message || error)
    return { seenSequence: optimistic, persisted: false }
  }
}

export function releasePromptSessionKey(userId, sequence) {
  return `forge_whats_new_prompted:${String(userId || '').trim()}:${normalizeSeenSequence(sequence)}`
}
