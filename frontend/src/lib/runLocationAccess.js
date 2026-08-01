export const RUN_LOCATION_STATUS = Object.freeze({
  IDLE: 'idle',
  CHECKING: 'checking',
  READY: 'ready',
  DENIED: 'denied',
  TIMEOUT: 'timeout',
  UNAVAILABLE: 'unavailable',
})

export function runLocationErrorStatus(error = {}) {
  const code = String(error?.code || '').toUpperCase()
  if (code === 'NOT_AUTHORIZED' || code === 'PERMISSION_DENIED' || Number(error?.code) === 1) {
    return RUN_LOCATION_STATUS.DENIED
  }
  if (code === 'TIMEOUT' || Number(error?.code) === 3) return RUN_LOCATION_STATUS.TIMEOUT
  return RUN_LOCATION_STATUS.UNAVAILABLE
}

function validPosition(position) {
  const latitude = Number(position?.latitude ?? position?.coords?.latitude)
  const longitude = Number(position?.longitude ?? position?.coords?.longitude)
  return Number.isFinite(latitude)
    && latitude >= -90
    && latitude <= 90
    && Number.isFinite(longitude)
    && longitude >= -180
    && longitude <= 180
}

export function canAcceptRunLocationPoint({
  watcherLifecycle,
  recordingActive,
  recordingEpoch,
  activeEpoch,
  latitude,
  longitude,
} = {}) {
  const isCurrentWatcher = watcherLifecycle?.accepts
    ? watcherLifecycle.accepts(recordingEpoch)
    : Boolean(recordingActive) && Number(recordingEpoch) === Number(activeEpoch)
  if (!isCurrentWatcher) return false
  return validPosition({ latitude, longitude })
}

export function createRunLocationWatcherLifecycle({ active = false } = {}) {
  let recordingActive = Boolean(active)
  let activeEpoch = 0

  return {
    begin() {
      activeEpoch += 1
      recordingActive = true
      return activeEpoch
    },
    stop() {
      recordingActive = false
      activeEpoch += 1
    },
    accepts(recordingEpoch) {
      return recordingActive && Number(recordingEpoch) === activeEpoch
    },
  }
}

export function createRunLocationWatcherCallbacks({
  watcherLifecycle,
  recordingEpoch,
  onLocation,
  onError,
} = {}) {
  const dispatch = (callback, value) => {
    if (!watcherLifecycle?.accepts?.(recordingEpoch)) return false
    callback?.(value)
    return true
  }

  return {
    location: (location) => dispatch(onLocation, location),
    error: (error) => dispatch(onError, error),
  }
}

export async function requestNativeRunLocation(plugin, timeoutMs = 15_000) {
  if (!plugin?.addWatcher || !plugin?.removeWatcher) {
    return { status: RUN_LOCATION_STATUS.UNAVAILABLE }
  }

  let watcherId = null
  let resolveResult
  const resultPromise = new Promise((resolve) => { resolveResult = resolve })
  let timeoutId
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ status: RUN_LOCATION_STATUS.TIMEOUT }), timeoutMs)
  })

  try {
    const watcherPromise = plugin.addWatcher({
      requestPermissions: true,
      stale: false,
      distanceFilter: 0,
    }, (position, error) => {
      if (error) {
        resolveResult({ status: runLocationErrorStatus(error), error })
        return
      }
      if (validPosition(position)) resolveResult({ status: RUN_LOCATION_STATUS.READY, position })
    })

    const registration = await Promise.race([
      watcherPromise.then((id) => ({ status: 'registered', id })),
      timeoutPromise,
    ])
    if (registration.status !== 'registered') {
      watcherPromise.then((id) => plugin.removeWatcher({ id })).catch((error) => {
        console.error('[run/location] timed-out watcher cleanup failed:', error?.message || error)
      })
      return { status: RUN_LOCATION_STATUS.TIMEOUT }
    }
    watcherId = registration.id

    const result = await Promise.race([resultPromise, timeoutPromise])
    return result
  } catch (error) {
    return { status: runLocationErrorStatus(error), error }
  } finally {
    clearTimeout(timeoutId)
    if (watcherId) {
      await plugin.removeWatcher({ id: watcherId }).catch((error) => {
        console.error('[run/location] preflight watcher cleanup failed:', error?.message || error)
      })
    }
  }
}

export function requestWebRunLocation(geolocation, timeoutMs = 15_000) {
  if (!geolocation?.getCurrentPosition) {
    return Promise.resolve({ status: RUN_LOCATION_STATUS.UNAVAILABLE })
  }

  return new Promise((resolve) => {
    geolocation.getCurrentPosition(
      (position) => resolve(validPosition(position)
        ? { status: RUN_LOCATION_STATUS.READY, position }
        : { status: RUN_LOCATION_STATUS.UNAVAILABLE }),
      (error) => resolve({ status: runLocationErrorStatus(error), error }),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 5_000 },
    )
  })
}

export function runLocationStatusMessage(status) {
  if (status === RUN_LOCATION_STATUS.DENIED) return 'Location access is off. Turn it on in iPhone Settings to record your route.'
  if (status === RUN_LOCATION_STATUS.TIMEOUT) return 'Forged Hybrid could not confirm a GPS fix. Move near an open area and try again.'
  if (status === RUN_LOCATION_STATUS.UNAVAILABLE) return 'Location is unavailable. Try again or continue without route tracking.'
  if (status === RUN_LOCATION_STATUS.CHECKING) return 'Checking iPhone Location access before the timer starts...'
  if (status === RUN_LOCATION_STATUS.READY) return 'Location connected. Route recording is ready.'
  return 'Location will be checked before the timer starts.'
}
