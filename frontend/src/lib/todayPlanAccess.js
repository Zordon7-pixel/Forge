export const WORKOUT_START_ACCESS_SCHEMA = 'goal_backward_workout_start_access_v1'

const RUNNING_FAMILIES = new Set([
  'recovery_run', 'easy_run', 'long_aerobic', 'steady_run', 'threshold_run',
  'interval_run', 'race_rhythm_run', 'race', 'assessment',
])
const HIGH_INTENSITY_FAMILIES = new Set([
  'threshold_run', 'interval_run', 'race_rhythm_run', 'race',
  'hyrox_compromised', 'hyrox_partial_simulation', 'hyrox_full_simulation',
])

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function sessionId(session) {
  const value = session?.session_id ?? session?.id
  return value === null || value === undefined ? '' : String(value)
}

function normalizedAction(manifest) {
  const safety = objectValue(manifest?.safety) || {}
  const action = String(safety.action || 'FULL_REST').toUpperCase()
  if (action !== 'PROFESSIONAL_ASSESSMENT_RECOMMENDED') return action
  const scoped = String(safety.enforcement_action || safety.scoped_action || '').toUpperCase()
  return scoped && scoped !== 'PROFESSIONAL_ASSESSMENT_RECOMMENDED' ? scoped : 'FULL_REST'
}

function activityFamily(session, activity) {
  return String(session?.workout_family || activity?.workoutFamily || activity?.workout_family || '').toLowerCase()
}

function activityKind(session, activity) {
  const explicit = String(activity?.kind || session?.kind || '').toLowerCase()
  if (explicit) return explicit
  const family = activityFamily(session, activity)
  if (family.startsWith('strength_')) return 'lift'
  if (family.startsWith('hyrox_')) return 'hybrid'
  if (RUNNING_FAMILIES.has(family)) return 'run'
  return ''
}

function safetyScopes(session, activity) {
  if (session) {
    return new Set((Array.isArray(session.safety_scope) ? session.safety_scope : [])
      .map((value) => String(value || '').toUpperCase()).filter(Boolean))
  }
  return new Set([
    ...(Array.isArray(activity?.safetyScope) ? activity.safetyScope : []),
    ...(Array.isArray(activity?.safety_scope) ? activity.safety_scope : []),
  ].map((value) => String(value || '').toUpperCase()).filter(Boolean))
}

function targetRpes(value, found = []) {
  if (Array.isArray(value)) {
    value.forEach((entry) => targetRpes(entry, found))
    return found
  }
  if (!objectValue(value)) return found
  for (const [key, entry] of Object.entries(value)) {
    if (String(key).toLowerCase() === 'rpe' && Number.isFinite(Number(entry))) found.push(Number(entry))
    else targetRpes(entry, found)
  }
  return found
}

function highIntensity(session, activity) {
  const explicit = Number(session
    ? session.intensity_level
    : activity?.intensity ?? activity?.intensityLevel)
  if (Number.isFinite(explicit)) return explicit >= 3
  const rpes = targetRpes(session?.steps || activity?.steps || [])
  if (rpes.length) return Math.max(...rpes) >= 3
  const family = activityFamily(session, activity)
  if (HIGH_INTENSITY_FAMILIES.has(family)) return true
  if (['recovery_run', 'easy_run', 'mobility', 'manual_recovery', 'strength_upper'].includes(family)) return false
  const label = String(session?.intensity || activity?.intensityLabel || '').toLowerCase()
  if (/(hard|high|threshold|interval|race|tempo)/.test(label)) return true
  if (/(easy|recovery|technique|low)/.test(label)) return false
  return null
}

function affectsRunning(session, activity) {
  const scopes = safetyScopes(session, activity)
  const family = activityFamily(session, activity)
  const kind = activityKind(session, activity)
  return kind === 'run' || RUNNING_FAMILIES.has(family) || scopes.has('RUN') || scopes.has('IMPACT')
}

function affectsLowerBody(session, activity) {
  const scopes = safetyScopes(session, activity)
  const family = activityFamily(session, activity)
  const kind = activityKind(session, activity)
  if (scopes.has('LOWER_BODY') || scopes.has('RUN') || scopes.has('IMPACT')) return true
  if (kind === 'run') return true
  if (['strength_lower', 'strength_full_body'].includes(family)) return true
  if (family.startsWith('hyrox_')) return true
  if (family === 'strength_upper') return false
  if (kind === 'lift') return null
  return false
}

