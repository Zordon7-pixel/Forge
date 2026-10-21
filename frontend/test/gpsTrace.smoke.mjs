import assert from 'node:assert/strict'
import { acceptGpsFix, createGpsTrace, gpsPaused, traceBoundary, setTraceAutoPause, splitTraceSegments, runElapsedSeconds, runPauseLabel, metersBetween } from '../src/lib/gpsTrace.js'
import { saveActiveRunSession, loadActiveRunSession, elapsedFromSession } from '../src/lib/activeRunSession.js'
const start = 1800000000000
const fix = (meters, seconds, accuracy = 3) => ({ lat: 0, lon: meters / 111194.92664455874, accuracy, altitudeMeters: 10, timestampMs: start + seconds * 1000 })
function recorder(options = {}) {
  let state = createGpsTrace({ startedAtMs: start, ...options }), points = [], gaps = []
  return { get state() { return state }, points, gaps,
    boundary(reason) { state = traceBoundary(state, reason) }, toggle(value) { state = setTraceAutoPause(state, value) },
    push(point, now = point.timestampMs) { const result = acceptGpsFix(state, point, now); state = result.state;
      if (result.point) {
        assert.equal(result.point[3], point.timestampMs, 'smoothed position retains accepted source time')
        assert.ok(Number.isFinite(result.point[0]) && Math.abs(result.point[0]) <= 90)
        assert.ok(Number.isFinite(result.point[1]) && Math.abs(result.point[1]) <= 180)
        const last = points.at(-1)
        const geometryDelta = last && last[5] === result.point[5] ? metersBetween(
          { lat: last[0], lon: last[1] }, { lat: result.point[0], lon: result.point[1] }) : 0
        assert.ok(Math.abs(result.distanceMeters - geometryDelta) < 1e-8, 'distance follows emitted geometry')
        points.push(result.point)
      }
      if (result.gap) gaps.push(result.gap); return result } }
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
// The product now requires a mature smoothed speed below .3 for ten full
// source-time seconds, and above .6 for three; raw first/second fixes cannot
// force a pause/resume. Auto-pause explicitly no longer breaks map segments.
for (let second = 0; second <= 30; second++) {
  const before = pause.state
  pause.push(fix(0, second))
  if (!before.autoPaused && pause.state.autoPaused) {
    assert.ok(pause.state.smoothedSpeedMps < .3)
    assert.equal(pause.state.lastFix.timestampMs - pause.state.stationarySinceMs, 10000)
  }
}
assert.equal(pause.state.autoPaused, true)
assert.equal(pause.push(fix(300, 31)).reason, 'speed')
assert.equal(pause.state.autoPaused, true)
pause.push(fix(1, 32)); assert.equal(pause.state.autoPaused, true)
assert.equal(pause.state.distanceMeters, 0); assert.equal(pause.points.length, 1)
let resumedAt = null
for (let second = 33; second <= 65; second++) {
  const before = pause.state
  pause.push(fix((second - 32) * 1.4, second))
  if (before.autoPaused && !pause.state.autoPaused) {
    resumedAt = second
    assert.ok(pause.state.smoothedSpeedMps > .6)
    assert.equal(pause.state.lastFix.timestampMs - pause.state.movingSinceMs, 3000)
  }
}
assert.ok(resumedAt > 35 && resumedAt < 55)
assert.equal(splitTraceSegments(pause.points).length, 1)
assert.equal(pause.gaps.length, 0)
pause.toggle(false)
for (let second = 66; second <= 100; second++) pause.push(fix(46.2, second))
assert.equal(pause.state.autoPaused, false)
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

// Supersedes the rejected test's auto-resume segment break and raw-anchor tail
// flush. Smoothed geometry retains the pre-stop leg and one continuous segment;
// bounded filter settling is measured instead of demanding a raw t=19 endpoint.
const stop = recorder()
for (let second = 0; second <= 19; second++) stop.push(fix(second * 1.4, second, 18))
const stopMeters = 19 * 1.4
assert.ok(stop.state.distanceMeters < stopMeters - 1, 'fixture has an undrawn moving tail')
for (let second = 20; second <= 45; second++) stop.push(fix(stopMeters, second, 18))
assert.equal(stop.state.autoPaused, true)
assert.ok(stop.state.distanceMeters >= stopMeters, 'pre-pause leg is retained through filter settling')
assert.ok(stop.points.every(point => point[3] >= start && point[3] <= start + 45000), 'only actual accepted source times')
const stoppedDistance = stop.state.distanceMeters
for (let second = 46; second <= 60; second++) stop.push(fix(stopMeters + (second % 2 ? 1 : -1), second, 18))
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
assert.ok(resumeResult.distanceMeters > 0, 'coordinate-confirmed resumed movement is retained')
assert.equal(resumeResult.point[6], null)
assert.equal(splitTraceSegments(stop.points).length, 1)
assert.equal(stop.gaps.length, 0)
const geometryMeters = splitTraceSegments(stop.points).reduce((sum, segment) => sum + segment.slice(1)
  .reduce((subtotal, point, i) => subtotal + Math.abs(point[1] - segment[i][1]) * 111194.92664455874, 0), 0)
assert.ok(Math.abs(geometryMeters - stop.state.distanceMeters) < .001, 'distance is exactly the continuous emitted smoothed geometry')

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


// Auto-pause OFF during a stop cannot manufacture a GPS gap or erase a pending
// manual boundary. OFF controls the clock; the position filter stays active.
const disabled = recorder()
for (let second = 0; second <= 30; second++) disabled.push(fix(0, second, 18))
assert.equal(disabled.state.autoPaused, true)
disabled.toggle(false); disabled.boundary('auto-pause-disabled')
for (let second = 31; second <= 70; second++) disabled.push(fix((second - 30) * 1.4, second, 18))
assert.equal(disabled.state.autoPaused, false)
assert.equal(disabled.gaps.length, 0)
assert.equal(splitTraceSegments(disabled.points).length, 1)
assert.equal(traceBoundary(traceBoundary(disabled.state, 'manual-pause'), 'auto-resume').boundary, 'manual-pause')
// Accuracy actually weights position; it is not merely a quality gate.
const weightedPosition = outlierAccuracy => {
  let trace = createGpsTrace({ startedAtMs: start })
  for (let t = 0; t <= 20; t++) trace = acceptGpsFix(trace,
    { ...fix(t * 1.4 + (t === 20 ? 4 : 0), t, t === 20 ? outlierAccuracy : 8) }, start + t * 1000).state
  return trace.filterPosition.lon
}
assert.ok(weightedPosition(1) > weightedPosition(20), 'more accurate observation receives more position weight')
// Source time and bounded memory, including high-frequency and irregular fixes.
const rapid = recorder()
for (let i = 0; i < 3000; i++) {
  rapid.push(fix(i * .03, i * .01, 8))
  assert.ok(rapid.state.movementWindow.length <= 64)
}
assert.equal(rapid.state.autoPaused, false)
assert.ok(Math.abs(rapid.state.distanceMeters / 89.97 - 1) < .05)
const irregular = recorder()
let elapsed = 0
for (let i = 0; i < 600; i++) {
  elapsed += [.5, 1.5, 2, 1][i % 4]
  irregular.push(fix(elapsed * 1.4, elapsed, 12))
}
assert.equal(irregular.state.autoPaused, false)
assert.equal(splitTraceSegments(irregular.points).length, 1)
assert.ok(Math.abs(irregular.state.distanceMeters / ((elapsed - .5) * 1.4) - 1) < .05)

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
          if (scenario.kind === 'stop' && (segmentCount !== 1 || pausesSeconds.length !== 1 || resumesSeconds.length !== 1
            || pausesSeconds[0] < 240 || pausesSeconds[0] > 275 || resumesSeconds[0] <= 330 || resumesSeconds[0] > 355
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

// BEGIN GAUSSIAN FIXTURES
// Predeclared: standstill/drift <=2m in 300s, zero false resumes; Gaussian is
// unbounded, independent per axis, 1Hz INCLUDING sigma3. Raw >7m/s is rejected.
function gaussianMeasurements() {
 const rows=[], epoch=1800000000000, scale=111194.92664455874
 // Includes the three formerly independent host seeds: these are regressions now.
 const seeds=process.env.GPS_EXTRA_SEEDS ? process.env.GPS_EXTRA_SEEDS.split(',').map(Number) : [1,42,20261020,7,123,8675309,314159,271828,20261021]
 for(const seed of seeds) for(const sigma of [1,2,3]) for(const accuracy of [8,14,20,'ramp']) {
  const scenarios=[... [1,1.2,1.4,3].map(speed=>({kind:'straight',speed,duration:600})),
   {kind:'stationary',speed:0,duration:300},{kind:'drift',speed:.1,duration:300},
   ...[1.4,3].flatMap(speed=>[{kind:'stop',speed,duration:540+(speed===3?60:90)},
    {kind:'outback',speed,duration:100/speed},{kind:'switchbacks',speed,duration:600/speed},
    {kind:'oval',speed,duration:600}])]
  for(const scenario of scenarios) {
   let rng=seed>>>0
   const uniform=()=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return (rng+.5)/4294967296}
   const noise=()=>Math.sqrt(-2*Math.log(uniform()))*Math.cos(2*Math.PI*uniform())*sigma
   let state=createGpsTrace({startedAtMs:epoch}),pausedFixes=0,discardedFixes=0,settledDistanceMeters=0
   const points=[],pauses=[],resumes=[]; const {kind,speed,duration}=scenario
   let maxWindow=0, acceptedFixes=0
   const stopEnd=240+(speed===3?60:90)
   const coord=t=>{
    let d=speed*t
    if(kind==='stop') d=speed*(Math.min(t,240)+Math.max(0,t-stopEnd))
    if(kind==='outback'||kind==='switchbacks') d=50-Math.abs(d%100-50)
    if(kind==='oval') {const radius=400/(2*Math.PI),a=speed*t/radius; return [radius*Math.sin(a),radius*(1-Math.cos(a))]}
    return [d,0]
   }
   const times=Array.from({length:Math.floor(duration)+1},(_,i)=>i)
   if(duration%1) times.push(duration)
   for(const t of times){
    const [x,y]=coord(t);const a=accuracy==='ramp'?5+15*t/duration:accuracy
    const f={lat:(y+noise())/scale,lon:(x+noise())/scale,accuracy:a,timestampMs:epoch+t*1000}
    // Missing and invalid speed share every matrix; a platform claim never drives it.
    if(seed===42) f.speed=[null,NaN,Infinity,-1,'1.4',{},true][Math.floor(t)%7]
    if(seed===20261020) f.speed=kind==='stationary'?3:speed
    const was=state.autoPaused,r=acceptGpsFix(state,f,f.timestampMs); state=r.state
    if(r.point)points.push(r.point)
    if(r.accepted)acceptedFixes++;else discardedFixes++
    if(state.autoPaused)pausedFixes++
    if(!was&&state.autoPaused)pauses.push(t)
    if(was&&!state.autoPaused)resumes.push(t)
    if(kind==='stop'&&t>=270&&t<=stopEnd)settledDistanceMeters+=r.distanceMeters
    maxWindow=Math.max(maxWindow,state.movementWindow?.length||0)
   }
   const expectedMeters=kind==='stationary'||kind==='drift'?0:kind==='stop'?540*speed:speed*duration
   const errorPercent=expectedMeters?100*(state.distanceMeters-expectedMeters)/expectedMeters:null
   const segments=splitTraceSegments(points).length,failures=[]
   if(segments!==1)failures.push('segments')
   if(kind==='stationary'||kind==='drift'){
    if(state.distanceMeters>2||!state.autoPaused||pauses.length!==1||resumes.length)failures.push('stationary/drift')
   }else{
    if(Math.abs(errorPercent)>(kind==='outback'||kind==='switchbacks'?10:5)) failures.push('distance')
    if(kind==='stop'){
     if(pauses.length!==1||resumes.length!==1||pauses[0]<250||pauses[0]>275||resumes[0]<stopEnd+3||resumes[0]>stopEnd+25||state.autoPaused||settledDistanceMeters>2)failures.push('stop/resume')
    }else if(pausedFixes)failures.push('false pause')
   }
   if(maxWindow>64)failures.push('unbounded')
   rows.push({...scenario,seed,sigma,accuracy,expectedMeters,actualMeters:state.distanceMeters,errorPercent,segments,pausedFixes,pauses,resumes,discardedFixes,acceptedFixes,counts:state.counts,settledDistanceMeters,maxWindow,pass:!failures.length,failures})
  }
 }
 return rows
}
// END GAUSSIAN FIXTURES
const gaussianRows = gaussianMeasurements()
for (const row of gaussianRows) console.log(JSON.stringify(row))
assert.deepEqual(gaussianRows.filter(row => !row.pass), [], 'unbounded 1Hz Gaussian sigma1–3 contracts')
console.log(`GAUSSIAN PASS: ${gaussianRows.length} measured scenarios`)

// BEGIN CURVATURE REGRESSIONS
// Geometry witnesses distinguish an actual trajectory correction from a distance
// multiplier. Clean curves isolate extrapolation bias from Gaussian scatter.
function curvatureMeasurements() {
 const rows=[],scale=6371000*Math.PI/180,epoch=1800000000000
 for(const shape of ['circle','ellipse']) for(const speed of [1.4,3]) for(const direction of [1,-1]) {
  const rx=shape==='circle'?400/(2*Math.PI):90,ry=shape==='circle'?rx:60
  let state=createGpsTrace({startedAtMs:epoch}),previousTruth,previousDraw,expectedMeters=0,geometryMeters=0
  const points=[],radial=[]
  for(let t=0;t<=600;t++){
   const a=direction*speed*t/rx,x=rx*Math.sin(a),y=ry*(1-Math.cos(a))
   const f={lat:y/scale,lon:x/scale,accuracy:20,timestampMs:epoch+t*1000}
   if(previousTruth)expectedMeters+=metersBetween(previousTruth,f)
   previousTruth=f
   const result=acceptGpsFix(state,f,f.timestampMs);state=result.state
   assert.equal(result.accepted,true,'clean curve passes the unchanged quality boundary')
   assert.equal(state.autoPaused,false,'continuous curved movement must not pause')
   if(result.point){
    assert.equal(result.point[3],f.timestampMs)
    points.push(result.point)
    const p={lat:result.point[0],lon:result.point[1]}
    if(previousDraw)geometryMeters+=metersBetween(previousDraw,p)
    previousDraw=p
    if(shape==='circle'&&t>=60)radial.push(Math.hypot(p.lon*scale,p.lat*scale-ry)-rx)
   }
  }
  const errorPercent=100*(state.distanceMeters/expectedMeters-1)
  const radialBiasMeters=radial.length?radial.reduce((s,v)=>s+v,0)/radial.length:null
  rows.push({shape,speed,direction,expectedMeters,actualMeters:state.distanceMeters,errorPercent,
   radialBiasMeters,geometryDeltaMeters:geometryMeters-state.distanceMeters,segments:splitTraceSegments(points).length})
 }
 return rows
}
// END CURVATURE REGRESSIONS
const curvatureRows=curvatureMeasurements()
for(const row of curvatureRows)console.log(JSON.stringify(row))
for(const row of curvatureRows){
 assert.equal(row.segments,1)
 assert.ok(Math.abs(row.geometryDeltaMeters)<1e-8,'distance exactly follows the drawn curve')
 assert.ok(Math.abs(row.errorPercent)<1.5,'clean curved position model has <1.5% bias')
 if(row.radialBiasMeters!==null)assert.ok(Math.abs(row.radialBiasMeters)<.75,'clean circle radial bias <0.75m')
}
console.log(`CURVATURE PASS: ${curvatureRows.length} geometry witnesses`)

// BEGIN EXACT FIRST FIX REGRESSIONS
function exactFirstFixMeasurements() {
 const rows=[],epoch=1800000000000
 for(const [lat,lon] of [[38.9,-76.95],[-33.865,151.209],[0,180],[0,-180],[-0,-0]]) {
  for(const boundary of ['initial','manual-pause','background','foreground','restore','timeout']) {
   let state=createGpsTrace({startedAtMs:epoch})
   if(boundary!=='initial') {
    state=acceptGpsFix(state,{lat:0,lon:0,accuracy:5,timestampMs:epoch},epoch).state
    state=acceptGpsFix(state,{lat:0,lon:.00001,accuracy:5,timestampMs:epoch+1000},epoch+1000).state
    if(boundary!=='timeout')state=traceBoundary(state,boundary)
   }
   const timestampMs=epoch+(boundary==='timeout'?16000:2000)
   const input={lat,lon,accuracy:4.5,altitudeMeters:14,timestampMs}
   const rejected=acceptGpsFix(state,{...input,accuracy:20.01},timestampMs)
   assert.equal(rejected.accepted,false)
   const result=acceptGpsFix(rejected.state,input,timestampMs)
   assert.equal(result.accepted,true)
   assert.deepEqual(result.point.slice(0,5),[lat,lon,14,timestampMs,4.5],'first/reset point preserves source numbers exactly')
   assert.ok(Object.is(result.state.filterPosition.lat,lat))
   assert.ok(Object.is(result.state.filterPosition.lon,lon))
   assert.equal(result.distanceMeters,0,'first/reset point never connects across a real boundary')
   assert.equal(result.point[5],boundary==='initial'?0:1)
   assert.equal(result.point[6],boundary==='initial'?null:boundary)
   rows.push({lat,lon,boundary,exact:true,connectorMeters:result.distanceMeters})
  }
 }
 return rows
}
const exactFirstFixRows=exactFirstFixMeasurements()
console.log(`EXACT FIRST FIX PASS: ${exactFirstFixRows.length} initial/manual/lifecycle/timeout cases`)
// END EXACT FIRST FIX REGRESSIONS
