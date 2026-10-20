import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createPrivatePlanPicker, normalizePrivatePlan, plannedPresentation, privatePlanOverlay } from '../src/lib/activeRunPlannedRoute.js'
import { ACTIVE_RUN_SESSION_KEY, saveActiveRunSession, loadActiveRunSession, elapsedFromSession } from '../src/lib/activeRunSession.js'
import { finishedPhoneRoute } from '../src/lib/gpsTrace.js'
import { parseRunRouteSegments } from '../src/lib/runRecap.js'
import { activeRunMapCommand } from '../src/lib/activeRunControls.js'
const id='00000000-0000-4000-8000-000000000001'
const geometry=Array.from({length:10000},(_,i)=>[-73+i/1000000,40+i/1000000])
const route={id,name:'Private course',kind:'planned',schemaVersion:1,provenanceTrust:'client_declared',
  waypoints:[geometry[0],geometry.at(-1)],geometry:{type:'LineString',coordinates:geometry},
  legs:[{mode:'routed',profile:'foot-walking',provenance:'ors',startIndex:0,endIndex:9999,distanceMeters:1700,distanceSource:'ors'}],
  distanceMeters:1700,targetDistanceMeters:null,elevation:{source:null,coverage:'missing',gainMeters:null,lossMeters:null},
  display:{description:null,surface:null,elevationPreference:null}}
const {geometry:_,waypoints:__,legs:___,...summary}=route
const list={routes:[summary],limit:20,offset:0}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
let current=true,state,reply={data:{route}},calls=[]
const picker=createPrivatePlanPicker({ownerUserId:'alice',current:()=>current,onChange:value=>state=value,get:async(url,options)=>{
  calls.push({url,options});return url==='/user-routes'?{data:list}:reply
}})
await picker.list();assert.equal(state.routes.length,1)
await picker.select(id);assert.equal(state.selection.ownerUserId,'alice');assert.deepEqual(state.selection.route,route)
assert.equal(calls.every(call=>call.url.startsWith('/user-routes')),true)
const snapshot=structuredClone(state.selection),overlay=privatePlanOverlay(snapshot),presentation=plannedPresentation(overlay.coordinates)
assert.equal(overlay.coordinates.length,10000);assert.equal(presentation.positions.length,800);assert.equal(presentation.sampled,true)
assert.deepEqual(presentation.positions[0],[40,-73]);assert.deepEqual(presentation.positions.at(-1),geometry.at(-1).slice().reverse())
for(let i=1;i<800;i++)assert.ok(presentation.positions[i][0]>presentation.positions[i-1][0])
assert.deepEqual(plannedPresentation(overlay.coordinates),presentation)
assert.deepEqual(plannedPresentation([[null,0],['40',-73],[NaN,0],[91,0],[40,-73]]),{positions:[],sampled:false})
const recorded=Object.freeze([Object.freeze([40,-73,10,1000,4]),Object.freeze([40.001,-73.001,12,2000,5])])
const recording={phase:'running',startedAt:100000,savedAt:110000,elapsed:10,pausedDurationMs:0,distanceMiles:0.1,routeCoords:recorded,
  clientRunId:'canonical',gpsStarted:true,gpsAvailable:true,mapMyRun:true,gpsGapCount:2,gpsGapSeconds:90,discardedSegment:true,
  privatePlanChoice:true,plannedRouteSelection:snapshot}
