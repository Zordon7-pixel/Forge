import { expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installAuthenticatedApi } from './support/mockApi.mjs'

const dateISO = '2026-08-16'
const receiptDirectory = fileURLToPath(new URL('../../.qa/dashboard-unified-brief-recap/', import.meta.url))
const receiptNames = {
  'compact-mobile-320': {
    dashboardClosed: 'compact-mobile-320-dashboard-closed.png',
    weeklyRecapOpen: 'compact-mobile-320-weekly-recap-open.png',
  },
  'iphone-17': {
    dashboardClosed: 'iphone-17-dashboard-closed.png',
    weeklyRecapOpen: 'iphone-17-weekly-recap-open.png',
  },
}
const recapFixture = {
  weekLabel: 'Aug 10 - Aug 16',
  totalMiles: 7.2,
  totalRuns: 2,
  totalMinutes: 83,
  totalCalories: 830,
  avgPace: '11:32',
  longestRun: 4.5,
  bestRun: { date: '2026-08-13', miles: 4.5, pace: '11:10' },
  liftSessions: 1,
  mileageVsLastWeek: -4.3,
  insight: 'Keep Monday easy, then bring full energy to Tuesday’s progression run.',
  is_pro: true,
}

function restExecution() {
  return {
    today: { date: dateISO, day: 'Sun', type: 'rest', rest: true, sessions: [] },
    execution: {
      hasPlan: true,
      hasDay: true,
      isRest: true,
      isPlannedRest: true,
      restSource: 'planned',
      mode: 'run_only',
      phase: 'base',
      week: 1,
      date: dateISO,
      day: 'Sun',
      sessions: [],
      run: null,
      lift: null,
    },
  }
}

function collectRuntimeErrors(page) {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  return errors
}

async function expectNoHorizontalOverflow(page) {
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }))
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport)
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewport)
}

async function captureReceipt(page, testInfo, state, options) {
  const fileName = receiptNames[testInfo.project.name]?.[state]
  expect(fileName, `stable receipt name for ${testInfo.project.name}/${state}`).toBeTruthy()
  await mkdir(receiptDirectory, { recursive: true })
  await page.screenshot({ path: join(receiptDirectory, fileName), ...options })
}

