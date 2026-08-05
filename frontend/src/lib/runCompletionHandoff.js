export const RUN_COMPLETION_HANDOFF_KEY = 'forged_hybrid_run_completion_handoff_v1'
export const RUN_COMPLETION_HANDOFF_EVENT = 'forge:run-completion-handoff'

export const RUN_COMPLETION_PHASE = Object.freeze({
  RECORDING: 'recording',
  SAVING: 'saving',
  QUEUED: 'queued',
  CHECKIN_PENDING: 'checkin_pending',
  RECAP_READY: 'recap_ready',
  COMPLETE: 'complete',
})

export const RUN_RECAP_TABS = Object.freeze([
  { key: 'summary', label: 'Summary' },
  { key: 'pace', label: 'Splits / Pace' },
  { key: 'heart_rate', label: 'Heart Rate / Zones' },
  { key: 'route', label: 'Route / Elevation' },
  { key: 'workout', label: 'Workout / Plan' },
  { key: 'recovery', label: 'Recovery / Check-in' },
  { key: 'media', label: 'Media / Share' },
])

const MAX_HANDOFF_AGE_MS = 48 * 60 * 60 * 1000
const MAX_ROUTE_POINTS = 800
const MAX_STRUCTURED_LENGTH = 20_000
const PROVENANCE_VALUES = new Set(['manual', 'live_tracked', 'imported', 'unknown'])
const PHASE_VALUES = new Set(Object.values(RUN_COMPLETION_PHASE))

const SAFE_SCALAR_FIELDS = Object.freeze([
  'id', 'date', 'type', 'run_type', 'run_surface', 'surface', 'distance_miles',
  'duration_seconds', 'perceived_effort', 'notes', 'watch_mode', 'avg_heart_rate',
  'avg_hr', 'max_heart_rate', 'min_heart_rate', 'cadence_spm', 'elevation_gain',
  'elevation_loss', 'pace_avg', 'vo2_max', 'training_effect_aerobic',
  'training_effect_anaerobic', 'recovery_time_hours', 'temperature_f', 'calories',
  'calories_burned', 'treadmill_brand', 'treadmill_model', 'gps_available',
  'target_zone', 'plan_session_id', 'health_source', 'health_start_at',
  'health_end_at', 'activity_start_at', 'activity_end_at', 'pain_level',
  'post_energy', 'calculated_effort', 'calculated_effort_coverage_pct',
  'effort_source', 'ai_feedback', 'name', 'title', 'created_at', 'incline_pct',
  'treadmill_speed', 'detected_surface_type', 'watch_activity_type',
  'watch_normalized_type', 'planned_match_source',
])

function storageOrNull(storage) {
  if (storage) return storage
  if (typeof window === 'undefined') return null
  return window.localStorage
}

function notifyHandoffChange() {
  if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return
  window.dispatchEvent(new Event(RUN_COMPLETION_HANDOFF_EVENT))
}

function boundedString(value, maxLength = 500) {
  if (value === null || value === undefined) return null
  const normalized = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim()
  return normalized ? normalized.slice(0, maxLength) : null
}

function parseStructured(value) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    return JSON.parse(value)
  } catch (error) {
    console.warn('[run-completion] structured field parse failed:', error?.message || error)
    return null
  }
}

function boundedStructured(value) {
  const parsed = parseStructured(value)
  if (!parsed) return null
  try {
    const serialized = JSON.stringify(parsed)
    if (serialized.length > MAX_STRUCTURED_LENGTH) return null
    return JSON.parse(serialized)
  } catch (error) {
    console.warn('[run-completion] structured field normalization failed:', error?.message || error)
    return null
  }
}

function optionalFiniteNumber(value, min, max) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  if (!Number.isFinite(number) || number < min || number > max) return null
  return number
}

