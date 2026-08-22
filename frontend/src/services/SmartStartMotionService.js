import { Capacitor, registerPlugin } from '@capacitor/core'

const ForgeMotion = registerPlugin('ForgeMotion')

export const SMART_START_PREFERENCE_KEY = 'forge_smart_start_motion_enabled_v1'
const SUPPRESSED_CANDIDATES_KEY = 'forge_smart_start_motion_suppressed_v1'
const MAX_SUPPRESSED_CANDIDATES = 50
const RECOVERY_WINDOW_MS = 36 * 60 * 60 * 1000
const RECOVERY_END_BUFFER_MS = 10 * 60 * 1000
const MAX_HISTORY_MS = 7 * 24 * 60 * 60 * 1000
const MIN_RUN_DURATION_SECONDS = 8 * 60
const MAX_RUN_DURATION_SECONDS = 6 * 60 * 60
const MIN_STEPS = 600
const MIN_DISTANCE_METERS = 750
const MAX_DISTANCE_METERS = 100_000
const MIN_SECONDS_PER_KILOMETER = 120
const MAX_SECONDS_PER_KILOMETER = 900
const AUTHORIZATION_STATES = new Set(['not_determined', 'restricted', 'denied', 'authorized'])

function storageOrNull(storage) {
  if (storage) return storage
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch (error) {
    console.warn('[SmartStart] local preference storage is unavailable:', error?.message || error)
    return null
  }
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function boundedDate(value) {
  if (typeof value !== 'string' || value.length > 40) return null
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : null
}

function normalizedAuthorization(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return AUTHORIZATION_STATES.has(normalized) ? normalized : 'not_determined'
}

function fnv1a(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function candidateFingerprint(candidate) {
  const startDate = typeof candidate?.startDate === 'string' ? candidate.startDate : ''
  const endDate = typeof candidate?.endDate === 'string' ? candidate.endDate : ''
  const steps = finiteNumber(candidate?.steps)
  const distanceMeters = finiteNumber(candidate?.distanceMeters)
  if (!startDate || !endDate || steps === null || distanceMeters === null) return ''
  const evidence = [
    startDate,
    endDate,
    Math.round(steps),
    Math.round(distanceMeters),
  ].join('|')
  return `smart-start-${fnv1a(evidence)}`
}

function summaryForSegment(segment, summaries) {
  const segmentStart = boundedDate(segment?.startDate)
  const segmentEnd = boundedDate(segment?.endDate)
  if (segmentStart === null || segmentEnd === null) return null
  return summaries.find((summary) => {
    const summaryStart = boundedDate(summary?.startDate)
    const summaryEnd = boundedDate(summary?.endDate)
    if (summaryStart === null || summaryEnd === null) return false
    return Math.abs(summaryStart - segmentStart) <= 1_000
      && Math.abs(summaryEnd - segmentEnd) <= 1_000
  }) || null
}

function candidateFromSegment(segment, summary) {
  const startAt = boundedDate(segment?.startDate)
  const endAt = boundedDate(segment?.endDate)
  const running = segment?.running === true && String(segment?.activity || '').toLowerCase() === 'running'
  if (!running || segment?.automotive === true || startAt === null || endAt === null || endAt <= startAt) return null

  const durationSeconds = (endAt - startAt) / 1000
  const steps = finiteNumber(summary?.steps)
  const distanceMeters = finiteNumber(summary?.distanceMeters)
  if (
    durationSeconds < MIN_RUN_DURATION_SECONDS
    || durationSeconds > MAX_RUN_DURATION_SECONDS
    || steps === null
    || distanceMeters === null
    || steps < MIN_STEPS
    || distanceMeters < MIN_DISTANCE_METERS
    || distanceMeters > MAX_DISTANCE_METERS
  ) return null

  const measuredPace = summary?.averageActivePaceSecondsPerMeter == null
    ? null
    : finiteNumber(summary.averageActivePaceSecondsPerMeter)
  const measuredCadence = summary?.cadenceStepsPerSecond == null
    ? null
    : finiteNumber(summary.cadenceStepsPerSecond)
  if (summary?.averageActivePaceSecondsPerMeter != null && (measuredPace === null || measuredPace <= 0)) return null
  if (summary?.cadenceStepsPerSecond != null && (measuredCadence === null || measuredCadence <= 0)) return null

  const derivedSecondsPerKilometer = durationSeconds / (distanceMeters / 1000)
  const paceSecondsPerKilometer = measuredPace === null ? derivedSecondsPerKilometer : measuredPace * 1000
  if (
    !Number.isFinite(paceSecondsPerKilometer)
    || paceSecondsPerKilometer < MIN_SECONDS_PER_KILOMETER
    || paceSecondsPerKilometer > MAX_SECONDS_PER_KILOMETER
  ) return null

  const cadenceStepsPerMinute = measuredCadence === null ? null : measuredCadence * 60
  if (cadenceStepsPerMinute !== null && (cadenceStepsPerMinute < 60 || cadenceStepsPerMinute > 300)) return null

  const normalized = {
    startDate: new Date(startAt).toISOString(),
    endDate: new Date(endAt).toISOString(),
    durationSeconds: Math.round(durationSeconds),
    steps: Math.round(steps),
    distanceMeters: Math.round(distanceMeters),
    averagePaceSecondsPerKilometer: Math.round(paceSecondsPerKilometer),
    cadenceStepsPerMinute: cadenceStepsPerMinute === null ? null : Math.round(cadenceStepsPerMinute),
    source: 'core_motion_recovery',
    confidence: String(segment?.confidence || 'unknown').toLowerCase(),
    counting: false,
    route: null,
    routeStatus: 'missing',
    routeMessage: 'GPS had not started, so the route is unavailable.',
  }
  return { ...normalized, id: candidateFingerprint(normalized) }
}

export function classifyMissedRun(history) {
  const segments = Array.isArray(history?.activitySegments) ? history.activitySegments : []
  const summaries = Array.isArray(history?.pedometerSummaries) ? history.pedometerSummaries : []
  const candidates = segments
    .map((segment) => candidateFromSegment(segment, summaryForSegment(segment, summaries)))
    .filter(Boolean)
    .sort((left, right) => right.endDate.localeCompare(left.endDate))
  return candidates[0] || null
}

function readSuppressedIds(storage) {
  const target = storageOrNull(storage)
  if (!target) return []
  try {
    const parsed = JSON.parse(target.getItem(SUPPRESSED_CANDIDATES_KEY) || '[]')
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string').slice(-MAX_SUPPRESSED_CANDIDATES) : []
  } catch (error) {
    console.warn('[SmartStart] suppressed-candidate storage could not be read:', error?.message || error)
    return []
  }
}

export function isCandidateSuppressed(candidate, storage) {
  const id = candidateFingerprint(candidate)
  return Boolean(id) && readSuppressedIds(storage).includes(id)
}

export function suppressCandidate(candidate, storage) {
  const target = storageOrNull(storage)
  const id = candidateFingerprint(candidate)
  if (!target || !id) return false
  try {
    const ids = readSuppressedIds(target).filter((existing) => existing !== id)
    target.setItem(SUPPRESSED_CANDIDATES_KEY, JSON.stringify([...ids, id].slice(-MAX_SUPPRESSED_CANDIDATES)))
    return true
  } catch (error) {
    console.warn('[SmartStart] candidate suppression could not be saved:', error?.message || error)
    return false
  }
}

export function toManualLogRunPrefill(candidate) {
  const startAt = boundedDate(candidate?.startDate)
  const durationSeconds = finiteNumber(candidate?.durationSeconds)
  const distanceMeters = finiteNumber(candidate?.distanceMeters)
  if (startAt === null || durationSeconds === null || distanceMeters === null) return null
  const localStart = new Date(startAt)
  const localDate = [
    localStart.getFullYear(),
    String(localStart.getMonth() + 1).padStart(2, '0'),
    String(localStart.getDate()).padStart(2, '0'),
  ].join('-')
  return {
    date: localDate,
    distanceMeters: Math.round(distanceMeters),
    durationSeconds: Math.round(durationSeconds),
  }
}

function softFailureReason(error) {
  const code = String(error?.code || '').trim().toLowerCase()
  if (code) return code
  const message = String(error?.message || error || '').toLowerCase()
  if (/denied|not authorized/.test(message)) return 'denied'
  if (/restricted/.test(message)) return 'restricted'
  if (/empty history|no motion history/.test(message)) return 'empty_history'
  if (/malformed|invalid date|history interval/.test(message)) return 'malformed_dates'
  if (/unavailable|not implemented/.test(message)) return 'plugin_unavailable'
  return 'native_error'
}

export function createSmartStartMotionService({ capacitor = Capacitor, plugin = ForgeMotion, storage } = {}) {
  const localStorageTarget = storageOrNull(storage)
  const isPluginAvailable = () => Boolean(
    capacitor?.isNativePlatform?.()
    && capacitor?.getPlatform?.() === 'ios'
    && typeof capacitor?.isPluginAvailable === 'function'
    && capacitor.isPluginAvailable('ForgeMotion')
  )

  const getStatus = async () => {
    if (!isPluginAvailable()) {
      return { available: false, authorization: 'unavailable', reason: 'plugin_unavailable' }
    }
    try {
      const result = await plugin.getStatus()
      return {
        ...result,
        available: result?.available === true,
        authorization: normalizedAuthorization(result?.authorization),
      }
    } catch (error) {
      return { available: false, authorization: 'unavailable', reason: softFailureReason(error) }
    }
  }

  return {
    isPluginAvailable,

    isEnabled() {
      if (!localStorageTarget) return false
      try {
        return localStorageTarget.getItem(SMART_START_PREFERENCE_KEY) === 'true'
      } catch (error) {
        console.warn('[SmartStart] preference could not be read:', error?.message || error)
        return false
      }
    },

    setEnabled(enabled) {
      if (!localStorageTarget) return false
      try {
        localStorageTarget.setItem(SMART_START_PREFERENCE_KEY, enabled === true ? 'true' : 'false')
        return true
      } catch (error) {
        console.warn('[SmartStart] preference could not be saved:', error?.message || error)
        return false
      }
    },

    getStatus,

    async requestAuthorization() {
      if (!isPluginAvailable()) return { ok: false, authorization: 'unavailable', reason: 'plugin_unavailable' }
      try {
        const result = await plugin.requestAuthorization()
        const authorization = normalizedAuthorization(result?.authorization)
        return {
          ok: result?.available === true && authorization === 'authorized',
          ...result,
          authorization,
          reason: authorization === 'authorized' ? null : authorization,
        }
      } catch (error) {
        const reason = softFailureReason(error)
        return { ok: false, authorization: reason === 'restricted' ? 'restricted' : reason === 'denied' ? 'denied' : 'unavailable', reason }
      }
    },

    async openSettings() {
      if (!isPluginAvailable()) return false
      try {
        const result = await plugin.openSettings()
        return result?.opened === true
      } catch (error) {
        console.warn('[SmartStart] iPhone Settings could not be opened:', error?.message || error)
        return false
      }
    },

    async findRecentCandidate({ now = new Date(), recoveryWindowMs = RECOVERY_WINDOW_MS } = {}) {
      if (!isPluginAvailable()) return { ok: false, candidate: null, reason: 'plugin_unavailable' }
      const status = await getStatus()
      if (!status.available) return { ok: false, candidate: null, reason: status.reason || 'unavailable' }
      if (status.authorization !== 'authorized') {
        return { ok: false, candidate: null, reason: status.authorization }
      }

      const nowAt = now instanceof Date ? now.getTime() : Number.NaN
      const boundedWindowMs = Math.min(MAX_HISTORY_MS, Math.max(MIN_RUN_DURATION_SECONDS * 1000, finiteNumber(recoveryWindowMs) || RECOVERY_WINDOW_MS))
      if (!Number.isFinite(nowAt)) return { ok: false, candidate: null, reason: 'malformed_dates' }
      const endAt = nowAt - RECOVERY_END_BUFFER_MS
      const startAt = endAt - boundedWindowMs

      try {
        const history = await plugin.queryHistory({
          startDate: new Date(startAt).toISOString(),
          endDate: new Date(endAt).toISOString(),
        })
        const candidate = classifyMissedRun(history)
        if (!candidate) return { ok: false, candidate: null, reason: 'no_plausible_run' }
        if (isCandidateSuppressed(candidate, localStorageTarget)) {
          return { ok: false, candidate: null, reason: 'suppressed' }
        }
        return { ok: true, candidate }
      } catch (error) {
        return { ok: false, candidate: null, reason: softFailureReason(error) }
      }
    },

    suppressCandidate(candidate) {
      return suppressCandidate(candidate, localStorageTarget)
    },
  }
}

const SmartStartMotionService = createSmartStartMotionService()

export default SmartStartMotionService
