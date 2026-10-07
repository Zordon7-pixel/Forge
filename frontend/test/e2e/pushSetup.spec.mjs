import { expect, test } from '@playwright/test'
import { workerWitnesses, setupHarness } from '../pushSetupWorker.smoke.mjs'
import { installAuthenticatedApi } from './support/mockApi.mjs'
import { randomUUID, randomBytes } from 'node:crypto'

test('actual Chromium worker, IndexedDB, private-port and synthetic push lifecycle', async () => {
  await workerWitnesses()
})

test('old deployed worker cannot admit setup or silently enable', async () => {
  const h = await setupHarness({ oldWorker: true })
  try {
    expect(await h.page.evaluate(() => window.__flow.snapshot().state)).toBe('update-required')
    await h.page.evaluate(() => window.__flow.enable())
    expect(h.calls).toHaveLength(0)
    const op = { protocol: 'FORGE_WEB_PUSH_SETUP_V1', challengeId: randomUUID(), operationId: randomUUID(), clientNonce: randomBytes(32).toString('base64url'), authEpoch: randomUUID(), subscription: h.control.subscription, secret: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 300000 }
    await h.push(h.payload(op))
    const notices = await h.notices()
    expect(notices).toHaveLength(1)
    expect(notices[0].body).toBe('Open Forge to finish enabling notifications.')
    expect(JSON.stringify(notices)).not.toContain(op.secret)
    expect(h.calls).toHaveLength(0)
  } finally { await h.close() }
})

test('no-client proof survives reload but confirmation possession is volatile', async () => {
  const h = await setupHarness()
  try {
    await h.page.evaluate(() => window.__flow.enable())
    await h.page.close()
    await h.push()
    await h.reopen()
    expect(await h.page.evaluate(() => window.__flow.snapshot().state)).toBe('setup-pending')
    expect(h.calls.filter(c => c.action === 'confirm')).toHaveLength(0)
    await h.page.evaluate(() => window.__flow.continueSetup())
    expect(await h.page.evaluate(() => window.__flow.snapshot().state)).toBe('confirmed-current-controllable')
    await h.page.reload(); await h.initialize()
    expect(await h.page.evaluate(() => window.__flow.snapshot().state)).toBe('confirmed-current-reverification-required')
    await h.page.evaluate(() => window.__flow.revoke())
    expect(h.calls.filter(c => c.action === 'revoke')).toHaveLength(0)
  } finally { await h.close() }
})

