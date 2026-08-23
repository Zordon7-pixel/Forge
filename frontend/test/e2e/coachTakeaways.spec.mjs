import { expect, test } from '@playwright/test'
import { installAuthenticatedApi } from './support/mockApi.mjs'

const run = {
  id: 'coach-takeaway-run',
  date: '2026-08-21',
  type: 'easy',
  distance_miles: 5,
  duration_seconds: 2700,
  perceived_effort: 6,
  pain_level: 'none',
  ai_feedback: 'Your final mile stayed controlled at the planned effort. Recovery should stay easy for the next 24 hours. Keep the next run conversational before adding speed. No pain was reported, but stop if discomfort appears. Heart rate stayed steady through the finish.',
}

const expectedViewports = {
  'compact-mobile-320': { width: 320, height: 568 },
  'iphone-17': { width: 402, height: 874 },
}

test('Coach Takeaways stays compact and contained at exact mobile widths', async ({ page }, testInfo) => {
  const expectedViewport = expectedViewports[testInfo.project.name]
  expect(expectedViewport, `viewport fixture for ${testInfo.project.name}`).toBeTruthy()
  const viewport = testInfo.project.use.viewport
  expect(viewport, `configured viewport for ${testInfo.project.name}`).toEqual(expectedViewport)
  expect(page.viewportSize()).toEqual(viewport)
  const apiState = await installAuthenticatedApi(page, {
    responses: [
      ['GET /api/runs', { runs: [run] }],
      [`GET /api/runs/${run.id}`, { run }],
      [`GET /api/plans/adaptation/run/${run.id}`, {
        impact: { status: 'keep', decisionStatus: 'reviewed', changes: [] },
      }],
    ],
  })

  await page.goto(`/history?runId=${run.id}`)
  const heading = page.getByRole('heading', { name: 'Coach Takeaways', exact: true })
  await expect(heading).toBeVisible()
  const card = heading.locator('xpath=ancestor::section')
  await expect(card.locator('li')).toHaveCount(4)
  await expect(card.getByText('Pain', { exact: true })).toBeVisible()
  await expect(card.getByText('Next Step', { exact: true })).toBeVisible()

  const layout = await card.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const copy = [...element.querySelectorAll('li p:last-child')]
    return {
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      left: rect.left,
      right: rect.right,
      width: rect.width,
      height: rect.height,
      clippedCopy: copy.some((node) => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1),
    }
  })

  expect(layout.viewportWidth, JSON.stringify(layout)).toBe(viewport.width)
  expect(layout.viewportHeight, JSON.stringify(layout)).toBe(viewport.height)
  expect(layout.documentWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewportWidth + 1)
  expect(layout.left, JSON.stringify(layout)).toBeGreaterThanOrEqual(0)
  expect(layout.right, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewportWidth + 1)
  expect(Math.abs(layout.left - (layout.viewportWidth - layout.width) / 2), JSON.stringify(layout)).toBeLessThanOrEqual(1)
  expect(layout.height, JSON.stringify(layout)).toBeLessThan(layout.viewportHeight)
  expect(layout.clippedCopy, JSON.stringify(layout)).toBe(false)
  expect([...new Set(apiState.unexpectedRequests)]).toEqual([])
})
