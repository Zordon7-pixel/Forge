import { expect, test } from '@playwright/test'

async function waitForServiceWorkerControl(page) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
    await page.reload({ waitUntil: 'domcontentloaded' })
  }
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
}

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
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForServiceWorkerControl(page)

  await expect.poll(() => page.evaluate(async () => {
    const names = await caches.keys()
    return names.includes('forge-v6') && !names.includes('forge-v5')
  })).toBe(true)
  const cacheNames = await page.evaluate(() => caches.keys())
  expect(cacheNames).toContain('forge-v6')
  expect(cacheNames).not.toContain('forge-v5')

  const staleAsset = await page.evaluate(async () => {
    const url = '/assets/forge-stale-chunk-probe.js'
    const response = await fetch(url, { cache: 'reload' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    return {
      status: response.status,
      contentType: response.headers.get('content-type') || '',
      cached: Boolean(await caches.match(url)),
    }
  })

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
    const cache = await caches.open('forge-v6')
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
