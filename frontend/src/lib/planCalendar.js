// Forged Training Calendar — pure model module (H2).
//
// Framework-free so it can be unit-smoke-tested directly under Node ESM and
// reused by the Week/Month/Day calendar components. It normalizes BOTH legacy
// plan shapes (week.sessions[] flat day entries, week.days[] legacy day entries)
// and schema-v2 shapes (week.days[] where each day carries a sessions[] array of
// run/lift entries). All date math is LOCAL-date-safe: we never hand a bare
// 'YYYY-MM-DD' to `new Date()` (which parses as UTC and drifts a day), and day
// arithmetic uses the local Date(y, m, d + n) constructor which is DST-safe.

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
  if (raw === 'run_only' || raw === 'hybrid_maintain' || raw === 'hybrid_build') return raw
  // Infer from strength policy / plan type when explicit mode is absent (legacy).
  const policy = data.strengthPolicy || data.strength_policy
  if (policy && policy.enabled === false) return 'run_only'
  if (policy && String(policy.goal || '').toLowerCase() === 'build') return 'hybrid_build'
  if (policy && policy.enabled) return 'hybrid_maintain'
  const type = String(plan?.type || data.type || '').toLowerCase()
  if (type.includes('hybrid') || type.includes('strength')) return 'hybrid_maintain'
  return 'run_only'
}

export function planModeLabel(mode) {
  return PLAN_MODE_LABELS[mode] || 'Run only'
}

export function isStrengthEnabled(plan) {
  return getPlanMode(plan) !== 'run_only'
}

export function getGoal(plan) {
  const data = planData(plan)
  const goal = data.goal || {}
  const dateISO = goal.date || goal.raceDate || data.raceDate || null
  return {
    name: goal.name || data.raceName || plan?.name || null,
    dateISO: dateISO || null,
    distanceMiles: Number(goal.distanceMiles || goal.distance_miles || 0) || null,
    goalType: goal.goalType || goal.goal_type || null,
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

  const data = planData(plan)
  const planStart = parseLocalDate(
    data.startDate || data.start_date || userPlan?.started_at || userPlan?.startedAt,
  )
  if (planStart) return addDays(startOfWeekMonday(planStart), weekIndex * 7)

  // Last resort: anchor on the current local week so rows still render dated.
  return startOfWeekMonday(new Date(now.getFullYear(), now.getMonth(), now.getDate()))
}

// ---------------------------------------------------------------------------
// Session normalization
// ---------------------------------------------------------------------------

export function sessionKind(rawSession = {}) {
  const raw = String(
    rawSession.kind || rawSession.workout_type || rawSession.type || '',
  ).toLowerCase()
  if (raw.includes('rest')) return 'rest'
  if (raw.includes('strength') || raw.includes('lift') || raw.includes('cross')) return 'lift'
  return 'run'
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value
  }
  return null
}

// Normalize a raw session (legacy flat entry OR schema-v2 session) into a stable
// render shape. Never invents prescription content that is not present.
export function normalizeSession(rawSession, context = {}) {
  const kind = sessionKind(rawSession)
  const prescription = rawSession.prescription || rawSession.details || {}
  const anchor = context.anchor || 'day'
  const index = context.index ?? 0
  const id = firstDefined(rawSession.id, `${anchor}-${kind}-${index}`)
  const distanceMiles =
    Number(firstDefined(rawSession.distance_miles, prescription.distanceMiles, prescription.distance_miles, 0)) || 0
  const type = firstDefined(rawSession.type, prescription.type, kind === 'lift' ? 'strength' : kind)
  const title = firstDefined(
    rawSession.title,
    prescription.title,
    prescription.name,
    kind === 'lift' ? 'Strength' : kind === 'rest' ? 'Rest day' : 'Run',
  )
  return {
    id: String(id),
    kind,
    type,
    title,
    distanceMiles,
    status: String(rawSession.status || prescription.status || '').toLowerCase() || null,
    adjusted: Boolean(rawSession.adjusted || rawSession.status === 'adjusted' || prescription.adjusted),
    prescription,
    raw: rawSession,
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
    if (!byWeekday.has(weekdayIndex)) byWeekday.set(weekdayIndex, entry)
  })

  const days = []
  for (let slot = 0; slot < 7; slot += 1) {
    const entry = byWeekday.get(slot) || null
    const slotDate = weekStartDate ? addDays(weekStartDate, slot) : null
    const entryDate = entry ? parseLocalDate(entry.date) : null
    const date = entryDate || slotDate
    const anchor = firstDefined(entry?.id, entry?.date, toISODate(date), `day-${slot}`)

    let sessions = []
    if (entry) {
      if (isSchemaV2Entry(entry)) {
        sessions = entry.sessions.map((raw, index) =>
          normalizeSession(raw, { anchor, index }),
        )
      } else {
        // Legacy flat/day entry: the entry itself is one session.
        const normalized = normalizeSession(entry, { anchor, index: 0 })
        if (normalized.kind !== 'rest') sessions = [normalized]
      }
    }

    if (runOnly) sessions = sessions.filter((session) => session.kind === 'run')

    const isRest = sessions.length === 0
    days.push({
      slot,
      dayLabel: WEEKDAYS[slot],
      dateISO: toISODate(date),
      date,
      sessions,
      isRest,
      orderGuidance: firstDefined(entry?.orderGuidance, entry?.order_guidance),
      whyToday: firstDefined(entry?.whyToday, entry?.why_today, entry?.explanation),
      recovery: firstDefined(entry?.recovery, entry?.recoveryNote),
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
  for (const kind of ['run', 'lift']) {
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
  if (hasRun && hasLift) return 'hybrid'
  if (hasLift) return 'lift'
  if (hasRun) return 'run'
  return 'rest'
}

// ---------------------------------------------------------------------------
// Full calendar model
// ---------------------------------------------------------------------------

export function buildCalendarModel(plan, userPlan, options = {}) {
  const now = options.now || new Date()
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
    }
  })

  const daysByDate = new Map()
  weekModels.forEach((week) => {
    week.days.forEach((day) => {
      if (day.dateISO) daysByDate.set(day.dateISO, { ...day, weekIndex: week.weekIndex, phase: week.phase })
    })
  })

  return {
    mode,
    modeLabel: planModeLabel(mode),
    runOnly,
    strengthEnabled: !runOnly,
    goal: getGoal(plan),
    phaseForWeek: (weekIndex) => weekModels[weekIndex]?.phase || null,
    weekCount: weekCount || weekModels.length,
    weeks: weekModels,
    getWeek: (weekIndex) => weekModels[weekIndex] || null,
    findDayByDate: (dateISO) => daysByDate.get(dateISO) || null,
    daysByDate,
  }
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
      cells.push({
        dateISO: iso,
        dayOfMonth: cellDate.getDate(),
        inMonth: cellDate.getMonth() === month,
        isToday: iso === nowISO,
        mark: dayModel ? monthMark(dayModel) : null,
        state: dayModel ? dayStatus(dayModel, options.completedSet) : null,
        hasPlan: Boolean(dayModel),
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
