const EACH_SIDE_PATTERN = /\b(?:each|per)\s+(?:side|leg|arm)\b/i
const HOLD_PATTERN = /\bhold\b/i

function boundedDuration(value, fallback = 30) {
  const parsed = Math.round(Number(value))
  if (!Number.isFinite(parsed) || parsed < 5 || parsed > 180) return fallback
  return parsed
}

export function stretchTimerSeconds(stretch = {}) {
  const text = `${stretch.reps || ''} ${stretch.durationLabel || ''}`
  const holdMatch = text.match(/\bhold\s*(\d{1,3})\s*(?:s|sec|seconds?)\b/i)
    || text.match(/\b(\d{1,3})\s*(?:s|sec|seconds?)\s*(?:each|per)\s+(?:side|leg|arm)\b/i)
  return boundedDuration(holdMatch?.[1] ?? stretch.duration)
}

export function stretchSideCount(stretch = {}) {
  const text = `${stretch.reps || ''} ${stretch.durationLabel || ''}`
  const isTimedHold = HOLD_PATTERN.test(text) || String(stretch.type || '').toLowerCase() === 'static'
  return isTimedHold && EACH_SIDE_PATTERN.test(text) ? 2 : 1
}

export function stretchSideLabel(stretch, sideIndex = 0) {
  if (stretchSideCount(stretch) !== 2) return ''
  return sideIndex === 0 ? 'Left side' : 'Right side'
}
