import { metersBetween } from './gpsTrace.js'

export const ACTIVE_RUN_RETURN_FALLBACK = '/log-run'
export const ACTIVE_RUN_MAP_LAYOUT_KEY = 'forge_active_run_map_layout_v1'
export const ACTIVE_RUN_MAP_LAYOUTS = ['follow', 'overview', 'stats']

const INTERNAL_RETURN_PATHS = new Set([
  '/',
  '/checkin',
  '/community',
  '/log-run',
  '/plan',
  '/run',
])

function storageOrNull(storage) {
  if (storage) return storage
  if (typeof window === 'undefined') return null
  return window.localStorage
}

export function resolveActiveRunReturnTarget(value, fallback = ACTIVE_RUN_RETURN_FALLBACK) {
  if (typeof value !== 'string') return fallback
  const candidate = value.trim()
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\') || candidate.includes('#')) return fallback

  try {
    const parsed = new URL(candidate, 'https://forge.internal')
    if (parsed.origin !== 'https://forge.internal' || !INTERNAL_RETURN_PATHS.has(parsed.pathname)) return fallback
    return `${parsed.pathname}${parsed.search}`
  } catch (error) {
    console.warn('[ActiveRun] invalid return target:', error?.message || error)
    return fallback
  }
}

export function withActiveRunReturnTarget(state, returnTarget) {
  const navigationState = state && typeof state === 'object' && !Array.isArray(state) ? state : {}
  return {
    ...navigationState,
    activeRunReturnTo: resolveActiveRunReturnTarget(returnTarget),
  }
}

export function activeRunReturnTargetFromLocation(pathname, search = '') {
  const resolved = resolveActiveRunReturnTarget(`${pathname || ''}${search || ''}`)
  if (!resolved.startsWith('/log-run')) return resolved
  const parsed = new URL(resolved, 'https://forge.internal')
  parsed.searchParams.delete('intent')
  parsed.searchParams.delete('warmup')
  return `${parsed.pathname}${parsed.search}`
}

export function shouldProtectActiveRunNavigation({
  running = false,
  paused = false,
  countingDown = false,
  awaitingManualDistance = false,
  saving = false,
} = {}) {
  return Boolean(running || paused || countingDown || awaitingManualDistance || saving)
}

export function activeRunBackDecision({
  pendingExit = null,
  protectedNavigation = false,
  returnTarget,
} = {}) {
  if (pendingExit?.to) return { action: 'navigate', to: pendingExit.to, options: pendingExit.options || { replace: true } }
  if (protectedNavigation) return { action: 'block' }
  return { action: 'navigate', to: resolveActiveRunReturnTarget(returnTarget), options: { replace: true } }
}

export function normalizeMapPosition(value) {
  if (!Array.isArray(value) || value.length < 2) return null
  const latitude = Number(value[0])
  const longitude = Number(value[1])
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null
  return [latitude, longitude]
}

export function validMapPositions(...collections) {
  return collections.flatMap((collection) => (
    Array.isArray(collection) ? collection.map(normalizeMapPosition).filter(Boolean) : []
  ))
}

export function activeRunMapCommand(layout, { recordedPositions = [], plannedPositions = [] } = {}) {
  const selectedLayout = ACTIVE_RUN_MAP_LAYOUTS.includes(layout) ? layout : 'follow'
  if (selectedLayout === 'stats') return { type: 'hidden', positions: [] }

  const recorded = validMapPositions(recordedPositions)
  const planned = validMapPositions(plannedPositions)
  if (selectedLayout === 'overview') {
    const positions = [...recorded, ...planned]
    return positions.length ? { type: 'fit', positions } : { type: 'empty', positions: [] }
  }

  const position = recorded.at(-1) || null
  if (position) return { type: 'follow', position, positions: [position] }
  return { type: 'empty', positions: [] }
}

// Leaflet is confined to this bounded adapter. Unknown bounds are not evidence
// that the runner is near an edge. The outer 15% of the view counts as near.
export function activeRunNearViewEdge(map, position) {
  if (!normalizeMapPosition(position)) return null
  try {
    const bounds = map.getBounds()
    if (bounds.isValid() !== true) return null
    const inner = bounds.pad(-0.15)
    if (inner.isValid() !== true) return null
    const contains = inner.contains(position)
    return typeof contains === 'boolean' ? !contains : null
  } catch {
    return null // Unavailable map geometry must not fabricate an edge-triggered pan.
  }
}

export function createActiveRunMapPolicy() {
  return { layout: null, overviewFitted: false, recenterToken: 0, lastPosition: null, lastPanAt: null }
}

// Pure camera policy: explicit monotonic milliseconds and tri-state edge input.
// The first Follow fix establishes an anchor (ForgeMap starts at that center).
// Only an emitted pan advances it, so small fixes accumulate real displacement.
export function activeRunMapViewDecision(previous, {
  layout = 'follow', command, followPaused = false, recenterToken = 0,
  nowMs, nearViewEdge = null,
}) {
  const state = { ...previous, layout, recenterToken,
    overviewFitted: layout === previous.layout && previous.overviewFitted }
  const result = action => ({ state, action })
  if (layout === 'overview') {
    if (!state.overviewFitted && command.type === 'fit' && command.positions.length) {
      state.overviewFitted = true
      return result({ type: 'fit', positions: command.positions })
    }
    return result(null)
  }
  if (layout !== 'follow' || command.type !== 'follow' || followPaused || !Number.isFinite(nowMs)) return result(null)
  const position = normalizeMapPosition(command.position)
  if (!position) return result(null)
  const anchor = state.lastPosition || position
  state.lastPosition = anchor
  const moved = metersBetween({ lat: anchor[0], lon: anchor[1] }, { lat: position[0], lon: position[1] }) > 15
  const recenter = recenterToken !== previous.recenterToken
  const eligible = state.lastPanAt === null || nowMs - state.lastPanAt >= 2000
  if (!recenter && (!eligible || (!moved && nearViewEdge !== true))) return result(null)
  state.lastPosition = position
  state.lastPanAt = nowMs
  return result({ type: 'pan', position })
}

export function loadActiveRunMapLayout(storage) {
  const target = storageOrNull(storage)
  if (!target) return 'follow'
  try {
    const stored = target.getItem(ACTIVE_RUN_MAP_LAYOUT_KEY)
    return ACTIVE_RUN_MAP_LAYOUTS.includes(stored) ? stored : 'follow'
  } catch (error) {
    console.warn('[ActiveRun] map layout preference read failed:', error?.message || error)
    return 'follow'
  }
}

export function saveActiveRunMapLayout(layout, storage) {
  const selectedLayout = ACTIVE_RUN_MAP_LAYOUTS.includes(layout) ? layout : 'follow'
  const target = storageOrNull(storage)
  if (!target) return selectedLayout
  try {
    target.setItem(ACTIVE_RUN_MAP_LAYOUT_KEY, selectedLayout)
  } catch (error) {
    console.warn('[ActiveRun] map layout preference save failed:', error?.message || error)
  }
  return selectedLayout
}