for (const action of ['issue-create', 'create', 'authorize-handoff', 'redeem-handoff', 'confirm', 'revoke']) {
  test(`controller interruption at ${action} fences late state and authority`, async () => {
    const h = await setupHarness()
    try {
      if (!['issue-create', 'create'].includes(action)) { await h.page.evaluate(() => window.__flow.enable()); await h.push() }
      if (action === 'revoke') await h.page.evaluate(() => window.__flow.continueSetup())
      let interrupted = false
      h.control.after = async observed => {
        if (observed === action && !interrupted) { interrupted = true; await h.page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange'))) }
        return false
      }
      await h.page.evaluate(action => action === 'revoke' ? window.__flow.revoke() : ['issue-create', 'create'].includes(action) ? window.__flow.enable() : window.__flow.continueSetup(), action)
      expect(interrupted).toBe(true)
      await expect.poll(async () => (await h.stores())[0].length).toBe(0)
      expect(await h.page.evaluate(() => window.__flow.snapshot().state)).toBe('verification-required')
      expect(await h.page.evaluate(() => window.__unsubscribes)).toBe(0)
      const count = h.calls.filter(c => c.action === 'confirm').length
      await h.push(); await h.page.evaluate(() => window.__flow.continueSetup())
      expect(h.calls.filter(c => c.action === 'confirm')).toHaveLength(count)
      expect((await h.stores())[1]).toHaveLength(0)
    } finally { await h.close() }
  })
}

test('push can precede create response; successful revoke precedes failed browser cleanup', async () => {
  const h = await setupHarness()
  try {
    h.control.after = async action => { if (action === 'create') await h.push(); return false }
    await h.page.evaluate(() => window.__flow.enable())
    expect((await h.stores())[1]).toHaveLength(1)
    const payload = h.payload([...h.operations.values()][0]); payload.type = 'FORGE_WEB_PUSH_SETUP_V1'
    await h.push(payload); expect((await h.stores())[1]).toHaveLength(1)
    await h.page.evaluate(() => window.__flow.continueSetup())
    await h.page.evaluate(() => { window.__unsubscribeFails = true })
    await h.page.evaluate(() => window.__flow.revoke())
    expect(await h.page.evaluate(() => window.__flow.snapshot().state)).toBe('server-revoked-cleanup-incomplete')
    expect([...h.operations.values()][0].revoked).toBe(true)
  } finally { await h.close() }
})

test('confirmation response loss reads back without a second mutation or persistent possession secret', async () => {
  const h = await setupHarness()
  try {
    await h.page.evaluate(() => window.__flow.enable()); await h.push()
    let lost = false
    // A committed but unreadable response deterministically reaches application
    // readback. A dropped keep-alive socket can be retransmitted by Chromium itself.
    h.control.after = async (action, input, result, req, res) => { if (action === 'confirm' && !lost) { lost = true; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{'); return true } return false }
    await h.page.evaluate(() => window.__flow.continueSetup())
    expect(await h.page.evaluate(() => window.__flow.snapshot().state)).toBe('confirmed-current-controllable')
    expect(h.calls.filter(c => c.action === 'confirm')).toHaveLength(1)
    await h.page.evaluate(() => window.__flow.revoke())
    const secret = h.calls.find(c => c.action === 'revoke').input.possessionProof
    const stores = await h.stores(), storage = await h.page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage }, html: document.documentElement.outerHTML, href: location.href }))
    expect(JSON.stringify({ stores, storage, notices: await h.notices() })).not.toContain(secret)
  } finally { await h.close() }
})

test('actual socket loss permits only identical browser retransmission and one simulated authority effect', async () => {
  const h = await setupHarness()
  try {
    await h.page.evaluate(() => window.__flow.enable()); await h.push()
    let dropped = false
    h.control.after = async (action, input, result, req, res) => {
      if (action === 'confirm' && !dropped) { dropped = true; res.destroy(); return true }
      return false
    }
    await h.page.evaluate(() => window.__flow.continueSetup())
    expect(dropped).toBe(true)
    expect(await h.page.evaluate(() => window.__flow.snapshot().state)).toBe('confirmed-current-controllable')
    const attempts = h.calls.filter(c => c.action === 'confirm')
    expect(attempts.length).toBeGreaterThanOrEqual(1)
    for (const attempt of attempts) expect(attempt.input).toEqual(attempts[0].input)
    expect(h.calls.filter(c => c.action === 'issue-create')).toHaveLength(1)
    expect(h.calls.filter(c => c.action === 'create')).toHaveLength(1)
    expect([...h.operations.values()][0].authorityEffects).toBe(1)
    expect([...h.operations.values()][0].revision).toBe(1)
    // This is the fixture's effect count, not a claim of new real-D2b DB proof.
  } finally { await h.close() }
})

for (const transition of ['same-account', 'different-account', 'cross-tab', 'equal-token', 'cross-tab-equal-token']) {
  test(`${transition} invalidation removes exact old proof and cannot log out successor`, async () => {
    const h = await setupHarness()
    try {
      await h.page.evaluate(() => window.__flow.enable()); await h.push()
      if (transition.includes('equal-token')) await h.page.evaluate(() => window.__flow.continueSetup())
      const confirmations = h.calls.filter(c => c.action === 'confirm').length
      if (transition === 'cross-tab-equal-token') {
        const other = await h.context.newPage()
        await other.goto(h.page.url())
        await other.evaluate(async () => { const tokens = await import('/src/lib/tokenStore.js'); tokens.setToken(tokens.getToken()) })
        await other.close()
      } else await h.page.evaluate(transition => {
        if (transition === 'cross-tab') {
          localStorage.setItem('forge_push_setup_auth_epoch', crypto.randomUUID())
          window.dispatchEvent(new StorageEvent('storage', { key: 'forge_push_setup_auth_epoch' }))
        } else if (transition === 'equal-token') window.__token.setToken(window.__token.getToken())
        else { window.__token.clearToken(); window.__token.setToken(transition === 'same-account' ? 'synthetic-session-a' : 'synthetic-session-b') }
      }, transition)
      await expect.poll(async () => (await h.stores())[0].length).toBe(0)
      await h.push(); expect((await h.stores())[1]).toHaveLength(0)
      await h.page.evaluate(async () => { await window.__flow.continueSetup(); await window.__flow.revoke() })
      expect(h.calls.filter(c => c.action === 'confirm')).toHaveLength(confirmations)
      expect(h.calls.filter(c => c.action === 'revoke')).toHaveLength(0)
      expect(await h.page.evaluate(() => window.__token.getToken())).toBe(transition === 'different-account' ? 'synthetic-session-b' : 'synthetic-session-a')
      expect(await h.page.evaluate(() => window.__flow.snapshot().state)).toBe('verification-required')
    } finally { await h.close() }
  })
}

