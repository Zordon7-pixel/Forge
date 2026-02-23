/**
 * Parse natural language or formatted duration strings to total seconds.
 *
 * Handles:
 *   "2 hours 45 minutes"  → 9900
 *   "2h 45m"              → 9900
 *   "2:45:00"             → 9900
 *   "45:00"               → 2700
 *   "45"                  → 2700  (assumes minutes)
 *   "90 minutes"          → 5400
 *   "1 hour 30"           → 5400
 *   "1hr 30min"           → 5400
 *   "45m30s"              → 2730
 *   "45 mins 30 secs"     → 2730
 */
export function parseDuration(input) {
  if (!input || typeof input !== 'string') return null
  const s = input.trim().toLowerCase()
  if (!s) return null

  // h:mm:ss or m:ss
  const colonMatch = s.match(/^(\d+):(\d{1,2})(?::(\d{2}))?$/)
  if (colonMatch) {
    const a = parseInt(colonMatch[1])
    const b = parseInt(colonMatch[2])
    const c = colonMatch[3] !== undefined ? parseInt(colonMatch[3]) : null
    if (c !== null) return a * 3600 + b * 60 + c // h:mm:ss
    return a * 60 + b // m:ss
  }

  // Natural language / mixed
  let total = 0
  const hourMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)(?!\w)/)
  const minMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)(?!\w)/)
  const secMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)(?!\w)/)

  if (hourMatch) total += parseFloat(hourMatch[1]) * 3600
  if (minMatch) total += parseFloat(minMatch[1]) * 60
  if (secMatch) total += parseFloat(secMatch[1])

  if (total > 0) return Math.round(total)

  // Plain number — assume minutes
  const plain = s.match(/^(\d+(?:\.\d+)?)$/)
  if (plain) return Math.round(parseFloat(plain[1]) * 60)

  return null
}

/**
 * Format seconds to display string: "1:23:45" or "45:30"
 */
export function formatDurationDisplay(seconds) {
  if (!seconds || seconds <= 0) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}
