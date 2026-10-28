import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createLegClient, createRouteEditor, elevationStats, geometricMeters, legKey, METERS_PER_MILE,
  MODE_LABELS, routePayload, turnaroundPoint, validateSavedRoute, routeError } from '../src/lib/manualRouteBuilder.js'
const require = createRequire(import.meta.url)
const { validateRoute } = require('../../backend/src/lib/userRoutes.js')
globalThis.fetch = () => { throw new Error('Live network forbidden') }
const A = [-73, 40], B = [-73.01, 40], C = [-73.02, 40], D = [-73.03, 40]
const response = (points, distanceMeters = 1000, profile = 'foot-walking') => ({ profile, geometry: { type: 'LineString', coordinates: points }, distanceMeters, durationSeconds: 600 })
const receipt = payload => ({ ...payload, id: '00000000-0000-4000-8000-000000000001', kind: 'planned', schemaVersion: 1, provenanceTrust: 'client_declared', createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z' })
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b }); return { resolve, reject, promise } }
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }
function fixture(request = async body => response(body.points, 1000, body.profile)) {
  let time = 0, next = 0
  const timers = new Map(), calls = []
  const client = createLegClient(body => { calls.push(body); return request(body) }, { now: () => time })
  const editor = createRouteEditor({ client, now: () => time,
    setTimer(fn, delay) { const id = ++next; timers.set(id, { at: time + delay, fn }); return id }, clearTimer(id) { timers.delete(id) } })
  return { editor, calls, client, async tick(ms = 300) { time += ms; for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); void timer.fn() } await flush() } }
}
let groups = 0
async function test(name, run) { await run(); groups++; console.log(`PASS ${name}`) }
await test('debounce selects latest pending waypoint; accepted legs are never rerouted', async () => {
  const f = fixture(); f.editor.setStart(A); f.editor.add(B); await f.tick(299); assert.equal(f.calls.length, 0)
  f.editor.add(C); await f.tick(299); assert.equal(f.calls.length, 0); await f.tick(1)
  assert.deepEqual(f.calls, [{ profile: 'foot-walking', points: [A, C] }]); assert.equal(f.editor.snapshot().legs.length, 1)
  f.editor.add(D); await f.tick(); assert.deepEqual(f.calls[1].points, [C, D]); assert.equal(f.editor.snapshot().distanceMeters, 2000)
})
await test('ordered normalized profile key, duplicate in-flight coalescing, cache and expiry', async () => {
  const d = deferred(); let calls = 0, now = 0
  const client = createLegClient(() => { calls++; return d.promise }, { now: () => now, ttl: 100 })
  const a = client.get('foot-walking', [A, B]), b = client.get('foot-walking', [[-73.0000001, 40], B])
  assert.equal(a, b); await flush(); assert.equal(calls, 1); d.resolve(response([A, B])); await a
  const cached = await client.get('foot-walking', [A, B]); cached.geometry.coordinates[0][0] = 0
  assert.deepEqual((await client.get('foot-walking', [A, B])).geometry.coordinates[0], A); assert.equal(calls, 1)
  assert.notEqual(legKey('foot-walking', [A, B]), legKey('foot-walking', [B, A]))
  assert.notEqual(legKey('foot-walking', [A, B]), legKey('foot-hiking', [A, B]))
  now = 100; await client.get('foot-walking', [A, B]); assert.equal(calls, 2)
  client.dispose(); await assert.rejects(client.get('foot-walking', [A, B]))
})
await test('stale success and failure cannot mutate after undo, clear, mode, profile or dispose', async () => {
  for (const action of ['undo', 'clear', 'mode', 'profile', 'dispose']) for (const fail of [false, true]) {
    const d = deferred(), f = fixture(() => d.promise)
    f.editor.setStart(A); f.editor.add(B); await f.tick()
    if (action === 'mode') f.editor.setMode('straight')
    else if (action === 'profile') f.editor.setProfile('foot-hiking')
    else f.editor[action]()
    const before = structuredClone(f.editor.snapshot())
    if (fail) d.reject(new Error('late failure')); else d.resolve(response([A, B]))
    await flush(); assert.deepEqual(f.editor.snapshot(), before, `${action}/${fail}`)
  }
})
await test('newer waypoint wins out-of-order responses; duplicate pending uses one request', async () => {
  const first = deferred(), second = deferred(); const f = fixture(body => body.points[1][0] === B[0] ? first.promise : second.promise)
  f.editor.setStart(A); f.editor.add(B); await f.tick(); f.editor.add(B); await f.tick(); assert.equal(f.calls.length, 1)
  f.editor.add(C); await f.tick(); second.resolve(response([A, C], 2345)); await flush(); first.resolve(response([A, B])); await flush()
  assert.deepEqual(f.editor.snapshot().waypoints, [A, C]); assert.equal(f.editor.snapshot().distanceMeters, 2345)
})
await test('ORS failures never fall back, bounded retry preserves accepted legs', async () => {
  let fail = false
  const f = fixture(async body => { if (fail) throw { response: { status: 429, headers: { 'retry-after': '2' } } }; return response(body.points) })
  f.editor.setStart(A); f.editor.add(B); await f.tick(); fail = true; f.editor.add(C); await f.tick()
  assert.equal(f.editor.snapshot().distanceMeters, 1000); assert.equal(f.editor.snapshot().legs.length, 1)
  assert.match(f.editor.snapshot().error.message, /limit/); f.editor.retry(); await f.tick(); assert.equal(f.calls.length, 2)
  fail = false; await f.tick(2000); f.editor.retry(); await f.tick(); assert.equal(f.editor.snapshot().distanceMeters, 2000)
  for (const error of [{ response: { status: 503 } }, { response: { status: 504, data: { error: 'PROVIDER_TIMEOUT' } } }, { code: 'ECONNABORTED' }]) assert.match(routeError(error).message, /kept/)
  assert.equal(routeError({ response: { status: 429, headers: { 'retry-after': '999999999' } } }).retryAfter, 86400)
})
await test('explicit straight-line labels, geometric distance, cumulative miles and undo/clear', async () => {
  const f = fixture(); f.editor.setStart(A); f.editor.add(B); await f.tick(); f.editor.setMode('straight'); f.editor.add(C)
  const state = f.editor.snapshot(); assert.equal(state.distanceMeters, 1000 + geometricMeters(B, C))
  assert.equal(state.legs[1].provenance, 'manual'); assert.equal(state.legs[1].profile, null); assert.equal(f.calls.length, 1)
  assert.equal(MODE_LABELS.straight, 'Planned straight line'); assert.equal(METERS_PER_MILE, 1609.344)
  f.editor.undo(); assert.equal(f.editor.snapshot().distanceMeters, 1000); f.editor.undo(); assert.equal(f.editor.snapshot().legs.length, 0)
  f.editor.clear(); assert.equal(f.editor.snapshot().waypoints.length, 0); assert.equal(f.editor.snapshot().canUndo, false)
})
await test('close loop requests just the final leg; out-and-back reverses geometry and provenance without requests', async () => {
  const f = fixture(); f.editor.setStart(A); f.editor.add(B); await f.tick(); f.editor.add(C); await f.tick()
  f.editor.closeLoop(); await f.tick(); assert.deepEqual(f.calls[2].points, [C, A]); assert.equal(f.editor.snapshot().distanceMeters, 3000)
  f.editor.undo(); const before = f.editor.snapshot(); f.editor.outAndBack(); const after = f.editor.snapshot()
  assert.equal(f.calls.length, 3); assert.deepEqual(after.coordinates, [A,B,C,B,A]); assert.equal(after.distanceMeters, 4000)
  assert.deepEqual(after.legs.map(l => [l.startIndex,l.endIndex]), [[0,1],[1,2],[2,3],[3,4]])
  assert.deepEqual(after.legs.map(l => l.provenance), ['ors','ors','ors','ors']); f.editor.undo(); assert.deepEqual(f.editor.snapshot().coordinates, before.coordinates)
})
await test('missing and partial elevation never bridge missing values or coerce null', () => {
  assert.deepEqual(elevationStats([A,B]), { coverage: 'missing', gainMeters: null, lossMeters: null })
  assert.deepEqual(elevationStats([[0,0,0],[1,0,20],[2,0,null],[3,0,500],[4,0,490]]), { coverage: 'partial', gainMeters: 20, lossMeters: 10 })
  assert.deepEqual(elevationStats([[0,0,0],[1,0,null]]), { coverage: 'partial', gainMeters: null, lossMeters: null })
  assert.deepEqual(elevationStats([[0,0,0],[1,0,0]]), { coverage: 'complete', gainMeters: 0, lossMeters: 0 })
})
await test('target halfway uses existing accumulated geometry; cannot extend or use provider distance as a fake path', () => {
  const segment = geometricMeters(A, B), halfway = turnaroundPoint([A,B,C], segment)
  assert.ok(Math.abs(halfway[0] - (A[0]+B[0])/2) < 1e-8)
  assert.equal(turnaroundPoint([A,B], segment * 3), null); assert.equal(turnaroundPoint([A,B], null), null)
  assert.deepEqual(turnaroundPoint([A,B], 2 * segment), B)
  assert.ok(Math.abs(Math.abs(turnaroundPoint([[179,0],[-179,0]], geometricMeters([179,0],[-179,0]))[0]) - 180) < 1e-8)
})
await test('save/load round-trips actual backend validator and loaded leg totals and undo; malformed data fail closed', async () => {
  const f = fixture(); f.editor.setStart(A); f.editor.add(B); await f.tick(); f.editor.setMode('straight'); f.editor.add(C)
  const payload = routePayload(f.editor.snapshot(), '26.2 course', 26.2 * METERS_PER_MILE)
  const raw = receipt(validateRoute(payload)); assert.deepEqual(validateSavedRoute(raw), raw)
  const loaded = fixture(); loaded.editor.load(raw); assert.equal(loaded.calls.length, 0); assert.equal(loaded.editor.snapshot().canUndo, true)
  loaded.editor.undo(); assert.equal(loaded.editor.snapshot().distanceMeters, 1000)
  assert.deepEqual(loaded.editor.snapshot().coordinates, [A, B]); assert.deepEqual(loaded.editor.snapshot().waypoints, [A, B])
  loaded.editor.load(raw)
  loaded.editor.add(D); await loaded.tick(); assert.equal(loaded.editor.snapshot().distanceMeters, payload.distanceMeters + 1000)
  loaded.editor.undo(); assert.equal(loaded.editor.snapshot().distanceMeters, payload.distanceMeters)
  loaded.editor.outAndBack(); assert.equal(loaded.editor.snapshot().distanceMeters, payload.distanceMeters * 2)
  validateRoute(routePayload(loaded.editor.snapshot(), 'Mirrored', null))
  for (const mutate of [r => r.kind = 'recorded', r => r.id = '../runs', r => r.geometry.coordinates[1][0] = '0', r => r.geometry.coordinates[0].push(Infinity), r => r.legs[0].endIndex = 99, r => r.legs[1].profile = 'foot-walking', r => r.elevation.coverage = 'complete', r => r.distanceMeters = null, r => r.waypoints.pop(), r => r.geometry.coordinates.push([0,0]), r => r.targetDistanceMeters = -1, r => r.elevation.source = 'invented', r => r.extra = 1]) {
    const bad = structuredClone(raw); mutate(bad); const before = loaded.editor.snapshot(); assert.throws(() => loaded.editor.load(bad)); assert.deepEqual(loaded.editor.snapshot(), before)
  }
})
await test('disconnected provider geometry fails closed, accepted geometry stays unchanged', async () => {
  let n = 0; const f = fixture(body => response(++n === 1 ? body.points : [D, body.points[1]]))
  f.editor.setStart(A); f.editor.add(B); await f.tick(); f.editor.add(C); await f.tick()
  assert.deepEqual(f.editor.snapshot().coordinates, [A,B]); assert.match(f.editor.snapshot().error.message, /does not join/)
})
await test('pre-dispatch transitions cancel debounce; hiking profile applies only to new legs', async () => {
  for (const action of ['undo','clear','profile','mode']) {
    const f=fixture(); f.editor.setStart(A); f.editor.add(B)
    if(action==='profile') f.editor.setProfile('foot-hiking')
    else if(action==='mode') f.editor.setMode('straight')
    else f.editor[action]()
    await f.tick(); assert.equal(f.calls.length,0)
  }
  const f=fixture(); f.editor.setStart(A); f.editor.add(B); await f.tick(); f.editor.setProfile('foot-hiking'); f.editor.add(C); await f.tick()
  assert.deepEqual(f.calls.map(call=>call.profile),['foot-walking','foot-hiking'])
  assert.deepEqual(f.editor.snapshot().legs.map(leg=>leg.profile),['foot-walking','foot-hiking'])
})
await test('cache eviction and failure are bounded; no failure is cached', async () => {
  let count=0, fail=false
  const client=createLegClient(async body=>{count++; if(fail) throw new Error('offline'); return response(body.points,10,body.profile)}, {maxEntries:1})
  await client.get('foot-walking',[A,B]); await client.get('foot-walking',[B,C]); await client.get('foot-walking',[A,B]); assert.equal(count,3)
  fail=true; await assert.rejects(client.get('foot-hiking',[A,B])); await assert.rejects(client.get('foot-hiking',[A,B])); assert.equal(count,5)
})
await test('mixed out-and-back preserves supplied heights and leg modes; pending response stays stale', async () => {
  const d=deferred(), f=fixture(()=>d.promise)
  f.editor.setStart(A); f.editor.setMode('straight'); f.editor.add(B); f.editor.setMode('routed'); f.editor.add(C); await f.tick()
  f.editor.outAndBack(); const state=f.editor.snapshot(); d.resolve(response([B,C])); await flush()
  assert.deepEqual(f.editor.snapshot(),state); assert.deepEqual(state.coordinates,[A,B,A]); assert.ok(state.legs.every(leg=>leg.mode==='straight'))
  const payload=routePayload(state,'Heights',null)
  payload.geometry.coordinates=[[...A,0],[...B,10],[...A,0]]; payload.elevation={source:'imported',coverage:'complete',gainMeters:10,lossMeters:10}
  f.editor.load(receipt(payload)); f.editor.outAndBack(); assert.deepEqual(elevationStats(f.editor.snapshot().coordinates),{coverage:'complete',gainMeters:20,lossMeters:20})
})
await test('invalid leg and route limits preserve accepted state', async () => {
  const f=fixture(body=>({...response(body.points),distanceMeters:NaN})); f.editor.setStart(A); f.editor.add(B); await f.tick()
  assert.equal(f.editor.snapshot().legs.length,0); assert.match(f.editor.snapshot().error.message,/invalid geometry/)
  const good=fixture(body=>response(body.points,600000)); good.editor.setStart(A); good.editor.add(B); await good.tick(); good.editor.outAndBack()
  assert.equal(good.editor.snapshot().distanceMeters,600000); assert.match(good.editor.snapshot().error.message,/limits/)
})
await test('legacy distances recover only authorized geometry or a single saved remainder; ambiguous totals stay unknown', async () => {
  const f=fixture(); f.editor.setStart(A); f.editor.add(B); await f.tick(); f.editor.add(C); await f.tick()
  const raw=receipt(validateRoute(routePayload(f.editor.snapshot(),'Legacy',null)))
  for(const leg of raw.legs) {delete leg.distanceMeters; delete leg.distanceSource}
  f.editor.load(raw); assert.equal(f.editor.snapshot().distanceMeters,2000)
  f.editor.undo(); assert.equal(f.editor.snapshot().distanceMeters,null); assert.deepEqual(f.editor.snapshot().coordinates,[A,B])
  assert.throws(()=>routePayload(f.editor.snapshot(),'Unknown',null))
  f.editor.undo(); assert.equal(f.editor.snapshot().distanceMeters,0); f.editor.undo(); assert.equal(f.editor.snapshot().canUndo,false)
  raw.legs[1].mode='straight'; raw.legs[1].profile=null; raw.legs[1].provenance='manual'
  f.editor.load(raw); const legs=f.editor.snapshot().legs
  assert.equal(legs[1].distanceMeters,geometricMeters(B,C)); assert.equal(legs[0].distanceSource,'saved_total_remainder')
  f.editor.undo(); assert.equal(f.editor.snapshot().distanceMeters,2000-geometricMeters(B,C))
  validateRoute(routePayload(f.editor.snapshot(),'Recovered',null))
})
await test('loaded undo invalidates pending routing and additive distance fields fail closed', async () => {
  const f=fixture(); f.editor.setStart(A); f.editor.add(B); await f.tick(); f.editor.add(C); await f.tick()
  const raw=receipt(validateRoute(routePayload(f.editor.snapshot(),'Known',null))), d=deferred(), loaded=fixture(()=>d.promise)
  loaded.editor.load(raw); loaded.editor.add(D); await loaded.tick(); loaded.editor.undo(); loaded.editor.undo()
  const before=structuredClone(loaded.editor.snapshot()); d.resolve(response([C,D],999)); await flush(); assert.deepEqual(loaded.editor.snapshot(),before)
  assert.equal(before.distanceMeters,1000)
  for(const patch of [{distanceMeters:-1},{distanceMeters:null},{distanceMeters:'1000'},{distanceSource:'geometry'},{distanceSource:'invented'},{distanceMeters:1001}]) {
    const bad=structuredClone(raw); Object.assign(bad.legs[0],patch)
    assert.throws(()=>validateSavedRoute(bad)); const {id,kind,schemaVersion,provenanceTrust,createdAt,updatedAt,...payload}=bad
    assert.throws(()=>validateRoute(payload))
  }
})
console.log(`PASS ${groups} deterministic manual-route groups; mocked providers only`)
