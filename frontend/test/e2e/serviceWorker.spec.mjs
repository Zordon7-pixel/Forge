import { expect, test } from '@playwright/test'

async function waitForServiceWorkerControl(page) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
    await page.reload({ waitUntil: 'domcontentloaded' })
  }
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
}

async function waitForAdoptedAppShell(page, expectedLoadCount = 2) {
  await expect.poll(async () => {
    try {
      return await page.evaluate(() => ({
        pathname: window.location.pathname,
        readyState: document.readyState,
        loadCount: window.__forgeSwFixture?.snapshot().loadCount ?? null,
        rootHasContent: Boolean(document.getElementById('root')?.childElementCount),
      }))
    } catch {
      return null
    }
  }, {
    message: 'the final same-URL takeover document should restore the React app shell after exactly one reload',
    timeout: 15_000,
  }).toEqual({
    pathname: '/login',
    readyState: 'complete',
    loadCount: expectedLoadCount,
    rootHasContent: true,
  })
  await expect(page.getByRole('heading', { name: 'Log In', exact: true })).toBeVisible({ timeout: 15_000 })
}

async function installWaitingUpdateFixture(page) {
  await page.addInitScript(() => {
    const LOAD_COUNT_KEY = 'forge-sw-fixture-loads'
    const ACTIVATION_COUNT_KEY = 'forge-sw-fixture-activations'
    const CONTROLLER_COUNT_KEY = 'forge-sw-fixture-controllerchanges'
    const DUPLICATE_CONTROLLER_COUNT_KEY = 'forge-sw-fixture-duplicate-controllerchanges'
    const TOTAL_UPDATE_COUNT_KEY = 'forge-sw-fixture-update-checks'
    const ACTIVE_REVISION_KEY = 'forge-sw-fixture-active-revision'
    const loadCount = Number(sessionStorage.getItem(LOAD_COUNT_KEY) || 0) + 1
    sessionStorage.setItem(LOAD_COUNT_KEY, String(loadCount))

    let clock = 1_000
    Date.now = () => clock

    class FixtureWorker extends EventTarget {
      constructor(scriptURL, state) {
        super()
        this.scriptURL = scriptURL
        this.state = state
      }

      setState(state) {
        this.state = state
        this.dispatchEvent(new Event('statechange'))
      }

      postMessage(message, transfer = []) {
        if (message?.type === 'FORGE_GET_VERSION') {
          transfer[0]?.postMessage({ type: 'FORGE_SW_VERSION', revision: 'forge-fixture-v2' })
          return
        }
        if (message?.type !== 'FORGE_ACTIVATE_UPDATE') return
        const activations = Number(sessionStorage.getItem(ACTIVATION_COUNT_KEY) || 0) + 1
        sessionStorage.setItem(ACTIVATION_COUNT_KEY, String(activations))
        queueMicrotask(() => {
          container.controller = this
          registration.waiting = null
          sessionStorage.setItem(ACTIVE_REVISION_KEY, 'v2')
          const changes = Number(sessionStorage.getItem(CONTROLLER_COUNT_KEY) || 0) + 1
          sessionStorage.setItem(CONTROLLER_COUNT_KEY, String(changes))
          container.dispatchEvent(new Event('controllerchange'))
        })
      }
    }

    class FixtureRegistration extends EventTarget {
      constructor() {
        super()
        this.installing = null
        this.waiting = null
        this.active = null
        this.updateCalls = 0
      }

      async update() {
        this.updateCalls += 1
        const totalUpdates = Number(sessionStorage.getItem(TOTAL_UPDATE_COUNT_KEY) || 0) + 1
        sessionStorage.setItem(TOTAL_UPDATE_COUNT_KEY, String(totalUpdates))
        if (this.updateCalls !== 2) return this
        const installing = new FixtureWorker(`${location.origin}/sw.js?fixture=v2`, 'installing')
        this.installing = installing
        this.dispatchEvent(new Event('updatefound'))
        queueMicrotask(() => {
          installing.setState('installed')
          this.installing = null
          this.waiting = installing
        })
        return this
      }
    }

    const registration = new FixtureRegistration()
    const container = new EventTarget()
    const activeRevision = sessionStorage.getItem(ACTIVE_REVISION_KEY) || 'v1'
    container.controller = new FixtureWorker(`${location.origin}/sw.js?fixture=${activeRevision}`, 'activated')
    container.register = async () => registration
    container.getRegistration = async () => registration
    container.ready = Promise.resolve(registration)

    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: container,
    })

    window.__forgeSwFixture = {
      foreground() {
        clock += 60_000
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
        document.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
      },
      repeatControllerChange() {
        const duplicates = Number(sessionStorage.getItem(DUPLICATE_CONTROLLER_COUNT_KEY) || 0) + 1
        sessionStorage.setItem(DUPLICATE_CONTROLLER_COUNT_KEY, String(duplicates))
        container.dispatchEvent(new Event('controllerchange'))
      },
      snapshot() {
        return {
          updateCalls: registration.updateCalls,
          totalUpdateCalls: Number(sessionStorage.getItem(TOTAL_UPDATE_COUNT_KEY) || 0),
          activationCount: Number(sessionStorage.getItem(ACTIVATION_COUNT_KEY) || 0),
          controllerChanges: Number(sessionStorage.getItem(CONTROLLER_COUNT_KEY) || 0),
          duplicateControllerChanges: Number(sessionStorage.getItem(DUPLICATE_CONTROLLER_COUNT_KEY) || 0),
          loadCount: Number(sessionStorage.getItem(LOAD_COUNT_KEY) || 0),
        }
      },
    }
  })
}