test('dedicated store caps at three, scoped deletion and backwards clock cannot extend expiry', async () => {
  const h = await setupHarness()
  try {
    const result = await h.page.evaluate(async () => {
      const store = await import('/src/lib/pushSetupStore.js')
      const ids = Array.from({ length: 4 }, () => crypto.randomUUID()), epoch = crypto.randomUUID()
      const evictions = []
      for (const operationId of ids) evictions.push(await store.putSetupOperation({ operationId, authEpoch: epoch, expiresAt: store.setupNow() + 300000 }))
      const kept = await store.listSetupOperations()
      await store.eraseSetupOperation(ids[3], crypto.randomUUID())
      const afterForeignErase = await store.listSetupOperations()
      const original = Date.now, before = store.setupNow()
      Date.now = () => before - 86400000
      const after = store.setupNow(); Date.now = original
      return { ids, evictions, kept, afterForeignErase, before, after }
    })
    expect(result.kept).toHaveLength(3); expect(result.evictions[3]).toHaveLength(1)
    expect(result.afterForeignErase).toEqual(result.kept); expect(result.after).toBeGreaterThanOrEqual(result.before)
  } finally { await h.close() }
})

for (const mode of ['false', 'reject']) {
  test(`late unsubscribe ${mode} cannot replace controller-interrupted UI`, async () => {
    const h = await setupHarness()
    try {
      await h.page.evaluate(() => window.__flow.enable()); await h.push(); await h.page.evaluate(() => window.__flow.continueSetup())
      await h.page.evaluate(() => { window.__unsubscribeHold = true; window.__pendingRevoke = window.__flow.revoke() })
      await h.page.waitForFunction(() => typeof window.__finishUnsubscribe === 'function')
      await h.page.evaluate(mode => { navigator.serviceWorker.dispatchEvent(new Event('controllerchange')); window.__finishUnsubscribe(mode) }, mode)
      await h.page.evaluate(() => window.__pendingRevoke)
      expect(await h.page.evaluate(() => window.__flow.snapshot().state)).toBe('verification-required')
    } finally { await h.close() }
  })
}

test('late subscription rejection is handled without reviving an interrupted flow', async () => {
  const h = await setupHarness()
  const errors = []
  h.page.on('pageerror', error => errors.push(error.message))
  try {
    await h.page.evaluate(() => { window.__subscription = null; window.__subscribeHold = true; window.__pendingEnable = window.__flow.enable() })
    await h.page.waitForFunction(() => typeof window.__finishSubscribe === 'function')
    await h.page.evaluate(() => { navigator.serviceWorker.dispatchEvent(new Event('controllerchange')); window.__finishSubscribe() })
    await h.page.evaluate(() => window.__pendingEnable)
    expect(await h.page.evaluate(() => window.__flow.snapshot().state)).toBe('verification-required')
    expect(h.calls.filter(c => c.action === 'issue-create')).toHaveLength(0)
    expect(errors).toEqual([])
  } finally { await h.close() }
})

