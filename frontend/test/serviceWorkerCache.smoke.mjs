import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { ACTIVE_RUN_SESSION_KEY } from '../src/lib/activeRunSession.js'
import { reloadSafety, ServiceWorkerUpdateManager } from '../src/lib/serviceWorkerUpdate.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = fs.readFileSync(path.join(root, 'public/sw.js'), 'utf8')

function buildWorkerHarness() {
  const listeners = new Map()
  const puts = []
  const deletes = []
  let nextResponse = new Response('', { status: 500 })
  let responseQueue = []
  let fetchError = null
  let cacheNames = []
  let cachePutWait = Promise.resolve()
  const cacheMatches = new Map()
  let skipWaitingCalls = 0

  const cache = {
    addAll: async () => {},
    put: async (request, response) => {
      puts.push({ request, response })
      await cachePutWait
    },
    match: async (request, options) => cacheMatches.get(`${typeof request === 'string' ? request : request.url}|${Boolean(options?.ignoreVary)}`) || null,
  }

  const sandbox = {
    URL,
    Request,
    Response,
    console,
    fetch: async () => {
      if (fetchError) throw fetchError
      if (responseQueue.length) return responseQueue.shift().clone()
      return nextResponse.clone()
    },
    caches: {
      open: async () => cache,
      keys: async () => [...cacheNames],
      delete: async (name) => {
        deletes.push(name)
        cacheNames = cacheNames.filter((candidate) => candidate !== name)
        return true
      },
    match: async (request, options) => cacheMatches.get(`${typeof request === 'string' ? request : request.url}|${Boolean(options?.ignoreVary)}`) || null,
    },
    self: {
      addEventListener: (type, handler) => listeners.set(type, handler),
      skipWaiting: async () => { skipWaitingCalls += 1 },
      clients: {
        claim: async () => {},
        matchAll: async () => [],
      },
      location: { origin: 'https://forge.test' },
    },
  }

  vm.runInNewContext(source, sandbox, { filename: 'sw.js' })

  return {
    listeners,
    puts,
    deletes,
    get skipWaitingCalls() {
      return skipWaitingCalls
    },
    setCacheNames(names) {
      cacheNames = [...names]
    },
    setResponse(response) {
      nextResponse = response
      responseQueue = []
      fetchError = null
    },
    setResponses(responses) {
      responseQueue = [...responses]
      fetchError = null
    },
    setFetchError(error) {
      fetchError = error
    },
    setCachePutWait(value) {
      cachePutWait = value
    },
    setCacheMatch(request, response, options = {}) {
      cacheMatches.set(`${typeof request === 'string' ? request : request.url}|${Boolean(options.ignoreVary)}`, response)
    },
  }
}

async function dispatchLifecycle(harness, type) {
  let workPromise
  harness.listeners.get(type)({
    waitUntil(value) {
      workPromise = Promise.resolve(value)
    },
  })
  assert.ok(workPromise, `${type} handler registers lifecycle work`)
  await workPromise
}

async function dispatchFetch(harness, pathname, init = {}) {
  let responsePromise
  harness.listeners.get('fetch')({
    request: new Request(`https://forge.test${pathname}`, init),
    respondWith(value) {
      responsePromise = Promise.resolve(value)
    },
  })
  assert.ok(responsePromise, `fetch handler responds to ${pathname}`)
  const response = await responsePromise
  await new Promise((resolve) => setImmediate(resolve))
  return response
}