function normalizeRoutePoint(value) {
  const latitude = optionalFiniteNumber(Array.isArray(value) ? value[0] : value?.lat ?? value?.latitude, -90, 90)
  const longitude = optionalFiniteNumber(Array.isArray(value) ? value[1] : value?.lon ?? value?.lng ?? value?.longitude, -180, 180)
  if (latitude === null || longitude === null) return null
  const altitude = optionalFiniteNumber(Array.isArray(value) ? value[2] : value?.alt ?? value?.altitude, -2_000, 100_000)
  const rawTime = Array.isArray(value) ? value[3] : value?.time ?? value?.timestamp
  const time = typeof rawTime === 'number' && Number.isFinite(rawTime) ? rawTime : boundedString(rawTime, 80)
  const accuracy = optionalFiniteNumber(Array.isArray(value) ? value[4] : value?.accuracy, 0, 100_000)
  return { lat: latitude, lon: longitude, alt: altitude, time, accuracy }
}

function boundedRoute(value) {
  const parsed = parseStructured(value)
  if (!Array.isArray(parsed)) return []
  const normalized = parsed.map(normalizeRoutePoint).filter(Boolean)
  if (normalized.length <= MAX_ROUTE_POINTS) return normalized
  const lastIndex = normalized.length - 1
  return Array.from({ length: MAX_ROUTE_POINTS }, (_, index) => (
    normalized[Math.round((index * lastIndex) / (MAX_ROUTE_POINTS - 1))]
  ))
}

export function buildRunCompletionSnapshot(...sources) {
  const merged = Object.assign({}, ...sources.filter((source) => source && typeof source === 'object'))
  const snapshot = {}
  for (const field of SAFE_SCALAR_FIELDS) {
    const value = merged[field]
    if (value === null || value === undefined || value === '') continue
    if (typeof value === 'number') {
      if (Number.isFinite(value)) snapshot[field] = value
      continue
    }
    if (typeof value === 'boolean') {
      snapshot[field] = value
      continue
    }
    const maxLength = field === 'notes' || field === 'ai_feedback' ? 1_500 : 240
    const normalized = boundedString(value, maxLength)
    if (normalized !== null) snapshot[field] = normalized
  }
  const structuredFields = {
    planned_session_json: merged.planned_session_json ?? merged.planned_session,
    pace_splits: merged.pace_splits,
    heart_rate_zones: merged.heart_rate_zones,
    workout_metrics_json: merged.workout_metrics_json ?? merged.workout_metrics,
  }
  for (const [field, value] of Object.entries(structuredFields)) {
    const normalized = boundedStructured(value)
    if (normalized) snapshot[field] = normalized
  }
  const route = boundedRoute(merged.route_coords)
  if (route.length) snapshot.route_coords = route
  return snapshot
}

function normalizeHeatDrift(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return {
    drifted: Boolean(value.drifted),
    label: boundedString(value.label, 120),
    reason: boundedString(value.reason, 500),
  }
}

function normalizeHandoff(value, ownerUserId, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const runId = boundedString(value.runId, 160)
  const storedOwnerId = boundedString(value.ownerUserId, 160)
  const expectedOwnerId = boundedString(ownerUserId, 160)
  const createdAt = Number(value.createdAt || value.updatedAt || 0)
  const updatedAt = Number(value.updatedAt || value.createdAt || 0)
  if (!runId || !storedOwnerId || !expectedOwnerId || storedOwnerId !== expectedOwnerId) return null
  if (!Number.isFinite(createdAt) || !Number.isFinite(updatedAt) || createdAt <= 0 || updatedAt <= 0) return null
  if (now - updatedAt > MAX_HANDOFF_AGE_MS || updatedAt - now > 60_000) return null

  const queued = Boolean(value.queued)
  const checkInPending = Boolean(value.checkInPending)
  const fallbackPhase = queued
    ? RUN_COMPLETION_PHASE.QUEUED
    : checkInPending ? RUN_COMPLETION_PHASE.CHECKIN_PENDING : RUN_COMPLETION_PHASE.RECAP_READY
  const phase = PHASE_VALUES.has(value.phase) ? value.phase : fallbackPhase
  return {
    version: 1,
    runId,
    ownerUserId: storedOwnerId,
    createdAt,
    updatedAt,
    phase,
    queued,
    checkInPending,
    snapshot: buildRunCompletionSnapshot(value.snapshot, { id: runId }),
    heatDrift: normalizeHeatDrift(value.heatDrift),
    provenance: PROVENANCE_VALUES.has(value.provenance) ? value.provenance : 'unknown',
    planProgressNotice: boundedString(value.planProgressNotice, 500),
  }
}