test('handoff is bound to actual WindowClient, nonce, epoch and one-use grant', async () => {
  const h = await setupHarness()
  try {
    await h.page.evaluate(() => window.__flow.enable()); await h.push()
    const result = await h.page.evaluate(async () => {
      const store = await import('/src/lib/pushSetupStore.js'), module = await import('/src/lib/pushSetup.js')
      const op = (await store.listSetupOperations())[0], controller = navigator.serviceWorker.controller
      const message = data => new Promise(resolve => {
        const channel = new MessageChannel(), timer = setTimeout(() => { channel.port1.close(); resolve(null) }, 2100)
        channel.port1.onmessage = ({ data }) => { clearTimeout(timer); channel.port1.close(); resolve(data) }
        controller.postMessage(data, [channel.port2])
      })
      const nonce = module.setupRandom(), hello = await message({ type: 'FORGE_PUSH_SETUP_HELLO', nonce })
      const common = { protocol: module.PUSH_SETUP_PROTOCOL, operationId: op.operationId, clientNonce: op.clientNonce, authEpoch: op.authEpoch }
      const response = await fetch('/push-setup/v1/authorize-handoff', { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + window.__token.getToken() }, body: JSON.stringify({ ...common, clientId: hello.clientId }) })
      const grant = await response.json()
      const input = { type: 'FORGE_PUSH_SETUP_HANDOFF', ...common, clientId: hello.clientId, challengeId: op.challengeId, grant: grant.grant, handshakeNonce: nonce, bootId: hello.bootId }
      const denied = []
      for (const wrong of [{ clientId: 'unrelated-client' }, { clientNonce: module.setupRandom() }, { authEpoch: crypto.randomUUID() }, { operationId: crypto.randomUUID() }]) {
        const reply = await message({ ...input, ...wrong }); denied.push(Boolean(reply?.secret))
      }
      const first = await message(input), replay = await message(input)
      return { denied, firstHasProof: typeof first?.secret === 'string', replayHasProof: Boolean(replay?.secret) }
    })
    expect(result.denied).toEqual([false, false, false, false]); expect(result.firstHasProof).toBe(true); expect(result.replayHasProof).toBe(false)
    expect(h.calls.filter(c => c.action === 'redeem-handoff')).toHaveLength(2)
  } finally { await h.close() }
})

test('same-origin unrelated form is never navigated by a setup notice click', async () => {
  const h = await setupHarness()
  try {
    await h.page.evaluate(() => window.__flow.enable()); await h.push()
    const form = await h.context.newPage(); await form.goto(h.page.url())
    await form.evaluate(() => { document.body.innerHTML = '<input id="draft" value="unsaved">'; window.__sentinel = 'unchanged' })
    let navigations = 0; form.on('framenavigated', () => navigations++)
    const op = [...h.operations.values()][0]
    await h.worker.evaluate(async challengeId => {
      // Synthetic dispatch has no OS user activation. Observe the actual selected
      // WindowClient without claiming the browser granted native focus permission.
      self.__setupFocused = []
      WindowClient.prototype.focus = async function () { self.__setupFocused.push(this.id); return this }
      const pending = [], event = new Event('notificationclick')
      event.notification = { close() {}, data: { kind: 'push-setup', url: '/more', challengeId } }
      event.waitUntil = p => pending.push(p)
      self.dispatchEvent(event); await Promise.all(pending)
    }, op.challengeId)
    expect(navigations).toBe(0); expect(await form.locator('#draft').inputValue()).toBe('unsaved')
    expect(await form.evaluate(() => window.__sentinel)).toBe('unchanged')
    expect(await h.worker.evaluate(() => self.__setupFocused.length)).toBe(1)
  } finally { await h.close() }
})

