import assert from 'node:assert/strict'
import fs from 'node:fs'
import { isRecoverableChunkError } from '../src/lib/chunkRecovery.js'

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
assert.match(
  appSource,
  /recoverFromChunkError\(err, \{ allowGenericLoadFailure: true \}\)/,
  'only the lazy dynamic-import boundary opts into generic iOS Load failed recovery',
)

console.log(`CHUNK RECOVERY SMOKE OK (${recoverableMessages.length + 4})`)
