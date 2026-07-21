const MIN_TRUSTED_ZONE_COVERAGE_PCT = 70
// hex required: consumed by `${color}XX` alpha templates — do not tokenize
const HEART_RATE_ZONE_META = Object.freeze([
  Object.freeze({ label: 'Recovery', color: '#5E6C7B' }),
  Object.freeze({ label: 'Easy', color: '#EAB308' }),
  Object.freeze({ label: 'Aerobic', color: '#F97316' }),
  Object.freeze({ label: 'Threshold', color: '#E5484D' }),
  Object.freeze({ label: 'Maximum', color: '#FFF6DC', textColor: '#B8A86A' }),
])

function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function parseJson(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function parsePaceSeconds(value) {
  const numeric = finiteNumber(value)
  if (numeric !== null && numeric > 0) return numeric
  const text = String(value || '').trim()
  const match = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\s*\/\s*mi)?$/i)
    || text.match(/^(\d{1,2}):(\d{2})(?:\s*\/\s*mi)?$/i)
  if (!match) return null
  if (match.length === 4) {
    return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3])
  }
  return Number(match[1]) * 60 + Number(match[2])
}

function parsePaceTargetRange(value) {
  const text = String(value || '').trim().replace(/\s*\/\s*mi.*$/i, '')
  if (!text) return null
  const pieces = text.split(/\s*(?:-|\u2013|to)\s*/i).filter(Boolean)
  if (pieces.length < 1 || pieces.length > 2) return null
  const seconds = pieces.map(parsePaceSeconds)
  if (seconds.some((item) => !(item > 0))) return null
  return { min: Math.min(...seconds), max: Math.max(...seconds) }
}

function closenessScore(actual, target) {
  if (!(actual > 0) || !(target > 0)) return null
  return Math.max(0, Math.min(100, 100 - (Math.abs(actual - target) / target) * 200))
}

function buildAdherenceSummary({
  actualDistanceMiles,
  actualDurationSeconds,
  actualPaceSeconds,
  plannedDistanceMiles,
  plannedDurationSeconds,
  plannedPaceTarget,
  plannedZoneTarget,
  zoneAdherencePct,
}) {
  const components = []
  if (plannedDistanceMiles > 0 && actualDistanceMiles > 0) {
    components.push({ key: 'distance', score: closenessScore(actualDistanceMiles, plannedDistanceMiles) })
  } else if (plannedDurationSeconds > 0 && actualDurationSeconds > 0) {
    components.push({ key: 'duration', score: closenessScore(actualDurationSeconds, plannedDurationSeconds) })
  }

  const paceRange = parsePaceTargetRange(plannedPaceTarget)
  if (paceRange && actualPaceSeconds > 0) {
    const nearestTarget = actualPaceSeconds < paceRange.min
      ? paceRange.min
      : actualPaceSeconds > paceRange.max
        ? paceRange.max
        : actualPaceSeconds
    components.push({ key: 'pace', score: closenessScore(actualPaceSeconds, nearestTarget) })
  }
  if (Number.isFinite(zoneAdherencePct)) {
    components.push({ key: 'zone', score: Math.max(0, Math.min(100, zoneAdherencePct)) })
  }

  if (!components.length) return { adherenceScore: null, adherenceLabel: null, adherenceCue: null, adherenceComponents: [] }
  const adherenceScore = Math.round(components.reduce((sum, component) => sum + component.score, 0) / components.length)
  const adherenceLabel = adherenceScore >= 85 ? 'On plan' : adherenceScore >= 65 ? 'Mostly on plan' : 'Different from plan'
  const weakest = components.reduce((lowest, component) => component.score < lowest.score ? component : lowest)
  let adherenceCue = 'Workout matched the available prescription targets.'
  if (adherenceScore < 85 && weakest.key === 'distance') adherenceCue = 'Bring the completed distance closer to the scheduled distance next time.'
  if (adherenceScore < 85 && weakest.key === 'duration') adherenceCue = 'Bring the completed time closer to the scheduled duration next time.'
  if (adherenceScore < 85 && weakest.key === 'pace') adherenceCue = `Hold the prescribed pace${plannedPaceTarget ? ` (${plannedPaceTarget})` : ''} more consistently.`
  if (adherenceScore < 85 && weakest.key === 'zone') adherenceCue = `Spend more of the workout in ${plannedZoneTarget || 'the prescribed heart-rate zone'}.`
  return { adherenceScore, adherenceLabel, adherenceCue, adherenceComponents: components }
}

