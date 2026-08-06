import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

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
      skipWaiting: () => {},
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
  assert.match(source, /const CACHE = 'forge-v6'/, 'cache version purges incomplete v5 app shells')
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
  assert.deepEqual(
    installation.puts.map(({ request }) => new URL(typeof request === 'string' ? request : request.url).pathname).sort(),
    ['/', '/asset-manifest.json', '/assets/app.css', '/assets/app.js', '/assets/login.js'],
    'install atomically precaches the HTML shell, asset manifest, and every generated code chunk',
  )

  const activation = buildWorkerHarness()
  activation.setCacheNames(['forge-v4', 'forge-v5', 'forge-v6', 'forge-api-v1', 'forge-api-v2'])
  await dispatchLifecycle(activation, 'activate')
  assert.deepEqual(activation.deletes, ['forge-v4', 'forge-v5', 'forge-api-v1'], 'activation deletes incomplete app caches and the unpartitioned API cache')

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

  console.log('SERVICE WORKER CACHE SMOKE OK (15)')
}

await runServiceWorkerCacheSmoke()
