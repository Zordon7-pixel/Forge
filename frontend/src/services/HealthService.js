const IOS_UA_REGEX = /iP(ad|hone|od)/i

function isIOSDevice() {
  return typeof navigator !== 'undefined' && IOS_UA_REGEX.test(navigator.userAgent || '')
}

function startOfDay(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

function toIso(date) {
  return new Date(date).toISOString()
}

function toNumber(value) {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

function average(list) {
  if (!Array.isArray(list) || list.length === 0) return null
  const total = list.reduce((sum, item) => sum + toNumber(item?.value), 0)
  return total / list.length
}

class HealthService {
  constructor() {
    this.healthKit = null
  }

  async loadHealthKit() {
    if (this.healthKit) return this.healthKit

    try {
      const mod = await import('react-native-health')
      this.healthKit = mod?.default || mod
      return this.healthKit
    } catch {
      return null
    }
  }

  getPermissionConfig(healthKit) {
    const constants = healthKit?.Constants?.Permissions || {}
    return {
      permissions: {
        read: [
          constants.StepCount || 'StepCount',
          constants.ActiveEnergyBurned || 'ActiveEnergyBurned',
          constants.HeartRate || 'HeartRate',
          constants.DistanceWalkingRunning || 'DistanceWalkingRunning',
          constants.Workout || 'Workout',
        ],
        write: [],
      },
    }
  }

  async initialize() {
    if (!isIOSDevice()) {
      return { available: false, reason: 'Apple Health is only available on iOS devices.' }
    }

    const healthKit = await this.loadHealthKit()
    if (!healthKit) {
      return { available: false, reason: 'react-native-health is not installed.' }
    }

    return new Promise((resolve) => {
      healthKit.initHealthKit(this.getPermissionConfig(healthKit), (error) => {
        if (error) {
          resolve({ available: false, reason: error?.message || 'Failed to initialize HealthKit.' })
          return
        }
        resolve({ available: true })
      })
    })
  }

  async getSamples(options) {
    const healthKit = await this.loadHealthKit()
    if (!healthKit || typeof healthKit.getSamples !== 'function') return []

    return new Promise((resolve) => {
      healthKit.getSamples(options, (error, results) => {
        if (error) {
          resolve([])
          return
        }
        resolve(Array.isArray(results) ? results : [])
      })
    })
  }

  async getWorkouts(options) {
    const healthKit = await this.loadHealthKit()
    if (!healthKit) return []

    if (typeof healthKit.getAnchoredWorkouts === 'function') {
      return new Promise((resolve) => {
        healthKit.getAnchoredWorkouts(options, (error, results) => {
          if (error) {
            resolve([])
            return
          }
          resolve(Array.isArray(results) ? results : results?.data || [])
        })
      })
    }

    return this.getSamples({ ...options, type: 'Workout' })
  }

  async getHealthSummary() {
    const init = await this.initialize()
    if (!init.available) {
      return {
        available: false,
        reason: init.reason,
        metrics: null,
      }
    }

    const now = new Date()
    const todayStart = startOfDay(now)
    const weekStart = new Date(todayStart)
    weekStart.setDate(weekStart.getDate() - 6)

    const [distanceSamples, calorieSamples, stepSamples, workouts] = await Promise.all([
      this.getSamples({
        startDate: toIso(weekStart),
        endDate: toIso(now),
        type: 'DistanceWalkingRunning',
        unit: 'mile',
      }),
      this.getSamples({
        startDate: toIso(todayStart),
        endDate: toIso(now),
        type: 'ActiveEnergyBurned',
        unit: 'kcal',
      }),
      this.getSamples({
        startDate: toIso(todayStart),
        endDate: toIso(now),
        type: 'StepCount',
        unit: 'count',
      }),
      this.getWorkouts({
        startDate: toIso(weekStart),
        endDate: toIso(now),
      }),
    ])

    const totalMilesThisWeek = distanceSamples.reduce((sum, sample) => sum + toNumber(sample?.value), 0)
    const caloriesBurnedToday = calorieSamples.reduce((sum, sample) => sum + toNumber(sample?.value), 0)
    const stepsToday = stepSamples.reduce((sum, sample) => sum + toNumber(sample?.value), 0)

    const runWorkout = [...workouts]
      .sort((a, b) => new Date(b?.startDate || b?.start).getTime() - new Date(a?.startDate || a?.start).getTime())
      .find((w) => {
        const type = String(w?.workoutActivityType || w?.activityName || w?.activityType || w?.type || '').toLowerCase()
        return type.includes('run')
      })

    let avgHeartRateFromLastRun = null
    if (runWorkout?.startDate || runWorkout?.start) {
      const runStart = runWorkout.startDate || runWorkout.start
      const runEnd = runWorkout.endDate || runWorkout.end || now.toISOString()
      const heartRateSamples = await this.getSamples({
        startDate: runStart,
        endDate: runEnd,
        type: 'HeartRate',
        unit: 'bpm',
      })
      avgHeartRateFromLastRun = average(heartRateSamples)
    }

    return {
      available: true,
      reason: null,
      metrics: {
        totalMilesThisWeek: Number(totalMilesThisWeek.toFixed(2)),
        avgHeartRateFromLastRun: avgHeartRateFromLastRun ? Math.round(avgHeartRateFromLastRun) : null,
        caloriesBurnedToday: Math.round(caloriesBurnedToday),
        stepsToday: Math.round(stepsToday),
      },
    }
  }
}

export default new HealthService()