export function parsePlannedRun(value) {
  const parsed = parseJson(value, null)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const meaningful = [
    parsed.sessionId,
    parsed.title,
    parsed.type,
    parsed.workoutType,
    parsed.distanceMiles,
    parsed.durationMinutes,
    parsed.paceTarget,
    parsed.targetZone,
  ].some((item) => item !== undefined && item !== null && item !== '')
  return meaningful ? parsed : null
}

export function parseZoneTimeline(value, durationSeconds = 0) {
  const parsed = parseJson(value, {})
  const seconds = ['z1', 'z2', 'z3', 'z4', 'z5'].map((key) => {
    const amount = finiteNumber(parsed?.[key] ?? parsed?.[key.toUpperCase()])
    return Math.max(0, amount || 0)
  })
  const totalSeconds = seconds.reduce((sum, amount) => sum + amount, 0)
  const duration = Math.max(0, finiteNumber(durationSeconds) || 0)
  const coveragePct = duration > 0 && totalSeconds > 0
    ? Math.min(100, (totalSeconds / duration) * 100)
    : null
  const dominantIndex = totalSeconds > 0
    ? seconds.indexOf(Math.max(...seconds))
    : -1
  return {
    seconds,
    totalSeconds,
    coveragePct,
    trusted: Number.isFinite(coveragePct) && coveragePct >= MIN_TRUSTED_ZONE_COVERAGE_PCT,
    dominantZone: dominantIndex >= 0 ? dominantIndex + 1 : null,
  }
}

export function resolveRunHeartRateZone(run = {}, zones = []) {
  const timeline = parseZoneTimeline(run.heart_rate_zones, run.duration_seconds)
  const workoutMetrics = parseJson(run.workout_metrics_json, {})
  const metricCoverage = finiteNumber(workoutMetrics?.hr_sample_coverage_pct)
  const coveragePct = metricCoverage ?? timeline.coveragePct

  if (coveragePct !== null && coveragePct >= MIN_TRUSTED_ZONE_COVERAGE_PCT && timeline.dominantZone) {
    const meta = HEART_RATE_ZONE_META[timeline.dominantZone - 1]
    const dominantSeconds = timeline.seconds[timeline.dominantZone - 1]
    return {
      zone: timeline.dominantZone,
      label: meta.label,
      color: meta.color,
      textColor: meta.textColor || meta.color,
      source: 'timeline',
      coveragePct,
      dominantPct: timeline.totalSeconds > 0 ? (dominantSeconds / timeline.totalSeconds) * 100 : null,
    }
  }

  const averageHeartRate = finiteNumber(run.avg_hr ?? run.avg_heart_rate)
  if (averageHeartRate === null || !Array.isArray(zones) || zones.length !== 5) return null
  const minimums = zones.map((entry) => finiteNumber(entry?.minBpm ?? entry?.min_bpm))
  if (minimums.some((minimum) => minimum === null)) return null

  let index = minimums.findIndex((minimum, zoneIndex) => (
    averageHeartRate >= minimum
    && (zoneIndex === minimums.length - 1 || averageHeartRate < minimums[zoneIndex + 1])
  ))
  if (index < 0 && averageHeartRate < minimums[0]) index = 0
  if (index < 0) return null

  const meta = HEART_RATE_ZONE_META[index]
  return {
    zone: index + 1,
    label: meta.label,
    color: meta.color,
    textColor: meta.textColor || meta.color,
    source: 'average',
    averageHeartRate,
    coveragePct,
  }
}

export function targetZoneNumber(value) {
  return targetZoneNumbers(value)[0] || null
}

export function targetZoneNumbers(value) {
  const text = String(value || '')
  const range = text.match(/(?:zone|z)\s*([1-5])\s*(?:-|\u2013|to)\s*(?:zone|z)?\s*([1-5])/i)
  if (range) {
    const start = Number(range[1])
    const end = Number(range[2])
    const lower = Math.min(start, end)
    const upper = Math.max(start, end)
    return Array.from({ length: upper - lower + 1 }, (_, index) => lower + index)
  }
  const single = text.match(/(?:zone|z)\s*([1-5])/i)
  return single ? [Number(single[1])] : []
}

