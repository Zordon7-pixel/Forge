import { getAuthSession, isAuthSessionCurrent } from './tokenStore.js'
import { getAuthenticatedUserId } from './auth.js'

export const HEALTH_SYNC_RESULT_EVENT = 'forge-health-sync-result'
export const HEALTH_SYNC_COMPLETED_EVENT = 'forge-health-sync-completed'
export const HEALTH_SYNC_ORIGIN_PULL_REFRESH = 'pull_to_refresh'
export const HEALTH_IMPORT_BATCH_SIZE = 10
export const HEALTH_IMPORT_TIMEOUT_MS = 30000
export const HEALTH_PULL_REFRESH_DEADLINE_MS = 15000
// Separate from the gesture deadline: an uncancellable native bridge must not
// retain the shared operation forever. Late continuations must assertCurrent.
export const HEALTH_SYNC_OPERATION_DEADLINE_MS = 120000
export const healthAccountKey = (key, accountId) => accountId ? `${key}:${encodeURIComponent(accountId)}` : key

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

export function isHealthHistoryTransferPending(accountId) {
  try {
    return localStorage.getItem(healthAccountKey(HEALTH_HISTORY_TRANSFER_PENDING_KEY, accountId)) === '1'
  } catch (error) {
    console.warn('[health-sync] transfer state lookup failed:', error?.message || error)
    return true
  }
}

export function markHealthHistoryTransferPending(accountId) {
  try {
    localStorage.setItem(healthAccountKey(HEALTH_HISTORY_TRANSFER_PENDING_KEY, accountId), '1')
    return true
  } catch (error) {
    console.error('[health-sync] transfer state save failed:', error?.message || error)
    return false
  }
}

export function clearHealthHistoryTransferPending(accountId) {
  try {
    localStorage.removeItem(healthAccountKey(HEALTH_HISTORY_TRANSFER_PENDING_KEY, accountId))
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

export function validateHealthImportAcknowledgment(data, submittedCount) {
  const invalid = () => { throw Object.assign(new Error('Apple Health import acknowledgment is invalid. The history will be retried.'), { code: 'HEALTH_IMPORT_ACK_INVALID' }) }
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || !Number.isInteger(submittedCount) || submittedCount < 1
    || !['imported', 'skipped', 'errors'].every(key => own(data, key))
    || Object.keys(data).some(key => !['imported', 'skipped', 'errors', 'identity_decision_receipt'].includes(key))
    || !Number.isInteger(data.imported) || data.imported < 0 || data.imported > submittedCount
    || !Number.isInteger(data.skipped) || data.skipped < 0 || data.skipped > submittedCount
    || !Array.isArray(data.errors) || data.errors.length > submittedCount) invalid()
  const indexes = new Set()
  for (const row of data.errors) {
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).length !== 4 || !['index', 'error', 'code', 'retryable'].every(key => own(row, key))
      || !Number.isInteger(row.index) || row.index < 0 || row.index >= submittedCount || indexes.has(row.index)
      || typeof row.error !== 'string' || !row.error.trim() || typeof row.code !== 'string' || !row.code.trim()
      || typeof row.retryable !== 'boolean' || row.retryable !== (row.code !== 'IMPORT_ROW_INVALID')) invalid()
    indexes.add(row.index)
  }
  // importRows counts each submitted row exactly once: saved, skipped or failed.
  // Failed rows are NOT also counted as skipped. The identity receipt is metadata,
  // not an alternative acknowledgment or authority to fabricate missing totals.
  if (data.imported + data.skipped + data.errors.length !== submittedCount) invalid()
  return data
}

