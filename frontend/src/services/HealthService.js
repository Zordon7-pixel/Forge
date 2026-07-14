import { Capacitor, registerPlugin } from '@capacitor/core'
import api from '../lib/api'

const IOS_UA_REGEX = /iP(ad|hone|od)/i
const NATIVE_HEALTH_AUTH_KEY = 'forge_health_authorized'
const NATIVE_HEALTH_AUTH_VERSION_KEY = 'forge_health_authorized_version'
const REQUIRED_HEALTH_AUTH_VERSION = 2
const HEALTH_RESYNC_NEEDED_KEY = 'forge.health.resyncNeeded'
const AUTO_HEALTH_SYNC_LAST_SYNC_KEY = 'forge_auto_health_sync_last_sync_at'
const ForgeHealth = registerPlugin('ForgeHealth')

function isIOSDevice() {
  return typeof navigator !== 'undefined' && IOS_UA_REGEX.test(navigator.userAgent || '')
}

function isNativeRuntime() {
  return typeof Capacitor !== 'undefined'
    && typeof Capacitor.isNativePlatform === 'function'
    && Capacitor.isNativePlatform()
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

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function average(list) {
  if (!Array.isArray(list) || list.length === 0) return null
  const total = list.reduce((sum, item) => sum + toNumber(item?.value), 0)
  return total / list.length
}

function importNativeModule(name) {
  return new Function('name', 'return import(name)')(name)
}

function hasNativeAuthorizationHint() {
  try {
    return localStorage.getItem(NATIVE_HEALTH_AUTH_KEY) === '1'
  } catch {
    return false
  }
}

function markNativeAuthorized(version = 1) {
  try {
    localStorage.setItem(NATIVE_HEALTH_AUTH_KEY, '1')
    const currentVersion = Number(localStorage.getItem(NATIVE_HEALTH_AUTH_VERSION_KEY) || 0)
    localStorage.setItem(NATIVE_HEALTH_AUTH_VERSION_KEY, String(Math.max(currentVersion, version)))
  } catch {}
}

function hasExpandedNativeAuthorization() {
  try {
    return Number(localStorage.getItem(NATIVE_HEALTH_AUTH_VERSION_KEY) || 0) >= REQUIRED_HEALTH_AUTH_VERSION
  } catch {
    return false
  }
}

function healthResyncNeeded() {
  try {
    return localStorage.getItem(HEALTH_RESYNC_NEEDED_KEY) === '1'
  } catch {
    return false
  }
}

function markHealthResyncNeeded() {
  try {
    localStorage.setItem(HEALTH_RESYNC_NEEDED_KEY, '1')
  } catch {}
}

function clearHealthResyncNeeded() {
  try {
    localStorage.removeItem(HEALTH_RESYNC_NEEDED_KEY)
  } catch {}
}

function markAutoHealthSyncAttempted() {
  try {
    localStorage.setItem(AUTO_HEALTH_SYNC_LAST_SYNC_KEY, String(Date.now()))
  } catch {}
}

function nativeBridgeUnavailableReason(error) {
  const message = String(error?.message || error || '')
  if (/not implemented|unimplemented|not available|no web implementation|plugin/i.test(message)) {
    return 'Update TestFlight to a build that includes the Apple Health bridge.'
  }
  return message || 'Unable to reach the Apple Health bridge.'
}

class HealthService {
  constructor() {
    this.healthKit = null
  }

  async loadHealthKit() {
    if (this.healthKit) return this.healthKit

    try {
      const mod = await importNativeModule('react-native-health')
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
          constants.RestingHeartRate || 'RestingHeartRate',
          constants.HeartRateVariabilitySDNN || 'HeartRateVariabilitySDNN',
          constants.DistanceWalkingRunning || 'DistanceWalkingRunning',
          constants.AppleExerciseTime || 'AppleExerciseTime',
          constants.Vo2Max || 'Vo2Max',
          constants.WalkingHeartRateAverage || 'WalkingHeartRateAverage',
          constants.HeartRateRecoveryOneMinute || 'HeartRateRecoveryOneMinute',
          constants.RespiratoryRate || 'RespiratoryRate',
          constants.RunningPower || 'RunningPower',
          constants.RunningSpeed || 'RunningSpeed',
          constants.RunningStrideLength || 'RunningStrideLength',
          constants.RunningVerticalOscillation || 'RunningVerticalOscillation',
          constants.RunningGroundContactTime || 'RunningGroundContactTime',
          constants.SleepAnalysis || 'SleepAnalysis',
          constants.Workout || 'Workout',
        ],
        write: [],
      },
    }
  }

  async initialize({ requestPermission = false } = {}) {
    if (!isIOSDevice()) {
      return { available: false, reason: 'Apple Health is only available on iOS devices.' }
    }

    if (isNativeRuntime()) {
      try {
        const status = await ForgeHealth.isAvailable()
        if (!status?.available) {
          return { available: false, reason: 'Apple Health is not available on this iPhone.' }
        }

        if (requestPermission) {
          const auth = await ForgeHealth.requestAuthorization()
          if (!auth?.authorized) {
            return { available: false, reason: 'Apple Health permission was not granted.' }
          }
          markNativeAuthorized()
        } else if (!hasNativeAuthorizationHint()) {
          return { available: false, reason: 'Open Settings > Apple Health and tap Sync Apple Health to grant access.' }
        }

        return { available: true, authorizationUpgradeRequired: !hasExpandedNativeAuthorization() }
      } catch (error) {
        return { available: false, reason: nativeBridgeUnavailableReason(error) }
      }
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

  async syncToProfile(metrics) {
    if (!metrics) return null
    const { data } = await api.post('/health/sync', {
      steps_today: metrics.stepsToday,
      calories_today: metrics.caloriesBurnedToday,
      avg_hr_bpm_last_workout: metrics.avgHeartRateFromLastRun,
      avg_heart_rate_last_run: metrics.avgHeartRateFromLastRun,
      total_miles_this_week: metrics.totalMilesThisWeek,
      resting_heart_rate: metrics.restingHeartRate,
      hrv_ms: metrics.heartRateVariabilityMs,
      sleep_hours_last_night: metrics.sleepHoursLastNight,
      active_minutes_this_week: metrics.activeMinutesThisWeek,
      workout_count_this_week: metrics.workoutCountThisWeek,
      last_workout_type: metrics.lastWorkoutType,
      last_workout_duration_seconds: metrics.lastWorkoutDurationSeconds,
      last_workout_calories: metrics.lastWorkoutCalories,
      sleep_core_hours: metrics.sleepCoreHours,
      sleep_deep_hours: metrics.sleepDeepHours,
      sleep_rem_hours: metrics.sleepRemHours,
      sleep_awake_hours: metrics.sleepAwakeHours,
      sleep_end_at: metrics.sleepEndAt,
      sleep_hours_7d_baseline: metrics.sleepHours7dBaseline,
      resting_heart_rate_baseline: metrics.restingHeartRateBaseline,
      resting_heart_rate_recorded_at: metrics.restingHeartRateRecordedAt,
      hrv_ms_baseline: metrics.heartRateVariabilityBaselineMs,
      hrv_recorded_at: metrics.heartRateVariabilityRecordedAt,
      vo2_max: metrics.vo2Max,
      vo2_max_recorded_at: metrics.vo2MaxRecordedAt,
      walking_heart_rate_average: metrics.walkingHeartRateAverage,
      walking_heart_rate_recorded_at: metrics.walkingHeartRateRecordedAt,
      heart_rate_recovery_one_minute: metrics.heartRateRecoveryOneMinute,
      heart_rate_recovery_recorded_at: metrics.heartRateRecoveryRecordedAt,
      respiratory_rate: metrics.respiratoryRate,
      respiratory_rate_recorded_at: metrics.respiratoryRateRecordedAt,
      exercise_minutes_this_week: metrics.exerciseMinutesThisWeek,
      running_power_watts: metrics.runningPowerWatts,
      running_speed_mps: metrics.runningSpeedMps,
      running_stride_length_m: metrics.runningStrideLengthM,
      running_vertical_oscillation_cm: metrics.runningVerticalOscillationCm,
      running_ground_contact_time_ms: metrics.runningGroundContactTimeMs,
      running_dynamics_recorded_at: metrics.runningDynamicsRecordedAt,
      metrics_schema_version: hasExpandedNativeAuthorization() ? metrics.metricsSchemaVersion : 1,
    })
    return data
  }

  async syncNativeData({ requestPermission = false } = {}) {
    const result = await this.getHealthSummary({ requestPermission })
    if (!result?.available) {
      throw new Error(result?.reason || 'Apple Health is not available.')
    }

    const profile = await this.syncToProfile(result.metrics)
    const historyOptions = healthResyncNeeded() ? { forceFullSync: true } : {}
    const history = await this.getWorkoutHistory(historyOptions)
    const workouts = history.available && history.workouts.length > 0 ? history.workouts : result.workouts
    let importResult = { imported: 0, skipped: 0, errors: [] }
    if (Array.isArray(workouts) && workouts.length > 0) {
      try {
        const { data } = await api.post('/import/health', { workouts })
        importResult = data || importResult
        clearHealthResyncNeeded()
      } catch (error) {
        markHealthResyncNeeded()
        throw error
      }
    }

    markAutoHealthSyncAttempted()

    return {
      ...result,
      profile,
      observedMaxHR: history.observedMaxHR,
      workouts,
      imported: Number(importResult.imported || 0),
      skipped: Number(importResult.skipped || 0),
      errors: importResult.errors || [],
    }
  }

  markAutoHealthSyncAttempted() {
    markAutoHealthSyncAttempted()
  }

  async getWorkoutHistory(options = {}) {
    if (!isNativeRuntime()) {
      return { available: false, reason: 'Apple Health workout history requires the native iOS app.', workouts: [] }
    }

    try {
      if (typeof ForgeHealth.getWorkoutHistory !== 'function') {
        return { available: false, reason: 'Update TestFlight to sync full Apple Health workout history.', workouts: [] }
      }

      const response = await ForgeHealth.getWorkoutHistory(options)
      return {
        available: true,
        reason: null,
        workouts: Array.isArray(response?.workouts) ? response.workouts : [],
        observedMaxHR: response?.observedMaxHR ? Math.round(toNumber(response.observedMaxHR)) : null,
        incremental: Boolean(response?.incremental),
        startDate: response?.startDate || null,
        endDate: response?.endDate || null,
      }
    } catch (error) {
      return {
        available: false,
        reason: nativeBridgeUnavailableReason(error),
        workouts: [],
      }
    }
  }

  async getNativeHealthSummary(options = {}) {
    const init = await this.initialize(options)
    if (!init.available) {
      return {
        available: false,
        reason: init.reason,
        metrics: null,
        workouts: [],
      }
    }

    try {
      const summary = await ForgeHealth.getSummary()
      const metricsSchemaVersion = Number(summary?.metricsSchemaVersion || 1)
      if (options.requestPermission && metricsSchemaVersion >= REQUIRED_HEALTH_AUTH_VERSION) {
        markNativeAuthorized(REQUIRED_HEALTH_AUTH_VERSION)
      }
      return {
        available: true,
        reason: null,
        authorizationUpgradeRequired: !hasExpandedNativeAuthorization(),
        metrics: {
          metricsSchemaVersion,
          totalMilesThisWeek: toNumber(summary?.totalMilesThisWeek),
          avgHeartRateFromLastRun: summary?.avgHeartRateFromLastRun ? Math.round(toNumber(summary.avgHeartRateFromLastRun)) : null,
          restingHeartRate: summary?.restingHeartRate ? Math.round(toNumber(summary.restingHeartRate)) : null,
          heartRateVariabilityMs: summary?.heartRateVariabilityMs ? Math.round(toNumber(summary.heartRateVariabilityMs)) : null,
          sleepHoursLastNight: numberOrNull(summary?.sleepHoursLastNight),
          activeMinutesThisWeek: Math.round(toNumber(summary?.activeMinutesThisWeek)),
          workoutCountThisWeek: Math.round(toNumber(summary?.workoutCountThisWeek)),
          lastWorkoutType: summary?.lastWorkoutType || null,
          lastWorkoutDurationSeconds: summary?.lastWorkoutDurationSeconds ? Math.round(toNumber(summary.lastWorkoutDurationSeconds)) : null,
          lastWorkoutCalories: summary?.lastWorkoutCalories ? Math.round(toNumber(summary.lastWorkoutCalories)) : null,
          caloriesBurnedToday: Math.round(toNumber(summary?.caloriesBurnedToday)),
          stepsToday: Math.round(toNumber(summary?.stepsToday)),
          exerciseMinutesThisWeek: Math.round(toNumber(summary?.exerciseMinutesThisWeek)),
          sleepHours7dBaseline: numberOrNull(summary?.sleepHours7dBaseline),
          sleepCoreHours: numberOrNull(summary?.sleepCoreHours),
          sleepDeepHours: numberOrNull(summary?.sleepDeepHours),
          sleepRemHours: numberOrNull(summary?.sleepREMHours),
          sleepAwakeHours: numberOrNull(summary?.sleepAwakeHours),
          sleepEndAt: summary?.sleepEndAt || null,
          restingHeartRateBaseline: numberOrNull(summary?.restingHeartRateBaseline),
          restingHeartRateRecordedAt: summary?.restingHeartRateRecordedAt || null,
          heartRateVariabilityBaselineMs: numberOrNull(summary?.heartRateVariabilityBaselineMs),
          heartRateVariabilityRecordedAt: summary?.heartRateVariabilityRecordedAt || null,
          vo2Max: numberOrNull(summary?.vo2Max),
          vo2MaxRecordedAt: summary?.vo2MaxRecordedAt || null,
          walkingHeartRateAverage: numberOrNull(summary?.walkingHeartRateAverage),
          walkingHeartRateRecordedAt: summary?.walkingHeartRateRecordedAt || null,
          heartRateRecoveryOneMinute: numberOrNull(summary?.heartRateRecoveryOneMinute),
          heartRateRecoveryRecordedAt: summary?.heartRateRecoveryRecordedAt || null,
          respiratoryRate: numberOrNull(summary?.respiratoryRate),
          respiratoryRateRecordedAt: summary?.respiratoryRateRecordedAt || null,
          runningPowerWatts: numberOrNull(summary?.runningPowerWatts),
          runningSpeedMps: numberOrNull(summary?.runningSpeedMps),
          runningStrideLengthM: numberOrNull(summary?.runningStrideLengthM),
          runningVerticalOscillationCm: numberOrNull(summary?.runningVerticalOscillationCm),
          runningGroundContactTimeMs: numberOrNull(summary?.runningGroundContactTimeMs),
          runningDynamicsRecordedAt: summary?.runningDynamicsRecordedAt || null,
        },
        workouts: Array.isArray(summary?.workouts) ? summary.workouts : [],
      }
    } catch (error) {
      return {
        available: false,
        reason: nativeBridgeUnavailableReason(error),
        metrics: null,
        workouts: [],
      }
    }
  }

  async getHealthSummary(options = {}) {
    if (isNativeRuntime()) {
      return this.getNativeHealthSummary(options)
    }

    const init = await this.initialize(options)
    if (!init.available) {
      return {
        available: false,
        reason: init.reason,
        metrics: null,
        workouts: [],
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

    const workoutMinutesThisWeek = workouts.reduce((sum, workout) => {
      const seconds = toNumber(workout?.durationSeconds || workout?.duration_seconds || workout?.duration || 0)
      return sum + (seconds / 60)
    }, 0)
    const latestWorkout = [...workouts]
      .sort((a, b) => new Date(b?.startDate || b?.start || b?.date).getTime() - new Date(a?.startDate || a?.start || a?.date).getTime())[0]

    return {
      available: true,
      reason: null,
      metrics: {
        totalMilesThisWeek: Number(totalMilesThisWeek.toFixed(2)),
        avgHeartRateFromLastRun: avgHeartRateFromLastRun ? Math.round(avgHeartRateFromLastRun) : null,
        restingHeartRate: null,
        heartRateVariabilityMs: null,
        sleepHoursLastNight: null,
        activeMinutesThisWeek: Math.round(workoutMinutesThisWeek),
        workoutCountThisWeek: workouts.length,
        lastWorkoutType: latestWorkout?.type || latestWorkout?.activityName || latestWorkout?.activityType || null,
        lastWorkoutDurationSeconds: latestWorkout ? Math.round(toNumber(latestWorkout.durationSeconds || latestWorkout.duration_seconds || latestWorkout.duration || 0)) : null,
        lastWorkoutCalories: latestWorkout ? Math.round(toNumber(latestWorkout.calories || latestWorkout.totalEnergyBurned || 0)) : null,
        caloriesBurnedToday: Math.round(caloriesBurnedToday),
        stepsToday: Math.round(stepsToday),
      },
      workouts,
    }
  }
}

export default new HealthService()