test('mounted settings remains truthful with browser presence and no eligible operation', async ({ page, context }) => {
  const api = await installAuthenticatedApi({ addInitScript: page.addInitScript.bind(page), route: context.route.bind(context) }, { responses: [
    ['GET /api/strava/status', { connected: false }],
    ['GET /api/notifications/push/config', { configured: true, publicKey: 'BA' }],
  ] })
  await page.goto('/more')
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) await page.reload()
  await page.getByText('Data & alerts', { exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Activity alerts', exact: true })).toBeVisible()
  await expect(page.getByText('This browser is not subscribed. Previous server setup, if any, cannot be verified here.', { exact: true })).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
  expect(api.requestsFor('POST', '/push-setup/v1/issue-create')).toHaveLength(0)
})

test('mounted settings rechecks first worker control without reload or notification permission', async ({ page, context }) => {
  const api = await installAuthenticatedApi({ addInitScript: page.addInitScript.bind(page), route: context.route.bind(context) }, { responses: [
    ['GET /api/strava/status', { connected: false }],
    ['GET /api/notifications/push/config', { configured: true, publicKey: 'BA' }],
  ] })
  await page.addInitScript(() => {
    // Hold first registration until the mounted control has observed no worker.
    // This forces the CI ordering with the real worker and real PushManager.
    const register = navigator.serviceWorker.register.bind(navigator.serviceWorker)
    const released = new Promise(resolve => { window.__releaseFirstWorker = resolve })
    navigator.serviceWorker.register = async (...args) => { await released; return register(...args) }
  })
  await page.goto('/more')
  const permissionBefore = await page.evaluate(() => Notification.permission)
  expect(permissionBefore).not.toBe('granted')
  await page.getByText('Data & alerts', { exact: true }).click()
  await expect(page.getByText('Update Forge to finish enabling notifications. Your notification settings have not changed.', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull()
  await page.evaluate(() => window.__releaseFirstWorker())
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  await expect(page.getByText('This browser is not subscribed. Previous server setup, if any, cannot be verified here.', { exact: true })).toBeVisible()
  expect(await page.evaluate(async () => ({
    controlled: Boolean(navigator.serviceWorker.controller),
    permission: Notification.permission,
    subscription: await (await navigator.serviceWorker.ready).pushManager.getSubscription(),
  }))).toEqual({ controlled: true, permission: permissionBefore, subscription: null })
  expect(api.unexpectedRequests).toEqual([])
  expect(api.requestsFor('POST', '/push-setup/v1/issue-create')).toHaveLength(0)
})

test('mounted pending settings protects reload and controller change never reports enabled', async ({ page, context }) => {
  await context.grantPermissions(['notifications'])
  await installAuthenticatedApi({ addInitScript: page.addInitScript.bind(page), route: context.route.bind(context) }, { responses: [
    ['GET /api/strava/status', { connected: false }],
    ['GET /api/notifications/push/config', { configured: true, publicKey: 'BA' }],
  ] })
  await page.addInitScript(() => {
    const subscription = { endpoint: 'https://fcm.googleapis.com/mounted-synthetic', keys: { p256dh: 'mounted-public-key', auth: 'mounted-auth' } }
    Object.defineProperty(ServiceWorkerRegistration.prototype, 'pushManager', { configurable: true, get: () => ({ getSubscription: async () => ({ toJSON: () => subscription }) }) })
    const original = window.fetch.bind(window)
    window.__setupCalls = []
    const id = crypto.randomUUID(), challenge = crypto.randomUUID()
    window.fetch = async (url, options) => {
      if (!String(url).startsWith('/push-setup/v1/')) return original(url, options)
      const action = String(url).split('/').at(-1), input = JSON.parse(options.body)
      window.__setupCalls.push(action)
      const response = action === 'issue-create' ? { protocol: input.protocol, operationId: id, createAdmission: 'test.capability', expiresAt: Date.now() + 120000 }
        : { protocol: input.protocol, operationId: id, challengeId: challenge, expiresAt: Date.now() + 300000, state: action === 'cancel' ? 'CANCELLED' : 'RESERVED' }
      return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } })
    }
  })
  await page.goto('/more'); await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  await page.reload(); await page.getByText('Data & alerts', { exact: true }).click()
  await expect(page.getByText('This browser has a notification subscription. Forge must verify server setup before showing it as on.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Enable notifications', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Continue enabling notifications' })).toBeVisible()
  const section = page.getByRole('heading', { name: 'Activity alerts', exact: true }).locator('xpath=ancestor::section[1]')
  await expect(section).toHaveAttribute('data-forge-reload-protected', 'true')
  expect(await page.evaluate(() => window.__setupCalls)).toEqual(['issue-create', 'create'])
  await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new Event('controllerchange')))
  await expect(page.getByText('Forge could not verify current setup. Verify again before changing it.', { exact: true })).toBeVisible()
  await expect(page.getByText('Notification setup is verified for this browser.', { exact: true })).toHaveCount(0)
})

