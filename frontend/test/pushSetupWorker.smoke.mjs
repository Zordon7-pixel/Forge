import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { randomUUID, randomBytes, createHash, createECDH } from 'node:crypto'
import { chromium } from '@playwright/test'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import { createRequire } from 'node:module'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
export const digest = value => createHash('sha256').update(value).digest('hex')
export async function setupHarness({ oldWorker = false } = {}) {
  const curve = createECDH('prime256v1'); curve.generateKeys()
  const subscription = { endpoint: 'https://fcm.googleapis.com/synthetic-capability', keys: { p256dh: curve.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }
  const calls = [], operations = new Map(), notices = [], broadcasts = []
  const control = { subscription, before: null, after: null, status: null, permissionCalls: 0, unsubscribeCalls: 0, configReads: 0 }
  let page, worker
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture')
      if (url.pathname === '/api/notifications/push/config') {
        control.configReads++; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ configured: true, publicKey: 'BA' })); return
      }
      if (url.pathname.startsWith('/push-setup/v1/')) {
        let body = ''; for await (const chunk of req) body += chunk
        const input = JSON.parse(body), action = url.pathname.split('/').at(-1)
        calls.push({ action, input, authorization: req.headers.authorization })
        if (await control.before?.(action, input, req, res)) return
        let op = operations.get(input.operationId), result, status = 200
        if (action === 'issue-create') {
          const operationId = randomUUID()
          op = { ...input, operationId, challengeId: randomUUID(), state: 'RESERVED', expiresAt: Date.now() + 300000, secret: randomBytes(32).toString('base64url'), token: req.headers.authorization }
          operations.set(operationId, op)
          result = { protocol: input.protocol, operationId, createAdmission: 'synthetic.admission', expiresAt: Date.now() + 120000 }
        } else if (!op || op.authEpoch !== input.authEpoch || op.clientNonce !== input.clientNonce || (action !== 'redeem-handoff' && op.token !== req.headers.authorization)) { status = 409; result = { error: 'CLAIM_CHANGED' } }
        else if (action === 'create' || action === 'status') {
          if (control.status) { status = control.status; result = { error: 'CLAIM_CHANGED' } }
          else result = publicState(op)
        } else if (action === 'authorize-handoff') {
          op.grant = randomBytes(32).toString('base64url'); op.clientId = input.clientId
          result = { protocol: input.protocol, challengeId: op.challengeId, grant: op.grant, expiresAt: Date.now() + 30000 }
        } else if (action === 'redeem-handoff') {
          if (!op.grant || input.grant !== op.grant || input.clientId !== op.clientId) { status = 409; result = { error: 'CLAIM_CHANGED' } }
          else { op.grant = null; result = { protocol: input.protocol, challengeId: op.challengeId, operationId: op.operationId, clientId: op.clientId, authEpoch: op.authEpoch, clientNonceHash: digest(op.clientNonce), endpointHash: digest(op.subscription.endpoint), expiresAt: op.expiresAt } }
        } else if (action === 'confirm') {
          assert.equal(input.proof, op.secret)
          if (op.confirmation) assert.deepEqual(input, op.confirmation)
          else op.authorityEffects = (op.authorityEffects || 0) + 1
          op.confirmation = input
          op.state = 'CONFIRMED'; op.targetId ||= randomUUID(); op.generation ||= randomUUID(); op.incarnation ||= randomUUID(); op.revision ||= 1
          result = publicState(op)
        } else if (action === 'cancel') { op.state = 'CANCELLED'; result = publicState(op) }
        else if (action === 'revoke') {
          assert.equal(digest(Buffer.from(input.possessionProof, 'base64url')), op.confirmation.nextPossessionProofHash)
          assert.equal(input.generation, op.generation); op.revoked = true
          result = { protocol: input.protocol, state: 'REVOKED' }
        } else throw Error('Unexpected fixture action')
        if (await control.after?.(action, input, result, req, res)) return
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result)); return
      }
      if (url.pathname === '/' || url.pathname === '/more') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Isolated setup fixture</title><div id="root"></div>'); return }
      if (url.pathname === '/asset-manifest.json') { res.setHeader('Content-Type', 'application/json'); res.end('{}'); return }
      const relative = url.pathname === '/sw.js' ? (oldWorker ? 'test/fixtures/sw-f3627676.js' : 'public/sw.js') : url.pathname.slice(1)
      if (!relative.startsWith('src/') && !relative.startsWith('public/') && !relative.startsWith('test/fixtures/')) { res.writeHead(404); res.end(); return }
      const file = path.resolve(root, relative)
      if (!file.startsWith(root + path.sep)) throw Error('Out of fixture root')
      res.setHeader('Content-Type', 'text/javascript'); res.end(await readFile(file))
    } catch { res.writeHead(500); res.end('FIXTURE_FAILURE') }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ permissions: ['notifications'], serviceWorkers: 'allow' })
  page = await context.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}/more`)
  await page.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready })
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) await page.reload()
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller))
  worker = context.serviceWorkers()[0]
  await worker.evaluate(() => {
    self.__notices = []; self.__signals = []
    self.registration.showNotification = async (title, options) => { self.__notices.push({ title, ...options }) }
  })
  const initialize = () => page.evaluate(async subscription => {
    window.__subscription = subscription; window.__unsubscribes = 0; window.__states = []
    const manager = {
      getSubscription: async () => window.__subscription && ({ toJSON: () => structuredClone(window.__subscription), endpoint: window.__subscription.endpoint,
        unsubscribe: async () => { window.__unsubscribes++; if (window.__unsubscribeHold) return new Promise((resolve, reject) => { window.__finishUnsubscribe = mode => mode === 'reject' ? reject(Error('synthetic')) : resolve(false) }); if (window.__unsubscribeFails) throw Error('synthetic'); window.__subscription = null; return true } }),
      subscribe: async () => { if (window.__subscribeHold) await new Promise((resolve, reject) => { window.__finishSubscribe = () => reject(Error('synthetic')) }); window.__subscription = subscription; return manager.getSubscription() },
    }
    Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', { configurable: true, get: () => manager })
    window.__token = await import('/src/lib/tokenStore.js')
    // Ordinary reload restores authentication; it is not another successful login.
    if (!window.__token.getToken()) window.__token.setToken('synthetic-session-a')
    window.__module = await import('/src/lib/pushSetup.js')
    window.__flow = window.__module.createPushSetupCoordinator({ readConfig: async () => ({ configured: true, publicKey: 'BA' }), onChange: state => window.__states.push(state) })
    await window.__flow.init()
  }, subscription)
  await initialize()
  function publicState(op) { return { protocol: op.protocol, operationId: op.operationId, challengeId: op.challengeId, state: op.state, expiresAt: op.expiresAt,
    ...(op.state === 'CONFIRMED' ? { targetId: op.targetId, generation: op.generation, incarnation: op.incarnation, revision: op.revision } : {}) } }
  function payload(op) { return { title: 'Forged Hybrid', body: 'Open Forge to finish enabling notifications.', url: '/more', notificationId: `forge-push-setup:${op.challengeId}`,
    setup: { protocol: op.protocol, challengeId: op.challengeId, operationId: op.operationId, clientNonceHash: digest(op.clientNonce), authEpoch: op.authEpoch, endpointHash: digest(op.subscription.endpoint), secret: op.secret, expiresAt: op.expiresAt } } }
  return {
    get page() { return page }, worker, context, calls, operations, control, payload, initialize,
    async mountControl() {
      // Bundle the actual React component and its real imports in memory. Only
      // HTTP, PushManager and visible OS notification boundaries are synthetic.
      const require = createRequire(import.meta.url)
      const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
      const result = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Control from './src/components/WorkoutNotificationControl.jsx'; import * as tokens from './src/lib/tokenStore.js'; window.__token=tokens; window.__mountControl=()=>{window.__root=createRoot(document.getElementById('root'));window.__root.render(React.createElement(Control))}; window.__mountControl();`, resolveDir: root, loader: 'jsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' } })
      await page.evaluate(() => {
        window.__flow.dispose()
        window.__listenerCounts = {}
        for (const [target, types] of [[navigator.serviceWorker, ['controllerchange', 'message']], [window, ['pagehide', 'pageshow']]]) {
          const add = target.addEventListener.bind(target), remove = target.removeEventListener.bind(target)
          const sets = new Map(types.map(type => [type, new Set()]))
          target.addEventListener = (type, listener, ...options) => { if (sets.has(type)) { sets.get(type).add(listener); window.__listenerCounts[type] = sets.get(type).size }; return add(type, listener, ...options) }
          target.removeEventListener = (type, listener, ...options) => { if (sets.has(type)) { sets.get(type).delete(listener); window.__listenerCounts[type] = sets.get(type).size }; return remove(type, listener, ...options) }
        }
      })
      await page.addScriptTag({ content: result.outputFiles[0].text })
      await page.getByRole('button', { name: 'Enable notifications', exact: true }).waitFor()
    },
    async reopen() { page = await context.newPage(); await page.goto(`http://127.0.0.1:${server.address().port}/more`); await initialize(); return page },
    async push(value = payload([...operations.values()].at(-1))) {
      await worker.evaluate(async payload => {
        const pending = [], event = new Event('push')
        Object.defineProperty(event, 'data', { value: { json: () => JSON.parse(JSON.stringify(payload)) } })
        event.waitUntil = promise => pending.push(promise)
        self.dispatchEvent(event); await Promise.all(pending)
      }, value)
    },
    async stores() { return page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('forge-push-setup-v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = reject })
      try { return await Promise.all(['operations', 'proofs'].map(name => new Promise((resolve, reject) => { const r = db.transaction(name).objectStore(name).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = reject }))) }
      finally { db.close() }
    }) },
    async notices() { return worker.evaluate(() => self.__notices) },
    async close() { await page.evaluate(() => { window.__root?.unmount(); window.__flow?.dispose() }).catch(() => {}); await context.close(); await browser.close(); await new Promise(resolve => server.close(resolve)) },
  }
}