export async function importHealthWorkoutBatches(workouts, sendBatch, onBatchAcknowledged) {
  const result = { imported: 0, skipped: 0, errors: [] }
  let offset = 0

  for (const batch of createHealthImportBatches(workouts)) {
    try {
      const data = validateHealthImportAcknowledgment(await sendBatch(batch), batch.length)
      result.imported += data.imported
      result.skipped += data.skipped
      result.errors.push(...data.errors.map((item) => ({
        ...item,
        index: offset + item.index,
      })))
      offset += batch.length
      await onBatchAcknowledged?.(data)
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

export function createHealthSyncCoordinator(performSync, {
  deadlineMs = HEALTH_SYNC_OPERATION_DEADLINE_MS,
  schedule = (fn, ms) => globalThis.setTimeout(fn, ms),
  cancel = (id) => globalThis.clearTimeout(id),
  getIdentity = () => null,
  isCurrent = () => true,
} = {}) {
  if (typeof performSync !== 'function') throw new Error('Health sync coordinator requires an executor.')
  let activeOperation = null

  return {
    async run(options = {}) {
      const identity = getIdentity()
      const assertIdentity = () => {
        if (!isCurrent(identity)) throw Object.assign(new Error('Apple Health sync account changed.'), { code: 'HEALTH_SYNC_CANCELLED' })
      }
      const requestPermission = Boolean(options.requestPermission)
      const forceFresh = Boolean(options.forceFresh)
      // A newly observed workout cannot be acknowledged by a read already in
      // progress, even if that read itself was a manual/forceFresh request.
      const observedDuringOperation = options.afterActive ? activeOperation : null

      while (true) {
        assertIdentity()
        const sharedOperation = activeOperation
        if (sharedOperation) {
          try {
            const sharedResult = await sharedOperation.promise
            assertIdentity()
            const needsFreshOperation = (forceFresh && !sharedOperation.forceFresh) || sharedOperation === observedDuringOperation
            const needsPermissionOperation = requestPermission
              && !sharedOperation.requestPermission
              && sharedResult?.authorizationUpgradeRequired
            if (!needsFreshOperation && !needsPermissionOperation) {
              return sharedResult
            }
          } catch (error) {
            const canRetryFresh = (forceFresh && !sharedOperation.forceFresh) || sharedOperation === observedDuringOperation
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
        const controller = new AbortController()
        let rejectCancellation
        const cancelled = new Promise((resolve, reject) => { rejectCancellation = reject })
        operation.abort = (code = 'HEALTH_SYNC_CANCELLED') => {
          if (controller.signal.aborted) return
          const error = Object.assign(new Error(code === 'HEALTH_SYNC_TIMEOUT' ? 'Apple Health sync timed out; retry is available.' : 'Apple Health sync cancelled.'), { code })
          controller.abort(error)
          rejectCancellation(error)
        }
        const assertCurrent = () => {
          assertIdentity()
          if (controller.signal.aborted || activeOperation !== operation) {
            throw controller.signal.reason || Object.assign(new Error('Apple Health sync superseded.'), { code: 'HEALTH_SYNC_CANCELLED' })
          }
        }
        activeOperation = operation
        const timer = schedule(() => operation.abort('HEALTH_SYNC_TIMEOUT'), deadlineMs)
        operation.promise = Promise.race([
          cancelled,
          Promise.resolve().then(() => {
            assertCurrent()
            return performSync({ ...options, forceFresh, requestPermission, operation: { identity, signal: controller.signal, assertCurrent } })
          }).then((result) => { assertCurrent(); return result }),
        ])

        try {
          return await operation.promise
        } finally {
          cancel(timer)
          if (activeOperation === operation) activeOperation = null
        }
      }
    },
    hasActiveOperation() {
      return Boolean(activeOperation)
    },
    cancel() { activeOperation?.abort() },
  }
}

export async function runHealthAwarePageRefresh({
  authenticated = false,
  native = false,
  syncNativeData,
  syncConnectedProvider,
  onSourceSettled,
  afterHealthSync,
  onHealthSyncError,
  refreshPage,
  scheduleDeadline = (callback, delay) => globalThis.setTimeout(callback, delay),
  cancelDeadline = (deadlineId) => globalThis.clearTimeout(deadlineId),
} = {}) {
  let healthSyncAttempted = false
  let healthSyncResult = null
  let healthSyncError = null
  let providerResult = null
  let providerError = null
  let refreshError = null
  const sourceStates = { apple: authenticated && native ? 'pending' : 'not_attempted', strava: authenticated && syncConnectedProvider ? 'pending' : 'not_attempted' }
  const settled = (source, status) => {
    sourceStates[source] = status
    try { onSourceSettled?.(source, status) }
    catch (error) { console.warn('[activity-sync] status display unavailable') }
  }
  const providerPromise = authenticated && syncConnectedProvider
    ? Promise.resolve().then(syncConnectedProvider).then((result) => {
      providerResult = result
      settled('strava', result?.status || 'partial')
    }, (error) => { providerError = error; settled('strava', 'error') })
    : Promise.resolve()
  const suppressHealthEventRefreshes = Boolean(authenticated && native)

  if (suppressHealthEventRefreshes) activeHealthPullRefreshes += 1

  try {
    if (suppressHealthEventRefreshes || (authenticated && syncConnectedProvider)) {
      healthSyncAttempted = suppressHealthEventRefreshes
      let deadlineExpired = false
      let deadlineScheduled = false
      let deadlineId
      const nativePromise = suppressHealthEventRefreshes ? Promise.resolve().then(() => syncNativeData({
        forceFresh: true,
        afterActive: true,
        syncOrigin: HEALTH_SYNC_ORIGIN_PULL_REFRESH,
      })).then((result) => {
        healthSyncResult = result
        settled('apple', result?.complete === true ? 'complete' : 'partial')
      }, (error) => {
        healthSyncError = error; settled('apple', 'error')
        if (!deadlineExpired) {
          try { onHealthSyncError?.(error) }
          catch (reportingError) { console.warn('[healthSync] refresh error reporter failed') }
        }
      }) : Promise.resolve()
      const healthSyncPromise = Promise.all([nativePromise, providerPromise])
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
          reject(suppressHealthEventRefreshes && sourceStates.apple === 'pending'
            ? new HealthPullRefreshTimeoutError()
            : Object.assign(new Error('Activity sources are still syncing.'), { code: 'ACTIVITY_REFRESH_TIMEOUT' }))
        }, HEALTH_PULL_REFRESH_DEADLINE_MS)
        deadlineScheduled = true
      })
      try {
        await Promise.race([healthSyncPromise, deadlinePromise])
      } catch (error) {
        refreshError = error
        if (sourceStates.strava === 'pending') providerError = error
        if (suppressHealthEventRefreshes && sourceStates.apple === 'pending') healthSyncError = error
        try {
          if (suppressHealthEventRefreshes && sourceStates.apple === 'pending') onHealthSyncError?.(error)
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
      providerResult,
      providerError,
      refreshError,
      sourceStates: { ...sourceStates },
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

export function activityRefreshNotice(outcome) {
  const labels = { apple: 'Apple Health', strava: 'Strava' }
  const text = { pending: 'still syncing; saved runs will appear automatically', partial: 'partially synced; some data is unavailable', error: 'could not sync; try again', complete: 'synced', disconnected: 'not connected', cooldown: 'recently checked', cancelled: 'sync cancelled' }
  return Object.entries(outcome?.sourceStates || {}).filter(([, state]) => state !== 'not_attempted')
    .map(([source, state]) => `${labels[source]}: ${text[state] || text.partial}.`).join(' ')
}

export function getLastHealthSyncResult(accountId) {
  try {
    const parsed = JSON.parse(localStorage.getItem(healthAccountKey(HEALTH_SYNC_RESULT_KEY, accountId)) || 'null')
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (error) {
    console.warn('[health-sync] result lookup failed:', error?.message || error)
    return null
  }
}

export function shouldRefreshPageForHealthSyncEvent() {
  return activeHealthPullRefreshes === 0
}

export function announceHealthSyncResult(result, { complete = true, origin = null, accountId = null, assertCurrent = () => {} } = {}) {
  assertCurrent()
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
    localStorage.setItem(healthAccountKey(HEALTH_SYNC_RESULT_KEY, accountId), JSON.stringify(summary))
  } catch (error) {
    console.warn('[health-sync] result save failed:', error?.message || error)
  }

  if (typeof window !== 'undefined') {
    assertCurrent()
    const detail = { ...summary, metrics: result?.metrics || null, origin }
    window.dispatchEvent(new CustomEvent(HEALTH_SYNC_RESULT_EVENT, { detail }))
    assertCurrent()
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
export const ACTIVITY_DATA_CHANGED_EVENT = 'forge-activity-data-changed'
// Invalidation carries no token, measurements or provider exception text.
export function announceActivityDataChanged(source, session) {
  if (!isAuthSessionCurrent(session) || session.accountId !== getAuthenticatedUserId()) return false
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(ACTIVITY_DATA_CHANGED_EVENT, {
    detail: { source, accountId: session.accountId, generation: session.generation },
  }))
  return true
}

export function subscribeActivityDataChanged(callback) {
  const session = { ...getAuthSession(), accountId: getAuthenticatedUserId() }
  let active = true
  let reading = false, pending = false
  const current = () => active && isAuthSessionCurrent(session) && session.accountId === getAuthenticatedUserId()
  const read = () => {
    if (!current()) return
    if (reading) { pending = true; return }
    reading = true
    Promise.resolve().then(() => { if (current()) return callback(current, session) })
      .catch(() => console.warn('[activity-sync] data refresh unavailable'))
      .finally(() => { reading = false; if (pending) { pending = false; read() } })
  }
  const listener = (event) => {
    if (current() && event.detail?.accountId === session.accountId && event.detail?.generation === session.generation) read()
  }
  window.addEventListener(ACTIVITY_DATA_CHANGED_EVENT, listener)
  return () => { active = false; window.removeEventListener(ACTIVITY_DATA_CHANGED_EVENT, listener) }
}
