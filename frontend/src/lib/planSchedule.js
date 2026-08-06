const DAY_ORDER = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])
const DEFAULT_TRAINING_DAYS = Object.freeze(['Tue', 'Thu', 'Sat'])

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.round(parsed)))
}

export function normalizeTrainingDays(value) {
  if (!Array.isArray(value)) return []
  const selected = new Set(value.map((day) => String(day || '').slice(0, 3)))
  return DAY_ORDER.filter((day) => selected.has(day))
}

export function scheduleDraftFromPlan(planData = {}) {
  const preferences = planData?.schedulePreferences || {}
  const selectedDays = normalizeTrainingDays(preferences.trainingDays)
  const trainingDays = selectedDays.length ? selectedDays : [...DEFAULT_TRAINING_DAYS]
  return {
    trainingDays,
    runDaysPerWeek: clampInteger(preferences.runDaysPerWeek, 1, Math.min(6, trainingDays.length), Math.min(3, trainingDays.length)),
  }
}

export function toggleTrainingDay(draft, day) {
  if (!DAY_ORDER.includes(day)) return draft
  const current = normalizeTrainingDays(draft?.trainingDays)
  const trainingDays = current.includes(day)
    ? current.filter((candidate) => candidate !== day)
    : normalizeTrainingDays([...current, day])
  const maximumRuns = Math.max(1, Math.min(6, trainingDays.length))
  return {
    trainingDays,
    runDaysPerWeek: clampInteger(draft?.runDaysPerWeek, 1, maximumRuns, maximumRuns),
  }
}

export function validateScheduleDraft(draft) {
  const trainingDays = normalizeTrainingDays(draft?.trainingDays)
  const runDaysPerWeek = Number(draft?.runDaysPerWeek)
  if (!trainingDays.length) return 'Choose at least one eligible running day.'
  if (!Number.isInteger(runDaysPerWeek) || runDaysPerWeek < 1 || runDaysPerWeek > 6) {
    return 'Choose between one and six running days per week.'
  }
  if (runDaysPerWeek > trainingDays.length) {
    return 'Weekly run frequency cannot exceed the number of eligible weekdays.'
  }
  return ''
}

export function scheduleFrequencyGuidance(runDaysPerWeek) {
  const count = Number(runDaysPerWeek)
  if (count <= 2) return 'A low-frequency plan concentrates the work. Forged Hybrid will not add catch-up mileage to compensate.'
  if (count === 3) return 'Three days can support a PR. Four days can separate quality, easy, steady, and long work when your history and recovery support it.'
  if (count === 4) return 'Four days separate quality, easy, steady, and long work while your recorded volume still controls the dose.'
  return 'Additional days are primarily easy volume. Forged Hybrid still limits progression from recorded history and recovery.'
}

export function protectedRaceIdsFromGoals(goals = []) {
  const normalizedGoals = Array.isArray(goals) ? goals.filter(Boolean) : []
  const raceIds = normalizedGoals.map((goal) => String(goal?.raceId || goal?.race_id || '').trim())
  const protectedRaceIds = [...new Set(raceIds.filter(Boolean))]
  if (normalizedGoals.length > 1 && (
    raceIds.some((raceId) => !raceId)
    || protectedRaceIds.length !== normalizedGoals.length
  )) {
    throw new Error('Review the saved races before rebuilding this calendar.')
  }
  return protectedRaceIds
}

export function scheduleHasChanges(planData, draft) {
  const current = scheduleDraftFromPlan(planData)
  return current.runDaysPerWeek !== Number(draft?.runDaysPerWeek)
    || JSON.stringify(current.trainingDays) !== JSON.stringify(normalizeTrainingDays(draft?.trainingDays))
}

export function buildScheduleRebuildRequest({ planData = {}, goal = {}, raceIds = [], draft, weekCount = 0 }) {
  const error = validateScheduleDraft(draft)
  if (error) throw new Error(error)

  const trainingDays = normalizeTrainingDays(draft.trainingDays)
  const runDaysPerWeek = Number(draft.runDaysPerWeek)
  const strengthPolicy = planData?.strengthPolicy || {}
  const planMode = planData?.planMode || 'run_only'
  const liftingEnabled = planMode !== 'run_only' && Boolean(strengthPolicy.enabled)
  const target = {
    trainingDays,
    runDaysPerWeek,
    planMode,
    liftingEnabled,
    liftDaysPerWeek: liftingEnabled ? Number(strengthPolicy.sessionsPerWeek || 0) : 0,
    strengthGoal: strengthPolicy.goal || 'maintain',
    equipment: Array.isArray(strengthPolicy.equipment) ? strengthPolicy.equipment : [],
  }

  const ownedRaceIds = [...new Set((raceIds || []).filter(Boolean).map(String))]
  if (ownedRaceIds.length > 2) throw new Error('A training plan can protect at most two races.')
  if (ownedRaceIds.length === 2) {
    return { path: '/plans/generate-for-races', body: { race_ids: ownedRaceIds, target } }
  }
  if (ownedRaceIds.length === 1) {
    return { path: `/plans/generate-for-race/${encodeURIComponent(ownedRaceIds[0])}`, body: { target } }
  }

  const distanceMiles = Number(goal?.distanceMiles || planData?.goal?.distanceMiles || 0)
  if (Number.isFinite(distanceMiles) && distanceMiles > 0) target.distanceMiles = distanceMiles
  if (goal?.dateISO) target.raceDate = goal.dateISO
  if (goal?.name) target.raceName = String(goal.name).slice(0, 200)
  if (Number(goal?.goalTimeSeconds) > 0) target.goalTimeSeconds = Number(goal.goalTimeSeconds)
  if (!goal?.dateISO && Number(weekCount) > 0) target.weeks = Math.max(4, Math.min(20, Math.round(Number(weekCount))))
  return { path: '/plans/generate', body: { target } }
}

export { DAY_ORDER as TRAINING_DAY_OPTIONS }
