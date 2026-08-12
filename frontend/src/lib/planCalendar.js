// Forged Training Calendar — pure model module (H2).
//
// Framework-free so it can be unit-smoke-tested directly under Node ESM and
// reused by the Week/Month/Day calendar components. It normalizes BOTH legacy
// plan shapes (week.sessions[] flat day entries, week.days[] legacy day entries)
// and schema-v2 shapes (week.days[] where each day carries a sessions[] array of
// run/lift entries). All date math is LOCAL-date-safe: we never hand a bare
// 'YYYY-MM-DD' to `new Date()` (which parses as UTC and drifts a day), and day
// arithmetic uses the local Date(y, m, d + n) constructor which is DST-safe.

import { isRunningActivity } from './activityType.js'

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

const DAY_NAME_TO_INDEX = {
  mon: 0, monday: 0,
  tue: 1, tues: 1, tuesday: 1,
  wed: 2, weds: 2, wednesday: 2,
  thu: 3, thur: 3, thurs: 3, thursday: 3,
  fri: 4, friday: 4,
  sat: 5, saturday: 5,
  sun: 6, sunday: 6,
}

const PLAN_MODE_LABELS = {
  run_only: 'Run only',
  hybrid_maintain: 'Maintain strength',
  hybrid_build: 'Build strength',
  hyrox_build: 'HYROX build',
}

const FEASIBILITY_LABELS = Object.freeze({
  supported: 'On track',
  stretch: 'Stretch target',
  unsafe: 'Goal needs adjustment',
  not_applicable: 'Completion goal',
})

const HYROX_RUNWAY_LABELS = Object.freeze({
  foundation_only: 'Eight-week HYROX foundation',
  race_week: 'Race-week HYROX taper',
  readiness_bridge: 'HYROX readiness bridge',
  short_runway: 'Short-runway HYROX specialization',
  standard_build: 'Standard HYROX build',
  full_build: 'Full HYROX foundation and build',
  base_then_build: 'Base development before HYROX-specific work',
})

function readableHyroxKey(value) {
  return String(value || '').replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function hyroxCandidateReviewModel(plan = {}) {
  const policy = plan.hyroxPolicy || {}
  const weeks = Array.isArray(plan.weeks) ? plan.weeks : []
  const phases = [...new Set(weeks.map((week) => week?.phase).filter(Boolean))]
  const goals = Array.isArray(plan.goals) ? plan.goals : plan.goal ? [plan.goal] : []
  const secondary = goals.find((goal) => String(goal?.kind || goal?.eventKind) === 'run_race')
  const missingEquipment = Array.isArray(policy.missingEquipment) ? policy.missingEquipment : []
  const availableEquipment = Array.isArray(policy.equipment) ? policy.equipment : []
  const hardDayLimit = Number(policy.maximumHardLowerBodyDaysPerRollingSeven || 0)
  const runDays = Number(plan.schedulePreferences?.runDaysPerWeek || 0)
  const hyroxDays = Number(policy.sessionsPerWeek || 0)
  return {
    daysRemaining: Number.isInteger(policy.daysToEventAtGeneration) ? policy.daysToEventAtGeneration : null,
    runwayClass: String(policy.runwayClass || ''),
    runwayLabel: HYROX_RUNWAY_LABELS[policy.runwayClass] || readableHyroxKey(policy.runwayClass),
    phases,
    phaseLabels: phases.map(readableHyroxKey),
    weekCount: weeks.length,
    sessionSummary: `${runDays} run exposures · ${hyroxDays} HYROX exposures · ${hardDayLimit} hard lower-body days`,
    missingEquipment,
    availableEquipment,
    equipmentTruth: missingEquipment.length
      ? `Missing ${missingEquipment.map(readableHyroxKey).join(', ')}. The plan uses pattern-only substitutions and does not claim exact station readiness.`
      : 'Required station equipment is available; exact prescriptions remain canonical metric values.',
    safetyPolicy: `No more than ${hardDayLimit} hard lower-body days in a rolling seven-day window. Compromised sessions replace another hard stimulus.`,
    recoveryTransition: secondary && phases.includes('post_hyrox_recovery')
      ? `Post-HYROX recovery comes before the running-specific transition to ${secondary.name || 'the secondary running race'}.`
      : '',
  }
}

// ---------------------------------------------------------------------------
// Local-date-safe helpers
// ---------------------------------------------------------------------------

export function parseLocalDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : new Date(value.getFullYear(), value.getMonth(), value.getDate())
  }
  if (typeof value !== 'string' || value.trim() === '') return null
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (match) {
    return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  }
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime())
    ? null
    : new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())
}

export function toISODate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function addDays(date, amount) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + amount)
}

export function startOfWeekMonday(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null
  const mondayOffset = (date.getDay() + 6) % 7
  return addDays(date, -mondayOffset)
}

export function isSameISODate(a, b) {
  return Boolean(a) && Boolean(b) && a === b
}

export function todayISO(now = new Date()) {
  return toISODate(new Date(now.getFullYear(), now.getMonth(), now.getDate()))
}

