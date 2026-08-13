function activityTimestamp(item) {
  const value = item?.ended_at || item?.date || item?.started_at || item?.synced_at || item?.created_at
  if (!value) return 0
  const raw = String(value)
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T12:00:00` : raw)
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime()
}

export function combineRecentActivity({ runs = [], lifts = [], workouts = [], otherActivities = [], limit = 4 } = {}) {
  const safeRuns = Array.isArray(runs) ? runs : []
  const safeLifts = Array.isArray(lifts) ? lifts : []
  const safeWorkouts = Array.isArray(workouts) ? workouts : []
  const safeOtherActivities = Array.isArray(otherActivities) ? otherActivities : []
  const items = [
    ...safeRuns.slice(0, 3).map((item) => ({ ...item, _type: 'run' })),
    ...safeLifts.slice(0, 3).map((item) => ({ ...item, _type: 'lift' })),
    ...safeWorkouts.filter((item) => item?.ended_at).slice(0, 3).map((item) => ({ ...item, _type: 'workout' })),
    ...safeOtherActivities.slice(0, 3).map((item) => ({ ...item, _type: 'other' })),
  ]

  return items
    .sort((a, b) => activityTimestamp(b) - activityTimestamp(a))
    .slice(0, Math.max(0, Number(limit) || 0))
}

export function workoutActivityTitle(item) {
  const groups = Array.isArray(item?.muscle_groups) ? item.muscle_groups.filter(Boolean) : []
  return groups.length ? groups.join(', ') : 'Strength workout'
}
