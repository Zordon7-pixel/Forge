function finiteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export const GROUP_RUN_NAVIGATION_SOURCE = 'group_run'
const PRIVATE_ACCESS_GRACE_MINUTES = 120

function normalizedGroupRunId(value) {
  if (value === null || value === undefined) return null
  const normalized = String(value).trim()
  return normalized && normalized.length <= 160 ? normalized : null
}

export function localDateTimeInput(hoursAhead = 24) {
  const date = new Date(Date.now() + hoursAhead * 60 * 60 * 1000)
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

export function groupRunDateISO(groupRun) {
  const date = new Date(groupRun?.starts_at || '')
  if (!Number.isFinite(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60 * 1000)
  return local.toISOString().slice(0, 10)
}

export function formatGroupRunDate(groupRun) {
  const date = new Date(groupRun?.starts_at || '')
  if (!Number.isFinite(date.getTime())) return 'Date unavailable'
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date)
}

export function groupRunCountdown(groupRun, now = Date.now()) {
  const startsAt = new Date(groupRun?.starts_at || '').getTime()
  if (!Number.isFinite(startsAt)) return ''
  const minutes = Math.round((startsAt - now) / 60000)
  if (minutes < -Number(groupRun?.duration_minutes || 60)) return 'Finished'
  if (minutes < 0) return 'In progress'
  if (minutes < 60) return `Starts in ${Math.max(1, minutes)} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `Starts in ${hours} hr${hours === 1 ? '' : 's'}`
  return formatGroupRunDate(groupRun)
}

export function workoutSummary(groupRun) {
  if (!groupRun) return 'Social run'
  const type = String(groupRun.run_type || 'social').replace(/_/g, ' ')
  const distance = finiteNumber(groupRun.distance_target_miles ?? groupRun.target_distance_miles)
  const duration = finiteNumber(groupRun.time_target_minutes ?? groupRun.target_duration_minutes)
  if (groupRun.goal_mode === 'distance' && distance > 0) {
    return `${distance.toFixed(1)} mi ${type}`
  }
  if (groupRun.goal_mode === 'time' && duration > 0) {
    return `${Math.round(duration)} min ${type}`
  }
  return `Open ${type}`
}

export function planRunSnapshot(run) {
  if (!run) return null
  const distance = finiteNumber(run.distance_miles ?? run.distanceMiles ?? run.prescription?.distance_miles)
  const duration = finiteNumber(run.duration_min ?? run.durationMinutes ?? run.prescription?.duration_min)
  const rawType = String(run.prescription?.workout_type || run.type || run.rawType || 'social').toLowerCase()
  return {
    run_type: ['easy', 'recovery', 'long', 'tempo', 'intervals', 'hills', 'social'].find((type) => rawType.includes(type)) || 'social',
    goal_mode: distance > 0 ? 'distance' : duration > 0 ? 'time' : 'open',
    target_distance_miles: distance > 0 ? Number(distance.toFixed(2)) : null,
    target_duration_minutes: duration > 0 ? Math.round(duration) : null,
    pace_note: String(run.pace_target || run.pace || run.prescription?.pace_target || run.prescription?.pace || '').slice(0, 80),
    target_zone: String(run.target_zone || run.prescription?.target_zone || '').slice(0, 20),
    workout_structure: Array.isArray(run.structure || run.prescription?.structure)
      ? (run.structure || run.prescription.structure).map((item) => typeof item === 'string' ? item : item?.detail || item?.label || '').filter(Boolean).join('\n').slice(0, 500)
      : String(run.structure || run.prescription?.structure || '').slice(0, 500),
  }
}

export function groupRunCompatibility(groupRun, execution) {
  const planned = planRunSnapshot(execution?.run)
  if (!planned) return { state: 'none', label: 'No scheduled run conflict detected' }
  const sameMode = planned.goal_mode === groupRun?.goal_mode
  const groupDistance = finiteNumber(groupRun?.distance_target_miles ?? groupRun?.target_distance_miles)
  const planDistance = finiteNumber(planned.target_distance_miles)
  const groupDuration = finiteNumber(groupRun?.time_target_minutes ?? groupRun?.target_duration_minutes)
  const planDuration = finiteNumber(planned.target_duration_minutes)
  const targetMatches = sameMode && (
    groupRun?.goal_mode === 'open'
    || (groupDistance > 0 && planDistance > 0 && Math.abs(groupDistance - planDistance) / planDistance <= 0.2)
    || (groupDuration > 0 && planDuration > 0 && Math.abs(groupDuration - planDuration) / planDuration <= 0.2)
  )
  return targetMatches
    ? { state: 'match', label: 'Matches your scheduled run' }
    : { state: 'different', label: 'Different from your scheduled run' }
}

export function groupRunIdFromNavigationState(state) {
  if (!isGroupRunNavigationState(state)) return null
  if (state.source === GROUP_RUN_NAVIGATION_SOURCE) {
    return normalizedGroupRunId(state.groupRunId)
  }

  const legacyScheduledRunId = String(state.scheduledRun?.id || '')
  const legacyGroupRunId = legacyScheduledRunId.slice('group-run-'.length)
  return legacyGroupRunId === 'scheduled' ? null : normalizedGroupRunId(legacyGroupRunId)
}

export function isGroupRunNavigationState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return false
  if (state.source === GROUP_RUN_NAVIGATION_SOURCE) return true
  if (state.source !== null && state.source !== undefined) return false
  return String(state.scheduledRun?.id || '').startsWith('group-run-')
}

export function groupRunNavigationProvenance(state) {
  const groupRunId = groupRunIdFromNavigationState(state)
  if (!groupRunId) return {}
  return {
    source: GROUP_RUN_NAVIGATION_SOURCE,
    groupRunId,
    planSessionId: null,
  }
}

export function canRestoreGroupRunNavigation(groupRun, expectedGroupRunId, now = Date.now()) {
  const groupRunId = normalizedGroupRunId(groupRun?.id)
  const expectedId = normalizedGroupRunId(expectedGroupRunId)
  if (!groupRunId || !expectedId || groupRunId !== expectedId) return false
  if (groupRun?.membership?.status !== 'going') return false
  if (!['scheduled', 'completed'].includes(String(groupRun?.status || ''))) return false

  const startsAt = new Date(groupRun?.starts_at || '').getTime()
  const durationMinutes = finiteNumber(groupRun?.duration_minutes)
  const currentTime = Number(now)
  if (!Number.isFinite(startsAt) || durationMinutes === null || durationMinutes < 0 || !Number.isFinite(currentTime)) return false
  const privateAccessExpiresAt = startsAt + (durationMinutes + PRIVATE_ACCESS_GRACE_MINUTES) * 60 * 1000
  return currentTime <= privateAccessExpiresAt
}

export function groupRunWarmupState(groupRun) {
  const route = groupRun?.route || null
  const distance = groupRun?.distance_target_miles ?? groupRun?.target_distance_miles ?? null
  const duration = groupRun?.time_target_minutes ?? groupRun?.target_duration_minutes ?? null
  const groupRunId = normalizedGroupRunId(groupRun?.id)
  return {
    source: GROUP_RUN_NAVIGATION_SOURCE,
    groupRunId,
    planSessionId: null,
    startAfterWarmup: true,
    runType: groupRun?.run_type || 'social',
    runEnvironment: 'outdoor',
    surface: route?.surface || 'road',
    mapMyRun: true,
    plannedRoute: route,
    scheduledRun: {
      id: `group-run-${groupRunId || 'scheduled'}`,
      title: groupRun?.title || 'Group run',
      type: groupRun?.run_type || 'social',
      distance_miles: distance,
      duration_min: duration,
      target_zone: groupRun?.target_zone || null,
      pace_target: groupRun?.pace_note || null,
      structure: groupRun?.workout_structure || null,
    },
    workoutTarget: {
      distanceMiles: distance,
      durationMinutes: duration,
      pace: groupRun?.pace_note || null,
      zone: groupRun?.target_zone || null,
      prescriptionBasis: 'Private group run',
    },
  }
}

export function upcomingGroupRun(groupRuns, now = Date.now()) {
  const cutoff = now + 24 * 60 * 60 * 1000
  return (groupRuns || [])
    .filter((run) => run.membership?.status === 'going' && run.status === 'scheduled')
    .filter((run) => {
      const startsAt = new Date(run.starts_at).getTime()
      return Number.isFinite(startsAt) && startsAt >= now && startsAt <= cutoff
    })
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))[0] || null
}
