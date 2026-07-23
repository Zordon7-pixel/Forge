export function normalizeDurationSeconds(value) {
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds <= 0) return 0
  return Math.floor(seconds)
}

export function splitDurationSeconds(value) {
  const total = normalizeDurationSeconds(value)
  return {
    hours: Math.floor(total / 3600),
    minutes: Math.floor((total % 3600) / 60),
    seconds: total % 60,
  }
}

export function durationPartsToSeconds({ hours = 0, minutes = 0, seconds = 0 } = {}) {
  const safeHours = Math.max(0, Math.floor(Number(hours) || 0))
  const safeMinutes = Math.max(0, Math.min(59, Math.floor(Number(minutes) || 0)))
  const safeSeconds = Math.max(0, Math.min(59, Math.floor(Number(seconds) || 0)))
  return safeHours * 3600 + safeMinutes * 60 + safeSeconds
}

export function formatDuration(value, { padHours = false } = {}) {
  const { hours, minutes, seconds } = splitDurationSeconds(value)
  const hourLabel = padHours ? String(hours).padStart(2, '0') : String(hours)
  return `${hourLabel}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