export function countdownDays(goalISO, referenceISO = todayISO()) {
  const goal = parseLocalDate(goalISO)
  const ref = parseLocalDate(referenceISO)
  if (!goal || !ref) return null
  const diffMs = goal.getTime() - ref.getTime()
  return Math.round(diffMs / 86400000)
}

function normalizeDayName(name) {
  if (!name && name !== 0) return null
  const key = String(name).trim().toLowerCase()
  if (key in DAY_NAME_TO_INDEX) return DAY_NAME_TO_INDEX[key]
  return null
}

// ---------------------------------------------------------------------------
// Plan-level accessors
// ---------------------------------------------------------------------------

function planData(plan) {
  return plan?.plan_data || plan?.planData || plan || {}
}

export function getPlanMode(plan) {
  const data = planData(plan)
  const raw = String(data.planMode || data.plan_mode || '').toLowerCase()
  if (raw === 'run_only' || raw === 'hybrid_maintain' || raw === 'hybrid_build' || raw === 'hyrox_build') return raw
  // Infer from strength policy / plan type when explicit mode is absent (legacy).
  const policy = data.strengthPolicy || data.strength_policy
  if (policy && policy.enabled === false) return 'run_only'
  if (policy && String(policy.goal || '').toLowerCase() === 'build') return 'hybrid_build'
  if (policy && policy.enabled) return 'hybrid_maintain'
  const type = String(plan?.type || data.type || '').toLowerCase()
  if (type.includes('hybrid') || type.includes('strength')) return 'hybrid_maintain'
  // Legacy catalog plan types are race distances (5K, 10K, etc.), so infer
  // hybrid mode from their actual sessions just as the backend schema does.
  for (const week of getWeeks(plan)) {
    for (const entry of weekEntries(week)) {
      const sessions = isSchemaV2Entry(entry) ? entry.sessions : [entry]
      if (sessions.some((session) => sessionKind(session) === 'lift')) {
        return 'hybrid_maintain'
      }
    }
  }
  return 'run_only'
}

export function planModeLabel(mode) {
  return PLAN_MODE_LABELS[mode] || 'Run only'
}

export function feasibilityLabel(status) {
  return FEASIBILITY_LABELS[String(status || '').toLowerCase()] || null
}

export function isStrengthEnabled(plan) {
  return getPlanMode(plan) !== 'run_only'
}

function normalizeGoal(data, plan, goal = {}) {
  const dateISO = goal.date || goal.raceDate || data.raceDate || null
  const distanceMiles = Number(goal.distanceMiles || goal.distance_miles || 0) || null
  const goalTimeSeconds = Number(goal.goalTimeSeconds || goal.goal_time_seconds || 0) || null
  const rawRaceTarget = goal.raceTarget || goal.race_target || data.raceTarget || data.race_target || null
  const raceTarget = rawRaceTarget && typeof rawRaceTarget === 'object'
    ? {
        raceId: rawRaceTarget.raceId || rawRaceTarget.race_id || null,
        name: rawRaceTarget.name || rawRaceTarget.raceName || rawRaceTarget.race_name || null,
        dateISO: rawRaceTarget.date || rawRaceTarget.raceDate || rawRaceTarget.race_date || null,
        distanceMiles: Number(rawRaceTarget.distanceMiles || rawRaceTarget.distance_miles || 0) || null,
        location: rawRaceTarget.location ?? null,
        goalTimeSeconds: Number(rawRaceTarget.goalTimeSeconds || rawRaceTarget.goal_time_seconds || 0) || null,
      }
    : null
  const derivedPace = goalTimeSeconds && distanceMiles ? Math.round(goalTimeSeconds / distanceMiles) : null
  return {
    kind: goal.kind || goal.eventKind || goal.event_kind || 'run_race',
    raceId: goal.raceId || goal.race_id || data.raceId || data.race_id || null,
    name: goal.name || data.raceName || plan?.name || null,
    dateISO: dateISO || null,
    distanceMiles,
    goalType: goal.goalType || goal.goal_type || null,
    goalTimeSeconds,
    goalTimeSource: goal.goalTimeSource || goal.goal_time_source || null,
    improvementTargetPercent: Number(goal.improvementTargetPercent || goal.improvement_target_percent || 0) || null,
    goalPaceSecondsPerMile: Number(goal.goalPaceSecondsPerMile || goal.goal_pace_seconds_per_mile || derivedPace || 0) || null,
    goalPaceLabel: goal.goalPaceLabel || goal.goal_pace_label || null,
    paceContext: goal.paceContext || null,
    anchorState: data.anchorState || goal.anchorState || plan?.anchorState || null,
    anchoredBy: data.anchoredBy || goal.anchoredBy || plan?.anchoredBy || null,
    course: goal.course || data.course || null,
    priority: goal.priority || null,
    sequence: Number(goal.sequence || 0) || null,
    role: goal.role || null,
    raceTarget,
  }
}

function normalizedTargetText(value) {
  return String(value || '').trim().toLowerCase()
}