export function formatPlannedPaceTarget(value, units = 'imperial') {
  const text = String(value || '').trim()
  if (!text || units !== 'metric') return text || null
  const match = text.match(/^(\d{1,2}):(\d{2})(?:\s*-\s*(\d{1,2}):(\d{2}))?\s*\/\s*mi$/i)
  if (!match) return text
  const formatPerKm = (minutes, seconds) => {
    const totalSeconds = (Number(minutes) * 60 + Number(seconds)) / 1.60934
    const rounded = Math.round(totalSeconds)
    return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`
  }
  const start = formatPerKm(match[1], match[2])
  const end = match[3] ? formatPerKm(match[3], match[4]) : null
  return `${start}${end ? `-${end}` : ''}/km`
}

export function buildRunComparison(run = {}) {
  const planned = parsePlannedRun(run.planned_session_json ?? run.plannedSession)
  const actualDistanceMiles = Math.max(0, finiteNumber(run.distance_miles) || 0)
  const actualDurationSeconds = Math.max(0, finiteNumber(run.duration_seconds) || 0)
  const actualPaceSeconds = actualDistanceMiles > 0 && actualDurationSeconds > 0
    ? actualDurationSeconds / actualDistanceMiles
    : null
  const timeline = parseZoneTimeline(run.heart_rate_zones, actualDurationSeconds)

  if (!planned) {
    return {
      hasPlan: false,
      planned: null,
      actualDistanceMiles,
      actualDurationSeconds,
      actualPaceSeconds,
      timeline,
      targetZone: null,
      zoneAdherencePct: null,
    }
  }

  const targetZones = targetZoneNumbers(planned.targetZone)
  const targetZone = targetZones[0] || null
  const zoneAdherencePct = targetZones.length > 0 && timeline.trusted && timeline.totalSeconds > 0
    ? (targetZones.reduce((sum, zone) => sum + timeline.seconds[zone - 1], 0) / timeline.totalSeconds) * 100
    : null

  const plannedDistanceMiles = finiteNumber(planned.distanceMiles)
  const plannedDurationSeconds = finiteNumber(planned.durationMinutes) !== null
    ? finiteNumber(planned.durationMinutes) * 60
    : null
  const plannedPaceTarget = String(planned.paceTarget || '').trim() || null
  const plannedZoneTarget = String(planned.targetZone || '').trim() || null
  const adherence = buildAdherenceSummary({
    actualDistanceMiles,
    actualDurationSeconds,
    actualPaceSeconds,
    plannedDistanceMiles,
    plannedDurationSeconds,
    plannedPaceTarget,
    plannedZoneTarget,
    zoneAdherencePct,
  })

  return {
    hasPlan: true,
    planned,
    actualDistanceMiles,
    actualDurationSeconds,
    actualPaceSeconds,
    plannedDistanceMiles,
    plannedDurationSeconds,
    plannedPaceTarget,
    plannedZoneTarget,
    targetZone,
    targetZones,
    zoneAdherencePct,
    timeline,
    ...adherence,
  }
}

export function normalizeRunSplits(value) {
  const parsed = parseJson(value, [])
  if (!Array.isArray(parsed)) return []

  return parsed.slice(0, 50).map((raw, index) => {
    if (typeof raw === 'number') {
      return raw > 0 && raw <= 50
        ? { index: index + 1, label: `Lap ${index + 1}`, distanceMiles: raw, durationSeconds: null, paceSeconds: null }
        : null
    }
    if (typeof raw === 'string') {
      const paceSeconds = parsePaceSeconds(raw)
      return paceSeconds
        ? { index: index + 1, label: `Split ${index + 1}`, distanceMiles: null, durationSeconds: null, paceSeconds }
        : null
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

    const distanceMiles = finiteNumber(raw.distance_miles ?? raw.distanceMiles ?? raw.distance)
    const durationSeconds = finiteNumber(raw.duration_seconds ?? raw.durationSeconds ?? raw.elapsed_seconds ?? raw.elapsedSeconds ?? raw.time_seconds)
    let paceSeconds = parsePaceSeconds(raw.pace_seconds ?? raw.paceSeconds ?? raw.avg_pace ?? raw.pace)
    if (!paceSeconds && distanceMiles > 0 && durationSeconds > 0) {
      paceSeconds = durationSeconds / distanceMiles
    }
    if (!(distanceMiles > 0) && !(durationSeconds > 0) && !(paceSeconds > 0)) return null

    return {
      index: index + 1,
      label: String(raw.label || raw.name || raw.mile || raw.lap || `Split ${index + 1}`).slice(0, 40),
      distanceMiles: distanceMiles > 0 ? distanceMiles : null,
      durationSeconds: durationSeconds > 0 ? durationSeconds : null,
      paceSeconds: paceSeconds > 0 ? paceSeconds : null,
    }
  }).filter(Boolean)
}

export function parseRunRoute(value) {
  const parsed = parseJson(value, [])
  if (!Array.isArray(parsed)) return []
  return parsed.slice(0, 5000).map((point) => {
    const lat = finiteNumber(Array.isArray(point) ? point[0] : point?.lat)
    const lon = finiteNumber(Array.isArray(point) ? point[1] : point?.lon ?? point?.lng)
    if (lat === null || lon === null || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
    return [lat, lon]
  }).filter(Boolean)
}

export { MIN_TRUSTED_ZONE_COVERAGE_PCT }
