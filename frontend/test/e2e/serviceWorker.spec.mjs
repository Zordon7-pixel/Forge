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

  const cacheNames = await page.evaluate(() => caches.keys())
  expect(cacheNames).toContain('forge-v5')
  expect(cacheNames).not.toContain('forge-v4')

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
