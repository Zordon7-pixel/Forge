// Executes the real component's hooks/handlers with a deterministic host, no device or network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import * as trace from '../src/lib/gpsTrace.js'
import * as watcher from '../src/lib/phoneGpsWatcher.js'
import * as controls from '../src/lib/activeRunControls.js'
import * as session from '../src/lib/activeRunSession.js'
import * as locationAccess from '../src/lib/runLocationAccess.js'
import * as planned from '../src/lib/activeRunPlannedRoute.js'
import * as live from '../src/lib/liveActivityState.js'
import * as elevation from '../src/utils/elevation.js'
const requireInstalled = createRequire(process.env.FORGE_TEST_MODULE_ROOT ? `${process.env.FORGE_TEST_MODULE_ROOT}/package.json` : import.meta.url)
const { transformSync } = createRequire(requireInstalled.resolve('vite'))('esbuild')
const code = transformSync(readFileSync(new URL('../src/pages/ActiveRun.jsx', import.meta.url),'utf8'), { loader:'jsx', format:'cjs', jsx:'automatic' }).code
function mount({ native = false, restored = null } = {}) {
  let now=1800000000000, cursor=0, dirty=true, tree, slots=[], effects=[], listeners=new Map(), intervals=new Map(), nextInterval=0
  let callback, watchCount=0, watchStops=0, maxWatchCount=0, payload, lastLive, closed=false
  const storage=new Map()
  const localStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}
  const subscribe=(name,fn)=>{ if(!listeners.has(name)) listeners.set(name,new Set()); listeners.get(name).add(fn) }
  const unsubscribe=(name,fn)=>listeners.get(name)?.delete(fn)
  const setInterval=fn=>{ intervals.set(++nextInterval,fn); return nextInterval }
  const clearInterval=id=>intervals.delete(id)
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]))
  const hooks={
    useState(initial){ const id=cursor++; if(!(id in slots)) slots[id]=typeof initial==='function'?initial():initial; return [slots[id],value=>{const next=typeof value==='function'?value(slots[id]):value;if(!Object.is(next,slots[id])){slots[id]=next;dirty=true}}] },
    useRef(value){const id=cursor++; return slots[id]??=( {current:value} )},
    useMemo(fn,deps){const id=cursor++;if(!slots[id]||!same(slots[id].deps,deps)) slots[id]={deps,value:fn()};return slots[id].value},
    useCallback(fn,deps){return hooks.useMemo(()=>fn,deps)},
    useEffect(fn,deps){const id=cursor++;if(!slots[id]||!same(slots[id].deps,deps)){const prior=slots[id];slots[id]={deps,cleanup:prior?.cleanup};effects.push(()=>{slots[id].cleanup?.();slots[id].cleanup=fn()})}},
  }
  const startWatch=cb=>{callback=cb;watchCount++;maxWatchCount=Math.max(maxWatchCount,watchCount);return 1}
  const stopWatch=()=>{watchStops++;watchCount--}
  const background={addWatcher:async(_opts,cb)=>startWatch(cb),removeWatcher:async()=>stopWatch(),openSettings:async()=>{}}
  const app={addListener:async(name,fn)=>{subscribe(name,fn);return {remove:()=>unsubscribe(name,fn)}}}
  const api={get:async()=>({data:{}}),post:async(_url,body)=>{payload=body;return {data:{id:'saved',run:body}}}}
  const navLocation={pathname:'/run/active',search:'',hash:'',state:{countdown:0}}
  const noop=()=>{}
  const modules={
    'react':hooks,'react/jsx-runtime':{jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props})},
    'react-router':{useLocation:()=>navLocation,useNavigate:()=>noop,Navigate:'Navigate'},
    'react-leaflet':{Polyline:'Polyline',CircleMarker:'CircleMarker',useMapEvents:noop},
    '@capacitor/app':{App:app},'@capacitor/core':{Capacitor:{isNativePlatform:()=>native},registerPlugin:()=>background},
    'lucide-react':{LocateFixed:'Icon',MapPinned:'Icon',Pause:'Icon',Play:'Icon'},
    '../components/maps/ForgeMap':{default:'ForgeMap'},
    '../context/UnitsContext':{useUnits:()=>({units:'imperial',fmt:{distance:(n)=>String(n),pace:n=>String(n),distanceLabel:'mi'}})},
    '../lib/api':{default:api},'../lib/offlineQueue':{queueRequest:async()=>{}},
    '../lib/dailyExecution':{planSessionIdFromState:()=>null,currentWeekFromState:()=>null},
    '../utils/elevation':elevation,'../lib/activeRunSession':{...session,loadActiveRunSession:()=>restored,saveActiveRunSession:noop,clearActiveRunSession:noop},
    '../lib/runProvenance':{buildPlannedSessionSnapshot:()=>null},
    '../lib/runCompletionPolicy':{resolveRunCompletion:()=>({}),RUN_PROVENANCE:{LIVE_TRACKED:'live_tracked'}},
    '../lib/runCompletionHandoff':{loadRunCompletionHandoff:()=>null,runCompletionNavigation:()=>null,saveRunCompletionHandoff:()=>null,buildRunCompletionSnapshot:()=>null},
    '../lib/auth':{getAuthenticatedUserId:()=>null},'../lib/tokenStore':{},
    '../lib/activeRunPlannedRoute':planned,'../lib/athleteLanguage':{ZONE_HEAT_PALETTE:Array(5).fill({})},
    '../lib/liveActivityState':{...live,buildLiveActivityUpdate:args=>{lastLive=live.buildLiveActivityUpdate({...args,now});return lastLive}},
    '../services/LiveActivityService':{default:{end:async()=>{},isPluginAvailable:()=>false}},
    '../lib/runLocationAccess':locationAccess,'../lib/groupRuns':{isGroupRunNavigationState:()=>false,groupRunIdFromNavigationState:()=>null},
    '../lib/activeRunControls':controls,'../lib/gpsTrace':trace,'../lib/phoneGpsWatcher':watcher,
  }
  const document={hidden:false,addEventListener:subscribe,removeEventListener:unsubscribe}
  const window={localStorage,setInterval,clearInterval,addEventListener:subscribe,removeEventListener:unsubscribe,
    matchMedia:()=>({matches:false}),location:navLocation,history:{pushState:noop,back:noop}}
  const context={module:{exports:{}},require:id=>{assert.ok(id in modules,`Unexpected import ${id}`);return {...modules[id],__esModule:true}},
    window,document,navigator:{geolocation:{watchPosition:cb=>startWatch(cb),clearWatch:stopWatch}},
    Date:class extends Date {static now(){return now}},URLSearchParams,setInterval,clearInterval,setTimeout:()=>0,clearTimeout:noop,console,
    crypto:{randomUUID:()=> 'synthetic-run'}}
  vm.runInNewContext(code,context)
  const Component=context.module.exports.default
  const flush=async()=>{for(let i=0;i<20;i++){await Promise.resolve();if(dirty){cursor=0;effects=[];dirty=false;tree=Component();for(const effect of effects) effect()}}}
  const nodes=()=>{const result=[];const walk=v=>{if(Array.isArray(v))return v.forEach(walk);if(!v||typeof v!=='object')return;result.push(v);walk(v.props?.children)};walk(tree);return result}
  const textOf=v=>Array.isArray(v)?v.map(textOf).join(''):typeof v==='object'&&v?textOf(v.props?.children):String(v??'')
  const find=id=>nodes().find(n=>n.props?.['data-testid']===id)
  const clickText=async(text)=>{const n=nodes().find(n=>n.type==='button'&&textOf(n)===text);assert.ok(n,`Missing ${text}`);assert.ok(!n.props.disabled);await n.props.onClick();await flush()}
  return { flush, find, nodes, text:()=>textOf(tree), clickText,
    get live(){return lastLive},get watches(){return watchCount},get maxWatches(){return maxWatchCount},get stops(){return watchStops},get payload(){return payload},
    async tick(seconds){now=1800000000000+seconds*1000;for(const fn of [...intervals.values()])fn();await flush()},
    async fix(meters,{accuracy=3,age=0}={}){const value={latitude:0,longitude:meters/111194.92664455874,altitude:10,accuracy};if(native)callback({...value,time:now-age});else callback({coords:value,timestamp:now-age});await flush()},
    async toggle(){await nodes().find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange();await flush()},
    async foreground(active){if(native){for(const fn of listeners.get('appStateChange')||[])fn({isActive:active})}else{document.hidden=!active;for(const fn of listeners.get('visibilitychange')||[])fn()}await flush()},
    listenerCount:name=>listeners.get(name)?.size||0,
    async close(){if(closed)return;closed=true;for(const slot of slots)slot?.cleanup?.();await flush()},
  }
}
for(const native of [false,true]) {
  const app=mount({native});await app.flush()
  assert.ok(app.nodes().find(n=>n.type==='input'&&n.props.type==='checkbox').props.checked)
  await app.clickText('Start Run');assert.equal(app.watches,1);assert.match(app.text(),/Connecting to GPS/)
  await app.fix(300,{accuracy:300});await app.fix(600,{age:6000});assert.equal(app.live.distance,0);assert.doesNotMatch(app.text(),/Route connected/);assert.equal(app.nodes().filter(n=>n.type==='CircleMarker'||n.type==='Polyline').length,0)
  await app.fix(0);assert.match(app.text(),/Route connected/)
  await app.tick(9.999);await app.fix(0);assert.ok(!app.find('auto-paused'))
  await app.tick(10);await app.fix(0);assert.ok(app.find('auto-paused'));assert.equal(app.live.elapsedSeconds,10);assert.equal(app.live.isPaused,true)
  await app.tick(12);await app.fix(300);await app.fix(1);assert.ok(app.find('auto-paused'));assert.equal(app.live.distance,0)
  await app.tick(14);await app.fix(7);assert.ok(!app.find('auto-paused'));assert.equal(app.live.elapsedSeconds,10)
  await app.tick(16);await app.fix(13);assert.ok(app.live.distance>0)
  const distance=app.live.distance
  await app.clickText('Pause');assert.equal(app.watches,0);assert.match(app.text(),/Run paused ·/)
  await app.tick(30);assert.equal(app.live.elapsedSeconds,12)
  await app.clickText('Resume');assert.equal(app.watches,1);await app.fix(100);assert.equal(app.live.distance,distance)
  await app.foreground(false);await app.foreground(true);await app.foreground(true)
  assert.equal(app.watches,1);assert.equal(app.maxWatches,1);assert.equal(app.listenerCount(native?'appStateChange':'visibilitychange'),1)
  await app.tick(32);await app.fix(200);assert.equal(app.live.distance,distance);assert.ok(app.find('gps-gap'))
  await app.tick(34);await app.fix(206)
  assert.equal(app.nodes().filter(n=>n.type==='Polyline').length,2, 'two independently drawn moving segments, no pause/return connector')
  await app.tick(53.999);assert.ok(!app.find('gps-paused'))
  await app.tick(54);assert.ok(app.find('gps-paused'));assert.equal(app.live.isPaused,false)
  await app.fix(300,{age:6000});assert.ok(app.find('gps-paused'))
  await app.fix(300);assert.ok(!app.find('gps-paused'))
  await app.toggle();await app.tick(64);await app.fix(300);assert.ok(!app.find('auto-paused'))
  await app.close();assert.equal(app.watches,0)
}