// Reproduced boundary: a still-open page has an older controller and learns about
// a newly installed worker only when it returns to the foreground. This covers the
// source lifecycle gap; it does not treat a historical screenshot as a current-release reproduction.
test('a foregrounded page adopts one installed update from its older controller', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 })
  await installWaitingUpdateFixture(page)
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Log In', exact: true })).toBeVisible()
  await page.evaluate(() => setTimeout(() => window.__forgeSwFixture.foreground(), 0))
  await waitForAdoptedAppShell(page)
  await expect.poll(() => page.evaluate(() => window.__forgeSwFixture.snapshot().totalUpdateCalls)).toBe(3)

  expect(await page.evaluate(() => window.__forgeSwFixture.snapshot())).toMatchObject({
    totalUpdateCalls: 3,
    activationCount: 1,
    controllerChanges: 1,
    loadCount: 2,
  })
  await expect(page.getByTestId('service-worker-update-notice')).toHaveCount(0)
  await page.evaluate(() => window.__forgeSwFixture.repeatControllerChange())
  await page.waitForTimeout(250)
  expect(await page.evaluate(() => window.__forgeSwFixture.snapshot())).toMatchObject({
    totalUpdateCalls: 3,
    activationCount: 1,
    controllerChanges: 1,
    duplicateControllerChanges: 1,
    loadCount: 2,
  })
})

test('a 320px dirty form defers activation until the user makes reload safe', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 })
  await installWaitingUpdateFixture(page)
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Log In', exact: true })).toBeVisible()
  await page.getByPlaceholder('Email').fill('unsaved@example.com')
  await page.evaluate(() => window.__forgeSwFixture.foreground())

  const notice = page.getByTestId('service-worker-update-notice')
  await expect(notice).toBeVisible()
  await expect(notice).toContainText('Save or finish')
  expect(await notice.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    return element.scrollWidth <= element.clientWidth
      && bounds.left >= 0
      && bounds.right <= window.innerWidth
      && document.documentElement.scrollWidth <= window.innerWidth
  })).toBe(true)
  expect(await page.evaluate(() => window.__forgeSwFixture.snapshot())).toMatchObject({
    totalUpdateCalls: 2,
    activationCount: 0,
    loadCount: 1,
  })

  await page.getByPlaceholder('Email').fill('')
  await page.waitForTimeout(100)
  expect((await page.evaluate(() => window.__forgeSwFixture.snapshot())).activationCount).toBe(0)
  await expect(notice).toBeVisible()
  await notice.getByRole('button', { name: 'Update now' }).click()
  await waitForAdoptedAppShell(page)
  await expect.poll(() => page.evaluate(() => window.__forgeSwFixture.snapshot().totalUpdateCalls)).toBe(3)
  expect(await page.evaluate(() => window.__forgeSwFixture.snapshot())).toMatchObject({
    totalUpdateCalls: 3,
    activationCount: 1,
    controllerChanges: 1,
    loadCount: 2,
  })
  await page.evaluate(() => window.__forgeSwFixture.repeatControllerChange())
  await page.waitForTimeout(250)
  expect(await page.evaluate(() => window.__forgeSwFixture.snapshot())).toMatchObject({
    totalUpdateCalls: 3,
    activationCount: 1,
    controllerChanges: 1,
    duplicateControllerChanges: 1,
    loadCount: 2,
  })
})