function explicitlyValidatedModification(session, activity) {
  if (session?.explicitly_validated_modified_session === true
    || (!session && activity?.explicitlyValidatedModifiedSession === true)) return true
  const reasons = Array.isArray(session?.purpose_reason_codes) ? session.purpose_reason_codes : []
  return reasons.some((reason) => [
    'EXPLICITLY_VALIDATED_MODIFIED_SESSION',
    'MODIFIED_SESSION_VALIDATED',
  ].includes(String(reason || '').toUpperCase()))
}

function safetyBlockReason(manifest, session, activity) {
  const action = normalizedAction(manifest)
  if (action === 'FULL_REST') return 'FULL_REST'
  if (action === 'NO_RUNNING' && affectsRunning(session, activity)) return 'NO_RUNNING'
  if (action === 'NO_LOWER_BODY' && affectsLowerBody(session, activity) !== false) return 'NO_LOWER_BODY'
  if (action === 'NO_HIGH_INTENSITY' && highIntensity(session, activity) !== false) return 'NO_HIGH_INTENSITY'
  if (action === 'MODIFY_IMPACT'
    && safetyScopes(session, activity).has('IMPACT')
    && session?.impact_modified !== true) return 'MODIFY_IMPACT'
  if (action === 'MODIFIED_SESSION_ONLY' && !explicitlyValidatedModification(session, activity)) return 'MODIFIED_SESSION_ONLY'
  return null
}

export function canonicalWorkoutStartAccess(manifest, session = null) {
  const identity = objectValue(manifest?.identity)
  if (!identity || manifest?.schema_version !== 'goal_backward_surface_manifest_v1'
    || manifest?.status !== 'accepted' || !objectValue(manifest?.safety)) return null
  return {
    schema_version: WORKOUT_START_ACCESS_SCHEMA,
    manifest: {
      schema_version: String(manifest.schema_version),
      surface_revision: Number(manifest.surface_revision),
      decision_id: String(identity.decision_id || ''),
      candidate_id: String(identity.candidate_id || ''),
      plan_id: String(identity.plan_id || ''),
      plan_revision: Number(identity.plan_revision),
      canonical_session_set_hash: String(identity.canonical_session_set_hash || ''),
      athlete_state_revision: Number(identity.athlete_state_revision),
      safety_state_hash: String(identity.safety_state_hash || ''),
      safety_action: String(manifest.safety.action || ''),
    },
    session: session ? {
      session_id: sessionId(session),
      session_revision: Number(session.session_revision),
      content_hash: String(session.content_hash || ''),
    } : null,
  }
}

export function workoutStartAccessFromState(state) {
  return objectValue(state?.workoutStartAccess)
}

export function workoutStartDecision({
  execution = null,
  sessionId: requestedSessionId = null,
  activity = {},
  expectedAccess,
  requireBoundAccess = false,
} = {}) {
  const surface = objectValue(execution?.surface)
  if (!surface || surface.status === 'legacy') {
    if (expectedAccess || requireBoundAccess) {
      return { allowed: false, reasonCode: 'WORKOUT_START_ACCESS_MISSING', access: null, session: null }
    }
    return { allowed: true, reasonCode: null, access: null, session: null, legacy: true }
  }
  if (surface.status !== 'accepted' || !objectValue(surface.manifest)) {
    return { allowed: false, reasonCode: 'WORKOUT_START_ACCESS_UNAVAILABLE', access: null, session: null }
  }
  const manifest = surface.manifest
  const wanted = requestedSessionId === null || requestedSessionId === undefined || requestedSessionId === ''
    ? '' : String(requestedSessionId)
  const session = wanted
    ? (Array.isArray(manifest.sessions) ? manifest.sessions : []).find((entry) => sessionId(entry) === wanted) || null
    : null
  if (wanted && !session) {
    return { allowed: false, reasonCode: 'CANONICAL_SESSION_MISSING', access: null, session: null }
  }
  const access = canonicalWorkoutStartAccess(manifest, session)
  if (!access) return { allowed: false, reasonCode: 'WORKOUT_START_ACCESS_UNAVAILABLE', access: null, session }
  if (requireBoundAccess && !objectValue(expectedAccess)) {
    return { allowed: false, reasonCode: 'WORKOUT_START_ACCESS_MISSING', access, session }
  }
  if (objectValue(expectedAccess) && JSON.stringify(expectedAccess) !== JSON.stringify(access)) {
    return { allowed: false, reasonCode: 'WORKOUT_START_ACCESS_STALE', access, session }
  }
  if (session && session.executability !== 'EXECUTABLE') {
    return {
      allowed: false,
      reasonCode: safetyBlockReason(manifest, session, activity) || 'SESSION_NOT_EXECUTABLE',
      access,
      session,
    }
  }
  const reasonCode = safetyBlockReason(manifest, session, activity)
  return { allowed: !reasonCode, reasonCode, access, session }
}

