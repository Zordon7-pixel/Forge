export const HEALTH_SYNC_COMPLETED_EVENT = 'forge-health-sync-completed'
export const HEALTH_IMPORT_BATCH_SIZE = 10
export const HEALTH_IMPORT_TIMEOUT_MS = 30000

const HEALTH_SYNC_RESULT_KEY = 'forge_last_health_sync_result'

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

export function getLastHealthSyncResult() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HEALTH_SYNC_RESULT_KEY) || 'null')
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch (error) {
    console.warn('[health-sync] result lookup failed:', error?.message || error)
    return null
  }
}

export function announceHealthSyncCompleted(result) {
  const scanned = Array.isArray(result?.workouts) ? result.workouts.length : Number(result?.scanned || result?.total || 0)
  const summary = {
    scanned: Number(scanned || 0),
    imported: Number(result?.imported || 0),
    skipped: Number(result?.skipped || 0),
    errors: Array.isArray(result?.errors) ? result.errors : [],
    authorizationUpgradeRequired: Boolean(result?.authorizationUpgradeRequired),
    syncedAt: new Date().toISOString(),
  }

  try {
    localStorage.setItem(HEALTH_SYNC_RESULT_KEY, JSON.stringify(summary))
  } catch (error) {
    console.warn('[health-sync] result save failed:', error?.message || error)
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(HEALTH_SYNC_COMPLETED_EVENT, {
      detail: { ...summary, metrics: result?.metrics || null },
    }))
  }

  return summary
}

export function healthSyncFailureMessage(error) {
  const message = String(error?.message || error || '')
  if (error?.code === 'ECONNABORTED' || /timeout|timed out/i.test(message)) {
    return 'Apple Health is taking longer than expected. Any completed batches are safely saved; keep Forged Hybrid open and try Sync again.'
  }
  return message || 'Unable to sync Apple Health on this device.'
}