// A race row is editable, while raceTarget is the owned target used when the
// workouts were generated. Comparing both keeps review state durable.
export function racePlanReview(goal = {}, race = null) {
  if (!goal || !race) return { required: false, changedFields: [] }
  const stored = goal.raceTarget
  if (!stored) return { required: false, changedFields: [] }
  if (stored.raceId && race.id && String(stored.raceId) !== String(race.id)) {
    return { required: false, changedFields: [] }
  }

  const changedFields = []
  if (normalizedTargetText(stored.name) !== normalizedTargetText(race.race_name)) changedFields.push('name')
  if (String(stored.dateISO || '') !== String(race.race_date || '')) changedFields.push('date')
  if (Number(stored.distanceMiles || 0) !== Number(race.distance_miles || 0)) changedFields.push('distance')
  if (Number(stored.goalTimeSeconds || 0) !== Number(race.goal_time_seconds || 0)) changedFields.push('goal_time')
  if (normalizedTargetText(stored.location) !== normalizedTargetText(race.location)) changedFields.push('location')
  return { required: changedFields.length > 0, changedFields }
}

export function getGoals(plan) {
  const data = planData(plan)
  const goals = Array.isArray(data.goals) ? data.goals : []
  return goals.map((goal) => normalizeGoal(data, plan, goal))
}

export function getGoal(plan) {
  const data = planData(plan)
  const goals = getGoals(plan)
  return goals[goals.length - 1] || normalizeGoal(data, plan, data.goal || {})
}

// Race rows remain the editable source of truth. Overlay them on the persisted
// plan goal for display without pretending the existing workout calendar was
// regenerated from an edited date, distance, or target.
export function goalWithRace(goal = {}, race = null) {
  if (!race) return goal
  const distanceMiles = Number(race.distance_miles || 0) || null
  const goalTimeSeconds = Number(race.goal_time_seconds || 0) || null
  const identityChanged = String(goal.name || '').trim().toLowerCase() !== String(race.race_name || '').trim().toLowerCase()
    || String(goal.dateISO || '') !== String(race.race_date || '')
    || Number(goal.distanceMiles || 0) !== Number(distanceMiles || 0)
  const courseInvalidated = identityChanged || race.course_intelligence?.trusted === false
  const goalChanged = Number(goal.distanceMiles || 0) !== Number(distanceMiles || 0)
    || Number(goal.goalTimeSeconds || 0) !== Number(goalTimeSeconds || 0)
  const derivedPace = goalTimeSeconds && distanceMiles
    ? Math.round(goalTimeSeconds / distanceMiles)
    : null
  return {
    ...goal,
    raceId: race.id || goal.raceId || null,
    name: race.race_name || goal.name || null,
    dateISO: race.race_date || goal.dateISO || null,
    distanceMiles,
    location: race.location || null,
    goalTimeSeconds,
    goalTimeSource: goalChanged ? (goalTimeSeconds ? 'user' : null) : goal.goalTimeSource,
    goalPaceSecondsPerMile: derivedPace,
    goalPaceLabel: goalChanged ? null : goal.goalPaceLabel,
    paceContext: goalChanged ? null : goal.paceContext,
    anchoredBy: goalChanged ? null : goal.anchoredBy,
    course: courseInvalidated ? null : goal.course,
  }
}

export function getWeeks(plan) {
  const data = planData(plan)
  return Array.isArray(data.weeks) ? data.weeks : []
}

// Derive the Monday-anchored start date for a given zero-based week index.
export function deriveWeekStart(plan, userPlan, weekIndex, now = new Date()) {
  const weeks = getWeeks(plan)
  const week = weeks[weekIndex]
  const explicit = parseLocalDate(week?.startDate || week?.start_date)
  if (explicit) return startOfWeekMonday(explicit)

  const firstDatedEntry = weekEntries(week)
    .map((entry) => ({
      date: parseLocalDate(entry?.date),
      weekdayIndex: normalizeDayName(entry?.day || entry?.dayName),
    }))
    .filter((entry) => entry.date)
    .sort((a, b) => a.date.getTime() - b.date.getTime())[0]
  if (firstDatedEntry) {
    return addDays(
      firstDatedEntry.date,
      -(firstDatedEntry.weekdayIndex ?? ((firstDatedEntry.date.getDay() + 6) % 7)),
    )
  }

  const data = planData(plan)
  const planStart = parseLocalDate(
    data.startDate || data.start_date
      || userPlan?.effective_from || userPlan?.effectiveFrom
      || userPlan?.started_at || userPlan?.startedAt,
  )
  if (planStart) return addDays(startOfWeekMonday(planStart), weekIndex * 7)

  // Last resort: anchor on the current local week so rows still render dated.
  return addDays(
    startOfWeekMonday(new Date(now.getFullYear(), now.getMonth(), now.getDate())),
    weekIndex * 7,
  )
}

// Resolve presentation state from the plan's dated week contract. Persisted
// `user_plans.current_week` is progress metadata, not a reliable screen-open
// cursor, so it deliberately does not participate in this calculation.
export function deriveCurrentPlanWeekIndex(plan, userPlan, now = new Date()) {
  const weeks = getWeeks(plan)
  if (!weeks.length) return 0
  const localToday = parseLocalDate(now)
  if (!localToday) return 0

  let selectedIndex = 0
  for (let weekIndex = 0; weekIndex < weeks.length; weekIndex += 1) {
    const start = deriveWeekStart(plan, userPlan, weekIndex, localToday)
    if (start && start.getTime() <= localToday.getTime()) selectedIndex = weekIndex
  }
  return Math.max(0, Math.min(weeks.length - 1, selectedIndex))
}

