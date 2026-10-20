// Phone-only trace policy. All time inputs are explicit milliseconds; distances are meters.
// A quality-accepted stationary observation updates liveness/auto-pause, never geometry.
export const METERS_PER_MILE = 1609.344
const COUNT_LIMIT = 65535
const REASONS = ['coordinates', 'accuracy', 'timestamp', 'stale', 'order', 'speed', 'jitter']
export function createGpsTrace({ startedAtMs, autoPauseEnabled = true } = {}) {
  return { startedAtMs, autoPauseEnabled, autoPaused: false, stationarySinceMs: null,
    movementWindow: [], lastMovementFix: null,
    lastFix: null, anchor: null, segmentId: -1, boundary: null, ready: false,
    distanceMeters: 0, counts: Object.fromEntries(REASONS.map(reason => [reason, 0])) }
}
export function fixTimestampMs(value) {
  if (typeof value === 'number') return value
  return typeof value === 'string' && value.trim() ? Date.parse(value) : NaN
}
export function gpsFixRejection(fix, nowMs) {
  if (!Number.isFinite(fix?.lat) || !Number.isFinite(fix?.lon)
    || Math.abs(fix.lat) > 90 || Math.abs(fix.lon) > 180) return 'coordinates'
  if (!Number.isFinite(fix.accuracy) || fix.accuracy < 0 || fix.accuracy > 20) return 'accuracy'
  if (!Number.isFinite(fix.timestampMs) || fix.timestampMs > nowMs) return 'timestamp'
  if (nowMs - fix.timestampMs > 5000) return 'stale'
  return null
}
export function metersBetween(a, b) {
  const radians = degrees => degrees * Math.PI / 180
  const h = Math.sin(radians(b.lat - a.lat) / 2) ** 2
    + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(radians(b.lon - a.lon) / 2) ** 2
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)))
}
export function traceBoundary(state, reason = 'foreground') {
  return { ...state, boundary: reason, stationarySinceMs: null, movementWindow: [], lastMovementFix: null }
}
export function setTraceAutoPause(state, enabled) {
  return { ...state, autoPauseEnabled: enabled, autoPaused: enabled && state.autoPaused, stationarySinceMs: null }
}
export function gpsPaused(state, nowMs) {
  const lastMs = state.lastFix?.timestampMs ?? state.startedAtMs
  return Number.isFinite(lastMs) && nowMs - lastMs >= 20000
}
export function runElapsedSeconds({ startedAt, pausedDurationMs = 0, pauseStartedAt }, nowMs) {
  if (!startedAt) return 0
  return Math.max(0, Math.round(((pauseStartedAt ?? nowMs) - startedAt - pausedDurationMs) / 1000))
}
export function runPauseLabel({ manualPaused, autoPaused, gpsIsPaused }) {
  if (manualPaused) return 'Run paused'
  if (autoPaused) return 'Auto-paused'
  return gpsIsPaused ? 'GPS paused' : null
}
// Independent of the drawn anchor/accuracy radius and of optional platform speed.
// Fit position against source time, so per-fix zigzags do not inflate a path
// denominator. Displacement must clear both the accuracy-scaled noise floor and
// the observed scatter about that trend. Retain ten seconds / 64 accepted fixes.
function movementObservation(state, fix, breakSegment) {
  const samples = breakSegment ? [] : (state.movementWindow || [])
    .filter(point => fix.timestampMs - point.timestampMs <= 10000).slice(-63)
  const window = [...samples, fix]
  const seconds = (fix.timestampMs - window[0].timestampMs) / 1000
  if (window.length < 3 || seconds < 2) return { window, moving: false }
  const origin = window[0], metersPerDegree = 6371000 * Math.PI / 180
  const samplesXY = window.map(point => ({
    t: (point.timestampMs - origin.timestampMs) / 1000,
    x: ((point.lon - origin.lon + 540) % 360 - 180) * metersPerDegree * Math.cos(origin.lat * Math.PI / 180),
    y: (point.lat - origin.lat) * metersPerDegree,
  }))
  const mean = key => samplesXY.reduce((sum, point) => sum + point[key], 0) / window.length
  const t = mean('t'), x = mean('x'), y = mean('y')
  let tt = 0, tx = 0, ty = 0
  for (const point of samplesXY) {
    tt += (point.t - t) ** 2
    tx += (point.t - t) * (point.x - x)
    ty += (point.t - t) * (point.y - y)
  }
  const vx = tx / tt, vy = ty / tt
  const residualMeters = Math.sqrt(samplesXY.reduce((sum, point) => sum
    + (point.x - x - vx * (point.t - t)) ** 2
    + (point.y - y - vy * (point.t - t)) ** 2, 0) / (window.length - 2))
  const netMeters = Math.hypot(vx, vy) * seconds
  // Twice the fitted displacement's standard error accounts for sample timing
  // and scatter, without penalizing walking for its total zigzag path length.
  const uncertaintyMeters = 2 * residualMeters * seconds / Math.sqrt(tt)
  const noiseFloorMeters = Math.max(3, ...window.map(point => point.accuracy * 0.4), uncertaintyMeters)
  // A single late jump away from an otherwise settled position is insufficient
  // evidence, even if its leverage on the fitted slope is large.
  const priorProgress = window.slice(1, -1).some(point => metersBetween(origin, point) >= 0.5)
  const moving = priorProgress && netMeters >= noiseFloorMeters && netMeters / seconds >= 0.5
  return { window, moving }
}
export function acceptGpsFix(state, input, nowMs) {
  const reject = reason => ({ state: { ...state, counts: { ...state.counts,
    [reason]: Math.min(COUNT_LIMIT, state.counts[reason] + 1) } }, accepted: false, reason,
    point: null, gap: null, distanceMeters: 0 })
  const reason = gpsFixRejection(input, nowMs)
  if (reason) return reject(reason)
  const fix = { lat: input.lat, lon: input.lon, accuracy: input.accuracy, timestampMs: input.timestampMs,
    altitudeMeters: Number.isFinite(input.altitudeMeters) && input.altitudeMeters >= -2000 && input.altitudeMeters <= 100000 ? input.altitudeMeters : null }
  const previous = state.lastFix
  if (previous && fix.timestampMs <= previous.timestampMs) return reject('order')
  const gapMs = previous ? fix.timestampMs - previous.timestampMs : 0
  const breakSegment = Boolean(state.boundary) || (previous && gapMs >= 15000)
  if (previous && !breakSegment && metersBetween(previous, fix) / (gapMs / 1000) > 7) return reject('speed')
  const displacementMeters = state.anchor ? metersBetween(state.anchor, fix) : 0
  const jitter = Boolean(state.anchor) && !breakSegment && displacementMeters < Math.max(3, fix.accuracy)
  const speedMps = previous && !breakSegment ? metersBetween(previous, fix) / (gapMs / 1000) : 0
  const movement = movementObservation(state, fix, breakSegment)
  let stationarySinceMs = state.stationarySinceMs
  let autoPaused = state.autoPaused
  // Bootstrap a clear first step; once history exists, require window
  // progress. Neither decision consults the last DRAWN anchor or reported speed.
  const clearFirstStep = movement.window.length === 2 && previous
    && metersBetween(previous, fix) >= Math.max(3, previous.accuracy, fix.accuracy)
  // A noisy walking fix can nearly coincide with its predecessor. Only exact
  // repeats suppress the window's decision; minimum speed belongs to the trend.
  const genuineMovement = !breakSegment && Boolean(previous) && speedMps > 0
    && (clearFirstStep || movement.moving)
  const lastMovementFix = breakSegment ? null : genuineMovement && !state.autoPaused ? fix : state.lastMovementFix
  if (!state.autoPauseEnabled) { autoPaused = false; stationarySinceMs = null }
  else if (!previous || breakSegment) stationarySinceMs = null
  else if (genuineMovement) { autoPaused = false; stationarySinceMs = null }
  else {
    stationarySinceMs ??= previous.timestampMs
    if (fix.timestampMs - stationarySinceMs >= 10000) autoPaused = true
  }
  // Resume uses a new anchor, so none of the distance traversed while paused is counted.
  const resumed = state.autoPaused && !autoPaused
  const newSegment = !state.anchor || breakSegment || resumed
  // Flush only previously confirmed, pre-pause movement still below the drawing
  // radius. Use that observation's original timestamp/height, not stationary GPS
  // or the resume location. This preserves the tail without a paused connector.
  const pendingMovement = !state.autoPaused && autoPaused && lastMovementFix
    && lastMovementFix.timestampMs > state.anchor?.timestampMs ? lastMovementFix : null
  const drawnFix = pendingMovement || fix
  const draw = newSegment || Boolean(pendingMovement) || (!jitter && !autoPaused)
  const segmentId = newSegment ? state.segmentId + 1 : state.segmentId
  const distanceMeters = draw && !newSegment ? metersBetween(state.anchor, drawnFix) : 0
  const point = draw ? [drawnFix.lat, drawnFix.lon, drawnFix.altitudeMeters, drawnFix.timestampMs, drawnFix.accuracy, segmentId,
    newSegment && state.segmentId >= 0 ? normalizeGapReason(state.boundary || (resumed ? 'auto-resume' : 'timeout')) : null] : null
  const gap = breakSegment ? { kind: 'gps-gap', reason: state.boundary || 'timeout',
    afterTimestampMs: previous?.timestampMs ?? null, beforeTimestampMs: fix.timestampMs, segmentId } : null
  return { accepted: true, point, gap, distanceMeters,
    state: { ...state, ready: true, lastFix: fix, anchor: draw ? drawnFix : state.anchor,
      movementWindow: movement.window, lastMovementFix: resumed ? null : lastMovementFix,
      boundary: null, segmentId, stationarySinceMs, autoPaused,
      distanceMeters: state.distanceMeters + distanceMeters,
      counts: jitter ? { ...state.counts, jitter: Math.min(COUNT_LIMIT, state.counts.jitter + 1) } : state.counts } }
}
// Tuple slot 5 is additive segment identity. Never use the flat list as a polyline.
export function splitTraceSegments(points = []) {
  const segments = []
  let previousId
  for (const point of points) {
    const id = point[5] ?? 0
    if (!segments.length || id !== previousId) segments.push([])
    segments.at(-1).push(point)
    previousId = id
  }
  return segments
}

