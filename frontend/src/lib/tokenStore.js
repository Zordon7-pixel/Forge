import { clearActiveRunSession } from './activeRunSession.js'
import { discardRunCompletionHandoff } from './runCompletionHandoff.js'

const TOKEN_KEY = 'forge_token'
const PUSH_EPOCH_KEY = 'forge_push_setup_auth_epoch'
let observedPushEpoch // undefined = first observation; null = observed storage unavailability.
let pushEpochObservationQueued = false
const POST_AUTH_REDIRECT_KEY = 'forge_post_auth_redirect'
const POST_AUTH_REDIRECT_TTL_MS = 24 * 60 * 60 * 1000
let authGeneration = 0
const authListeners = new Set()
const pushEpochListeners = new Set()

export function getAuthSession() {
  return { token: getToken(), generation: authGeneration }
}

export function isAuthSessionCurrent(session) {
  return Boolean(session?.token) && session.token === getToken() && session.generation === authGeneration
}

export function subscribeAuthSession(listener) {
  authListeners.add(listener)
  return () => authListeners.delete(listener)
}

export function subscribePushSetupEpoch(listener) {
  pushEpochListeners.add(listener)
  return () => pushEpochListeners.delete(listener)
}

function queuePushEpochObservation() {
  if (pushEpochObservationQueued) return
  pushEpochObservationQueued = true
  // A getter can repair missing/malformed storage in this very tab, which does
  // not receive a storage event. Never invoke live listeners inside a getter;
  // read the latest value later, coalescing repairs/rotations and delayed events.
  queueMicrotask(() => { pushEpochObservationQueued = false; invalidatePushEpoch(false) })
}

export function getPushSetupAuthEpoch() {
  try {
    let epoch = localStorage.getItem(PUSH_EPOCH_KEY)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(epoch || '')) {
      epoch = globalThis.crypto.randomUUID()
      localStorage.setItem(PUSH_EPOCH_KEY, epoch)
    }
    // A current-session check may read the new value before its queued storage
    // event. Reads must not consume that event's invalidation notification.
    if (observedPushEpoch === undefined) observedPushEpoch = epoch
    else if (observedPushEpoch !== epoch) queuePushEpochObservation()
    return epoch
  } catch {
    if (observedPushEpoch === undefined) observedPushEpoch = null
    else if (observedPushEpoch !== null) queuePushEpochObservation()
    return null
  }
}

function invalidatePushEpoch(rotate) {
  let previous = observedPushEpoch
  try {
    if (!previous && rotate) previous = localStorage.getItem(PUSH_EPOCH_KEY)
    if (rotate) localStorage.setItem(PUSH_EPOCH_KEY, globalThis.crypto.randomUUID())
    observedPushEpoch = localStorage.getItem(PUSH_EPOCH_KEY)
  } catch { observedPushEpoch = null }
  if (previous && previous !== observedPushEpoch) {
    import('./pushSetupStore.js').then(({ eraseSetupEpoch }) => eraseSetupEpoch(previous)).then((operations) => {
      for (const operation of operations) navigator.serviceWorker?.controller?.postMessage({ type: 'FORGE_PUSH_SETUP_ERASE', ...operation })
    }).catch(() => {}) // Fail closed: captured epoch checks still deny stale operations.
  }
  if (previous !== observedPushEpoch) for (const listener of pushEpochListeners) {
    try { listener() } catch { /* Notification cleanup cannot interrupt authentication. */ }
  }
}

function authChanged(rotatePushEpoch = true) {
  invalidatePushEpoch(rotatePushEpoch)
  authGeneration += 1
  for (const listener of authListeners) listener()
}

// Other same-origin tabs do not call this module's setToken/clearToken.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    // The originating tab rotates once. Other tabs invalidate without an epoch ping-pong.
    if (event.key === TOKEN_KEY || event.key === null) authChanged(false)
    else if (event.key === PUSH_EPOCH_KEY) invalidatePushEpoch(false)
  })
}

function safeInternalPath(value) {
  const path = String(value || '')
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.length > 600) return ''
  return path
}

export function getToken() {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(token) {
  const previousToken = localStorage.getItem(TOKEN_KEY)
  localStorage.setItem(TOKEN_KEY, token)
  if (previousToken !== String(token)) authChanged()
  // A successful reauthentication may issue byte-identical JWTs within one
  // signing second. Invalidate notification possession, not unrelated requests.
  else invalidatePushEpoch(true)
  if (previousToken !== null && previousToken !== String(token)) {
    clearActiveRunSession()
    discardRunCompletionHandoff()
  }
}

export function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY)
    localStorage.removeItem(POST_AUTH_REDIRECT_KEY)
  } finally {
    authChanged()
    clearActiveRunSession()
    discardRunCompletionHandoff()
  }
}

export function rememberPostAuthRedirect(path) {
  const safePath = safeInternalPath(path)
  if (!safePath) return
  localStorage.setItem(POST_AUTH_REDIRECT_KEY, JSON.stringify({ path: safePath, createdAt: Date.now() }))
}

export function consumePostAuthRedirect() {
  try {
    const value = JSON.parse(localStorage.getItem(POST_AUTH_REDIRECT_KEY) || 'null')
    localStorage.removeItem(POST_AUTH_REDIRECT_KEY)
    if (!value || Date.now() - Number(value.createdAt || 0) > POST_AUTH_REDIRECT_TTL_MS) return ''
    return safeInternalPath(value.path)
  } catch {
    localStorage.removeItem(POST_AUTH_REDIRECT_KEY)
    return ''
  }
}
