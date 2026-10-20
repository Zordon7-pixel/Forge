import { createRunLocationWatcherLifecycle, runLocationErrorStatus } from './runLocationAccess.js'
import { fixTimestampMs } from './gpsTrace.js'

// Serial ownership of exactly one watcher, including unresolved native registration.
export function createPhoneGpsWatcher({ native, web, isNative, onFix, onError, onSource }) {
  const lifecycle = createRunLocationWatcherLifecycle()
  let revision = 0, active = false, handle = null, queue = Promise.resolve()
  const clear = async () => {
    if (!handle) return
    // Retain the handle if removal fails; no replacement may create a duplicate.
    if (handle.native) await native.removeWatcher({ id: handle.id })
    else web.clearWatch(handle.id)
    handle = null
  }
  const reconcile = () => {
    const requestedRevision = ++revision
    lifecycle.stop()
    queue = queue.then(async () => {
      await clear()
      if (!active || requestedRevision !== revision) return
      const epoch = lifecycle.begin()
      const current = () => active && requestedRevision === revision && lifecycle.accepts(epoch)
      const error = value => { if (current()) onError(runLocationErrorStatus(value)) }
      if (isNative) {
        try {
          const id = await native.addWatcher({ backgroundMessage: 'Forged Hybrid is recording your run',
            backgroundTitle: 'Forged Hybrid', requestPermissions: true, stale: false, distanceFilter: 0 }, (fix, failure) => {
            if (!current()) return
            if (failure) return error(failure)
            if (fix) onFix({ lat: fix.latitude, lon: fix.longitude, altitudeMeters: fix.altitude,
              accuracy: fix.accuracy, timestampMs: fixTimestampMs(fix.time) })
          })
          handle = { id, native: true }
          if (!current()) await clear()
          else onSource?.('native_bg')
          return
        } catch {
          if (handle) throw new Error('watcher_cleanup')
          if (!current()) return
          onError('unavailable')
          // Registration failure permits the existing browser fallback; no raw errors logged.
        }
      }
      if (!web?.watchPosition) { error({}); return }
      const id = web.watchPosition(fix => {
        if (current()) onFix({ lat: fix.coords.latitude, lon: fix.coords.longitude,
          altitudeMeters: fix.coords.altitude, accuracy: fix.coords.accuracy, timestampMs: fix.timestamp })
      }, error, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 })
      handle = { id, native: false }
      onSource?.('browser')
    }).catch(() => { lifecycle.stop(); onError('unavailable') })
    return queue
  }
  return {
    start() { active = true; return reconcile() },
    restart() { return active ? reconcile() : queue },
    stop() { active = false; return reconcile() },
  }
}

// Use one platform event stream. Repeated active notifications do not restart twice.
export function createGpsForegroundHandler({ boundary, restart }) {
  let wasActive = true
  return isActive => {
    if (isActive === wasActive) return
    wasActive = isActive
    boundary(isActive ? 'foreground' : 'background')
    if (isActive) void restart()
  }
}
