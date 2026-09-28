import { Capacitor, registerPlugin } from '@capacitor/core'
import api from '../lib/api'
import { getAuthenticatedUserId } from '../lib/auth'
import { getAuthSession, isAuthSessionCurrent, subscribeAuthSession } from '../lib/tokenStore'
import {
  announceHealthSyncResult,
  announceActivityDataChanged,
  clearHealthHistoryTransferPending,
  createHealthSyncCoordinator,
  HEALTH_IMPORT_TIMEOUT_MS,
  importHealthWorkoutBatches,
  isHealthHistoryImportComplete,
  isHealthHistoryTransferPending,
  markHealthHistoryTransferPending,
  retryableHealthSyncErrors,
  healthAccountKey,
} from '../lib/healthSync'

const IOS_UA_REGEX = /iP(ad|hone|od)/i
const NATIVE_HEALTH_AUTH_KEY = 'forge_health_authorized'
const NATIVE_HEALTH_AUTH_VERSION_KEY = 'forge_health_authorized_version'
const REQUIRED_HEALTH_AUTH_VERSION = 4
const AUTO_HEALTH_SYNC_LAST_SYNC_KEY = 'forge_auto_health_sync_last_sync_at'
const WORKOUT_IMPORT_VERSION_KEY = 'forge_health_workout_import_version'
const REQUIRED_WORKOUT_IMPORT_VERSION = 6
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
  } catch (error) {
    console.error('[HealthService] authorization hint could not be read:', error?.message || error)
    return false
  }
}

function markNativeAuthorized(version = 1) {
  try {
    localStorage.setItem(NATIVE_HEALTH_AUTH_KEY, '1')
    const currentVersion = Number(localStorage.getItem(NATIVE_HEALTH_AUTH_VERSION_KEY) || 0)
    localStorage.setItem(NATIVE_HEALTH_AUTH_VERSION_KEY, String(Math.max(currentVersion, version)))
  } catch (error) {
    console.error('[HealthService] authorization hint could not be saved:', error?.message || error)
  }
}

function hasExpandedNativeAuthorization() {
  try {
    return Number(localStorage.getItem(NATIVE_HEALTH_AUTH_VERSION_KEY) || 0) >= REQUIRED_HEALTH_AUTH_VERSION
  } catch (error) {
    console.error('[HealthService] authorization version could not be read:', error?.message || error)
    return false
  }
}

function workoutHistoryUpgradeRequired(accountId) {
  try {
    return Number(localStorage.getItem(healthAccountKey(WORKOUT_IMPORT_VERSION_KEY, accountId)) || 0) < REQUIRED_WORKOUT_IMPORT_VERSION
  } catch (error) {
    console.error('[HealthService] workout import version could not be read:', error?.message || error)
    return true
  }
}

function markWorkoutHistoryUpgraded(accountId) {
  try {
    localStorage.setItem(healthAccountKey(WORKOUT_IMPORT_VERSION_KEY, accountId), String(REQUIRED_WORKOUT_IMPORT_VERSION))
    return true
  } catch (error) {
    console.error('[HealthService] workout import version could not be saved:', error?.message || error)
    return false
  }
}

function markAutoHealthSyncAttempted(accountId) {
  try {
    localStorage.setItem(healthAccountKey(AUTO_HEALTH_SYNC_LAST_SYNC_KEY, accountId), String(Date.now()))
  } catch (error) {
    console.error('[HealthService] automatic sync timestamp could not be saved:', error?.message || error)
  }
}

function nativeBridgeUnavailableReason(error) {
  const message = String(error?.message || error || '')
  if (/not implemented|unimplemented|not available|no web implementation|plugin/i.test(message)) {
    return 'Update TestFlight to a build that includes the Apple Health bridge.'
  }
  return message || 'Unable to reach the Apple Health bridge.'
}

export class HealthService {
  constructor({ apiClient = api, bridge = ForgeHealth, native = isNativeRuntime, coordinatorOptions = {} } = {}) {
    this.api = apiClient
    this.bridge = bridge
    this.native = native
    this.pendingBridgeCalls = new Set()
    this.pendingHistoryReads = new Set()
    this.pendingOptionalSummary = null
    this.healthKit = null
    this.lastNativeSync = null
    this.nativeSyncCoordinator = createHealthSyncCoordinator((options) => this.performNativeSync(options), {
      ...coordinatorOptions,
      getIdentity: () => ({ ...getAuthSession(), accountId: getAuthenticatedUserId() }),
      isCurrent: (identity) => Boolean(identity?.accountId) && isAuthSessionCurrent(identity) && getAuthenticatedUserId() === identity.accountId,
    })
    this.unsubscribeAuth = subscribeAuthSession(() => {
      this.lastNativeSync = null
      this.nativeSyncCoordinator.cancel()
    })
  }

  dispose() { this.nativeSyncCoordinator.cancel(); this.unsubscribeAuth() }

