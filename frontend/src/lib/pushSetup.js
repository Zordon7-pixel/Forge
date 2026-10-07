import { getAuthSession, isAuthSessionCurrent, getPushSetupAuthEpoch, subscribeAuthSession, subscribePushSetupEpoch } from './tokenStore.js'
import { listSetupOperations, putSetupOperation, updateSetupOperation, eraseSetupOperation, setupNow } from './pushSetupStore.js'

export const PUSH_SETUP_PROTOCOL = 'FORGE_WEB_PUSH_SETUP_V1'
export const PUSH_SETUP_REVISION = 'forge-push-setup-1'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PENDING = new Set(['RESERVED', 'ACCEPTED', 'FAILED', 'UNKNOWN'])
const fail = (code = 'SETUP_UNAVAILABLE', status = 0) => Object.assign(new Error(code), { code, status })
export const setupRandom = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
export async function setupDigest(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('')
}
export function subscriptionValue(subscription) {
  const value = subscription?.toJSON()
  if (!value || typeof value.endpoint !== 'string' || value.endpoint.length > 2048 || typeof value.keys?.p256dh !== 'string' || typeof value.keys?.auth !== 'string') throw fail('SUBSCRIPTION_REQUIRED')
  return { endpoint: value.endpoint, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } }
}
export const subscriptionDigest = value => setupDigest(JSON.stringify([value.endpoint, value.keys.p256dh, value.keys.auth]))
function publicKeyBytes(value) {
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), x => x.charCodeAt(0))
}
function exactTuple(value) {
  return UUID.test(value?.targetId) && UUID.test(value?.generation) && UUID.test(value?.incarnation) && Number.isSafeInteger(value?.revision) && value.revision > 0
}

