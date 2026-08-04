export const RUN_PROVENANCE = Object.freeze({
  MANUAL: 'manual',
  LIVE_TRACKED: 'live_tracked',
  IMPORTED: 'imported',
  UNKNOWN: 'unknown',
})

const IMPORT_WATCH_MODES = new Set(['import', 'imported', 'provider'])
const LIVE_HEALTH_SOURCES = new Set(['forged_hybrid'])
const MANUAL_DISTANCE_SOURCES = new Set(['manual'])

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function normalizeRunProvenance(value) {
  return Object.values(RUN_PROVENANCE).includes(value) ? value : RUN_PROVENANCE.UNKNOWN
}

export function runProvenanceFromRecord(run = {}) {
  const watchMode = String(run.watch_mode || run.watchMode || '').trim().toLowerCase()
  const healthSource = String(run.health_source || run.healthSource || '').trim().toLowerCase()
  const metrics = parseObject(run.workout_metrics_json || run.workoutMetrics)
  const distanceSource = String(metrics.distance_source || metrics.distanceSource || '').trim().toLowerCase()

  if (IMPORT_WATCH_MODES.has(watchMode)) return RUN_PROVENANCE.IMPORTED
  if (LIVE_HEALTH_SOURCES.has(healthSource)) return RUN_PROVENANCE.LIVE_TRACKED
  if (watchMode === RUN_PROVENANCE.MANUAL || MANUAL_DISTANCE_SOURCES.has(distanceSource)) {
    return RUN_PROVENANCE.MANUAL
  }
  if (healthSource) return RUN_PROVENANCE.IMPORTED
  return RUN_PROVENANCE.UNKNOWN
}

export function runCompletionPolicy(provenance) {
  const resolved = normalizeRunProvenance(provenance)
  return {
    provenance: resolved,
    requiresImmediateCheckIn: resolved === RUN_PROVENANCE.LIVE_TRACKED,
    offersRetrospectiveCheckIn: resolved === RUN_PROVENANCE.MANUAL
      || resolved === RUN_PROVENANCE.IMPORTED,
  }
}

export function resolveRunCompletion({ provenance, runId, queued = false } = {}) {
  const policy = runCompletionPolicy(provenance)
  const normalizedRunId = String(runId || '').trim()
  const recapPath = normalizedRunId
    ? `/run/recap/${encodeURIComponent(normalizedRunId)}`
    : null
  return {
    ...policy,
    runId: normalizedRunId || null,
    queued: Boolean(queued),
    recapPath,
    destination: recapPath,
  }
}

export default {
  RUN_PROVENANCE,
  normalizeRunProvenance,
  resolveRunCompletion,
  runCompletionPolicy,
  runProvenanceFromRecord,
}
