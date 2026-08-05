const PAIN_LEVELS = new Set(['none', 'mild', 'moderate', 'severe'])

export function validatePostRunCheckInAnswers({ effort, pain } = {}) {
  const errors = {}
  const normalizedEffort = Number(effort)

  if (!Number.isInteger(normalizedEffort) || normalizedEffort < 1 || normalizedEffort > 10) {
    errors.effort = 'Select an effort score before saving.'
  }
  if (!PAIN_LEVELS.has(pain)) {
    errors.pain = 'Select a pain/discomfort level before saving.'
  }

  return {
    errors,
    firstInvalid: errors.effort ? 'effort' : errors.pain ? 'pain' : null,
    valid: Object.keys(errors).length === 0,
  }
}

export default validatePostRunCheckInAnswers