const automatic=mount();await automatic.flush();await automatic.clickText('Start Run');await automatic.fix(0)
await automatic.tick(10);await automatic.fix(0);assert.ok(automatic.find('auto-paused'))
await automatic.tick(18);await automatic.toggle();assert.ok(!automatic.find('auto-paused'))
await automatic.tick(23);assert.equal(automatic.live.elapsedSeconds,15);await automatic.fix(10);assert.equal(automatic.live.distance,0)
await automatic.toggle();await automatic.tick(33);await automatic.fix(10);assert.ok(automatic.find('auto-paused'))
await automatic.clickText('Pause');await automatic.toggle();await automatic.tick(40);assert.equal(automatic.live.elapsedSeconds,25)
await automatic.clickText('Resume');await automatic.tick(45);assert.equal(automatic.live.elapsedSeconds,30);await automatic.close()
const recovered=mount({restored:{phase:'paused',startedAt:1800000000000,elapsed:5,pauseStartedAt:1800000005000,mapMyRun:true,
  routeCoords:[[0,0,10,1800000000000,3],[0,0.00005,10,1800000002000,3]],distanceMiles:0.003}})
await recovered.flush();await recovered.tick(10);await recovered.clickText('Resume');await recovered.fix(100)
await recovered.tick(12);await recovered.fix(106)
assert.equal(recovered.nodes().filter(n=>n.type==='Polyline').length,2,'legacy five-slot route and resumed segment never join')
await recovered.close()
const off=mount({restored:{phase:'paused',startedAt:1800000000000,elapsed:5,pauseStartedAt:1800000005000,mapMyRun:false}})
await off.flush();await off.tick(10);await off.clickText('Resume');assert.equal(off.watches,0);assert.equal(off.live.gpsState,'off');assert.equal(off.nodes().filter(n=>n.type==='Polyline').length,0);await off.close()
console.log('ACTIVE RUN GPS PASS: actual component deterministic native/web hooks, early Start, status, auto/manual clocks, foreground dedup, gaps, route OFF, Live Activity')
