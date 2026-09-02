export function activityTypeText(activity = {}) {
  return [activity.type, activity.run_type, activity.workout_type, activity.activity_kind, activity.watch_activity_type, activity.watch_normalized_type]
    .filter((value) => value !== null && value !== undefined)
    .map((value) => String(value).trim().toLowerCase().replace(/[_-]+/g, ' '))
    .join(' ')
}

const ACTIVITY_KIND_MATCHERS = [
  ['walk', /\bwalk(?:ing)?\b/],
  ['cycling', /\b(?:cycl(?:e|ing)|bike|biking)\b/],
  ['swimming', /\bswim(?:ming)?\b/],
  ['hiking', /\bhik(?:e|ing)\b/],
  ['rowing', /\brow(?:ing)?\b/],
  ['elliptical', /\belliptical\b/],
  ['stairs', /\b(?:stair|stepper)\b/],
  ['yoga', /\b(?:yoga|pilates)\b/],
  ['hiit', /\bhiit\b|high intensity interval/],
  ['strength', /\b(?:strength|weightlifting|resistance)\b/],
  ['workout', /\b(?:workout|other)\b/],
]

export function activityKind(activity = {}) {
  const text = activityTypeText(activity)
  return ACTIVITY_KIND_MATCHERS.find(([, regex]) => regex.test(text))?.[0] || 'run'
}

export function isWalkActivity(activity = {}) {
  return activityKind(activity) === 'walk'
}

export function isRunningActivity(activity = {}) {
  return activityKind(activity) === 'run'
}

export function runningActivities(activities = []) {
  return (Array.isArray(activities) ? activities : []).filter(isRunningActivity)
}

export function latestRunningActivity(activities = []) {
  return runningActivities(activities)[0] || null
}

export function activityLabel(activity = {}) {
  const kind = activityKind(activity)
  return {
    run: 'Run',
    walk: 'Walk',
    cycling: 'Cycling',
    swimming: 'Swimming',
    hiking: 'Hike',
    rowing: 'Rowing',
    elliptical: 'Elliptical',
    stairs: 'Stairs',
    yoga: 'Yoga',
    hiit: 'HIIT',
    strength: 'Strength',
    workout: 'Workout',
  }[kind] || 'Activity'
}
