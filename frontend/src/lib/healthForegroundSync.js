import { healthAccountKey } from './healthSync.js'
import { getAuthSession, isAuthSessionCurrent } from './tokenStore.js'

export const HEALTH_FOREGROUND_INTERVAL_MS = 5 * 60 * 1000
export const HEALTH_FOREGROUND_RETRY_MS = 30000
const pendingKey = (id) => healthAccountKey('forge.health.observerPending', id)

export async function syncConnectedStrava(api, session, { storage = localStorage, now = () => Date.now() } = {}) {
  if (!isAuthSessionCurrent(session) || !session.accountId) return
  const key = healthAccountKey('forge_auto_strava_sync_last_sync_at', session.accountId)
  let last = 0
  try { last = Number(storage.getItem(key) || 0) } catch (error) { console.warn('[AutoHealthSync] Strava timestamp lookup failed:', error?.message) }
  if (last && now() - last < 15 * 60 * 1000) return
  const status = await api.get('/strava/status', { forgeAuthSession: session })
  if (!isAuthSessionCurrent(session)) return
  if (status.data?.connected) await api.post('/strava/sync', undefined, { forgeAuthSession: session })
  if (!isAuthSessionCurrent(session)) return
  try { storage.setItem(key, String(now())) } catch (error) { console.warn('[AutoHealthSync] Strava timestamp save failed:', error?.message) }
}

// A foreground lifecycle owner, not background upload. The durable event marker
// is distinct from the service's native-anchor transfer checkpoint.
export function mountForegroundHealthSync({
  service, app, documentTarget, getAccountId,
  storage = localStorage, now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms), cancel = (id) => clearTimeout(id),
  afterSync = () => {}, onError = (error) => console.warn('[AutoHealthSync]', error?.message || error),
}) {
  let disposed = false
  let active = false
  let timer
  let sequence = 0
  const lastAttempt = new Map()
  const retryAfter = new Map()
  const pendingMemory = new Map()
  const handles = []
  const read = (key) => { try { return storage.getItem(key) } catch (error) { onError(error); return null } }
  const readPending = (id) => pendingMemory.has(id) ? pendingMemory.get(id) : read(pendingKey(id))
  const setPending = (id, value) => {
    pendingMemory.set(id, value)
    try {
      if (value === null) storage.removeItem(pendingKey(id))
      else storage.setItem(pendingKey(id), value)
    } catch (error) { onError(error) }
  }
  const arm = (delay) => {
    cancel(timer)
    if (!disposed) timer = schedule(() => { void sync('periodic') }, delay)
  }
  const sync = async (reason = 'periodic') => {
    if (disposed) return
    const id = getAccountId()
    const session = getAuthSession()
    if (!id) { arm(HEALTH_FOREGROUND_INTERVAL_MS); return }
    if (reason === 'workout') setPending(id, `${now()}:${++sequence}`)
    if (active) return
    const pending = readPending(id)
    const at = now()
    const failedUntil = retryAfter.get(id) || 0
    if (at < failedUntil) { arm(failedUntil - at); return }
    const persisted = Number(read(healthAccountKey('forge_auto_health_sync_last_sync_at', id)) || 0)
    const previous = Math.max(lastAttempt.get(id) || 0, persisted)
    if (reason !== 'cold' && !pending && previous && at - previous < HEALTH_FOREGROUND_INTERVAL_MS) {
      arm(HEALTH_FOREGROUND_INTERVAL_MS - (at - previous)); return
    }
    active = true
    lastAttempt.set(id, at)
    let complete = false
    try {
      const result = await service.syncNativeData({ forceFresh: Boolean(pending), afterActive: Boolean(pending) })
      if (disposed || getAccountId() !== id) return
      complete = result?.complete === true
      if (complete && pending && readPending(id) === pending) setPending(id, null)
      if (!complete) {
        if (!readPending(id)) setPending(id, `${now()}:${++sequence}`)
        retryAfter.set(id, now() + HEALTH_FOREGROUND_RETRY_MS)
      }
      else retryAfter.delete(id)
      // Optional enrichment never owns or holds the Apple sync latch.
      void Promise.resolve().then(() => {
        if (!disposed && isAuthSessionCurrent(session)) return afterSync({ ...session, accountId: id })
      }).catch(onError)
    } catch (error) {
      if (!disposed && getAccountId() === id) {
        if (!readPending(id)) setPending(id, `${now()}:${++sequence}`)
        retryAfter.set(id, now() + HEALTH_FOREGROUND_RETRY_MS)
        onError(error)
      }
    } finally {
      active = false
      if (!disposed) {
        const current = getAccountId()
        arm(current && readPending(current)
          ? (complete ? 0 : HEALTH_FOREGROUND_RETRY_MS)
          : (complete ? HEALTH_FOREGROUND_INTERVAL_MS : HEALTH_FOREGROUND_RETRY_MS))
      }
    }
  }
  const visible = () => { if (documentTarget.visibilityState === 'visible') void sync('resume') }
  documentTarget.addEventListener('visibilitychange', visible)
  const attach = (request) => {
    Promise.resolve(request).then((handle) => {
      if (disposed) handle?.remove?.()
      else if (handle) handles.push(handle)
    }).catch(onError)
  }
  try {
    attach(app.addListener('appStateChange', ({ isActive }) => { if (isActive) void sync('resume') }))
    attach(app.addListener('resume', () => { void sync('resume') }))
    attach(service.addWorkoutObserverListener(() => { void sync('workout') }))
  } catch (error) { onError(error) }
  void sync('cold')
  return {
    sync,
    dispose() {
      disposed = true
      cancel(timer)
      documentTarget.removeEventListener('visibilitychange', visible)
      handles.forEach((handle) => handle?.remove?.())
    },
  }
}
