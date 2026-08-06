import { expect, test } from '@playwright/test'

const EXPECTED_ASSET_PATH = String(process.env.FORGE_QA_EXPECTED_ASSET || '').trim()
const EXPECTED_REVISION = String(process.env.FORGE_QA_EXPECTED_REVISION || '').trim().toLowerCase()

const PUBLIC_ROUTES = [
  { path: '/', heading: /The coach for runners who lift/i },
  { path: '/login', heading: 'Log In' },
  { path: '/register', heading: 'Sign Up' },
  { path: '/privacy', heading: 'Privacy Policy' },
  { path: '/terms', heading: 'Terms of Service' },
]

async function waitForServiceWorkerControl(page) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true))
  if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
    await page.reload({ waitUntil: 'domcontentloaded' })
  }
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
}

test('live production shell, hashed assets, and offline cache remain healthy', async ({ page, context, request }) => {
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  if (EXPECTED_REVISION) {
    const rootResponse = await request.get('/')
    expect(String(rootResponse.headers()['x-forge-revision'] || '').toLowerCase()).toBe(EXPECTED_REVISION)
  }

  for (const { path, heading } of PUBLIC_ROUTES) {
    await page.goto(path, { waitUntil: 'domcontentloaded' })
    expect(new URL(page.url()).pathname).toBe(path)
    await expect(page.getByRole('heading', { name: heading, exact: typeof heading === 'string' })).toBeVisible()
    await expect(page.getByText('Forged Hybrid — Startup Error')).toHaveCount(0)
    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      body: document.body.scrollWidth,
      document: document.documentElement.scrollWidth,
    }))
    expect(overflow.body, `${path}: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(overflow.viewport + 1)
    expect(overflow.document, `${path}: ${JSON.stringify(overflow)}`).toBeLessThanOrEqual(overflow.viewport + 1)
  }

  await waitForServiceWorkerControl(page)

  const assets = await page.evaluate(() => [
    ...document.querySelectorAll('script[type="module"][src], link[rel="stylesheet"][href]'),
  ].map((element) => element.src || element.href))
  expect(assets.length).toBeGreaterThanOrEqual(2)

  if (EXPECTED_ASSET_PATH) {
    const entryAsset = assets.find((assetUrl) => new URL(assetUrl).pathname.endsWith('.js'))
    expect(entryAsset).toBeTruthy()
    expect(new URL(entryAsset).pathname).toBe(EXPECTED_ASSET_PATH)
  }

  for (const assetUrl of assets) {
    const response = await request.get(assetUrl)
    expect(response.status(), assetUrl).toBe(200)
    const contentType = response.headers()['content-type'] || ''
    if (assetUrl.endsWith('.js')) expect(contentType, assetUrl).toMatch(/javascript|ecmascript/)
    if (assetUrl.endsWith('.css')) expect(contentType, assetUrl).toContain('text/css')
  }

  const staleUrl = '/assets/forge-stale-chunk-probe.js'
  const staleResponse = await request.get(staleUrl)
  expect(staleResponse.status()).toBe(404)
  expect(staleResponse.headers()['content-type'] || '').not.toContain('text/html')

  const staleCacheState = await page.evaluate(async (url) => {
    await fetch(url, { cache: 'reload' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    return Boolean(await caches.match(url))
  }, staleUrl)
  expect(staleCacheState).toBe(false)

  await page.goto('/login', { waitUntil: 'domcontentloaded' })
  await waitForServiceWorkerControl(page)
  await expect(page.getByRole('heading', { name: 'Log In', exact: true })).toBeVisible()
  await context.setOffline(true)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await expect(page.getByRole('heading', { name: 'Log In', exact: true })).toBeVisible()
  await expect(page.getByText('Forged Hybrid — Startup Error')).toHaveCount(0)
  await context.setOffline(false)

  expect(pageErrors).toEqual([])
})