// No singleton possession authority: disposal drops all page-realm secrets.
export function createPushSetupCoordinator({ readConfig, onChange = () => {} }) {
  const session = getAuthSession(), epoch = getPushSetupAuthEpoch()
  let generation = 0, disposed = false, busy = false, operation = null, handshake = null, configuration = null
  let nextSecret = null, confirmation = null, confirmed = null, recoveryRevoke = false
  let expiryTimer = null
  let awaitingFirstController = typeof navigator !== 'undefined' && Boolean(navigator.serviceWorker) && !navigator.serviceWorker.controller
  let snapshot = { state: 'checking', supported: true, configured: false, busy: false, proofAvailable: false }
  const requests = new Set(), ports = new Set()
  const current = () => !disposed && isAuthSessionCurrent(session) && epoch && getPushSetupAuthEpoch() === epoch
  const guard = (version = generation) => { if (!current() || version !== generation) throw fail('SETUP_INTERRUPTED') }
  const publish = (changes, version = generation) => { if (current() && version === generation) { snapshot = { ...snapshot, ...changes, busy }; onChange({ ...snapshot }) } }
  // Invalidation itself must terminalize the old snapshot even after its epoch
  // stopped being current. This contains no account/authority data. Async paths
  // still use publish/guard; the mounted owner additionally fences flow identity.
  const terminal = state => {
    snapshot = { ...snapshot, state, busy: false, proofAvailable: false, configured: current() ? snapshot.configured : false }
    if (!disposed) onChange({ ...snapshot })
  }
  const common = (op = operation) => ({ protocol: PUSH_SETUP_PROTOCOL, operationId: op.operationId, clientNonce: op.clientNonce, authEpoch: op.authEpoch })
  const sessionFingerprint = () => setupDigest(`forge:push-setup-local-session:v1\0${session.token}\0${epoch}`)

  async function request(action, body, { detached = false } = {}) {
    const version = generation
    if (!detached) guard(version)
    if (!isAuthSessionCurrent(session)) throw fail('SETUP_INTERRUPTED')
    const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), 8000)
    requests.add(abort)
    try {
      const text = JSON.stringify(body)
      if (new TextEncoder().encode(text).length > 8192) throw fail('SETUP_INVALID')
      const response = await fetch(`/push-setup/v1/${action}`, { method: 'POST', cache: 'no-store', redirect: 'error', credentials: 'same-origin', signal: abort.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.token}` }, body: text })
      const reader = response.body?.getReader()
      if (!reader) throw fail()
      let bytes = 0, data = ''
      const decoder = new TextDecoder()
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.length
        if (bytes > 2048) { await reader.cancel(); throw fail() }
        data += decoder.decode(chunk.value, { stream: true })
      }
      data += decoder.decode()
      if (!detached) guard(version)
      let value
      try { value = JSON.parse(data) } catch { throw fail() }
      if (response.status !== 200) throw fail(response.status === 410 ? 'SETUP_EXPIRED' : response.status === 409 ? 'SETUP_CONFLICT' : response.status === 401 ? 'SETUP_AUTH_REQUIRED' : 'SETUP_UNAVAILABLE', response.status)
      if (value?.protocol !== PUSH_SETUP_PROTOCOL) throw fail()
      return value
    } catch (error) {
      if (error?.code) throw error
      throw fail()
    } finally { clearTimeout(timeout); requests.delete(abort) }
  }
  function privateMessage(controller, message, timeout = 2000) {
    const version = generation
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel()
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true; clearTimeout(timer); ports.delete(cancel); channel.port1.close(); channel.port2.close()
        error ? reject(error) : resolve(value)
      }
      const cancel = () => finish(fail('SETUP_INTERRUPTED'))
      const timer = setTimeout(() => finish(fail('WORKER_UPDATE_REQUIRED')), timeout)
      ports.add(cancel)
      channel.port1.onmessage = ({ data }) => {
        try { guard(version); if (navigator.serviceWorker.controller !== controller) throw fail('SETUP_INTERRUPTED'); finish(null, data) }
        catch (error) { finish(error) }
      }
      try { controller.postMessage(message, [channel.port2]) } catch { finish(fail('WORKER_UPDATE_REQUIRED')) }
    })
  }
  async function hello(version = generation) {
    guard(version)
    const controller = navigator.serviceWorker.controller
    const registration = await navigator.serviceWorker.getRegistration(location.href)
    guard(version)
    if (!controller || controller !== navigator.serviceWorker.controller || registration?.active !== controller || !location.href.startsWith(registration.scope) || new URL(registration.scope).origin !== location.origin) throw fail('WORKER_UPDATE_REQUIRED')
    const nonce = setupRandom()
    const reply = await privateMessage(controller, { type: 'FORGE_PUSH_SETUP_HELLO', nonce })
    if (!reply || Object.keys(reply).sort().join('|') !== 'bootId|clientId|nonce|protocol|revision' || reply.protocol !== PUSH_SETUP_PROTOCOL || reply.nonce !== nonce || reply.revision !== PUSH_SETUP_REVISION || !UUID.test(reply.bootId) || typeof reply.clientId !== 'string' || !reply.clientId || reply.clientId.length > 256) throw fail('WORKER_UPDATE_REQUIRED')
    guard(version)
    handshake = { ...reply, controller, registration, handshakeNonce: nonce }
    if (nextSecret && (nextSecret.bootId !== reply.bootId || nextSecret.controller !== controller)) eraseSecrets()
    return handshake
  }
  async function sample(op = operation, version = generation) {
    guard(version)
    if (op && op.expiresAt <= setupNow()) throw fail('SETUP_EXPIRED')
    const registration = await navigator.serviceWorker.getRegistration(location.href)
    const subscription = await registration?.pushManager.getSubscription()
    guard(version)
    if (!subscription) throw fail('SUBSCRIPTION_REQUIRED')
    const value = subscriptionValue(subscription)
    if (op && (op.authEpoch !== epoch || op.sessionFingerprint !== await sessionFingerprint() || op.subscriptionHash !== await subscriptionDigest(value))) throw fail('SETUP_INTERRUPTED')
    guard(version)
    return { subscription, value }
  }
  function clearExpiry() { clearTimeout(expiryTimer); expiryTimer = null }
  function armExpiry() {
    clearExpiry()
    if (!operation || disposed) return
    const deadline = Math.min(operation.expiresAt, nextSecret?.expiresAt ?? Infinity)
    const remaining = deadline - setupNow()
    if (!Number.isFinite(remaining) || remaining <= 0) { interrupt('expired', false); return }
    expiryTimer = setTimeout(armExpiry, remaining)
  }
  function eraseSecrets() { nextSecret = null; confirmation = null; confirmed = null }
  async function erase(op, cancel = false) {
    if (!op) return
    await eraseSetupOperation(op.operationId, op.authEpoch).catch(() => {})
    navigator.serviceWorker?.controller?.postMessage({ type: 'FORGE_PUSH_SETUP_ERASE', operationId: op.operationId, authEpoch: op.authEpoch })
    if (cancel && isAuthSessionCurrent(session)) await request('cancel', common(op), { detached: true }).catch(() => {})
  }
  function interrupt(state = 'verification-required', cancel = true) {
    const old = operation
    clearExpiry()
    generation++; for (const abort of requests) abort.abort(); for (const cancel of [...ports]) cancel()
    eraseSecrets(); operation = null; handshake = null; busy = false
    void erase(old, cancel)
    terminal(state)
  }
  const unsubscribe = subscribeAuthSession(() => interrupt())
  const unsubscribeEpoch = subscribePushSetupEpoch(() => interrupt())
  const workerChange = () => {
    // The settings control may mount before the first worker claims this page.
    // Re-sample that initial read only; never resume an established setup flow.
    const initialize = awaitingFirstController && navigator.serviceWorker.controller && !handshake && !operation && !busy
    awaitingFirstController = false
    interrupt()
    if (initialize && current()) void init()
  }
  const pageHide = () => { generation++; clearExpiry(); eraseSecrets(); for (const abort of requests) abort.abort(); for (const cancel of [...ports]) cancel(); busy = false; terminal('verification-required') }
  const pageShow = event => { if (event.persisted && current()) void init() }
  const proofMessage = (event) => {
    if (event.source !== navigator.serviceWorker.controller || event.data?.type !== 'SETUP_PROOF_AVAILABLE' || !operation || !UUID.test(event.data.challengeId)) return
    const version = generation
    void updateSetupOperation(operation.operationId, epoch, op => op.challengeId === event.data.challengeId ? { ...op } : null).then(op => {
      if (op && current() && version === generation && operation?.operationId === op.operationId) { operation = op; publish({ proofAvailable: true }, version) }
    }).catch(() => {})
  }
  if (typeof navigator !== 'undefined') {
    navigator.serviceWorker?.addEventListener('controllerchange', workerChange)
    navigator.serviceWorker?.addEventListener('message', proofMessage)
  }
  window.addEventListener('pagehide', pageHide)
  window.addEventListener('pageshow', pageShow)

  async function adopt(result, version = generation) {
    guard(version)
    if (!operation || result.operationId !== operation.operationId || !UUID.test(result.challengeId)) throw fail('SETUP_CONFLICT')
    await sample(operation, version)
    const row = await updateSetupOperation(operation.operationId, epoch, (op, proofs) => {
      guard(version)
      if (op.challengeId && op.challengeId !== result.challengeId) throw fail('SETUP_CONFLICT')
      op.challengeId = result.challengeId
      if (Number.isSafeInteger(result.expiresAt)) op.expiresAt = Math.min(op.expiresAt, result.expiresAt)
      op.state = result.state
      delete op.createAdmission
      if (result.state === 'CONFIRMED') for (let i = proofs.length - 1; i >= 0; i--) if (proofs[i].operationId === op.operationId && proofs[i].authEpoch === epoch) proofs.splice(i, 1)
    })
    guard(version)
    if (!row) throw fail('SETUP_EXPIRED')
    operation = row
    armExpiry(); guard(version)
    if (result.state === 'CONFIRMED') {
      if (!exactTuple(result)) throw fail('SETUP_CONFLICT')
      confirmed = result
      publish({ state: secretEligible() ? 'confirmed-current-controllable' : 'confirmed-current-reverification-required', proofAvailable: false })
    } else if (PENDING.has(result.state)) publish({ state: result.state === 'UNKNOWN' ? 'transport-unknown' : 'setup-pending' })
    else if (result.state === 'CANCELLED' || result.state === 'EXPIRED') {
      const op = operation; clearExpiry(); eraseSecrets(); operation = null; await erase(op)
      publish({ state: result.state.toLowerCase(), proofAvailable: false }, version)
    } else throw fail()
    return result
  }
  const secretEligible = () => nextSecret && operation && handshake && handshake.controller === navigator.serviceWorker.controller && nextSecret.controller === handshake.controller && nextSecret.bootId === handshake.bootId && nextSecret.expiresAt > setupNow() && nextSecret.operationId === operation.operationId
  async function status(version = generation) {
    guard(version)
    if (!operation) throw fail('SETUP_EXPIRED')
    return adopt(await request('status', common()), version)
  }
  async function init() {
    const version = generation
    if (!current()) { terminal('verification-required'); return snapshot }
    try {
      guard(version)
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) { publish({ state: 'unsupported', supported: false }); return snapshot }
      configuration = await readConfig(session)
      guard(version)
      publish({ configured: Boolean(configuration?.configured && configuration?.publicKey) })
      await hello(version)
      const subscription = await handshake.registration.pushManager.getSubscription()
      guard(version)
      const hash = subscription ? await subscriptionDigest(subscriptionValue(subscription)) : null
      const fingerprint = await sessionFingerprint()
      const rows = await listSetupOperations()
      guard(version)
      operation = rows.filter(op => op.authEpoch === epoch && op.sessionFingerprint === fingerprint && op.subscriptionHash === hash).sort((a, b) => b.createdAt - a.createdAt)[0] || null
      if (operation) { armExpiry(); guard(version); await status(version) }
      else publish({ state: subscription ? 'browser-subscription-present-server-unverified' : 'browser-subscription-absent-server-unverified' })
    } catch (error) { if (version === generation) handleError(error) }
    return snapshot
  }
  function handleError(error) {
    if (['SETUP_INTERRUPTED', 'SETUP_EXPIRED', 'SETUP_CONFLICT', 'SETUP_AUTH_REQUIRED', 'SUBSCRIPTION_REQUIRED'].includes(error?.code)) {
      const old = operation; clearExpiry(); eraseSecrets(); operation = null; void erase(old)
    }
    const state = error?.code === 'WORKER_UPDATE_REQUIRED' ? 'update-required' : error?.code === 'SETUP_EXPIRED' ? 'expired' : error?.code === 'SETUP_CONFLICT' ? 'conflict' : error?.code === 'PERMISSION_DENIED' ? 'permission-denied' : 'verification-required'
    publish({ state, proofAvailable: false })
  }
  async function run(work) {
    if (busy || !current()) return
    const version = ++generation // Invalidate any older read-only initialization.
    busy = true; publish({})
    try { return await work(version) } catch (error) { if (version === generation) handleError(error) }
    finally { if (version === generation) { busy = false; publish({}) } }
  }
  // Called directly by the click handler. Permission is requested before the first await.
  function enable({ turnOff = false } = {}) {
    if (busy || !current() || !configuration?.configured) return
    if (!handshake || handshake.controller !== navigator.serviceWorker.controller) return init()
    let permission, subscriptionGesture
    try { permission = Notification.permission === 'granted' ? Promise.resolve('granted') : Notification.requestPermission() } catch { handleError(fail('PERMISSION_DENIED')); return }
    if (Notification.permission === 'granted' && snapshot.state === 'subscription-gesture-required') {
      try { subscriptionGesture = Promise.resolve(handshake.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKeyBytes(configuration.publicKey) })).then(value => ({ value }), () => ({ failed: true })) }
      catch { handleError(fail('PERMISSION_DENIED')); return }
    }
    return run(async (version) => {
      if (await permission !== 'granted') throw fail('PERMISSION_DENIED')
      guard(version)
      const old = operation; clearExpiry(); operation = null; eraseSecrets(); await erase(old, true)
      guard(version)
      recoveryRevoke = turnOff
      await hello(version)
      const gestureResult = subscriptionGesture ? await subscriptionGesture : null
      guard(version)
      if (gestureResult?.failed) { publish({ state: 'subscription-gesture-required' }, version); return }
      let subscription = gestureResult ? gestureResult.value : await handshake.registration.pushManager.getSubscription()
      if (!subscription) {
        try { subscription = await handshake.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKeyBytes(configuration.publicKey) }) }
        catch { publish({ state: 'subscription-gesture-required' }, version); return }
      }
      guard(version); await hello(version)
      const value = subscriptionValue(subscription), clientNonce = setupRandom()
      const input = { protocol: PUSH_SETUP_PROTOCOL, clientNonce, authEpoch: epoch, subscription: value }
      const issued = await request('issue-create', input)
      guard(version)
      if (!UUID.test(issued.operationId) || typeof issued.createAdmission !== 'string' || issued.createAdmission.length > 4096 || !Number.isSafeInteger(issued.expiresAt) || issued.expiresAt <= setupNow()) throw fail()
      const row = { operationId: issued.operationId, clientNonce, authEpoch: epoch, sessionFingerprint: await sessionFingerprint(), endpointHash: await setupDigest(value.endpoint), subscriptionHash: await subscriptionDigest(value), challengeId: null, state: 'ISSUED', expiresAt: setupNow() + 300000, createAdmission: issued.createAdmission, admissionExpiresAt: issued.expiresAt }
      guard(version)
      const evicted = await putSetupOperation(row)
      if (!current() || version !== generation) { await erase(row); throw fail('SETUP_INTERRUPTED') }
      operation = row
      armExpiry(); guard(version)
      for (const op of evicted) await erase(op, true)
      guard(version)
      const watching = await privateMessage(handshake.controller, { type: 'FORGE_PUSH_SETUP_WATCH', ...common(), handshakeNonce: handshake.handshakeNonce, bootId: handshake.bootId })
      if (watching?.protocol !== PUSH_SETUP_PROTOCOL || watching.state !== 'WATCHING') throw fail()
      await sample(operation, version)
      try { await adopt(await request('create', { ...common(), subscription: value, createAdmission: issued.createAdmission }), version) }
      catch (error) {
        guard(version)
        if (error.status || error.code === 'SETUP_INTERRUPTED') throw error
        publish({ state: 'transport-unknown' })
        await status(version) // Readback only; never automatically resend or issue replacement.
      }
    })
  }
  function continueSetup() {
    return run(async (version) => {
      if (!operation) throw fail('SETUP_EXPIRED')
      await hello(version); await sample(operation, version)
      const state = await status(version)
      if (state.state === 'CONFIRMED') return
      if (!PENDING.has(state.state)) throw fail('SETUP_EXPIRED')
      const granted = await request('authorize-handoff', { ...common(), clientId: handshake.clientId })
      guard(version)
      if (granted.challengeId !== operation.challengeId || !/^[A-Za-z0-9_-]{43}$/.test(granted.grant || '') || !Number.isSafeInteger(granted.expiresAt) || granted.expiresAt <= setupNow()) throw fail()
      const proof = await privateMessage(handshake.controller, { type: 'FORGE_PUSH_SETUP_HANDOFF', ...common(), challengeId: operation.challengeId,
        grant: granted.grant, clientId: handshake.clientId, handshakeNonce: handshake.handshakeNonce, bootId: handshake.bootId }, 10000)
      if (proof?.protocol !== PUSH_SETUP_PROTOCOL || proof.challengeId !== operation.challengeId || typeof proof.secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(proof.secret) || !Number.isSafeInteger(proof.expiresAt) || proof.expiresAt <= setupNow()) throw fail()
      const { value } = await sample(operation, version)
      if (!nextSecret) nextSecret = { secret: setupRandom(), operationId: operation.operationId, controller: handshake.controller, bootId: handshake.bootId, expiresAt: Math.min(proof.expiresAt, setupNow() + 300000) }
      armExpiry(); guard(version)
      if (!secretEligible()) throw fail('SETUP_EXPIRED')
      if (!confirmation) {
        const body = { ...common(), subscription: value, challengeId: operation.challengeId, proof: proof.secret, nextPossessionProofHash: await setupDigest(publicKeyBytes(nextSecret.secret)) }
        guard(version)
        confirmation = body
      }
      guard(version)
      try { await adopt(await request('confirm', confirmation), version) }
      catch (error) {
        guard(version)
        if (error.status || error.code === 'SETUP_INTERRUPTED') throw error
        const observed = await status(version)
        if (PENDING.has(observed.state) && secretEligible()) await adopt(await request('confirm', confirmation), version)
        else if (observed.state !== 'CONFIRMED') throw fail()
      }
      confirmation = null
      if (recoveryRevoke && secretEligible()) await revokeCurrent(version)
    })
  }
  async function revokeCurrent(version = generation) {
    await hello(version)
    await sample(operation, version)
    if (!confirmed || !secretEligible()) throw fail('SETUP_EXPIRED')
    const { subscription, value } = await sample(operation, version)
    const tuple = confirmed
    const body = { ...common(), subscription: value, targetId: tuple.targetId, generation: tuple.generation, incarnation: tuple.incarnation, revision: tuple.revision, possessionProof: nextSecret.secret }
    let result
    try { result = await request('revoke', body) }
    catch (error) {
      guard(version)
      if (error.status || error.code === 'SETUP_INTERRUPTED') throw error
      try {
        const observed = await status(version)
        if (observed.state !== 'CONFIRMED' || ['targetId', 'generation', 'incarnation', 'revision'].some(k => observed[k] !== tuple[k]) || !secretEligible()) throw fail('SETUP_CONFLICT')
        result = await request('revoke', body)
      } catch (readbackError) {
        guard(version)
        if (readbackError.status) throw readbackError
        publish({ state: 'revoke-outcome-unknown' }); return
      }
    }
    if (result.state !== 'REVOKED') throw fail()
    const old = operation; clearExpiry(); operation = null; eraseSecrets(); await erase(old)
    guard(version)
    publish({ state: 'server-revoked-known', proofAvailable: false })
    try { if (!await subscription.unsubscribe()) publish({ state: 'server-revoked-cleanup-incomplete' }, version) }
    catch { publish({ state: 'server-revoked-cleanup-incomplete' }, version) }
  }
  return {
    init, enable, continueSetup, revoke: () => run(revokeCurrent),
    cancel: () => run(async (version) => { const old = operation; clearExpiry(); operation = null; eraseSecrets(); await erase(old, true); guard(version); publish({ state: 'cancelled', proofAvailable: false }) }),
    snapshot: () => ({ ...snapshot }),
    dispose() {
      if (disposed) return
      disposed = true; interrupt(); unsubscribe(); unsubscribeEpoch()
      navigator.serviceWorker?.removeEventListener('controllerchange', workerChange)
      navigator.serviceWorker?.removeEventListener('message', proofMessage)
      window.removeEventListener('pagehide', pageHide)
      window.removeEventListener('pageshow', pageShow)
    },
  }
}