async function runServiceWorkerCacheSmoke() {
  assert.match(source, /const CACHE = 'forge-v8'/, 'cache version advances for controlled activation')
  assert.match(source, /hasExpectedAssetType\(url, response\)/, 'static responses are type-checked before caching')

  const installation = buildWorkerHarness()
  installation.setResponses([
    new Response('<link rel="stylesheet" href="/assets/app.css"><script type="module" src="/assets/app.js"></script>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
    new Response(JSON.stringify({
      'src/main.jsx': { file: 'assets/app.js', css: ['assets/app.css'] },
      'src/pages/Login.jsx': { file: 'assets/login.js' },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
    new Response('body{}', { status: 200, headers: { 'content-type': 'text/css' } }),
    new Response('export default true', { status: 200, headers: { 'content-type': 'application/javascript' } }),
    new Response('export default true', { status: 200, headers: { 'content-type': 'application/javascript' } }),
  ])
  await dispatchLifecycle(installation, 'install')
  assert.equal(installation.skipWaitingCalls, 0, 'install waits for the page-side safety gate instead of activating unconditionally')
  assert.deepEqual(
    installation.puts.map(({ request }) => new URL(typeof request === 'string' ? request : request.url).pathname).sort(),
    ['/', '/asset-manifest.json', '/assets/app.css', '/assets/app.js', '/assets/login.js'],
    'install atomically precaches the HTML shell, asset manifest, and every generated code chunk',
  )

  const activation = buildWorkerHarness()
  activation.setCacheNames(['forge-v4', 'forge-v5', 'forge-v6', 'forge-v7', 'forge-v8', 'forge-api-v1', 'forge-api-v2'])
  await dispatchLifecycle(activation, 'activate')
  assert.deepEqual(activation.deletes, ['forge-v4', 'forge-v5', 'forge-v6', 'forge-v7', 'forge-api-v1'], 'activation deletes stale app caches and the unpartitioned API cache')

  const messagedActivation = buildWorkerHarness()
  let activationWork
  messagedActivation.listeners.get('message')({
    data: { type: 'FORGE_ACTIVATE_UPDATE' },
    waitUntil(value) { activationWork = Promise.resolve(value) },
  })
  await activationWork
  assert.equal(messagedActivation.skipWaitingCalls, 1, 'the explicit page message activates a waiting worker')
  let reportedVersion = null
  messagedActivation.listeners.get('message')({
    data: { type: 'FORGE_GET_VERSION' },
    ports: [{ postMessage(value) { reportedVersion = value } }],
  })
  assert.equal(reportedVersion?.type, 'FORGE_SW_VERSION')
  assert.equal(reportedVersion?.revision, 'forge-v8', 'worker reports its cache revision for loop-bounded adoption')

  const isolatedApi = buildWorkerHarness()
  isolatedApi.setResponse(new Response('{"units":"imperial"}', {
    status: 200,
    headers: { 'content-type': 'application/json', vary: 'Origin, Authorization' },
  }))
  await dispatchFetch(isolatedApi, '/api/users/settings', { headers: { Authorization: 'Bearer user-a' } })
  assert.equal(isolatedApi.puts.length, 1, 'authorization-varying API responses are cached')

  const unpartitionedApi = buildWorkerHarness()
  unpartitionedApi.setResponse(new Response('{"units":"imperial"}', {
    status: 200,
    headers: { 'content-type': 'application/json', vary: 'Origin' },
  }))
  await dispatchFetch(unpartitionedApi, '/api/users/settings', { headers: { Authorization: 'Bearer user-a' } })
  assert.equal(unpartitionedApi.puts.length, 0, 'API responses without Authorization variance are never cached')

  for (const pathname of [
    '/api/races/race-1/removal-preview',
    '/api/races/race-1/removal-apply',
    '/api/plans/candidates/candidate-1/apply',
    '/api/plans/adaptation/proposal-1/accept',
    '/api/plans/adaptation/proposal-1/keep',
  ]) {
    const replayUnsafeMutation = buildWorkerHarness()
    replayUnsafeMutation.setFetchError(new Error('offline'))
    await assert.rejects(
      () => dispatchFetch(replayUnsafeMutation, pathname, { method: 'POST' }),
      /offline/,
      `${pathname} fails immediately offline instead of being replayed later against changed plan state`,
    )
  }

  const validJs = buildWorkerHarness()
  validJs.setResponse(new Response('export default true', {
    status: 200,
    headers: { 'content-type': 'application/javascript' },
  }))
  await dispatchFetch(validJs, '/assets/app.js')
  assert.equal(validJs.puts.length, 1, 'valid JavaScript is cached')

  let releaseCacheWrite
  const durableJs = buildWorkerHarness()
  durableJs.setResponse(new Response('export default true', {
    status: 200,
    headers: { 'content-type': 'application/javascript' },
  }))
  durableJs.setCachePutWait(new Promise((resolve) => {
    releaseCacheWrite = resolve
  }))
  let durableResponseSettled = false
  const durableResponse = dispatchFetch(durableJs, '/assets/durable.js').then((response) => {
    durableResponseSettled = true
    return response
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(durableResponseSettled, false, 'static response waits for its offline cache write')
  releaseCacheWrite()
  assert.equal((await durableResponse).status, 200, 'static response returns after its offline cache is durable')

  const htmlAsJs = buildWorkerHarness()
  htmlAsJs.setResponse(new Response('<!doctype html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=UTF-8' },
  }))
  await dispatchFetch(htmlAsJs, '/assets/missing.js')
  assert.equal(htmlAsJs.puts.length, 0, 'HTML returned for JavaScript is never cached')

  const validCss = buildWorkerHarness()
  validCss.setResponse(new Response('body{}', {
    status: 200,
    headers: { 'content-type': 'text/css' },
  }))
  await dispatchFetch(validCss, '/assets/app.css')
  assert.equal(validCss.puts.length, 1, 'valid CSS is cached')

  const htmlAsCss = buildWorkerHarness()
  htmlAsCss.setResponse(new Response('<!doctype html>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=UTF-8' },
  }))
  await dispatchFetch(htmlAsCss, '/assets/missing.css')
  assert.equal(htmlAsCss.puts.length, 0, 'HTML returned for CSS is never cached')

  const cachedVaryingJs = buildWorkerHarness()
  cachedVaryingJs.setFetchError(new Error('offline'))
  cachedVaryingJs.setCacheMatch(
    'https://forge.test/assets/cached.js',
    new Response('export default true', { status: 200, headers: { 'content-type': 'application/javascript' } }),
    { ignoreVary: true },
  )
  const cachedVaryingResponse = await dispatchFetch(cachedVaryingJs, '/assets/cached.js')
  assert.equal(cachedVaryingResponse.status, 200, 'offline static lookup ignores server Vary headers for the same versioned URL')

  const offlineJs = buildWorkerHarness()
  offlineJs.setFetchError(new Error('offline'))
  const offlineResponse = await dispatchFetch(offlineJs, '/assets/uncached.js')
  assert.equal(offlineResponse.status, 503, 'uncached offline JavaScript returns an explicit unavailable response')
  assert.match(offlineResponse.headers.get('content-type') || '', /^text\/plain/i, 'offline JavaScript never receives the HTML shell')

  const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8')
  assert.doesNotMatch(indexSource, /window\.addEventListener\('load'.*serviceWorker\.register/s,
    'registration is no longer limited to the first window load')

  const storage = (initial = {}) => {
    const values = new Map(Object.entries(initial))
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
    }
  }
  const safeDocument = new EventTarget()
  Object.assign(safeDocument, {
    readyState: 'complete',
    visibilityState: 'visible',
    querySelector: () => null,
    querySelectorAll: () => [],
  })
  assert.deepEqual(reloadSafety({
    pathname: '/run/active',
    document: safeDocument,
    localStorage: storage(),
  }), { safe: false, reason: 'active-interaction' }, 'active run routes fail closed')
  assert.deepEqual(reloadSafety({
    pathname: '/login',
    document: { ...safeDocument, querySelectorAll: (selector) => selector.startsWith('input') ? [{ value: 'draft', defaultValue: '', tagName: 'INPUT' }] : [] },
    localStorage: storage(),
  }), { safe: false, reason: 'unsaved-interaction' }, 'dirty forms fail closed')

  const controlledInput = {
    tagName: 'INPUT',
    type: 'email',
    value: 'draft@example.com',
    defaultValue: '',
    disabled: false,
    readOnly: false,
    isConnected: true,
  }
  const controlledDocument = new EventTarget()
  Object.assign(controlledDocument, {
    readyState: 'complete',
    visibilityState: 'visible',
    querySelector: () => null,
    querySelectorAll: (selector) => selector.startsWith('input') ? [controlledInput] : [],
  })
  let controlledActivations = 0
  let controlledReloads = 0
  const controlledWorkerContainer = new EventTarget()
  const controlledRegistration = new EventTarget()
  const controlledWorker = {
    scriptURL: 'https://forge.test/sw.js?v=forge-v7',
    state: 'installed',
    postMessage(message, ports = []) {
      if (message?.type === 'FORGE_GET_VERSION') {
        ports[0]?.postMessage({ type: 'FORGE_SW_VERSION', revision: 'forge-v7' })
      }
      if (message?.type === 'FORGE_ACTIVATE_UPDATE') {
        controlledActivations += 1
        queueMicrotask(() => {
          controlledRegistration.waiting = null
          controlledWorkerContainer.controller = controlledWorker
          controlledWorkerContainer.dispatchEvent(new Event('controllerchange'))
        })
      }
    },
  }
  Object.assign(controlledRegistration, {
    installing: null,
    waiting: controlledWorker,
    update: async () => controlledRegistration,
  })
  Object.assign(controlledWorkerContainer, {
    controller: { scriptURL: 'https://forge.test/sw.js?v=forge-v6', state: 'activated' },
    register: async () => controlledRegistration,
  })
  const controlledManager = new ServiceWorkerUpdateManager({
    window: new EventTarget(),
    document: controlledDocument,
    serviceWorker: controlledWorkerContainer,
    localStorage: storage(),
    sessionStorage: storage(),
    location: { pathname: '/login', reload: () => { controlledReloads += 1 } },
    logger: { info() {}, warn() {} },
  })
  controlledManager.trackControlInput(controlledInput)
  controlledInput.defaultValue = controlledInput.value
  await controlledManager.start()
  assert.deepEqual(controlledManager.currentSafety(), { safe: false, reason: 'unsaved-interaction' },
    'capture-time form tracking remains fail-closed after React synchronizes controlled defaultValue')
  assert.equal(controlledActivations, 0, 'an installed update remains waiting while the controlled form is dirty')
  assert.deepEqual(controlledManager.getSnapshot(), {
    phase: 'update-ready',
    actionRequired: true,
    reason: 'unsaved-interaction',
    revision: 'forge-v7',
  }, 'the dirty-form deferral truthfully requires user action')
  controlledInput.value = ''
  controlledManager.trackControlInput(controlledInput)
  controlledInput.defaultValue = ''
  assert.deepEqual(controlledManager.currentSafety(), { safe: true, reason: null },
    'returning a controlled field to its captured baseline makes explicit activation safe')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(controlledActivations, 0, 'making the form safe does not create a noisy automatic activation')
  await controlledManager.requestUpdate()
  assert.equal(controlledActivations, 1, 'the explicit user request activates the waiting update once')
  assert.equal(controlledReloads, 1, 'the explicitly activated update reloads once')
  controlledWorkerContainer.dispatchEvent(new Event('controllerchange'))
  assert.equal(controlledReloads, 1, 'the dirty-form path also rejects a repeated controllerchange reload')
  const adoptedSessionStorage = storage({
    forge_sw_reloaded_revision_v1: 'forge-v7',
  })
  let adoptedReloads = 0
  const adoptedManager = new ServiceWorkerUpdateManager({
    window: new EventTarget(),
    document: safeDocument,
    serviceWorker: new EventTarget(),
    localStorage: storage(),
    sessionStorage: adoptedSessionStorage,
    location: { pathname: '/login', reload: () => { adoptedReloads += 1 } },
    logger: { info() {}, warn() {} },
  })
  adoptedManager.pendingReloadRevision = 'forge-v7'
  assert.equal(adoptedManager.reloadAfterActivation(), false,
    'the final document recognizes the adopted revision instead of beginning another navigation stage')
  assert.equal(adoptedReloads, 0, 'the adoption marker prevents a second same-revision reload')
  assert.equal(adoptedManager.getSnapshot().phase, 'update-adopted',
    'the stable final document records the completed adoption lifecycle')
  assert.deepEqual(reloadSafety({
    pathname: '/login',
    document: safeDocument,
    localStorage: storage(),
    hasPendingMutation: () => true,
  }), { safe: false, reason: 'pending-mutation' }, 'in-flight mutations fail closed')
  assert.deepEqual(reloadSafety({
    pathname: '/',
    document: safeDocument,
    localStorage: storage({
      [ACTIVE_RUN_SESSION_KEY]: JSON.stringify({ phase: 'paused', startedAt: 500, savedAt: 900 }),
    }),
    now: 1_000,
  }), { safe: false, reason: 'active-run' }, 'persisted active-run state protects reload even away from the run route')

  const managerSource = fs.readFileSync(path.join(root, 'src/lib/serviceWorkerUpdate.js'), 'utf8')
  assert.match(managerSource, /add\('appStateChange'/, 'Capacitor foreground state is observed where available')
  assert.match(managerSource, /add\('resume'/, 'Capacitor resume is observed where available')
  const apiSource = fs.readFileSync(path.join(root, 'src/lib/api.js'), 'utf8')
  assert.match(apiSource, /beginMutation\(cfg\)/, 'API mutations enter the reload safety window')
  assert.match(apiSource, /settleMutation\(response\.config\)/, 'successful API mutations leave the reload safety window')
  assert.match(apiSource, /settleMutation\(error\?\.config\)/, 'failed API mutations leave the reload safety window')

  let now = 1_000
  let updateCalls = 0
  let activationRequests = 0
  let reloads = 0
  const workerContainer = new EventTarget()
  const registration = new EventTarget()
  const olderWorker = { scriptURL: 'https://forge.test/sw.js?v=forge-v6', state: 'activated' }
  const newerWorker = new EventTarget()
  Object.assign(newerWorker, {
    scriptURL: 'https://forge.test/sw.js?v=forge-v7',
    state: 'installing',
    postMessage(message, ports = []) {
      if (message?.type === 'FORGE_GET_VERSION') {
        ports[0]?.postMessage({ type: 'FORGE_SW_VERSION', revision: 'forge-v7' })
      }
      if (message?.type === 'FORGE_ACTIVATE_UPDATE') {
        activationRequests += 1
        queueMicrotask(() => {
          registration.waiting = null
          workerContainer.controller = newerWorker
          workerContainer.dispatchEvent(new Event('controllerchange'))
        })
      }
    },
  })
  Object.assign(registration, {
    installing: null,
    waiting: null,
    async update() {
      updateCalls += 1
      if (updateCalls !== 2) return registration
      registration.installing = newerWorker
      registration.dispatchEvent(new Event('updatefound'))
      queueMicrotask(() => {
        newerWorker.state = 'installed'
        registration.waiting = newerWorker
        newerWorker.dispatchEvent(new Event('statechange'))
      })
      return registration
    },
  })
  Object.assign(workerContainer, {
    controller: olderWorker,
    register: async () => registration,
  })
  const windowHarness = new EventTarget()
  const manager = new ServiceWorkerUpdateManager({
    window: windowHarness,
    document: safeDocument,
    serviceWorker: workerContainer,
    localStorage: storage(),
    sessionStorage: storage(),
    location: { pathname: '/login', reload: () => { reloads += 1 } },
    now: () => now,
    minCheckIntervalMs: 30_000,
    logger: { info() {}, warn() {} },
  })
  await manager.start()
  assert.equal(updateCalls, 1, 'initial load performs one explicit update check')
  now += 60_000
  manager.handleForeground('visibility')
  manager.handleForeground('pageshow')
  for (let index = 0; index < 8 && reloads === 0; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(updateCalls, 2, 'overlapping foreground signals collapse to one update check')
  assert.equal(activationRequests, 1, 'the installed update receives one controlled activation request')
  assert.equal(reloads, 1, 'controllerchange adopts the activated update with one reload')
  workerContainer.dispatchEvent(new Event('controllerchange'))
  assert.equal(reloads, 1, 'repeated controllerchange cannot create a reload loop')

  console.log('SERVICE WORKER CACHE + UPDATE SMOKE OK')
}

await runServiceWorkerCacheSmoke()