// A non-null selection belongs only to the mounted Plan screen. Keeping it
// wins during in-session reloads; a remount passes null and re-derives today.
export function resolvePlanWeekSelection(plan, userPlan, selectedWeekIndex, now = new Date()) {
  const weekCount = Math.max(1, getWeeks(plan).length || Number(plan?.weeks || 0) || 1)
  if (Number.isInteger(selectedWeekIndex)) {
    return Math.max(0, Math.min(weekCount - 1, selectedWeekIndex))
  }
  return deriveCurrentPlanWeekIndex(plan, userPlan, now)
}

// ---------------------------------------------------------------------------
// Session normalization
// ---------------------------------------------------------------------------

export function sessionKind(rawSession = {}) {
  const raw = String(
    rawSession.kind || rawSession.workout_type || rawSession.type || '',
  ).toLowerCase()
  if (raw.includes('rest')) return 'rest'
  if (rawSession.kind === 'hyrox' || raw.startsWith('hyrox')) return 'hyrox'
  if (raw.includes('strength') || raw.includes('lift') || raw.includes('cross')) return 'lift'
  return 'run'
}

export function canonicalWorkoutLabel(session) {
  if (!session) return ''
  if (session.kind === 'hyrox') return session.title || 'HYROX session'
  if (session.kind === 'lift') {
    const focus = String(session.prescription?.focus || session.raw?.focus || '').trim()
    const label = focus.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
    return label ? `${label} strength` : 'Strength session'
  }
  if (session.type === 'race' || session.raw?.workout_id === 'race') return 'Race day'
  const identity = [session.raw?.workout_id, session.type, session.title].filter(Boolean).join(' ').toLowerCase()
  if (/benchmark/.test(identity)) return 'Benchmark run'
  if (/race.?pace|goal.?pace/.test(identity)) return 'Race-pace workout'
  if (/hill/.test(identity)) return 'Hill workout'
  if (/interval|repeat|speed/.test(identity)) return 'Interval workout'
  if (/threshold|tempo/.test(identity)) return 'Tempo / threshold run'
  if (/progression/.test(identity)) return 'Progression run'
  if (/long/.test(identity)) return 'Long run'
  if (/recovery/.test(identity)) return 'Recovery run'
  if (/easy/.test(identity)) return 'Easy aerobic run'
  return 'Run session'
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value
  }
  return null
}

const RECOVERY_MARKER = /(recovery|zone\s*1(?:\s*-\s*2)?|fully conversational)/i
const HARD_WORK_MARKER = /(hill|interval|repeat|threshold|sprint|tempo|race pace|zone\s*[3-5]|hard(?:\s+but)?|comfortably steady|steady effort|moderate\s+(?:effort|pace|run(?:ning)?|intensity))/i
const SAFE_RECOVERY_PRESCRIPTION = {
  type: 'recovery',
  workout_type: 'recovery',
  title: 'Recovery run',
  target_zone: 'Zone 1-2',
  pace_target: 'Fully conversational; walking is allowed',
  intensity: 'Recovery',
  warmup: ['5 min easy walking', 'Begin running only when your stride feels relaxed'],
  steps: ['Stay in Zone 1-2', 'Keep breathing relaxed', 'Stop if soreness changes your stride'],
  cooldown: ['5 min easy walking', 'Hydrate and refuel'],
  progression: 'Do not add pace or distance today.',
}

function nestedText(value) {
  if (Array.isArray(value)) return value.map(nestedText).join(' ')
  if (value && typeof value === 'object') return Object.values(value).map(nestedText).join(' ')
  return value === null || value === undefined ? '' : String(value)
}

export function normalizePrescription(rawSession = {}) {
  const nested = rawSession.prescription && typeof rawSession.prescription === 'object'
    ? rawSession.prescription
    : rawSession.details && typeof rawSession.details === 'object'
      ? rawSession.details
      : null
  const base = nested || rawSession
  if (sessionKind(rawSession) !== 'run') return { prescription: base, raw: rawSession, adjusted: false }
  const markers = [
    rawSession.title, rawSession.type, rawSession.workout_type, rawSession.target_zone, rawSession.intensity, rawSession.pace_target,
    base.title, base.type, base.workout_type, base.target_zone, base.intensity, base.pace_target,
  ].filter(Boolean).join(' ')
  const hardWork = nestedText([
    rawSession.warmup, rawSession.steps, rawSession.blocks, rawSession.structure, rawSession.cooldown, rawSession.pace_target, rawSession.intensity, rawSession.progression,
    base.warmup, base.steps, base.blocks, base.structure, base.cooldown, base.pace_target, base.intensity, base.progression,
  ])
  if (!RECOVERY_MARKER.test(markers) || !HARD_WORK_MARKER.test(hardWork)) {
    return { prescription: base, raw: rawSession, adjusted: false }
  }
  const prescription = { ...base, ...SAFE_RECOVERY_PRESCRIPTION, prescriptionIntegrityAdjusted: true }
  const raw = { ...rawSession, ...SAFE_RECOVERY_PRESCRIPTION, prescriptionIntegrityAdjusted: true }
  if (rawSession.prescription && typeof rawSession.prescription === 'object') raw.prescription = prescription
  if (rawSession.details && typeof rawSession.details === 'object') raw.details = prescription
  return { prescription, raw, adjusted: true }
}

