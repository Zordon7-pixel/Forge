// Phone-only trace policy. All time inputs are explicit milliseconds; distances are meters.
// Quality-accepted observations update liveness; confirmed motion emits a smoothed track.
export const METERS_PER_MILE = 1609.344
const COUNT_LIMIT = 65535
const REASONS = ['coordinates', 'accuracy', 'timestamp', 'stale', 'order', 'speed', 'jitter']
export function createGpsTrace({ startedAtMs, autoPauseEnabled = true } = {}) {
  return { startedAtMs, autoPauseEnabled, autoPaused: false, stationarySinceMs: null,
    movementWindow: [], movingSinceMs: null, motionConfirmed: false, smoothedSpeedMps: null, filterPosition: null, trackingSpeed: 0,
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
  if (reason === 'auto-pause-disabled' || reason === 'auto-resume') return state
  return { ...state, boundary: reason, stationarySinceMs: null, movingSinceMs: null, movementWindow: [], motionConfirmed: false }
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
// Accuracy-weighted local motion fit on source time. Sustained transverse
// acceleration corrects the line fit on bends; distance uses emitted positions.
// Bounded history also supplies velocity uncertainty, so stationary scatter is
// not mistaken for movement. Optional platform speed is deliberately irrelevant.
function movementObservation(state, fix, breakSegment) {
  let history = breakSegment ? [] : (state.movementWindow || [])
    .filter(point => fix.timestampMs - point.timestampMs <= 32000)
  // Compact dense callbacks across time rather than truncating to the newest
  // 64: otherwise high-rate sources could never reach the six-second warm-up.
  if (history.length >= 64) history = history.filter((_, index) => index % 2 === 0)
  const window = [...history, fix]
  const origin = window[0], scale = 6371000 * Math.PI / 180
  const cosLat = Math.max(1e-9, Math.cos(origin.lat * Math.PI / 180))
  const samples = window.map(point => ({
    t: (point.timestampMs - fix.timestampMs) / 1000,
    t2: ((point.timestampMs - fix.timestampMs) / 1000) ** 2,
    x: ((point.lon - origin.lon + 540) % 360 - 180) * scale * cosLat,
    y: (point.lat - origin.lat) * scale,
    // Reported accuracy is a radius, not observed per-axis Gaussian variance.
    // Inverse-radius weights retain responsiveness when reported accuracy changes.
    w: 1 / Math.max(1, point.accuracy),
  }))
  const fit = samples => {
    const weight = samples.reduce((sum, p) => sum + p.w, 0)
    const mean = key => samples.reduce((sum, p) => sum + p.w * p[key], 0) / weight
    const t = mean('t'), x = mean('x'), y = mean('y')
    let tt = 0, tx = 0, ty = 0
    for (const p of samples) {
      tt += p.w * (p.t - t) ** 2
      tx += p.w * (p.t - t) * (p.x - x)
      ty += p.w * (p.t - t) * (p.y - y)
    }
    const vx = tt ? tx / tt : 0, vy = tt ? ty / tt : 0
    const residual = samples.reduce((sum, p) => sum + p.w *
      ((p.x - x - vx * (p.t - t)) ** 2 + (p.y - y - vy * (p.t - t)) ** 2), 0)
    const uncertainty = samples.length > 2 && tt ? Math.sqrt(residual / (samples.length - 2) / tt) : 0
    // Orthogonalize the quadratic term against the line to estimate curvature
    // without changing the position/velocity trend used by pause hysteresis.
    const t2 = mean('t2')
    const tq = tt ? samples.reduce((sum, p) => sum + p.w * (p.t - t) * p.t ** 2, 0) / tt : 0
    let qq = 0, qx = 0, qy = 0
    for (const p of samples) {
      const q = p.t ** 2 - t2 - tq * (p.t - t)
      qq += p.w * q * q
      qx += p.w * q * p.x
      qy += p.w * q * p.y
    }
    return { x: x - vx * t, y: y - vy * t, vx, vy, uncertainty,
      q0: -t2 + tq * t, qSlope: -tq, qx: qq > 1e-9 ? qx / qq : 0, qy: qq > 1e-9 ? qy / qq : 0,
      qUncertainty: samples.length > 3 && qq > 1e-9 ? Math.sqrt(Math.max(0, residual - (qx * qx + qy * qy) / qq) / (samples.length - 3) / qq) : Infinity }
  }
  // A six-second warm-up prevents two noisy fixes from authorizing movement.
  // The 16-second trend and three-second speed filter suppress scatter; the
  // hysteresis below measures additional sustained source time, not fix counts.
  const trend = fit(samples.filter(p => p.t >= -16))
  const seconds = (fix.timestampMs - origin.timestampMs) / 1000
  const dt = state.lastFix ? (fix.timestampMs - state.lastFix.timestampMs) / 1000 : 0
  const observedSpeed = Math.max(0, Math.hypot(trend.vx, trend.vy) - 2 * trend.uncertainty)
  const priorSpeed = breakSegment ? null : state.smoothedSpeedMps
  const speed = seconds >= 6 ? priorSpeed == null ? observedSpeed
    : priorSpeed + (1 - Math.exp(-dt / 3)) * (observedSpeed - priorSpeed) : null
  const trackingSpeed = Math.max(Math.hypot(trend.vx, trend.vy), breakSegment ? 0 : (state.trackingSpeed || 0) * Math.exp(-dt / 30))
  // Shorten position history at running speeds (24m travel, bounded 8–16s),
  // while keeping the pause estimator's full history through turns.
  const horizon = Math.max(8, Math.min(16, 24 / Math.max(1, trackingSpeed)))
  const local = fit(samples.filter(p => p.t >= -horizon))
  // A line extrapolated to the newest time lies outside a curved track, and
  // its slope points toward the middle of the window instead of the endpoint.
  // Estimate transverse quadratic motion over 32s, requiring 24s of history
  // and shrinking coefficients within two residual standard errors to zero.
  // This longer baseline separates sustained turning from per-fix scatter.
  // Projecting across velocity leaves longitudinal stop/reversal response to
  // the short fit. Correct both endpoint and heading using the same polynomial;
  // correcting only position leaves the directional filter's outward bias.
  let { vx, vy } = local
  const magnitude = Math.hypot(vx, vy)
  const nx = magnitude ? -vy / magnitude : 0, ny = magnitude ? vx / magnitude : 0
  const curve = fit(samples)
  const curvature = curve.qx * nx + curve.qy * ny
  const confidence = seconds >= 24 && curvature ? Math.max(0, 1 - (2 * curve.qUncertainty / curvature) ** 2) : 0
  const correction = local.q0 * curvature * confidence
  local.x += correction * nx
  local.y += correction * ny
  const velocityCorrection = local.qSlope * curvature * confidence
  vx += velocityCorrection * nx
  vy += velocityCorrection * ny
  const position = { ...fix, lat: origin.lat + local.y / scale,
    lon: ((origin.lon + local.x / (scale * cosLat) + 540) % 360) - 180 }
  const prior = breakSegment ? null : state.filterPosition
  const response = Math.max(1, trackingSpeed / 1.4)
  const alpha = 1 - Math.exp(-dt * response / 3)
  // Correct along the local velocity more quickly than across it. Lateral
  // scatter should not turn a straight walk into a longer zigzag track.
  let smoothed = position
  if (prior && window.length > 2) {
    const dx = ((position.lon - prior.lon + 540) % 360 - 180) * scale * cosLat
    const dy = (position.lat - prior.lat) * scale
    const magnitude = Math.hypot(vx, vy)
    const ux = magnitude ? vx / magnitude : 0, uy = magnitude ? vy / magnitude : 0
    const along = dx * ux + dy * uy
    const lateralGain = 1 - Math.exp(-dt * response / 7)
    // Partial velocity prediction reduces causal-filter lag, bounded to half
    // a step so a noisy instantaneous heading cannot fully steer the position.
    const prediction = Math.min(0.5, 0.25 * response - 0.1)
    const mx = prediction * (1 - alpha) * vx * dt + alpha * along * ux + lateralGain * (dx - along * ux)
    const my = prediction * (1 - alpha) * vy * dt + alpha * along * uy + lateralGain * (dy - along * uy)
    smoothed = { ...position, lat: prior.lat + my / scale,
      lon: ((prior.lon + mx / (scale * cosLat) + 540) % 360) - 180 }
  }
  return { window, speed, trackingSpeed, position: { ...smoothed, lat: Math.max(-90, Math.min(90, smoothed.lat)) } }
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
  const movement = movementObservation(state, fix, breakSegment)
  let stationarySinceMs = state.stationarySinceMs
  let movingSinceMs = state.movingSinceMs
  let autoPaused = state.autoPaused
  let motionConfirmed = breakSegment ? false : state.motionConfirmed
  if (!previous || breakSegment) { stationarySinceMs = null; movingSinceMs = null }
  else {
    stationarySinceMs = movement.speed !== null && movement.speed < 0.3 ? (stationarySinceMs ?? fix.timestampMs) : null
    movingSinceMs = movement.speed > 0.6 ? (movingSinceMs ?? fix.timestampMs) : null
  }
  // With auto-pause OFF, two precise observations can establish a short leg
  // before warm-up. Default-ON always requires sustained movement evidence.
  if (!state.autoPauseEnabled && movement.window.length === 2
    && metersBetween(movement.window[0], fix) >= 2 * Math.max(1, movement.window[0].accuracy, fix.accuracy) - 1e-6) motionConfirmed = true
  if (movingSinceMs !== null && fix.timestampMs - movingSinceMs >= 3000) motionConfirmed = true
  if (stationarySinceMs !== null && fix.timestampMs - stationarySinceMs >= 10000) motionConfirmed = false
  if (!state.autoPauseEnabled) autoPaused = false
  else if (stationarySinceMs !== null && fix.timestampMs - stationarySinceMs >= 10000) autoPaused = true
  else if (movingSinceMs !== null && fix.timestampMs - movingSinceMs >= 3000) autoPaused = false
  const newSegment = !state.anchor || breakSegment
  const drawnFix = movement.position
  // Every confirmed smoothed fix is emitted and integrated. No accuracy-radius
  // chords, distance-only compensation, or automatic-pause segment boundary.
  const draw = newSegment || motionConfirmed
  const segmentId = newSegment ? state.segmentId + 1 : state.segmentId
  const distanceMeters = draw && !newSegment ? metersBetween(state.anchor, drawnFix) : 0
  const point = draw ? [drawnFix.lat, drawnFix.lon, drawnFix.altitudeMeters, drawnFix.timestampMs, drawnFix.accuracy, segmentId,
    newSegment && state.segmentId >= 0 ? normalizeGapReason(state.boundary || 'timeout') : null] : null
  const gap = breakSegment ? { kind: 'gps-gap', reason: state.boundary || 'timeout',
    afterTimestampMs: previous?.timestampMs ?? null, beforeTimestampMs: fix.timestampMs, segmentId } : null
  return { accepted: true, point, gap, distanceMeters,
    state: { ...state, ready: true, lastFix: fix, anchor: draw ? drawnFix : state.anchor,
      movementWindow: movement.window, movingSinceMs, motionConfirmed, smoothedSpeedMps: movement.speed, filterPosition: movement.position, trackingSpeed: movement.trackingSpeed,
      boundary: null, segmentId, stationarySinceMs, autoPaused,
      distanceMeters: state.distanceMeters + distanceMeters,
      counts: !draw ? { ...state.counts, jitter: Math.min(COUNT_LIMIT, state.counts.jitter + 1) } : state.counts } }
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
