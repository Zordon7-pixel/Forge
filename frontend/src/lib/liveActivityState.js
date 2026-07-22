const KM_PER_MILE = 1.60934
const HEART_RATE_FRESH_MS = 30_000

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function compactText(value, maximumLength) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maximumLength)
}

export function liveActivityTargetLabel(workoutTarget = {}) {
  const pace = compactText(workoutTarget?.pace, 18)
  const zone = compactText(workoutTarget?.zone, 18)
  return compactText([pace, zone].filter(Boolean).join(' · '), 24)
}

export function buildLiveActivityStart({ clientRunId, startedAt, units, runType, workoutTarget } = {}) {
  const normalizedUnit = units === 'metric' ? 'km' : 'mi'
  const normalizedRunType = compactText(runType, 24)
  const title = normalizedRunType && normalizedRunType !== 'run'
    ? `${normalizedRunType[0].toUpperCase()}${normalizedRunType.slice(1)} run`
    : 'Active run'

  return {
    runClientId: compactText(clientRunId, 64),
    startedAtEpochMs: Math.max(0, Math.round(finiteNumber(startedAt))),
    unit: normalizedUnit,
    title: compactText(title, 40),
    targetLabel: liveActivityTargetLabel(workoutTarget),
  }
}

export function buildLiveActivityUpdate({
  startedAt,
  elapsed,
  distanceMiles,
  units,
  liveHr,
  hrLastUpdated,
  hrZone,
  mapMyRun,
  gpsStarted,
  gpsAvailable,
  currentAccuracy,
  now = Date.now(),
} = {}) {
  const normalizedUnit = units === 'metric' ? 'km' : 'mi'
  const measuredMiles = Math.max(0, finiteNumber(distanceMiles))
  const measuredDistance = normalizedUnit === 'km' ? measuredMiles * KM_PER_MILE : measuredMiles
  const elapsedSeconds = Math.max(0, Math.round(finiteNumber(elapsed)))
  const paceSecPerUnit = measuredDistance > 0 && elapsedSeconds > 0
    ? Math.round(elapsedSeconds / measuredDistance)
    : 0
  const heartRate = Math.round(finiteNumber(liveHr))
  const heartRateUpdatedAt = finiteNumber(hrLastUpdated)
  const hrFresh = heartRate >= 30
    && heartRate <= 250
    && heartRateUpdatedAt > 0
    && now - heartRateUpdatedAt <= HEART_RATE_FRESH_MS
  const accuracy = finiteNumber(currentAccuracy, -1)
  const gpsState = !mapMyRun
    ? 'off'
    : gpsStarted && gpsAvailable ? 'tracking' : 'acquiring'

  return {
    timerStartDateEpochMs: Math.max(0, Math.round(finiteNumber(startedAt, now - (elapsedSeconds * 1000)))),
    distance: mapMyRun ? Number(measuredDistance.toFixed(3)) : -1,
    paceSecPerUnit,
    heartRate: hrFresh ? heartRate : 0,
    hrFresh,
    hrZoneKey: hrFresh ? compactText(hrZone?.key, 4) : '',
    hrZoneColorHex: hrFresh ? compactText(hrZone?.color, 7) : '',
    gpsState,
    gpsAccuracyMeters: accuracy >= 0 && accuracy <= 10_000 ? Math.round(accuracy) : -1,
    staleAtEpochMs: Math.round(now + 90_000),
  }
}
