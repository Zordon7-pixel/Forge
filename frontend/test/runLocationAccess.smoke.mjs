import assert from 'node:assert/strict'
import {
  canAcceptRunLocationPoint,
  requestNativeRunLocation,
  requestWebRunLocation,
  RUN_LOCATION_STATUS,
  runLocationStatusMessage,
} from '../src/lib/runLocationAccess.js'

const removed = []
let nativeWatcherOptions = null
const nativeReady = await requestNativeRunLocation({
  addWatcher: async (options, callback) => {
    nativeWatcherOptions = options
    queueMicrotask(() => callback({ latitude: 38.9, longitude: -76.95 }, null))
    return 'ready-watcher'
  },
  removeWatcher: async ({ id }) => { removed.push(id) },
}, 100)
assert.equal(nativeReady.status, RUN_LOCATION_STATUS.READY)
assert.equal(nativeWatcherOptions?.stale, false, 'preflight waits for a current GPS fix instead of accepting a stale cache')
assert.deepEqual(removed, ['ready-watcher'], 'the permission preflight never leaves a second GPS watcher alive')

const queuedPoint = {
  recordingEpoch: 4,
  latitude: 38.9,
  longitude: -76.95,
}
assert.equal(canAcceptRunLocationPoint({ ...queuedPoint, recordingActive: true, activeEpoch: 4 }), true)
assert.equal(canAcceptRunLocationPoint({ ...queuedPoint, recordingActive: false, activeEpoch: 5 }), false, 'a queued callback cannot append after pause')
assert.equal(canAcceptRunLocationPoint({ ...queuedPoint, recordingActive: true, activeEpoch: 6 }), false, 'a failed-to-remove old watcher stays invalid after resume')
assert.equal(canAcceptRunLocationPoint({ ...queuedPoint, recordingEpoch: 6, recordingActive: true, activeEpoch: 6 }), true)

const deniedRemoved = []
const nativeDenied = await requestNativeRunLocation({
  addWatcher: async (_options, callback) => {
    queueMicrotask(() => callback(null, { code: 'NOT_AUTHORIZED' }))
    return 'denied-watcher'
  },
  removeWatcher: async ({ id }) => { deniedRemoved.push(id) },
}, 100)
assert.equal(nativeDenied.status, RUN_LOCATION_STATUS.DENIED)
assert.deepEqual(deniedRemoved, ['denied-watcher'])

const webDenied = await requestWebRunLocation({
  getCurrentPosition: (_success, error) => error({ code: 1 }),
})
assert.equal(webDenied.status, RUN_LOCATION_STATUS.DENIED)
assert.match(runLocationStatusMessage(RUN_LOCATION_STATUS.DENIED), /iPhone Settings/)
assert.match(runLocationStatusMessage(RUN_LOCATION_STATUS.READY), /Location connected/)

console.log('RUN LOCATION ACCESS SMOKE OK (12)')
