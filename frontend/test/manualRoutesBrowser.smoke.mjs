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
import { chromium, devices, expect } from '@playwright/test'
const RUNNING_PREFERENCE = 'running-avoid-ferries-fords-steps-v1'
const SYNTHETIC_COLORS = { outdoors:'#225533', landscape:'#685533', 'mobile-atlas':'#334455' }
// Chromium emulation using Playwright's native descriptor, NOT a physical iPhone.
const iphone17 = devices['iPhone 17']
assert.ok(iphone17, 'installed Playwright must provide the iPhone 17 descriptor')
const paintViewports = [
  { label:'iphone17-descriptor', ...iphone17.viewport },
  { label:'iphone17-canonical', width:402, height:874 },
  { label:'compact', width:320, height:568 },
]
const require = createRequire(import.meta.url)
const { validateRoute, toGpx } = require('../../backend/src/lib/userRoutes.js')
const root = fileURLToPath(new URL('..', import.meta.url)), artifacts = mkdtempSync(path.join(os.tmpdir(), 'forge-manual-routes-'))
mkdirSync(path.join(artifacts, 'no-env'))
process.chdir(root)
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {MemoryRouter,Routes,Route} from 'react-router';
import ActiveRun from '/src/pages/ActiveRun.jsx'; import {UnitsProvider} from '/src/context/UnitsContext.jsx';
import ManualRoutes from '/src/pages/ManualRoutes.jsx'; import {setToken} from '/src/lib/tokenStore.js';
import RunHub from '/src/pages/RunHub.jsx';
import '/src/index.css'; import 'leaflet/dist/leaflet.css';
window.changeAccount=()=>setToken('synthetic.'+btoa(JSON.stringify({id:'other',exp:9999999999}))+'.synthetic');
createRoot(document.getElementById('root')).render(<MemoryRouter initialEntries={[location.pathname === '/hub-test' ? '/run' : '/run/active']}><UnitsProvider>{location.pathname === '/hub-test' ? <Routes><Route path="/run" element={<RunHub/>}/><Route path="/run/routes" element={<ManualRoutes/>}/></Routes> : location.pathname === '/active-test' ? <Routes><Route path="/run/active" element={<ActiveRun/>}/><Route path="*" element={<p>Synthetic recap handoff</p>}/></Routes> : <ManualRoutes/>}</UnitsProvider></MemoryRouter>);`
const server = await createServer({ root, configFile: false, envDir: path.join(artifacts, 'no-env'), cacheDir: path.join(artifacts, 'cache'),
  optimizeDeps: { noDiscovery: true, include: ['react','react-dom/client','react/jsx-runtime','react-router','react-leaflet','leaflet','lucide-react','axios','@capacitor/core','@capacitor/app'] },
  plugins: [react(), { name: 'manual-route-smoke', configureServer(s) { s.middlewares.use(async (req,res,next) => {
    if (!['/manual-test','/active-test','/hub-test'].includes(req.url)) return next()
    res.setHeader('Content-Type','text/html; charset=utf-8'); res.end(await s.transformIndexHtml(req.url, '<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><p style="margin:8px;text-align:center">SYNTHETIC QA — mocked tiles and routing. Chromium emulation, NOT physical device or live map/probe evidence.</p><main id="root" style="padding:16px;max-width:760px;margin:auto"></main><script type="module" src="/manual-entry.jsx"></script></body></html>'))
  }) }, resolveId(id) { if(id === '/manual-entry.jsx') return id }, load(id) { if(id === '/manual-entry.jsx') return entry } }],
  server: { host:'127.0.0.1',port:0 } })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] })
  const context = await browser.newContext({ ...iphone17, serviceWorkers:'block', reducedMotion:'reduce', acceptDownloads:true })
  const page = await context.newPage(), errors = [], unexpected = [], calls = []
  let routes = [], corrupt = false, routeFailure = false, tiles = false, tileRequests = 0, syntheticTiles = false, missing = false, detailHold, planningHold, savedRunPayload
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
    if (url.hostname === 'api.thunderforest.com') {
      tileRequests++
      const style = url.pathname.split('/')[1]
      assert.ok(['outdoors','landscape','mobile-atlas'].includes(style), 'fixed style allowlist')
      if (!syntheticTiles) return route.abort()
      const color = SYNTHETIC_COLORS[style]
      return route.fulfill({contentType:'image/svg+xml; charset=utf-8',body:`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="${color}"/><text x="8" y="100" fill="white">SYNTHETIC ${style}</text></svg>`})
    }
    if (url.hostname !== '127.0.0.1') { if (url.hostname !== 'fonts.googleapis.com' && url.hostname !== 'fonts.gstatic.com') unexpected.push(url.origin); return route.fulfill({body:'',contentType:'text/css; charset=utf-8'}) }
    if (!url.pathname.startsWith('/api/')) return route.continue()
    assert.match(request.headers().authorization || '', /^Bearer synthetic\./)
    calls.push([request.method(),url.pathname])
    if (['/api/auth/me','/api/profile/hr-zones','/api/watch-sync/status','/api/users/settings'].includes(url.pathname)) return route.fulfill({json:{user:{id:'route-smoke'},zones:[],units:'imperial'}})
    if (url.pathname === '/api/runs' && request.method() === 'GET') return route.fulfill({json:{runs:[]}})
    if (url.pathname === '/api/plans/today') return route.fulfill({json:{today:null,execution:{hasPlan:false,hasDay:false,sessions:[]}}})
    if (url.pathname === '/api/runs/next-recommendation') return route.fulfill({body:'null',contentType:'application/json; charset=utf-8'})
    if (url.pathname === '/api/runs' && request.method() === 'POST') {savedRunPayload=request.postDataJSON(); return route.fulfill({json:{id:savedRunPayload.id,run:savedRunPayload}})}
    if (url.pathname === '/api/meta/map-tiles') return route.fulfill({json:{THUNDERFOREST_API_KEY:tiles ? '0'.repeat(32) : null}})
    if (url.pathname === '/api/route-planning/leg') {
      const body = request.postDataJSON()
      assert.deepEqual(Object.keys(body).sort(),body.routingPreference ? ['points','profile','routingPreference'] : ['points','profile']); assert.equal(body.points.length,2)
      if(body.routingPreference) { assert.equal(body.routingPreference,RUNNING_PREFERENCE); assert.equal(body.profile,'foot-walking') }
      if(routeFailure) return route.fulfill({status:503,json:{error:'PLANNING_UNAVAILABLE'}})
      await planningHold
      return route.fulfill({json:{leg:{profile:body.profile,...(body.routingPreference ? {routingPreference:body.routingPreference} : {}),geometry:{type:'LineString',coordinates:body.points},distanceMeters:1609.344,durationSeconds:600}}})
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
      if(url.pathname.endsWith('/gpx')) return route.fulfill({contentType:'application/gpx+xml; charset=utf-8',body:toGpx(saved)})
      await detailHold
      if(missing) return route.fulfill({status:404,json:{error:'USER_ROUTE_NOT_FOUND'}})
      return route.fulfill({json:{route:corrupt?{...saved,kind:'recorded'}:saved}})
    }
    unexpected.push(url.pathname); return route.abort()
  })
  const url=`http://127.0.0.1:${server.httpServer.address().port}/manual-test`
  if (!process.argv.includes('--active-only')) {
  await page.goto(url.replace('/manual-test','/hub-test'))
  assert.deepEqual(await page.evaluate(()=>({viewport:{width:innerWidth,height:innerHeight},
    screen:{width:screen.width,height:screen.height},scale:devicePixelRatio})),
    {viewport:iphone17.viewport,screen:iphone17.screen,scale:iphone17.deviceScaleFactor},'native iPhone 17 descriptor in Chromium emulation')
  await expect(page.getByRole('heading',{name:'Train',exact:true})).toBeVisible()
  await expect(page.getByText('Loading run stats...', {exact:true})).toHaveCount(0)
  const mapRunLink=page.getByRole('link').filter({has:page.getByText('Map a run',{exact:true})})
  await expect(mapRunLink).toHaveCount(1)
  await expect(mapRunLink.locator('span').first()).toHaveText('Map a run')
  await expect(mapRunLink).toHaveAttribute('href','/run/routes')
  await mapRunLink.click()
  await expect(page.getByRole('heading',{name:'Build your route'})).toBeVisible()
  await page.goto(url)
  await expect(page.getByRole('heading',{name:'Build your route'})).toBeVisible()
  await expect(page.getByTestId('forge-map')).toHaveAttribute('data-map-state','unavailable')
  await page.getByRole('button',{name:'Start at current location',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('Could not get your location')
  await expect(page.locator('.leaflet-overlay-pane path')).toHaveCount(0)
  const map=page.locator('.leaflet-container')
  const recorderNotice=page.getByRole('note').filter({hasText:'Routes containing Running legs'})
  await expect(recorderNotice).toHaveCount(0)
  // Wait for the CURRENT layer to be fully visible on screen. Image completion
  // alone cannot detect Leaflet's offscreen opacity=0 fade (the 320px regression).
  async function paintedScreenshot(style, label) {
    await map.scrollIntoViewIfNeeded()
    await expect(page.getByTestId('forge-map')).toHaveAttribute('data-map-state','ready')
    await expect.poll(()=>map.evaluate((node, selectedStyle)=>{
      const bounds=node.getBoundingClientRect()
      if (bounds.top<0 || bounds.bottom>innerHeight || bounds.left<0 || bounds.right>innerWidth) return false
      const visible=el=>{
        for(let parent=el;parent;parent=parent.parentElement) {
          const css=getComputedStyle(parent)
          if(css.display==='none'||css.visibility!=='visible'||Number(css.opacity)<0.999) return false
        }
        return true
      }
      const tiles=[...node.querySelectorAll('.leaflet-tile')].filter(tile=>{
        const r=tile.getBoundingClientRect()
        return r.right>bounds.left && r.left<bounds.right && r.bottom>bounds.top && r.top<bounds.bottom
      })
      return visible(node) && tiles.length>0 && tiles.every(tile=>tile.complete && tile.naturalWidth>0
        && new URL(tile.src).pathname.split('/')[1]===selectedStyle && visible(tile))
    },style),{message:`fully opaque on-screen synthetic ${style} tiles at ${label}`}).toBe(true)
    // Allow a compositor frame after the style/opacity check; never override CSS.
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    const rect=await map.evaluate(node=>{
      const r=node.getBoundingClientRect(); return {x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height}
    })
    const png=await page.screenshot({path:path.join(artifacts,`synthetic-${label}-${style}.png`),fullPage:true,scale:'css'})
    assert.ok(png.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) && png.toString('ascii',12,16)==='IHDR')
    assert.ok(png.length<16000000 && png.readUInt32BE(16)*png.readUInt32BE(20)<=16000000,'bound PNG before decoding')
    // Decode the captured PNG with Chromium's native decoder via existing
    // Playwright, bounded to 16M pixels. This reads screenshot pixels, not tiles.
    const fraction=await page.evaluate(async ({base64,rect,color})=>{
      const image=new Image(); image.src='data:image/png;base64,'+base64; await image.decode()
      if(image.width*image.height>16000000) throw new Error('Synthetic screenshot exceeds pixel bound')
      const canvas=document.createElement('canvas'); canvas.width=image.width; canvas.height=image.height
      const ctx=canvas.getContext('2d'); ctx.drawImage(image,0,0)
      const x=Math.ceil(rect.x+4), y=Math.ceil(rect.y+4), width=Math.floor(rect.width-8), height=Math.floor(rect.height-8)
      if(x<0||y<0||x+width>image.width||y+height>image.height) throw new Error('Map outside captured PNG')
      const pixels=ctx.getImageData(x,y,width,height).data
      const rgb=color.slice(1).match(/../g).map(hex=>parseInt(hex,16))
      let matches=0
      for(let i=0;i<pixels.length;i+=4) if(pixels[i]===rgb[0]&&pixels[i+1]===rgb[1]&&pixels[i+2]===rgb[2]&&pixels[i+3]===255) matches++
      return matches/(width*height)
    },{base64:png.toString('base64'),rect,color:SYNTHETIC_COLORS[style]})
    assert.ok(fraction>0.65,`captured ${label}/${style} map must contain >65% fixture color, got ${(fraction*100).toFixed(1)}%`)
    console.log(`PASS SYNTHETIC Chromium paint ${label}/${style}: ${(fraction*100).toFixed(1)}% fixture color; NOT live cartography/probe evidence`)
  }
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
  await expect(recorderNotice).toHaveCount(0)
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
  for(const viewport of [{width:393,height:852},{width:320,height:568},iphone17.viewport]) {
    const {width}=viewport
    await page.setViewportSize(viewport)
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
  // Synthetic map-style recovery: preserve the actual map, SVG overlays, view and route.
  await expect(page.getByLabel('Map display style')).toHaveValue('outdoors')
  assert.deepEqual(await page.getByLabel('Map display style').locator('option').allTextContents(),
    ['Outdoors (trails)','Landscape (terrain)','Mobile Atlas (roads)'])
  await expect(page.getByText(/Styles change the display only/)).toBeVisible()
  const routingCallsBeforeStyles=calls.filter(call=>call[1]==='/api/route-planning/leg').length
  await page.evaluate(()=>{
    window.syntheticMapNode=document.querySelector('.leaflet-container')
    window.syntheticOverlayNodes=[...document.querySelectorAll('.leaflet-overlay-pane path')]
    window.syntheticGeometry=window.syntheticOverlayNodes.map(node=>node.getAttribute('d'))
    window.syntheticView=document.querySelector('.leaflet-map-pane').style.transform
  })
  syntheticTiles=true
  for(const style of ['landscape','mobile-atlas','outdoors']) {
    await page.getByLabel('Map display style').selectOption(style)
    await paintedScreenshot(style,'style-recovery')
    assert.equal(await page.evaluate(()=>window.syntheticMapNode===document.querySelector('.leaflet-container')
      && window.syntheticOverlayNodes.every((node,i)=>node===document.querySelectorAll('.leaflet-overlay-pane path')[i]
        && node.getAttribute('d')===window.syntheticGeometry[i])
      && document.querySelector('.leaflet-map-pane').style.transform===window.syntheticView),true)
    await expect(page.getByText('2 accepted legs',{exact:true})).toBeVisible()
    await expect(page.getByTestId('map-attribution')).toHaveText('Maps © Thunderforest, Data © OpenStreetMap contributors')
  }
  await page.evaluate(()=>{
    window.syntheticOldTile=document.querySelector('.leaflet-tile-loaded')
    window.syntheticOldTile.dispatchEvent(new Event('error'))
  })
  await expect(page.getByTestId('forge-map')).toHaveAttribute('data-map-state','unavailable')
  await page.getByLabel('Map display style').selectOption('landscape')
  await expect.poll(()=>page.locator('.leaflet-tile-loaded').count()).toBeGreaterThan(0)
  await page.evaluate(()=>window.syntheticOldTile.dispatchEvent(new Event('error')))
  await expect(page.getByTestId('forge-map')).toHaveAttribute('data-map-state','ready')
  await page.getByLabel('Map display style').selectOption('outdoors')
  await page.evaluate(()=>window.syntheticOldTile.dispatchEvent(new Event('error')))
  await expect(page.getByTestId('forge-map')).toHaveAttribute('data-map-state','ready')
  assert.equal(calls.filter(call=>call[1]==='/api/route-planning/leg').length,routingCallsBeforeStyles)
  assert.equal(await page.evaluate(()=>window.syntheticMapNode===document.querySelector('.leaflet-container')),true)
  await page.getByLabel('Routing profile').selectOption('running')
  await expect(page.getByText(/Running uses walking-based pedestrian routing/)).toContainText('not road-only. No running ETA')
  await expect(recorderNotice).toHaveText('Routes containing Running legs can be edited and exported here. Using them as a recorder overlay is not supported yet.')
  let releasePlanning
  planningHold=new Promise(resolve=>{releasePlanning=resolve})
  await map.click({position:{x:210,y:260}})
  await expect.poll(()=>calls.filter(call=>call[1]==='/api/route-planning/leg').length).toBe(routingCallsBeforeStyles+1)
  await page.getByLabel('Map display style').selectOption('mobile-atlas')
  await expect(page.getByText('Routing the new leg… Accepted distance is unchanged.',{exact:true})).toBeVisible()
  releasePlanning(); planningHold=undefined
  await expect(page.getByText('3 accepted legs',{exact:true})).toBeVisible()
  await page.getByLabel('Route name',{exact:true}).fill('Synthetic mixed running course')
  await page.getByRole('button',{name:'Save private route',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Synthetic mixed running course',exact:true})).toBeVisible()
  assert.deepEqual(routes[0].legs.map(leg=>leg.profile),['foot-walking','foot-hiking','foot-walking'])
  assert.deepEqual(routes[0].legs.map(leg=>leg.routingPreference),[undefined,undefined,RUNNING_PREFERENCE])
  await page.getByLabel('Routing profile').selectOption('foot-walking')
  await expect(recorderNotice).toBeVisible()
  await page.getByRole('button',{name:'Clear',exact:true}).click()
  await expect(recorderNotice).toHaveCount(0)
  await expect(page.getByLabel('Routing profile')).toHaveValue('foot-walking')
  await page.getByRole('button',{name:'Load / edit',exact:true}).click()
  await expect(page.getByText('3 accepted legs',{exact:true})).toBeVisible()
  await expect(page.getByLabel('Routing profile')).toHaveValue('foot-walking')
  await expect(recorderNotice).toBeVisible()
  for(const {label,width,height} of paintViewports) {
    await page.setViewportSize({width,height})
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
    // Resizing may reproject SVG paths; style switches must preserve those
    // resized paths and their node identities exactly.
    await map.scrollIntoViewIfNeeded()
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
    await page.evaluate(()=>{
      window.syntheticGeometry=[...document.querySelectorAll('.leaflet-overlay-pane path')].map(node=>node.getAttribute('d'))
      window.syntheticOverlayNodes=[...document.querySelectorAll('.leaflet-overlay-pane path')]
      window.syntheticView=document.querySelector('.leaflet-map-pane').style.transform
    })
    const beforePaintCalls=calls.filter(call=>call[1]==='/api/route-planning/leg').length
    for(const style of ['outdoors','landscape','mobile-atlas']) {
      await page.getByLabel('Map display style').selectOption(style)
      await paintedScreenshot(style,`running-${label}-${width}x${height}`)
      assert.equal(await page.evaluate(()=>window.syntheticMapNode===document.querySelector('.leaflet-container')
        && window.syntheticOverlayNodes.every((node,i)=>node===document.querySelectorAll('.leaflet-overlay-pane path')[i]
          && node.getAttribute('d')===window.syntheticGeometry[i])
        && document.querySelector('.leaflet-map-pane').style.transform===window.syntheticView),true)
      await expect(page.getByLabel('Map display style')).toHaveValue(style)
      await expect(page.getByText('3 accepted legs',{exact:true})).toBeVisible()
      await expect(recorderNotice).toBeVisible()
      await expect(page.getByTestId('map-attribution')).toHaveText('Maps © Thunderforest, Data © OpenStreetMap contributors')
    }
    assert.equal(calls.filter(call=>call[1]==='/api/route-planning/leg').length,beforePaintCalls)
  }
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
    await page.evaluate(()=>{
      window.emitPoint({coords:{latitude:40,longitude:-73,altitude:10,accuracy:5}})
      window.emitPoint({coords:{latitude:40.001,longitude:-73.001,altitude:12,accuracy:5}})
    })
    await expect(page.locator('.recorded-route-overlay')).toHaveCount(1)
    const recorded=await persist()
    assert.equal(recorded.routeCoords.length,2);assert.equal(recorded.plannedRouteSelection.route.geometry.coordinates.length,10000)
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
    await expect.poll(()=>savedRunPayload?.route_coords.length).toBe(2)
    await expect(page.getByText('Synthetic recap handoff',{exact:true})).toBeVisible()
    assert.deepEqual(savedRunPayload.route_coords.map(p=>[p.lat,p.lon,p.alt,p.time,p.accuracy]),recorded.routeCoords)
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
  if (!process.argv.includes('--active-only')) console.log('PASS focused browser smoke: actual RunHub Map a run CTA; real editor/map; Running disclosure on selection and mixed load with Walking picker; location success/denial/long-press, straight/walking/hiking/Running/ORS failure; synthetic style recovery, overlay identity and captured PNG color for every style at iPhone 17 descriptor/402x874/320x568 in Chromium emulation (NOT physical device); private CRUD/GPX, fail-closed load, auth fencing, missing/bad tiles and attribution. No live map/probe evidence.')
  console.log(`Artifacts: ${artifacts}`)
} finally { await browser?.close(); await server.close() }
