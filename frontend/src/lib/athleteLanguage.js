const PACE_ZONES = [
  { zone: 1, label: 'Easy', description: 'Conversational pace - builds aerobic base', color: '#4CAF50' },
  { zone: 2, label: 'Moderate', description: 'Steady aerobic work - improves endurance efficiency', color: '#8BC34A' },
  { zone: 3, label: 'Tempo', description: 'Comfortably hard - strengthens sustained speed', color: '#FFC107' },
  { zone: 4, label: 'Threshold', description: 'Controlled discomfort - raises lactate threshold', color: '#FF9800' },
  { zone: 5, label: 'Race Pace', description: 'High intensity effort - race-specific speed', color: '#F44336' },
]

const RPE_LABELS = {
  1: 'Very easy - recovery effort',
  2: 'Easy - relaxed movement',
  3: 'Light - smooth and controlled',
  4: 'Moderate - working but comfortable',
  5: 'Moderate+ - focused effort',
  6: 'Challenging - breathing harder',
  7: 'Hard - steady discomfort',
  8: 'Very hard - near limit',
  9: 'Extremely hard - maximal control',
  10: 'All-out - max effort',
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0))
}

function round(value) {
  return Math.round(Number(value) || 0)
}

export function getPaceZone(paceMinPerMile) {
  const pace = Number(paceMinPerMile)
  if (!pace || pace <= 0) return null

  if (pace > 10.5) return PACE_ZONES[0]
  if (pace >= 9 && pace <= 10.5) return PACE_ZONES[1]
  if (pace >= 7.5 && pace < 9) return PACE_ZONES[2]
  if (pace >= 6.5 && pace < 7.5) return PACE_ZONES[3]
  return PACE_ZONES[4]
}

export function getEffortLabel(rpe) {
  const level = clampNumber(rpe, 1, 10)
  return RPE_LABELS[level] || RPE_LABELS[5]
}

export function getVolumeLoad(sets, reps, weight) {
  const s = Math.max(0, Number(sets) || 0)
  const r = Math.max(0, Number(reps) || 0)
  const w = Math.max(0, Number(weight) || 0)
  const totalLbs = round(s * r * w)
  const totalKg = round(totalLbs * 0.45359237)

  let label = 'Light'
  if (totalLbs >= 20000) label = 'Max Effort'
  else if (totalLbs >= 12000) label = 'Heavy'
  else if (totalLbs >= 5000) label = 'Moderate'

  return {
    totalLbs,
    totalKg,
    label,
    display: `${totalLbs.toLocaleString()} lbs (${totalKg.toLocaleString()} kg)`,
  }
}

function sessionVolume(session = {}) {
  if (session.totalVolume != null) return Math.max(0, Number(session.totalVolume) || 0)
  if (session.volume != null) return Math.max(0, Number(session.volume) || 0)
  return Math.max(
    0,
    (Number(session.sets) || 0) * (Number(session.reps) || 0) * (Number(session.weight) || 0)
  )
}

export function getProgressiveOverloadTip(lastSession, currentSession) {
  if (!currentSession) return 'Log a full session to track progressive overload.'
  const current = sessionVolume(currentSession)
  const previous = sessionVolume(lastSession)

  if (current <= 0) return 'Complete a working set to start tracking overload.'
  if (previous <= 0) return 'Baseline set - try adding 5 lbs next time.'

  const deltaPct = ((current - previous) / previous) * 100
  if (deltaPct >= 3) return `${Math.round(deltaPct)}% more volume than last session ✅`
  if (deltaPct > -3) return 'Volume matched last session - add 1 rep or 5 lbs next time.'
  return 'Volume dipped from last session - try adding 5 lbs next time.'
}
