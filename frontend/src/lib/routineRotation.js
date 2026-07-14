import { getUser } from './auth.js'

const STORAGE_PREFIX = 'forge_recent_routine'
const MAX_STORED_IDS = 20

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
    const id = String(item?.id || '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    unique.push(item)
  }

  const previous = new Set((Array.isArray(previousIds) ? previousIds : []).map(String))
  const unseen = shuffle(unique.filter((item) => !previous.has(String(item.id))), random)
  const recent = shuffle(unique.filter((item) => previous.has(String(item.id))), random)
  const limit = Math.max(0, Math.min(Math.trunc(Number(count) || 0), unique.length))
  return [...unseen, ...recent].slice(0, limit)
}

export function getPreviousRoutineIds(scope) {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(scope)) || '[]')
    return Array.isArray(parsed)
      ? parsed.map(String).filter(Boolean).slice(0, MAX_STORED_IDS)
      : []
  } catch (err) {
    console.warn('[routine-rotation] recent routine could not be read:', err?.message || err)
    return []
  }
}

export function chooseRotatingRoutine(scope, pool, count, random = Math.random) {
  return selectRotatingRoutine(pool, count, getPreviousRoutineIds(scope), random)
}

export function rememberRoutine(scope, routine) {
  try {
    const ids = (Array.isArray(routine) ? routine : [])
      .map((item) => String(item?.id || ''))
      .filter(Boolean)
      .slice(0, MAX_STORED_IDS)
    localStorage.setItem(storageKey(scope), JSON.stringify(ids))
  } catch (err) {
    console.warn('[routine-rotation] recent routine could not be saved:', err?.message || err)
  }
}