test('independent page and worker clock samples do not delete a new pending operation', async () => {
  const h = await setupHarness()
  try {
    await h.page.evaluate(() => { const original = Date.now; Date.now = () => original() + 20 })
    await h.page.evaluate(() => window.__flow.enable())
    expect(h.calls.map(c => c.action)).toEqual(['issue-create', 'create'])
    await h.push()
    expect((await h.stores())[1]).toHaveLength(1)
    await h.page.evaluate(() => window.__flow.continueSetup())
    expect(await h.page.evaluate(() => window.__flow.snapshot().state)).toBe('confirmed-current-controllable')
  } finally { await h.close() }
})

for (const transition of ['equal-token', 'changed-token', 'logout-login', 'cross-tab-equal-token', 'read-before-storage-event', 'missing-epoch', 'malformed-epoch', 'rapid-rotations']) {
  test(`mounted coordinator replaces ${transition} once, read-only, without listener leaks or inert controls`, async () => {
    const h = await setupHarness()
    try {
      await h.mountControl()
      const enable = h.page.getByRole('button', { name: 'Enable notifications', exact: true })
      for (let cycle = 0; cycle < 2; cycle++) {
        await enable.click(); await h.page.getByRole('button', { name: 'Continue enabling notifications' }).waitFor()
        await h.push(); await h.page.getByRole('button', { name: 'Continue enabling notifications' }).click()
        await h.page.getByRole('button', { name: 'Turn off alerts', exact: true }).waitFor()
        const reads = h.control.configReads, issues = h.calls.filter(c => c.action === 'issue-create').length
        if (transition === 'cross-tab-equal-token') {
          const other = await h.context.newPage(); await other.goto(new URL('/more', h.page.url()).href)
          await other.evaluate(async () => { const token = await import('/src/lib/tokenStore.js'); token.setToken(token.getToken()) })
          await other.close()
        } else await h.page.evaluate(({ transition, cycle }) => {
          if (transition === 'logout-login') { window.__token.clearToken(); window.__token.setToken('synthetic-session-a') }
          else if (transition === 'read-before-storage-event') {
            localStorage.setItem('forge_push_setup_auth_epoch', crypto.randomUUID())
            window.__token.getPushSetupAuthEpoch()
            window.dispatchEvent(new StorageEvent('storage', { key: 'forge_push_setup_auth_epoch', newValue: localStorage.getItem('forge_push_setup_auth_epoch') }))
          }
          else if (transition === 'missing-epoch' || transition === 'malformed-epoch') {
            if (transition === 'missing-epoch') localStorage.removeItem('forge_push_setup_auth_epoch')
            else localStorage.setItem('forge_push_setup_auth_epoch', 'malformed')
            window.__token.getPushSetupAuthEpoch() // Same tab receives no storage event.
          }
          else if (transition === 'rapid-rotations') {
            const middle = crypto.randomUUID(), latest = crypto.randomUUID()
            localStorage.setItem('forge_push_setup_auth_epoch', middle); window.__token.getPushSetupAuthEpoch()
            localStorage.setItem('forge_push_setup_auth_epoch', latest); window.__token.getPushSetupAuthEpoch()
            for (const newValue of [middle, latest, middle]) window.dispatchEvent(new StorageEvent('storage', { key: 'forge_push_setup_auth_epoch', newValue }))
          }
          else window.__token.setToken(transition === 'equal-token' ? window.__token.getToken() : `synthetic-session-${cycle + 2}`)
        }, { transition, cycle })
        await enable.waitFor()
        await expect(h.page.getByText('This browser has a notification subscription. Forge must verify server setup before showing it as on.', { exact: true })).toBeVisible()
        expect(h.control.configReads).toBe(reads + 1)
        expect(h.calls.filter(c => c.action === 'issue-create')).toHaveLength(issues)
        expect(h.calls.filter(c => c.action === 'revoke')).toHaveLength(0)
        expect(await h.page.evaluate(() => window.__listenerCounts)).toEqual({ controllerchange: 1, message: 1, pagehide: 1, pageshow: 1 })
        // An unchanged epoch notification is not a reauthentication.
        await h.page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'forge_push_setup_auth_epoch', newValue: localStorage.getItem('forge_push_setup_auth_epoch') })))
        await h.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 0)))
        expect(h.control.configReads).toBe(reads + 1)
      }
      const before = h.calls.filter(c => c.action === 'issue-create').length
      await enable.click(); await h.page.getByRole('button', { name: 'Continue enabling notifications' }).waitFor()
      expect(h.calls.filter(c => c.action === 'issue-create')).toHaveLength(before + 1)
      await h.page.evaluate(() => window.__root.unmount())
      expect(await h.page.evaluate(() => window.__listenerCounts)).toEqual({ controllerchange: 0, message: 0, pagehide: 0, pageshow: 0 })
    } finally { await h.close() }
  })
}

