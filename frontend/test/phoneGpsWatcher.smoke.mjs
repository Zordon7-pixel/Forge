import assert from 'node:assert/strict'
import { createPhoneGpsWatcher, createGpsForegroundHandler } from '../src/lib/phoneGpsWatcher.js'
import { acceptGpsFix, createGpsTrace } from '../src/lib/gpsTrace.js'
const now = 1800000000000
let pendingRegistration, callback, options, nextId = 0, maximumActive = 0
const active = new Set(), removed = [], received = [], errors = [], sources = []
const native = {
  addWatcher(settings, cb) { options = settings; callback = cb; return new Promise(resolve => {
    pendingRegistration = () => { const id = ++nextId; active.add(id); maximumActive = Math.max(maximumActive, active.size); resolve(id) }
  }) },
  async removeWatcher({id}) { active.delete(id); removed.push(id) },
}
const watcher = createPhoneGpsWatcher({ native, isNative: true, onFix: fix => received.push(fix), onError: code => errors.push(code), onSource: source => sources.push(source) })
const tick = async () => { for(let i=0;i<12;i++) await Promise.resolve() }
const first = watcher.start(); await tick()
assert.ok(options.distanceFilter >= 0 && options.distanceFilter <= 3)
const oldCallback = callback
const restart = watcher.restart(); pendingRegistration(); await first; await tick()
assert.equal(active.size, 0); assert.equal(removed.length, 1)
oldCallback({latitude:0,longitude:0,accuracy:3,time:now}); assert.equal(received.length, 0)
pendingRegistration(); await restart
callback({latitude:0,longitude:0,accuracy:3,time:now-6000})
assert.equal(received.at(-1).timestampMs, now-6000)
assert.equal(acceptGpsFix(createGpsTrace(), received.at(-1), now).reason, 'stale')
callback({latitude:0,longitude:0,accuracy:3,time:now})
assert.equal(acceptGpsFix(createGpsTrace(), received.at(-1), now).accepted, true)
let boundaries = 0, restarts = 0
const foreground = createGpsForegroundHandler({ boundary: () => boundaries++, restart: () => { restarts++; return watcher.restart() } })
foreground(true); foreground(false); foreground(false); foreground(true); foreground(true)
await tick(); pendingRegistration(); await tick()
assert.equal(boundaries, 2); assert.equal(restarts, 1); assert.equal(maximumActive, 1)
await watcher.stop(); assert.equal(active.size, 0)
const receivedCount = received.length; callback({latitude:0,longitude:0,accuracy:3,time:now}); assert.equal(received.length, receivedCount)
const lateStart = watcher.start(); await tick(); const stop = watcher.stop(); pendingRegistration(); await lateStart; await stop
assert.equal(active.size, 0); assert.equal(maximumActive, 1)
let webCallback, webOptions, webStarts=0, webStops=0
const web = { watchPosition(cb, _err, settings) { webStarts++; webCallback=cb; webOptions=settings; return 0 }, clearWatch(id) { assert.equal(id,0); webStops++ } }
const browser = createPhoneGpsWatcher({ native: { addWatcher: async () => { throw Error('synthetic') } }, web, isNative: true, onFix: fix => received.push(fix), onError: code => errors.push(code), onSource: source => sources.push(source) })
await browser.start(); assert.equal(webStarts,1); assert.equal(webOptions.maximumAge,0)
assert.deepEqual(errors,['unavailable']); assert.equal(sources.at(-1),'browser')
webCallback({coords:{latitude:0,longitude:0,accuracy:3},timestamp:now-6000})
assert.equal(received.at(-1).timestampMs,now-6000)
assert.equal(acceptGpsFix(createGpsTrace(),received.at(-1),now).reason,'stale')
await browser.stop(); assert.equal(webStops,1)
let blockedAdds = 0, failRemove = true
const blocked = createPhoneGpsWatcher({ native: { async addWatcher() { blockedAdds++; return 1 }, async removeWatcher() { if (failRemove) throw Error('synthetic') } }, isNative:true, onFix() {}, onError: code => errors.push(code) })
await blocked.start(); await blocked.restart(); assert.equal(blockedAdds,1, 'failed removal cannot start duplicate')
failRemove = false; await blocked.stop()
console.log('PHONE GPS WATCHER PASS: native/browser timestamp, fallback, serial restart, foreground dedup, pending-registration stop, failed-removal fencing')
