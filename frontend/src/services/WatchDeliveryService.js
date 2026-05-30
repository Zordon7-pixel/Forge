import WatchWorkoutService from './WatchWorkoutService'

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
    notes: 'Adapter is planned; official Garmin API approval is required before Forge can push workouts.',
  },
  {
    id: 'coros',
    name: 'COROS',
    status: 'partner_required',
    delivery: 'COROS partner API',
    notes: 'Adapter is planned; COROS API application approval is required before Forge can push workouts.',
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
    notes: 'Data API is available; workout push path still needs provider validation.',
  },
  {
    id: 'suunto',
    name: 'Suunto',
    status: 'partner_required',
    delivery: 'Suunto Cloud API',
    notes: 'Partner approval is required before direct workout delivery can ship.',
  },
  {
    id: 'wahoo',
    name: 'Wahoo',
    status: 'partner_required',
    delivery: 'Wahoo Cloud API',
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

function textStep(label, durationSeconds = null) {
  return {
    type: 'instruction',
    label: String(label || '').trim(),
    durationSeconds,
  }
}

function normalizeRunWorkout(workout = {}) {
  const miles = milesFromLabel(workout.display?.distance || workout.distanceLabel)
  const paceSeconds = workout.targetPaceSecondsPerMile || paceToSeconds(workout.display?.pace || workout.pace)
  const goal = workout.goal || (miles > 0
    ? { type: 'distance', value: miles, unit: 'mile' }
    : { type: 'open' })

  return {
    schemaVersion: 1,
    source: 'forge',
    kind: 'run',
    title: workout.title || workout.typeLabel || 'Forge Run',
    scheduledAt: workout.scheduledAt || new Date().toISOString(),
    activity: workout.activity || 'running',
    location: workout.location || 'outdoor',
    goal,
    targets: {
      paceSecondsPerMile: paceSeconds || null,
      heartRateZone: workout.heartRateZone || null,
      effort: workout.effort || null,
    },
    steps: Array.isArray(workout.steps) && workout.steps.length ? workout.steps.map((step) => textStep(step)) : [
      textStep('Warm up easy', 300),
      {
        type: goal.type === 'distance' ? 'distance' : 'open',
        label: workout.title || workout.typeLabel || 'Main run',
        distanceMiles: goal.type === 'distance' ? Number(goal.value || miles || 0) : null,
        targetPaceSecondsPerMile: paceSeconds || null,
      },
      textStep('Cool down easy', 300),
    ],
    notes: workout.notes || workout.description || '',
    fallbackText: WatchWorkoutService.formatWorkoutText(workout),
  }
}

function normalizeStrengthWorkout(workout = {}) {
  const steps = Array.isArray(workout.steps) ? workout.steps : []
  return {
    schemaVersion: 1,
    source: 'forge',
    kind: 'strength',
    title: workout.title || 'Forge Strength',
    scheduledAt: workout.scheduledAt || new Date().toISOString(),
    activity: workout.activity || 'functionalStrengthTraining',
    location: workout.location || 'indoor',
    goal: workout.goal || { type: 'open' },
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

class WatchDeliveryService {
  getProviders() {
    return WATCH_PROVIDERS
  }

  buildStructuredWorkout(workout = {}) {
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

  formatFallbackText(workout = {}) {
    const structured = this.buildStructuredWorkout(workout)
    if (structured.kind === 'run') {
      return [
        `${structured.title}`,
        `Goal: ${structured.goal?.type === 'distance' ? `${structured.goal.value} ${structured.goal.unit || 'mile'}` : 'Open run'}`,
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
