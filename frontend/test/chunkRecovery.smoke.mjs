import assert from 'node:assert/strict'
import { isRecoverableChunkError } from '../src/lib/chunkRecovery.js'

const recoverableMessages = [
  'Failed to fetch dynamically imported module',
  'Error loading dynamically imported module',
  'Importing a module script failed',
  'Module script load failed',
  'Load failed',
  "'text/html' is not a valid JavaScript MIME type",
  'ChunkLoadError: Loading chunk 42 failed',
]

for (const message of recoverableMessages) {
  assert.equal(isRecoverableChunkError(new Error(message)), true, message)
}

assert.equal(isRecoverableChunkError(new Error('Cannot read properties of null')), false)
console.log(`CHUNK RECOVERY SMOKE OK (${recoverableMessages.length + 1})`)
