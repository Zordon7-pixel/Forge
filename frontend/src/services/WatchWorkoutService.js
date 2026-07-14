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
