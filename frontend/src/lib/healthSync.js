export const HEALTH_SYNC_RESULT_EVENT = 'forge-health-sync-result'
export const HEALTH_SYNC_COMPLETED_EVENT = 'forge-health-sync-completed'
export const HEALTH_SYNC_ORIGIN_PULL_REFRESH = 'pull_to_refresh'
export const HEALTH_IMPORT_BATCH_SIZE = 10
export const HEALTH_IMPORT_TIMEOUT_MS = 30000
export const HEALTH_PULL_REFRESH_DEADLINE_MS = 15000

export class HealthPullRefreshTimeoutError extends Error {
  constructor(deadlineMs = HEALTH_PULL_REFRESH_DEADLINE_MS) {
    super(`Apple Health pull-to-sync timed out after ${deadlineMs}ms.`)
    this.name = 'HealthPullRefreshTimeoutError'
    this.code = 'HEALTH_PULL_REFRESH_TIMEOUT'
    this.deadlineMs = deadlineMs
  }
}

const HEALTH_SYNC_RESULT_KEY = 'forge_last_health_sync_result'
const HEALTH_HISTORY_TRANSFER_PENDING_KEY = 'forge.health.resyncNeeded'
let activeHealthPullRefreshes = 0

export function isHealthHistoryTransferPending() {
  try {
    return localStorage.getItem(HEALTH_HISTORY_TRANSFER_PENDING_KEY) === '1'
  } catch (error) {
    console.warn('[health-sync] transfer state lookup failed:', error?.message || error)
    return true
  }
}

export function markHealthHistoryTransferPending() {
  try {
    localStorage.setItem(HEALTH_HISTORY_TRANSFER_PENDING_KEY, '1')
    return true
  } catch (error) {
    console.error('[health-sync] transfer state save failed:', error?.message || error)
    return false
  }
}

export function clearHealthHistoryTransferPending() {
  try {
    localStorage.removeItem(HEALTH_HISTORY_TRANSFER_PENDING_KEY)
    return true
  } catch (error) {
    console.error('[health-sync] transfer state cleanup failed:', error?.message || error)
    return false
  }
}

export function createHealthImportBatches(workouts, batchSize = HEALTH_IMPORT_BATCH_SIZE) {
  if (!Array.isArray(workouts) || workouts.length === 0) return []
  const size = Number(batchSize)
  if (!Number.isInteger(size) || size < 1) throw new Error('Health import batch size must be a positive integer.')

  const batches = []
  for (let index = 0; index < workouts.length; index += size) {
    batches.push(workouts.slice(index, index + size))
  }
  return batches
}

export async function importHealthWorkoutBatches(workouts, sendBatch) {
  const result = { imported: 0, skipped: 0, errors: [] }
  let offset = 0

  for (const batch of createHealthImportBatches(workouts)) {
    try {
      const data = await sendBatch(batch)
      result.imported += Number(data?.imported || 0)
      result.skipped += Number(data?.skipped || 0)
      const batchErrors = Array.isArray(data?.errors) ? data.errors : []
      result.errors.push(...batchErrors.map((item) => ({
        ...item,
        index: Number.isInteger(Number(item?.index)) ? offset + Number(item.index) : item?.index,
      })))
      offset += batch.length
    } catch (error) {
      error.partialImportResult = { ...result, errors: [...result.errors] }
      throw error
    }
  }

  return result
}

export function retryableHealthSyncErrors(errors) {
  return (Array.isArray(errors) ? errors : []).filter((error) => error?.retryable !== false)
}

export function isHealthHistoryImportComplete({ historyAvailable, errors } = {}) {
  return Boolean(historyAvailable) && retryableHealthSyncErrors(errors).length === 0
}

export function createHealthSyncCoordinator(performSync) {
  if (typeof performSync !== 'function') throw new Error('Health sync coordinator requires an executor.')
  let activeOperation = null

  return {
    async run(options = {}) {
      const requestPermission = Boolean(options.requestPermission)
      const forceFresh = Boolean(options.forceFresh)

      while (true) {
        const sharedOperation = activeOperation
        if (sharedOperation) {
          try {
            const sharedResult = await sharedOperation.promise
            const needsFreshOperation = forceFresh && !sharedOperation.forceFresh
            const needsPermissionOperation = requestPermission
              && !sharedOperation.requestPermission
              && sharedResult?.authorizationUpgradeRequired
            if (!needsFreshOperation && !needsPermissionOperation) {
              return sharedResult
            }
          } catch (error) {
            const canRetryFresh = forceFresh && !sharedOperation.forceFresh
            const canRetryWithPermission = requestPermission && !sharedOperation.requestPermission
            if (!canRetryFresh && !canRetryWithPermission) throw error
          }
          continue
        }

        const operation = {
          forceFresh,
          requestPermission,
          promise: null,
        }
        operation.promise = Promise.resolve().then(() => performSync({ ...options, forceFresh, requestPermission }))
        activeOperation = operation

        try {
          return await operation.promise
        } finally {
          if (activeOperation === operation) activeOperation = null
        }
      }
    },
    hasActiveOperation() {
      return Boolean(activeOperation)
    },
  }
}

