import WatchWorkoutService from './WatchWorkoutService'
import { encodeWorkoutFit } from './fit/encodeWorkoutFit'

const FIT_MIME_TYPE = 'application/vnd.ant.fit'
const FIT_HELP_TEXT = {
  garmin: 'Export a structured .FIT file for manual transfer to a compatible Garmin device. Automatic Garmin Connect delivery requires Training API approval.',
  coros: 'Export a structured .FIT file for a compatible manual transfer workflow. Automatic COROS delivery requires partner API approval.',
  suunto: 'Export a structured .FIT file for a compatible manual transfer workflow. Automatic Suunto delivery requires partner API approval.',
  wahoo: 'Export a structured .FIT file for a compatible manual transfer workflow. Automatic Wahoo delivery requires partner API approval.',
  polar: 'Export a structured .FIT file for a compatible manual transfer workflow. Automatic Polar delivery requires a validated provider integration.',
}

export const WATCH_PROVIDERS = [
  {
    id: 'apple-watch',
    name: 'Apple Watch',
    status: 'available',
    delivery: 'Direct from iPhone app',
    notes: 'Uses Apple WorkoutKit when the TestFlight build, iPhone, and watch support it.',
  },
  {
    id: 'garmin',
    name: 'Garmin',
    status: 'partner_required',
    delivery: 'Garmin Training/Courses API',
    fitExport: true,
    help: FIT_HELP_TEXT.garmin,
    notes: 'Adapter is planned; official Garmin API approval is required before Forged Hybrid can push workouts.',
  },
  {
    id: 'coros',
    name: 'COROS',
    status: 'partner_required',
    delivery: 'COROS partner API',
    fitExport: true,
    help: FIT_HELP_TEXT.coros,
    notes: 'Adapter is planned; COROS API application approval is required before Forged Hybrid can push workouts.',
  },
  {
    id: 'trainingpeaks',
    name: 'TrainingPeaks',
    status: 'partner_required',
    delivery: 'Bridge to Garmin, COROS, Polar, Suunto, Wahoo',
    notes: 'Best broad-watch bridge candidate once API access is approved.',
  },
  {
    id: 'polar',
    name: 'Polar',
    status: 'planned',
    delivery: 'Polar Flow / structured workout path',
    fitExport: true,
    help: FIT_HELP_TEXT.polar,
    notes: 'Data API is available; workout push path still needs provider validation.',
  },
  {
    id: 'suunto',
    name: 'Suunto',
    status: 'partner_required',
    delivery: 'Suunto Cloud API',
    fitExport: true,
    help: FIT_HELP_TEXT.suunto,
    notes: 'Partner approval is required before direct workout delivery can ship.',
  },
  {
    id: 'wahoo',
    name: 'Wahoo',
    status: 'partner_required',
    delivery: 'Wahoo Cloud API',
    fitExport: true,
    help: FIT_HELP_TEXT.wahoo,
    notes: 'Partner approval is required before direct workout delivery can ship.',
  },
]

function paceToSeconds(value = '') {
  const match = String(value).match(/([0-9]+):([0-9]{2})/)
  if (!match) return null
  return (Number(match[1]) * 60) + Number(match[2])
}

function milesFromLabel(value = '') {
  const match = String(value).match(/([0-9]+(?:\.[0-9]+)?)/)
  return match ? Number(match[1]) : 0
}

function workoutTitle(value, fallback) {
  const title = String(value || fallback).replace(/_+/g, ' ').replace(/\s+/g, ' ').trim()
  return title ? `${title.charAt(0).toUpperCase()}${title.slice(1)}` : fallback
}

function textStep(label, durationSeconds = null) {
  if (label && typeof label === 'object') {
    return {
      ...label,
      type: label.type || 'instruction',
      label: String(label.label || label.name || '').trim(),
    }
  }
  return {
    type: 'instruction',
    label: String(label || '').trim(),
    durationSeconds,
  }
}

export function normalizeRunWorkout(workout = {}) {
  const miles = milesFromLabel(workout.display?.distance || workout.distanceLabel)
  const title = workoutTitle(workout.title || workout.typeLabel, 'Forged Hybrid Run')
  const paceSeconds = workout.targetPaceSecondsPerMile
    || workout.targets?.paceSecondsPerMile
    || paceToSeconds(workout.display?.pace || workout.pace)
  const goal = workout.goal || (miles > 0
    ? { type: 'distance', value: miles, unit: 'mile' }
    : { type: 'open' })

  return {
    schemaVersion: 1,
    source: 'forge',
    kind: 'run',
    title,
    scheduledAt: workout.scheduledAt || new Date().toISOString(),
    activity: workout.activity || 'running',
    location: workout.location || 'outdoor',
    goal,
    targets: {
      paceSecondsPerMile: paceSeconds || null,
      heartRateZone: workout.heartRateZone || workout.targets?.heartRateZone || null,
      effort: workout.effort || null,
    },
    steps: Array.isArray(workout.steps) && workout.steps.length ? workout.steps.map((step) => textStep(step)) : [
      textStep('Warm up easy', 300),
      {
        type: goal.type === 'distance' ? 'distance' : goal.type === 'time' ? 'time' : 'open',
        label: title,
        distanceMiles: goal.type === 'distance' ? Number(goal.value || miles || 0) : null,
        durationSeconds: goal.type === 'time' ? Number(goal.value || 0) * 60 : null,
        targetPaceSecondsPerMile: paceSeconds || null,
      },
      textStep('Cool down easy', 300),
    ],
    notes: workout.notes || workout.description || '',
    fallbackText: WatchWorkoutService.formatWorkoutText(workout),
  }
}

