import assert from 'node:assert/strict'
import {
  canAcceptRunLocationPoint,
  consumeRunAutoStartState,
  createRunLocationWatcherCallbacks,
  createRunLocationWatcherLifecycle,
  requestNativeRunLocation,
  requestWebRunLocation,
  RUN_LOCATION_STATUS,
  runLocationStatusMessage,
} from '../src/lib/runLocationAccess.js'

const autoStart = consumeRunAutoStartState({
  autoStart: true,
  planSessionId: 'session-1',
  workoutTarget: { distanceMiles: 3 },
})
assert.equal(autoStart.requested, true)
assert.deepEqual(autoStart.state, {
  planSessionId: 'session-1',
  workoutTarget: { distanceMiles: 3 },
}, 'consuming auto-start preserves the scheduled workout handoff')
assert.deepEqual(consumeRunAutoStartState({ autoStart: false, runType: 'easy' }), {
  requested: false,
  state: { runType: 'easy' },
}, 'a false one-shot flag is removed without starting')
assert.deepEqual(consumeRunAutoStartState(null), { requested: false, state: {} })

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

const watcherLifecycle = createRunLocationWatcherLifecycle()
const receivedLocations = []
const receivedErrors = []
const firstEpoch = watcherLifecycle.begin()
const firstWatcher = createRunLocationWatcherCallbacks({
  watcherLifecycle,
  recordingEpoch: firstEpoch,
  onLocation: (location) => receivedLocations.push(location),
  onError: (error) => receivedErrors.push(error),
})
assert.equal(firstWatcher.location({ latitude: 38.9, longitude: -76.95 }), true)
assert.equal(receivedLocations.length, 1, 'the active watcher can deliver a current point')
assert.equal(canAcceptRunLocationPoint({
  watcherLifecycle,
  recordingEpoch: firstEpoch,
  latitude: 38.9,
  longitude: -76.95,
}), true)

watcherLifecycle.stop()
assert.equal(firstWatcher.location({ latitude: 38.91, longitude: -76.96 }), false, 'a queued point cannot append after pause')
assert.equal(firstWatcher.error({ code: 'TIMEOUT' }), false, 'a queued error cannot mutate state after pause')

const resumedEpoch = watcherLifecycle.begin()
const resumedWatcher = createRunLocationWatcherCallbacks({
  watcherLifecycle,
  recordingEpoch: resumedEpoch,
  onLocation: (location) => receivedLocations.push(location),
  onError: (error) => receivedErrors.push(error),
})
assert.equal(firstWatcher.location({ latitude: 38.92, longitude: -76.97 }), false, 'a failed-to-remove old watcher cannot append after resume')
assert.equal(firstWatcher.error({ code: 'NOT_AUTHORIZED' }), false, 'a failed-to-remove old watcher cannot disable a resumed run')
assert.equal(resumedWatcher.location({ latitude: 38.93, longitude: -76.98 }), true)
assert.equal(resumedWatcher.error({ code: 'TIMEOUT' }), true)
assert.equal(receivedLocations.length, 2)
assert.equal(receivedErrors.length, 1)

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

console.log('RUN LOCATION ACCESS SMOKE OK (23)')
