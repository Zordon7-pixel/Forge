// Pure deterministic helpers for race-plan reconciliation and travel/no-gym
// choices. This module intentionally has no API, storage, geolocation, or AI
// dependency so its safety decisions can run under plain Node smoke tests.

import { isRestExecutionAuthority, isRestSession, runRouteState } from './dailyExecutionCore.js'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function validISODate(value) {
  const text = String(value || '')
  if (!ISO_DATE.test(text)) return false
  const parsed = new Date(`${text}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text
}

function normalizedIdentity(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')
}

function raceId(value) {
  return String(value?.raceId || value?.race_id || value?.id || '').trim()
}

function raceDate(value) {
  return String(value?.dateISO || value?.date || value?.raceDate || value?.race_date || '').trim()
}

function raceName(value) {
  return String(value?.name || value?.raceName || value?.race_name || '').trim()
}

function goalTimeSeconds(value) {
  return Number(value?.goalTimeSeconds ?? value?.goal_time_seconds ?? 0)
}

function sameRaceIdentity(left, right) {
  if (!left || !right) return false
  const leftId = raceId(left)
  const rightId = raceId(right)
  if (leftId && rightId && leftId === rightId) return true
  return Boolean(
    validISODate(raceDate(left))
    && raceDate(left) === raceDate(right)
    && normalizedIdentity(raceName(left))
    && normalizedIdentity(raceName(left)) === normalizedIdentity(raceName(right))
  )
}

function daysApart(leftISO, rightISO) {
  if (!validISODate(leftISO) || !validISODate(rightISO)) return null
  return Math.abs(Math.round(
    (new Date(`${rightISO}T12:00:00.000Z`).getTime() - new Date(`${leftISO}T12:00:00.000Z`).getTime()) / 86400000,
  ))
}

export function deriveRacePlanReconciliation({ calendarGoals, savedRaces, todayISO } = {}) {
  const goals = Array.isArray(calendarGoals) ? calendarGoals : []
  const protectedGoals = goals.filter((goal) => raceId(goal))
  if (protectedGoals.length !== 1 || !validISODate(todayISO)) return null

  const rows = Array.isArray(savedRaces) ? savedRaces : []
  const protectedGoal = protectedGoals[0]
  const protectedRace = rows.find((race) => raceId(race) === raceId(protectedGoal)) || null
  if (!protectedRace || !(goalTimeSeconds(protectedRace) > 0)) return null

  const eligible = rows.filter((race) => (
    String(race?.status || '').toLowerCase() === 'upcoming'
    && validISODate(raceDate(race))
    && raceDate(race) >= todayISO
    && goalTimeSeconds(race) > 0
    && !sameRaceIdentity(protectedRace, race)
  ))

  if (eligible.length > 1) {
    return {
      kind: 'review',
      reason: 'ambiguous',
      protectedRace,
      candidates: eligible.slice().sort((a, b) => raceDate(a).localeCompare(raceDate(b))),
    }
  }
  if (eligible.length !== 1) return null

  const missingRace = eligible[0]
  const gapDays = daysApart(raceDate(protectedRace), raceDate(missingRace))
  if (gapDays === null || gapDays < 21) {
    return {
      kind: 'review',
      reason: 'close_dates',
      protectedRace,
      candidates: [missingRace],
      gapDays,
    }
  }

  const orderedRaces = [protectedRace, missingRace]
    .slice()
    .sort((a, b) => raceDate(a).localeCompare(raceDate(b)))
  return {
    kind: 'direct',
    protectedRace,
    missingRace,
    orderedRaces,
    orderedRaceIds: orderedRaces.map(raceId),
    gapDays,
  }
}

function normalizeLifeFlags(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  const trimmed = value.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed
    if (typeof parsed === 'string') return [parsed]
  } catch (error) {
    // A plain comma-separated value is a supported defensive fallback.
    if (!(error instanceof SyntaxError)) return []
  }
  return trimmed.split(/[,|]/)
}

export function checkinLifeFlags(checkinData) {
  const raw = checkinData?.life_flags ?? checkinData?.lifeFlags ?? checkinData?.flags ?? []
  return [...new Set(normalizeLifeFlags(raw)
    .map((flag) => String(flag || '').trim().toLowerCase().replace(/[\s-]+/g, '_'))
    .filter(Boolean))]
}

export function trainingGapEvidence(proposal) {
  const evidence = Array.isArray(proposal?.evidence) ? proposal.evidence : []
  return evidence.find((item) => String(item?.signal || '').toLowerCase() === 'run_gap') || null
}

function readinessState(readiness) {
  const available = readiness?.available === true && Number.isFinite(Number(readiness?.score))
  const score = available ? Number(readiness.score) : null
  const band = String(readiness?.band || '').trim().toUpperCase()
  const poor = available && (score < 45 || ['RED', 'POOR', 'REST'].includes(band))
  return { available, poor }
}

function hasActiveInjury(activeInjury) {
  if (!activeInjury) return false
  if (activeInjury === true) return true
  if (typeof activeInjury !== 'object') return Boolean(activeInjury)
  if (activeInjury.active === false && !activeInjury.id && !activeInjury.unknown) return false
  return true
}

export function buildTravelRecoveryWorkout({ date = null } = {}) {
  return {
    travelRecovery: true,
    source: 'travel_recovery',
    kind: 'run',
    type: 'recovery',
    workout_type: 'recovery',
    title: '20-minute recovery run',
    date: validISODate(date) ? date : null,
    prescription_basis: 'time',
    duration_min: 20,
    distance_miles: 2,
    distance_is_estimate: true,
    target_zone: 'Zone 1-2',
    pace_target: 'Fully conversational; walking is allowed',
    intensity: 'Recovery',
    walking_allowed: true,
    warmup: ['5 min easy walking'],
    steps: [
      'Keep breathing relaxed in Zone 1-2',
      'Walk whenever needed to stay fully conversational',
      'Stop if soreness changes your stride',
    ],
    cooldown: ['5 min easy walking'],
    progression: 'Do not add time, distance, hills, or speed today.',
    description: 'An optional short recovery route for a real run gap; rest remains a valid choice.',
    planSessionId: null,
    currentWeek: null,
  }
}

export function normalizeTravelWorkoutOverride(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.travelRecovery !== true || value.source !== 'travel_recovery') return null
  return buildTravelRecoveryWorkout({ date: value.date })
}

export function deriveTravelTrainingChoices({
  execution,
  checkinData,
  adaptationProposal,
  readiness,
  activeInjury,
  hasRunRecordedToday,
  travelContext,
} = {}) {
  const lifeFlags = checkinLifeFlags(checkinData)
  const traveling = lifeFlags.includes('traveling')
  const gapEvidence = trainingGapEvidence(adaptationProposal)
  const gapDecision = String(adaptationProposal?.decisionStatus || '').toLowerCase()
  const activeGap = Boolean(gapEvidence) && !['accepted', 'kept'].includes(gapDecision)
  const restBlocked = isRestExecutionAuthority(execution) || isRestSession(execution?.lift)
  const scheduledLift = !restBlocked && execution?.lift && execution.lift.completed !== true
    ? execution.lift
    : null
  const injuryBlocked = hasActiveInjury(activeInjury) || lifeFlags.includes('injured')
  const readinessTruth = readinessState(readiness)
  const choices = []
  const safeToTrain = !injuryBlocked && readinessTruth.available && !readinessTruth.poor
  const runAlreadyComplete = hasRunRecordedToday === true
  const scheduledRunState = runAlreadyComplete ? null : runRouteState(execution)

  if (scheduledRunState) {
    choices.push({
      id: 'run_near_me',
      kind: 'scheduled_run',
      label: 'Run near me',
      description: 'Map today\'s exact scheduled run from your current location.',
      routeState: scheduledRunState,
    })
  } else if (!scheduledRunState && activeGap && safeToTrain && !runAlreadyComplete) {
    const workout = buildTravelRecoveryWorkout({ date: execution?.date || null })
    choices.push({
      id: 'run_near_me',
      kind: 'recovery_run',
      label: 'Run near me',
      description: 'Map an optional 20-minute Zone 1-2 recovery route; walking is allowed.',
      workout,
      routeState: {
        planSessionId: null,
        currentWeek: null,
        scheduledRun: null,
        travelWorkoutOverride: workout,
      },
    })
  }

  if (scheduledLift && safeToTrain) {
    choices.push({
      id: 'bodyweight_strength',
      kind: 'bodyweight_strength',
      label: 'Runner strength — no equipment',
      description: 'Translate the exact scheduled lift and keep its plan credit.',
      sessionId: String(scheduledLift.id || ''),
      currentWeek: execution?.week ?? null,
    })
  }

  const meaningfulChoiceCount = choices.length
  const reasons = [
    traveling ? 'traveling' : null,
    scheduledRunState ? 'scheduled_run' : null,
    scheduledLift ? 'scheduled_lift' : null,
    activeGap ? 'training_gap' : null,
  ].filter(Boolean)
  if (meaningfulChoiceCount === 0) {
    return {
      shouldPrompt: false,
      needsLocation: false,
      reasons,
      choices: [],
      gapEvidence: activeGap ? gapEvidence : null,
      locationStatus: String(travelContext?.status || 'unchecked'),
    }
  }

  choices.push({
    id: 'mobility_recovery',
    kind: 'recovery',
    label: 'Mobility / recovery',
    description: 'Use the existing recovery flow with no added mileage.',
  })
  choices.push({
    id: 'keep_planned',
    kind: 'keep',
    label: 'Keep today as planned',
    description: 'Dismiss this choice for today without changing the calendar.',
  })

  return {
    shouldPrompt: String(travelContext?.status || '').toLowerCase() === 'away',
    needsLocation: true,
    reasons,
    choices,
    gapEvidence: activeGap ? gapEvidence : null,
    locationStatus: String(travelContext?.status || 'unchecked').toLowerCase(),
  }
}
