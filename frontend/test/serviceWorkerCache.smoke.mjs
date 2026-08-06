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
  let fetchError = null
  let cacheNames = []

  const cache = {
    addAll: async () => {},
    put: async (request, response) => {
      puts.push({ request, response })
    },
  }

  const sandbox = {
    URL,
    Request,
    Response,
    console,
    fetch: async () => {
      if (fetchError) throw fetchError
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
      match: async () => null,
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
      fetchError = null
    },
    setFetchError(error) {
      fetchError = error
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

async function dispatchFetch(harness, pathname) {
  let responsePromise
  harness.listeners.get('fetch')({
    request: new Request(`https://forge.test${pathname}`),
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
  assert.match(source, /const CACHE = 'forge-v5'/, 'cache version purges pre-fix responses')
  assert.match(source, /hasExpectedAssetType\(url, response\)/, 'static responses are type-checked before caching')

  const activation = buildWorkerHarness()
  activation.setCacheNames(['forge-v4', 'forge-v5', 'forge-api-v1'])
  await dispatchLifecycle(activation, 'activate')
  assert.deepEqual(activation.deletes, ['forge-v4'], 'v5 activation deletes the poisoned v4 cache only')

  const validJs = buildWorkerHarness()
  validJs.setResponse(new Response('export default true', {
    status: 200,
    headers: { 'content-type': 'application/javascript' },
  }))
  await dispatchFetch(validJs, '/assets/app.js')
  assert.equal(validJs.puts.length, 1, 'valid JavaScript is cached')

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

  const offlineJs = buildWorkerHarness()
  offlineJs.setFetchError(new Error('offline'))
  const offlineResponse = await dispatchFetch(offlineJs, '/assets/uncached.js')
  assert.equal(offlineResponse.status, 503, 'uncached offline JavaScript returns an explicit unavailable response')
  assert.match(offlineResponse.headers.get('content-type') || '', /^text\/plain/i, 'offline JavaScript never receives the HTML shell')

  console.log('SERVICE WORKER CACHE SMOKE OK (9)')
}

await runServiceWorkerCacheSmoke()
