import { getUser } from './auth'

const STORAGE_PREFIX = 'forge_quick_action_visits'

export const SMART_QUICK_ACTIONS = Object.freeze([
  { path: '/history', label: 'View History', icon: 'history' },
  { path: '/health', label: 'Check Body', icon: 'body' },
  { path: '/prs', label: 'View PRs', icon: 'prs' },
])

function storageKey() {
  const userId = String(getUser()?.id || 'anonymous')
  return `${STORAGE_PREFIX}:${userId}`
}

function readCounts() {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey()) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (err) {
    console.warn('[smart-quick-action] visit counts could not be read:', err?.message || err)
    return {}
  }
}

export function selectSmartQuickAction(counts = {}) {
  return SMART_QUICK_ACTIONS.reduce((best, candidate) => {
    const candidateCount = Number(counts[candidate.path] || 0)
    const bestCount = Number(counts[best.path] || 0)
    return candidateCount > bestCount ? candidate : best
  }, SMART_QUICK_ACTIONS[0])
}

export function recordSmartDestinationVisit(pathname) {
  const candidate = SMART_QUICK_ACTIONS.find((action) => action.path === pathname)
  if (!candidate) return

  try {
    const counts = readCounts()
    counts[candidate.path] = Math.min(Number(counts[candidate.path] || 0) + 1, Number.MAX_SAFE_INTEGER)
    localStorage.setItem(storageKey(), JSON.stringify(counts))
  } catch (err) {
    console.warn('[smart-quick-action] visit count could not be saved:', err?.message || err)
  }
}

export function getSmartQuickAction() {
  return selectSmartQuickAction(readCounts())
}
