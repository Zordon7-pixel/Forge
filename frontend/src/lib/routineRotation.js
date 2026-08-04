import { getUser } from './auth.js'

const STORAGE_PREFIX = 'forge_recent_routine'
const MAX_HISTORY_ROUTINES = 3
const MAX_IDS_PER_ROUTINE = 12

function normalizedId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  const id = String(value).trim()
  return /^[a-z0-9][a-z0-9:_-]{0,119}$/i.test(id) ? id : ''
}

function normalizeRoutineIds(value) {
  const output = []
  const seen = new Set()
  for (const rawId of Array.isArray(value) ? value : []) {
    const id = normalizedId(rawId)
    if (!id || seen.has(id)) continue
    seen.add(id)
    output.push(id)
    if (output.length >= MAX_IDS_PER_ROUTINE) break
  }
  return output
}

function normalizeHistory(value) {
  if (!Array.isArray(value)) return []
  if (!value.some(Array.isArray)) {
    const legacyRoutine = normalizeRoutineIds(value)
    return legacyRoutine.length ? [legacyRoutine] : []
  }
  return value
    .filter(Array.isArray)
    .map(normalizeRoutineIds)
    .filter((routine) => routine.length)
    .slice(0, MAX_HISTORY_ROUTINES)
}

function shuffle(items, random = Math.random) {
  const output = [...items]
  for (let index = output.length - 1; index > 0; index -= 1) {
    const value = Math.max(0, Math.min(0.999999, Number(random()) || 0))
    const swapIndex = Math.floor(value * (index + 1))
    ;[output[index], output[swapIndex]] = [output[swapIndex], output[index]]
  }
  return output
}

function storageKey(scope) {
  const userId = String(getUser()?.id || 'anonymous')
  return `${STORAGE_PREFIX}:${userId}:${scope}`
}

export function selectRotatingRoutine(pool, count, previousIds = [], random = Math.random) {
  const unique = []
  const seen = new Set()
  for (const item of Array.isArray(pool) ? pool : []) {
    const id = normalizedId(item?.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    unique.push(item)
  }

  const parsedCount = typeof count === 'number'
    ? count
    : (typeof count === 'string' && /^\d+$/.test(count.trim()) ? Number(count) : 0)
  const limit = Math.max(0, Math.min(Number.isFinite(parsedCount) ? Math.trunc(parsedCount) : 0, unique.length))
  if (!limit) return []

  const history = normalizeHistory(previousIds)
  const immediateIds = history[0] || []
  const immediate = new Set(immediateIds)
  const lastSeenAt = new Map()
  history.forEach((routine, historyIndex) => {
    routine.forEach((id) => {
      if (!lastSeenAt.has(id)) lastSeenAt.set(id, historyIndex)
    })
  })
  const neverSeen = shuffle(unique.filter((item) => !lastSeenAt.has(normalizedId(item.id))), random)
  const older = unique.filter((item) => {
    const id = normalizedId(item.id)
    return lastSeenAt.has(id) && !immediate.has(id)
  })
  const olderByRecency = []
  for (let historyIndex = history.length - 1; historyIndex >= 1; historyIndex -= 1) {
    const items = older.filter((item) => lastSeenAt.get(normalizedId(item.id)) === historyIndex)
    olderByRecency.push(...shuffle(items, random))
  }
  const justUsed = shuffle(unique.filter((item) => immediate.has(normalizedId(item.id))), random)
  const selected = [...neverSeen, ...olderByRecency, ...justUsed].slice(0, limit)

  const selectedIds = selected.map((item) => normalizedId(item.id))
  const exactRepeat = selectedIds.length === immediateIds.length
    && selectedIds.every((id, index) => id === immediateIds[index])
  if (exactRepeat && selected.length > 1) {
    const lastIndex = selected.length - 1
    const swap = selected[lastIndex]
    selected[lastIndex] = selected[lastIndex - 1]
    selected[lastIndex - 1] = swap
  } else if (exactRepeat && selected.length === 1) {
    const alternative = unique.find((item) => normalizedId(item.id) !== immediateIds[0])
    if (alternative) selected[0] = alternative
  }
  return selected
}

export function getRoutineHistory(scope) {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(scope)) || '[]')
    return normalizeHistory(parsed)
  } catch (err) {
    console.warn('[routine-rotation] recent routine could not be read:', err?.message || err)
    return []
  }
}

export function getPreviousRoutineIds(scope) {
  const seen = new Set()
  return getRoutineHistory(scope).flat().filter((id) => {
    if (seen.has(id)) return false
    seen.add(id)
    return true
  }).slice(0, MAX_HISTORY_ROUTINES * MAX_IDS_PER_ROUTINE)
}

export function getMostRecentRoutineIds(scope) {
  return getRoutineHistory(scope)[0] || []
}

export function chooseRotatingRoutine(scope, pool, count, random = Math.random) {
  return selectRotatingRoutine(pool, count, getRoutineHistory(scope), random)
}

export function rememberRoutine(scope, routine) {
  try {
    const ids = normalizeRoutineIds((Array.isArray(routine) ? routine : []).map((item) => item?.id))
    if (!ids.length) return
    const history = getRoutineHistory(scope)
    localStorage.setItem(storageKey(scope), JSON.stringify([ids, ...history].slice(0, MAX_HISTORY_ROUTINES)))
  } catch (err) {
    console.warn('[routine-rotation] recent routine could not be saved:', err?.message || err)
  }
}