// Finished phone recordings use an explicit envelope; legacy flat routes stay legacy.
export const GAP_REASONS = ['timeout', 'foreground', 'background', 'restore', 'manual-pause', 'auto-resume', 'auto-pause-disabled', 'unknown']
export function normalizeGapReason(value) { return GAP_REASONS.includes(value) ? value : 'unknown' }
export function normalizeGpsSource(value) { return ['native_bg', 'web_fallback'].includes(value) ? value : null }
export function normalizeBackgroundRefreshStatus(value) {
  return ['available', 'denied', 'restricted', 'unknown', 'error', 'unavailable'].includes(value) ? value : 'unknown'
}
export function phoneRunDiagnostics(value = {}) {
  return { gps_source: normalizeGpsSource(value.gps_source), backgroundRefreshStatus: normalizeBackgroundRefreshStatus(value.backgroundRefreshStatus) }
}
export function phoneRunStatusLine(value = {}) {
  const status = phoneRunDiagnostics(value)
  const source = status.gps_source === 'native_bg' ? 'GPS: iPhone background' : status.gps_source === 'web_fallback'
    ? 'GPS: web fallback · keep the app visible; running remains available' : 'GPS source: unknown'
  const refresh = { denied: 'off', restricted: 'restricted', unknown: 'unknown', error: 'unavailable (check failed)', unavailable: 'unavailable' }
  return source + (status.backgroundRefreshStatus === 'available' ? '' : ` · Background refresh: ${refresh[status.backgroundRefreshStatus]}`)
}
export function finishedPhoneRoute(points = []) {
  return { version: 2, segments: splitTraceSegments(points).map((segment, index) => ({
    gap: index ? { kind: 'gps-gap', reason: normalizeGapReason(segment[0][6]) } : null,
    points: segment.map(([lat, lon, alt, time, accuracy]) => ({ lat, lon, alt, time, accuracy })),
  })) }
}
// No sampling or flattening: every supplied boundary survives, or invalid input fails closed.
export function normalizeSegmentedRoute(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { return null } }
  if (!value || value.version !== 2 || !Array.isArray(value.segments) || value.segments.length > 100000) return null
  let count = 0
  const segments = []
  for (const [index, segment] of value.segments.entries()) {
    if (!Array.isArray(segment?.points) || !segment.points.length) return null
    const points = []
    for (const point of segment.points) {
      if (++count > 100000 || !Number.isFinite(point?.lat) || Math.abs(point.lat) > 90 || !Number.isFinite(point?.lon) || Math.abs(point.lon) > 180) return null
      const optional = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null
      const time = typeof point.time === 'number' ? point.time : typeof point.time === 'string' && point.time.length <= 40 ? Date.parse(point.time) : NaN
      points.push({ lat: point.lat, lon: point.lon, alt: optional(point.alt, -2000, 100000),
        time: Number.isFinite(time) && Math.abs(time) <= 8640000000000000 ? time : null, accuracy: optional(point.accuracy, 0, 10000) })
    }
    segments.push({ gap: index ? { kind: 'gps-gap', reason: normalizeGapReason(segment.gap?.reason) } : null, points })
  }
  return { version: 2, segments }
}
