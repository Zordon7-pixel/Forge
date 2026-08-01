import assert from 'node:assert/strict'
import {
  requestNativeRunLocation,
  requestWebRunLocation,
  RUN_LOCATION_STATUS,
  runLocationStatusMessage,
} from '../src/lib/runLocationAccess.js'

const removed = []
const nativeReady = await requestNativeRunLocation({
  addWatcher: async (_options, callback) => {
    queueMicrotask(() => callback({ latitude: 38.9, longitude: -76.95 }, null))
    return 'ready-watcher'
  },
  removeWatcher: async ({ id }) => { removed.push(id) },
}, 100)
assert.equal(nativeReady.status, RUN_LOCATION_STATUS.READY)
assert.deepEqual(removed, ['ready-watcher'], 'the permission preflight never leaves a second GPS watcher alive')

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

console.log('RUN LOCATION ACCESS SMOKE OK (7)')