export function loadRunCompletionHandoff(runId, ownerUserId, storage, now = Date.now()) {
  const target = storageOrNull(storage)
  if (!target) return null
  try {
    const raw = JSON.parse(target.getItem(RUN_COMPLETION_HANDOFF_KEY) || 'null')
    const handoff = normalizeHandoff(raw, ownerUserId, now)
    if (!handoff) {
      target.removeItem(RUN_COMPLETION_HANDOFF_KEY)
      return null
    }
    return runId && handoff.runId !== String(runId) ? null : handoff
  } catch (error) {
    console.error('[run-completion] handoff restore failed:', error?.message || error)
    target.removeItem(RUN_COMPLETION_HANDOFF_KEY)
    return null
  }
}

export function saveRunCompletionHandoff(value, ownerUserId, storage, now = Date.now()) {
  const target = storageOrNull(storage)
  const runId = boundedString(value?.runId, 160)
  const normalizedOwnerId = boundedString(ownerUserId, 160)
  if (!target || !runId || !normalizedOwnerId) return null
  try {
    const existing = loadRunCompletionHandoff(runId, normalizedOwnerId, target, now)
    const queued = Boolean(value.queued)
    const checkInPending = Boolean(value.checkInPending)
    const next = normalizeHandoff({
      ...(existing || {}),
      ...value,
      runId,
      ownerUserId: normalizedOwnerId,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      phase: value.phase || (queued
        ? RUN_COMPLETION_PHASE.QUEUED
        : checkInPending ? RUN_COMPLETION_PHASE.CHECKIN_PENDING : RUN_COMPLETION_PHASE.RECAP_READY),
      snapshot: buildRunCompletionSnapshot(existing?.snapshot, value.snapshot, { id: runId }),
    }, normalizedOwnerId, now)
    if (!next) return null
    target.setItem(RUN_COMPLETION_HANDOFF_KEY, JSON.stringify(next))
    notifyHandoffChange()
    return next
  } catch (error) {
    console.error('[run-completion] handoff save failed:', error?.message || error)
    return null
  }
}

export function updateRunCompletionHandoff(runId, ownerUserId, patch, storage, now = Date.now()) {
  const existing = loadRunCompletionHandoff(runId, ownerUserId, storage, now)
  if (!existing) return null
  return saveRunCompletionHandoff({ ...existing, ...patch, runId }, ownerUserId, storage, now)
}

export function clearRunCompletionHandoff(runId, ownerUserId, storage) {
  const target = storageOrNull(storage)
  if (!target) return false
  try {
    const current = loadRunCompletionHandoff(null, ownerUserId, target)
    if (!current || (runId && current.runId !== String(runId))) return false
    target.removeItem(RUN_COMPLETION_HANDOFF_KEY)
    notifyHandoffChange()
    return true
  } catch (error) {
    console.error('[run-completion] handoff clear failed:', error?.message || error)
    return false
  }
}

export function discardRunCompletionHandoff(storage) {
  const target = storageOrNull(storage)
  if (!target) return false
  try {
    target.removeItem(RUN_COMPLETION_HANDOFF_KEY)
    notifyHandoffChange()
    return true
  } catch (error) {
    console.error('[run-completion] handoff discard failed:', error?.message || error)
    return false
  }
}

export function runCompletionRecapPath(runId) {
  const normalized = boundedString(runId, 160)
  return normalized ? `/run/recap/${encodeURIComponent(normalized)}` : null
}

export function runCompletionNavigation(handoff) {
  const destination = runCompletionRecapPath(handoff?.runId)
  return destination ? { destination, options: { replace: true } } : null
}

export default {
  RUN_COMPLETION_HANDOFF_KEY,
  RUN_COMPLETION_HANDOFF_EVENT,
  RUN_COMPLETION_PHASE,
  RUN_RECAP_TABS,
  buildRunCompletionSnapshot,
  clearRunCompletionHandoff,
  discardRunCompletionHandoff,
  loadRunCompletionHandoff,
  runCompletionNavigation,
  runCompletionRecapPath,
  saveRunCompletionHandoff,
  updateRunCompletionHandoff,
}
