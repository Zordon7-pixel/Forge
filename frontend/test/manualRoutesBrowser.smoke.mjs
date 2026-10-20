// Focused DOM smoke, offline. Full SPA/ActiveRun Playwright acceptance is Phase 1C.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import { chromium, expect } from '@playwright/test'
const require = createRequire(import.meta.url)
const { validateRoute, toGpx } = require('../../backend/src/lib/userRoutes.js')
const root = fileURLToPath(new URL('..', import.meta.url)), artifacts = mkdtempSync(path.join(os.tmpdir(), 'forge-manual-routes-'))
mkdirSync(path.join(artifacts, 'no-env'))
process.chdir(root)
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import {MemoryRouter} from 'react-router';
import ManualRoutes from '/src/pages/ManualRoutes.jsx'; import {setToken} from '/src/lib/tokenStore.js';
import '/src/index.css'; import 'leaflet/dist/leaflet.css';
window.changeAccount=()=>setToken('synthetic.'+btoa(JSON.stringify({id:'other',exp:9999999999}))+'.synthetic');
createRoot(document.getElementById('root')).render(<MemoryRouter><ManualRoutes/></MemoryRouter>);`
const server = await createServer({ root, configFile: false, envDir: path.join(artifacts, 'no-env'), cacheDir: path.join(artifacts, 'cache'),
  optimizeDeps: { noDiscovery: true, include: ['react','react-dom/client','react/jsx-runtime','react-router','react-leaflet','leaflet','lucide-react','axios'] },
  plugins: [react(), { name: 'manual-route-smoke', configureServer(s) { s.middlewares.use(async (req,res,next) => {
    if (req.url !== '/manual-test') return next()
    res.setHeader('Content-Type','text/html'); res.end(await s.transformIndexHtml(req.url, '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><main id="root" style="padding:16px;max-width:760px;margin:auto"></main><script type="module" src="/manual-entry.jsx"></script></body></html>'))
  }) }, resolveId(id) { if(id === '/manual-entry.jsx') return id }, load(id) { if(id === '/manual-entry.jsx') return entry } }],
  server: { host:'127.0.0.1',port:0 } })
let browser
try {
  await server.listen()
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] })
  const context = await browser.newContext({ viewport: {width:393,height:852}, serviceWorkers:'block', reducedMotion:'reduce', acceptDownloads:true })
  const page = await context.newPage(), errors = [], unexpected = [], calls = []
  let routes = [], corrupt = false, routeFailure = false, tiles = false, tileRequests = 0
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    localStorage.setItem('forge_token','synthetic.'+btoa(JSON.stringify({id:'route-smoke',exp:9999999999}))+'.synthetic')
    navigator.geolocation.getCurrentPosition = (_success, failure) => failure({code:1})
  })
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.hostname === 'api.thunderforest.com') { tileRequests++; return route.abort() }
    if (url.hostname !== '127.0.0.1') { if (url.hostname !== 'fonts.googleapis.com' && url.hostname !== 'fonts.gstatic.com') unexpected.push(url.origin); return route.fulfill({body:'',contentType:'text/css'}) }
    if (!url.pathname.startsWith('/api/')) return route.continue()
    assert.match(request.headers().authorization || '', /^Bearer synthetic\./)
    calls.push([request.method(),url.pathname])
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
      return route.fulfill({json:{route:corrupt?{...saved,kind:'recorded'}:saved}})
    }
    unexpected.push(url.pathname); return route.abort()
  })
  const url=`http://127.0.0.1:${server.httpServer.address().port}/manual-test`
  await page.goto(url)
  await expect(page.getByRole('heading',{name:'Build your route'})).toBeVisible()
  await expect(page.getByTestId('forge-map')).toHaveAttribute('data-map-state','unavailable')
  await page.getByRole('button',{name:'Start at current location',exact:true}).click()
  await expect(page.getByRole('alert')).toContainText('Could not get your location')
  await expect(page.locator('.leaflet-overlay-pane path')).toHaveCount(0)
  const map=page.locator('.leaflet-container')
  await map.scrollIntoViewIfNeeded(); let box=await map.boundingBox()
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
  await expect(page.getByText(/Loaded route is the saved base/)).toBeVisible()
  await expect(page.getByRole('button',{name:'Undo',exact:true})).toBeDisabled()
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
  assert.deepEqual(errors,[]); assert.deepEqual(unexpected,[])
  console.log('PASS focused browser smoke: real editor/map, 393/320 layout, location success/denial/long-press, straight/walking/hiking/ORS failure, private CRUD/GPX, fail-closed load, auth fencing, missing/bad tiles and attribution')
  console.log(`Artifacts: ${artifacts}`)
} finally { await browser?.close(); await server.close() }
