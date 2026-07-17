import { Encoder, Profile } from '@garmin/fitsdk'

const METERS_PER_MILE = 1609.344
const FIT_STRING_MAX_BYTES = 254

const MESG_NUM = {
  fileId: Profile.MesgNum.FILE_ID ?? 0,
  workout: Profile.MesgNum.WORKOUT ?? 26,
  workoutStep: Profile.MesgNum.WORKOUT_STEP ?? 27,
}

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function truncateFitString(value, fallback) {
  const text = String(value || fallback || '').replace(/\s+/g, ' ').trim() || fallback
  if (typeof TextEncoder === 'undefined') return text.slice(0, FIT_STRING_MAX_BYTES)

  const encoder = new TextEncoder()
  let result = ''
  for (const char of text) {
    const candidate = `${result}${char}`
    if (encoder.encode(candidate).length > FIT_STRING_MAX_BYTES) break
    result = candidate
  }
  return result || String(fallback || '').slice(0, FIT_STRING_MAX_BYTES)
}

function stepLabel(step = {}) {
  return String(step.label || step.name || step.type || 'Workout step').trim()
}

function zoneNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const direct = Number(value)
  if (Number.isFinite(direct) && direct > 0) return Math.round(direct)

  const match = String(value).match(/(?:zone|z)?\s*([1-9][0-9]?)/i)
  return match ? Number(match[1]) : null
}

function stepHeartRateZone(step = {}, workout = {}) {
  return zoneNumber(
    step.heartRateZone
      ?? step.hrZone
      ?? step.targetHeartRateZone
      ?? step.targetHrZone
      ?? workout.targets?.heartRateZone
      ?? workout.heartRateZone,
  )
}

function stepPaceSecondsPerMile(step = {}, workout = {}) {
  return positiveNumber(
    step.targetPaceSecondsPerMile
      ?? step.paceSecondsPerMile
      ?? workout.targets?.paceSecondsPerMile
      ?? workout.targetPaceSecondsPerMile,
  )
}

function stepDuration(step = {}) {
  const distanceMiles = positiveNumber(step.distanceMiles)
  if (distanceMiles) {
    return {
      durationType: 'distance',
      durationValue: Math.round(distanceMiles * METERS_PER_MILE * 100),
      durationDistance: distanceMiles * METERS_PER_MILE,
    }
  }

  const durationSeconds = positiveNumber(step.durationSeconds)
  if (durationSeconds) {
    return {
      durationType: 'time',
      durationValue: Math.round(durationSeconds * 1000),
      durationTime: durationSeconds,
    }
  }

  return {
    durationType: 'open',
    durationValue: 0,
  }
}

function stepTarget(step = {}, workout = {}) {
  const hrZone = stepHeartRateZone(step, workout)
  if (hrZone) {
    return {
      targetType: 'heartRate',
      targetValue: hrZone,
      targetHrZone: hrZone,
      customTargetValueLow: 0,
      customTargetValueHigh: 0,
    }
  }

  const paceSeconds = stepPaceSecondsPerMile(step, workout)
  if (paceSeconds) {
    const speedMetersPerSecond = METERS_PER_MILE / paceSeconds
    const low = speedMetersPerSecond * 0.95
    const high = speedMetersPerSecond * 1.05
    return {
      targetType: 'speed',
      targetValue: 0,
      customTargetValueLow: Math.round(low * 1000),
      customTargetValueHigh: Math.round(high * 1000),
      customTargetSpeedLow: low,
      customTargetSpeedHigh: high,
    }
  }

  return {
    targetType: 'open',
    targetValue: 0,
  }
}

function stepIntensity(step = {}, workout = {}) {
  const label = stepLabel(step).toLowerCase()
  const target = stepTarget(step, workout)
  if (label.startsWith('warm')) return 'warmup'
  if (label.startsWith('cool')) return 'cooldown'
  if ((step.type === 'instruction' || step.type === 'rest') && target.targetType === 'open') return 'rest'
  return 'active'
}

function workoutStepMessage(step, index, workout) {
  const duration = stepDuration(step)
  const target = stepTarget(step, workout)
  return {
    messageIndex: index,
    wktStepName: truncateFitString(stepLabel(step), `Step ${index + 1}`),
    notes: truncateFitString(step.notes || step.description || '', ''),
    intensity: stepIntensity(step, workout),
    ...duration,
    ...target,
  }
}

export function encodeWorkoutFit(normalizedWorkout = {}) {
  const steps = Array.isArray(normalizedWorkout.steps) ? normalizedWorkout.steps : []
  const encoder = new Encoder()

  encoder.onMesg(MESG_NUM.fileId, {
    type: 'workout',
    manufacturer: 'development',
    product: 1,
    timeCreated: new Date(),
  })

  encoder.onMesg(MESG_NUM.workout, {
    wktName: truncateFitString(normalizedWorkout.title, 'Forge Workout'),
    sport: normalizedWorkout.kind === 'run' ? 'running' : 'training',
    numValidSteps: steps.length,
  })

  // Repeat/interval compression is a future enhancement; encode each provided step literally.
  steps.forEach((step, index) => {
    encoder.onMesg(MESG_NUM.workoutStep, workoutStepMessage(step, index, normalizedWorkout))
  })

  return encoder.close()
}