const frozen=JSON.stringify(recording)
for(const mode of ['follow','overview','stats','overview','follow'])activeRunMapCommand(mode,{recordedPositions:recorded,plannedPositions:presentation.positions})
assert.equal(JSON.stringify(recording),frozen);assert.deepEqual(snapshot.route,route)
presentation.positions[0][0]=0;assert.equal(snapshot.route.geometry.coordinates[0][1],40)
const values=new Map(),storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}
saveActiveRunSession(recording,'alice',storage,110000)
const restored=loadActiveRunSession('alice',storage,115000)
assert.deepEqual(restored.routeCoords,recorded);assert.deepEqual(restored.plannedRouteSelection,snapshot)
assert.equal(elapsedFromSession(restored,115000),15);assert.equal(restored.distanceMiles,0.1);assert.equal(restored.gpsGapCount,2)
assert.equal(restored.plannedRouteSelection.route.geometry.coordinates.length,10000)
assert.equal(loadActiveRunSession('bob',storage,115000),null);assert.equal(values.size,0)
saveActiveRunSession({...recording,plannedRouteSelection:{...snapshot,ownerUserId:'bob'}},'alice',storage,110000)
assert.equal(loadActiveRunSession('alice',storage,115000).plannedRouteSelection,null)
assert.deepEqual(loadActiveRunSession('alice',storage,115000).routeCoords,recorded)
assert.equal(normalizePrivatePlan(snapshot,'bob'),null)
for(const mutate of [r=>r.kind='recorded',r=>r.user_id='bob',r=>r.geometry.coordinates[3][0]=null,r=>r.distanceMeters='1700',r=>r.legs[0].distanceMeters=0]){
  const bad=structuredClone(route);mutate(bad);reply={data:{route:bad}};await picker.select(id)
  assert.equal(state.selection,null);assert.match(state.error,/unavailable/)
}
reply=Promise.reject({response:{status:404}});await picker.select(id);assert.equal(state.selection,null)
reply={data:{route:{...route,id:'00000000-0000-4000-8000-000000000002'}}};await picker.select(id);assert.equal(state.selection,null)
let d=deferred();reply=d.promise;const pending=picker.select(id);await picker.select('');d.resolve({data:{route}});await pending;assert.equal(state.selection,null)
d=deferred();reply=d.promise;const stale=picker.select(id);current=false;picker.revoke();d.resolve({data:{route}});await stale;assert.equal(state.selection,null);assert.deepEqual(state.routes,[])
current=true;reply={data:{route}};await picker.select(id,{restore:true});assert.equal(state.selection.route.id,id)
picker.dispose()
// Optional selection is never spread into the canonical payload or completion.
const source=readFileSync(new URL('../src/pages/ActiveRun.jsx',import.meta.url),'utf8')
const payload=source.slice(source.indexOf('  const buildRunPayload ='),source.indexOf('  const syncPlanProgressAfterSave ='))
assert.doesNotMatch(payload,/privatePlan|plannedRoute/)
assert.match(payload,/route_coords: finishedPhoneRoute\(routeCoords\)/)
// The new persistence contract contains only recorded points and keeps the gap.
// A loaded 10,000-vertex plan must not supply even one missing recorded vertex.
const segmented = [recorded[0].concat([0, null]), recorded[1].concat([1, 'foreground'])]
const finished = finishedPhoneRoute(segmented)
assert.equal(finished.segments.length, 2)
assert.deepEqual(finished.segments.map(segment => segment.points.map(point => [point.lat, point.lon])), recorded.map(point => [point.slice(0, 2)]))
assert.deepEqual(finished.segments[1].gap, { kind: 'gps-gap', reason: 'foreground' })
assert.deepEqual(parseRunRouteSegments(JSON.stringify(finished)).map(segment => segment.positions.length), [1, 1])
assert.deepEqual(finishedPhoneRoute([]), { version: 2, segments: [] })
assert.deepEqual(recording.plannedRouteSelection, snapshot)
assert.equal(JSON.stringify(recording), frozen)
const lib=readFileSync(new URL('../src/lib/activeRunPlannedRoute.js',import.meta.url),'utf8')
assert.doesNotMatch(lib,/shared_routes|\/runs|queueRequest|api\.post|watchPosition/)
assert.match(source,/className="planned-route-overlay"/);assert.match(source,/className="recorded-route-overlay"/)
assert.match(source,/normalizePrivatePlan|createPrivatePlanPicker/)
assert.equal(values.has(ACTIVE_RUN_SESSION_KEY),true)
console.log('PASS private-only selection, malformed/not-found/identity rejection, auth/stale fences, full geometry persistence/resume, sampled endpoints/order, recorder immutability and canonical-payload separation')