export function normalizeStrengthWorkout(workout = {}) {
  const steps = Array.isArray(workout.steps) ? workout.steps : []
  return {
    schemaVersion: 1,
    source: 'forge',
    kind: 'strength',
    title: workoutTitle(workout.title, 'Forged Hybrid Strength'),
    scheduledAt: workout.scheduledAt || new Date().toISOString(),
    activity: workout.activity || 'functionalStrengthTraining',
    location: workout.location || 'indoor',
    goal: workout.goal || { type: 'open' },
    targets: {
      paceSecondsPerMile: null,
      heartRateZone: workout.heartRateZone || null,
      effort: workout.effort || null,
    },
    warmup: workout.warmup || [],
    steps: steps.map((step) => ({
      type: 'exercise',
      name: step.name || 'Exercise',
      sets: Number(step.sets || 0),
      reps: String(step.reps || ''),
      rest: String(step.rest || ''),
    })),
    recovery: workout.recovery || [],
    notes: workout.notes || '',
    fallbackText: WatchWorkoutService.formatWorkoutText(workout),
  }
}

function isNormalizedWorkout(workout = {}) {
  return workout.schemaVersion === 1
    && workout.source === 'forge'
    && (workout.kind === 'run' || workout.kind === 'strength')
    && Array.isArray(workout.steps)
}

function fitDateStamp(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

function fitFileName(workout = {}) {
  const kind = workout.kind === 'strength' ? 'strength' : 'run'
  return `forge-${kind}-${fitDateStamp()}.fit`
}

function triggerDownload(file) {
  const url = URL.createObjectURL(file)
  const link = document.createElement('a')
  link.href = url
  link.download = file.name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function exportWorkoutFitFile(normalizedWorkout = {}) {
  try {
    const bytes = encodeWorkoutFit(normalizedWorkout)
    const filename = fitFileName(normalizedWorkout)
    const file = new File([bytes], filename, { type: FIT_MIME_TYPE })

    if (typeof navigator !== 'undefined' && navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: normalizedWorkout.title || 'Forge Workout' })
      return { filename, shared: true }
    }

    triggerDownload(file)
    return { filename, downloaded: true }
  } catch (error) {
    if (error?.name === 'AbortError') return { cancelled: true }
    console.error('[watch-fit-export] export failed:', error?.message || error)
    throw error
  }
}

class WatchDeliveryService {
  getProviders() {
    return WATCH_PROVIDERS
  }

  buildStructuredWorkout(workout = {}) {
    if (isNormalizedWorkout(workout)) return workout
    if (workout.kind === 'strength') return normalizeStrengthWorkout(workout)
    return normalizeRunWorkout(workout)
  }

  async getAvailability() {
    const apple = await WatchWorkoutService.getAvailability()
    return {
      primaryProvider: 'apple-watch',
      canAutoSend: Boolean(apple?.available),
      reason: apple?.reason || 'Connect a supported watch provider to send workouts automatically.',
      providers: WATCH_PROVIDERS,
    }
  }

  async send(workout) {
    const structured = this.buildStructuredWorkout(workout)
    if (structured.kind === 'strength' || structured.kind === 'run') {
      return WatchWorkoutService.sendToAppleWatch(workout)
    }
    throw new Error('This workout type is not ready for watch delivery yet.')
  }

  async exportWorkoutFitFile(normalizedWorkout) {
    return exportWorkoutFitFile(normalizedWorkout)
  }

  formatFallbackText(workout = {}) {
    const structured = this.buildStructuredWorkout(workout)
    if (structured.kind === 'run') {
      return [
        `${structured.title}`,
        `Goal: ${structured.goal?.type === 'distance'
          ? `${structured.goal.value} ${structured.goal.unit || 'mile'}`
          : structured.goal?.type === 'time'
            ? `${structured.goal.value} ${structured.goal.unit || 'minute'}${Number(structured.goal.value) === 1 ? '' : 's'}`
            : 'Open run'}`,
        structured.targets?.paceSecondsPerMile ? `Target pace: ${Math.floor(structured.targets.paceSecondsPerMile / 60)}:${String(structured.targets.paceSecondsPerMile % 60).padStart(2, '0')} / mi` : '',
        structured.targets?.heartRateZone ? `Target zone: ${structured.targets.heartRateZone}` : '',
        structured.targets?.effort ? `Focus: ${structured.targets.effort}` : '',
        structured.steps?.length ? `Structure: ${structured.steps.map((step) => step.label).filter(Boolean).join(' / ')}` : '',
        structured.notes ? `Notes: ${structured.notes}` : '',
      ].filter(Boolean).join('\n')
    }
    return structured.fallbackText
  }
}

export default new WatchDeliveryService()