export function normalizeLiftExercisePrescription(exercise = {}) {
  const rpe = exercise.rpe ?? exercise.RPE ?? exercise.rir ?? exercise.RIR ?? null
  const rawLoad = exercise.load ?? exercise.weight ?? exercise.targetLoad ?? ''
  const explicitSource = exercise.loadSource ?? exercise.load_source ?? ''
  const unsupportedGenericLoad = !explicitSource && /estimated|max|moderate|controlled|%\s*1rm|reps? in reserve/i.test(String(rawLoad))
  if (!unsupportedGenericLoad) return exercise
  return {
    ...exercise,
    load: rpe ? `Choose load for RPE/RIR ${rpe}` : 'Choose load for the prescribed effort',
    loadSource: 'Effort calibrated; this saved plan has no matching logged set attached',
  }
}

// Normalize a raw session (legacy flat entry OR schema-v2 session) into a stable
// render shape. The only synthesized content is a conservative recovery
// prescription when persisted labels conflict with hard-workout instructions.
export function normalizeSession(rawSession, context = {}) {
  const kind = sessionKind(rawSession)
  const normalized = normalizePrescription(rawSession)
  const prescription = normalized.prescription
  const safeRaw = normalized.raw
  const anchor = context.anchor || 'day'
  const index = context.index ?? 0
  const id = firstDefined(rawSession.id, context.fallbackId, `${anchor}-${kind}-${index}`)
  const distanceMiles =
    Number(firstDefined(rawSession.distance_miles, prescription.distanceMiles, prescription.distance_miles, 0)) || 0
  const durationMinutes =
    Number(firstDefined(rawSession.durationMin, rawSession.duration_min, prescription.durationMinutes, prescription.duration_min, 0)) || 0
  const prescriptionBasis = String(firstDefined(rawSession.prescription_basis, prescription.prescriptionBasis, prescription.prescription_basis, '') || '').toLowerCase()
  const type = firstDefined(prescription.type, safeRaw.type, kind === 'lift' ? 'strength' : kind)
  const title = firstDefined(
    prescription.title,
    safeRaw.title,
    prescription.name,
    kind === 'lift' ? 'Strength' : kind === 'rest' ? 'Rest day' : kind === 'hyrox' ? 'HYROX session' : 'Run',
  )
  const displayName = firstDefined(
    rawSession.display_name,
    rawSession.displayName,
    prescription.display_name,
    prescription.displayName,
  )
  return {
    id: String(id),
    kind,
    type,
    title,
    motivationalTitle: displayName && String(displayName).trim() !== String(title).trim()
      ? String(displayName).trim()
      : null,
    distanceMiles,
    durationMinutes,
    prescriptionBasis,
    distanceIsEstimate: Boolean(firstDefined(rawSession.distance_is_estimate, prescription.distanceIsEstimate, prescription.distance_is_estimate, false)),
    durationIsEstimated: Boolean(firstDefined(rawSession.durationIsEstimated, prescription.durationIsEstimated, rawSession.duration_is_estimate, prescription.duration_is_estimate, false)),
    isBenchmark: Boolean(firstDefined(rawSession.benchmark, prescription.benchmark, false)),
    benchmarkDistanceMiles: Number(firstDefined(rawSession.benchmark_distance_miles, prescription.benchmarkDistanceMiles, prescription.benchmark_distance_miles, 0)) || null,
    anchorState: firstDefined(rawSession.anchorState, prescription.anchorState, rawSession.anchor_state, prescription.anchor_state),
    status: String(rawSession.status || prescription.status || '').toLowerCase() || null,
    adjusted: Boolean(safeRaw.adjusted || safeRaw.status === 'adjusted' || prescription.adjusted || normalized.adjusted),
    prescription,
    raw: safeRaw,
  }
}

// Normalize real run rows for calendar overlays. These are deliberately kept
// separate from plan sessions: recording a run does not prove that a specific
// scheduled workout was completed unless the saved plan_session_id says so.
export function normalizeRecordedRun(activity = {}) {
  if (!activity?.id || !isRunningActivity(activity)) return null
  const dateValue = activity.date || activity.started_at || activity.start_time || activity.created_at
  const dateISO = toISODate(parseLocalDate(dateValue))
  if (!dateISO) return null
  const distanceMiles = Number(activity.distance_miles || 0) || 0
  const durationSeconds = Number(activity.duration_seconds || 0) || 0
  return {
    id: String(activity.id),
    kind: 'run',
    title: 'Recorded run',
    dateISO,
    distanceMiles,
    durationSeconds,
    paceSecondsPerMile: distanceMiles > 0 && durationSeconds > 0 ? durationSeconds / distanceMiles : null,
    planSessionId: activity.plan_session_id != null ? String(activity.plan_session_id) : null,
    source: activity.import_source || activity.source || activity.watch_source || activity.watch_mode || null,
    raw: activity,
  }
}

