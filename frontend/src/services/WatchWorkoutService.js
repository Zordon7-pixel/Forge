import { Capacitor, registerPlugin } from '@capacitor/core'

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

function parsePaceSecondsPerMile(pace = '') {
  const match = String(pace).match(/([0-9]+):([0-9]{2})/)
  if (!match) return null
  return (Number(match[1]) * 60) + Number(match[2])
}

function cleanTitle(value, fallback) {
  return String(value || fallback).replace(/_/g, ' ').trim() || fallback
}

function unavailableReason(error) {
  const message = String(error?.message || error || '')
  if (/not implemented|unimplemented|plugin|no web implementation/i.test(message)) {
    return 'Update TestFlight to a build that includes Forge Apple Watch workout sending.'
  }
  return message || 'Apple Watch workout sending is unavailable on this build.'
}

class WatchWorkoutService {
  buildRunWorkout(workout = {}) {
    const miles = parseMiles(workout.distanceLabel)
    const paceSeconds = parsePaceSecondsPerMile(workout.pace)
    return {
      source: 'forge',
      kind: 'run',
      activity: 'running',
      location: 'outdoor',
      title: cleanTitle(workout.typeLabel, 'Forge Run'),
      notes: workout.description || '',
      scheduledAt: new Date().toISOString(),
      goal: miles > 0
        ? { type: 'distance', value: miles, unit: 'mile' }
        : { type: 'open' },
      targetPaceSecondsPerMile: paceSeconds,
      display: {
        day: workout.day || 'Today',
        distance: workout.distanceLabel || 'Open distance',
        pace: workout.pace || '',
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
      `${workout.display?.day || 'Today'}: ${workout.title || 'Forge Run'}`,
      `Distance: ${workout.display?.distance || 'Open distance'}`,
      workout.display?.pace ? `Pace: ${workout.display.pace}` : '',
      workout.notes ? `Notes: ${workout.notes}` : '',
    ].filter(Boolean).join('\n')
  }

  async sendToAppleWatch(workout) {
    if (!isNativeRuntime()) {
      throw new Error('Apple Watch workout sending only works in the Forge iPhone app.')
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
      throw new Error(unavailableReason(error))
    }
  }
}

export default new WatchWorkoutService()
