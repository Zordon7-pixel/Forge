// Phone-only trace policy. All time inputs are explicit milliseconds; distances are meters.
// A quality-accepted stationary observation updates liveness/auto-pause, never geometry.
export const METERS_PER_MILE = 1609.344
const COUNT_LIMIT = 65535
const REASONS = ['coordinates', 'accuracy', 'timestamp', 'stale', 'order', 'speed', 'jitter']
export function createGpsTrace({ startedAtMs, autoPauseEnabled = true } = {}) {
  return { startedAtMs, autoPauseEnabled, autoPaused: false, stationarySinceMs: null,
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
  return { ...state, boundary: reason, stationarySinceMs: null }
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
  const speedMps = previous && !breakSegment && !jitter ? metersBetween(previous, fix) / (gapMs / 1000) : 0
  let stationarySinceMs = state.stationarySinceMs
  let autoPaused = state.autoPaused
  const genuineMovement = !breakSegment && !jitter && Boolean(previous) && speedMps >= 0.5
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
  const draw = newSegment || (!jitter && !autoPaused)
  const segmentId = newSegment ? state.segmentId + 1 : state.segmentId
  const distanceMeters = draw && !newSegment ? displacementMeters : 0
  const point = draw ? [fix.lat, fix.lon, fix.altitudeMeters, fix.timestampMs, fix.accuracy, segmentId] : null
  const gap = breakSegment ? { kind: 'gps-gap', reason: state.boundary || 'timeout',
    afterTimestampMs: previous?.timestampMs ?? null, beforeTimestampMs: fix.timestampMs, segmentId } : null
  return { accepted: true, point, gap, distanceMeters,
    state: { ...state, ready: true, lastFix: fix, anchor: draw ? fix : state.anchor,
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
