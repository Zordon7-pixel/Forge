export function resolveTodayPlanAccess({
  checkedInToday = false,
  recommendation = null,
  calendarSessions = [],
  isRestDay = false,
  onCheckIn,
  onStartWorkout,
  onDetails,
} = {}) {
  const sessionCount = Array.isArray(calendarSessions) ? calendarSessions.length : 0
  const hasRecommendation = Boolean(recommendation)
  const hasViewablePlan = hasRecommendation || sessionCount > 0 || isRestDay

  if (!hasViewablePlan) {
    return {
      hasViewablePlan: false,
      primaryAction: onCheckIn,
      primaryLabel: checkedInToday ? 'Edit check-in' : 'Check in',
      secondaryAction: null,
      secondaryLabel: null,
      trainAction: onCheckIn,
      uncheckedSignal: "Check in to build today's recommendation.",
      readinessFallback: checkedInToday
        ? 'No recommendation is available yet. Review your check-in or open the calendar.'
        : "Check in to build today's recommendation. Sync a watch to add readiness context.",
      showStartLog: false,
    }
  }

  return {
    hasViewablePlan: true,
    primaryAction: checkedInToday
      ? onStartWorkout
      : onDetails,
    primaryLabel: checkedInToday
      ? isRestDay ? 'View week' : 'Start'
      : 'View plan',
    secondaryAction: checkedInToday
      ? onDetails
      : onCheckIn,
    secondaryLabel: checkedInToday
      ? 'Details'
      : 'Check in',
    trainAction: checkedInToday
      ? onStartWorkout
      : onDetails,
    uncheckedSignal: "You can review the full schedule now. Complete a check-in if you want today's effort adjusted before training.",
    readinessFallback: 'Check in and sync a watch to add a readiness explanation. Your scheduled plan remains visible.',
    showStartLog: isRestDay || (hasRecommendation && sessionCount === 0),
  }
}

export function resolveTodayWorkoutLabel({ calendarKinds = [], recommendationLabel = null } = {}) {
  if (calendarKinds.length > 1) return 'Run + lift'
  if (calendarKinds[0] === 'lift') return 'Strength'
  if (calendarKinds[0] === 'run') return 'Run'
  return recommendationLabel
}