test('service worker purges old caches and never stores or serves HTML as JavaScript', async ({ page, context }) => {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  await waitForServiceWorkerControl(page)

  await page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations()
    await Promise.all(registrations.map((registration) => registration.unregister()))
    const oldCache = await caches.open('forge-v5')
    await oldCache.put('/assets/poisoned-old-chunk.js', new Response('<!doctype html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=UTF-8' },
    }))
    const oldApiCache = await caches.open('forge-api-v1')
    await oldApiCache.put('/api/users/settings', new Response('{"account":"stale"}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForServiceWorkerControl(page)

  await expect.poll(() => page.evaluate(async () => {
    const names = await caches.keys()
    return names.includes('forge-v8') && !names.includes('forge-v5') && !names.includes('forge-v6') && !names.includes('forge-v7') && !names.includes('forge-api-v1')
  })).toBe(true)
  const cacheNames = await page.evaluate(() => caches.keys())
  expect(cacheNames).toContain('forge-v8')
  expect(cacheNames).not.toContain('forge-v5')
  expect(cacheNames).not.toContain('forge-v6')
  expect(cacheNames).not.toContain('forge-v7')
  expect(cacheNames).not.toContain('forge-api-v1')

  const staleAsset = await page.evaluate(async () => {
    const url = '/assets/forge-stale-chunk-probe.js'
    const response = await fetch(url, { cache: 'reload' })
    return {
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      cached: Boolean(await caches.match(url)),
    }
  })

  expect(staleAsset.status, JSON.stringify(staleAsset)).toBe(503)
  expect(staleAsset.contentType, JSON.stringify(staleAsset)).toMatch(/^text\/plain/i)
  expect(staleAsset.cached, JSON.stringify(staleAsset)).toBe(false)

  await context.setOffline(true)
  const offlineAsset = await page.evaluate(async () => {
    const response = await fetch('/assets/forge-uncached-offline-probe.js')
    return {
      status: response.status,
      contentType: response.headers.get('content-type') || '',
    }
  })
  await context.setOffline(false)

  expect(offlineAsset.status).toBe(503)
  expect(offlineAsset.contentType).toMatch(/^text\/plain/i)
})

test('a rendered login page survives an immediate offline reload', async ({ page, context }) => {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  await waitForServiceWorkerControl(page)
  await expect(page.getByRole('heading', { name: 'Log In', exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(async () => {
    const cache = await caches.open('forge-v8')
    const codeUrls = [
      ...document.querySelectorAll('script[type="module"][src], link[rel="stylesheet"][href]'),
    ].map((element) => element.src || element.href).concat(
      performance.getEntriesByType('resource').map((entry) => entry.name),
    )
      .filter((url) => new URL(url).origin === window.location.origin)
      .filter((url) => /\.(?:js|css)(?:\?|$)/i.test(new URL(url).pathname))
    const uniqueCodeUrls = [...new Set(codeUrls)]
    const responses = await Promise.all(uniqueCodeUrls.map((url) => cache.match(url, { ignoreVary: true })))
    return uniqueCodeUrls.length >= 3 && responses.every(Boolean)
  })).toBe(true)

  await context.setOffline(true)
  await page.reload({ waitUntil: 'domcontentloaded' })

  await expect(page.getByRole('heading', { name: 'Log In', exact: true })).toBeVisible()
  await expect(page.getByText('Forged Hybrid — Startup Error')).toHaveCount(0)
  await context.setOffline(false)
})

test('authenticated API cache entries are isolated by bearer token', async ({ page }) => {
  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  await waitForServiceWorkerControl(page)

  const result = await page.evaluate(async () => {
    const cache = await caches.open('forge-api-v2')
    const url = new URL('/api/users/settings', window.location.origin)
    const accountARequest = new Request(url, {
      headers: { Authorization: 'Bearer account-a-token' },
    })
    const accountBRequest = new Request(url, {
      headers: { Authorization: 'Bearer account-b-token' },
    })
    await cache.put(accountARequest, new Response('{"account":"a"}', {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        Vary: 'Origin, Authorization',
      },
    }))

    const accountAResponse = await cache.match(accountARequest)
    const accountBResponse = await cache.match(accountBRequest)
    await cache.delete(accountARequest)
    return {
      accountABody: accountAResponse ? await accountAResponse.text() : null,
      accountBMatched: Boolean(accountBResponse),
    }
  })

  expect(result.accountABody).toBe('{"account":"a"}')
  expect(result.accountBMatched).toBe(false)
})