test('mounted logout and held old response cannot render or mutate the read-only successor', async () => {
  const h = await setupHarness()
  let release
  try {
    await h.mountControl()
    const held = new Promise(resolve => { release = resolve })
    h.control.after = async action => { if (action === 'create') await held; return false }
    await h.page.getByRole('button', { name: 'Enable notifications', exact: true }).click()
    await expect.poll(() => h.calls.filter(c => c.action === 'create').length).toBe(1)
    await h.page.evaluate(() => window.__token.clearToken())
    await expect(h.page.getByText('Forge could not verify current setup. Verify again before changing it.', { exact: true })).toBeVisible()
    expect(h.control.configReads).toBe(1)
    expect(await h.page.getByRole('button').count()).toBe(0)
    await h.page.evaluate(() => window.__token.setToken('synthetic-successor-session'))
    await h.page.getByRole('button', { name: 'Enable notifications', exact: true }).waitFor()
    expect(h.control.configReads).toBe(2)
    release(); await h.page.evaluate(() => new Promise(resolve => setTimeout(resolve, 30)))
    await expect(h.page.getByText('This browser has a notification subscription. Forge must verify server setup before showing it as on.', { exact: true })).toBeVisible()
    expect(h.calls.filter(c => ['issue-create', 'create'].includes(c.action)).map(c => c.action)).toEqual(['issue-create', 'create'])
    expect(h.calls.filter(c => ['confirm', 'revoke'].includes(c.action))).toHaveLength(0)
    expect(await h.page.evaluate(() => window.__listenerCounts)).toEqual({ controllerchange: 1, message: 1, pagehide: 1, pageshow: 1 })
  } finally { release?.(); await h.close() }
})

test('mounted epoch-storage failure, observed recovery and storage clear stay truthful without listener loops', async () => {
  const h = await setupHarness()
  try {
    await h.mountControl()
    await h.page.getByRole('button', { name: 'Enable notifications', exact: true }).click()
    await h.page.getByRole('button', { name: 'Continue enabling notifications' }).waitFor()
    await h.push(); await h.page.getByRole('button', { name: 'Continue enabling notifications' }).click()
    await h.page.getByRole('button', { name: 'Turn off alerts', exact: true }).waitFor()
    await h.page.evaluate(() => {
      window.__beforeStorageFailureSession = window.__token.getAuthSession()
      window.__storageGet = Storage.prototype.getItem
      Storage.prototype.getItem = function (key) { if (key === 'forge_push_setup_auth_epoch') throw Error('synthetic epoch storage unavailable'); return window.__storageGet.call(this, key) }
      window.__token.getPushSetupAuthEpoch()
    })
    await expect(h.page.getByText('Forge could not verify current setup. Verify again before changing it.', { exact: true })).toBeVisible()
    expect(await h.page.getByRole('button').count()).toBe(0)
    expect(h.control.configReads).toBe(1)
    expect(await h.page.evaluate(() => window.__token.isAuthSessionCurrent(window.__beforeStorageFailureSession))).toBe(true)
    await h.page.evaluate(() => { Storage.prototype.getItem = window.__storageGet; window.__token.getPushSetupAuthEpoch() })
    await h.page.getByRole('button', { name: 'Enable notifications', exact: true }).waitFor()
    expect(h.control.configReads).toBe(2)
    expect(h.calls.filter(c => c.action === 'issue-create')).toHaveLength(1)
    expect(h.calls.filter(c => c.action === 'revoke')).toHaveLength(0)
    await h.page.evaluate(() => { localStorage.clear(); window.dispatchEvent(new StorageEvent('storage', { key: null })) })
    await expect(h.page.getByText('Forge could not verify current setup. Verify again before changing it.', { exact: true })).toBeVisible()
    expect(await h.page.getByRole('button').count()).toBe(0)
    expect(await h.page.evaluate(() => window.__token.isAuthSessionCurrent(window.__beforeStorageFailureSession))).toBe(false)
    expect(await h.page.evaluate(() => window.__listenerCounts)).toEqual({ controllerchange: 1, message: 1, pagehide: 1, pageshow: 1 })
  } finally { await h.page.evaluate(() => { if (window.__storageGet) Storage.prototype.getItem = window.__storageGet }).catch(() => {}); await h.close() }
})

