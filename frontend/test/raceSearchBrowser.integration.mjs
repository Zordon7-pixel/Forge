// --ui: real components/context with isolated HTTP transport; NOT full E2E.
// --e2e: same components + actual auth/race/plan HTTP routes and real isolated PG.
// WebKit is mandatory in both modes. No Chromium fallback, downloads or providers.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { buildFixture, serveFixture, fixtureNegativeControls } from './raceSearchBuiltFixture.mjs'
const require = createRequire(import.meta.url)
const { artifactDir, exactDependencies, identity, startFixture, scratchDir, runGuarded, cleanupSteps, bounded, assertStoredPlanWeeks } = require('../../backend/test/raceSearch.integration.js')
const artifacts = artifactDir()
const e2e = process.argv.includes('--e2e')
const checkEntry = process.argv.includes('--check-entry')
assert.ok(!(checkEntry && e2e),'--check-entry is a bundle/link check, not E2E')
const mode = checkEntry ? 'entry-check' : e2e ? 'e2e' : 'ui'
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client';
import {BrowserRouter,Routes,Route} from 'react-router'; import PlanCatalog from '/src/pages/PlanCatalog.jsx';
import Upgrade from '/src/pages/Upgrade.jsx'; import {ProProvider,useProContext} from '/src/context/ProContext.jsx';
import PlanCandidateDecisionSheet from '/src/components/PlanCandidateDecisionSheet.jsx';
import {setToken,clearToken} from '/src/lib/tokenStore.js'; import api from '/src/lib/api.js'; import '/src/index.css';
window.qaLogin=async(email,password)=>{const {data}=await api.post('/auth/login',{email,password});setToken(data.token)};
window.qaSetToken=setToken; window.qaLogout=clearToken;
function Probe(){const pro=useProContext(); window.qaRefresh=pro.refreshPro; return <output aria-label="Access source">{pro.loading?'loading':pro.error?'error':pro.accessSource}</output>}
const root=createRoot(document.getElementById('root')); window.qaUnmount=()=>root.unmount();
root.render(<BrowserRouter><ProProvider><Probe/><PlanCandidateDecisionSheet/><Routes><Route path="/plan-catalog" element={<PlanCatalog/>}/><Route path="/upgrade" element={<Upgrade/>}/><Route path="/plan" element={<h1>Plan navigation reached</h1>}/></Routes></ProProvider></BrowserRouter>);`
let fixture, server, browser
const unexpected = [], pageErrors = [], pages = []
const diagnostics = path.join(artifacts,`browser-${mode}-${Date.now()}-diagnostics.jsonl`)
const record = (event, details) => appendFileSync(diagnostics,JSON.stringify({time:new Date().toISOString(),event,...details})+'\n')
await runGuarded(`browser-${mode}`, async () => {
  writeFileSync(path.join(artifacts,`browser-${mode}-candidate.json`),JSON.stringify(identity(),null,2))
  exactDependencies('frontend')
  const { build } = await import('vite')
  const { webkit, expect } = await import('@playwright/test')
  const root = fileURLToPath(new URL('..',import.meta.url))
  process.chdir(root)

  if (e2e) fixture=await startFixture()
  // Normal production build is a separate gate; no .env/config/proxy mutation.
  if (process.argv.includes('--build')) {
    const scratch = scratchDir('race-browser-')
    mkdirSync(path.join(scratch,'no-env'))
    const config=(await import('../vite.config.js')).default
    await build({...config,root,configFile:false,envDir:path.join(scratch,'no-env'),cacheDir:path.join(scratch,'build-cache'),build:{...config.build,outDir:path.join(scratch,'dist')}})
    console.log('PASS normal production build with empty envDir')
  }
  const built = await buildFixture(root, entry, mode)
  writeFileSync(path.join(artifacts,`browser-${mode}-module-graph.json`),JSON.stringify(built.graph,null,2))
  // Durable exact served bytes are evidence, not scratch or a source-file server.
  const bundleEvidence = path.join(artifacts,`browser-${mode}-bundle-${Date.now()}`)
  for(const [name,body] of built.files){
    const destination=path.join(bundleEvidence,name.slice(1))
    mkdirSync(path.dirname(destination),{recursive:true});writeFileSync(destination,body)
  }
  record('fixture-built-linked',{sources:built.graph.sources.length,chunks:built.graph.chunks.length,bundleEvidence})
  console.log(built.linkResult)
  console.log(fixtureNegativeControls(built.files))
  if(checkEntry){
    record('entry-check-completed',{sources:built.graph.sources.length,chunks:built.graph.chunks.length})
    console.log('PASS complete production fixture graph and link controls; NOT browser acceptance')
    return
  }
  server=await serveFixture(built.files,fixture?.base)
  browser=await webkit.launch()
  writeFileSync(path.join(artifacts,`webkit-${mode}-version.json`),JSON.stringify({browser:'WebKit',version:browser.version(),mode,candidate:identity()},null,2))
  const origin=server.origin
  const token=id=>'synthetic.'+Buffer.from(JSON.stringify({id,exp:9999999999})).toString('base64url')+'.synthetic'
  async function pageFor(role='pro', width=393) {
    const context=await browser.newContext({viewport:{width,height:852},timezoneId:'UTC',serviceWorkers:'block',reducedMotion:'reduce'})
    const page=await context.newPage()
    pages.push(page)
    page.on('console',message=>record('console',{type:message.type(),text:message.text()}))
    page.on('pageerror',error=>{pageErrors.push(error.message);record('pageerror',{message:error.message,stack:error.stack})})
    const localPath = request => { const url=new URL(request.url()); return url.origin===origin ? url.pathname : null }
    page.on('requestfailed',request=>{const pathname=localPath(request);if(pathname)record('local-request-failed',{pathname,error:request.failure()?.errorText})})
    page.on('response',response=>{const pathname=localPath(response.request());if(pathname&&response.status()>=400)record('local-response-error',{pathname,status:response.status()})})
    await page.addInitScript(value=>localStorage.setItem('forge_token',value),fixture?fixture.users[role].token:token(role))
    await context.route('**/*',async route=>{
      const url=new URL(route.request().url())
      if(url.origin===origin)return route.continue()
      // Local CSS imports an external font stylesheet; block it, never fetch it.
      if(['fonts.googleapis.com','fonts.gstatic.com'].includes(url.hostname))return route.fulfill({body:'',contentType:'text/css'})
      unexpected.push(url.origin); return route.abort()
    })
    return {page,context}
  }
  const manual=async(page,name,date='2027-01-01',distance='13.1')=>{
    await page.getByRole('button',{name:'Enter your race manually',exact:true}).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByLabel('Race name',{exact:true}).fill(name)
    await page.getByLabel('Race date',{exact:true}).fill(date)
    await page.getByLabel('Distance miles',{exact:true}).fill(distance)
  }
  const search=async(page,q)=>{
    await page.getByRole('searchbox').fill(q)
    await page.getByRole('searchbox').press('Enter')
  }
  const buildButton=page=>page.getByRole('button',{name:'Build Race Calendar',exact:true})
  async function screenshot(page,name){
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'no horizontal overflow')
    await page.screenshot({path:path.join(artifacts,`webkit-${mode}-${name}.png`),fullPage:true})
  }
  if(!e2e){
    const {page,context}=await pageFor()
    await page.clock.setFixedTime(new Date('2026-11-02T12:00:00Z'))
    let access='subscription', authError=false, authDelay=0, meCalls=0, writes=0, searchCalls=0, prefillDelay=0, prefillError=false
    const race={id:'generic',name:'River and Trail Half Marathon',race_date:'2027-01-01',distance_miles:13.1,city:'Meadow',state:'VA'}
    let searchBehavior='result'
    const pending=[]
    await page.route('**/api/**',async route=>{
      const request=route.request(),url=new URL(request.url()),pathname=url.pathname
      const respond=(status,json)=>route.fulfill({status,json}).catch(()=>undefined) // aborted stale transport
      if(pathname==='/api/auth/login')return respond(200,{token:token('logged-in')})
      if(pathname==='/api/auth/me'){
        meCalls++; const capturedAccess=access,capturedError=authError,capturedDelay=authDelay
        if(capturedDelay)await new Promise(r=>setTimeout(r,capturedDelay))
        return respond(capturedError?503:200,{user:{entitlement:{effectivePremiumAccess:capturedAccess!=='free',accessSource:capturedAccess}}})
      }
      if(pathname==='/api/races'&&request.method()==='GET')return respond(200,{races:[]})
      if(pathname==='/api/plans/prefill'){
        const fail=prefillError; if(prefillDelay)await new Promise(r=>setTimeout(r,prefillDelay))
        return respond(fail?503:200,fail?{error:'Synthetic prefill failure'}:{inferredTrainingDays:['Tue','Thu','Sat'],runDaysPerWeek:3})
      }
      if(pathname==='/api/races/catalog'){
        searchCalls++
        if(searchBehavior==='hold'){pending.push(()=>respond(200,{races:[{...race,name:'Stale result'}]}));return}
        if(searchBehavior==='error')return respond(503,{error:'Synthetic unavailable'})
        return respond(200,{races:searchBehavior==='empty'?[]:searchBehavior==='past'?[{...race,race_date:'2026-11-01'},{...race,id:'today',name:'Today River',race_date:'2026-11-02'}]:[race]})
      }
      if(request.method()==='POST'){
        writes++
        if(pathname==='/api/races')return respond(201,{race:{...request.postDataJSON(),id:'owned'}})
        if(pathname.startsWith('/api/plans/generate-for-race/'))return respond(201,{requires_apply:true,candidate_id:'candidate',candidate_hash:'synthetic-hash',plan:{plan_data:{overall_feasibility:'supported',weeks:[]}}})
        if(pathname==='/api/plans/candidates/candidate/apply')return respond(200,{applied:true})
      }
      unexpected.push(pathname);return route.abort()
    })
    await page.goto(origin+'/plan-catalog')
    await expect(page.getByLabel('Access source')).toHaveText('subscription')
    await search(page,'x')
    await expect(page.getByRole('alert')).toContainText('at least two')
    searchBehavior='empty';await search(page,'zznotaracexx')
    await expect(page.getByRole('status').filter({hasText:'No matching races'})).toBeVisible()
    await screenshot(page,'empty-393')
    searchBehavior='error';await search(page,'River')
    await expect(page.getByRole('alert')).toContainText('Try Search again')
    await screenshot(page,'error-393')
    searchBehavior='hold';await search(page,'older')
    await expect(page.getByRole('status').filter({hasText:'Searching the race catalog'})).toBeVisible()
    const calls=searchCalls
    await page.locator('form').evaluate(form=>{form.requestSubmit();form.requestSubmit()})
    await page.waitForTimeout(100);assert.equal(searchCalls,calls,'same-query duplicate coalesced')
    searchBehavior='result';await page.getByRole('searchbox').fill('newer')
    await page.locator('form').evaluate(form=>form.requestSubmit())
    await expect(page.getByRole('status').filter({hasText:'1 matching race'})).toBeVisible()
    await Promise.all(pending.splice(0).map(release=>release()))
    await expect(page.getByText('Stale result',{exact:true})).toHaveCount(0)
    searchBehavior='past';await search(page,'past river')
    await expect(page.getByRole('button',{name:'Past race',exact:true})).toBeDisabled()
    await expect(page.getByRole('button',{name:'Use this race',exact:true})).toBeEnabled()
    // Eight REAL elapsed seconds. A fixed wall-clock Date does not fast-forward timers.
    authDelay=8000;const beforeDelay=meCalls
    await page.evaluate(()=>{document.dispatchEvent(new Event('visibilitychange'));document.dispatchEvent(new Event('visibilitychange'))})
    await expect(page.getByLabel('Access source')).toHaveText('loading')
    await expect(page.getByRole('button',{name:'Checking Pro access…',exact:true})).toBeDisabled()
    await page.waitForTimeout(100);assert.equal(meCalls,beforeDelay+1,'resume refresh single-flight')
    await expect(page.getByLabel('Access source')).toHaveText('subscription',{timeout:12000})
    authDelay=0
    await page.getByRole('button',{name:'Use this race',exact:true}).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.getByRole('button',{name:'Close plan options'}).click()
    // Failed access is visible and retryable, never an upgrade decision.
    authError=true;await page.evaluate(()=>window.qaRefresh())
    await manual(page,'Arbitrary Dawn Event')
    await expect(page.getByRole('alert')).toContainText('Could not verify Pro access')
    await buildButton(page).click();assert.equal(writes,0)
    authError=false;await page.getByRole('button',{name:'Retry access check'}).click()
    await expect(page.getByLabel('Access source')).toHaveText('subscription')
    await screenshot(page,'manual-393')
    await page.getByRole('button',{name:'Close plan options'}).click()
    // Stale old-account success must never override the new free login.
    authDelay=1200;access='subscription';await page.evaluate(()=>{void window.qaRefresh()})
    access='free';authDelay=0
    await page.evaluate(()=>window.qaLogin('synthetic@example.invalid','synthetic-only'))
    await expect(page.getByLabel('Access source')).toHaveText('free')
    await page.waitForTimeout(1300);await expect(page.getByLabel('Access source')).toHaveText('free')
    await manual(page,'Arbitrary Free Sunrise')
    await page.getByLabel('Race name',{exact:true}).fill(' ');await buildButton(page).click()
    await expect(page.getByRole('alert')).toContainText('race name')
    await page.getByLabel('Race name',{exact:true}).fill('Arbitrary Free Sunrise')
    await page.getByLabel('Race date',{exact:true}).fill('2026-11-01');await buildButton(page).click()
    await expect(page.getByRole('alert')).toContainText('today or later')
    await page.getByLabel('Race date',{exact:true}).fill('2027-01-01')
    for(const distance of ['0.01','101']){
      await page.getByLabel('Distance miles',{exact:true}).fill(distance);await buildButton(page).click()
      await expect(page.getByRole('alert')).toContainText('0.1 and 100')
    }
    await page.getByLabel('Distance miles',{exact:true}).fill('13.1');await buildButton(page).click()
    await expect(page.getByRole('status').filter({hasText:'Race calendars require Pro'})).toBeVisible()
    assert.equal(writes,0,'free entry never writes a race/plan')
    await page.getByRole('button',{name:'View Pro upgrade'}).click()
    await expect(page.getByRole('heading',{name:'Train with the full signal.'})).toBeVisible()
    await page.goBack()
    await expect(page.getByLabel('Race name',{exact:true})).toHaveValue('Arbitrary Free Sunrise')
    await expect(page.getByLabel('Race date',{exact:true})).toHaveValue('2027-01-01')
    await expect(page.getByLabel('Distance miles',{exact:true})).toHaveValue('13.1')
    await page.getByRole('button',{name:'Close plan options'}).click()
    // Old prefill failure after close/reopen must not affect the next dialog.
    access='subscription';await page.evaluate(()=>window.qaRefresh())
    prefillDelay=600;prefillError=true;await manual(page,'Old prefill')
    await page.getByRole('button',{name:'Close plan options'}).click()
    prefillDelay=0;prefillError=false;await manual(page,'New prefill')
    await page.waitForTimeout(700);await expect(page.getByRole('alert')).toHaveCount(0)
    await page.getByRole('button',{name:'Close plan options'}).click()
    // UI-only successful request paths, clearly distinct from DB-backed C below.
    for(const source of ['subscription','beta']){
      access=source;await page.evaluate(()=>window.qaRefresh())
      await manual(page,`Arbitrary ${source} Sunrise`)
      const before=writes
      await buildButton(page).evaluate(button=>{button.click();button.click()})
      await expect(page.getByRole('heading',{name:'Plan navigation reached'})).toBeVisible()
      assert.equal(writes,before+3,'one race save, one preview, one apply')
      await page.goBack()
    }
    await page.setViewportSize({width:320,height:700})
    searchBehavior='empty';await search(page,'no match');await screenshot(page,'empty-320')
    searchBehavior='error';await search(page,'error');await screenshot(page,'error-320')
    await manual(page,'Arbitrary Compact Event');await screenshot(page,'manual-320')
    await page.evaluate(()=>window.qaUnmount())
    assert.deepEqual(pageErrors,[],'no unhandled browser errors before closing the page')
    await context.close()
    console.log('PASS B/D UI transport-isolated WebKit matrix; NOT database E2E')
  } else {
    // Every /api request below reaches the real local backend and PostgreSQL.
    for(const [role,catalog] of [['pro',true],['pro',false],['beta',false],['free',false]]){
      fixture.setBeta(role==='beta')
      const {page,context}=await pageFor(role)
      await page.goto(origin+'/plan-catalog')
      // Exercise actual /auth/login -> tokenStore -> ProProvider /auth/me refresh.
      await page.evaluate(({email,password})=>window.qaLogin(email,password),fixture.users[role])
      await expect(page.getByLabel('Access source')).toHaveText(role==='pro'?'subscription':role)
      const before=await fixture.db.dbGet('SELECT COUNT(*) AS n FROM user_plans WHERE user_id=?',[fixture.users[role].id])
      if(catalog){
        await search(page,'River Trail Half')
        await expect(page.getByRole('status').filter({hasText:'matching race'})).toBeVisible()
        await page.getByRole('button',{name:'Use this race',exact:true}).click()
      }else await manual(page,`Arbitrary ${role} Sunrise`,fixture.date)
      await buildButton(page).click()
      if(role==='free'){
        await expect(page.getByRole('status').filter({hasText:'Race calendars require Pro'})).toBeVisible()
        await screenshot(page,'free-upgrade')
        await page.getByRole('button',{name:'View Pro upgrade'}).click()
        await expect(page.getByRole('heading',{name:'Train with the full signal.'})).toBeVisible()
        await page.goBack()
        await expect(page.getByLabel('Race name',{exact:true})).toHaveValue('Arbitrary free Sunrise')
        assert.equal((await fixture.call('/plans/generate-for-race/missing',{role,body:{}})).status,402)
        assert.equal((await fixture.call('/plans/candidates/missing/apply',{role,body:{}})).status,402)
      }else{
        // Click the real decision sheet if this legitimate plan requires review.
        const applied=page.getByRole('heading',{name:'Plan navigation reached'})
        const decision=page.getByRole('button',{name:/^(Apply reviewed plan|Keep target and apply)$/})
        await expect(applied.or(decision)).toBeVisible({timeout:100000})
        if(await decision.isVisible())await decision.click()
        await expect(applied).toBeVisible({timeout:50000})
      }
      const after=await fixture.db.dbGet('SELECT COUNT(*) AS n FROM user_plans WHERE user_id=?',[fixture.users[role].id])
      assert.equal(after.n,before.n+(role==='free'?0:1))
      if(role!=='free'){
        const stored=await fixture.db.dbGet("SELECT tp.plan_data FROM training_plans tp JOIN user_plans up ON up.plan_id=tp.id WHERE up.user_id=? AND up.status='active'",[fixture.users[role].id])
        assertStoredPlanWeeks(stored)
      }
      console.log(`PASS C WebKit -> actual HTTP -> PostgreSQL ${role} ${catalog?'catalog':'manual'}`)
      assert.deepEqual(pageErrors,[],'no unhandled browser errors before closing the page')
      await context.close()
    }
  }
  assert.deepEqual(unexpected,[],'no unexpected provider or API requests')
  assert.deepEqual(pageErrors,[],'no unhandled browser errors')
}, { cleanup: async failure => {
  if(failure){
    record('failure',{message:failure.message,stack:failure.stack})
    for(const [index,page] of pages.entries()) if(!page.isClosed()) {
      try { await bounded('failure screenshot',()=>page.screenshot({path:path.join(artifacts,`webkit-${mode}-failure-${index}-${Date.now()}.png`),fullPage:true,timeout:5000}),6000) }
      catch(error){record('failure-screenshot-error',{message:error.message});console.error('Failure screenshot unavailable:',error.message)}
    }
  }
  await cleanupSteps([
    ['browser close',()=>browser?.close()],
    ['built fixture server close',()=>server?.close()],
    ['fixture close',()=>fixture?.close(),55000],
  ])
} }).catch(error=>{console.error(error);process.exitCode=1})