test('rest-day brief and Weekly Recap share one interaction system at mobile widths', async ({ page }, testInfo) => {
  const runtimeErrors = collectRuntimeErrors(page)
  await page.clock.setFixedTime(new Date('2026-08-16T16:00:00.000Z'))
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/today', restExecution()],
      ['GET /api/recap/weekly', recapFixture],
      ['GET /api/recovery/readiness', {
        available: true,
        score: 79,
        band: 'AMBER',
        drivers: ['Recent training load supports a lighter day.'],
      }],
      ['GET /api/races/next', {
        race: { id: 'qa-race', race_name: 'Army Ten-Miler', race_date: '2026-10-11', status: 'upcoming' },
      }],
    ]),
  })

  await page.goto('/')

  const brief = page.locator('[data-signature-coachs-log]')
  await expect(brief).toBeVisible()
  await expect(brief).toHaveClass(/card-hero/)
  await expect(brief.getByText("Coach's daily brief", { exact: true })).toBeVisible()
  await expect(brief.getByRole('heading', { name: 'Rest & recover' })).toBeVisible()
  const briefToggle = brief.locator('.signature-log-toggle')
  await expect(briefToggle).toHaveAccessibleName("Open Coach's daily brief for Rest & recover")
  await expect(briefToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(brief.getByRole('list', { name: 'Rest day reasons' })).toBeHidden()
  await briefToggle.click()
  await expect(briefToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(briefToggle).toHaveAccessibleName("Close Coach's daily brief for Rest & recover")
  await expect(brief.getByText('Why today matters', { exact: true })).toBeVisible()
  const reasons = brief.getByRole('list', { name: 'Rest day reasons' })
  await expect(reasons.getByText('Planned recovery', { exact: true })).toBeVisible()
  await expect(reasons.getByText('Rest and recovery are scheduled today.', { exact: true })).toBeVisible()
  await expect(reasons.getByText('Absorb recent work', { exact: true })).toBeVisible()
  await expect(reasons.getByText('7.2 mi across 2 runs · Aug 10 - Aug 16', { exact: true })).toBeVisible()
  await expect(reasons.getByText('Protect the build', { exact: true })).toBeVisible()
  await expect(reasons.getByText('Army Ten-Miler · Oct 11', { exact: true })).toBeVisible()
  await expect(reasons.getByText(/79/)).toHaveCount(0)

  const recapTeaser = page.locator('[data-dashboard-card-family="recap"]')
  await expect(recapTeaser).toBeVisible()
  await expect(recapTeaser).toHaveClass(/card-hero/)
  await expect(recapTeaser.getByText('7.2 mi · 2 runs · 830 cal', { exact: true })).toBeVisible()
  const recapOpener = recapTeaser.getByRole('button', { name: /Weekly recap.*View recap/i })
  await expect(recapOpener).toHaveAttribute('aria-haspopup', 'dialog')

  await expect(page.getByRole('heading', { name: "Review today's plan" })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'View rest day', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start extra run', exact: true })).toHaveCount(0)
  await expectNoHorizontalOverflow(page)

  expect(apiState.requestsFor('GET', '/api/recap/weekly')).toHaveLength(1)
  await captureReceipt(page, testInfo, 'dashboardClosed', { fullPage: true })

  await recapOpener.click()
  const dialog = page.getByRole('dialog', { name: 'Weekly recap' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toHaveAttribute('aria-modal', 'true')
  const close = dialog.getByRole('button', { name: 'Close weekly recap' })
  await expect(close).toBeFocused()
  await expect(dialog.getByRole('heading', { name: 'Aug 10 - Aug 16' })).toBeVisible()
  await expect(dialog.locator('[data-recap-metric="distance"] dd')).toHaveText('7.2 mi')
  await expect(dialog.locator('[data-recap-metric="runs"] dd')).toHaveText('2')
  await expect(dialog.locator('[data-recap-metric="duration"] dd')).toHaveText('83 min')
  await expect(dialog.locator('[data-recap-metric="calories"] dd')).toHaveText('830 cal')
  await expect(dialog.locator('[data-recap-metric="pace"] dd')).toHaveText('11:32/mi')
  await expect(dialog.getByText('Longest run — 4.5 mi on Aug 13', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Next week' })).toBeVisible()
  await expect(dialog.getByText(recapFixture.insight, { exact: true })).toBeVisible()
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden')
  expect(apiState.requestsFor('GET', '/api/recap/weekly')).toHaveLength(1)

  const dialogLayout = await dialog.evaluate((node) => ({
    left: node.getBoundingClientRect().left,
    right: node.getBoundingClientRect().right,
    top: node.getBoundingClientRect().top,
    bottom: node.getBoundingClientRect().bottom,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  }))
  expect(dialogLayout.left).toBeGreaterThanOrEqual(0)
  expect(dialogLayout.right).toBeLessThanOrEqual(dialogLayout.viewportWidth)
  expect(dialogLayout.top).toBeGreaterThanOrEqual(0)
  expect(dialogLayout.bottom).toBeLessThanOrEqual(dialogLayout.viewportHeight)
  const scrollport = dialog.locator('[data-weekly-recap-scrollport]')
  const scrollLayout = await scrollport.evaluate((node) => ({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }))
  expect(scrollLayout.scrollWidth).toBeLessThanOrEqual(scrollLayout.clientWidth)
  const closeBox = await close.boundingBox()
  expect(closeBox.width).toBeGreaterThanOrEqual(44)
  expect(closeBox.height).toBeGreaterThanOrEqual(44)
  await expectNoHorizontalOverflow(page)
  await captureReceipt(page, testInfo, 'weeklyRecapOpen', { fullPage: false })

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(recapOpener).toBeFocused()
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden')

  await recapOpener.click()
  await dialog.getByRole('button', { name: 'Close weekly recap' }).click()
  await expect(dialog).toHaveCount(0)
  await recapTeaser.getByRole('button', { name: 'Dismiss weekly recap' }).click()
  await expect(recapTeaser).toHaveCount(0)
  await expect(page.getByRole('dialog', { name: 'Weekly recap' })).toHaveCount(0)
  await expect(page).toHaveURL('/')
  const storedDismissal = await page.evaluate(() => Object.keys(localStorage).some((key) => key.startsWith('recap-seen-') && localStorage.getItem(key) === '1'))
  expect(storedDismissal).toBe(true)
  expect(apiState.requestsFor('GET', '/api/recap/weekly')).toHaveLength(1)
  expect([...new Set(apiState.unexpectedRequests)]).toEqual([])
  expect(runtimeErrors).toEqual([])
})