export function indexRecordedRuns(activities = []) {
  const byDate = new Map()
  for (const activity of activities) {
    const normalized = normalizeRecordedRun(activity)
    if (!normalized) continue
    const existing = byDate.get(normalized.dateISO) || []
    existing.push(normalized)
    byDate.set(normalized.dateISO, existing)
  }
  return byDate
}

export function dayWithRecordedRuns(dayModel, dateISO, recordedRunsByDate) {
  const activities = recordedRunsByDate?.get(dateISO) || []
  if (dayModel) return { ...dayModel, activities, hasPlan: true }
  if (!activities.length) return null
  const date = parseLocalDate(dateISO)
  const slot = date ? (date.getDay() + 6) % 7 : 0
  return {
    slot,
    dayLabel: WEEKDAYS[slot],
    dateISO,
    date,
    sessions: [],
    activities,
    isRest: true,
    hasPlan: false,
    status: 'recorded',
  }
}

export function sessionState(session, completedSet) {
  if (!session) return 'rest'
  if (session.kind === 'rest') return 'rest'
  if (completedSet && completedSet.has(String(session.id))) return 'completed'
  if (session.status === 'skipped') return 'skipped'
  if (session.adjusted || session.status === 'adjusted') return 'adjusted'
  return 'planned'
}

// ---------------------------------------------------------------------------
// Week model
// ---------------------------------------------------------------------------

function weekEntries(weekData) {
  if (!weekData) return []
  if (Array.isArray(weekData.days)) return weekData.days
  if (Array.isArray(weekData.sessions)) return weekData.sessions
  return []
}

function isSchemaV2Entry(entry) {
  return Boolean(entry) && Array.isArray(entry.sessions)
}

// Build seven stable, Monday-anchored day models for one week. Run-only plans
// never emit lift sessions or lift placeholders.
export function buildWeekDays(weekData, weekStartDate, options = {}) {
  const runOnly = options.runOnly === true
  const entries = weekEntries(weekData)
  const byWeekday = new Map()

  entries.forEach((entry, entryIndex) => {
    if (!entry) return
    let weekdayIndex = normalizeDayName(entry.day || entry.dayName)
    if (weekdayIndex === null) {
      const entryDate = parseLocalDate(entry.date)
      if (entryDate) weekdayIndex = (entryDate.getDay() + 6) % 7
    }
    if (weekdayIndex === null) weekdayIndex = entryIndex % 7
    const mapped = { entry, entryIndex }
    if (byWeekday.has(weekdayIndex)) byWeekday.get(weekdayIndex).push(mapped)
    else byWeekday.set(weekdayIndex, [mapped])
  })

  const days = []
  for (let slot = 0; slot < 7; slot += 1) {
    const mappedEntries = byWeekday.get(slot) || []
    const mapped = mappedEntries[0] || null
    const entry = mapped?.entry || null
    const slotDate = weekStartDate ? addDays(weekStartDate, slot) : null
    const entryDate = mappedEntries
      .map((item) => parseLocalDate(item.entry?.date))
      .find(Boolean) || null
    const date = entryDate || slotDate

    let sessions = mappedEntries.flatMap((item) => {
      const rawEntry = item.entry
      const anchor = firstDefined(
        rawEntry?.id,
        rawEntry?.date,
        rawEntry?.day,
        `day-${item.entryIndex}`,
      )
      if (isSchemaV2Entry(rawEntry)) {
        return rawEntry.sessions
          .map((raw, index) => normalizeSession(raw, { anchor, index }))
          .filter((session) => session.kind !== 'rest')
      }

      // Legacy flat/day entry: the entry itself is one session. Keep the
      // backend's compliance id fallback: original entry-array index.
      const normalized = normalizeSession(rawEntry, {
        anchor,
        index: 0,
        fallbackId: String(item.entryIndex),
      })
      return normalized.kind === 'rest' ? [] : [normalized]
    })

    if (runOnly) sessions = sessions.filter((session) => session.kind === 'run')

    const isRest = sessions.length === 0
    days.push({
      slot,
      dayLabel: WEEKDAYS[slot],
      dateISO: toISODate(date),
      date,
      sessions,
      isRest,
      orderGuidance: firstDefined(...mappedEntries.flatMap(({ entry: item }) => [item?.orderGuidance, item?.order_guidance])),
      whyToday: firstDefined(...mappedEntries.flatMap(({ entry: item }) => [item?.whyToday, item?.why_today, item?.explanation])),
      recovery: firstDefined(...mappedEntries.flatMap(({ entry: item }) => [item?.recovery, item?.recoveryNote])),
      anchorState: firstDefined(...mappedEntries.flatMap(({ entry: item }) => [item?.anchorState, item?.anchor_state])),
      anchoredBy: firstDefined(...mappedEntries.flatMap(({ entry: item }) => [item?.anchoredBy, item?.anchored_by])),
      status: String(entry?.status || '').toLowerCase() || (isRest ? 'rest' : 'planned'),
      raw: entry,
    })
  }
  return days
}

