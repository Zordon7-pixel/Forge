import { motivationalRunName } from '../../../shared/runDisplayName.mjs'

const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTH_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const DATE_FORMAT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

function parseISODate(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12))
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== String(value) ? null : date
}

function isoDate(date) {
  return date.toISOString().slice(0, 10)
}

function addDays(value, count) {
  const date = parseISODate(value)
  if (!date) return null
  date.setUTCDate(date.getUTCDate() + count)
  return isoDate(date)
}

function normalizedDay(value) {
  const key = String(value || '').trim().slice(0, 3).toLowerCase()
  return DAY_ORDER.find((day) => day.toLowerCase() === key) || null
}

function dayForDate(value) {
  const date = parseISODate(value)
  return date ? DAY_ORDER[(date.getUTCDay() + 6) % 7] : null
}

function kindForSession(session = {}) {
  const explicit = String(session.kind || '').toLowerCase()
  if (['run', 'lift', 'rest'].includes(explicit)) return explicit
  const type = String(session.workout_type || session.type || '').toLowerCase()
  if (type.includes('rest')) return 'rest'
  if (/(lift|strength|cross)/.test(type)) return 'lift'
  return 'run'
}

function restEntry(entry = {}) {
  return entry.rest === true || kindForSession(entry) === 'rest'
}

function sessionTypeLabel(session = {}) {
  const raw = String(session.type || session.workout_type || (session.kind === 'lift' ? 'strength' : 'run'))
  return raw.replace(/[_-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase())
}

function dateForEntry(entry, week, entryIndex) {
  const direct = String(entry?.date || '').slice(0, 10)
  if (parseISODate(direct)) return direct
  const startDate = String(week?.startDate || week?.week_start || '').slice(0, 10)
  if (!parseISODate(startDate)) return null
  const day = normalizedDay(entry?.day)
  const offset = day ? DAY_ORDER.indexOf(day) : entryIndex
  return offset >= 0 && offset <= 6 ? addDays(startDate, offset) : null
}

function normalizeSession(session, { date, entry, sessionIndex }) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return null
  const kind = kindForSession(session)
  if (kind === 'rest') return null
  const id = String(session.id || (!Array.isArray(entry.sessions) && entry.id) || `${date}-${kind}-${sessionIndex}`)
  const normalized = { ...session, id, kind, typeLabel: sessionTypeLabel({ ...session, kind }), displayName: '' }
  if (kind === 'run') normalized.displayName = motivationalRunName(normalized, { date, sessionId: id })
  return normalized
}

function classificationFor(sessions) {
  const hasRun = sessions.some((session) => session.kind === 'run')
  const hasLift = sessions.some((session) => session.kind === 'lift')
  if (hasRun && hasLift) return 'Run + Lift'
  if (hasRun) return 'Run'
  if (hasLift) return 'Lift'
  return 'Rest'
}

function unwrapPlan(value) {
  return value?.plan?.plan_data || value?.plan_data || value?.plan_json || value || {}
}