for (const confirmed of [false, true]) {
  test(`mounted ${confirmed ? 'confirmed' : 'pending'} expires passively, erases local authority and never auto-issues or cancels`, async () => {
    const h = await setupHarness()
    try {
      await h.page.clock.install(); await h.mountControl()
      await h.page.getByRole('button', { name: 'Enable notifications', exact: true }).click()
      await h.page.getByRole('button', { name: 'Continue enabling notifications' }).waitFor()
      if (confirmed) { await h.push(); await h.page.getByRole('button', { name: 'Continue enabling notifications' }).click(); await h.page.getByRole('button', { name: 'Turn off alerts', exact: true }).waitFor() }
      const calls = h.calls.length
      await h.page.clock.fastForward(300001)
      await expect(h.page.getByText('Setup expired. Start a new verification to continue.', { exact: true })).toBeVisible()
      await expect.poll(async () => (await h.stores()).map(rows => rows.length)).toEqual([0, 0])
      expect(h.calls).toHaveLength(calls)
      await h.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
      await expect(h.page.getByText('This browser has a notification subscription. Forge must verify server setup before showing it as on.', { exact: true })).toBeVisible()
      expect(h.calls).toHaveLength(calls)
    } finally { await h.close() }
  })
}

test('pagehide drops volatile state and pageshow resumes pending proof read-only with a fresh handshake', async () => {
  const h = await setupHarness()
  try {
    await h.page.evaluate(() => window.__flow.enable()); await h.push()
    const before = h.calls.filter(c => c.action === 'issue-create').length
    await h.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })))
    expect(await h.page.evaluate(() => window.__flow.snapshot().state)).toBe('verification-required')
    await h.page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })))
    await expect.poll(() => h.page.evaluate(() => window.__flow.snapshot().state)).toBe('setup-pending')
    expect(h.calls.filter(c => c.action === 'issue-create')).toHaveLength(before)
    expect(h.calls.filter(c => c.action === 'confirm')).toHaveLength(0)
    await h.page.evaluate(() => window.__flow.continueSetup())
    expect(await h.page.evaluate(() => window.__flow.snapshot().state)).toBe('confirmed-current-controllable')
  } finally { await h.close() }
})

test('expiry aborts a held confirmation and its late response cannot revive authority', async () => {
  const h = await setupHarness()
  let release
  try {
    await h.page.clock.install()
    await h.page.evaluate(() => window.__flow.enable()); await h.push()
    const held = new Promise(resolve => { release = resolve })
    h.control.after = async action => { if (action === 'confirm') await held; return false }
    await h.page.evaluate(() => { window.__pendingConfirm = window.__flow.continueSetup() })
    await expect.poll(() => h.calls.filter(c => c.action === 'confirm').length).toBe(1)
    const count = h.calls.length
    await h.page.clock.fastForward(300001)
    await h.page.evaluate(() => window.__pendingConfirm)
    expect(await h.page.evaluate(() => window.__flow.snapshot().state)).toBe('expired')
    release()
    await expect.poll(async () => (await h.stores()).map(rows => rows.length)).toEqual([0, 0])
    expect(h.calls).toHaveLength(count)
    expect(await h.page.evaluate(() => window.__flow.snapshot().state)).toBe('expired')
    expect(await h.page.evaluate(() => window.__unsubscribes)).toBe(0)
  } finally { release?.(); await h.close() }
})
