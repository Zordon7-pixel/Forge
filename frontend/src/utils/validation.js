export function isPositiveNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0
}

export function scrollToFirstError(refMap, keys) {
  const targetKey = keys.find((key) => refMap[key]?.current)
  if (targetKey) {
    refMap[targetKey].current.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }
}

export function validateWorkoutSet({ reps, weight }) {
  const errors = {}
  if (!isPositiveNumber(reps)) errors.reps = 'Reps must be a positive number.'
  if (!isPositiveNumber(weight)) errors.weight = 'Weight must be a positive number.'
  return { errors }
}

export function getWeightDropWarning({ exerciseName, nextWeight, recentLifts }) {
  if (!exerciseName || !isPositiveNumber(nextWeight) || !Array.isArray(recentLifts)) return ''
  const latestForExercise = recentLifts.find((lift) => {
    return String(lift.exercise_name || '').trim().toLowerCase() === String(exerciseName).trim().toLowerCase() && isPositiveNumber(lift.weight_lbs)
  })
  if (!latestForExercise) return ''

  const previous = Number(latestForExercise.weight_lbs)
  const current = Number(nextWeight)
  if (current < previous * 0.7) {
    return `Weight is ${Math.round(((previous - current) / previous) * 100)}% below your previous ${previous} lbs for this exercise.`
  }
  return ''
}

export function validateRunLog({ distance, durationSeconds, distanceMiles }) {
  const errors = {}
  const warnings = {}

  if (!isPositiveNumber(distance)) errors.distance = 'Distance must be greater than 0.'
  if (!isPositiveNumber(durationSeconds)) errors.duration = 'Duration must be greater than 0.'

  if (!errors.distance && !errors.duration && isPositiveNumber(distanceMiles)) {
    const paceMinPerMile = Number(durationSeconds) / 60 / Number(distanceMiles)
    if (paceMinPerMile < 4 || paceMinPerMile > 20) {
      warnings.pace = `Pace is ${paceMinPerMile.toFixed(2)} min/mi, which is outside the usual 4:00-20:00 range.`
    }
  }

  return { errors, warnings }
}

export function validateInjuryLog({ bodyPart, severity }) {
  const errors = {}
  if (!String(bodyPart || '').trim()) errors.body_part = 'Select a body part.'
  if (!Number.isFinite(Number(severity)) || Number(severity) < 1) errors.pain_level = 'Select a severity level.'
  return { errors }
}

export function getRecurringInjuryWarning({ bodyPart, injuries }) {
  if (!String(bodyPart || '').trim() || !Array.isArray(injuries)) return ''
  const now = new Date()
  const windowStart = new Date(now)
  windowStart.setDate(now.getDate() - 30)

  const count = injuries.filter((injury) => {
    if (String(injury.body_part || '').trim().toLowerCase() !== String(bodyPart).trim().toLowerCase()) return false
    const when = new Date(`${injury.date || injury.created_at || ''}`)
    return Number.isFinite(when.getTime()) && when >= windowStart
  }).length

  if (count >= 3) {
    return `You've logged this injury ${count} times in the last 30 days.`
  }
  return ''
}

export function validateCheckIn({ feeling }) {
  const errors = {}
  if (!feeling) errors.feeling = 'Select at least one feeling before continuing.'
  return { errors }
}

export function validateGoalSetting({ name, targetValue, targetDate }) {
  const errors = {}
  if (!String(name || '').trim()) errors.name = 'Goal name is required.'
  if (!isPositiveNumber(targetValue)) errors.target_value = 'Target value must be greater than 0.'

  if (!targetDate) {
    errors.target_date = 'Target date is required.'
  } else {
    const selectedDate = new Date(`${targetDate}T00:00:00`)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    if (!Number.isFinite(selectedDate.getTime()) || selectedDate <= today) {
      errors.target_date = 'Target date must be in the future.'
    }
  }

  return { errors }
}
