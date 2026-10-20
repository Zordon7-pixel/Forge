import assert from 'node:assert/strict'
import { acceptGpsFix, createGpsTrace, gpsPaused, traceBoundary, setTraceAutoPause, splitTraceSegments, runElapsedSeconds, runPauseLabel } from '../src/lib/gpsTrace.js'
import { saveActiveRunSession, loadActiveRunSession, elapsedFromSession } from '../src/lib/activeRunSession.js'
const start = 1800000000000
const fix = (meters, seconds, accuracy = 3) => ({ lat: 0, lon: meters / 111194.92664455874, accuracy, altitudeMeters: 10, timestampMs: start + seconds * 1000 })
function recorder(options = {}) {
  let state = createGpsTrace({ startedAtMs: start, ...options }), points = [], gaps = []
  return { get state() { return state }, points, gaps,
    boundary(reason) { state = traceBoundary(state, reason) }, toggle(value) { state = setTraceAutoPause(state, value) },
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

// The exact rejected-candidate reproduction: 600 accepted synthetic 1 Hz fixes.
// These exercise the exported policy, including the default-ON setting.
function walking(speed, accuracy, reportedSpeed, autoPauseEnabled = true) {
  const walk = recorder({ autoPauseEnabled })
  for (let second = 0; second < 600; second++) {
    const point = fix(second * speed, second, accuracy)
    if (reportedSpeed !== undefined) point.speed = reportedSpeed
    assert.equal(walk.push(point).accepted, true)
    assert.equal(walk.state.autoPaused, false, `walking must not pause at second ${second}`)
    assert.ok(walk.state.movementWindow.length <= 64)
  }
  const expected = 599 * speed
  assert.ok(Math.abs(walk.state.distanceMeters - expected) / expected <= .05,
    `walking ${speed}m/s accuracy ${accuracy}: ${walk.state.distanceMeters} vs ${expected}`)
  assert.equal(splitTraceSegments(walk.points).length, 1)
  assert.equal(walk.gaps.length, 0)
  return walk
}
const witness = walking(1.4, 18, 1.4)
console.log(JSON.stringify({ witness: '600 accepted 1Hz fixes, 1.4m/s, 18m accuracy',
  expectedMeters: 599 * 1.4, countedMeters: witness.state.distanceMeters,
  segments: splitTraceSegments(witness.points).length, autoPaused: witness.state.autoPaused }))
for (const speed of [1, 1.1, 1.2, 1.3, 1.4, 1.5]) {
  for (const accuracy of [10, 12, 15, 18, 20]) walking(speed, accuracy, speed)
}
// Both actual adapters can omit speed. No platform claim bypasses movement evidence.
for (const reportedSpeed of [undefined, null, NaN, Infinity, -Infinity, -1, 0, 1.4, 7, 8, '1.4', {}, true]) {
  walking(1.4, 18, reportedSpeed)
  const still = recorder()
  for (let second = 0; second <= 60; second++) {
    still.push({ ...fix(second % 2 ? 1 : 0, second, 18), speed: reportedSpeed })
  }
  assert.equal(still.state.autoPaused, true)
  assert.equal(still.state.distanceMeters, 0)
  assert.equal(still.points.length, 1)
}
const settledJitter = recorder()
for (let second = 0; second <= 20; second++) settledJitter.push(fix(0, second, 18))
for (let second = 25; second <= 100; second += 5) {
  assert.equal(settledJitter.push({ ...fix(second % 10 ? 15 : -15, second, 18), speed: 1.4 }).accepted, true)
  assert.equal(settledJitter.state.autoPaused, true, 'an isolated wobble after a stationary history cannot resume')
  assert.equal(settledJitter.state.distanceMeters, 0)
}
assert.equal(settledJitter.points.length, 1)
walking(1, 20, undefined, false)

// Inclusive product/readiness boundary, not the superseded 25m specification.
for (const accuracy of [20, 20.000001, 20.01, 25]) {
  const edge = recorder(), accepted = accuracy === 20
  const result = edge.push(fix(0, 0, accuracy))
  assert.equal(result.accepted, accepted)
  assert.equal(edge.state.ready, accepted)
  assert.equal(edge.points.length, accepted ? 1 : 0)
  if (!accepted) assert.equal(result.reason, 'accuracy')
}

// Preserve the legitimate tail below the accuracy drawing radius BEFORE a true
// stop. Resume must create a separate polyline and count no stationary connector.
const stop = recorder()
for (let second = 0; second <= 19; second++) stop.push(fix(second * 1.4, second, 18))
const stopMeters = 19 * 1.4
assert.ok(stop.state.distanceMeters < stopMeters - 1, 'fixture has an undrawn moving tail')
for (let second = 20; second <= 29; second++) stop.push(fix(stopMeters, second, 18))
assert.equal(stop.state.autoPaused, true)
assert.ok(Math.abs(stop.state.distanceMeters - stopMeters) < .001, 'pre-pause distance is retained')
assert.equal(stop.points.at(-1)[3], start + 19000, 'tail keeps the original moving timestamp')
const stoppedDistance = stop.state.distanceMeters
for (let second = 30; second <= 60; second++) stop.push(fix(stopMeters + (second % 2 ? 1 : -1), second, 18))
assert.equal(stop.state.autoPaused, true)
assert.equal(stop.state.distanceMeters, stoppedDistance)
const stoppedState = stop.state
for (const [point, now, reason] of [
  [fix(1000, 61, 18), start + 61000, 'speed'],
  [fix(stopMeters + 1, 61, 20.01), start + 61000, 'accuracy'],
  [fix(stopMeters + 1, 61, 18), start + 67000, 'stale'],
  [fix(stopMeters + 1, 62, 18), start + 61000, 'timestamp'],
  [fix(stopMeters + 1, 60, 18), start + 60000, 'order'],
]) {
  assert.equal(stop.push({ ...point, speed: 7 }, now).reason, reason)
  assert.equal(stop.state.autoPaused, true)
  assert.equal(stop.state.distanceMeters, stoppedDistance)
  assert.equal(stop.state.lastFix, stoppedState.lastFix)
  assert.equal(stop.state.movementWindow, stoppedState.movementWindow)
}
let resumeResult
for (let second = 61; second <= 90; second++) {
  const wasPaused = stop.state.autoPaused
  const result = stop.push(fix(stopMeters + (second - 60) * 1.4, second, 18))
  if (wasPaused && !stop.state.autoPaused) resumeResult = result
}
assert.ok(resumeResult, 'accepted sustained walking resumes automatically')
assert.equal(resumeResult.distanceMeters, 0)
assert.equal(resumeResult.point[6], 'auto-resume')
assert.equal(splitTraceSegments(stop.points).length, 2)
const geometryMeters = splitTraceSegments(stop.points).reduce((sum, segment) => sum + segment.slice(1)
  .reduce((subtotal, point, i) => subtotal + Math.abs(point[1] - segment[i][1]) * 111194.92664455874, 0), 0)
assert.ok(Math.abs(geometryMeters - stop.state.distanceMeters) < .001, 'no distance-only chord across pause')

// Manual/background/gap boundaries discard movement history and never count a
// connector, even with a large displacement or an enticing reported speed.
for (const reason of ['manual-pause', 'background', 'foreground', 'restore']) {
  const boundary = recorder()
  for (let second = 0; second <= 30; second++) boundary.push(fix(second * 1.4, second, 18))
  const before = boundary.state.distanceMeters
  boundary.boundary(reason)
  const result = boundary.push({ ...fix(1000, 31, 18), speed: 7 })
  assert.equal(result.distanceMeters, 0)
  assert.equal(boundary.state.distanceMeters, before)
  assert.equal(result.point[6], reason)
  assert.equal(result.gap.reason, reason)
  assert.equal(boundary.state.movementWindow.length, 1)
  assert.equal(splitTraceSegments(boundary.points).length, 2)
}
for (const gapSeconds of [14.999, 15, 15.001]) {
  const gap = recorder({ autoPauseEnabled: false })
  gap.push(fix(0, 0)); const result = gap.push(fix(6, gapSeconds))
  assert.equal(Boolean(result.gap), gapSeconds >= 15)
  assert.equal(result.distanceMeters === 0, gapSeconds >= 15)
}
for (const speed of [7, 7.001]) {
  const edge = recorder()
  edge.push(fix(0, 0))
  assert.equal(edge.push(fix(speed, 1)).accepted, speed === 7)
}
console.log('WALKING/STOP/BOUNDARY PASS: 30 walking cases, invalid speed fallback, stationary jitter, retained tail, true resume, rejection fencing, <=20m and <=7m/s')
console.log('GPS TRACE PASS: quality/readiness, 300m spike, ±15m jitter, 2% distance, exact gaps, clock/pause/resume, bounded counts, recovery')

// BEGIN SHARED NOISE FIXTURES: kept identical in the tracked regression.
function noiseMeasurements() {
  const measurements = []
  const epoch = 1800000000000, metersPerDegree = 111194.92664455874
  for (const seed of [1, 42, 20261020]) for (const accuracy of [18, 20]) {
    for (const amplitude of [1, 2, 3]) for (const speedMode of ['missing', 'invalid', 'valid']) {
      // At +/-3m, 1Hz independent noise can exceed 7m/s. 2s bounds the
      // worst 1.4m/s + noise step to hypot(8.8, 6)/2 < 7m/s.
      const intervalSeconds = amplitude === 3 ? 2 : 1
      const scenarios = [1, 1.2, 1.4].map(speed => ({ kind: 'walk', speed, fixes: 600 }))
      for (const duration of [60, 90, 300]) scenarios.push({ kind: 'stationary', speed: 0, fixes: duration / intervalSeconds + 1 })
      scenarios.push({ kind: 'stop', speed: 1.2, fixes: 570 / intervalSeconds + 1 })
      for (const scenario of scenarios) {
        let randomState = seed >>> 0
        const noise = () => { randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return (randomState / 4294967296 * 2 - 1) * amplitude }
        let state = createGpsTrace({ startedAtMs: epoch }), pausedFixes = 0, rejectedSpikes = 0, rejectedFixes = 0
        let stationaryDistanceMeters = 0, settledStationaryDistanceMeters = 0
        const points = [], pausesSeconds = [], resumesSeconds = []
        for (let i = 0; i < scenario.fixes; i++) {
          const seconds = i * intervalSeconds
          const trueMeters = scenario.kind === 'stop'
            ? scenario.speed * (Math.min(seconds, 240) + Math.max(0, seconds - 330)) : scenario.speed * seconds
          const point = { lat: noise() / metersPerDegree, lon: (trueMeters + noise()) / metersPerDegree,
            accuracy, timestampMs: epoch + seconds * 1000 }
          if (speedMode === 'valid') point.speed = scenario.speed
          if (speedMode === 'invalid') point.speed = [null, NaN, Infinity, -1, '1.2', {}, true][i % 7]
          const wasPaused = state.autoPaused, result = acceptGpsFix(state, point, point.timestampMs)
          state = result.state
          if (result.point) points.push(result.point)
          if (!result.accepted) rejectedFixes++
          if (result.reason === 'speed') rejectedSpikes++
          if (state.autoPaused) pausedFixes++
          if (!wasPaused && state.autoPaused) pausesSeconds.push(seconds)
          if (wasPaused && !state.autoPaused) resumesSeconds.push(seconds)
          if (scenario.kind === 'stationary' || (scenario.kind === 'stop' && seconds > 240 && seconds <= 330)) stationaryDistanceMeters += result.distanceMeters
          if (scenario.kind === 'stationary' || (scenario.kind === 'stop' && seconds >= 270 && seconds <= 330)) settledStationaryDistanceMeters += result.distanceMeters
        }
        const expectedDistanceMeters = scenario.kind === 'stop' ? 480 * scenario.speed : (scenario.fixes - 1) * intervalSeconds * scenario.speed
        const relativeError = expectedDistanceMeters ? (state.distanceMeters - expectedDistanceMeters) / expectedDistanceMeters : state.distanceMeters === 0 ? 0 : null
        const segmentCount = splitTraceSegments(points).length
        const failures = []
        if (rejectedFixes) failures.push('unexpected rejection')
        if (scenario.kind === 'stationary') {
          if (state.distanceMeters !== 0 || !state.autoPaused || pausesSeconds.length !== 1 || resumesSeconds.length) failures.push('stationary distance/pause')
        } else {
          if (Math.abs(relativeError) > .05) failures.push('distance error >5%')
          if (scenario.kind === 'walk' && (segmentCount !== 1 || pausedFixes !== 0)) failures.push('continuous walk interrupted')
          if (scenario.kind === 'stop' && (segmentCount !== 2 || pausesSeconds.length !== 1 || resumesSeconds.length !== 1
            || pausesSeconds[0] < 240 || pausesSeconds[0] > 265 || resumesSeconds[0] <= 330 || resumesSeconds[0] > 350
            || settledStationaryDistanceMeters !== 0 || state.autoPaused)) failures.push('stop/resume boundary')
        }
        measurements.push({ ...scenario, seed, accuracy, amplitude, speedMode, intervalSeconds,
          actualDistanceMeters: state.distanceMeters, expectedDistanceMeters, relativeError, segmentCount, pausedFixes,
          rejectedSpikes, rejectedFixes, pausesSeconds, resumesSeconds, stationaryDistanceMeters, settledStationaryDistanceMeters,
          pass: failures.length === 0, failures })
      }
    }
  }
  return measurements
}
// END SHARED NOISE FIXTURES
const noisyMeasurements = noiseMeasurements()
for (const measurement of noisyMeasurements) console.log(JSON.stringify(measurement))
assert.deepEqual(noisyMeasurements.filter(row => !row.pass), [], 'seeded noisy walk/stop/stationary contracts')
console.log(`SEEDED NOISE PASS: ${noisyMeasurements.length} measured fixtures`)