export async function runHealthAwarePageRefresh({
  authenticated = false,
  native = false,
  syncNativeData,
  afterHealthSync,
  onHealthSyncError,
  refreshPage,
  scheduleDeadline = (callback, delay) => globalThis.setTimeout(callback, delay),
  cancelDeadline = (deadlineId) => globalThis.clearTimeout(deadlineId),
} = {}) {
  let healthSyncAttempted = false
  let healthSyncResult = null
  let healthSyncError = null
  const suppressHealthEventRefreshes = Boolean(authenticated && native)

  if (suppressHealthEventRefreshes) activeHealthPullRefreshes += 1

  try {
    if (suppressHealthEventRefreshes) {
      healthSyncAttempted = true
      let deadlineExpired = false
      let deadlineScheduled = false
      let deadlineId
      const healthSyncPromise = Promise.resolve().then(() => syncNativeData({
        forceFresh: true,
        syncOrigin: HEALTH_SYNC_ORIGIN_PULL_REFRESH,
      }))
      // Promise.race observes the losing branch, and this explicit observer
      // keeps that contract obvious if the bridge rejects after the gesture.
      void healthSyncPromise.catch((error) => {
        if (deadlineExpired) {
          console.warn('[healthSync] native sync rejected after pull deadline:', error?.message || error)
        }
      })
      const deadlinePromise = new Promise((resolve, reject) => {
        deadlineId = scheduleDeadline(() => {
          deadlineExpired = true
          reject(new HealthPullRefreshTimeoutError())
        }, HEALTH_PULL_REFRESH_DEADLINE_MS)
        deadlineScheduled = true
      })
      try {
        healthSyncResult = await Promise.race([healthSyncPromise, deadlinePromise])
      } catch (error) {
        healthSyncError = error
        try {
          onHealthSyncError?.(error)
        } catch (reportingError) {
          console.warn('[healthSync] refresh error reporter failed:', reportingError?.message || reportingError)
        }
      } finally {
        if (deadlineScheduled && !deadlineExpired) {
          try {
            cancelDeadline(deadlineId)
          } catch (error) {
            console.warn('[healthSync] pull deadline cancellation failed:', error?.message || error)
          }
        }
      }
    }

    const outcome = {
      healthSyncAttempted,
      healthSyncResult,
      healthSyncError,
    }

    await afterHealthSync?.()
    await refreshPage?.(outcome)
    return outcome
  } finally {
    if (suppressHealthEventRefreshes) {
      activeHealthPullRefreshes = Math.max(0, activeHealthPullRefreshes - 1)
    }
  }
}

export function getLastHealthSyncResult() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HEALTH_SYNC_RESULT_KEY) || 'null')
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (error) {
    console.warn('[health-sync] result lookup failed:', error?.message || error)
    return null
  }
}

export function shouldRefreshPageForHealthSyncEvent(event) {
  return activeHealthPullRefreshes === 0
    && event?.detail?.origin !== HEALTH_SYNC_ORIGIN_PULL_REFRESH
}

export function announceHealthSyncResult(result, { complete = true, origin = null } = {}) {
  const scanned = Array.isArray(result?.workouts) ? result.workouts.length : Number(result?.scanned || result?.total || 0)
  const retryableErrors = retryableHealthSyncErrors(result?.errors)
  const summary = {
    scanned: Number(scanned || 0),
    imported: Number(result?.imported || 0),
    skipped: Number(result?.skipped || 0),
    errors: Array.isArray(result?.errors) ? result.errors : [],
    unresolved: retryableErrors.length,
    complete: Boolean(complete),
    status: complete ? 'complete' : 'partial',
    authorizationUpgradeRequired: Boolean(result?.authorizationUpgradeRequired),
    syncedAt: new Date().toISOString(),
  }

  try {
    localStorage.setItem(HEALTH_SYNC_RESULT_KEY, JSON.stringify(summary))
  } catch (error) {
    console.warn('[health-sync] result save failed:', error?.message || error)
  }

  if (typeof window !== 'undefined') {
    const detail = { ...summary, metrics: result?.metrics || null, origin }
    window.dispatchEvent(new CustomEvent(HEALTH_SYNC_RESULT_EVENT, { detail }))
    if (complete) window.dispatchEvent(new CustomEvent(HEALTH_SYNC_COMPLETED_EVENT, { detail }))
  }

  return summary
}

export function healthSyncNotice(result) {
  const scanned = Array.isArray(result?.workouts) ? result.workouts.length : Number(result?.scanned || 0)
  if (result?.complete === false) {
    const unresolved = Number(result?.unresolved || retryableHealthSyncErrors(result?.errors).length || 0)
    return `Apple Health partially synced: ${scanned} scanned, ${result?.imported || 0} imported, ${result?.skipped || 0} already saved, ${unresolved} unresolved. Forged Hybrid will retry automatically.`
  }
  return `Apple Health synced: ${scanned} scanned, ${result?.imported || 0} imported, ${result?.skipped || 0} already saved.`
}

export function healthSyncFailureMessage(error) {
  const message = String(error?.message || error || '')
  if (error?.code === 'ECONNABORTED' || /timeout|timed out/i.test(message)) {
    return 'Apple Health is taking longer than expected. Any completed batches are safely saved; keep Forged Hybrid open and try Sync again.'
  }
  return message || 'Unable to sync Apple Health on this device.'
}
