import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import { MessageChannel } from 'node:worker_threads'

// Real coordinator with synthetic browser/storage/server boundaries. Real IDB and
// worker execution are separately mandatory in pushSetup.spec.mjs, not simulated here.
const source = await readFile(new URL('../src/lib/pushSetup.js', import.meta.url), 'utf8')
assert.equal((source.match(/^import /gm) || []).length, 2)
const imports = source.replace(/^import .*\n/gm, '')
globalThis.MessageChannel = MessageChannel
globalThis.window = new EventTarget()
globalThis.location = { href: 'https://forge.test/more', origin: 'https://forge.test' }
window.PushManager = class {}
window.Notification = globalThis.Notification = { permission: 'granted', requestPermission: async () => 'granted' }
const session = { token: 'synthetic-session', generation: 0 }, epoch = randomUUID()
const listeners = new Set(), rows = new Map(), calls = [], states = []
let current = true, responseHook, configHook, stateHook, unsubscribes = 0, confirmCalls = 0, statusState = 'RESERVED'
const subscription = { endpoint: 'https://fcm.googleapis.com/synthetic', keys: { p256dh: 'public-test-key', auth: 'test-auth' } }
const controller = { postMessage(message, ports) {
  const port = ports?.[0]
  if (!port) return
  const response = message.type === 'FORGE_PUSH_SETUP_HELLO'
    ? { protocol: 'FORGE_WEB_PUSH_SETUP_V1', nonce: message.nonce, revision: 'forge-push-setup-1', bootId, clientId: 'actual-synthetic-client' }
    : message.type === 'FORGE_PUSH_SETUP_HANDOFF' ? { protocol: 'FORGE_WEB_PUSH_SETUP_V1', challengeId, secret: challengeSecret, expiresAt: Date.now() + 300000 }
      : { protocol: 'FORGE_WEB_PUSH_SETUP_V1', state: 'WATCHING' }
  queueMicrotask(() => { port.postMessage(response); port.close() })
} }
const serviceWorker = new EventTarget(); serviceWorker.controller = controller
serviceWorker.getRegistration = async () => ({ active: controller, scope: 'https://forge.test/', pushManager: { getSubscription: async () => ({ toJSON: () => subscription, unsubscribe: async () => { unsubscribes++; return true } }) } })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serviceWorker } })
let operationId, challengeId, bootId = randomUUID(), challengeSecret = randomBytes(32).toString('base64url')
const targetId = randomUUID(), generation = randomUUID(), incarnation = randomUUID()
const dependencies = {
  getAuthSession: () => session, isAuthSessionCurrent: () => current, getPushSetupAuthEpoch: () => epoch,
  subscribeAuthSession: fn => { listeners.add(fn); return () => listeners.delete(fn) }, setupNow: Date.now,
  subscribePushSetupEpoch: () => () => {},
  listSetupOperations: async () => [...rows.values()].map(row => structuredClone(row)),
  putSetupOperation: async row => { rows.set(row.operationId, { ...row, createdAt: Date.now() }); return [] },
  updateSetupOperation: async (id, e, fn) => { const row = rows.get(id); if (!row || row.authEpoch !== e) return null; const result = fn(row, []); return result === undefined ? structuredClone(row) : result },
  eraseSetupOperation: async (id, e) => { if (rows.get(id)?.authEpoch === e) rows.delete(id) },
}
globalThis.__setupDependencies = dependencies
const body = `const {${Object.keys(dependencies).join(',')}} = globalThis.__setupDependencies;\n${imports}`
const { createPushSetupCoordinator } = await import('data:text/javascript;base64,' + Buffer.from(body).toString('base64'))
function state() { return { protocol: 'FORGE_WEB_PUSH_SETUP_V1', operationId, challengeId, expiresAt: Date.now() + 300000, state: statusState,
  ...(statusState === 'CONFIRMED' ? { targetId, generation, incarnation, revision: 1 } : {}) } }