export async function workerWitnesses() {
  const h = await setupHarness()
  try {
    assert.equal(h.calls.length, 0)
    assert.equal(await h.page.evaluate(() => window.__flow.snapshot().state), 'browser-subscription-present-server-unverified')
    await h.page.evaluate(() => window.__flow.enable())
    assert.deepEqual(h.calls.map(x => x.action), ['issue-create', 'create'])
    await h.push()
    let [ops, proofs] = await h.stores()
    assert.equal(ops.length, 1); assert.equal(proofs.length, 1)
    const notice = (await h.notices())[0]
    assert.equal(notice.body, 'Open Forge to finish enabling notifications.')
    assert.deepEqual(Object.keys(notice.data).sort(), ['challengeId', 'kind', 'url'])
    assert(!JSON.stringify(notice).includes(proofs[0].secret))
    const original = h.payload([...h.operations.values()][0])
    const malformed = [p => { p.type = 'conflict' }, p => { p.setup.extra = 1 }, p => { p.body = 'Run saved' }, p => { p.notificationId += 'wrong' }, p => { p.setup.secret += '=' }, p => { p.setup.authEpoch = 'invalid' }, p => { delete p.setup.protocol },
      p => { p.extra = true }, p => { p.setup.operationId = randomUUID() }, p => { p.setup.clientNonceHash = '0'.repeat(64) }, p => { p.setup.endpointHash = '0'.repeat(64) },
      p => { p.setup.expiresAt = -1 }, p => { p.setup.expiresAt = 0.5 }, p => { p.setup.secret = 'a'.repeat(9000) }, p => { p.setup.challengeId = randomUUID() }]
    for (const mutate of malformed) {
      const hostile = structuredClone(original); mutate(hostile)
      const before = await h.stores(); await h.push(hostile); assert.deepEqual(await h.stores(), before)
    }
    assert.equal((await h.notices()).length, 1 + malformed.length)
    await h.page.evaluate(() => window.__flow.continueSetup())
    assert.equal(await h.page.evaluate(() => window.__flow.snapshot().state), 'confirmed-current-controllable')
    ;[ops, proofs] = await h.stores(); assert.equal(proofs.length, 0)
    assert(!JSON.stringify(ops).includes([...h.operations.values()][0].secret))
    await h.page.evaluate(() => window.__flow.revoke())
    assert.equal(await h.page.evaluate(() => window.__flow.snapshot().state), 'server-revoked-known')
    assert.equal(await h.page.evaluate(() => window.__unsubscribes), 1)
    assert.equal(h.calls.at(-1).action, 'revoke')
  } finally { await h.close() }
}
export async function isolatedWorkerWitnesses() {
  const source = await readFile(path.join(root, 'public/sw.js'), 'utf8')
  const listeners = new Map(), notices = [], requests = [], messages = []
  const context = vm.createContext({ crypto: webcrypto, performance, Date, TextEncoder, structuredClone, URL, Request, Response, AbortController,
    setTimeout, clearTimeout, btoa, atob, console: { error() { throw Error('Unexpected worker log') } },
    indexedDB: { open() { throw Error('Synthetic unavailable storage') } },
    fetch: async request => { requests.push(request); throw Error('Synthetic offline') },
    self: { location: { origin: 'https://forge.test' }, addEventListener: (name, listener) => listeners.set(name, listener),
      registration: { scope: 'https://forge.test/', showNotification: async (title, options) => notices.push(JSON.parse(JSON.stringify({ title, ...options }))) },
      clients: { matchAll: async () => [{ postMessage: data => messages.push(data) }] } },
  })
  vm.runInContext(source, context)
  const input = { title: 'Forged Hybrid', body: 'Open Forge to finish enabling notifications.', url: '/more', notificationId: 'forge-push-setup:' + randomUUID(),
    setup: { protocol: 'FORGE_WEB_PUSH_SETUP_V1', challengeId: randomUUID(), operationId: randomUUID(), clientNonceHash: 'a'.repeat(64), authEpoch: randomUUID(), endpointHash: 'b'.repeat(64), secret: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 300000 } }
  input.notificationId = 'forge-push-setup:' + input.setup.challengeId
  for (const payload of [input, { ...input, type: 'FORGE_WEB_PUSH_SETUP_V1' }, { ...input, type: 'wrong' }, { type: 'FORGE_WEB_PUSH_SETUP_V1' }, { setup: { secret: 'private' }, body: 'Run saved' }]) {
    let pending
    listeners.get('push')({ data: { json: () => vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(payload))})`, context) }, waitUntil: p => { pending = p } })
    await pending
  }
  assert.equal(notices.length, 5); assert.equal(messages.length, 0)
  for (const notice of notices) { assert.equal(notice.body, input.body); assert.equal(notice.title, input.title); assert(!JSON.stringify(notice).includes(input.setup.secret)) }
  let malformedHandling
  listeners.get('push')({ data: { json() { throw Error('secret must not be logged') }, text: () => '{"setup":{"secret":"private"' }, waitUntil: p => { malformedHandling = p } })
  await malformedHandling
  assert.equal(notices.at(-1).body, input.body); assert(!JSON.stringify(notices.at(-1)).includes('private'))
  let response
  listeners.get('fetch')({ request: new Request('https://forge.test/push-setup/v1/confirm', { method: 'POST', body: 'private' }), respondWith: p => { response = p } })
  await assert.rejects(response, /Synthetic offline/)
  assert.equal(requests.length, 1); assert.equal(requests[0].cache, 'no-store'); assert.equal(requests[0].redirect, 'error')
  assert.equal(digest(await readFile(path.join(root, 'test/fixtures/sw-f3627676.js'))), 'c4aa38138185653d596e7618fa119b2c240b4334ef6e74021ecc06c18d031ba0')
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await isolatedWorkerWitnesses()
  console.log('PUSH SETUP WORKER module secrecy/visible-failure/network-only witnesses PASS; actual IDB/ports run in the SW browser suite')
}