export function dayHasLift(dayModel) {
  return Boolean(dayModel?.sessions?.some((session) => session.kind === 'lift'))
}

export function dayHasRun(dayModel) {
  return Boolean(dayModel?.sessions?.some((session) => session.kind === 'run'))
}

// Up to two concise marks (run + lift) with their per-session state.
export function dayMarks(dayModel, completedSet) {
  if (!dayModel || dayModel.isRest) return []
  const marks = []
  for (const kind of ['run', 'lift', 'hyrox']) {
    const session = dayModel.sessions.find((item) => item.kind === kind)
    if (session) marks.push({ kind, state: sessionState(session, completedSet), id: session.id })
  }
  return marks.slice(0, 2)
}

export function dayStatus(dayModel, completedSet) {
  if (!dayModel || dayModel.isRest) return 'rest'
  if (dayModel.status === 'skipped') return 'skipped'
  const states = dayModel.sessions.map((session) => sessionState(session, completedSet))
  if (states.length && states.every((state) => state === 'completed')) return 'completed'
  if (states.includes('adjusted') || dayModel.status === 'adjusted') return 'adjusted'
  if (states.includes('skipped')) return 'skipped'
  return 'planned'
}

// Single-letter mark category used by the quiet Month overview.
export function monthMark(dayModel) {
  if (!dayModel || dayModel.isRest) return 'rest'
  const hasRun = dayHasRun(dayModel)
  const hasLift = dayHasLift(dayModel)
  const hasHyrox = dayModel.sessions?.some((session) => session.kind === 'hyrox')
  if (hasHyrox) return 'hyrox'
  if (hasRun && hasLift) return 'hybrid'
  if (hasLift) return 'lift'
  if (hasRun) return 'run'
  return 'rest'
}

export function monthMarkWithRecordedRuns(dayModel, activities = []) {
  const hasRecordedRun = activities.some((activity) => activity.kind === 'run')
  const hasRun = dayHasRun(dayModel) || hasRecordedRun
  const hasLift = dayHasLift(dayModel)
  if (hasRun && hasLift) return 'hybrid'
  if (hasLift) return 'lift'
  if (hasRun) return 'run'
  return dayModel ? 'rest' : null
}

// ---------------------------------------------------------------------------
// Full calendar model
// ---------------------------------------------------------------------------

