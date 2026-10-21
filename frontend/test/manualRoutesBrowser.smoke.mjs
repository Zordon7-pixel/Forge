// Mocked browser acceptance for the actual editor, ActiveRun and map. No live providers.
// Full host/cross-surface SPA and physical-device acceptance remain coordinator-owned.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium, expect } from '@playwright/test'
// BEGIN SUSTAINED ROUTE FIXTURE
function sustainedRouteFixes(startMs) {
  // 30 seconds at 1.4m/s, 1Hz. Each callback is delivered at its source time;
  // default-ON warm-up and sustained movement confirmation remain in force.
  return Array.from({length:31},(_,second)=>({
    coords:{latitude:40+second*1.4/111194.92664455874,longitude:-73,altitude:10+second/15,accuracy:5},
    timestamp:startMs+second*1000,
  }))
}
// END SUSTAINED ROUTE FIXTURE
const require = createRequire(import.meta.url)
const { validateRoute, toGpx } = require('../../backend/src/lib/userRoutes.js')
const root = fileURLToPath(new URL('..', import.meta.url)), artifacts = mkdtempSync(path.join(os.tmpdir(), 'forge-manual-routes-'))
mkdirSync(path.join(artifacts, 'no-env'))
process.chdir(root)
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {MemoryRouter,Routes,Route} from 'react-router';
import ActiveRun from '/src/pages/ActiveRun.jsx'; import {UnitsProvider} from '/src/context/UnitsContext.jsx';
import ManualRoutes from '/src/pages/ManualRoutes.jsx'; import {setToken} from '/src/lib/tokenStore.js';
import '/src/index.css'; import 'leaflet/dist/leaflet.css';
window.changeAccount=()=>setToken('synthetic.'+btoa(JSON.stringify({id:'other',exp:9999999999}))+'.synthetic');
createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={['/run/active']}><UnitsProvider>{location.pathname === '/active-test' ? <Routes><Route path="/run/active" element={<ActiveRun/>}/><Route path="*" element={<p>Synthetic recap handoff</p>}/></Routes> : <ManualRoutes/>}</UnitsProvider></MemoryRouter>);`
const server = await createServer({ root, configFile: false, envDir: path.join(artifacts, 'no-env'), cacheDir: path.join(artifacts, 'cache'),
  optimizeDeps: { noDiscovery: true, include: ['react','react-dom/client','react/jsx-runtime','react-router','react-leaflet','leaflet','lucide-react','axios','@capacitor/core','@capacitor/app'] },
  plugins: [react(), { name: 'manual-route-smoke', configureServer(s) { s.middlewares.use(async (req,res,next) => {
    if (!['/manual-test','/active-test'].includes(req.url)) return next()
    res.setHeader('Content-Type','text/html'); res.end(await s.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><main id="root" style="padding:16px;max-width:760px;margin:auto"></main><script type="module" src="/manual-entry.jsx"></script></body></html>'))
  }) }, resolveId(id) { if(id === '/manual-entry.jsx') return id }, load(id) { if(id === '/manual-entry.jsx') return entry } }],
  server: { host:'127.0.0.1',port:0 } })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] })
  const context = await browser.newContext({ viewport: {width:393,height:852}, serviceWorkers:'block', reducedMotion:'reduce', acceptDownloads:true })
  const page = await context.newPage(), errors = [], unexpected = [], calls = []
  let routes = [], corrupt = false, routeFailure = false, tiles = false, tileRequests = 0, missing = false, detailHold, savedRunPayload
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    localStorage.setItem('forge_token','synthetic.'+btoa(JSON.stringify({id:'route-smoke',exp:9999999999}))+'.synthetic')
    window.watchStarts=0; window.watchStops=0
    navigator.geolocation.watchPosition = success => { window.watchStarts++; window.emitPoint=success; return 1 }
    navigator.geolocation.clearWatch = () => {window.watchStops++}
    navigator.geolocation.getCurrentPosition = (_success, failure) => failure({code:1})
  })
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.hostname === 'api.thunderforest.com') { tileRequests++; return route.abort() }
    if (url.hostname !== '127.0.0.1') { if (url.hostname !== 'fonts.googleapis.com' && url.hostname !== 'fonts.gstatic.com') unexpected.push(url.origin); return route.fulfill({body:'',contentType:'text/css'}) }
    if (!url.pathname.startsWith('/api/')) return route.continue()
    assert.match(request.headers().authorization || '', /^Bearer synthetic\./)
    calls.push([request.method(),url.pathname])
    if (['/api/auth/me','/api/profile/hr-zones','/api/watch-sync/status','/api/users/settings'].includes(url.pathname)) return route.fulfill({json:{user:{id:'route-smoke'},zones:[],units:'imperial'}})
    if (url.pathname === '/api/runs' && request.method() === 'POST') {savedRunPayload=request.postDataJSON(); return route.fulfill({json:{id:savedRunPayload.id,run:savedRunPayload}})}
    if (url.pathname === '/api/meta/map-tiles') return route.fulfill({json:{THUNDERFOREST_API_KEY:tiles ? '0'.repeat(32) : null}})
    if (url.pathname === '/api/route-planning/leg') {
      const body = request.postDataJSON()
      assert.deepEqual(Object.keys(body).sort(),['points','profile']); assert.equal(body.points.length,2)
      if(routeFailure) return route.fulfill({status:503,json:{error:'PLANNING_UNAVAILABLE'}})
      return route.fulfill({json:{leg:{profile:body.profile,geometry:{type:'LineString',coordinates:body.points},distanceMeters:1609.344,durationSeconds:600}}})
    }
    if (url.pathname === '/api/user-routes' && request.method() === 'GET') return route.fulfill({json:{routes:routes.map(({geometry,legs,waypoints,...summary})=>summary),limit:20,offset:0}})
    if (url.pathname === '/api/user-routes' && request.method() === 'POST' || url.pathname.startsWith('/api/user-routes/') && request.method() === 'PUT') {
      const payload = validateRoute(request.postDataJSON())
      const saved = {...payload,id:request.method()==='PUT'?url.pathname.split('/').at(-1):`00000000-0000-4000-8000-${String(routes.length+1).padStart(12,'0')}`,kind:'planned',schemaVersion:1,provenanceTrust:'client_declared',createdAt:'2026-10-20T00:00:00Z',updatedAt:'2026-10-20T00:00:00Z'}
      routes = [...routes.filter(item=>item.id!==saved.id),saved]; return route.fulfill({status:request.method()==='POST'?201:200,json:{route:saved}})
    }
    if (url.pathname.startsWith('/api/user-routes/')) {
      const id=url.pathname.split('/')[3], saved=routes.find(item=>item.id===id)
      assert.ok(saved)
      if(request.method()==='DELETE') {routes=routes.filter(item=>item.id!==id); return route.fulfill({status:204})}
      if(url.pathname.endsWith('/gpx')) return route.fulfill({contentType:'application/gpx+xml',body:toGpx(saved)})
      await detailHold
      if(missing) return route.fulfill({status:404,json:{error:'USER_ROUTE_NOT_FOUND'}})
      return route.fulfill({json:{route:corrupt?{...saved,kind:'recorded'}:saved}})
    }
    unexpected.push(url.pathname); return route.abort()
  })
  const url=`http://127.0.0.1:${server.httpServer.address().port}/manual-test`
  if (!process.argv.includes('--active-only')) {
  await page.goto(url)
  await expect(page.getByRole('heading',{name:'Build your route'})).toBeVisible()
  await expect(page.getByTestId('forge-map')).toHaveAttribute('data-map-state','unavailable')
  await page.getByRole('button',{name:'Start at current location',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('Could not get your location')
  await expect(page.locator('.leaflet-overlay-pane path')).toHaveCount(0)
  const map=page.locator('.leaflet-container')
  await map.hover(); let box=await map.boundingBox()
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2); await page.mouse.down(); await page.waitForTimeout(650); await page.mouse.up()
  await expect(page.locator('.leaflet-overlay-pane path')).toHaveCount(1)
  await page.getByLabel('New leg mode').selectOption('straight')
  await expect(page.getByRole('status').filter({hasText:'Planned straight line'})).toBeVisible()
  await map.click({position:{x:240,y:230}})
  await expect(page.getByText('1 accepted legs · 1 planned straight-line legs (dashed)',{exact:true})).toBeVisible()
  assert.equal(calls.filter(call=>call[1]==='/api/route-planning/leg').length,0)
  await page.getByLabel('Target distance (miles, optional)').fill('26.2')
  await page.getByLabel('Route name',{exact:true}).fill('Offline private course')
  await page.getByRole('button',{name:'Save private route',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Offline private course',exact:true})).toBeVisible()
  const firstDistance=routes[0].distanceMeters
  await page.getByRole('button',{name:'Out-and-back',exact:true}).click()
  await page.getByRole('button',{name:'Update private route',exact:true}).click()
  await expect.poll(()=>routes[0].distanceMeters).toBe(firstDistance*2)
  const download=page.waitForEvent('download'); await page.getByRole('button',{name:'GPX',exact:true}).click(); assert.match((await download).suggestedFilename(),/^planned-route-.*\.gpx$/)
  await page.getByRole('button',{name:'Clear',exact:true}).click()
  corrupt=true; await page.getByRole('button',{name:'Load / edit',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('Load route failed'); await expect(page.locator('.leaflet-overlay-pane path')).toHaveCount(0)
  corrupt=false; await page.getByRole('button',{name:'Load / edit',exact:true}).click()
  await expect(page.getByText(/Undo removes the latest waypoint and leg/)).toBeVisible()
  await expect(page.getByRole('button',{name:'Undo',exact:true})).toBeEnabled()
  await page.getByRole('button',{name:'Undo',exact:true}).click()
  await expect(page.getByText('1 accepted legs · 1 planned straight-line legs (dashed)',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'Load / edit',exact:true}).click()
  await page.getByLabel('New leg mode').selectOption('routed'); routeFailure=true
  await page.getByRole('button',{name:'Add map center waypoint',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('Could not route this leg')
  assert.equal(routes[0].distanceMeters,firstDistance*2)
  await expect(page.getByRole('button',{name:'Update private route',exact:true})).toBeDisabled()
  await page.getByRole('button',{name:'Undo',exact:true}).click()
  await expect(page.getByRole('button',{name:'Update private route',exact:true})).toBeEnabled()
  for(const width of [393,320]) {
    await page.setViewportSize({width,height:852})
    await expect(page.getByTestId('map-attribution')).toHaveText('Maps © Thunderforest, Data © OpenStreetMap contributors')
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`no overflow ${width}`)
    assert.equal(await page.locator('.manual-route-map-center').evaluate(el=>{
      const control=el.getBoundingClientRect(), map=el.closest('.leaflet-container').getBoundingClientRect()
      return control.top > map.top + map.height / 2 && control.bottom <= map.bottom
    }),true,'map-center control stays at bottom, clear of provider indicator')
    for(const name of ['Thunderforest','OpenStreetMap contributors']) {
      const link=page.getByRole('link',{name,exact:true}); await link.scrollIntoViewIfNeeded(); await expect(link).toBeVisible()
      assert.ok(await link.evaluate(el=>[...el.getClientRects()].every(r=>r.left>=0&&r.right<=innerWidth)))
    }
    for(const button of await page.locator('.manual-routes button').all()) assert.ok(await button.evaluate(el=>el.getBoundingClientRect().height>=44))
    await page.screenshot({path:path.join(artifacts,`manual-${width}.png`),fullPage:true})
  }
  assert.equal(tileRequests,0,'missing key performs no tile requests')
  await page.getByRole('button',{name:'Delete',exact:true}).click(); await page.getByRole('button',{name:'Confirm delete',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Offline private course',exact:true})).toHaveCount(0)
  tiles=true; await page.reload(); await expect(page.getByTestId('forge-map')).toHaveAttribute('data-map-state','unavailable'); assert.ok(tileRequests>0)
  await page.evaluate(()=>{navigator.geolocation.getCurrentPosition=success=>success({coords:{longitude:-73,latitude:40}})})
  await page.getByRole('button',{name:'Start at current location',exact:true}).click()
  await expect(page.locator('.leaflet-overlay-pane path')).toHaveCount(1)
  routeFailure=false
  await map.click({position:{x:190,y:230}})
  await expect(page.getByText('1 accepted legs',{exact:true})).toBeVisible()
  await expect(page.locator('.manual-route-metrics')).toContainText('1.00')
  await page.getByLabel('Routing profile').selectOption('foot-hiking')
  await page.getByRole('button',{name:'Add map center waypoint',exact:true}).click()
  await expect(page.getByText('2 accepted legs',{exact:true})).toBeVisible()
  await expect(page.locator('.manual-route-metrics')).toContainText('2.00')
  await page.getByRole('button',{name:'Clear',exact:true}).click()
  await page.getByRole('button',{name:'Use map center as start',exact:true}).click()
  await expect(page.locator('.leaflet-overlay-pane path')).toHaveCount(1)
  await page.evaluate(()=>window.changeAccount()); await expect(page.getByRole('heading',{name:'Account changed'})).toBeVisible()
  await expect(page.getByTestId('forge-map')).toHaveCount(0)
  }
  if(process.argv.includes('--active-only')) await page.goto(url)
  // A saved 10,000-vertex private course; no routing/provider access to construct it.
  const plannedCoords=Array.from({length:10000},(_,i)=>[-73+i/1000000,40+i/1000000])
  const privateRoute={...validateRoute({name:'Private marathon reference '+ 'x'.repeat(80),waypoints:[plannedCoords[0],plannedCoords.at(-1)],
    geometry:{type:'LineString',coordinates:plannedCoords},legs:[{mode:'routed',provenance:'ors',profile:'foot-walking',startIndex:0,endIndex:9999,distanceMeters:42195,distanceSource:'ors'}],
    distanceMeters:42195,targetDistanceMeters:null}),id:'00000000-0000-4000-8000-000000000099',kind:'planned',schemaVersion:1,provenanceTrust:'client_declared'}
  routes=[privateRoute]; tiles=false
  const activeUrl=url.replace('/manual-test','/active-test')
  const persist=()=>page.evaluate(()=>{window.dispatchEvent(new Event('pagehide'));return JSON.parse(localStorage.getItem('forged_hybrid_active_run_v1'))})
  for(const width of [393,320]) {
    await page.evaluate(()=>{localStorage.removeItem('forged_hybrid_active_run_v1');localStorage.removeItem('forged_hybrid_run_completion_handoff_v1');localStorage.removeItem('forge_active_run_map_layout_v1')})
    await page.setViewportSize({width,height:852});await page.goto(activeUrl)
    const select=page.getByLabel('Planned route · Private (optional)')
    await expect(select.locator('option')).toHaveCount(2)
    await expect(page.getByRole('button',{name:'Start Run',exact:true})).toBeEnabled()
    const beforeCalls=calls.length
    await select.selectOption(privateRoute.id)
    await expect(page.locator('.planned-route-overlay')).toHaveCount(1)
    await expect(page.locator('.recorded-route-overlay')).toHaveCount(0)
    await expect(page.getByText('Planned route · Private',{exact:true})).toBeVisible()
    await expect(page.getByText(/Planned reference only · No recorded GPS line yet/)).toBeVisible()
    await expect(page.getByText(/Display sampled evenly to 800 points/)).toBeVisible()
    assert.equal(await page.evaluate(()=>window.watchStarts),0)
    await expect(page.getByText('0.00 mi',{exact:true})).toBeVisible()
    await page.getByRole('button',{name:'Use no planned route',exact:true}).click()
    await expect(page.locator('.planned-route-overlay')).toHaveCount(0)
    for(const failure of ['malformed','not-found']) {
      corrupt=failure==='malformed';missing=failure==='not-found';await select.selectOption(privateRoute.id)
      await expect(page.getByRole('alert')).toContainText('Private route unavailable')
      await expect(page.locator('.planned-route-overlay')).toHaveCount(0)
    }
    corrupt=false;missing=false
    let release;detailHold=new Promise(resolve=>release=resolve)
    await select.selectOption(privateRoute.id);await page.getByRole('button',{name:'Use no planned route',exact:true}).click()
    release();detailHold=undefined
    await expect(page.locator('.planned-route-overlay')).toHaveCount(0)
    await select.selectOption(privateRoute.id);await expect(page.locator('.planned-route-overlay')).toHaveCount(1)
    await page.evaluate(()=>{navigator.geolocation.getCurrentPosition=success=>success({coords:{latitude:40,longitude:-73,accuracy:5},timestamp:Date.now()})})
    await page.getByRole('button',{name:'Start Run',exact:true}).click();await expect(page.getByTestId('pause-run')).toBeVisible()
    await expect.poll(()=>page.evaluate(()=>window.watchStarts)).toBe(1)
    const suppliedFixes=sustainedRouteFixes(await page.evaluate(()=>Date.now()))
    for(const fix of suppliedFixes) {
      // Keep Date.now and source time together; timers/React/Leaflet keep running.
      await page.clock.setFixedTime(fix.timestamp)
      await page.evaluate(fix=>window.emitPoint(fix),fix)
    }
    await expect(page.locator('.recorded-route-overlay')).toHaveCount(1)
    await expect.poll(async()=>(await persist())?.routeCoords.length).toBe(23)
    const recorded=await persist()
    assert.equal(recorded.autoPauseEnabled,true,'fixture must exercise the default-ON recorder')
    assert.equal(recorded.autoPaused,false)
    // The first point plus seconds9..30: six-second warm-up, three-second hold.
    assert.equal(recorded.routeCoords.length,23)
    assert.equal(recorded.plannedRouteSelection.route.geometry.coordinates.length,10000)
    const drawnFixes=[suppliedFixes[0],...suppliedFixes.slice(9)]
    assert.deepEqual(recorded.routeCoords.map(point=>point.slice(2)),drawnFixes.map(({coords,timestamp})=>[
      coords.altitude,timestamp,coords.accuracy,0,null,
    ]),'every emitted vertex retains its source metadata and one uninterrupted segment')
    assert.deepEqual(recorded.routeCoords[0].slice(0,2),[40,-73],'first fix is exact')
    assert.ok(recorded.routeCoords.slice(1).every(([lat,lon])=>Number.isFinite(lat)&&lat>=40&&lat<=suppliedFixes.at(-1).coords.latitude&&Math.abs(lon+73)<1e-10))
    assert.notEqual(recorded.routeCoords.at(-1)[0],suppliedFixes.at(-1).coords.latitude,'subsequent positions are smoothed')
    assert.ok(recorded.distanceMiles*1609.344>35&&recorded.distanceMiles*1609.344<45,'distance reflects the 42m walk, not the planned marathon')
    assert.equal(recorded.gpsGapCount,0);assert.equal(recorded.gpsGapSeconds,0);assert.equal(recorded.discardedSegment,false)
    assert.equal(recorded.gps_source,'web_fallback')
    assert.notEqual(recorded.distanceMiles,42195/1609.344)
    await expect(page.locator('.planned-route-overlay')).toHaveAttribute('stroke-dasharray','7 9')
    await expect(page.locator('.recorded-route-overlay')).toHaveAttribute('stroke','#EAB308')
    assert.equal(await page.locator('.recorded-route-overlay').getAttribute('stroke-dasharray'),null)
    for(const mode of ['overview','stats','follow','stats','overview']) {
      await page.getByTestId('map-layout-'+mode).click()
      await expect(page.locator('.planned-route-overlay')).toHaveCount(mode==='stats'?0:1)
      const after=await persist()
      for(const key of ['routeCoords','distanceMiles','startedAt','pausedDurationMs','clientRunId','gpsGapCount','gpsGapSeconds','discardedSegment','plannedRouteSelection']) assert.deepEqual(after[key],recorded[key],key)
      assert.ok(after.elapsed>=recorded.elapsed)
      assert.equal(await page.evaluate(()=>window.watchStarts),1);assert.equal(await page.evaluate(()=>window.watchStops),0)
    }
    assert.equal(calls.slice(beforeCalls).some(([method,endpoint])=>method!=='GET'||endpoint.includes('shared')||endpoint.includes('route-planning')),false)
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`ActiveRun no overflow ${width}`)
    await expect(page.getByTestId('map-attribution')).toHaveText('Maps © Thunderforest, Data © OpenStreetMap contributors')
    await page.screenshot({path:path.join(artifacts,`active-planned-recorded-${width}.png`),fullPage:true})
    const detailCount=calls.filter(c=>c[1]==='/api/user-routes/'+privateRoute.id).length
    await page.reload();await expect(page.locator('.planned-route-overlay')).toHaveCount(1)
    assert.ok(calls.filter(c=>c[1]==='/api/user-routes/'+privateRoute.id).length>detailCount,'resume reauthorizes private saved route')
    const resumed=await persist();assert.deepEqual(resumed.routeCoords,recorded.routeCoords);assert.deepEqual(resumed.plannedRouteSelection,recorded.plannedRouteSelection)
    assert.equal(resumed.startedAt,recorded.startedAt);assert.equal(resumed.clientRunId,recorded.clientRunId)
    // Deleted/foreign on resume removes only the optional overlay, never GPS truth.
    missing=true;await page.reload();await expect(page.getByRole('alert')).toContainText('Private route unavailable')
    await expect(page.locator('.planned-route-overlay')).toHaveCount(0);await expect(page.locator('.recorded-route-overlay')).toHaveCount(1)
    assert.deepEqual((await persist()).routeCoords,recorded.routeCoords);missing=false
    await page.getByTestId('finish-run').click()
    await expect.poll(()=>savedRunPayload?.route_coords?.segments?.[0]?.points.length).toBe(23)
    await expect(page.getByText('Synthetic recap handoff',{exact:true})).toBeVisible()
    assert.deepEqual(savedRunPayload.route_coords,{version:2,segments:[{gap:null,
      points:recorded.routeCoords.map(([lat,lon,alt,time,accuracy])=>({lat,lon,alt,time,accuracy})),
    }]})
    assert.equal(savedRunPayload.gps_source,recorded.gps_source)
    assert.equal(savedRunPayload.distance_miles,recorded.distanceMiles)
    for(const key of ['plannedRouteSelection','privatePlanChoice','geometry','legs']) assert.equal(Object.hasOwn(savedRunPayload,key),false)
    assert.ok(savedRunPayload.elevation_gain<10,'only sampled altitude, not planned elevation')
    savedRunPayload=undefined
  }
  // Current account replacement clears the displayed selection without a new recorder.
  await page.evaluate(()=>{localStorage.removeItem('forged_hybrid_active_run_v1');localStorage.removeItem('forged_hybrid_run_completion_handoff_v1')})
  await page.goto(activeUrl);await expect(page.getByLabel('Planned route · Private (optional)').locator('option')).toHaveCount(2)
  await page.getByLabel('Planned route · Private (optional)').selectOption(privateRoute.id);await expect(page.locator('.planned-route-overlay')).toHaveCount(1)
  await page.evaluate(()=>window.changeAccount());await expect(page.locator('.planned-route-overlay')).toHaveCount(0)
  await expect(page.getByRole('alert')).toContainText('Account changed')
  assert.deepEqual(errors,[]); assert.deepEqual(unexpected,[])
  console.log('PASS ActiveRun 393/320: private selection/none/malformed/404/auth race, distinct planned vs GPS, 10000-point retention, map remount immutability, resume reauthorization and recorded-only save')
  if (!process.argv.includes('--active-only')) console.log('PASS focused browser smoke: real editor/map, 393/320 layout, location success/denial/long-press, straight/walking/hiking/ORS failure, private CRUD/GPX, fail-closed load, auth fencing, missing/bad tiles and attribution')
  console.log(`Artifacts: ${artifacts}`)
} finally { await browser?.close(); await server.close() }