export function normalizePlanSchedule(value, options = {}) {
  const plan = unwrapPlan(value)
  const weeks = Array.isArray(plan?.weeks) ? plan.weeks : []
  const today = parseISODate(options.todayISO) ? options.todayISO : isoDate(new Date())
  let malformedCount = 0
  let sourceEntryCount = 0

  const normalizedWeeks = weeks.map((week, weekIndex) => {
    if (!week || typeof week !== 'object' || Array.isArray(week)) {
      malformedCount += 1
      return { weekIndex, weekNumber: weekIndex + 1, startDate: null, entries: [] }
    }
    const source = Array.isArray(week.days) ? week.days : Array.isArray(week.sessions) ? week.sessions : []
    if (!Array.isArray(week.days) && !Array.isArray(week.sessions)) malformedCount += 1
    sourceEntryCount += source.length
    const entries = []

    source.forEach((entry, entryIndex) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        malformedCount += 1
        return
      }
      if (Object.prototype.hasOwnProperty.call(entry, 'sessions') && !Array.isArray(entry.sessions)) {
        malformedCount += 1
        return
      }
      const date = dateForEntry(entry, week, entryIndex)
      if (!date) {
        malformedCount += 1
        return
      }
      const day = normalizedDay(entry.day) || dayForDate(date)
      if (!day) {
        malformedCount += 1
        return
      }
      const rawSessions = Array.isArray(entry.sessions) ? entry.sessions : restEntry(entry) ? [] : [entry]
      const sessions = rawSessions
        .map((session, sessionIndex) => normalizeSession(session, { date, entry, sessionIndex }))
        .filter(Boolean)
      malformedCount += rawSessions.filter((session) => !session || typeof session !== 'object' || Array.isArray(session)).length
      const classification = classificationFor(sessions)
      entries.push({
        key: `${date}-${weekIndex}-${entryIndex}`,
        date,
        day,
        weekIndex,
        weekNumber: Number(week.week || weekIndex + 1),
        classification,
        isRest: classification === 'Rest',
        isToday: date === today,
        sessions,
        description: String(entry.description || entry.whyToday || ''),
        raw: entry,
      })
    })

    return {
      weekIndex,
      weekNumber: Number(week.week || weekIndex + 1),
      startDate: parseISODate(String(week.startDate || week.week_start || '').slice(0, 10))
        ? String(week.startDate || week.week_start).slice(0, 10)
        : entries[0]?.date || null,
      entries,
      raw: week,
    }
  })

  const entries = normalizedWeeks.flatMap((week) => week.entries).sort((left, right) => left.date.localeCompare(right.date))
  const status = entries.length ? 'ready' : malformedCount > 0 ? 'malformed' : sourceEntryCount === 0 ? 'empty' : 'malformed'
  const requestedWeek = Math.max(1, Math.round(Number(options.currentWeek || 1)))
  const activeWeek = normalizedWeeks[requestedWeek - 1] || normalizedWeeks.find((week) => week.entries.length) || null
  return { status, entries, weeks: normalizedWeeks, activeWeek, malformedCount, todayISO: today }
}

function normalizeMonth(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})$/)
  if (!match) return null
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1, 12))
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1
    ? `${match[1]}-${match[2]}`
    : null
}

export function shiftCalendarMonth(value, amount) {
  const month = normalizeMonth(value)
  if (!month) return null
  const date = new Date(`${month}-01T12:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() + Number(amount || 0))
  return isoDate(date).slice(0, 7)
}

function rangeLabel(entries) {
  if (!entries.length) return ''
  return `${DATE_FORMAT.format(parseISODate(entries[0].date))} – ${DATE_FORMAT.format(parseISODate(entries[entries.length - 1].date))}`
}

export function calendarMonthView(model, requestedMonth, options = {}) {
  const today = parseISODate(options.todayISO) ? options.todayISO : model?.todayISO
  const month = normalizeMonth(requestedMonth) || String(today || isoDate(new Date())).slice(0, 7)
  const entries = Array.isArray(model?.entries) ? model.entries : []
  const monthEntries = entries.filter((entry) => entry.date.startsWith(`${month}-`))
  const monthsWithData = new Set(entries.map((entry) => entry.date.slice(0, 7)))
  const canPrevious = monthsWithData.has(shiftCalendarMonth(month, -1))
  const canNext = monthsWithData.has(shiftCalendarMonth(month, 1))

  if (monthEntries.length) {
    return {
      mode: 'month',
      month,
      label: MONTH_FORMAT.format(new Date(`${month}-01T12:00:00Z`)),
      entries: monthEntries,
      canPrevious,
      canNext,
    }
  }

  const datedWeeks = (model?.weeks || []).filter((week) => week.entries.length)
  const futureWeeks = datedWeeks.filter((week) => week.entries.some((entry) => !today || entry.date >= today))
  const selectedWeeks = (futureWeeks.length ? futureWeeks : datedWeeks).slice(0, 4)
  const fallbackEntries = selectedWeeks.flatMap((week) => week.entries)
  return {
    mode: 'next_four_weeks',
    month,
    label: `Next four plan weeks${fallbackEntries.length ? ` · ${rangeLabel(fallbackEntries)}` : ''}`,
    entries: fallbackEntries,
    canPrevious,
    canNext,
  }
}

export { motivationalRunName }
