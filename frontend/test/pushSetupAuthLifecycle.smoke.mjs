import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

class Storage {
  values = new Map()
  failEpoch = false
  getItem(k) { if (this.failEpoch && k === 'forge_push_setup_auth_epoch') throw Error('synthetic unavailable epoch storage'); return this.values.get(k) ?? null }
  setItem(k, v) { this.values.set(k, String(v)) }
  removeItem(k) { this.values.delete(k) }
}
globalThis.localStorage = new Storage()
globalThis.window = new EventTarget()
window.localStorage = localStorage
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { serviceWorker: { controller: { postMessage() { throw Error('No unscoped auth broadcast') } } } } })
const token = await import('../src/lib/tokenStore.js')
let firstReadSignals = 0
const offFirstRead = token.subscribePushSetupEpoch(() => firstReadSignals++)
assert.match(token.getPushSetupAuthEpoch(), /^[0-9a-f-]{36}$/)
await Promise.resolve()
assert.equal(firstReadSignals, 0, 'first module observation has no predecessor to invalidate')
offFirstRead()
token.setToken('same-account-token')
const first = token.getAuthSession(), epoch = token.getPushSetupAuthEpoch()
assert.match(epoch, /^[0-9a-f-]{36}$/)
assert.equal(token.isAuthSessionCurrent(first), true)
let equalTokenInvalidations = 0
const stopEqualToken = token.subscribePushSetupEpoch(() => equalTokenInvalidations++)
token.setToken('same-account-token')
assert.notEqual(token.getPushSetupAuthEpoch(), epoch, 'direct equal-token successful login invalidates notification authority')
assert.equal(equalTokenInvalidations, 1)
assert.equal(token.isAuthSessionCurrent(first), true, 'equal-token login must preserve existing global auth-generation semantics')
stopEqualToken()
let invalidations = 0
const dispose = token.subscribeAuthSession(() => invalidations++)
token.clearToken(); token.setToken('same-account-token')
assert.equal(token.isAuthSessionCurrent(first), false)
assert.notEqual(token.getPushSetupAuthEpoch(), epoch)
const next = token.getAuthSession(), nextEpoch = token.getPushSetupAuthEpoch()
token.setToken('different-account-token')
assert.equal(token.isAuthSessionCurrent(next), false)
assert.notEqual(token.getPushSetupAuthEpoch(), nextEpoch)
const otherEpoch = randomUUID()
const beforeEpochOnly = token.getAuthSession()
let pushInvalidations = 0
const disposeEpoch = token.subscribePushSetupEpoch(() => pushInvalidations++)
localStorage.setItem('forge_push_setup_auth_epoch', otherEpoch)
assert.equal(token.getPushSetupAuthEpoch(), otherEpoch, 'reads see the successor without consuming its queued event')
assert.equal(pushInvalidations, 0)
const storageEvent = new Event('storage')
Object.defineProperty(storageEvent, 'key', { value: 'forge_push_setup_auth_epoch' })
window.dispatchEvent(storageEvent)
assert.equal(token.getPushSetupAuthEpoch(), otherEpoch, 'receiving tab must not rotate the originating tab epoch again')
assert.equal(localStorage.getItem('forge_push_setup_auth_epoch'), otherEpoch)
assert(invalidations >= 3)
assert.equal(pushInvalidations, 1)
assert.equal(token.isAuthSessionCurrent(beforeEpochOnly), true, 'notification-only epoch changes must not invalidate unrelated global auth requests')
await Promise.resolve()
assert.equal(pushInvalidations, 1, 'queued observation and actual storage event coalesce')
const signal = key => { const event = new Event('storage'); Object.defineProperty(event, 'key', { value: key }); window.dispatchEvent(event) }
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
for (const malformed of [null, 'not-an-epoch']) {
  const before = pushInvalidations
  if (malformed === null) localStorage.removeItem('forge_push_setup_auth_epoch')
  else localStorage.setItem('forge_push_setup_auth_epoch', malformed)
  assert.match(token.getPushSetupAuthEpoch(), /^[0-9a-f-]{36}$/)
  assert.equal(pushInvalidations, before, 'getter must not synchronously iterate live listeners')
  await flush(); assert.equal(pushInvalidations, before + 1, 'same-tab repair invalidates once without a storage event')
}
const beforeRapid = pushInvalidations, finalEpoch = randomUUID()
localStorage.setItem('forge_push_setup_auth_epoch', randomUUID()); token.getPushSetupAuthEpoch()
localStorage.setItem('forge_push_setup_auth_epoch', finalEpoch); token.getPushSetupAuthEpoch()
signal('forge_push_setup_auth_epoch'); signal('forge_push_setup_auth_epoch'); await flush()
assert.equal(pushInvalidations, beforeRapid + 1)
assert.equal(token.getPushSetupAuthEpoch(), finalEpoch, 'delayed events read latest C, never revive B')
const beforeUnavailable = pushInvalidations
localStorage.failEpoch = true
assert.equal(token.getPushSetupAuthEpoch(), null); await flush()
assert.equal(pushInvalidations, beforeUnavailable + 1)
assert.equal(token.getPushSetupAuthEpoch(), null); await flush()
assert.equal(pushInvalidations, beforeUnavailable + 1, 'persistent failure must not spin invalidation microtasks')
localStorage.failEpoch = false
assert.equal(token.getPushSetupAuthEpoch(), finalEpoch); await flush()
assert.equal(pushInvalidations, beforeUnavailable + 2, 'observed recovery permits a read-only mounted replacement')
assert.equal(token.isAuthSessionCurrent(beforeEpochOnly), true)
const beforeClearSession = token.getAuthSession()
localStorage.values.clear(); signal(null); await flush()
assert.equal(token.isAuthSessionCurrent(beforeClearSession), false, 'clear-storage retains existing global auth invalidation')
token.setToken('different-account-token'); await flush()
dispose(); disposeEpoch()
await new Promise(resolve => setTimeout(resolve, 20))
assert.deepEqual([...localStorage.values.keys()].sort(), ['forge_push_setup_auth_epoch', 'forge_token'])
const store = await import('../src/lib/pushSetupStore.js')
let opening, closed = 0
globalThis.indexedDB = { open() { opening = {}; return opening } }
const blocked = store.listSetupOperations()
opening.onblocked()
await assert.rejects(blocked, /SETUP_STORAGE_UNAVAILABLE/)
opening.result = { close() { closed++ } }; opening.onsuccess()
assert.equal(closed, 1, 'a late successful open after blocked rejection cannot retain a database handle')
console.log('PUSH SETUP actual auth/session/epoch lifecycle PASS; no credential/proof broadcast or auth semantics changes')
