import { expect, test } from '@playwright/test'
import { installAuthenticatedApi } from './support/mockApi.mjs'

const ROUTES = [
  { path: '/', label: 'Today', heading: "Check in for today's recommendation" },
  { path: '/run', label: 'Train', heading: 'Train' },
  { path: '/log-lift', label: 'Lift', heading: 'Start Workout' },
  { path: '/health', label: 'Body', heading: 'Body' },
  { path: '/more', label: 'More', heading: 'More' },
  { path: '/plan', label: 'Training', heading: 'Build your training calendar' },
  { path: '/history', label: 'History', heading: 'History' },
  { path: '/community', label: 'Community', heading: 'Community' },
]

let apiState

test.beforeEach(async ({ page }) => {
  apiState = await installAuthenticatedApi(page)
})

test.afterEach(() => {
  expect([...new Set(apiState?.unexpectedRequests || [])], 'Every browser API request must have an explicit method/path fixture').toEqual([])
})

for (const { path, label, heading } of ROUTES) {
  test(`${label} renders without startup errors or horizontal overflow`, async ({ page }) => {
    const pageErrors = []
    const consoleErrors = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })

    await page.goto(path)
    await expect(page.getByText('Loading Forged Hybrid')).toHaveCount(0, { timeout: 15_000 })
    await expect(page.getByText('Forged Hybrid — Startup Error')).toHaveCount(0)
    expect(new URL(page.url()).pathname).toBe(path)
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send feedback' })).toBeVisible()

    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      body: document.body.scrollWidth,
      document: document.documentElement.scrollWidth,
    }))
    expect(overflow.body, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport + 1)
    expect(overflow.document, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.viewport + 1)
    expect(pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
  })
}

test('primary navigation and feedback remain reachable', async ({ page }) => {
  await page.goto('/')
  for (const path of ['/run', '/log-lift', '/health', '/more', '/']) {
    await page.locator(`nav a[href="${path}"]`).click()
    await expect(page).toHaveURL(new RegExp(`${path === '/' ? '/$' : `${path}$`}`))
  }

  await page.getByRole('button', { name: 'Send feedback' }).click()
  await expect(page.getByRole('heading', { name: 'Send Feedback' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Report an Issue' })).toBeVisible()
  await page.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByRole('heading', { name: 'Send Feedback' })).toHaveCount(0)
})

test('pull to refresh remounts page data without a browser reload', async ({ page }) => {
  let runsRequests = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/runs') runsRequests += 1
  })

  await page.goto('/history')
  await expect.poll(() => runsRequests).toBeGreaterThan(0)
  const before = runsRequests
  const documentSentinel = await page.evaluate(() => {
    window.__forgeQaDocumentSentinel = crypto.randomUUID()
    return window.__forgeQaDocumentSentinel
  })
  let mainFrameNavigations = 0
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) mainFrameNavigations += 1
  })

  await page.evaluate(() => {
    window.scrollTo(0, 0)
    const target = document.querySelector('main')
    const touchAt = (y) => new Touch({ identifier: 1, target, clientX: 160, clientY: y })
    window.dispatchEvent(new TouchEvent('touchstart', { touches: [touchAt(80)], bubbles: true }))
    window.dispatchEvent(new TouchEvent('touchmove', { touches: [touchAt(230)], bubbles: true, cancelable: true }))
    window.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touchAt(230)], bubbles: true }))
  })

  await expect.poll(() => runsRequests).toBeGreaterThan(before)
  expect(mainFrameNavigations, 'Pull-to-refresh must not navigate or reload the main document').toBe(0)
  await expect.poll(() => page.evaluate(() => window.__forgeQaDocumentSentinel)).toBe(documentSentinel)
  await expect(page.getByText('Forged Hybrid — Startup Error')).toHaveCount(0)
})
