import { Capacitor, registerPlugin } from '@capacitor/core'
import { App } from '@capacitor/app'
import { watchWorkoutUnavailableReason } from './watchWorkoutAvailability'

const ForgeWatchWorkout = registerPlugin('ForgeWatchWorkout')

function isNativeRuntime() {
  return typeof Capacitor !== 'undefined'
    && typeof Capacitor.isNativePlatform === 'function'
    && Capacitor.isNativePlatform()
}

function toNumber(value) {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

function parseMiles(label = '') {
  const match = String(label).match(/([0-9]+(?:\.[0-9]+)?)/)
  return match ? toNumber(match[1]) : 0
}

function parseMinutes(label = '') {
  const match = String(label).match(/([0-9]+(?:\.[0-9]+)?)\s*(?:min|minute)/i)
  return match ? toNumber(match[1]) : 0
}

function parsePaceSecondsPerMile(pace = '') {
  const match = String(pace).match(/([0-9]+):([0-9]{2})/)
  if (!match) return null
  return (Number(match[1]) * 60) + Number(match[2])
}

function cleanTitle(value, fallback) {
  return String(value || fallback).replace(/_/g, ' ').trim() || fallback
}

const METERS_PER_MILE = 1609.344
const APPLE_STRUCTURED_TYPES = new Set(['warmup', 'run', 'interval', 'recovery', 'transition', 'cooldown'])
const APPLE_MANUAL_TYPES = new Set(['station', 'strength_exercise', 'mobility', 'manual_instruction'])

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

function canonicalLeafSteps(steps = [], output = [], parentStepId = null) {
  for (const step of Array.isArray(steps) ? steps : []) {
    if (step?.type === 'repeat') {
      output.push({ ...clone(step), children: undefined, parent_step_id: parentStepId })
      canonicalLeafSteps(step.children, output, step.step_id)
    } else {
      output.push({ ...clone(step), parent_step_id: parentStepId })
    }
  }
  return output
}

function targetRange(value) {
  if (Array.isArray(value) && value.length === 2) {
    return { minimum: Number(value[0]), maximum: Number(value[1]) }
  }
  if (objectValue(value)) return { minimum: Number(value.minimum), maximum: Number(value.maximum) }
  return null
}

function appleGoalForTarget(target = {}) {
  const fields = Object.keys(objectValue(target) || {}).filter((field) => target[field] !== null && target[field] !== undefined)
  const pace = targetRange(target.pace_range_s_per_km)
  const exactPace = pace && Number.isFinite(pace.minimum) && pace.minimum > 0 && pace.minimum === pace.maximum
  const allowed = new Set(['distance_m', 'duration_s', ...(exactPace ? ['pace_range_s_per_km'] : [])])
  const exact = fields.every((field) => allowed.has(field))
    && !(Number(target.distance_m) > 0 && Number(target.duration_s) > 0)
  if (Number(target.distance_m) > 0) {
    return {
      exact,
      goal: { type: 'distance', value: Number(target.distance_m) / METERS_PER_MILE, unit: 'mile' },
      targetPaceSecondsPerMile: exactPace ? pace.minimum * (METERS_PER_MILE / 1000) : null,
    }
  }
  if (Number(target.duration_s) > 0) {
    return {
      exact,
      goal: { type: 'time', value: Number(target.duration_s) / 60, unit: 'minute' },
      targetPaceSecondsPerMile: null,
    }
  }
  return {
    exact: fields.length === 0,
    goal: { type: 'open' },
    targetPaceSecondsPerMile: null,
  }
}

function appleComponentCapability(step = {}) {
  if (APPLE_MANUAL_TYPES.has(step.type) || step.type === 'repeat') return 'MANUAL_COMPONENTS_REQUIRED'
  if (!APPLE_STRUCTURED_TYPES.has(step.type)) return 'NOT_EXPORTABLE'
  const goal = appleGoalForTarget(step.target)
  return step.type === 'run' && goal.exact ? 'FULLY_STRUCTURED' : 'PARTIALLY_STRUCTURED'
}

function buildAppleCapability(workout, flatSteps, exactSingleRun) {
  if (workout.canonical_capability?.classification === 'NOT_EXPORTABLE' || !flatSteps.length) {
    return 'NOT_EXPORTABLE'
  }
  if (exactSingleRun) return 'FULLY_STRUCTURED'
  const componentClasses = flatSteps.map(appleComponentCapability)
  const hasNativeComponent = flatSteps.some((step) => (
    APPLE_STRUCTURED_TYPES.has(step.type) && appleGoalForTarget(step.target).goal.type !== 'open'
  ))
  if (hasNativeComponent) return 'PARTIALLY_STRUCTURED'
  if (componentClasses.some((classification) => classification === 'PARTIALLY_STRUCTURED')) {
    return 'PARTIALLY_STRUCTURED'
  }
  if (componentClasses.some((classification) => classification === 'MANUAL_COMPONENTS_REQUIRED')) {
    return 'MANUAL_COMPONENTS_REQUIRED'
  }
  return 'NOT_EXPORTABLE'
}

async function appInfo() {
  try {
    return await App.getInfo()
  } catch (error) {
    console.error('[watch-workout] app build lookup failed:', error?.message || error)
    return null
  }
}

class WatchWorkoutService {
  isNativeRuntime() {
    return isNativeRuntime()
  }

  async getAvailability() {
    if (!isNativeRuntime()) {
      return {
        available: false,
        reason: 'Automatic Apple Watch delivery only works in the Forged Hybrid iPhone app.',
      }
    }

    try {
      const status = await ForgeWatchWorkout.isAvailable()
      return {
        available: Boolean(status?.available),
        reason: status?.reason || '',
      }
    } catch (error) {
      return {
        available: false,
        reason: watchWorkoutUnavailableReason(error, await appInfo()),
      }
    }
  }

  buildRunWorkout(workout = {}) {
    const miles = parseMiles(workout.distanceLabel)
    const durationMinutes = toNumber(workout.durationMinutes) || parseMinutes(workout.durationLabel)
    const timePrimary = String(workout.prescriptionBasis || '').toLowerCase() === 'time' && durationMinutes > 0
    const paceSeconds = parsePaceSecondsPerMile(workout.pace)
    return {
      source: 'forge',
      kind: 'run',
      activity: 'running',
      location: 'outdoor',
      title: cleanTitle(workout.typeLabel, 'Forged Hybrid Run'),
      notes: [workout.progression, workout.description].filter(Boolean).join(' '),
      scheduledAt: new Date().toISOString(),
      goal: timePrimary
        ? { type: 'time', value: durationMinutes, unit: 'minute' }
        : miles > 0
        ? { type: 'distance', value: miles, unit: 'mile' }
        : { type: 'open' },
      targetPaceSecondsPerMile: paceSeconds,
      heartRateZone: workout.zone || workout.targetZone || null,
      effort: workout.intensity || null,
      steps: Array.isArray(workout.steps) ? workout.steps : [],
      display: {
        day: workout.day || 'Today',
        distance: workout.distanceLabel || 'Open distance',
        duration: durationMinutes > 0 ? `${Math.round(durationMinutes)} min` : '',
        pace: workout.pace || '',
        zone: workout.zone || '',
        focus: workout.intensity || '',
      },
    }
  }

  buildStrengthWorkout(recommendation = {}) {
    const main = Array.isArray(recommendation.main) ? recommendation.main : []
    return {
      source: 'forge',
      kind: 'strength',
      activity: 'functionalStrengthTraining',
      location: 'indoor',
      title: cleanTitle(recommendation.workoutName || recommendation.target, 'Forge Strength'),
      notes: recommendation.explanation || '',
      scheduledAt: new Date().toISOString(),
      goal: { type: 'open' },
      steps: main.map((item) => ({
        name: cleanTitle(item?.name, 'Exercise'),
        sets: toNumber(item?.sets),
        reps: String(item?.reps || ''),
        rest: String(item?.rest || ''),
      })),
      warmup: Array.isArray(recommendation.warmup) ? recommendation.warmup : [],
      recovery: Array.isArray(recommendation.recovery) ? recommendation.recovery : [],
    }
  }

  buildCanonicalWorkoutPayload(workout = {}) {
    if (!workout?.canonical || workout?.accepted_manifest !== true || !objectValue(workout.identity)) {
      const error = new Error('Apple Watch canonical delivery requires an accepted canonical workout representation.')
      error.code = 'CANONICAL_MANIFEST_NOT_ACCEPTED'
      throw error
    }

    const flatSteps = canonicalLeafSteps(workout.steps)
    const singleStep = flatSteps.length === 1 ? flatSteps[0] : null
    const singleGoal = singleStep ? appleGoalForTarget(singleStep.target) : null
    const exactSingleRun = Boolean(singleStep?.type === 'run' && singleGoal?.exact)
    const classification = buildAppleCapability(workout, flatSteps, exactSingleRun)
    const representableLeaves = flatSteps.filter((step) => step.type !== 'repeat' && APPLE_STRUCTURED_TYPES.has(step.type))
    const selectedGoal = exactSingleRun
      ? singleGoal
      : representableLeaves.length === 1
        ? appleGoalForTarget(representableLeaves[0].target)
        : { goal: { type: 'open' }, targetPaceSecondsPerMile: null }
    const manualComponents = exactSingleRun ? [] : flatSteps.filter((step) => {
      if (step.type === 'repeat' || APPLE_MANUAL_TYPES.has(step.type)) return true
      if (!APPLE_STRUCTURED_TYPES.has(step.type)) return true
      if (representableLeaves.length !== 1) return true
      return step.type !== 'run' || !appleGoalForTarget(step.target).exact
    }).map((step) => ({
      step_id: step.step_id,
      type: step.type,
      order: step.order,
      ...(step.repeat_count ? { repeat_count: Number(step.repeat_count) } : {}),
      target: clone(step.target || {}),
      classification: appleComponentCapability(step),
    }))

    const hasRun = flatSteps.some((step) => ['run', 'interval', 'warmup', 'recovery', 'cooldown'].includes(step.type))
    const payloadKind = hasRun ? 'run' : workout.kind === 'strength' ? 'strength' : 'run'
    return {
      schemaVersion: 2,
      source: 'forge',
      canonical: true,
      kind: payloadKind,
      activity: hasRun ? 'running' : workout.activity,
      location: hasRun ? 'outdoor' : workout.location,
      title: workout.title,
      scheduledAt: workout.scheduledAt,
      goal: selectedGoal.goal,
      targetPaceSecondsPerMile: selectedGoal.targetPaceSecondsPerMile,
      identity: clone(workout.identity),
      session_id: workout.identity.session_id,
      session_revision: workout.identity.session_revision,
      plan_id: workout.identity.plan_id,
      plan_revision: workout.identity.plan_revision,
      surface_revision: workout.identity.surface_revision,
      export_revision: workout.identity.export_revision,
      content_hash: workout.identity.content_hash,
      role: workout.role,
      safety: clone(workout.safety),
      executability: workout.executability,
      canonical_steps: clone(workout.steps),
      step_capabilities: flatSteps.map((step) => ({
        step_id: step.step_id,
        type: step.type,
        classification: exactSingleRun ? 'FULLY_STRUCTURED' : appleComponentCapability(step),
      })),
      target_provenance: clone(workout.target_provenance),
      capability: {
        classification,
        manual_step_ids: manualComponents.map((component) => component.step_id),
        unsupported_step_ids: flatSteps.filter((step) => appleComponentCapability(step) === 'NOT_EXPORTABLE').map((step) => step.step_id),
      },
      manual_components: manualComponents,
      notes: workout.notes || '',
    }
  }

  formatWorkoutText(workout = {}) {
    if (workout.kind === 'strength') {
      const lines = [
        workout.title,
        ...(workout.warmup?.length ? [`Warmup: ${workout.warmup.join(', ')}`] : []),
        ...(workout.steps || []).map((step) => `${step.name} ${step.sets || ''}x${step.reps || ''}${step.rest ? ` (${step.rest})` : ''}`.trim()),
        ...(workout.recovery?.length ? [`Recovery: ${workout.recovery.join(', ')}`] : []),
      ]
      return lines.filter(Boolean).join('\n')
    }

    return [
      `${workout.display?.day || 'Today'}: ${workout.title || 'Forged Hybrid Run'}`,
      workout.goal?.type === 'time' ? `Duration: ${workout.display?.duration || `${workout.goal.value} min`}` : '',
      workout.goal?.type === 'distance' ? `Distance: ${workout.display?.distance || `${workout.goal.value} mi`}` : '',
      workout.goal?.type === 'time' && workout.display?.distance ? `Estimated distance: ${workout.display.distance}` : '',
      workout.goal?.type === 'open' ? 'Goal: Open run' : '',
      workout.display?.pace ? `Pace: ${workout.display.pace}` : '',
      workout.display?.zone ? `Zone: ${workout.display.zone}` : '',
      workout.display?.focus ? `Focus: ${workout.display.focus}` : '',
      workout.notes ? `Notes: ${workout.notes}` : '',
      ...(workout.steps?.length ? [`Structure: ${workout.steps.join(' / ')}`] : []),
    ].filter(Boolean).join('\n')
  }

  async sendToAppleWatch(workout) {
    if (!isNativeRuntime()) {
      throw new Error('Automatic Apple Watch delivery only works in the Forged Hybrid iPhone app.')
    }

    try {
      const status = await ForgeWatchWorkout.isAvailable()
      if (!status?.available) {
        throw new Error(status?.reason || 'Apple Watch workout sending is not available on this iPhone.')
      }
      const auth = await ForgeWatchWorkout.requestAuthorization()
      if (auth?.authorized === false) {
        throw new Error('Apple Watch workout permission was not granted.')
      }
      return ForgeWatchWorkout.scheduleWorkout({ workout })
    } catch (error) {
      throw new Error(watchWorkoutUnavailableReason(error, await appInfo()))
    }
  }
}

export default new WatchWorkoutService()
