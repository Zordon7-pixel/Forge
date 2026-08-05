import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const frontendRoot = fileURLToPath(new URL('..', import.meta.url))
const vite = await createServer({
  root: frontendRoot,
  appType: 'custom',
  logLevel: 'silent',
  server: { middlewareMode: true },
})

const {
  installChunkRecovery,
  isRecoverableChunkBoundaryError,
  isRecoverableChunkError,
  markChunkBoundaryError,
  recoverFromChunkError,
} = await vite.ssrLoadModule('/src/lib/chunkRecovery.js')
const { default: ErrorBoundary } = await vite.ssrLoadModule('/src/components/ErrorBoundary.jsx')

function createMockWindow(href = 'https://forge.example/run/recap/run%2F42?source=device#summary') {
  const listeners = new Map()
  const replacements = []
  const storage = new Map()
  const storageOperations = []

  return {
    listeners,
    replacements,
    storageOperations,
    location: {
      href,
      replace(nextHref) {
        replacements.push(nextHref)
        this.href = nextHref
      },
    },
    sessionStorage: {
      getItem(key) {
        return storage.get(key) || null
      },
      setItem(key, value) {
        storageOperations.push(['set', key, value])
        storage.set(key, value)
      },
      removeItem(key) {
        storageOperations.push(['remove', key])
        storage.delete(key)
      },
    },
    setTimeout(callback, delay) {
      this.recoveryTimer = { callback, delay }
      return 1
    },
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
  }
}

function renderBoundary(error) {
  const boundary = new ErrorBoundary({ children: null })
  boundary.state = ErrorBoundary.getDerivedStateFromError(error)
  return { boundary, tree: boundary.render() }
}

function elementText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(elementText).join(' ')
  return elementText(node.props?.children)
}

function findElement(node, type) {
  if (!node || typeof node !== 'object') return null
  if (node.type === type) return node
  const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children]
  for (const child of children) {
    const match = findElement(child, type)
    if (match) return match
  }
  return null
}

const recoverableMessages = [
  'Failed to fetch dynamically imported module',
  'Error loading dynamically imported module',
  'Importing a module script failed',
  'Module script load failed',
  "'text/html' is not a valid JavaScript MIME type",
  'ChunkLoadError: Loading chunk 42 failed',
]

for (const message of recoverableMessages) {
  assert.equal(isRecoverableChunkError(new Error(message)), true, message)
}

assert.equal(isRecoverableChunkError(new Error('Load failed')), false, 'generic network failures do not reload the app')
assert.equal(
  isRecoverableChunkError(new Error('Load failed'), { allowGenericLoadFailure: true }),
  true,
  'a known dynamic-import boundary may recover the generic iOS chunk error',
)
assert.equal(isRecoverableChunkError(new Error('Cannot read properties of null')), false)

const appSource = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8')
const markIndex = appSource.indexOf('markChunkBoundaryError(err)')
const recoverIndex = appSource.indexOf('recoverFromChunkError(err, { allowGenericLoadFailure: true })')
assert.ok(markIndex >= 0 && recoverIndex > markIndex, 'lazyWithRetry marks the original iOS failure before bounded recovery')

const originalDateNow = Date.now
let now = 1700000000000
Date.now = () => ++now

