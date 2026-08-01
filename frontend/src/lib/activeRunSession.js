export const ACTIVE_RUN_SESSION_KEY = 'forged_hybrid_active_run_v1'

const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000
const MAX_ROUTE_POINTS = 5000
const ACTIVE_RUN_PHASES = ['running', 'paused', 'awaiting_distance']

function storageOrNull(storage) {
  if (storage) return storage
  if (typeof window === 'undefined') return null
  return window.localStorage
}

function normalizeOwnerUserId(value) {
  if (value === null || value === undefined) return null
  const normalized = String(value).trim()
  return normalized ? normalized.slice(0, 160) : null
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function downsampleRouteCoords(points) {
  if (points.length <= MAX_ROUTE_POINTS) return points
  return Array.from({ length: MAX_ROUTE_POINTS }, (_, index) => {
    const sourceIndex = Math.round((index * (points.length - 1)) / (MAX_ROUTE_POINTS - 1))
    return points[sourceIndex]
  })
}

function normalizeRouteCoords(value) {
  if (!Array.isArray(value)) return []
  const points = value.filter((point) => (
    Array.isArray(point)
    && Number.isFinite(Number(point[0]))
    && Number.isFinite(Number(point[1]))
    && Number(point[0]) >= -90
    && Number(point[0]) <= 90
    && Number(point[1]) >= -180
    && Number(point[1]) <= 180
  )).map((point) => [
    Number(point[0]),
    Number(point[1]),
    point[2] === null || point[2] === undefined || !Number.isFinite(Number(point[2])) ? null : Number(point[2]),
    point[3] === null || point[3] === undefined || !Number.isFinite(Number(point[3])) ? null : Number(point[3]),
    point[4] === null || point[4] === undefined || !Number.isFinite(Number(point[4])) || Number(point[4]) < 0 || Number(point[4]) > 10_000
      ? null
      : Number(point[4]),
  ])
  return downsampleRouteCoords(points)
}

export function clearActiveRunSession(storage) {
  try {
    storageOrNull(storage)?.removeItem(ACTIVE_RUN_SESSION_KEY)
  } catch (error) {
    console.error('[active-run/session] clear failed:', error?.message || error)
  }
}

export function loadActiveRunSession(ownerUserId, storage, now = Date.now()) {
  const target = storageOrNull(storage)
  if (!target) return null

  try {
    const expectedOwnerUserId = normalizeOwnerUserId(ownerUserId)
    if (!expectedOwnerUserId) {
      target.removeItem(ACTIVE_RUN_SESSION_KEY)
      return null
    }

    const parsed = JSON.parse(target.getItem(ACTIVE_RUN_SESSION_KEY) || 'null')
    if (!parsed || normalizeOwnerUserId(parsed.ownerUserId) !== expectedOwnerUserId) {
      target.removeItem(ACTIVE_RUN_SESSION_KEY)
      return null
    }
    if (!ACTIVE_RUN_PHASES.includes(parsed.phase)) {
      target.removeItem(ACTIVE_RUN_SESSION_KEY)
      return null
    }

    const startedAt = finiteNumber(parsed.startedAt, 0)
    const savedAt = finiteNumber(parsed.savedAt, startedAt)
    if (!startedAt || !savedAt || now - savedAt > MAX_SESSION_AGE_MS || savedAt - now > 60_000 || startedAt - now > 60_000 || now - startedAt > MAX_SESSION_AGE_MS) {
      target.removeItem(ACTIVE_RUN_SESSION_KEY)
      return null
    }

    return {
      ownerUserId: expectedOwnerUserId,
      phase: parsed.phase,
      startedAt,
      savedAt,
      elapsed: Math.min(86_400, Math.max(0, Math.round(finiteNumber(parsed.elapsed, 0)))),
      pausedDurationMs: Math.min(MAX_SESSION_AGE_MS, Math.max(0, Math.round(finiteNumber(parsed.pausedDurationMs, 0)))),
      pauseStartedAt: parsed.phase === 'paused' ? Math.max(0, finiteNumber(parsed.pauseStartedAt, savedAt)) : 0,
      distanceMiles: Math.min(500, Math.max(0, finiteNumber(parsed.distanceMiles, 0))),
      routeCoords: normalizeRouteCoords(parsed.routeCoords),
      manualDistance: String(parsed.manualDistance || ''),
      mapMyRun: Boolean(parsed.mapMyRun),
      gpsStarted: Boolean(parsed.gpsStarted),
      gpsAvailable: Boolean(parsed.gpsAvailable),
      runEnvironment: parsed.runEnvironment === 'indoor' ? 'indoor' : 'outdoor',
      surface: String(parsed.surface || 'road').slice(0, 40),
      runType: String(parsed.runType || 'run').slice(0, 40),
      treadmillBrand: parsed.treadmillBrand ? String(parsed.treadmillBrand).slice(0, 80) : null,
      clientRunId: typeof parsed.clientRunId === 'string' && parsed.clientRunId.length <= 80 ? parsed.clientRunId : null,
      gpsGapSeconds: Math.max(0, Math.round(finiteNumber(parsed.gpsGapSeconds, 0))),
      gpsGapCount: Math.max(0, Math.round(finiteNumber(parsed.gpsGapCount, 0))),
      lastFixAt: Math.max(0, finiteNumber(parsed.lastFixAt, 0)),
      discardedSegment: Boolean(parsed.discardedSegment),
      navigationState: parsed.navigationState && typeof parsed.navigationState === 'object' && !Array.isArray(parsed.navigationState)
        ? parsed.navigationState
        : {},
    }
  } catch (error) {
    console.error('[active-run/session] restore failed:', error?.message || error)
    target.removeItem(ACTIVE_RUN_SESSION_KEY)
    return null
  }
}

export function elapsedFromSession(session, now = Date.now()) {
  if (!session?.startedAt) return 0
  if (session.phase !== 'running') return Math.max(0, Number(session.elapsed || 0))
  const activeMilliseconds = now - session.startedAt - Math.max(0, Number(session.pausedDurationMs || 0))
  return Math.max(Number(session.elapsed || 0), Math.round(activeMilliseconds / 1000))
}

export function saveActiveRunSession(session, ownerUserId, storage, now = Date.now()) {
  const target = storageOrNull(storage)
  if (!target) return

  try {
    const normalizedOwnerUserId = normalizeOwnerUserId(ownerUserId)
    if (!normalizedOwnerUserId) {
      target.removeItem(ACTIVE_RUN_SESSION_KEY)
      return
    }
    if (!session || !ACTIVE_RUN_PHASES.includes(session.phase)) return

    target.setItem(ACTIVE_RUN_SESSION_KEY, JSON.stringify({
      ...session,
      ownerUserId: normalizedOwnerUserId,
      savedAt: now,
      routeCoords: normalizeRouteCoords(session.routeCoords),
    }))
  } catch (error) {
    console.error('[active-run/session] save failed:', error?.message || error)
  }
}
