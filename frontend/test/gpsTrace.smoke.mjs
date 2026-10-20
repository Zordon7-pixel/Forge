import assert from 'node:assert/strict'
import { acceptGpsFix, createGpsTrace, gpsPaused, traceBoundary, setTraceAutoPause, splitTraceSegments, runElapsedSeconds, runPauseLabel } from '../src/lib/gpsTrace.js'
import { saveActiveRunSession, loadActiveRunSession, elapsedFromSession } from '../src/lib/activeRunSession.js'
const start = 1800000000000
const fix = (meters, seconds, accuracy = 3) => ({ lat: 0, lon: meters / 111194.92664455874, accuracy, altitudeMeters: 10, timestampMs: start + seconds * 1000 })
function recorder(options = {}) {
  let state = createGpsTrace({ startedAtMs: start, ...options }), points = [], gaps = []
  return { get state() { return state }, points, gaps,
    boundary() { state = traceBoundary(state) }, toggle(value) { state = setTraceAutoPause(state, value) },
    push(point, now = point.timestampMs) { const result = acceptGpsFix(state, point, now); state = result.state;
      if (result.point) points.push(result.point); if (result.gap) gaps.push(result.gap); return result } }
}
const cold = recorder()
for (const point of [fix(0, 0, undefined), { ...fix(0, 1), accuracy: null }, fix(0, 2, 20.01), fix(0, 3, -1), { ...fix(0, 4), lat: NaN }, { ...fix(0, 5), timestampMs: undefined }]) {
  // Explicit undefined is a missing accuracy, not the fixture default.
  if (point.timestampMs === start) point.accuracy = undefined
  assert.equal(cold.push(point, start + 5000).accepted, false)
}
assert.equal(cold.state.ready, false); assert.equal(cold.points.length, 0)
assert.equal(cold.push(fix(0, 0), start + 5001).reason, 'stale')
assert.equal(cold.push(fix(0, 5, 20), start + 10000).accepted, true)
assert.equal(cold.state.ready, true); assert.equal(cold.points.length, 1); assert.equal(cold.state.distanceMeters, 0)
assert.equal(cold.push(fix(0, 11), start + 10000).reason, 'timestamp')
assert.equal(cold.push(fix(0, 5), start + 10000).reason, 'order')
const run = recorder({ autoPauseEnabled: false })
run.push(fix(0, 0))
for (let seconds = 1; seconds <= 100; seconds++) run.push(fix(seconds * 3, seconds))
assert.ok(Math.abs(run.state.distanceMeters - 300) / 300 <= .02)
const beforeSpike = run.points.length, beforeDistance = run.state.distanceMeters
assert.equal(run.push(fix(600, 101)).reason, 'speed')
assert.equal(run.points.length, beforeSpike); assert.equal(run.state.distanceMeters, beforeDistance)
assert.equal(run.push(fix(303, 102)).accepted, true)
const jitter = recorder()
jitter.push(fix(0, 0, 20))
for (let seconds = 5; seconds <= 100; seconds += 5) jitter.push(fix(seconds % 10 ? 15 : -15, seconds, 20))
assert.equal(jitter.points.length, 1); assert.equal(jitter.state.distanceMeters, 0)
assert.equal(jitter.state.autoPaused, true); assert.ok(jitter.state.counts.jitter > 0)
const tunnel = recorder({ autoPauseEnabled: false })
tunnel.push(fix(0, 0)); tunnel.push(fix(6, 2)); tunnel.push(fix(500, 17)); tunnel.push(fix(506, 19))
assert.equal(tunnel.gaps.length, 1); assert.equal(splitTraceSegments(tunnel.points).length, 2)
assert.ok(Math.abs(tunnel.state.distanceMeters - 12) / 12 < .02)
tunnel.boundary(); tunnel.push(fix(700, 20))
assert.equal(tunnel.gaps.length, 2); assert.equal(splitTraceSegments(tunnel.points).length, 3)
assert.ok(Math.abs(tunnel.state.distanceMeters - 12) / 12 < .02)
assert.equal(gpsPaused(tunnel.state, start + 39999), false)
assert.equal(gpsPaused(tunnel.state, start + 40000), true)
assert.equal(gpsPaused(createGpsTrace({ startedAtMs: start }), start + 20000), true)
tunnel.push(fix(710, 21), start + 40000)
assert.equal(gpsPaused(tunnel.state, start + 40000), true, 'stale samples cannot refresh liveness')
const pause = recorder()
assert.equal(pause.state.autoPauseEnabled, true)
pause.push(fix(0, 0)); pause.push(fix(0, 9.999)); assert.equal(pause.state.autoPaused, false)
pause.push(fix(0, 10)); assert.equal(pause.state.autoPaused, true)
assert.equal(pause.push(fix(300, 11)).accepted, false); assert.equal(pause.state.autoPaused, true)
pause.push(fix(1, 12)); assert.equal(pause.state.autoPaused, true)
assert.equal(pause.state.distanceMeters, 0); assert.equal(pause.points.length, 1)
pause.push(fix(7, 14)); assert.equal(pause.state.autoPaused, false); assert.equal(pause.state.distanceMeters, 0)
pause.push(fix(13, 16)); assert.ok(Math.abs(pause.state.distanceMeters - 6) < .01)
assert.equal(splitTraceSegments(pause.points).length, 2)
pause.toggle(false); pause.push(fix(13, 26)); pause.push(fix(13, 36)); assert.equal(pause.state.autoPaused, false)
assert.equal(runPauseLabel({ autoPaused: true }), 'Auto-paused')
assert.equal(runPauseLabel({ manualPaused: true, autoPaused: true }), 'Run paused')
assert.equal(runPauseLabel({ gpsIsPaused: true }), 'GPS paused')
assert.equal(runElapsedSeconds({ startedAt: start, pauseStartedAt: start + 10000 }, start + 40000), 10)
assert.equal(runElapsedSeconds({ startedAt: start, pausedDurationMs: 30000 }, start + 45000), 15)
const storage = { value: null, setItem(k,v) { this.value = v }, getItem() { return this.value }, removeItem() { this.value = null } }
saveActiveRunSession({ phase: 'running', startedAt: start, elapsed: 10, autoPaused: true, pauseStartedAt: start + 10000, routeCoords: tunnel.points }, 'synthetic', storage, start + 20000)
const restored = loadActiveRunSession('synthetic', storage, start + 30000)
assert.equal(splitTraceSegments(restored.routeCoords).length, 3)
assert.equal(elapsedFromSession(restored, start + 40000), 10)
assert.equal(restored.autoPauseEnabled, true)
let saturated = { ...cold.state, counts: { ...cold.state.counts, accuracy: 65535 } }
assert.equal(acceptGpsFix(saturated, fix(0, 12, 300), start + 12000).state.counts.accuracy, 65535)
assert.deepEqual(Object.keys(saturated.counts).sort(), ['accuracy','coordinates','jitter','order','speed','stale','timestamp'])
console.log('GPS TRACE PASS: quality/readiness, 300m spike, ±15m jitter, 2% distance, exact gaps, clock/pause/resume, bounded counts, recovery')
