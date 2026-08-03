export function resolveTodayPlanAccess({
  checkedInToday = false,
  recommendation = null,
  calendarSessions = [],
  isRestDay = false,
  hasRunRecordedToday = false,
  onCheckIn,
  onStartWorkout,
  onStartUnplannedRun,
  onDetails,
} = {}) {
  const sessions = Array.isArray(calendarSessions) ? calendarSessions : []
  const sessionCount = sessions.length
  const pendingSessionCount = sessions.filter((session) => session?.completed !== true).length
  const allScheduledComplete = sessionCount > 0 && pendingSessionCount === 0
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

  if (isRestDay) {
    return {
      hasViewablePlan: true,
      primaryAction: onDetails || onStartWorkout,
      primaryLabel: 'View rest day',
      secondaryAction: hasRunRecordedToday ? null : onStartUnplannedRun,
      secondaryLabel: hasRunRecordedToday ? null : 'Start extra run',
      trainAction: onDetails || onStartWorkout,
      uncheckedSignal: 'Rest is scheduled today. Check in only if you want recovery guidance adjusted.',
      readinessFallback: 'Rest is scheduled today. A check-in can add recovery context without hiding the calendar.',
      showStartLog: false,
    }
  }

  if (allScheduledComplete) {
    return {
      hasViewablePlan: true,
      primaryAction: onDetails,
      primaryLabel: 'Review completed workout',
      secondaryAction: null,
      secondaryLabel: null,
      trainAction: onDetails,
      uncheckedSignal: "Today's scheduled workout is complete.",
      readinessFallback: "Today's scheduled workout is complete.",
      showStartLog: false,
    }
  }

  return {
    hasViewablePlan: true,
    primaryAction: checkedInToday
      ? onStartWorkout
      : onDetails,
    primaryLabel: checkedInToday ? 'Start workout' : 'View workout',
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
