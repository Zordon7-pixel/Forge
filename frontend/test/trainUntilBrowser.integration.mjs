// Real PlanCatalog/ProProvider and application CSS. HTTP transport mocks are UI
// ONLY, not backend/E2E evidence. No launch/kill lifecycle: host supplies a live
// WebKit Browser to runBrowserChecks(). This file never closes that Browser.
import assert from 'node:assert/strict'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import { createServer } from 'node:http'
import { SourceTextModule } from 'node:vm'
import { loadTrainUntilHelper } from './trainUntil.smoke.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const deps = process.env.TRAIN_UNTIL_FRONTEND_DEPS || root
const require = createRequire(path.join(deps, 'package.json'))
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client';
import {BrowserRouter,Routes,Route} from 'react-router';
import PlanCatalog from '/src/pages/PlanCatalog.jsx'; import {ProProvider,useProContext} from '/src/context/ProContext.jsx';
import {setToken} from '/src/lib/tokenStore.js'; import '/src/index.css';
window.qaSetToken=setToken;
function Probe(){const pro=useProContext();return <output aria-label="Access source">{pro.loading?'loading':pro.error?'error':pro.accessSource}</output>}
createRoot(document.getElementById('root')).render(<BrowserRouter><ProProvider><Probe/><Routes><Route path="/plan-catalog" element={<PlanCatalog/>}/><Route path="/plan" element={<h1>Plan navigation reached</h1>}/></Routes></ProProvider></BrowserRouter>);`

export async function buildAndLink() {
  // Block every subprocess API before importing build tools. Vite's usual
  // esbuild service exposes child.kill(); use in-process TypeScript JSX instead.
  const childProcess = require('node:child_process')
  const originals = new Map()
  for (const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) {
    originals.set(key, childProcess[key])
    childProcess[key] = () => { throw new Error(`SUBPROCESS_FORBIDDEN: ${key}`) }
  }
  syncBuiltinESMExports()
  const priorCwd = process.cwd()
  try {
    process.chdir(root)
    const { build } = await import(pathToFileURL(require.resolve('vite')).href)
    const typescript = require('typescript')
    const tailwind = (await import('../tailwind.config.js')).default
    const id = path.join(root, 'train-until-qa.jsx')
    const result = await build({
      root, configFile: false, envDir: '/tmp/train-until-no-env-does-not-exist', envPrefix: 'TRAIN_UNTIL_UNUSED_',
      publicDir: false, esbuild: false,
      css: { postcss: { plugins: [require('tailwindcss')(tailwind), require('autoprefixer')()] } },
      plugins: [{ name: 'train-until-in-process-jsx', enforce: 'pre',
        configResolved(config) { config.plugins = config.plugins.filter(plugin => plugin.name !== 'vite:define') },
        resolveId(source, importer) {
          if (source === '/train-until-qa.jsx') return id
          if (!source.startsWith('.') && !source.startsWith('/') && !source.startsWith('\0')) {
            return this.resolve(source, path.join(deps, 'package.json'), { skipSelf: true })
          }
        },
        load(source) { if (source === id) return entry },
        async transform(code, source) {
          if (!/\.[cm]?jsx?(?:\?|$)/.test(source)) return
          // Synthetic build constants only; no environment files or credentials.
          code = code.replace(/process\.env\.NODE_ENV/g, '"production"')
            .replace(/import\.meta\.env/g, '({DEV:false,PROD:true,MODE:"production",BASE_URL:"/"})')
          if (!source.endsWith('.jsx')) return { code, map: null }
          const output = typescript.transpileModule(code, { fileName: source, compilerOptions: {
            jsx: typescript.JsxEmit.ReactJSX, target: typescript.ScriptTarget.ESNext, module: typescript.ModuleKind.ESNext } })
          return { code: output.outputText, map: null }
        },
      }],
      build: { write: false, minify: false, cssMinify: false, target: false, rollupOptions: {
        input: '/train-until-qa.jsx', onwarn(warning, warn) {
          if (['UNRESOLVED_IMPORT','MISSING_EXPORT'].includes(warning.code)) throw new Error(warning.message)
          warn(warning)
        },
      } },
    })
    const chunks = result.output.filter(item => item.type === 'chunk')
    assert.ok(chunks.some(chunk => Object.keys(chunk.modules).includes(path.join(root, 'src/pages/PlanCatalog.jsx'))))
    const modules = new Map(chunks.map(chunk => [new URL(chunk.fileName, 'https://local.invalid/').href,
      new SourceTextModule(chunk.code, { identifier: new URL(chunk.fileName, 'https://local.invalid/').href })]))
    for (const module of modules.values()) if (module.status === 'unlinked') await module.link((specifier, parent) => {
      assert.match(specifier, /^\.\.?\//)
      const child = modules.get(new URL(specifier, parent.identifier).href)
      assert.ok(child, `missing built chunk ${specifier}`)
      return child
    })
    assert.ok([...modules.values()].every(module => module.status === 'linked'))
    const files = new Map(result.output.map(item => ['/' + item.fileName, item.type === 'chunk' ? item.code : item.source]))
    files.set('/icon-192.png', readFileSync(path.join(root, 'public/icon-192.png')))
    const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'
      + result.output.filter(item => item.fileName.endsWith('.css')).map(item => `<link rel="stylesheet" href="/${item.fileName}">`).join('')
      + '</head><body><main id="root" style="padding:12px;max-width:760px;margin:auto"></main>'
      + `<script type="module" src="/${chunks.find(chunk => chunk.isEntry).fileName}"></script></body></html>`
    files.set('/plan-catalog', html); files.set('/plan', html)
    console.log(`PASS adapted Vite production bundle and ${modules.size} linked chunks; TypeScript JSX in process, esbuild/subprocess APIs disabled; NOT normal-build or WebKit acceptance`)
    return files
  } finally {
    process.chdir(priorCwd)
    for (const [key, value] of originals) childProcess[key] = value
    syncBuiltinESMExports()
  }
}

export async function runBrowserChecks(browser, files = null) {
  assert.equal(browser.browserType().name(), 'webkit', 'real WebKit required, no fallback')
  files ||= await buildAndLink()
  const { expect } = require('@playwright/test')
  const server = createServer((req, res) => {
    const body = req.method === 'GET' && files.get(req.url)
    res.writeHead(body ? 200 : 404, { 'Content-Type': req.url.endsWith('.js') ? 'text/javascript'
      : req.url.endsWith('.css') ? 'text/css' : req.url.endsWith('.png') ? 'image/png' : 'text/html', 'Cache-Control': 'no-store' })
    res.end(body || 'Not found')
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const contexts = []
  try {
    // Same UTC instant: opposite sides of midnight prove phone-local anchoring.
    for (const timezone of ['America/New_York', 'Pacific/Kiritimati']) {
      const context = await browser.newContext({ viewport: { width: 393, height: 852 }, timezoneId: timezone, serviceWorkers: 'block' })
      contexts.push(context)
      const page = await context.newPage()
      const errors = [], unexpected = [], writes = []
      page.on('pageerror', error => errors.push(error.message))
      await page.clock.setFixedTime(new Date('2026-11-03T04:30:00Z'))
      const token = id => 'synthetic.' + Buffer.from(JSON.stringify({ id, exp: 9999999999 })).toString('base64url') + '.synthetic'
      await page.addInitScript(value => localStorage.setItem('forge_token', value), token('train-until-synthetic'))
      await context.route('**/*', async route => {
        const req = route.request(), url = new URL(req.url())
        const respond = (status, json) => route.fulfill({ status, json })
        if (url.origin !== origin) {
          if (['fonts.googleapis.com','fonts.gstatic.com'].includes(url.hostname)) return route.fulfill({ body: '', contentType: 'text/css' })
          unexpected.push(url.origin); return route.abort()
        }
        if (!url.pathname.startsWith('/api/')) return route.continue()
        if (url.pathname === '/api/auth/me') return respond(200, { user: { entitlement: { effectivePremiumAccess: true, accessSource: 'subscription' } } })
        if (url.pathname === '/api/races' && req.method() === 'GET') return respond(200, { races: [] })
        if (url.pathname === '/api/plans/prefill') return respond(200, { inferredTrainingDays: ['Tue','Thu','Sat'], runDaysPerWeek: 3, liftingEnabled: false, liftDaysPerWeek: 0 })
        if (req.method() === 'POST') {
          writes.push({ pathname: url.pathname, body: req.postDataJSON() })
          if (url.pathname === '/api/races') return respond(201, { race: { ...req.postDataJSON(), id: 'synthetic-race' } })
          // UI transport ONLY: no generation mocked as backend evidence.
          if (url.pathname.startsWith('/api/plans/generate')) return respond(201, { requires_apply: false })
        }
        unexpected.push(url.pathname); return route.abort()
      })
      const goto = async () => {
        await page.goto(origin + '/plan-catalog')
        await expect(page.getByLabel('Access source')).toHaveText('subscription')
      }
      const overflow = async () => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
        const dialog = page.getByRole('dialog')
        assert.equal(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true)
      }
      const usable = async locator => {
        await locator.scrollIntoViewIfNeeded()
        await expect(locator).toBeVisible()
        assert.ok((await locator.boundingBox()).height >= 44)
        await locator.click()
        await expect(locator).toBeFocused()
      }
      const open = async name => {
        await page.getByRole('button', { name: new RegExp('^' + name + '(?:\\s|$)') }).click()
        await expect(page.getByRole('dialog')).toBeVisible()
        await expect(page.getByText('Loading your usual training rhythm...')).toHaveCount(0)
        if (name === 'Custom Distance') await page.getByLabel('Distance miles', { exact: true }).fill('8')
      }
      const submit = async () => page.getByRole('button', { name: 'Generate Training Block', exact: true }).click()
      await goto()
      const start = await page.evaluate(() => {
        const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
      })
      const addDays = days => new Date(Date.parse(start + 'T12:00:00Z') + days * 86400000).toISOString().slice(0,10)
      for (const name of ['5K','10K','Half Marathon','Marathon','Custom Distance']) {
        await open(name)
        const date = page.getByLabel('Train until (optional)', { exact: true })
        await usable(date)
        await expect(date).toHaveValue('')
        await page.getByLabel('Weeks', { exact: true }).fill('9')
        for (const days of [22, 28, 29, 140]) {
          await date.fill(addDays(days))
          await expect(page.locator('#block-train-until-preview')).toHaveText(`${Math.ceil(days/7)} weeks from today (rounded up).`)
        }
        await overflow()
        for (const days of [-1, 0, 21, 141]) {
          const before = writes.length
          await date.fill(addDays(days))
          await expect(page.locator('#block-train-until-preview [role="alert"]')).toBeVisible()
          await submit()
          assert.equal(writes.length, before, 'invalid date sends no request')
        }
        await page.getByRole('button', { name: 'Clear Train until', exact: true }).click()
        await expect(date).toHaveValue('')
        await expect(page.getByLabel('Weeks', { exact: true })).toBeEnabled()
        await expect(page.getByLabel('Weeks', { exact: true })).toHaveValue('9')
        await submit()
        await expect(page.getByRole('heading', { name: 'Plan navigation reached' })).toBeVisible()
        assert.equal(writes.at(-1).body.target.weeks, 9)
        await goto()
        for (const days of [22, 29, 140]) {
          await open(name)
          await page.getByLabel('Train until (optional)', { exact: true }).fill(addDays(days))
          await submit()
          await expect(page.getByRole('heading', { name: 'Plan navigation reached' })).toBeVisible()
          const request = writes.at(-1)
          assert.equal(request.pathname, '/api/plans/generate')
          const expected = loadTrainUntilHelper()(addDays(days), start).weeks
          assert.equal(request.body.target.weeks, expected)
          assert.ok(Number.isInteger(request.body.target.weeks))
          assert.equal(request.body.planning_date_local, start)
          assert.equal(Object.keys(request.body.target).some(key => /date|until/i.test(key)), false)
          await goto()
        }
        // Blank preserves default duration (no target.weeks), including new goal.
        await open(name)
        await expect(page.getByLabel('Train until (optional)', { exact: true })).toHaveValue('')
        await submit()
        await expect(page.getByRole('heading', { name: 'Plan navigation reached' })).toBeVisible()
        assert.equal(Object.hasOwn(writes.at(-1).body.target, 'weeks'), false)
        await goto()
      }
      // Goal changes, auth changes, and submit-time midnight revalidation.
      await open('5K')
      await page.getByLabel('Train until (optional)', { exact: true }).fill(addDays(22))
      await page.getByRole('button', { name: 'Close plan options' }).click()
      await open('10K')
      await expect(page.getByLabel('Train until (optional)', { exact: true })).toHaveValue('')
      await page.getByLabel('Train until (optional)', { exact: true }).fill(addDays(22))
      // Simulate native badInput separately from impossible calendar strings,
      // which native date controls sanitize to empty; helper tests cover those.
      await page.locator('#block-train-until').evaluate(el => Object.defineProperty(el, 'validity', { configurable: true, value: { badInput: true } }))
      const beforeBadInput = writes.length
      await submit()
      await expect(page.locator('#block-train-until-preview [role="alert"]')).toHaveText('Choose a valid Train until calendar date.')
      assert.equal(writes.length, beforeBadInput)
      await page.locator('#block-train-until').evaluate(el => delete el.validity)
      await page.getByRole('button', { name: 'Clear Train until', exact: true }).click()
      await page.getByLabel('Train until (optional)', { exact: true }).fill(addDays(22))
      const beforeRollover = writes.length
      await page.clock.setFixedTime(new Date('2026-11-04T20:00:00Z'))
      await submit()
      await expect(page.locator('#block-train-until-preview [role="alert"]')).toBeVisible()
      assert.equal(writes.length, beforeRollover)
      await page.evaluate(value => window.qaSetToken(value), token('another-synthetic'))
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByLabel('Access source')).toHaveText('subscription')
      await open('5K')
      await expect(page.getByLabel('Train until (optional)', { exact: true })).toHaveValue('')
      await page.getByRole('button', { name: 'Close plan options' }).click()
      await page.clock.setFixedTime(new Date('2026-11-03T04:30:00Z'))
      await page.getByRole('button', { name: 'Enter your race manually', exact: true }).click()
      const raceDate = page.getByLabel('Race date', { exact: true })
      assert.equal(await raceDate.getAttribute('id'), await page.locator('label[for="manual-race-date"]').getAttribute('for'))
      await usable(raceDate)
      await expect(raceDate).toHaveValue('')
      await expect(page.getByText('Select race date', { exact: true })).toBeVisible()
      await expect(page.getByLabel('Train until (optional)', { exact: true })).toHaveCount(0)
      await page.getByLabel('Race name', { exact: true }).fill('Synthetic QA Race')
      await page.getByLabel('Distance miles', { exact: true }).fill('6.2')
      const beforeRace = writes.length
      await page.getByRole('button', { name: 'Build Race Calendar', exact: true }).click()
      assert.equal(writes.length, beforeRace, 'empty race date retains validation')
      await raceDate.fill(addDays(60))
      await usable(raceDate)
      await expect(raceDate).toHaveValue(addDays(60))
      await expect(page.getByText('Select race date', { exact: true })).toBeVisible()
      await overflow()
      await page.getByRole('button', { name: 'Build Race Calendar', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Plan navigation reached' })).toBeVisible()
      assert.equal(writes.at(-2).body.race_date, addDays(60))
      assert.equal(writes.at(-1).pathname, '/api/plans/generate-for-race/synthetic-race')
      assert.deepEqual(errors, []); assert.deepEqual(unexpected, [])
      console.log(`PASS UI ONLY real WebKit ${browser.version()} 393x852 ${timezone}: all five goals, exact requests, clear/default, errors, rollover/auth, manual race date empty/filled/44px, overflow`)
    }
  } finally {
    for (const context of contexts) await context.close()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--check-entry')) {
    console.error('BLOCKED WebKit lifecycle: no browser launch/close under no-signals scope. Host must import runBrowserChecks(browser) with its permitted WebKit lifecycle. No browser acceptance claimed.')
    process.exitCode = 1
  } else await buildAndLink()
}