export function buildCalendarModel(plan, userPlan, options = {}) {
  const now = options.now || new Date()
  const data = planData(plan)
  const mode = getPlanMode(plan)
  const runOnly = mode === 'run_only'
  const weeks = getWeeks(plan)
  const weekCount = Number(plan?.weeks || weeks.length || 0)

  const weekModels = weeks.map((weekData, weekIndex) => {
    const startDate = deriveWeekStart(plan, userPlan, weekIndex, now)
    return {
      weekNumber: Number(weekData?.week || weekIndex + 1),
      weekIndex,
      phase: weekData?.phase || null,
      startDate,
      startISO: toISODate(startDate),
      days: buildWeekDays(weekData, startDate, { runOnly }),
      purpose: firstDefined(weekData?.purpose, weekData?.weekPurpose, weekData?.week_purpose),
      keyQualitySession: firstDefined(weekData?.keyQualitySession, weekData?.key_quality_session),
      longRunTarget: firstDefined(weekData?.longRunTarget, weekData?.long_run_target),
      strengthIntent: firstDefined(weekData?.strengthIntent, weekData?.strength_intent),
      safetyHold: firstDefined(weekData?.safetyHold, weekData?.safety_hold, weekData?.holdReason, weekData?.hold_reason),
      deloadReason: firstDefined(weekData?.deloadReason, weekData?.deload_reason),
      bridgeWeek: Boolean(firstDefined(weekData?.bridgeWeek, weekData?.bridge_week, false)),
      raw: weekData,
    }
  })

  const daysByDate = new Map()
  weekModels.forEach((week) => {
    week.days.forEach((day) => {
      if (day.dateISO) daysByDate.set(day.dateISO, { ...day, weekIndex: week.weekIndex, phase: week.phase })
    })
  })

  const overallFeasibility = String(firstDefined(data.overall_feasibility, data.overallFeasibility, '') || '').toLowerCase()
  const goalFeasibilities = firstDefined(data.goal_feasibilities, data.goalFeasibilities, [])
  const normalizedGoalFeasibilities = Array.isArray(goalFeasibilities)
    ? goalFeasibilities.map((goalFeasibility) => {
        const status = String(firstDefined(goalFeasibility?.feasibility, goalFeasibility?.status, '') || '').toLowerCase()
        return {
          ...goalFeasibility,
          status,
          label: feasibilityLabel(status),
          raceId: firstDefined(goalFeasibility?.race_id, goalFeasibility?.raceId),
          raceName: firstDefined(goalFeasibility?.race_name, goalFeasibility?.raceName),
          fullTrainingWeeks: firstDefined(goalFeasibility?.full_training_weeks, goalFeasibility?.fullTrainingWeeks),
          reasons: Array.isArray(goalFeasibility?.reasons) ? goalFeasibility.reasons : [],
        }
      })
    : []
  const whyThisPlan = firstDefined(data.whyThisPlan, data.why_this_plan)
  const inputSummary = firstDefined(data.inputSummary, data.input_summary)
  const trainingEvidence = firstDefined(data.trainingEvidence, data.training_evidence)

  return {
    mode,
    modeLabel: planModeLabel(mode),
    runOnly,
    strengthEnabled: !runOnly,
    goal: getGoal(plan),
    goals: getGoals(plan),
    feasibility: {
      status: overallFeasibility || null,
      label: feasibilityLabel(overallFeasibility),
      goals: normalizedGoalFeasibilities,
      checkpoint: firstDefined(data.checkpoint),
      reasons: Array.isArray(data.reasons) ? data.reasons : [],
    },
    whyThisPlan: whyThisPlan && typeof whyThisPlan === 'object' ? whyThisPlan : null,
    inputSummary: inputSummary && typeof inputSummary === 'object' ? inputSummary : null,
    trainingEvidence: Array.isArray(trainingEvidence) ? trainingEvidence : [],
    engineMetadata: {
      generationTraceSchemaVersion: firstDefined(data.generationTraceSchemaVersion, data.generation_trace_schema_version),
      engineVersion: firstDefined(data.engineVersion, data.engine_version),
      policyVersion: firstDefined(data.policyVersion, data.policy_version),
      invariantVersion: firstDefined(data.invariantVersion, data.invariant_version),
      generatedAt: firstDefined(data.generatedAt, data.generated_at),
      planningClock: firstDefined(data.planningClock, data.planning_clock),
      inputHash: firstDefined(data.inputHash, data.input_hash),
      candidateHash: firstDefined(data.candidateHash, data.candidate_hash),
      generationTrace: firstDefined(data.generationTrace, data.generation_trace),
      bridgeWeek: firstDefined(data.bridgeWeek, data.bridge_week),
      overallFeasibility: firstDefined(data.overall_feasibility, data.overallFeasibility),
      goalFeasibilities,
      weeklyCurve: firstDefined(data.weekly_curve, data.weeklyCurve),
      peakLongRun: firstDefined(data.peak_long_run, data.peakLongRun),
      anchor: firstDefined(data.anchor),
      checkpoint: firstDefined(data.checkpoint),
      reasons: firstDefined(data.reasons),
      choices: firstDefined(data.choices),
      whyThisPlan,
      inputSummary,
      trainingEvidence,
      raw: data,
    },
    phaseForWeek: (weekIndex) => weekModels[weekIndex]?.phase || null,
    weekCount: weekCount || weekModels.length,
    weeks: weekModels,
    getWeek: (weekIndex) => weekModels[weekIndex] || null,
    findDayByDate: (dateISO) => daysByDate.get(dateISO) || null,
    daysByDate,
  }
}

export function calendarDateRange(model, includeISO = null) {
  const dates = model?.daysByDate instanceof Map
    ? [...model.daysByDate.keys()].filter(Boolean)
    : []
  if (includeISO && /^\d{4}-\d{2}-\d{2}$/.test(includeISO)) dates.push(includeISO)
  if (!dates.length) return null
  dates.sort()
  return { start_date: dates[0], end_date: dates[dates.length - 1] }
}

// Quiet Month overview grid: six Monday-anchored rows covering the month that
// contains `anchorISO`. Each cell carries its ISO date, in/out-of-month flag,
// and (when the plan schedules that date) a small mark category.
export function buildMonthGrid(model, anchorISO, options = {}) {
  const nowISO = options.todayISO || todayISO(options.now || new Date())
  const anchor = parseLocalDate(anchorISO) || parseLocalDate(nowISO) || new Date()
  const firstOfMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
  const gridStart = startOfWeekMonday(firstOfMonth)
  const month = anchor.getMonth()

  const rows = []
  for (let week = 0; week < 6; week += 1) {
    const cells = []
    for (let day = 0; day < 7; day += 1) {
      const cellDate = addDays(gridStart, week * 7 + day)
      const iso = toISODate(cellDate)
      const dayModel = model?.findDayByDate ? model.findDayByDate(iso) : null
      const recordedRuns = options.recordedRunsByDate?.get(iso) || []
      cells.push({
        dateISO: iso,
        dayOfMonth: cellDate.getDate(),
        inMonth: cellDate.getMonth() === month,
        isToday: iso === nowISO,
        mark: monthMarkWithRecordedRuns(dayModel, recordedRuns),
        state: recordedRuns.length ? 'recorded' : dayModel ? dayStatus(dayModel, options.completedSet) : null,
        hasPlan: Boolean(dayModel),
        hasRecordedRun: recordedRuns.length > 0,
      })
    }
    rows.push(cells)
  }
  return {
    monthLabel: anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
    monthIndex: month,
    year: anchor.getFullYear(),
    rows,
  }
}

export function addMonths(anchorISO, amount) {
  const anchor = parseLocalDate(anchorISO) || new Date()
  return toISODate(new Date(anchor.getFullYear(), anchor.getMonth() + amount, 1))
}