  async callNative(method, ...args) {
    // Native HealthKit reads are not cancellable through the shipped bridge.
    // Permit one recovery slot, then fail promptly rather than accumulating
    // unbounded native jobs after repeated timeouts. Settlement frees a slot.
    if (this.pendingBridgeCalls.size >= 2) {
      throw Object.assign(new Error('Apple Health native reads are still pending. Keep the app open and retry after they finish.'), { code: 'HEALTH_NATIVE_BUSY' })
    }
    const call = Promise.resolve().then(() => this.bridge[method](...args))
    this.pendingBridgeCalls.add(call)
    try { return await call } finally { this.pendingBridgeCalls.delete(call) }
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

  async initialize({ requestPermission = false, operation } = {}) {
    if (!isIOSDevice()) {
      return { available: false, reason: 'Apple Health is only available on iOS devices.' }
    }

    if (this.native()) {
      try {
        const status = await this.callNative('isAvailable')
        operation?.assertCurrent()
        if (!status?.available) {
          return { available: false, reason: 'Apple Health is not available on this iPhone.' }
        }

        if (requestPermission) {
          const auth = await this.callNative('requestAuthorization')
          operation?.assertCurrent()
          if (!auth?.authorized) {
            return { available: false, reason: 'Apple Health permission was not granted.' }
          }
          markNativeAuthorized(REQUIRED_HEALTH_AUTH_VERSION)
        } else if (!hasNativeAuthorizationHint()) {
          return { available: false, reason: 'Open More > Health & data and tap Sync Apple Health to grant access.' }
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

  async syncToProfile(metrics, operation) {
    if (!metrics) return null
    operation?.assertCurrent()
    const { data } = await this.api.post('/health/sync', {
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
      activity_summary_recorded_at: metrics.activitySummaryRecordedAt,
      running_power_watts: metrics.runningPowerWatts,
      running_speed_mps: metrics.runningSpeedMps,
      running_stride_length_m: metrics.runningStrideLengthM,
      running_vertical_oscillation_cm: metrics.runningVerticalOscillationCm,
      running_ground_contact_time_ms: metrics.runningGroundContactTimeMs,
      running_dynamics_recorded_at: metrics.runningDynamicsRecordedAt,
      metrics_schema_version: hasExpandedNativeAuthorization() ? metrics.metricsSchemaVersion : 1,
    }, operation ? { signal: operation.signal, forgeAuthSession: operation.identity } : {})
    operation?.assertCurrent()
    return data
  }

  async syncNativeData(options = {}) {
    return this.nativeSyncCoordinator.run(options)
  }

  hasNativeSyncInFlight() {
    return this.nativeSyncCoordinator.hasActiveOperation()
  }

  getRecentNativeSyncResult(maxAgeMs = 30000) {
    if (!this.lastNativeSync || !isAuthSessionCurrent(this.lastNativeSync.identity)) return null
    const completedAt = Number(this.lastNativeSync?.completedAt || 0)
    if (!completedAt || Date.now() - completedAt > maxAgeMs) return null
    return this.lastNativeSync.result || null
  }

  async performNativeSync({ requestPermission = false, syncOrigin = null, operation } = {}) {
    operation.assertCurrent()
    const accountId = operation.identity.accountId
    const init = await this.initialize({ requestPermission, operation })
    operation.assertCurrent()
    if (!init?.available) {
      throw new Error(init?.reason || 'Apple Health is not available.')
    }
    // At most one optional native summary may remain unresolved. Retrying it
    // must not occupy both uncancellable bridge slots and starve history.
    const startSummary = () => {
      if (!this.pendingOptionalSummary && this.pendingBridgeCalls.size < 2) {
        const task = (async () => {
          const summary = await this.getHealthSummary({ operation })
          operation.assertCurrent()
          if (!summary.available) return { ...summary, summaryStatus: 'error' }
          try {
            await this.syncToProfile(summary.metrics, operation)
            return { ...summary, summaryStatus: 'complete' }
          } catch (error) {
            operation.assertCurrent()
            return { ...summary, summaryStatus: 'error' }
          }
        })().finally(() => { if (this.pendingOptionalSummary === task) this.pendingOptionalSummary = null })
        this.pendingOptionalSummary = task
        // Observe rejection immediately even when history fails first.
        void task.catch(() => null) // The owning operation reports failure; no detached rejection.
        return task
      }
      return Promise.resolve({ available: true, metrics: null, workouts: [], summaryStatus: 'pending' })
    }
    const historyOptions = (isHealthHistoryTransferPending(accountId) || workoutHistoryUpgradeRequired(accountId) || this.pendingHistoryReads.size > 0) ? { forceFullSync: true } : {}
    let profile = null
    try {
      operation.assertCurrent()
      const { data } = await this.api.get('/profile/hr-zones', { signal: operation.signal, forgeAuthSession: operation.identity })
      operation.assertCurrent()
      profile = data?.profile || null
      const zones = Array.isArray(data?.zones) ? data.zones : []
      if (Number.isFinite(Number(profile?.maxHr))) historyOptions.maxHR = Number(profile.maxHr)
      if (zones.length === 5 && zones.every((zone) => Number.isFinite(Number(zone?.minBpm)))) {
        historyOptions.zoneMinimums = zones.map((zone) => Number(zone.minBpm))
      }
    } catch (error) {
      operation.assertCurrent()
      console.error('[HealthService] HR zone profile lookup failed:', error?.message || error)
    }

    // HealthKit advances its native anchor when history is read. Persist the retry checkpoint first.
    operation.assertCurrent()
    if (!markHealthHistoryTransferPending(accountId)) {
      throw new Error('Unable to checkpoint Apple Health history before syncing. Please try again.')
    }
    const read = this.getWorkoutHistory(historyOptions)
    const summaryTask = startSummary()
    this.pendingHistoryReads.add(read)
    let history
    try { history = await read } finally { this.pendingHistoryReads.delete(read) }
    operation.assertCurrent()
    // A failed optional summary never defines whether workouts exist.
    const hasHistoryWorkouts = history.available && history.workouts.length > 0
    const fallbackSummary = !hasHistoryWorkouts ? await summaryTask : null
    const workouts = hasHistoryWorkouts ? history.workouts : (fallbackSummary?.workouts || [])
    let importResult = { imported: 0, skipped: 0, errors: [] }
    if (Array.isArray(workouts) && workouts.length > 0) {
      try {
        importResult = await importHealthWorkoutBatches(workouts, async (batch) => {
          operation.assertCurrent()
          const { data } = await this.api.post('/import/health', { workouts: batch }, { timeout: HEALTH_IMPORT_TIMEOUT_MS, signal: operation.signal, forgeAuthSession: operation.identity })
          operation.assertCurrent()
          return data
        }, (acknowledgment) => {
          operation.assertCurrent()
          if (acknowledgment.imported + acknowledgment.skipped > 0) announceActivityDataChanged('apple', operation.identity)
        })
      } catch (error) {
        operation.assertCurrent()
        markHealthHistoryTransferPending(accountId)
        throw error
      }
    }

    const result = await summaryTask
    operation.assertCurrent()
    const nativeMetricsVersion = Number(result.metrics?.metricsSchemaVersion || 1)
    const workoutUpgradeAvailable = nativeMetricsVersion >= REQUIRED_WORKOUT_IMPORT_VERSION
    const unresolved = retryableHealthSyncErrors(importResult.errors)
    const importComplete = isHealthHistoryImportComplete({
      historyAvailable: history.available && this.pendingHistoryReads.size === 0,
      errors: importResult.errors,
    })
    let upgradeCommitted = true
    if (importComplete && workoutUpgradeAvailable) {
      upgradeCommitted = markWorkoutHistoryUpgraded(accountId)
    }
    let historyComplete = importComplete && upgradeCommitted
    if (historyComplete) {
      historyComplete = clearHealthHistoryTransferPending(accountId)
    }
    if (!historyComplete) {
      markHealthHistoryTransferPending(accountId)
    }
    const complete = historyComplete && result.summaryStatus === 'complete'

    markAutoHealthSyncAttempted(accountId)

    const syncResult = {
      ...result,
      available: true,
      reason: null,
      authorizationUpgradeRequired: Boolean(init.authorizationUpgradeRequired),
      stages: { workouts: historyComplete ? 'complete' : 'partial', summary: result.summaryStatus },
      profile,
      observedMaxHR: history.observedMaxHR,
      workouts,
      imported: Number(importResult.imported || 0),
      skipped: Number(importResult.skipped || 0),
      errors: importResult.errors || [],
      unresolved: unresolved.length,
      complete,
      status: complete ? 'complete' : 'partial',
    }
    operation.assertCurrent()
    this.lastNativeSync = { result: syncResult, completedAt: Date.now(), identity: operation.identity }
    announceHealthSyncResult(syncResult, { complete, origin: syncOrigin, accountId, assertCurrent: operation.assertCurrent })
    return syncResult
  }

  markAutoHealthSyncAttempted() {
    const accountId = getAuthenticatedUserId()
    if (accountId) markAutoHealthSyncAttempted(accountId)
  }

  addWorkoutObserverListener(callback) {
    if (!this.native() || typeof this.bridge.addListener !== 'function') return null
    return this.bridge.addListener('workoutObserved', callback)
  }

  async getWorkoutHistory(options = {}) {
    if (!this.native()) {
      return { available: false, reason: 'Apple Health workout history requires the native iOS app.', workouts: [] }
    }

    try {
      if (typeof this.bridge.getWorkoutHistory !== 'function') {
        return { available: false, reason: 'Update TestFlight to sync full Apple Health workout history.', workouts: [] }
      }

      const response = await this.callNative('getWorkoutHistory', options)
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
      options.operation?.assertCurrent()
      const summary = await this.callNative('getSummary')
      options.operation?.assertCurrent()
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
          activitySummaryRecordedAt: summary?.activitySummaryRecordedAt || null,
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
    if (this.native()) {
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