export function workoutStartErrorMessage(reasonCode) {
  if (reasonCode === 'FULL_REST') return 'Your current safety plan calls for full rest, so workouts cannot start.'
  if (reasonCode === 'NO_RUNNING') return 'Running is currently restricted by your safety plan.'
  if (reasonCode === 'NO_LOWER_BODY') return 'Lower-body training is currently restricted by your safety plan.'
  if (reasonCode === 'NO_HIGH_INTENSITY') return 'High-intensity training is currently restricted by your safety plan.'
  if (reasonCode === 'MODIFIED_SESSION_ONLY') return 'Only the explicitly modified session can start right now.'
  if (reasonCode === 'MODIFY_IMPACT') return 'Impact work must be modified before this session can start.'
  if (reasonCode === 'SESSION_NOT_EXECUTABLE') return 'This planned session is not currently executable.'
  return 'Forge could not verify the current safety revision. Refresh Today or Train before starting.'
}

export function resolveTodayPlanAccess({
  checkedInToday = false,
  recommendation = null,
  calendarSessions = [],
  isRestDay = false,
  isPlannedRestDay = isRestDay,
  hasRunRecordedToday = false,
  onCheckIn,
  onStartWorkout,
  onStartUnplannedRun,
  onDetails,
} = {}) {
  const sessions = Array.isArray(calendarSessions) ? calendarSessions : []
  const sessionCount = sessions.length
  const pendingSessions = sessions.filter((session) => session?.completed !== true)
  const pendingSessionCount = pendingSessions.length
  const executablePendingCount = pendingSessions.filter((session) => (
    !session?.executability || session.executability === 'EXECUTABLE'
  )).length
  const allScheduledComplete = sessionCount > 0 && pendingSessionCount === 0
  const allScheduledBlocked = pendingSessionCount > 0 && executablePendingCount === 0
  const hasRecommendation = Boolean(recommendation)
  const isRestRecommendation = recommendation?.recommendationType === 'rest' || recommendation?.type === 'rest'
  const hasViewablePlan = hasRecommendation || sessionCount > 0 || isRestDay

  // Dashboard/Today no longer supplies a check-in action. Keep the optional
  // callback contract below for older non-surface callers while the current
  // accepted-plan path opens or starts training immediately.
  if (typeof onCheckIn !== 'function') {
    if (!hasViewablePlan) {
      return {
        hasViewablePlan: false,
        primaryAction: onDetails || onStartWorkout,
        primaryLabel: 'View plan',
        secondaryAction: null,
        secondaryLabel: null,
        trainAction: onDetails || onStartWorkout,
        uncheckedSignal: 'No accepted workout is scheduled today. Open the calendar to review the plan.',
        readinessFallback: 'No accepted workout is available today. Open the calendar to review the plan.',
        showCheckIn: false,
        showStartLog: false,
      }
    }

    if (isRestRecommendation && !isPlannedRestDay) {
      return {
        hasViewablePlan: true,
        primaryAction: onDetails,
        primaryLabel: 'View recovery',
        secondaryAction: null,
        secondaryLabel: null,
        trainAction: onDetails,
        uncheckedSignal: 'Recovery is today\'s current safety guidance.',
        readinessFallback: 'Recovery is today\'s current safety guidance. Review the reason before choosing any training.',
        showCheckIn: false,
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
        uncheckedSignal: 'Rest is scheduled today. Recovery is the accepted plan unless you choose to train.',
        readinessFallback: 'Rest is scheduled from the accepted plan. Feeling fresh keeps the rest day in place.',
        showCheckIn: false,
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
        showCheckIn: false,
        showStartLog: false,
      }
    }

    if (allScheduledBlocked) {
      return {
        hasViewablePlan: true,
        primaryAction: onDetails,
        primaryLabel: 'View workout',
        secondaryAction: null,
        secondaryLabel: null,
        trainAction: onDetails,
        uncheckedSignal: 'Today\'s workout is visible but cannot start under the current safety plan.',
        readinessFallback: 'The current safety plan blocks this workout. Review the details for the scoped reason.',
        showCheckIn: false,
        showStartLog: false,
      }
    }

    return {
      hasViewablePlan: true,
      primaryAction: onStartWorkout,
      primaryLabel: 'Start workout',
      secondaryAction: onDetails,
      secondaryLabel: onDetails ? 'Details' : null,
      trainAction: onStartWorkout,
      uncheckedSignal: "Today's accepted workout is ready to start.",
      readinessFallback: 'The accepted scheduled workout is ready. Synced readiness adds context without gating training.',
      showCheckIn: false,
      showStartLog: hasRecommendation && sessionCount === 0,
    }
  }

  if (!hasViewablePlan) {
    return {
      hasViewablePlan: false,
      primaryAction: onCheckIn,
      primaryLabel: checkedInToday ? 'Edit check-in' : 'Check in',
      secondaryAction: null,
      secondaryLabel: null,
      trainAction: onCheckIn,
      uncheckedSignal: 'Check in for today\'s guidance.',
      readinessFallback: checkedInToday
        ? 'No recommendation is available yet. Review your check-in or open the calendar.'
        : 'Check in for today\'s guidance. Sync a watch to add readiness context.',
      showCheckIn: true,
      showStartLog: false,
    }
  }

  if (isRestRecommendation && !isPlannedRestDay) {
    return {
      hasViewablePlan: true,
      primaryAction: checkedInToday ? (onDetails || onCheckIn) : onCheckIn,
      primaryLabel: checkedInToday ? 'View recovery' : 'Check in',
      secondaryAction: checkedInToday ? onCheckIn : onDetails,
      secondaryLabel: checkedInToday ? 'Edit check-in' : (onDetails ? 'Details' : null),
      trainAction: checkedInToday ? (onDetails || onCheckIn) : onCheckIn,
      uncheckedSignal: checkedInToday
        ? 'Your check-in changed today to recovery. Review it before choosing any training.'
        : 'Rest is a current recommendation, not a scheduled plan rest day. Check in so today\'s guidance uses how you feel now.',
      readinessFallback: checkedInToday
        ? 'Your check-in changed today to recovery. Edit the check-in if your condition changes.'
        : 'Check in so the recommendation can use how you feel now; a strong check-in does not automatically create a rest day.',
      showCheckIn: true,
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
      uncheckedSignal: 'Rest is scheduled today. No check-in is needed unless you choose to train.',
      readinessFallback: 'Rest is scheduled from your plan. Feeling fresh keeps the rest day in place. If you intentionally train or make up a missed run, Forged asks for a quick safety check-in before starting.',
      showCheckIn: false,
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
      showCheckIn: true,
      showStartLog: false,
    }
  }

  if (allScheduledBlocked) {
    return {
      hasViewablePlan: true,
      primaryAction: onDetails,
      primaryLabel: 'View workout',
      secondaryAction: checkedInToday ? null : onCheckIn,
      secondaryLabel: checkedInToday ? null : 'Check in',
      trainAction: onDetails,
      uncheckedSignal: 'Today\'s workout is visible but cannot start under the current safety plan.',
      readinessFallback: 'The current safety plan blocks this workout. Review the details for the scoped reason.',
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
    showCheckIn: true,
    showStartLog: isRestDay || (hasRecommendation && sessionCount === 0),
  }
}

export function resolveTodayWorkoutLabel({ calendarKinds = [], recommendationLabel = null } = {}) {
  if (calendarKinds.length > 1) return 'Run + lift'
  if (calendarKinds[0] === 'lift') return 'Strength'
  if (calendarKinds[0] === 'run') return 'Run'
  return recommendationLabel
}
