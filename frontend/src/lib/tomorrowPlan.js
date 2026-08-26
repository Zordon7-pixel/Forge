function hasScalarValue(value) {
  return (typeof value === 'string' && value.length > 0)
    || (typeof value === 'number' && Number.isFinite(value))
}

function firstScalar(...values) {
  return values.find(hasScalarValue) ?? null
}

function localDateFromISO(dateISO) {
  const match = String(dateISO || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12)
  return Number.isNaN(date.getTime()) ? null : date
}

function localDateISO(date) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function localTomorrowDateISO(now = new Date()) {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12)
  return localDateISO(tomorrow)
}

export function shouldPromoteTomorrow(now = new Date()) {
  return now.getHours() >= 18
}

export function millisecondsUntilTomorrowTransition(now = new Date()) {
  const target = shouldPromoteTomorrow(now)
    ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0)
    : new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0, 0)
  return Math.max(0, target.getTime() - now.getTime())
}

function sessionKind(session) {
  const explicit = String(session?.kind || '').trim().toLowerCase()
  if (['run', 'lift', 'hybrid', 'hyrox', 'rest'].includes(explicit)) {
    return explicit === 'hyrox' ? 'hybrid' : explicit
  }
  const family = String(session?.workout_family || session?.workoutFamily || '').trim().toLowerCase()
  if (family === 'rest' || family === 'mobility' || family === 'manual_recovery') return 'rest'
  if (family.startsWith('strength_')) return 'lift'
  if (family.startsWith('hyrox_')) return 'hybrid'
  if (family) return 'run'
  const type = String(session?.type || session?.workout_type || '').trim().toLowerCase()
  if (/(strength|lift)/.test(type)) return 'lift'
  if (/(hyrox|hybrid)/.test(type)) return 'hybrid'
  if (type === 'rest') return 'rest'
  return type ? 'run' : null
}

function metricFrom(session, key, candidates) {
  for (const [field, unit] of candidates) {
    const value = field.includes('.')
      ? field.split('.').reduce((current, part) => current?.[part], session)
      : session?.[field]
    if (hasScalarValue(value)) return { key, value, unit }
  }
  return null
}

function sessionMetrics(session) {
  return [
    metricFrom(session, 'duration', [
      ['duration_min', 'min'], ['duration_minutes', 'min'], ['durationMinutes', 'min'],
      ['duration_seconds', 'sec'], ['durationSeconds', 'sec'], ['derived_totals.duration_s', 'sec'],
    ]),
    metricFrom(session, 'distance', [
      ['distance_miles', 'mi'], ['distanceMiles', 'mi'], ['distance_km', 'km'],
      ['distance_m', 'm'], ['distance_meters', 'm'], ['derived_totals.distance_m', 'm'],
    ]),
    metricFrom(session, 'load', [
      ['load_summary', null], ['loadSummary', null], ['prescribed_load', null],
      ['prescribedLoad', null], ['target_load', null], ['targetLoad', null], ['load', null],
    ]),
  ].filter(Boolean)
}

function unavailablePlan(dateISO) {
  return {
    status: 'unavailable',
    identity: null,
    dateISO,
    dateLabel: formatTomorrowDate(dateISO),
    title: 'Plan unavailable',
    sessions: [],
    phase: null,
    reason: null,
  }
}

function formatTomorrowDate(dateISO) {
  const date = localDateFromISO(dateISO)
  if (!date) return String(dateISO || '')
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
}

export function buildTomorrowPlan(execution, expectedDateISO = localTomorrowDateISO()) {
  const dateISO = String(expectedDateISO || '')
  if (!execution || execution.hasPlan !== true || execution.hasDay !== true
    || execution.surface?.status === 'blocked'
    || execution.restSource === 'removed'
    || String(execution.date || '') !== dateISO) {
    return unavailablePlan(dateISO)
  }

  const rawSessions = Array.isArray(execution.sessions) ? execution.sessions : []
  const plannedRest = execution.isRest === true
    || execution.isPlannedRest === true
    || execution.restSource === 'planned'
    || rawSessions.some((session) => sessionKind(session) === 'rest')
  if (plannedRest) {
    return {
      status: 'rest',
      identity: 'rest',
      dateISO,
      dateLabel: formatTomorrowDate(dateISO),
      title: 'Rest day',
      sessions: [],
      phase: firstScalar(execution.phase),
      reason: firstScalar(execution.purpose, execution.day?.whyToday, execution.day?.why_today, execution.day?.explanation),
    }
  }

  const sessions = rawSessions
    .filter((session) => session && sessionKind(session) !== 'rest')
    .map((session) => ({
      id: firstScalar(session.session_id, session.id),
      kind: sessionKind(session),
      title: firstScalar(session.title, session.name, session.workout_name, session.workoutName),
      metrics: sessionMetrics(session),
      source: session,
    }))
  if (!sessions.length) return unavailablePlan(dateISO)

  const kinds = new Set(sessions.map((session) => session.kind).filter(Boolean))
  const identity = kinds.has('hybrid') || kinds.size > 1
    ? 'hybrid'
    : kinds.has('lift') ? 'lift' : kinds.has('run') ? 'run' : null
  return {
    status: 'training',
    identity,
    dateISO,
    dateLabel: formatTomorrowDate(dateISO),
    title: null,
    sessions,
    phase: firstScalar(execution.phase),
    reason: firstScalar(
      execution.purpose,
      execution.day?.whyToday,
      execution.day?.why_today,
      execution.day?.explanation,
      ...rawSessions.flatMap((session) => [session?.purpose, session?.reason, session?.description]),
    ),
  }
}