try {
  global.window = createMockWindow()
  const lazyLoadFailure = markChunkBoundaryError(new Error('Load failed'))

  assert.equal(isRecoverableChunkBoundaryError(lazyLoadFailure), true, 'a marked lazy import reaches ErrorBoundary as recoverable')
  assert.equal(
    recoverFromChunkError(lazyLoadFailure, { allowGenericLoadFailure: true }),
    true,
    'the first lazy import failure starts automatic recovery',
  )
  assert.equal(
    recoverFromChunkError(lazyLoadFailure, { allowGenericLoadFailure: true }),
    false,
    'the same failed shell cannot start an automatic reload loop',
  )
  assert.equal(window.replacements.length, 1, 'automatic recovery performs one replacement')

  const firstRecoveryUrl = new URL(window.replacements[0])
  assert.equal(firstRecoveryUrl.pathname, '/run/recap/run%2F42', 'automatic recovery preserves the recap URL')
  assert.equal(firstRecoveryUrl.searchParams.get('source'), 'device', 'automatic recovery preserves existing query data')
  assert.equal(firstRecoveryUrl.hash, '#summary', 'automatic recovery preserves the current hash')
  assert.equal(firstRecoveryUrl.searchParams.get('_forge_reload'), '1700000000001', 'automatic recovery adds only its cache buster')

  const recoveryFallback = renderBoundary(lazyLoadFailure)
  const recoveryCopy = elementText(recoveryFallback.tree)
  assert.match(recoveryCopy, /Forged Hybrid — Updating/, 'the exhausted generic chunk failure stays an updating state')
  assert.match(recoveryCopy, /automatic refresh does not finish/i, 'the recovery fallback gives truthful next-step copy')

  const reloadButton = findElement(recoveryFallback.tree, 'button')
  assert.ok(reloadButton, 'the recovery fallback exposes a manual Reload action')
  reloadButton.props.onClick()
  assert.equal(window.replacements.length, 2, 'manual Reload performs a real second replacement')
  assert.deepEqual(
    window.storageOperations.slice(-2).map(([operation]) => operation),
    ['remove', 'set'],
    'manual Reload resets and rearms the one-shot guard',
  )
  assert.equal(new URL(window.replacements[1]).searchParams.get('_forge_reload'), '1700000000002')

  global.window = createMockWindow()
  installChunkRecovery()
  const preloadListener = window.listeners.get('vite:preloadError')
  assert.equal(typeof preloadListener, 'function', 'the Vite preload recovery listener is installed')

  const firstPreloadError = new Error('Load failed')
  let firstPreloadPrevented = false
  preloadListener({
    payload: firstPreloadError,
    preventDefault() { firstPreloadPrevented = true },
  })
  assert.equal(firstPreloadPrevented, true, 'Vite suppresses the failure only when automatic replacement starts')
  assert.equal(isRecoverableChunkBoundaryError(firstPreloadError), true, 'Vite marks generic iOS failures as chunk-boundary errors')

  const exhaustedPreloadError = new Error('Load failed')
  let exhaustedPreloadPrevented = false
  preloadListener({
    payload: exhaustedPreloadError,
    preventDefault() { exhaustedPreloadPrevented = true },
  })
  assert.equal(exhaustedPreloadPrevented, false, 'Vite rethrows the original failure after the one-shot guard is exhausted')
  assert.equal(isRecoverableChunkBoundaryError(exhaustedPreloadError), true, 'the rethrown error keeps its recovery classification')

  global.window = createMockWindow()
  const ordinaryRuntimeError = new Error('Cannot read properties of null')
  const runtimeFallback = renderBoundary(ordinaryRuntimeError)
  assert.match(elementText(runtimeFallback.tree), /Forged Hybrid — Startup Error/, 'genuine runtime errors retain Startup Error')
  const originalConsoleError = console.error
  console.error = () => {}
  try {
    runtimeFallback.boundary.componentDidCatch(ordinaryRuntimeError, { componentStack: 'test' })
  } finally {
    console.error = originalConsoleError
  }
  assert.equal(window.replacements.length, 0, 'genuine runtime errors do not trigger chunk recovery')

  const unrelatedLoadFailure = new Error('Load failed')
  assert.match(
    elementText(renderBoundary(unrelatedLoadFailure).tree),
    /Forged Hybrid — Startup Error/,
    'an unmarked generic failure outside a chunk boundary is not auto-recovered',
  )
} finally {
  Date.now = originalDateNow
  delete global.window
  await vite.close()
}

console.log('CHUNK RECOVERY SMOKE OK (32)')
