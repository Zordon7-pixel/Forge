import { normalizeBackgroundRefreshStatus } from './gpsTrace.js'

export function normalizeRunReadiness(value = {}) {
  return {
    backgroundRefreshStatus: normalizeBackgroundRefreshStatus(value?.backgroundRefreshStatus),
    locationAuthorization: ['always', 'while_using', 'denied', 'restricted', 'not_determined'].includes(value?.locationAuthorization) ? value.locationAuthorization : 'unknown',
    accuracyAuthorization: ['precise', 'reduced'].includes(value?.accuracyAuthorization) ? value.accuracyAuthorization : 'unknown',
  }
}

export function runReadinessLine(value) {
  const status = normalizeRunReadiness(value)
  const location = { always: 'Always', while_using: 'While Using', denied: 'off', restricted: 'restricted (managed by iOS)', not_determined: 'not requested', unknown: 'unknown' }
  const accuracy = { precise: 'on', reduced: 'off', unknown: 'unknown' }
  return `Location: ${location[status.locationAuthorization]} · Precise: ${accuracy[status.accuracyAuthorization]}`
}

// Dependencies are injected for deterministic tests; the app owns one instance.
export function createRunReadiness({ nativeIOS, plugin, app, timeoutMs = 1200 }) {
  let current = normalizeRunReadiness(), revision = 0, owners = 0, listener = null
  let lifecycle = Promise.resolve(), explainerClaim = null
  let presentationPending = false
  const presenters = new Set()
  const present = () => {
    const fn = presenters.values().next().value
    if (presentationPending && fn) { presentationPending = false; fn() }
  }
  const subscribers = new Set()
  const publish = value => { current = value; for (const fn of subscribers) fn(current); return current }
  const bounded = async (operation, fallback) => {
    let timer
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise(resolve => {
        timer = setTimeout(() => resolve(fallback), timeoutMs)
      })])
    } catch { return fallback } finally { clearTimeout(timer) }
  }
  const refresh = async () => {
    const id = ++revision
    const result = nativeIOS
      ? await bounded(() => plugin.getStatus(), { backgroundRefreshStatus: 'error' })
      : { backgroundRefreshStatus: 'unavailable' }
    const value = normalizeRunReadiness(result)
    // Late replies cannot overwrite a newer start/foreground observation.
    if (id === revision) publish(value)
    return value
  }
  const reconcile = () => {
    lifecycle = lifecycle.then(async () => {
      if (owners && !listener) {
        let wasActive = true
        listener = await app.addListener('appStateChange', ({ isActive }) => {
          if (isActive === wasActive) return
          wasActive = isActive
          if (owners && isActive) void refresh()
        })
      }
      if (!owners && listener) {
        await listener.remove()
        listener = null
      }
    }).catch(() => {
      // A failed removal retains ownership so remount cannot duplicate the listener.
      publish(normalizeRunReadiness({ backgroundRefreshStatus: 'error' }))
    })
  }
  return {
    nativeIOS,
    snapshot: () => current,
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn) },
    refresh,
    mount() {
      if (!nativeIOS) return () => {}
      owners++
      reconcile()
      let closed = false
      return () => { if (!closed) { closed = true; owners--; reconcile() } }
    },
    presentExplainer(fn) {
      if (!nativeIOS) return () => {}
      presenters.add(fn)
      // StrictMode cleanup/remount and route changes share the pending claim.
      if (!explainerClaim) {
        explainerClaim = bounded(() => plugin.claimExplainer(), { first: false }).then(result => {
          presentationPending = result?.first === true
          present()
        })
      } else present()
      return () => presenters.delete(fn)
    },
    async prepareStart({ resume = false } = {}) {
      const [status, first] = await Promise.all([refresh(), nativeIOS && !resume
        ? bounded(() => plugin.claimFirstRun(), { first: false }) : null])
      return { status, requestPermissions: first?.first === true
        && ['not_determined', 'while_using'].includes(status.locationAuthorization) }
    },
    async openSettings() {
      if (!nativeIOS) return false
      const result = await bounded(() => plugin.openSettings(), { opened: false })
      return result?.opened === true // Navigation is never a status update.
    },
  }
}