globalThis.fetch = async (url, config) => {
  const action = url.split('/').at(-1), input = JSON.parse(config.body)
  assert.equal(config.cache, 'no-store'); assert.equal(config.redirect, 'error'); assert.equal(config.headers.Authorization, 'Bearer synthetic-session')
  calls.push({ action, input })
  const override = await responseHook?.(action, input, config)
  if (override) return override
  let result
  if (action === 'issue-create') { operationId = randomUUID(); challengeId = randomUUID(); statusState = 'RESERVED'; result = { protocol: input.protocol, operationId, createAdmission: 'test.capability', expiresAt: Date.now() + 120000 } }
  else if (action === 'create') { assert(rows.has(operationId), 'server operation must be durable locally before create'); result = state() }
  else if (action === 'status') result = state()
  else if (action === 'authorize-handoff') result = { protocol: input.protocol, challengeId, grant: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 30000 }
  else if (action === 'confirm') { confirmCalls++; statusState = 'CONFIRMED'; result = state() }
  else if (action === 'revoke') {
    const confirm = calls.filter(c => c.action === 'confirm').at(-1).input
    assert.equal(createHash('sha256').update(Buffer.from(input.possessionProof, 'base64url')).digest('hex'), confirm.nextPossessionProofHash)
    assert.equal(unsubscribes, 0); result = { protocol: input.protocol, state: 'REVOKED' }
  } else if (action === 'cancel') { result = { ...state(), state: 'CANCELLED' } }
  else throw Error('Unexpected action')
  return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
const make = () => createPushSetupCoordinator({ readConfig: async () => { await configHook?.(); return { configured: true, publicKey: 'BA' } }, onChange: s => { states.push(s); stateHook?.(s) } })

let flow = make()
await flow.init(); assert.equal(calls.length, 0); assert.equal(flow.snapshot().state, 'browser-subscription-present-server-unverified')
await flow.enable(); assert.deepEqual(calls.map(c => c.action), ['issue-create', 'create'])
await flow.continueSetup(); assert.equal(flow.snapshot().state, 'confirmed-current-controllable')
await flow.revoke(); assert.equal(flow.snapshot().state, 'server-revoked-known'); assert.equal(unsubscribes, 1)
flow.dispose()

// A lost confirmation is read back, never replaced with a new secret or blindly retried.
rows.clear(); calls.length = 0; unsubscribes = 0; flow = make(); await flow.init(); await flow.enable()
let lose = true
responseHook = async action => { if (action === 'confirm' && lose) { lose = false; statusState = 'CONFIRMED'; throw Error('synthetic response loss') } }
await flow.continueSetup()
assert.equal(flow.snapshot().state, 'confirmed-current-controllable')
assert.equal(calls.filter(c => c.action === 'confirm').length, 1)
assert.equal(calls.at(-1).action, 'status')
responseHook = null; await flow.revoke(); assert.equal(unsubscribes, 1); flow.dispose()

// Controller interruption at an awaited issue response cannot recreate an operation.
rows.clear(); calls.length = 0; unsubscribes = 0; flow = make(); await flow.init()
responseHook = async action => {
  if (action === 'issue-create') { serviceWorker.dispatchEvent(new Event('controllerchange')); return new Response(JSON.stringify({ protocol: 'FORGE_WEB_PUSH_SETUP_V1', operationId: randomUUID(), createAdmission: 'a.b', expiresAt: Date.now() + 120000 })) }
}
await flow.enable(); assert.equal(rows.size, 0); assert.equal(calls.filter(c => c.action === 'create').length, 0)
flow.dispose(); responseHook = null
// Lost response before commit: exact same confirmation/hash is retried only after a pending readback.
rows.clear(); calls.length = 0; unsubscribes = 0; flow = make(); await flow.init(); await flow.enable()
lose = true
responseHook = async action => { if (action === 'confirm' && lose) { lose = false; throw Error('synthetic lost response before commit') } }
await flow.continueSetup()
const confirmations = calls.filter(c => c.action === 'confirm')
assert.equal(confirmations.length, 2); assert.deepEqual(confirmations[0].input, confirmations[1].input)
assert.equal(flow.snapshot().state, 'confirmed-current-controllable')
responseHook = null; flow.dispose()

for (const failure of ['conflict', 'expired', 'unavailable']) {
  rows.clear(); calls.length = 0; unsubscribes = 0; flow = make(); await flow.init(); await flow.enable(); await flow.continueSetup()
  responseHook = async action => {
    if (action === 'revoke') throw Error('synthetic ambiguous revoke')
    if (action === 'status') return new Response(JSON.stringify({ error: 'synthetic' }), { status: failure === 'conflict' ? 409 : failure === 'expired' ? 410 : 503 })
  }
  await flow.revoke()
  assert.equal(unsubscribes, 0)
  assert.equal(calls.filter(c => c.action === 'revoke').length, 1)
  assert(!flow.snapshot().state.startsWith('server-revoked'))
  responseHook = null; flow.dispose()
}

// Changed worker boot never carries volatile possession into a new instance.
rows.clear(); calls.length = 0; flow = make(); await flow.init(); await flow.enable(); await flow.continueSetup()
bootId = randomUUID(); await flow.revoke()
assert.equal(calls.filter(c => c.action === 'revoke').length, 0)
flow.dispose()

// A stale unauthorized response must not alter the succeeding auth session.
rows.clear(); calls.length = 0; flow = make(); await flow.init()
responseHook = async action => {
  if (action === 'issue-create') { current = false; for (const listener of listeners) listener(); return new Response('{}', { status: 401 }) }
}
await flow.enable(); assert.equal(rows.size, 0); assert.equal(calls.filter(c => c.action === 'create').length, 0)
flow.dispose(); current = true; responseHook = null
// An older initialization cannot overwrite a subsequently started explicit flow.
rows.clear(); calls.length = 0; flow = make(); await flow.init()
let releaseConfig
configHook = () => new Promise(resolve => { releaseConfig = resolve })
const oldInit = flow.init()
await Promise.resolve()
await flow.enable()
releaseConfig(); await oldInit
assert.equal(flow.snapshot().state, 'setup-pending'); assert.equal(rows.size, 1)
configHook = null; flow.dispose()
await new Promise(resolve => setImmediate(resolve)) // Finish the preceding disposal's detached cancellation.

// A control mounted before the first worker claim must re-sample read-only.
// Exercise both a completed and a still-pending predecessor initialization.
const getRegistration = serviceWorker.getRegistration
serviceWorker.getRegistration = async () => ({ active: controller, scope: 'https://forge.test/', pushManager: { getSubscription: async () => null } })
for (const pendingConfig of [false, true]) {
  rows.clear(); calls.length = 0; states.length = 0; serviceWorker.controller = null
  let configReads = 0, release
  configHook = () => {
    if (++configReads === 1 && pendingConfig) return new Promise(resolve => { release = resolve })
  }
  flow = make()
  const predecessor = flow.init()
  if (!pendingConfig) { await predecessor; assert.equal(flow.snapshot().state, 'update-required') }
  let timer
  const sampled = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Error('First controller did not trigger a fresh subscription sample')), 2000)
    stateHook = state => { if (state.state === 'browser-subscription-absent-server-unverified') resolve() }
  })
  serviceWorker.controller = controller
  serviceWorker.dispatchEvent(new Event('controllerchange'))
  try { await sampled } finally { clearTimeout(timer); stateHook = null }
  assert.equal(flow.snapshot().state, 'browser-subscription-absent-server-unverified')
  assert.equal(configReads, 2)
  if (release) { release(); await predecessor }
  assert.equal(flow.snapshot().state, 'browser-subscription-absent-server-unverified', 'the interrupted predecessor cannot overwrite the fresh sample')
  assert.deepEqual(calls, [], 'first control cannot issue, confirm, revoke or cancel')
  serviceWorker.dispatchEvent(new Event('controllerchange'))
  assert.equal(flow.snapshot().state, 'verification-required', 'later controller changes still fence the flow')
  assert.equal(configReads, 2, 'later changes cannot automatically resume setup')
  flow.dispose()
}
serviceWorker.getRegistration = getRegistration; configHook = null
assert.equal(listeners.size, 0)
console.log('PUSH SETUP real coordinator synthetic-boundary gesture/order/response-loss/secret/revoke/controller tests PASS')
