import { expect, test } from '@playwright/test'
import {
  createQaToken,
  goalBackwardV24PlanFixture,
  installAuthenticatedApi,
  qaResponse,
  signatureUiDashboardFixture,
} from './support/mockApi.mjs'

test.describe.configure({ timeout: 60_000 })

function localDateISO(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 10)
}

function dayLabel(date = new Date()) {
  return date.toLocaleDateString('en-US', { weekday: 'short' })
}

function requestsFor(state, method, pathname) {
  return state.requestsFor(method, pathname)
}

function collectRuntimeErrors(page) {
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  return errors
}

function assertCleanApiAndRuntime(state, errors) {
  expect([...new Set(state.unexpectedRequests)], 'Every journey API request needs an explicit fixture').toEqual([])
  expect(errors, 'Authenticated journeys must not emit page or console errors').toEqual([])
}

async function openAllTechnicalVerificationAndReadBody(page) {
  const summaries = page.locator('summary').filter({ hasText: 'Technical verification' })
  const count = await summaries.count()
  expect(count, 'The journey should expose at least one Technical verification disclosure').toBeGreaterThan(0)
  await summaries.evaluateAll((nodes) => nodes.forEach((summary) => {
    if (summary.parentElement instanceof HTMLDetailsElement) summary.parentElement.open = true
  }))
  expect(await summaries.evaluateAll((nodes) => nodes.every((summary) => summary.parentElement?.open)), 'Every Technical verification disclosure should be open').toBe(true)
  return { count, text: await page.locator('body').innerText() }
}

const today = localDateISO()
const todayDay = dayLabel()
const tomorrowDate = (() => {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  return date
})()
const tomorrow = localDateISO(tomorrowDate)
const tomorrowDay = dayLabel(tomorrowDate)

const plannedRun = {
  id: 'journey-run-session',
  kind: 'run',
  type: 'easy',
  workout_type: 'easy',
  title: 'Easy aerobic run',
  distance_miles: 3.1,
  pace_target: 'Conversational effort',
  target_zone: 'Zone 2',
  completed: false,
}

const plannedLift = {
  id: 'journey-lift-session',
  kind: 'lift',
  type: 'strength',
  title: 'Strength maintenance',
  focus: 'full body',
  warmup: ['Bodyweight squat x 10'],
  main: [
    { name: 'Low Box Jump', sets: 3, reps: '5', rest: '90 sec', cue: 'Land softly with control.' },
    { name: 'Single-Arm Offset Goblet Squat With Front-Foot Elevation', sets: 3, reps: '8 controlled repetitions on each side', rest: '90 sec between every working set', cue: 'Brace before each rep and keep the full foot planted throughout the complete controlled range.' },
    { name: 'Romanian Deadlift', sets: 3, reps: '8', rest: '2 min', load: 'Choose a conservative working load that preserves a close bar path and a controlled hinge for every repetition.', cue: 'Stale generic hinge cue.' },
  ],
  completed: false,
}

function executionWith({ run = plannedRun, lift = null } = {}) {
  const sessions = [run, lift].filter(Boolean)
  return {
    today: { date: today, day: todayDay, type: run ? 'run' : 'strength' },
    execution: {
      hasPlan: true,
      hasDay: true,
      isRest: false,
      mode: lift ? 'hybrid_maintain' : 'run_only',
      phase: 'base',
      week: 1,
      date: today,
      day: todayDay,
      sessions,
      run,
      lift,
    },
  }
}

function restExecution() {
  return {
    today: { date: today, day: todayDay, type: 'rest', rest: true, sessions: [] },
    execution: {
      hasPlan: true,
      hasDay: true,
      isRest: true,
      isPlannedRest: true,
      restSource: 'planned',
      mode: 'run_only',
      phase: 'base',
      week: 1,
      date: today,
      day: todayDay,
      sessions: [],
      run: null,
      lift: null,
    },
  }
}

function minimumEffectiveRecoveryAlternativeExecution() {
  const recoveryGuidance = {
    id: 'token-quality-run',
    kind: 'rest',
    type: 'rest',
    workout_type: 'rest',
    title: 'Rest, easy walking, or mobility',
    description: 'Recent missed-session history supports recovery. The reduced dose would not deliver the intended recovery session, so Forge does not label a token run as productive. Rest or comfortable low-strain movement is the truthful choice.',
    distance_miles: 0,
    completed: false,
    recovery_alternative: {
      policy: 'minimum_effective_recovery_session_v1',
      minimum_run_minutes: 20,
      minimum_run_miles: 1.5,
      reduced_run_minutes: 11,
      reduced_run_miles: 0.8,
      options: [
        { type: 'rest', duration_minutes: 0 },
        { type: 'walking', duration_range_minutes: [20, 30] },
        { type: 'mobility', duration_range_minutes: [5, 10] },
      ],
    },
  }
  return {
    today: { date: today, day: todayDay, type: 'rest', rest: true, sessions: [] },
    execution: {
      hasPlan: true,
      hasDay: true,
      isRest: true,
      isPlannedRest: true,
      restSource: 'planned',
      mode: 'run_only',
      phase: 'build',
      week: 1,
      date: today,
      day: todayDay,
      sessions: [],
      run: null,
      lift: null,
      recoveryGuidance,
    },
  }
}

function checkinRecoveryExecution() {
  const recoveryRun = {
    ...plannedRun,
    type: 'rest',
    workout_type: 'rest',
    title: 'Rest day',
    distance_miles: 0,
    target_zone: null,
    description: "Rest day from today's check-in.",
    steps: [],
    checkin_override: { action: 'rest', label: 'Changed to rest from daily check-in' },
  }
  return {
    today: { date: today, day: todayDay, type: 'rest', sessions: [recoveryRun] },
    execution: {
      hasPlan: true,
      hasDay: true,
      isRest: false,
      isPlannedRest: false,
      restSource: null,
      mode: 'run_only',
      phase: 'base',
      week: 1,
      date: today,
      day: todayDay,
      sessions: [recoveryRun],
      run: recoveryRun,
      lift: null,
    },
  }
}

function legacyCheckinRecoveryExecution() {
  return {
    today: {
      date: today,
      day: todayDay,
      type: 'rest',
      workout_type: 'rest',
      description: "Recovery is today's guidance.",
      checkin_override: { action: 'rest', label: 'Changed to rest from daily check-in' },
    },
    execution: {
      hasPlan: true,
      hasDay: true,
      isRest: true,
      isPlannedRest: false,
      restSource: null,
      mode: 'hybrid_maintain',
      phase: 'base',
      week: 1,
      date: today,
      day: todayDay,
      type: 'rest',
      workout_type: 'rest',
      checkinOverride: { action: 'rest', label: 'Changed to rest from daily check-in' },
      sessions: [],
      run: null,
      lift: null,
    },
  }
}

function legacyRemovedExecution() {
  return {
    today: {
      date: today,
      day: todayDay,
      type: 'rest',
      workout_type: 'rest',
      status: 'removed',
      sessions: [],
    },
    execution: {
      hasPlan: true,
      hasDay: true,
      isRest: true,
      isPlannedRest: false,
      restSource: 'removed',
      mode: 'hybrid_maintain',
      phase: 'base',
      week: 1,
      date: today,
      day: todayDay,
      type: 'rest',
      workout_type: 'rest',
      status: 'removed',
      checkinOverride: null,
      sessions: [],
      run: null,
      lift: null,
    },
  }
}

function liftOnlyCheckinRecoveryExecution({ patchSession = true } = {}) {
  const recoveryLift = patchSession
    ? {
        ...plannedLift,
        type: 'rest',
        workout_type: 'rest',
        title: 'Rest day',
        description: "Rest day from today's check-in.",
        checkin_override: { action: 'rest', label: 'Changed to rest from daily check-in' },
      }
    : { ...plannedLift }
  return {
    today: {
      date: today,
      day: todayDay,
      type: 'rest',
      workout_type: 'rest',
      checkin_override: { action: 'rest', label: 'Changed to rest from daily check-in' },
      sessions: [recoveryLift],
    },
    execution: {
      hasPlan: true,
      hasDay: true,
      isRest: false,
      isPlannedRest: false,
      restSource: null,
      mode: 'hybrid_maintain',
      phase: 'base',
      week: 1,
      date: today,
      day: todayDay,
      type: 'rest',
      workout_type: 'rest',
      checkinOverride: { action: 'rest', label: 'Changed to rest from daily check-in' },
      sessions: [recoveryLift],
      run: null,
      lift: recoveryLift,
    },
  }
}

function activePlanWithTodaySessions(sessions, { completedSessionIds = [], additionalDays = [] } = {}) {
  return {
    plan: {
      id: 'journey-current-day-plan',
      name: 'Current day safety plan',
      type: 'hybrid_maintain',
      weeks: 1,
      plan_data: {
        schemaVersion: 2,
        planMode: 'hybrid_maintain',
        weeks: [{
          week: 1,
          phase: 'base',
          startDate: today,
          days: [{ date: today, day: todayDay, sessions }, ...additionalDays],
        }],
      },
    },
    user_plan: {
      current_week: 1,
      started_at: today,
      progress: { completedSessionIds },
    },
  }
}

async function assertSignatureResponsive(page, expectedViewport) {
  expect(page.viewportSize()).toEqual(expectedViewport)
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }))
  expect(layout.viewport).toBe(expectedViewport.width)
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport)
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewport)

  const nav = page.locator('nav.fixed')
  const navBox = await nav.boundingBox()
  expect(navBox).not.toBeNull()
  expect(navBox.y).toBeGreaterThanOrEqual(0)
  expect(navBox.y + navBox.height).toBeLessThanOrEqual(expectedViewport.height)

  const signatureControls = page.locator('.signature-dashboard-stack button:visible')
  const controlCount = await signatureControls.count()
  for (let index = 0; index < controlCount; index += 1) {
    const control = signatureControls.nth(index)
    await control.evaluate((node) => node.scrollIntoView({ block: 'center' }))
    const [controlBox, currentNavBox] = await Promise.all([control.boundingBox(), nav.boundingBox()])
    expect(controlBox?.width || 0).toBeGreaterThanOrEqual(44)
    expect(controlBox?.height || 0).toBeGreaterThanOrEqual(44)
    expect(controlBox.y + controlBox.height).toBeLessThanOrEqual(currentNavBox.y)
  }
}

async function assertReadinessOverlayResponsive(page, dialog, expectedViewport) {
  await dialog.evaluate(async (node) => {
    await Promise.all(node.getAnimations().map((animation) => animation.finished))
  })

  expect(page.viewportSize()).toEqual(expectedViewport)
  const layout = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }))
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewport)
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewport)

  const dialogMetrics = await dialog.evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
  }))
  expect(dialogMetrics.scrollWidth).toBeLessThanOrEqual(dialogMetrics.clientWidth)

  const dialogBox = await dialog.boundingBox()
  expect(dialogBox).not.toBeNull()
  expect(dialogBox.x).toBeGreaterThanOrEqual(0)
  expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(expectedViewport.width)
  expect(dialogBox.y).toBeGreaterThanOrEqual(0)
  expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(expectedViewport.height)

  const close = dialog.getByRole('button', { name: 'Close', exact: true })
  const closeBox = await close.boundingBox()
  expect(closeBox).not.toBeNull()
  expect(closeBox.width).toBeGreaterThanOrEqual(44)
  expect(closeBox.height).toBeGreaterThanOrEqual(44)
  expect(closeBox.y).toBeGreaterThanOrEqual(0)
  expect(closeBox.y + closeBox.height).toBeLessThanOrEqual(expectedViewport.height)

  if (dialogMetrics.scrollHeight > dialogMetrics.clientHeight) {
    await dialog.evaluate((node) => node.scrollTo({ top: node.scrollHeight }))
    await expect.poll(() => dialog.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
    await expect(close).toBeVisible()
    const scrolledCloseBox = await close.boundingBox()
    expect(scrolledCloseBox.y).toBeGreaterThanOrEqual(0)
    expect(scrolledCloseBox.y + scrolledCloseBox.height).toBeLessThanOrEqual(expectedViewport.height)
  }
}

async function waitForReadinessDialogEntered(page, dialog) {
  await expect(dialog).toBeVisible()
  await expect(page).toHaveURL('/')
  await dialog.evaluate(async (node) => {
    const overlay = node.closest('[data-readiness-overlay]')
    const animations = [...(overlay?.getAnimations() || []), ...node.getAnimations()]
    await Promise.all(animations.map((animation) => animation.finished))
  })
}

test('Signature UI opens canonical readiness on demand and keeps Coach\'s Daily Brief first on both mobile projects', async ({ page }, testInfo) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const fixture = signatureUiDashboardFixture({ dateISO: today, day: todayDay })
  const fixtureBeforePresentation = structuredClone(fixture)
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/recovery/readiness', fixture.readiness],
      ['GET /api/plans/today', fixture.today],
      ['GET /api/runs/next-recommendation', fixture.recommendation],
    ]),
  })

  await page.goto('/')
  const coachsLog = page.locator('[data-signature-coachs-log]')
  const headerReadiness = page.getByRole('button', { name: `Open recovery readiness, score ${fixture.readiness.score}` })
  await expect(page.locator('[data-signature-readiness]')).toHaveCount(0)
  await expect(coachsLog).toBeVisible()
  await expect(coachsLog.getByText("Coach's daily brief", { exact: true })).toBeVisible()
  await expect(page.locator('.signature-dashboard-stack > :first-child[data-signature-coachs-log]')).toHaveCount(1)
  await expect(coachsLog.getByRole('heading', { name: 'Controlled progression run' })).toBeVisible()
  await expect(coachsLog.locator('[data-mission-fact="duration"] dd')).toHaveText('38 min')
  await expect(coachsLog.locator('[data-mission-fact="distance"] dd')).toHaveText('4.25 mi')
  await expect(coachsLog.locator('[data-mission-fact="effort"] dd')).toHaveText('Controlled aerobic')
  await expect(coachsLog.locator('[data-mission-fact="pace"] dd')).toHaveText('9:15-9:45 /mi')
  await expect(coachsLog.locator('[data-mission-fact="zone"] dd')).toHaveText('Zone 2 · 132-146 bpm')
  await expect(coachsLog.getByText('9.9 mi', { exact: true })).toHaveCount(0)
  await expect(headerReadiness).toBeVisible()
  await expect(headerReadiness).toHaveAccessibleName(`Open recovery readiness, score ${fixture.readiness.score}`)

  const readinessRequestsBeforeOpen = requestsFor(apiState, 'GET', '/api/recovery/readiness').length
  expect(readinessRequestsBeforeOpen, 'Header chip plus Dashboard retain their two existing readiness requests').toBe(2)
  const rationaleToggle = coachsLog.getByRole('button', { name: 'Why today matters' })
  await expect(rationaleToggle).toHaveAttribute('aria-expanded', 'false')

  await page.evaluate(() => window.scrollTo(0, 0))
  await testInfo.attach(`signature-${testInfo.project.name}-dashboard-initial`, {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  })

  await headerReadiness.click()
  const readinessDialog = page.getByRole('dialog', { name: 'Daily readiness details' })
  await waitForReadinessDialogEntered(page, readinessDialog)
  await expect(readinessDialog).toHaveAttribute('aria-modal', 'true')
  await expect(page.getByRole('dialog')).toHaveCount(1)
  const readiness = readinessDialog.getByRole('region', { name: 'Recovery readiness' })
  await expect(page.locator('[data-signature-readiness]')).toHaveCount(1)
  await expect(readiness).toHaveAttribute('data-signature-readiness', 'loaded')
  await expect(readiness.locator('[data-readiness-score]')).toHaveText(String(fixture.readiness.score))
  await expect(readiness.locator('[data-readiness-band]')).toHaveText('Amber')
  await expect(readiness.getByText(fixture.readiness.verdict, { exact: true })).toBeVisible()
  for (const driver of fixture.readiness.drivers) {
    await expect(readiness.getByText(driver, { exact: true })).toBeVisible()
  }
  await expect(readiness.locator('.signature-arc')).toHaveAttribute('aria-hidden', 'true')
  await expect(readiness.locator('button')).toHaveCount(0)
  const readinessRequestsAfterOpenRoute = requestsFor(apiState, 'GET', '/api/recovery/readiness').length
  expect(readinessRequestsAfterOpenRoute, 'Opening readiness reuses the loaded Dashboard and header truth').toBe(readinessRequestsBeforeOpen)

  const close = readinessDialog.getByRole('button', { name: 'Close', exact: true })
  await expect(close).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(close).toBeFocused()
  const closeFocusStyle = await close.evaluate((node) => {
    const style = getComputedStyle(node)
    return { style: style.outlineStyle, width: style.outlineWidth }
  })
  expect(closeFocusStyle.style).not.toBe('none')
  expect(Number.parseFloat(closeFocusStyle.width)).toBeGreaterThanOrEqual(3)

  await page.emulateMedia({ reducedMotion: 'reduce' })
  const arcMotion = await readiness.locator('.signature-arc-progress').evaluate((node) => {
    const style = getComputedStyle(node)
    return { animation: style.animationName, transition: style.transitionDuration }
  })
  expect(arcMotion).toEqual({ animation: 'none', transition: '0s' })

  await testInfo.attach(`signature-${testInfo.project.name}-readiness-opened`, {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  })
  await assertReadinessOverlayResponsive(page, readinessDialog, testInfo.project.use.viewport)
  await testInfo.attach(`signature-${testInfo.project.name}-readiness-max-scroll`, {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  })

  const openedBody = await page.locator('body').innerText()
  expect(openedBody, 'Opened Signature UI copy contains no underscore symbol').not.toContain('_')
  expect(openedBody, 'Opened Signature UI copy contains no raw closed enum token').not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/)
  expect(openedBody, 'Opened Signature UI copy contains no raw hash').not.toMatch(/\b(?:sha256:)?[a-f0-9]{32,}\b/i)

  await close.click()
  await expect(readinessDialog).toHaveCount(0)
  await expect(page.locator('[data-signature-readiness]')).toHaveCount(0)
  await expect(coachsLog).toBeVisible()
  await expect(headerReadiness).toBeFocused()
  expect(requestsFor(apiState, 'GET', '/api/recovery/readiness')).toHaveLength(readinessRequestsAfterOpenRoute)

  await headerReadiness.click()
  await waitForReadinessDialogEntered(page, readinessDialog)
  const readinessRequestsAfterBackdropRoute = requestsFor(apiState, 'GET', '/api/recovery/readiness').length
  expect(readinessRequestsAfterBackdropRoute, 'Reopening readiness reuses the loaded Dashboard and header truth').toBe(readinessRequestsBeforeOpen)
  await page.locator('[data-readiness-overlay]').click({ position: { x: 4, y: 4 } })
  await expect(readinessDialog).toHaveCount(0)
  await expect(page.locator('[data-signature-readiness]')).toHaveCount(0)
  expect(requestsFor(apiState, 'GET', '/api/recovery/readiness')).toHaveLength(readinessRequestsAfterBackdropRoute)

  await rationaleToggle.click()
  await expect(rationaleToggle).toHaveAttribute('aria-expanded', 'true')
  await expect(coachsLog.getByText('Build aerobic control before the next quality session.', { exact: true })).toBeVisible()
  await assertSignatureResponsive(page, testInfo.project.use.viewport)
  const planRequests = requestsFor(apiState, 'GET', '/api/plans/today')
  expect(planRequests).toHaveLength(2)
  expect(planRequests.map((request) => request.search.date).sort()).toEqual([today, tomorrow].sort())

  expect(fixture).toEqual(fixtureBeforePresentation)
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('Signature UI truthfully covers loading, locked, unavailable, and error states on demand', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  let readinessMode = 'locked'
  let releaseReadiness
  let gatePending = true
  const readinessGate = new Promise((resolve) => { releaseReadiness = resolve })
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/recovery/readiness', async () => {
        if (gatePending) await readinessGate
        if (readinessMode === 'locked') return qaResponse({ error: 'Upgrade required' }, 402)
        if (readinessMode === 'error') return qaResponse({ error: 'Readiness unavailable' }, 500)
        return { available: false }
      }],
    ]),
  })

  await page.goto('/')
  await expect(page.locator('[data-signature-readiness]')).toHaveCount(0)
  const headerReadiness = page.getByRole('button', { name: 'Open recovery readiness', exact: true })
  await expect(headerReadiness).toBeVisible()
  await headerReadiness.click()
  const readinessDialog = page.getByRole('dialog', { name: 'Daily readiness details' })
  const readiness = readinessDialog.getByRole('region', { name: 'Recovery readiness' })
  await waitForReadinessDialogEntered(page, readinessDialog)
  await expect(readiness).toHaveAttribute('data-signature-readiness', 'loading')
  await expect(readiness).toHaveAttribute('aria-busy', 'true')

  gatePending = false
  releaseReadiness()
  await expect(readiness).toHaveAttribute('data-signature-readiness', 'locked')
  await expect(readiness.getByText('Upgrade to Forged Hybrid Pro to unlock today\'s readiness score.', { exact: true })).toBeVisible()
  await expect(readiness.locator('.signature-arc')).toHaveCount(0)
  await expect(readiness.locator('[data-readiness-score]')).toHaveCount(0)
  await expect(page.locator('[data-signature-coachs-log]')).toHaveCount(0)
  const lockedReadinessRequests = requestsFor(apiState, 'GET', '/api/recovery/readiness').length
  await readinessDialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.locator('[data-signature-readiness]')).toHaveCount(0)
  expect(requestsFor(apiState, 'GET', '/api/recovery/readiness')).toHaveLength(lockedReadinessRequests)

  readinessMode = 'unavailable'
  await page.reload()
  await expect(page.locator('[data-signature-readiness]')).toHaveCount(0)
  await headerReadiness.click()
  await waitForReadinessDialogEntered(page, readinessDialog)
  await expect(readiness).toHaveAttribute('data-signature-readiness', 'unavailable')
  await expect(readiness.getByText('Sync Health data to unlock today\'s readiness score.', { exact: true })).toBeVisible()
  await expect(readiness.locator('.signature-arc')).toHaveCount(0)
  await expect(readiness.locator('[data-readiness-score]')).toHaveCount(0)
  await expect(page.locator('[data-signature-coachs-log]')).toHaveCount(0)

  await readinessDialog.getByRole('button', { name: 'Close', exact: true }).click()
  readinessMode = 'error'
  await page.reload()
  await expect(page.locator('[data-signature-readiness]')).toHaveCount(0)
  await headerReadiness.click()
  await waitForReadinessDialogEntered(page, readinessDialog)
  await expect(readiness).toHaveAttribute('data-signature-readiness', 'error')
  await expect(readiness.getByText("Couldn't load recovery readiness.", { exact: true })).toBeVisible()
  await expect(readiness.locator('.signature-arc')).toHaveCount(0)
  await expect(readiness.locator('[data-readiness-score]')).toHaveCount(0)

  expect(requestsFor(apiState, 'GET', '/api/recovery/readiness').length).toBeGreaterThanOrEqual(6)
  const expectedLockedResourceError = 'Failed to load resource: the server responded with a status of 402 (Payment Required)'
  expect(runtimeErrors.filter((error) => error === expectedLockedResourceError).length).toBeGreaterThanOrEqual(2)
  expect(runtimeErrors.some((error) => error.includes('500 (Internal Server Error)'))).toBe(true)
  const unexpectedRuntimeErrors = runtimeErrors.filter((error) => (
    error !== expectedLockedResourceError
    && !error.includes('500 (Internal Server Error)')
    && !error.startsWith('[header/readiness] load failed:')
  ))
  assertCleanApiAndRuntime(apiState, unexpectedRuntimeErrors)
})

test('planned rest day remains accepted while an optional extra run starts without a routine check-in', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/today', restExecution()],
    ]),
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: "Review today's plan" })).toBeVisible()
  await expect(page.getByText('Rest and recovery are scheduled today. Recovery is the accepted plan unless you choose to train.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Check in', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'View rest day', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start extra run', exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'View rest day', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Recovery is the plan today' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Check in', exact: true })).toHaveCount(0)
  await page.getByText('Recovery tools', { exact: true }).click()
  await expect(page.getByRole('button', { name: 'Warm-up', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start extra run', exact: true }).last()).toBeVisible()
  await page.getByRole('button', { name: 'Close', exact: true }).click()

  await page.getByRole('button', { name: 'Start extra run', exact: true }).click()
  await expect(page).toHaveURL(/\/log-run\?tab=manual&intent=rest-day/)
  await expect(page.getByRole('heading', { name: 'Why are you running?' })).toBeVisible()
  await expect(page.getByText('No missed run is available in this training week.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Go to Check-In' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Start extra run', exact: true }).click()
  await expect(page).toHaveURL(/\/warmup$/)
  await expect(page.getByText('Morning Check-In Required', { exact: true })).toHaveCount(0)

  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('unscheduled rest guidance stays passive and never claims scheduled rest', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/today', { today: null, execution: { hasPlan: false, hasDay: false, date: today } }],
      ['GET /api/runs/next-recommendation', {
        recommendationType: 'rest',
        type: 'rest',
        reason: 'Rest is recommended from recent training.',
      }],
      ['GET /api/runs', [{
        id: 'unscheduled-rest-run',
        type: 'easy',
        date: today,
        distance_miles: 3,
        duration_seconds: 1800,
      }]],
    ]),
  })

  await page.goto('/')
  await expect(page.getByRole('button', { name: 'View recovery', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Check in', exact: true })).toHaveCount(0)
  await expect(page.getByText('An extra run is already logged today. Recovery is still the guidance for today.', { exact: true })).toBeVisible()
  await expect(page.getByText(/Rest and recovery are scheduled today/)).toHaveCount(0)
  await page.getByRole('button', { name: 'View recovery', exact: true }).click()
  await expect(page.getByRole('button', { name: /^(Start run|Start lift|Start workout|Start\/log)$/i })).toHaveCount(0)

  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('minimum-effective recovery guidance shows the reviewed rest, walk, or mobility choice without a token run', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/today', minimumEffectiveRecoveryAlternativeExecution()],
    ]),
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Rest & recover', exact: true })).toBeVisible()
  await expect(page.getByText(/Rest, easy walking, or mobility.*reduced dose would not deliver the intended recovery session/i)).toBeVisible()
  await expect(page.getByText(/missed-session history supports recovery/i)).toBeVisible()
  await expect(page.getByText(/0\.8\s*mi|11\s*min/i)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(Start run|Start lift|Start workout|Start\/log)$/i })).toHaveCount(0)

  await page.getByRole('button', { name: 'View rest day', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Recovery is the plan today', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^(Start run|Start lift|Start workout|Start\/log)$/i })).toHaveCount(0)
  expect(requestsFor(apiState, 'POST', '/api/checkin')).toHaveLength(0)
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('legacy check-in recovery remains guidance and never offers the rest-labelled run', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/today', checkinRecoveryExecution()],
      ['GET /api/checkin/today', {
        feeling: 1,
        sleep_hours: 3,
        life_flags: ['sick'],
      }],
      ['GET /api/runs', [{
        id: 'checkin-recovery-recorded-run',
        type: 'easy',
        date: today,
        distance_miles: 3,
        duration_seconds: 1800,
      }]],
    ]),
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: "Recovery is today's guidance" })).toBeVisible()
  await expect(page.getByText('An extra run is already logged today. Recovery is still the guidance for today.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'View recovery', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'View recovery', exact: true }).click()
  await expect(page.getByRole('heading', { name: "Recovery is today's guidance" }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start run', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start lift', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start workout', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start/log', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Map route', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Warm-up', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(Check in|Edit check-in)$/i })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Recovery is the plan today' })).toHaveCount(0)
  expect(requestsFor(apiState, 'POST', '/api/checkin')).toHaveLength(0)

  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('legacy empty rest payload stays truthful and closes every workout handoff', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/my', activePlanWithTodaySessions([plannedRun, plannedLift])],
      ['GET /api/plans/today', legacyCheckinRecoveryExecution()],
      ['GET /api/checkin/today', {
        feeling: 2,
        legs: 2,
        drive: 2,
        life_flags: ['traveling'],
      }],
      ['GET /api/recovery/readiness', { available: true, score: 42, band: 'RED' }],
      ['GET /api/injury/active', { injuries: [], safetyUnavailable: false }],
      ['POST /api/travel-context', { status: 'away', confidence: 'high', distanceBand: 'over_150_miles' }],
      ['POST /api/plans/today/bodyweight-alternative', { alternative: plannedLift }],
    ]),
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: "Recovery is today's guidance", exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'View recovery', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^(Check in|Edit check-in)$/i })).toHaveCount(0)
  await expect(page.getByText("Today's plan is not ready", { exact: true })).toHaveCount(0)
  await expect(page.getByText('No workout is available yet. Review your check-in or open the calendar.', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'View recovery', exact: true }).click()
  await expect(page.getByRole('heading', { name: "Recovery is today's guidance", exact: true }).last()).toBeVisible()

  const forbiddenButtons = [
    /^Start run$/i,
    /^Start lift$/i,
    /^Start workout$/i,
    /^Start HYROX/i,
    /^Warm-up$/i,
    /^Map route$/i,
    /Export watch workout/i,
    /Send to Watch/i,
    /Copy workout/i,
    /^Mark done$/i,
    /^Done$/i,
    /Remove workout/i,
    /Runner strength — no equipment/i,
    /^(Check in|Edit check-in)$/i,
  ]
  for (const name of forbiddenButtons) {
    await expect(page.getByRole('button', { name })).toHaveCount(0)
  }
  expect(requestsFor(apiState, 'POST', '/api/travel-context')).toHaveLength(0)
  expect(requestsFor(apiState, 'POST', '/api/plans/today/bodyweight-alternative')).toHaveLength(0)
  await expect(page).not.toHaveURL(/\/log-lift(?:\?|$)/)

  await page.goto('/plan')
  await page.locator('.forged-mission-card').click()
  await expect(page.getByRole('heading', { name: "Rest day from today's check-in", exact: true })).toBeVisible()
  await expect(page.getByText('Changed to rest from daily check-in', { exact: true })).toBeVisible()
  for (const name of forbiddenButtons) {
    await expect(page.getByRole('button', { name })).toHaveCount(0)
  }
  await expect(page).not.toHaveURL(/\/log-lift(?:\?|$)/)
  expect(requestsFor(apiState, 'POST', '/api/checkin')).toHaveLength(0)
  expect([320, 402]).toContain(page.viewportSize()?.width)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth))
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('legacy flat all-removed day stays removed without check-in recovery attribution', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/my', activePlanWithTodaySessions([])],
      ['GET /api/plans/today', legacyRemovedExecution()],
      ['GET /api/checkin/today', { feeling: 3, legs: 3, drive: 3 }],
      ['GET /api/recovery/readiness', { available: true, score: 70, band: 'GREEN' }],
      ['GET /api/injury/active', { injuries: [], safetyUnavailable: false }],
    ]),
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'No workout remains today', exact: true })).toBeVisible()
  await expect(page.getByText("The scheduled workout was removed from today's plan.", { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^(Check in|Edit check-in)$/i })).toHaveCount(0)
  await expect(page.getByText("Recovery is today's guidance", { exact: false })).toHaveCount(0)
  await expect(page.getByText('Your check-in changed today to recovery', { exact: false })).toHaveCount(0)
  await expect(page.getByText('Changed to rest from daily check-in', { exact: false })).toHaveCount(0)

  const forbiddenButtons = [
    /^Start run$/i,
    /^Start lift$/i,
    /^Start workout$/i,
    /^Start HYROX/i,
    /^Warm-up$/i,
    /^Map route$/i,
    /Export watch workout/i,
    /Send to Watch/i,
    /Copy workout/i,
    /^Mark done$/i,
    /^Done$/i,
    /Remove workout/i,
    /Runner strength — no equipment/i,
    /^(Check in|Edit check-in)$/i,
  ]
  for (const name of forbiddenButtons) {
    await expect(page.getByRole('button', { name })).toHaveCount(0)
  }
  await expect(page).not.toHaveURL(/\/log-lift(?:\?|$)/)

  await page.goto('/plan')
  await page.locator('.forged-mission-card').click()
  await expect(page.getByText('Changed to rest from daily check-in', { exact: false })).toHaveCount(0)
  for (const name of forbiddenButtons) {
    await expect(page.getByRole('button', { name })).toHaveCount(0)
  }
  await expect(page).not.toHaveURL(/\/log-lift(?:\?|$)/)
  expect(requestsFor(apiState, 'POST', '/api/checkin')).toHaveLength(0)
  expect([320, 402]).toContain(page.viewportSize()?.width)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth))
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('passive safety authority cannot turn a rest-labelled run slot into an executable run', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/today', checkinRecoveryExecution()],
    ]),
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: "Review today's plan", exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'View recovery', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^(Check in|Prepare to Run|Start Warm-Up|Skip, start the run)$/i })).toHaveCount(0)
  await page.getByRole('button', { name: 'View recovery', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start run', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start lift', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Map route', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^(Check in|Edit check-in)$/i })).toHaveCount(0)

  expect(requestsFor(apiState, 'POST', '/api/checkin')).toHaveLength(0)
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('lift-only safety rest cannot expose strength or workout starts even with a stale lift payload', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      // Deliberately retain a stale strength session while the canonical day
      // directive says rest. The phone must fail closed independently.
      ['GET /api/plans/today', liftOnlyCheckinRecoveryExecution({ patchSession: false })],
      ['GET /api/plans/my', activePlanWithTodaySessions([plannedLift])],
    ]),
  })

  await page.goto('/')
  await expect(page.getByRole('button', { name: 'View recovery', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review Strength Workout', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start workout', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start lift', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'View recovery', exact: true }).click()
  await expect(page).not.toHaveURL(/\/log-lift/)
  await expect(page.getByRole('button', { name: 'Start workout', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start lift', exact: true })).toHaveCount(0)

  // The Train surface routes rest to Plan for explanation. Plan must consume
  // the same canonical /plans/today safety authority instead of resurrecting
  // the retained lift from /plans/my.
  await page.goto('/plan')
  await page.locator('.forged-mission-card').click()
  await expect(page.getByRole('heading', { name: "Rest day from today's check-in", exact: true })).toBeVisible()
  await expect(page.getByText('Changed to rest from daily check-in', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start Lift', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start Run', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start a run', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Export watch workout/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Copy workout/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Send to Watch/i })).toHaveCount(0)
  await expect(page).not.toHaveURL(/\/log-lift(?:\?|$)/)
  expect([320, 402]).toContain(page.viewportSize()?.width)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth))

  expect(requestsFor(apiState, 'POST', '/api/checkin')).toHaveLength(0)
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('lift-only safety rest cannot offer a travel bodyweight handoff', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  await page.context().grantPermissions(['geolocation'])
  await page.context().setGeolocation({ latitude: 41.8781, longitude: -87.6298 })
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/my', activePlanWithTodaySessions([plannedLift])],
      ['GET /api/plans/today', liftOnlyCheckinRecoveryExecution()],
      ['GET /api/checkin/today', { life_flags: ['traveling'], sleep_hours: 7 }],
      ['GET /api/recovery/readiness', { available: true, score: 72, band: 'GREEN' }],
      ['GET /api/injury/active', { injuries: [], safetyUnavailable: false }],
      ['POST /api/travel-context', { status: 'away', confidence: 'high', distanceBand: 'over_150_miles' }],
      ['POST /api/plans/today/bodyweight-alternative', { alternative: plannedLift }],
    ]),
  })

  await page.goto('/plan')
  await page.waitForLoadState('networkidle')
  await expect(page.getByRole('button', { name: /Runner strength — no equipment/i })).toHaveCount(0)
  expect(requestsFor(apiState, 'POST', '/api/travel-context')).toHaveLength(0)
  expect(requestsFor(apiState, 'POST', '/api/plans/today/bodyweight-alternative')).toHaveLength(0)
  expect(new URL(page.url()).pathname).not.toBe('/log-lift')
  expect([320, 402]).toContain(page.viewportSize()?.width)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth))
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('ordinary traveling lift keeps its owner-bound bodyweight handoff', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  await page.context().grantPermissions(['geolocation'])
  await page.context().setGeolocation({ latitude: 41.8781, longitude: -87.6298 })
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/my', activePlanWithTodaySessions([plannedLift])],
      ['GET /api/plans/today', executionWith({ run: null, lift: plannedLift })],
      ['GET /api/checkin/today', { life_flags: ['traveling'], sleep_hours: 7 }],
      ['GET /api/recovery/readiness', { available: true, score: 72, band: 'GREEN' }],
      ['GET /api/injury/active', { injuries: [], safetyUnavailable: false }],
      ['POST /api/travel-context', { status: 'away', confidence: 'high', distanceBand: 'over_150_miles' }],
      ['POST /api/plans/today/bodyweight-alternative', {
        alternative: { ...plannedLift, adjustedForTravel: true, equipment: ['bodyweight'] },
      }],
    ]),
  })

  await page.goto('/plan')
  const bodyweight = page.getByRole('button', { name: /Runner strength — no equipment/i })
  await expect(bodyweight).toBeVisible()
  await bodyweight.click()
  await expect.poll(() => requestsFor(apiState, 'POST', '/api/plans/today/bodyweight-alternative').length).toBe(1)
  expect(requestsFor(apiState, 'POST', '/api/plans/today/bodyweight-alternative')[0].body).toEqual({
    date: today,
    session_id: plannedLift.id,
  })
  await expect(page).toHaveURL(/\/log-lift$/)
  expect([320, 402]).toContain(page.viewportSize()?.width)
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('completed current-day session stays recognized and reversible without reopening start or export actions', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const completedRun = { ...plannedRun, completed: true }
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/my', activePlanWithTodaySessions([plannedRun], { completedSessionIds: [plannedRun.id] })],
      ['GET /api/plans/today', executionWith({ run: completedRun })],
      ['PUT /api/plans/my/progress', { ok: true }],
    ]),
  })

  await page.goto('/plan')
  await page.locator('.forged-mission-card').click()
  await expect(page.getByText("Today's plan changed.", { exact: false })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start Run', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Export watch workout/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Copy workout/i })).toHaveCount(0)
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await expect.poll(() => requestsFor(apiState, 'PUT', '/api/plans/my/progress').length).toBe(1)
  expect(requestsFor(apiState, 'PUT', '/api/plans/my/progress')[0].body).toMatchObject({ unset_session_id: plannedRun.id })
  expect([320, 402]).toContain(page.viewportSize()?.width)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth))
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('partially completed hybrid day keeps the completed run reversible and the pending lift actionable', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const completedRun = { ...plannedRun, completed: true }
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/my', activePlanWithTodaySessions([plannedRun, plannedLift], { completedSessionIds: [plannedRun.id] })],
      ['GET /api/plans/today', executionWith({ run: completedRun, lift: plannedLift })],
    ]),
  })

  await page.goto('/plan')
  await page.locator('.forged-mission-card').click()
  await expect(page.getByText("Today's plan changed.", { exact: false })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start Run', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start Lift', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Mark done', exact: true })).toBeVisible()
  expect([320, 402]).toContain(page.viewportSize()?.width)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth))
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('future plan actions stay available while the phone-local current day is canonical rest', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const futureRun = { ...plannedRun, id: 'journey-future-run', title: 'Future easy run' }
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/my', activePlanWithTodaySessions([], {
        additionalDays: [{ date: tomorrow, day: tomorrowDay, sessions: [futureRun] }],
      })],
      ['GET /api/plans/today', restExecution()],
    ]),
  })

  await page.goto('/plan')
  await page.getByRole('button', { name: new RegExp(`^${tomorrowDay} ${tomorrowDate.getDate()} `) }).click()
  await expect(page.getByRole('button', { name: 'Start Run', exact: true })).toBeVisible()
  await expect(page.getByText("Today's plan changed.", { exact: false })).toHaveCount(0)
  await expect(page.getByText("Today's safety status could not be verified.", { exact: false })).toHaveCount(0)
  expect([320, 402]).toContain(page.viewportSize()?.width)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth))
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('mismatched-date execution authority fails closed after phone-local midnight', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const staleExecution = executionWith()
  staleExecution.execution.date = tomorrow
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/my', activePlanWithTodaySessions([plannedRun])],
      ['GET /api/plans/today', staleExecution],
    ]),
  })

  await page.goto('/plan')
  await page.locator('.forged-mission-card').click()
  await expect(page.getByText("Today's safety status could not be verified.", { exact: false })).toBeVisible()
  await expect(page.getByText("Today's plan changed.", { exact: false })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start Run', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Mark done', exact: true })).toHaveCount(0)
  expect([320, 402]).toContain(page.viewportSize()?.width)
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('onboarding persists the athlete profile and generates one plan', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const onboardedToken = createQaToken({ onboarded: true })
  let profilePayload = null
  const apiState = await installAuthenticatedApi(page, {
    user: { onboarded: false },
    token: createQaToken({ onboarded: false }),
    responses: new Map([
      ['PUT /api/auth/me/profile', (request) => {
        profilePayload = request.body
        return { token: onboardedToken }
      }],
      ['POST /api/plans/generate', { plan: { id: 'generated-plan' } }],
    ]),
  })

  await page.goto('/onboarding')
  await page.getByPlaceholder('Age').fill('37')
  await page.getByPlaceholder('Weight (lbs)').fill('205')
  for (let step = 1; step < 9; step += 1) await page.getByRole('button', { name: 'Next', exact: true }).click()
  const completionNavigationRequests = []
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      completionNavigationRequests.push(new URL(request.url()).pathname)
    }
  })
  await page.getByRole('button', { name: 'Finish', exact: true }).click()

  await expect(page).toHaveURL(/\/$/)
  await expect(page.getByRole('button', { name: 'Go Home' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('forge_token'))).toBe(onboardedToken)
  expect(completionNavigationRequests).toEqual(['/'])
  expect(profilePayload).toMatchObject({
    age: 37,
    weight_lbs: 205,
    schedule_type: 'adaptive',
    missed_workout_pref: 'adjust_week',
  })
  expect(requestsFor(apiState, 'PUT', '/api/auth/me/profile')).toHaveLength(1)
  expect(requestsFor(apiState, 'POST', '/api/plans/generate')).toHaveLength(1)
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('accepted plan hands off through warm-up and run save into a durable passive recap', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  let savedRun = null
  const apiState = await installAuthenticatedApi(page, {
    user: { sex: 'female' },
    responses: new Map([
      ['GET /api/plans/today', executionWith()],
      ['POST /api/runs', (request) => {
        savedRun = {
          ...request.body,
          id: 'journey-run',
          name: 'Easy aerobic run',
          health_source: 'forged_hybrid',
        }
        return { id: savedRun.id, run: savedRun }
      }],
      ['PUT /api/plans/my/progress', { ok: true }],
      ['GET /api/runs/journey-run', () => ({ run: savedRun })],
    ]),
  })

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(_success, failure) {
          failure({ code: 1, message: 'QA denied location' })
        },
        watchPosition() { return 1 },
        clearWatch() {},
      },
    })
  })

  await page.goto('/log-run')
  await page.getByRole('button', { name: 'Start Scheduled Run', exact: true }).click()
  await expect(page).toHaveURL(/\/warmup$/)

  for (let step = 0; step < 4; step += 1) await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.getByRole('button', { name: 'Finish Warm-Up', exact: true }).click()
  await page.getByRole('button', { name: 'Start Run', exact: true }).click()
  await expect(page).toHaveURL(/\/run\/active$/)
  await expect(page.getByRole('button', { name: 'Continue without route' })).toBeVisible()
  await page.getByRole('button', { name: 'Continue without route' }).click()
  await expect(page.getByTestId('pause-run')).toBeVisible({ timeout: 7_000 })
  await page.getByTestId('pause-run').click()
  await page.getByTestId('resume-run').click()
  await page.getByTestId('finish-run').click()
  await page.getByLabel('Run distance in mi').fill('3.1')
  await page.getByRole('button', { name: 'Save Run', exact: true }).click()

  await expect(page).toHaveURL(/\/run\/recap\/journey-run$/)
  await expect(page.getByRole('tab', { name: 'Summary' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'How did that run feel?' })).toHaveCount(0)
  await expect(page.getByTestId('post-run-checkin-page-submit')).toHaveCount(0)

  expect(savedRun.plan_session_id).toBe(plannedRun.id)
  expect(requestsFor(apiState, 'POST', '/api/runs')).toHaveLength(1)
  expect(requestsFor(apiState, 'PUT', '/api/plans/my/progress')).toHaveLength(1)
  expect(requestsFor(apiState, 'POST', '/api/checkin')).toHaveLength(0)
  expect(requestsFor(apiState, 'PATCH', '/api/runs/journey-run/check-in')).toHaveLength(0)

  await page.reload()
  await expect(page.getByRole('tab', { name: 'Summary' })).toBeVisible()
  expect(requestsFor(apiState, 'POST', '/api/runs')).toHaveLength(1)
  expect(requestsFor(apiState, 'PATCH', '/api/runs/journey-run/check-in')).toHaveLength(0)
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('scheduled lift logs one set, opens the large rest timer, and completes the exact plan session', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const sets = []
  const workoutSession = {
    id: 'journey-workout',
    muscle_groups: ['full body'],
    started_at: new Date().toISOString(),
    total_seconds: 90,
  }
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/today', executionWith({ run: null, lift: plannedLift })],
      ['POST /api/workouts/start', { session: workoutSession }],
      ['GET /api/workouts/journey-workout', { session: workoutSession }],
      ['GET /api/workouts/journey-workout/sets', () => ({ sets })],
      ['POST /api/workouts/journey-workout/sets', (request) => {
        const set = { id: `set-${sets.length + 1}`, ...request.body }
        sets.push(set)
        return { set }
      }],
      ['PUT /api/workouts/journey-workout/end', { ok: true }],
      ['PUT /api/plans/my/progress', { ok: true }],
      ['POST /api/ai/session-feedback', { feedback: null }],
    ]),
  })

  await page.goto('/log-lift')
  await expect(page.getByRole('button', { name: 'From your plan' })).toBeVisible()
  const guideButtons = page.getByRole('button', { name: 'View how' })
  await guideButtons.nth(0).click()
  const mappedGuide = page.getByRole('dialog', { name: 'Low Box Jump' })
  await expect(mappedGuide).toBeVisible()
  await expect(mappedGuide.getByRole('button', { name: 'Close exercise guide' })).toBeFocused()
  await expect.poll(() => page.locator('body').evaluate((body) => body.style.overflow)).toBe('hidden')
  await expect(mappedGuide.locator('img[src="/exercises/low-box-jump.jpg"]')).toBeVisible()
  await mappedGuide.getByRole('button', { name: 'Close exercise guide' }).click()
  await expect(mappedGuide).toBeHidden()
  await expect(guideButtons.nth(0)).toBeFocused()
  await expect.poll(() => page.locator('body').evaluate((body) => body.style.overflow)).toBe('')

  await guideButtons.nth(1).click()
  const fallbackGuide = page.getByRole('dialog', { name: 'Single-Arm Offset Goblet Squat With Front-Foot Elevation' })
  await expect(fallbackGuide.getByText('Visual guide pending review')).toBeVisible()
  await expect(fallbackGuide.getByText('No substitute image is shown.')).toBeVisible()
  await expect.poll(() => fallbackGuide.evaluate((dialog) => dialog.scrollWidth <= dialog.clientWidth)).toBe(true)
  await page.locator('[data-exercise-guide-dialog="true"]').click({ position: { x: 4, y: 4 } })
  await expect(fallbackGuide).toBeHidden()
  await expect(guideButtons.nth(1)).toBeFocused()

  await guideButtons.nth(1).click()
  await expect(fallbackGuide).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(fallbackGuide).toBeHidden()

  const originalViewport = page.viewportSize()
  await page.setViewportSize({ width: 320, height: 360 })
  await page.locator('body').evaluate((body) => {
    body.style.overflow = 'clip'
    body.style.overscrollBehavior = 'contain'
  })
  await guideButtons.nth(2).click()
  const vettedGuide = page.getByRole('dialog', { name: 'Romanian Deadlift' })
  const vettedClose = vettedGuide.getByRole('button', { name: 'Close exercise guide' })
  await expect(vettedClose).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(vettedClose).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(vettedClose).toBeFocused()
  await expect(vettedGuide.locator('img[src="/exercises/romanian-deadlift.webp"]')).toBeVisible()
  await expect(vettedGuide.getByText('Keep a soft knee bend, push the hips back, and keep the bar close without rounding your back.')).toBeVisible()
  await expect(vettedGuide.getByText('Stale generic hinge cue.')).toHaveCount(0)
  await expect.poll(() => vettedGuide.evaluate((dialog) => {
    const styles = getComputedStyle(dialog)
    return styles.overflowY === 'auto' && dialog.scrollHeight > dialog.clientHeight && dialog.scrollWidth <= dialog.clientWidth
  })).toBe(true)
  await vettedClose.click()
  await expect(guideButtons.nth(2)).toBeFocused()
  await expect.poll(() => page.locator('body').evaluate((body) => `${body.style.overflow}|${body.style.overscrollBehavior}`)).toBe('clip|contain')
  await page.locator('body').evaluate((body) => {
    body.style.overflow = ''
    body.style.overscrollBehavior = ''
  })
  if (originalViewport) await page.setViewportSize(originalViewport)

  await page.getByRole('button', { name: 'Start Workout', exact: true }).click()
  await expect(page).toHaveURL(/\/workout\/active\/journey-workout$/)
  await page.getByLabel('Reps').fill('8')
  await page.getByLabel('Weight in pounds').fill('50')
  await page.getByRole('button', { name: '+ Set 1', exact: true }).click()
  const timer = page.getByRole('dialog', { name: 'Rest Timer' })
  await expect(timer).toBeVisible()
  await expect(timer.getByText('1:30', { exact: true })).toBeVisible()
  await timer.getByRole('button', { name: 'Close rest timer' }).click()
  await page.getByRole('button', { name: 'End Workout', exact: true }).click()
  await expect(page).toHaveURL(/\/workout\/summary\/journey-workout$/)
  await expect(page.getByRole('heading', { name: 'Summary', exact: true })).toBeVisible()

  expect(requestsFor(apiState, 'POST', '/api/workouts/start')).toHaveLength(1)
  expect(requestsFor(apiState, 'POST', '/api/workouts/journey-workout/sets')).toHaveLength(1)
  expect(requestsFor(apiState, 'PUT', '/api/workouts/journey-workout/end')).toHaveLength(1)
  expect(requestsFor(apiState, 'PUT', '/api/plans/my/progress')).toHaveLength(1)
  expect(requestsFor(apiState, 'PUT', '/api/plans/my/progress')[0].body).toMatchObject({ completed_session_id: plannedLift.id, current_week: 1 })
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('exercise guides render exact catalog media and an uncropped vetted fallback before profile sex resolves', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const noProfileLift = {
    ...plannedLift,
    main: [
      {
        name: 'Pigeon Pose',
        image_url: '/stretches/pigeon-pose.webp',
        cue: 'Keep the front knee comfortable and avoid forcing hip range.',
      },
      {
        name: 'Trap Bar Deadlift',
        cue: 'Stale generic deadlift cue.',
      },
    ],
  }
  const apiState = await installAuthenticatedApi(page, {
    user: { sex: '' },
    responses: new Map([
      ['GET /api/plans/today', executionWith({ run: null, lift: noProfileLift })],
    ]),
  })

  await page.goto('/log-lift')
  const guideButtons = page.getByRole('button', { name: 'View how' })
  await guideButtons.nth(0).click()
  const catalogGuide = page.getByRole('dialog', { name: 'Pigeon Pose' })
  await expect(catalogGuide.locator('img[src="/stretches/pigeon-pose.webp"]')).toBeVisible()
  await catalogGuide.getByRole('button', { name: 'Close exercise guide' }).click()

  await guideButtons.nth(1).click()
  const vettedGuide = page.getByRole('dialog', { name: 'Trap Bar Deadlift' })
  const vettedImage = vettedGuide.locator('img[src="/exercises/trap-bar-deadlift.webp"]')
  await expect(vettedImage).toBeVisible()
  await expect.poll(() => vettedImage.evaluate((image) => ({
    position: image.style.position,
    width: image.style.width,
  }))).toEqual({ position: '', width: '100%' })
  await vettedGuide.getByRole('button', { name: 'Close exercise guide' }).click()

  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('adaptive plan keeps the original calendar only after an explicit decision', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const plan = {
    id: 'journey-plan',
    name: 'Army Ten-Miler plan',
    type: '10 mile',
    weeks: 1,
    plan_data: {
      schemaVersion: 2,
      planMode: 'run_only',
      goal: { name: 'Army Ten-Miler', dateISO: today, distanceMiles: 10 },
      weeks: [{
        week: 1,
        startDate: today,
        days: [{ date: today, day: todayDay, sessions: [{ id: plannedRun.id, kind: 'run', prescription: plannedRun }] }],
      }],
    },
  }
  const proposal = {
    id: 'journey-adaptation',
    revision: 'journey-adaptation-revision',
    planVersion: 'journey-plan-version',
    status: 'proposal',
    decisionStatus: 'pending',
    headline: 'One transparent change',
    reason: 'Sleep was below your recent baseline.',
    evidence: [{ signal: 'sleep', source: 'apple_health', objective: true, freshness: 'today', detail: 'Sleep was below baseline.' }],
    changes: [{
      date: today,
      sessionId: plannedRun.id,
      before: { title: 'Tempo run' },
      after: { title: 'Easy aerobic run' },
      summary: 'Intensity reduced; the race target remains protected.',
    }],
  }
  let keepAttempts = 0
  let keepCommitted = false
  let staleReadsAfterCommit = 0
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/my', { plan, user_plan: { current_week: 1, started_at: today, progress: { completedSessionIds: [] } } }],
      ['GET /api/plans/adaptation/current', () => {
        // Exercise the real post-decision refetch with a stale pending snapshot.
        // A committed exact proposal must remain settled on the client.
        if (keepCommitted) staleReadsAfterCommit += 1
        return { proposal }
      }],
      ['POST /api/plans/adaptation/journey-adaptation/keep', () => {
        keepAttempts += 1
        if (keepAttempts === 1) return qaResponse({ queued: true, offline: true }, 202)
        keepCommitted = true
        return { ok: true, status: 'kept' }
      }],
    ]),
  })

  await page.goto('/plan')
  await expect(page.getByText('One transparent change', { exact: true })).toBeVisible()
  expect(requestsFor(apiState, 'POST', '/api/plans/adaptation/journey-adaptation/keep')).toHaveLength(0)
  await page.getByRole('button', { name: 'Keep original', exact: true }).click()
  await expect(page.getByText(/Forge did not save this choice immediately/)).toBeVisible()
  await expect(page.getByText('One transparent change', { exact: true })).toBeVisible()
  const staleRefetch = page.waitForResponse((response) => {
    const url = new URL(response.url())
    return response.request().method() === 'GET' && url.pathname === '/api/plans/adaptation/current'
  })
  await page.getByRole('button', { name: 'Keep original', exact: true }).click()
  await staleRefetch
  await expect(page.getByText('One transparent change', { exact: true })).toHaveCount(0)
  const keepRequests = requestsFor(apiState, 'POST', '/api/plans/adaptation/journey-adaptation/keep')
  expect(keepRequests).toHaveLength(2)
  expect(requestsFor(apiState, 'GET', '/api/plans/adaptation/current')).toHaveLength(2)
  expect(staleReadsAfterCommit).toBe(1)
  expect(keepRequests[1].body).toEqual({
    proposal_revision: proposal.revision,
    proposal_plan_version: proposal.planVersion,
  })
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('a stale adaptation is discarded and recomputed for review without applying the wrong plan', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const plan = {
    id: 'stale-adaptation-plan',
    name: 'Current adaptive plan',
    type: '10 mile',
    weeks: 1,
    plan_data: {
      schemaVersion: 2,
      planMode: 'run_only',
      goal: { name: 'Army Ten-Miler', dateISO: today, distanceMiles: 10 },
      weeks: [{
        week: 1,
        startDate: today,
        days: [{ date: today, day: todayDay, sessions: [{ id: plannedRun.id, kind: 'run', prescription: plannedRun }] }],
      }],
    },
  }
  const staleProposal = {
    id: 'stale-adaptation',
    revision: 'stale-adaptation-revision',
    planVersion: 'stale-plan-version',
    status: 'proposal',
    decisionStatus: 'pending',
    headline: 'Outdated calendar adjustment',
    reason: 'This was computed before the calendar changed.',
    evidence: [],
    changes: [{ date: today, sessionId: plannedRun.id, before: { title: 'Tempo' }, after: { title: 'Easy' }, summary: 'Old proposal' }],
  }
  const freshProposal = {
    ...staleProposal,
    id: 'fresh-adaptation',
    revision: 'fresh-adaptation-revision',
    planVersion: 'fresh-plan-version',
    headline: 'Fresh calendar adjustment',
    reason: 'This was recomputed against the latest calendar.',
    changes: [{ date: today, sessionId: plannedRun.id, before: { title: 'Easy' }, after: { title: 'Rest' }, summary: 'Fresh proposal' }],
  }
  let currentProposalReads = 0
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/my', { plan, user_plan: { current_week: 1, started_at: today, progress: { completedSessionIds: [] } } }],
      ['GET /api/plans/adaptation/current', () => {
        currentProposalReads += 1
        return { proposal: currentProposalReads === 1 ? staleProposal : freshProposal }
      }],
      ['POST /api/plans/adaptation/stale-adaptation/accept', qaResponse({
        error: 'The active plan changed after this proposal was computed.',
        code: 'ADAPTATION_STALE',
        refresh_required: true,
      }, 409)],
    ]),
  })

  await page.goto('/plan')
  await expect(page.getByText('Outdated calendar adjustment', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(page.getByText('Outdated calendar adjustment', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Fresh calendar adjustment', { exact: true })).toBeVisible()
  await expect(page.getByText(/Review the updated proposal before accepting it/)).toBeVisible()
  const staleAcceptRequests = requestsFor(apiState, 'POST', '/api/plans/adaptation/stale-adaptation/accept')
  expect(staleAcceptRequests).toHaveLength(1)
  expect(staleAcceptRequests[0].body).toEqual({
    proposal_revision: staleProposal.revision,
    proposal_plan_version: staleProposal.planVersion,
  })
  expect(requestsFor(apiState, 'GET', '/api/plans/adaptation/current')).toHaveLength(2)
  expect(requestsFor(apiState, 'POST', '/api/plans/adaptation/fresh-adaptation/accept')).toHaveLength(0)
  expect([...new Set(apiState.unexpectedRequests)]).toEqual([])
  expect(runtimeErrors.filter((message) => !/status of 409 \(Conflict\)/.test(message))).toEqual([])
})

test('ambiguous race-removal response is reconciled from fresh account state and never stays pending', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const race = {
    id: 'yonkers-race',
    race_name: 'Yonkers Half Marathon',
    race_date: '2026-09-20',
    distance_miles: 13.1,
    status: 'upcoming',
  }
  let racePresent = true
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/races', () => ({ races: racePresent ? [race] : [] })],
      ['GET /api/plans/my', () => ({
        plan: racePresent
          ? { id: 'race-plan', plan_data: { schemaVersion: 2, goals: [{ raceId: race.id, name: race.race_name, dateISO: race.race_date }] } }
          : { id: 'replacement-plan', plan_data: { schemaVersion: 2, goals: [] } },
        user_plan: { id: racePresent ? 'assignment-old' : 'assignment-replacement', current_week: 1, started_at: today, progress: {} },
      })],
      ['POST /api/races/yonkers-race/removal-preview', {
        requires_apply: true,
        candidate_id: 'remove-yonkers-candidate',
        candidate_hash: 'sha256:remove-yonkers',
        removal: { remaining_race_ids: [] },
      }],
      ['POST /api/races/yonkers-race/removal-apply', () => {
        racePresent = false
        return qaResponse({ error: 'The response took too long.' }, 504)
      }],
    ]),
  })

  await page.goto('/races')
  await expect(page.getByText('Yonkers Half Marathon', { exact: true })).toBeVisible()
  await page.getByLabel('Manage Yonkers Half Marathon').getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.getByText('Yonkers Half Marathon', { exact: true })).toHaveCount(0)
  await expect(page.getByText(/Forge confirmed it after refreshing your account/)).toBeVisible()
  await expect(page.getByRole('button', { name: /Removing/ })).toHaveCount(0)
  expect(requestsFor(apiState, 'POST', '/api/races/yonkers-race/removal-preview')).toHaveLength(1)
  expect(requestsFor(apiState, 'POST', '/api/races/yonkers-race/removal-apply')).toHaveLength(1)
  expect(requestsFor(apiState, 'GET', '/api/races')).toHaveLength(2)
  expect([...new Set(apiState.unexpectedRequests)]).toEqual([])
  expect(runtimeErrors.filter((message) => !/status of 504 \(Gateway Timeout\)/.test(message))).toEqual([])
})

test('the reopened Yonkers to HYROX lifecycle passes the exact pre-bootstrap auth and replacement route', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)

  // RED control: without the historical context.addInitScript bootstrap, the
  // same real /races route correctly stops at Login and cannot expose a label.
  await page.goto('/races')
  await expect(page).toHaveURL(/\/login$/)

  const yonkers = {
    id: 'yonkers-race', race_name: 'Yonkers Half Marathon', race_date: '2026-09-20',
    event_kind: 'run_race', status: 'upcoming', distance_miles: 13.1,
  }
  let savedHyrox = {
    id: 'hyrox-dc', race_name: 'HYROX Washington DC', race_date: '2026-09-06',
    event_local_date: '2026-09-06', event_timezone: 'America/New_York', event_kind: 'hyrox',
    event_format: 'individual_open', event_category: 'men', goal_time_seconds: null, status: 'upcoming',
  }
  const army = {
    id: 'army-race', race_name: 'Army Ten-Miler', race_date: '2026-10-11',
    event_kind: 'run_race', status: 'upcoming', distance_miles: 10, goal_time_seconds: 5400,
  }
  let stage = 'stale'
  const activePlan = () => {
    const goals = stage === 'stale'
      ? [
          { raceId: yonkers.id, name: yonkers.race_name, eventLocalDate: yonkers.race_date },
          { raceId: army.id, name: army.race_name, eventLocalDate: army.race_date },
        ]
      : stage === 'removed'
        ? [{ raceId: army.id, name: army.race_name, eventLocalDate: army.race_date }]
        : [
            {
              kind: 'hyrox', raceId: savedHyrox.id, name: savedHyrox.race_name,
              eventLocalDate: savedHyrox.event_local_date, division: savedHyrox.event_format,
              category: savedHyrox.event_category, goalTimeSeconds: savedHyrox.goal_time_seconds,
            },
            { kind: 'run_race', raceId: army.id, name: army.race_name, eventLocalDate: army.race_date, goalTimeSeconds: army.goal_time_seconds },
          ]
    return {
      plan: { id: `plan-${stage}`, plan_data: { schemaVersion: 2, goals, weeks: [] } },
      user_plan: { id: `assignment-${stage}`, current_week: 1, started_at: today, progress: {} },
    }
  }
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/races', () => ({ races: [savedHyrox, army, ...(stage === 'stale' ? [yonkers] : [])] })],
      ['GET /api/plans/my', () => activePlan()],
      ['POST /api/races/yonkers-race/removal-preview', {
        requires_apply: true,
        candidate_id: 'remove-yonkers-candidate',
        candidate_hash: 'sha256:remove-yonkers-candidate',
        removal: { remaining_race_ids: [army.id] },
      }],
      ['POST /api/races/yonkers-race/removal-apply', () => {
        stage = 'removed'
        return { ok: true, plan_id: 'plan-removed', user_plan_id: 'assignment-removed' }
      }],
      ['PATCH /api/races/hyrox-dc', (request) => {
        savedHyrox = { ...savedHyrox, ...request.body }
        return { race: savedHyrox }
      }],
      ['POST /api/plans/generate-for-races', () => ({
        candidate_id: 'hyrox-army-candidate',
        candidate_hash: 'sha256:hyrox-army-candidate',
        candidate: { plan_data: {
          schemaVersion: 2,
          schedulePreferences: { runDaysPerWeek: 3 },
          hyroxPolicy: {
            daysToEventAtGeneration: 7,
            runwayClass: 'readiness_bridge',
            sessionsPerWeek: 2,
            maximumHardLowerBodyDaysPerRollingSeven: 2,
            equipment: [],
            missingEquipment: [],
          },
          goals: [
            {
              kind: 'hyrox', raceId: savedHyrox.id, name: savedHyrox.race_name,
              eventLocalDate: savedHyrox.event_local_date, division: savedHyrox.event_format,
              category: savedHyrox.event_category, goalTimeSeconds: savedHyrox.goal_time_seconds,
            },
            { kind: 'run_race', raceId: army.id, name: army.race_name },
          ],
          weeks: [{ week: 1, phase: 'post_hyrox_recovery', days: [] }],
        } },
      })],
      ['POST /api/plans/candidates/hyrox-army-candidate/apply', () => {
        stage = 'hyrox-army'
        return { ok: true, plan_id: 'plan-hyrox-army', user_plan_id: 'assignment-hyrox-army' }
      }],
    ]),
  })

  await expect(page.getByText('Yonkers Half Marathon', { exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(/\/login$/)

  // GREEN mirrors the historical a39b order: forge_token is installed before
  // React evaluates PrivateRoute, then the real /races page loads the
  // authoritative race and assignment endpoints.
  await page.goto('/races')
  await expect(page.getByText('Yonkers Half Marathon', { exact: true })).toBeVisible()
  await page.getByLabel('Manage Yonkers Half Marathon').getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.getByText('Yonkers Half Marathon', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Removing/ })).toHaveCount(0)
  await expect(page.getByText(/Yonkers Half Marathon was removed/)).toBeVisible()

  await page.getByLabel('Manage HYROX Washington DC').getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByLabel('Format / division').selectOption('doubles')
  await expect(page.getByLabel('Optional secondary running race')).toHaveValue(army.id)
  await page.getByRole('button', { name: 'Preview combined HYROX plan', exact: true }).click()
  await expect(page.getByText('Doubles Men', { exact: true })).toBeVisible()
  await expect(page.getByText('2026-09-06', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Apply reviewed HYROX plan', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'Update your HYROX plan' })).toHaveCount(0)
  await expect(page.getByText('HYROX Washington DC and the reviewed HYROX calendar are updated.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review & rebuild HYROX plan', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Rebuild combined plan', exact: true })).toBeVisible()

  expect(stage).toBe('hyrox-army')
  expect(savedHyrox.event_format).toBe('doubles')
  expect(savedHyrox.event_category).toBe('men')
  expect(requestsFor(apiState, 'POST', '/api/races/yonkers-race/removal-preview')).toHaveLength(1)
  expect(requestsFor(apiState, 'POST', '/api/races/yonkers-race/removal-apply')).toHaveLength(1)
  expect(requestsFor(apiState, 'POST', '/api/plans/generate-for-races')[0].body.race_ids).toEqual([savedHyrox.id, army.id])
  expect(requestsFor(apiState, 'POST', '/api/plans/candidates/hyrox-army-candidate/apply')).toHaveLength(1)
  expect(requestsFor(apiState, 'GET', '/api/races')).toHaveLength(3)
  expect(requestsFor(apiState, 'GET', '/api/plans/my').length).toBeGreaterThanOrEqual(3)
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('failed linked race removal returns to a retryable terminal state at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 })
  const runtimeErrors = collectRuntimeErrors(page)
  const race = {
    id: 'yonkers-race', race_name: 'Yonkers Half Marathon', race_date: '2026-09-20',
    distance_miles: 13.1, status: 'upcoming',
  }
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/races', { races: [race] }],
      ['GET /api/plans/my', {
        plan: { id: 'race-plan', plan_data: { schemaVersion: 2, goals: [{ raceId: race.id, name: race.race_name, dateISO: race.race_date }] } },
        user_plan: { id: 'assignment-race', current_week: 1, started_at: today, progress: {} },
      }],
      ['POST /api/races/yonkers-race/removal-preview', {
        requires_apply: true,
        candidate_id: 'remove-yonkers-candidate',
        candidate_hash: 'sha256:remove-yonkers',
        removal: { remaining_race_ids: [] },
      }],
      ['POST /api/races/yonkers-race/removal-apply', qaResponse({ error: 'Unable to apply race removal.' }, 500)],
    ]),
  })

  await page.goto('/races')
  const manage = page.getByLabel('Manage Yonkers Half Marathon')
  await manage.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(page.getByText(/Yonkers Half Marathon is still listed, and the removal stopped\. Refresh and try again\./)).toBeVisible()
  await expect(manage.getByRole('button', { name: 'Remove', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: /Removing/ })).toHaveCount(0)
  expect(requestsFor(apiState, 'POST', '/api/races/yonkers-race/removal-apply')).toHaveLength(1)
  expect([...new Set(apiState.unexpectedRequests)]).toEqual([])
  expect(runtimeErrors.filter((message) => !/status of 500 \(Internal Server Error\)/.test(message))).toEqual([])
})

test('HYROX setup stays horizontally locked', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const equipment = [
    'ski_erg', 'row_erg', 'sled_push', 'sled_pull', 'wall_ball_target', 'sandbag', 'farmers_carry', 'treadmill',
  ]
  const hyrox = {
    id: 'hyrox-horizontal-lock',
    race_name: 'HYROX Washington DC',
    race_date: '2026-09-06',
    event_local_date: '2026-09-06',
    event_timezone: 'America/New_York',
    event_kind: 'hyrox',
    event_format: 'individual_open',
    event_category: 'men',
    goal_time_seconds: 3600,
    status: 'upcoming',
    event_config_json: {
      schemaVersion: 1,
      canonicalUnits: 'metric',
      equipment,
      runningPriority: 'maintain',
      runDaysPerWeek: 4,
      trainingDays: ['Mon', 'Wed', 'Thu', 'Sun'],
    },
  }
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/races', { races: [hyrox] }],
      ['GET /api/plans/my', {
        plan: { id: 'hyrox-horizontal-lock-plan', plan_data: { schemaVersion: 2, goals: [{ raceId: hyrox.id }] } },
        user_plan: { id: 'hyrox-horizontal-lock-assignment', current_week: 1, started_at: today, progress: {} },
      }],
    ]),
  })

  await page.goto('/races')
  await page.getByLabel('Manage HYROX Washington DC').getByRole('button', { name: 'Edit', exact: true }).click()

  const dialog = page.getByRole('dialog', { name: 'Update your HYROX plan' })
  const weekdayGrid = dialog.getByLabel('Available training days')
  const dateInput = dialog.getByLabel('Exact local event date')
  const durationInputs = [
    dialog.getByLabel('Target finish time hours'),
    dialog.getByLabel('Target finish time minutes'),
    dialog.getByLabel('Target finish time seconds'),
  ]
  const close = dialog.getByRole('button', { name: 'Close HYROX setup' })
  const sunday = weekdayGrid.getByRole('button', { name: 'Sun', exact: true })

  await expect(dialog).toBeVisible()
  await expect(weekdayGrid).toBeVisible()
  await expect(dateInput).toHaveValue('2026-09-06')
  for (const input of durationInputs) await expect(input).toHaveCount(1)

  const measureLayout = () => dialog.evaluate((node) => {
    const rectValue = (element) => {
      const rect = element.getBoundingClientRect()
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      }
    }
    const overlay = node.parentElement
    const visual = window.visualViewport
    const descendants = [...node.querySelectorAll('*')].map((element) => ({
      element,
      rect: element.getBoundingClientRect(),
    })).filter(({ rect }) => rect.width > 0 && rect.height > 0)
    const widest = descendants.reduce((current, entry) => (
      !current || entry.rect.width > current.rect.width ? entry : current
    ), null)
    const closeButton = node.querySelector('button[aria-label="Close HYROX setup"]')
    const sundayButton = [...node.querySelectorAll('[aria-label="Available training days"] button')]
      .find((button) => button.textContent.trim() === 'Sun')
    const dialogRect = node.getBoundingClientRect()
    const clientLeft = dialogRect.left + node.clientLeft
    return {
      overflowX: getComputedStyle(node).overflowX,
      visualViewport: {
        width: visual?.width ?? window.innerWidth,
        height: visual?.height ?? window.innerHeight,
        offsetLeft: visual?.offsetLeft ?? 0,
        offsetTop: visual?.offsetTop ?? 0,
        scale: visual?.scale ?? 1,
      },
      overlay: rectValue(overlay),
      dialog: {
        ...rectValue(node),
        clientLeft,
        clientRight: clientLeft + node.clientWidth,
        clientWidth: node.clientWidth,
        clientHeight: node.clientHeight,
        scrollWidth: node.scrollWidth,
        scrollHeight: node.scrollHeight,
        scrollLeft: node.scrollLeft,
        scrollTop: node.scrollTop,
      },
      document: {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        scrollLeft: document.documentElement.scrollLeft,
        bodyClientWidth: document.body.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        bodyScrollLeft: document.body.scrollLeft,
      },
      descendants: {
        minLeft: Math.min(...descendants.map(({ rect }) => rect.left)),
        maxRight: Math.max(...descendants.map(({ rect }) => rect.right)),
        widest: widest ? {
          tag: widest.element.tagName,
          left: widest.rect.left,
          right: widest.rect.right,
          width: widest.rect.width,
        } : null,
      },
      controls: {
        close: rectValue(closeButton),
        sunday: rectValue(sundayButton),
      },
    }
  })

  const expectWithinVisualViewport = (box, visualViewport, label) => {
    expect(box.left, `${label} left edge`).toBeGreaterThanOrEqual(visualViewport.offsetLeft - 1)
    expect(box.right, `${label} right edge`).toBeLessThanOrEqual(visualViewport.offsetLeft + visualViewport.width + 1)
    expect(box.top, `${label} top edge`).toBeGreaterThanOrEqual(visualViewport.offsetTop - 1)
    expect(box.bottom, `${label} bottom edge`).toBeLessThanOrEqual(visualViewport.offsetTop + visualViewport.height + 1)
  }
  const expectInsideDialog = (box, layout, label) => {
    expect(box.left, `${label} stays inside the dialog client left edge`).toBeGreaterThanOrEqual(layout.dialog.clientLeft - 1)
    expect(box.right, `${label} stays inside the dialog client right edge`).toBeLessThanOrEqual(layout.dialog.clientRight + 1)
    expect(box.top, `${label} stays inside the visible dialog top edge`).toBeGreaterThanOrEqual(layout.dialog.top - 1)
    expect(box.bottom, `${label} stays inside the visible dialog bottom edge`).toBeLessThanOrEqual(layout.dialog.bottom + 1)
  }
  const expectHorizontalLock = (layout, baseline, label) => {
    expect(layout.dialog.scrollWidth, `${label}: dialog has no horizontal overflow`).toBeLessThanOrEqual(layout.dialog.clientWidth)
    expect(layout.dialog.scrollLeft, `${label}: dialog horizontal scroll remains zero`).toBe(0)
    expect(layout.document.scrollWidth, `${label}: document stays within its client width`).toBeLessThanOrEqual(layout.document.clientWidth)
    expect(layout.document.bodyScrollWidth, `${label}: body stays within its client width`).toBeLessThanOrEqual(layout.document.bodyClientWidth)
    expect(layout.document.scrollLeft, `${label}: document horizontal scroll remains zero`).toBe(0)
    expect(layout.document.bodyScrollLeft, `${label}: body horizontal scroll remains zero`).toBe(0)
    expect(layout.dialog.left, `${label}: dialog does not move horizontally`).toBeCloseTo(baseline.dialog.left, 0)
    expect(layout.dialog.right, `${label}: dialog right edge does not move horizontally`).toBeCloseTo(baseline.dialog.right, 0)
    expect(layout.visualViewport.width, `${label}: visual viewport width does not shift`).toBeCloseTo(baseline.visualViewport.width, 0)
    expect(layout.visualViewport.offsetLeft, `${label}: visual viewport offset does not shift`).toBeCloseTo(baseline.visualViewport.offsetLeft, 0)
    expect(layout.visualViewport.scale, `${label}: visual viewport scale does not shift`).toBeCloseTo(baseline.visualViewport.scale, 2)
    expect(layout.descendants.minLeft, `${label}: descendants stay inside the client left edge`).toBeGreaterThanOrEqual(layout.dialog.clientLeft - 1)
    expect(layout.descendants.maxRight, `${label}: descendants stay inside the client right edge`).toBeLessThanOrEqual(layout.dialog.clientRight + 1)
    expect(layout.descendants.widest.left, `${label}: widest descendant starts inside the client bounds`).toBeGreaterThanOrEqual(layout.dialog.clientLeft - 1)
    expect(layout.descendants.widest.right, `${label}: widest descendant ends inside the client bounds`).toBeLessThanOrEqual(layout.dialog.clientRight + 1)
  }

  const initial = await measureLayout()
  expect(initial.overflowX, 'HYROX setup dialog must not be a horizontal scroll container').toMatch(/^(hidden|clip)$/)
  expect(initial.visualViewport.width).toBeGreaterThan(0)
  expect(initial.visualViewport.offsetLeft).toBeGreaterThanOrEqual(0)
  expect(initial.visualViewport.scale).toBeGreaterThan(0)
  expect(initial.dialog.scrollHeight, 'the complete setup form uses the dialog as its vertical scroll container').toBeGreaterThan(initial.dialog.clientHeight)
  expectHorizontalLock(initial, initial, 'initial setup')
  expectWithinVisualViewport(initial.overlay, initial.visualViewport, 'overlay')
  expectWithinVisualViewport(initial.dialog, initial.visualViewport, 'dialog')
  expect(
    (initial.dialog.left + initial.dialog.right) / 2,
    'dialog remains centered in the visual viewport',
  ).toBeCloseTo(initial.visualViewport.offsetLeft + initial.visualViewport.width / 2, 0)
  for (const [label, box] of Object.entries(initial.controls)) {
    expectInsideDialog(box, initial, label)
    expectWithinVisualViewport(box, initial.visualViewport, label)
  }
  await expect(close).toBeVisible()
  await expect(sunday).toBeVisible()

  await dialog.evaluate(async (node) => {
    const center = node.getBoundingClientRect()
    node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: center.left + 100 }))
    node.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'touch', clientX: center.left + 25 }))
    node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', clientX: center.left + 25 }))
    node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 80 }))
    node.scrollLeft = 50
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  })
  const afterHorizontalAttempt = await measureLayout()
  expectHorizontalLock(afterHorizontalAttempt, initial, 'after horizontal touch, wheel, and direct scroll attempts')

  for (const input of [dateInput, ...durationInputs]) {
    await input.scrollIntoViewIfNeeded()
    await input.focus()
    await expect(input).toBeFocused()
    const focusedLayout = await measureLayout()
    const inputBox = await input.boundingBox()
    expect(inputBox).not.toBeNull()
    const normalizedInputBox = {
      left: inputBox.x,
      right: inputBox.x + inputBox.width,
      top: inputBox.y,
      bottom: inputBox.y + inputBox.height,
    }
    expectHorizontalLock(focusedLayout, initial, `after focusing ${await input.getAttribute('aria-label') || 'event date'}`)
    expectInsideDialog(normalizedInputBox, focusedLayout, 'focused input')
    expectWithinVisualViewport(normalizedInputBox, focusedLayout.visualViewport, 'focused input')
  }
  const afterDurationFocus = await measureLayout()
  let afterVerticalReachabilityCheck = afterDurationFocus
  if (afterDurationFocus.dialog.scrollHeight > afterDurationFocus.dialog.clientHeight) {
    await dialog.evaluate((node) => node.scrollTo({ top: node.scrollHeight }))
    await expect.poll(() => dialog.evaluate((node) => node.scrollTop)).toBeGreaterThan(0)
    afterVerticalReachabilityCheck = await measureLayout()
    expect(
      afterVerticalReachabilityCheck.dialog.scrollTop,
      'vertically overflowing dialog can scroll its content into reach',
    ).toBeGreaterThan(0)
  } else {
    expect(
      afterDurationFocus.dialog.scrollHeight,
      'dialog content fits without vertical scrolling',
    ).toBeLessThanOrEqual(afterDurationFocus.dialog.clientHeight)
    expect(afterDurationFocus.dialog.scrollTop, 'non-overflowing dialog remains at its vertical origin').toBe(0)
    expectWithinVisualViewport(afterDurationFocus.dialog, afterDurationFocus.visualViewport, 'non-overflowing dialog')
  }
  expectHorizontalLock(afterVerticalReachabilityCheck, initial, 'after the vertical reachability check')

  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('an existing HYROX event can correct its division and review a combined candidate without mutating the current plan', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const hyrox = {
    id: 'hyrox-dc',
    race_name: 'HYROX Washington DC',
    race_date: '2026-09-06',
    event_local_date: '2026-09-06',
    event_timezone: 'America/New_York',
    event_kind: 'hyrox',
    event_format: 'individual_open',
    event_category: 'men',
    status: 'upcoming',
  }
  const yonkers = { id: 'yonkers-race', race_name: 'Yonkers Half Marathon', race_date: '2026-09-20', event_kind: 'run_race', status: 'upcoming', distance_miles: 13.1 }
  const army = { id: 'army-race', race_name: 'Army Ten-Miler', race_date: '2026-10-11', event_kind: 'run_race', status: 'upcoming', distance_miles: 10 }
  let hyroxPatch = null
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/races', { races: [hyrox, yonkers, army] }],
      ['GET /api/plans/my', {
        plan: { id: 'existing-two-goal-plan', plan_data: { schemaVersion: 2, goals: [
          { raceId: yonkers.id, name: yonkers.race_name, dateISO: yonkers.race_date },
          { raceId: army.id, name: army.race_name, dateISO: army.race_date },
        ] } },
        user_plan: { current_week: 1, started_at: today, progress: {} },
      }],
      ['PATCH /api/races/hyrox-dc', (request) => {
        hyroxPatch = request.body
        return { race: { ...hyrox, ...request.body } }
      }],
      ['POST /api/plans/generate-for-races', {
        candidate_id: 'hyrox-doubles-candidate',
        candidate_hash: 'sha256:hyrox-doubles-candidate',
        candidate: { plan_data: {
          schemaVersion: 2,
          schedulePreferences: { runDaysPerWeek: 3 },
          hyroxPolicy: {
            daysToEventAtGeneration: 24,
            runwayClass: 'race_specific',
            sessionsPerWeek: 2,
            maximumHardLowerBodyDaysPerRollingSeven: 2,
            equipment: [],
            missingEquipment: ['sled_push'],
          },
          goals: [
            { kind: 'hyrox', raceId: hyrox.id, name: hyrox.race_name },
            { kind: 'run_race', raceId: army.id, name: army.race_name },
          ],
          weeks: [{ week: 1, phase: 'post_hyrox_recovery', days: [] }],
        } },
      }],
    ]),
  })

  await page.goto('/races')
  await expect(page.getByText('HYROX · Open Men', { exact: true })).toBeVisible()
  await page.getByLabel('Manage HYROX Washington DC').getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Update your HYROX plan' })).toBeVisible()
  await page.getByLabel('Format / division').selectOption('doubles')
  await expect(page.getByLabel('Optional secondary running race')).toHaveValue(army.id)
  const selectionReview = page.getByLabel('HYROX selection review')
  await expect(selectionReview.getByText('Doubles Men', { exact: true })).toBeVisible()
  await expect(selectionReview.getByText('2026-09-06', { exact: true })).toBeVisible()
  await expect(page.getByText('Combined rebuild selected: Army Ten-Miler.', { exact: true })).toBeVisible()
  await expect(page.getByText(/Yonkers Half Marathon is not included because it is 14 days after HYROX; at least 21 days is required\. Change either event date/i)).toBeVisible()

  await page.getByLabel('Optional secondary running race').selectOption(yonkers.id)
  await page.getByRole('button', { name: 'Preview combined HYROX plan', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Yonkers Half Marathon is only 14 days after HYROX. Choose a running race at least 21 days later, or change either event date.')
  expect(hyroxPatch).toBeNull()
  expect(requestsFor(apiState, 'POST', '/api/plans/generate-for-races')).toHaveLength(0)

  await page.getByLabel('Optional secondary running race').selectOption(army.id)
  await page.getByRole('button', { name: 'Preview combined HYROX plan', exact: true }).click()

  await expect(page.getByText('Doubles Men', { exact: true })).toBeVisible()
  await expect(page.getByText('2026-09-06', { exact: true })).toBeVisible()
  expect(hyroxPatch.event_format).toBe('doubles')
  expect(hyroxPatch.event_category).toBe('men')
  expect(hyroxPatch.event_config_json).toMatchObject({ runDaysPerWeek: 3, trainingDays: ['Tue', 'Thu', 'Sat', 'Sun'] })
  await expect.poll(() => requestsFor(apiState, 'POST', '/api/plans/generate-for-races').length).toBe(1)
  const previews = requestsFor(apiState, 'POST', '/api/plans/generate-for-races')
  expect(previews).toHaveLength(1)
  expect(previews[0].body.race_ids).toEqual([hyrox.id, army.id])
  expect(requestsFor(apiState, 'POST', '/api/plans/candidates/hyrox-doubles-candidate/apply')).toHaveLength(0)
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('an existing owned HYROX event can apply a foundation without requiring dated race truth at 393px', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 })
  const runtimeErrors = collectRuntimeErrors(page)
  let applied = false
  const hyrox = {
    id: 'hyrox-dc', race_name: 'HYROX Washington DC', race_date: '2026-09-06',
    event_local_date: '2026-09-06', event_timezone: 'America/New_York', event_kind: 'hyrox',
    event_format: 'doubles', event_category: 'men', goal_time_seconds: 3540, status: 'upcoming',
  }
  const before = {
    plan: { id: 'dated-plan', plan_data: { schemaVersion: 2, goals: [{
      raceId: hyrox.id, eventLocalDate: hyrox.event_local_date, division: hyrox.event_format,
      category: hyrox.event_category, goalTimeSeconds: hyrox.goal_time_seconds,
    }] } },
    user_plan: { id: 'assignment-dated', supersedes_user_plan_id: null, current_week: 1, started_at: today, progress: {} },
  }
  const foundation = {
    plan: { id: 'foundation-plan', plan_data: { schemaVersion: 2, goals: [], hyroxPolicy: {
      daysToEventAtGeneration: null, runwayClass: 'foundation_only', sessionsPerWeek: 2,
      maximumHardLowerBodyDaysPerRollingSeven: 2, equipment: [], missingEquipment: [],
    }, weeks: Array.from({ length: 8 }, (_, index) => ({ week: index + 1, phase: 'foundation', days: [] })) } },
    user_plan: { id: 'assignment-foundation', supersedes_user_plan_id: 'assignment-dated', current_week: 1, started_at: today, progress: {} },
  }
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/races', { races: [hyrox] }],
      ['GET /api/plans/my', () => applied ? foundation : before],
      ['POST /api/plans/generate', {
        candidate_id: 'foundation-candidate',
        candidate_hash: 'sha256:foundation-candidate',
        candidate: { plan_data: foundation.plan.plan_data },
      }],
      ['POST /api/plans/candidates/foundation-candidate/apply', () => {
        applied = true
        return { ok: true, plan_id: 'foundation-plan', user_plan_id: 'assignment-foundation' }
      }],
    ]),
  })

  await page.goto('/races')
  await page.getByLabel('Manage HYROX Washington DC').getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByRole('button', { name: 'Build an 8-week foundation', exact: true }).click()
  await page.getByRole('button', { name: 'Preview HYROX plan', exact: true }).click()
  await expect(page.getByText('Eight-week foundation · no event date', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Apply reviewed HYROX plan', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'Update your HYROX plan' })).toHaveCount(0)
  await expect(page.getByText('The reviewed eight-week HYROX foundation calendar is updated. Your saved event was not changed.', { exact: true })).toBeVisible()
  expect(requestsFor(apiState, 'PATCH', '/api/races/hyrox-dc')).toHaveLength(0)
  expect(requestsFor(apiState, 'POST', '/api/plans/candidates/foundation-candidate/apply')).toHaveLength(1)
  await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'scroll')
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('a successful two-week HYROX bridge suppresses an empty phase row and keeps review actions reachable on mobile', async ({ page }, testInfo) => {
  const expectedViewport = testInfo.project.name === 'compact-mobile-320'
    ? { width: 320, height: 568 }
    : { width: 402, height: 874 }
  expect(page.viewportSize()).toEqual(expectedViewport)
  const runtimeErrors = collectRuntimeErrors(page)
  const hyrox = {
    id: 'hyrox-dc', race_name: 'HYROX Washington DC', race_date: '2026-09-06',
    event_local_date: '2026-09-06', event_timezone: 'America/New_York', event_kind: 'hyrox',
    event_format: 'individual_open', event_category: 'men', goal_time_seconds: null, status: 'upcoming',
  }
  let previewCount = 0
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/races', { races: [hyrox] }],
      ['GET /api/plans/my', {
        plan: { id: 'active-hyrox-plan', plan_data: { schemaVersion: 2, goals: [{
          raceId: hyrox.id, eventLocalDate: hyrox.event_local_date,
          division: hyrox.event_format, category: hyrox.event_category,
        }] } },
        user_plan: { id: 'active-hyrox-assignment', current_week: 1, started_at: today, progress: {} },
      }],
      ['PATCH /api/races/hyrox-dc', { race: hyrox }],
      ['POST /api/plans/generate-for-race/hyrox-dc', () => {
        previewCount += 1
        const emptyPhaseBridge = previewCount === 1
        return {
          candidate_id: emptyPhaseBridge ? 'two-week-bridge-candidate' : 'multi-phase-candidate',
          candidate_hash: emptyPhaseBridge ? 'sha256:two-week-bridge-candidate' : 'sha256:multi-phase-candidate',
          candidate: { plan_data: {
            schemaVersion: 2,
            schedulePreferences: { runDaysPerWeek: 3 },
            hyroxPolicy: {
              daysToEventAtGeneration: emptyPhaseBridge ? 16 : 35,
              runwayClass: emptyPhaseBridge ? 'readiness_bridge' : 'short_runway',
              sessionsPerWeek: 2,
              maximumHardLowerBodyDaysPerRollingSeven: 2,
              equipment: [],
              missingEquipment: [],
            },
            goals: [{ kind: 'hyrox', raceId: hyrox.id, name: hyrox.race_name }],
            weeks: emptyPhaseBridge
              ? [
                  { week: 1, startDate: '2026-08-17', days: [] },
                  { week: 2, startDate: '2026-08-24', days: [] },
                ]
              : [
                  { week: 1, phase: 'orientation_assessment', days: [] },
                  { week: 2, phase: 'build', days: [] },
                  { week: 3, phase: 'taper_race', days: [] },
                ],
          } },
        }
      }],
    ]),
  })

  await page.goto('/races')
  await page.getByLabel('Manage HYROX Washington DC').getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByRole('button', { name: 'Preview HYROX plan', exact: true }).click()

  const dialog = page.getByRole('dialog')
  const apply = dialog.getByRole('button', { name: 'Apply reviewed HYROX plan', exact: true })
  const back = dialog.getByRole('button', { name: 'Back to setup', exact: true })
  await expect(dialog.getByText('HYROX readiness bridge', { exact: true })).toBeVisible()
  await expect(dialog.getByText('2 weeks · 3 run exposures · 2 HYROX exposures · 2 hard lower-body days', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Phase sequence', { exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('alert')).toHaveCount(0)
  await testInfo.attach(`hyrox-empty-phase-top-${expectedViewport.width}x${expectedViewport.height}`, {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  })

  await back.scrollIntoViewIfNeeded()
  await expect(apply).toBeEnabled()
  await expect(apply).toBeInViewport()
  await expect(back).toBeEnabled()
  await expect(back).toBeInViewport()
  const [applyBox, backBox] = await Promise.all([apply.boundingBox(), back.boundingBox()])
  expect(applyBox).not.toBeNull()
  expect(backBox).not.toBeNull()
  expect(backBox.y, 'Back follows Apply without overlap').toBeGreaterThanOrEqual(applyBox.y + applyBox.height)
  expect(applyBox.y, 'Apply does not clip above the viewport').toBeGreaterThanOrEqual(0)
  expect(backBox.y + backBox.height, 'Back does not clip below the viewport').toBeLessThanOrEqual(expectedViewport.height)

  const layout = await dialog.evaluate((node) => {
    const dialogBox = node.getBoundingClientRect()
    const reviewRows = [...node.querySelectorAll('dl > div')].map((row) => {
      const box = row.getBoundingClientRect()
      return {
        left: box.left, right: box.right, top: box.top, bottom: box.bottom,
        clientWidth: row.clientWidth, scrollWidth: row.scrollWidth,
      }
    })
    return {
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      dialog: {
        left: dialogBox.left, right: dialogBox.right,
        clientWidth: node.clientWidth, scrollWidth: node.scrollWidth,
      },
      reviewRows,
    }
  })
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth)
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth)
  expect(layout.dialog.scrollWidth).toBeLessThanOrEqual(layout.dialog.clientWidth)
  for (const [index, row] of layout.reviewRows.entries()) {
    expect(row.scrollWidth, `review row ${index + 1} has no horizontal overflow`).toBeLessThanOrEqual(row.clientWidth)
    expect(row.left, `review row ${index + 1} does not clip left`).toBeGreaterThanOrEqual(layout.dialog.left)
    expect(row.right, `review row ${index + 1} does not clip right`).toBeLessThanOrEqual(layout.dialog.right)
    if (index > 0) {
      expect(row.top, `review row ${index + 1} does not overlap its predecessor`).toBeGreaterThanOrEqual(layout.reviewRows[index - 1].bottom)
    }
  }
  for (const box of [applyBox, backBox]) {
    expect(box.x, 'review action does not clip left').toBeGreaterThanOrEqual(0)
    expect(box.x + box.width, 'review action does not clip right').toBeLessThanOrEqual(layout.viewportWidth)
  }
  await testInfo.attach(`hyrox-empty-phase-actions-${expectedViewport.width}x${expectedViewport.height}`, {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  })

  await back.click()
  await page.getByRole('button', { name: 'Preview HYROX plan', exact: true }).click()
  await expect(dialog.getByText('Phase sequence', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Orientation Assessment → Build → Taper Race', { exact: true })).toBeVisible()
  await expect(dialog).not.toContainText('orientation_assessment')
  await expect(dialog).not.toContainText('taper_race')
  expect(previewCount).toBe(2)
  expect(requestsFor(apiState, 'POST', '/api/plans/generate-for-race/hyrox-dc')).toHaveLength(2)
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('a failed reviewed HYROX apply keeps confirmed prior-calendar feedback beside the retry controls on mobile', async ({ page }, testInfo) => {
  const expectedViewport = testInfo.project.name === 'compact-mobile-320'
    ? { width: 320, height: 568 }
    : { width: 393, height: 852 }
  await page.setViewportSize(expectedViewport)
  const runtimeErrors = collectRuntimeErrors(page)
  const hyrox = {
    id: 'hyrox-dc', race_name: 'HYROX Washington DC', race_date: '2026-09-06',
    event_local_date: '2026-09-06', event_timezone: 'America/New_York', event_kind: 'hyrox',
    event_format: 'doubles', event_category: 'men', goal_time_seconds: 3540, status: 'upcoming',
  }
  const active = {
    plan: { id: 'active-before-failure', plan_data: { schemaVersion: 2, goals: [{
      raceId: hyrox.id, eventLocalDate: hyrox.event_local_date, division: hyrox.event_format,
      category: hyrox.event_category, goalTimeSeconds: hyrox.goal_time_seconds,
    }] } },
    user_plan: { id: 'assignment-before-failure', supersedes_user_plan_id: null, current_week: 1, started_at: today, progress: {} },
  }
  const servedAssignmentIds = []
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/races', { races: [hyrox] }],
      ['GET /api/plans/my', () => {
        servedAssignmentIds.push(active.user_plan.id)
        return active
      }],
      ['PATCH /api/races/hyrox-dc', { race: hyrox }],
      ['POST /api/plans/generate-for-race/hyrox-dc', {
        candidate_id: 'failed-hyrox-candidate',
        candidate_hash: 'sha256:failed-hyrox-candidate',
        candidate: { plan_data: {
          schemaVersion: 2,
          goals: active.plan.plan_data.goals,
          hyroxPolicy: { daysToEventAtGeneration: 22, runwayClass: 'short_runway', sessionsPerWeek: 2, maximumHardLowerBodyDaysPerRollingSeven: 2, equipment: [], missingEquipment: [] },
          weeks: [{ week: 1, phase: 'build', days: [] }],
        } },
      }],
      ['POST /api/plans/candidates/failed-hyrox-candidate/apply', qaResponse({ error: 'Apply service unavailable.' }, 500)],
    ]),
  })

  await page.goto('/races')
  await page.getByLabel('Manage HYROX Washington DC').getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByRole('button', { name: 'Preview HYROX plan', exact: true }).click()
  await page.getByRole('button', { name: 'Apply reviewed HYROX plan', exact: true }).click()

  const feedback = page.getByRole('alert')
  const retry = page.getByRole('button', { name: 'Apply reviewed HYROX plan', exact: true })
  const back = page.getByRole('button', { name: 'Back to setup', exact: true })
  await expect(feedback, 'the failure has one alert announcement').toHaveCount(1)
  await expect(feedback).toHaveText('Could not apply the reviewed plan. Forge confirmed the prior calendar is still active, so it is safe to retry.')
  await expect(feedback).toHaveAttribute('aria-live', 'assertive')
  await expect(feedback).toBeVisible()
  await expect(retry).toBeEnabled()
  await expect(retry).toBeInViewport()
  await expect(back).toBeEnabled()
  await expect(back).toBeInViewport()
  await expect(page.getByRole('button', { name: 'Applying reviewed plan…', exact: true })).toHaveCount(0)

  const dialog = page.getByRole('dialog')
  const [feedbackBox, retryBox, backBox, dialogBox] = await Promise.all([
    feedback.boundingBox(), retry.boundingBox(), back.boundingBox(), dialog.boundingBox(),
  ])
  expect(page.viewportSize()).toEqual(expectedViewport)
  expect(feedbackBox, 'reconciliation feedback has rendered geometry').not.toBeNull()
  expect(retryBox, 'retry control has rendered geometry').not.toBeNull()
  expect(backBox, 'back control has rendered geometry').not.toBeNull()
  expect(dialogBox, 'review dialog has rendered geometry').not.toBeNull()
  expect(feedbackBox.y, 'feedback starts inside the current viewport').toBeGreaterThanOrEqual(0)
  expect(feedbackBox.y + feedbackBox.height, 'the complete reconciliation feedback remains visible in the current viewport').toBeLessThanOrEqual(expectedViewport.height)
  expect(feedbackBox.y + feedbackBox.height, 'the complete feedback remains inside the dialog viewport').toBeLessThanOrEqual(dialogBox.y + dialogBox.height)
  expect(retryBox.y, 'retry remains fully visible in the current viewport').toBeGreaterThanOrEqual(0)
  expect(retryBox.y + retryBox.height, 'retry remains fully visible in the current viewport').toBeLessThanOrEqual(expectedViewport.height)
  expect(retryBox.y, 'retry remains inside the dialog viewport').toBeGreaterThanOrEqual(dialogBox.y)
  expect(feedbackBox.y, 'feedback follows the retry control without overlap').toBeGreaterThanOrEqual(retryBox.y + retryBox.height)
  expect(feedbackBox.y - (retryBox.y + retryBox.height), 'feedback stays adjacent to the retry control').toBeLessThanOrEqual(16)
  expect(backBox.y, 'back control follows feedback without overlap').toBeGreaterThanOrEqual(feedbackBox.y + feedbackBox.height)
  expect(backBox.y + backBox.height, 'back remains fully visible in the current viewport').toBeLessThanOrEqual(expectedViewport.height)
  expect(backBox.y + backBox.height, 'back remains inside the dialog viewport').toBeLessThanOrEqual(dialogBox.y + dialogBox.height)

  const layout = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]')
    return {
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      dialogClientWidth: dialog?.clientWidth || 0,
      dialogScrollWidth: dialog?.scrollWidth || 0,
    }
  })
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth)
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth)
  expect(layout.dialogScrollWidth).toBeLessThanOrEqual(layout.dialogClientWidth)
  for (const box of [feedbackBox, retryBox, backBox]) {
    expect(box.x, 'failure controls do not clip left').toBeGreaterThanOrEqual(0)
    expect(box.x + box.width, 'failure controls do not clip right').toBeLessThanOrEqual(layout.viewportWidth)
  }

  const applyRequests = requestsFor(apiState, 'POST', '/api/plans/candidates/failed-hyrox-candidate/apply')
  expect(applyRequests).toHaveLength(1)
  expect(applyRequests[0].body).toMatchObject({
    candidate_hash: 'sha256:failed-hyrox-candidate',
    choice: 'train_for_target',
  })
  expect(applyRequests[0].body).not.toHaveProperty('user_plan_id')
  expect(servedAssignmentIds.length, 'the page load and fresh before/after reconciliation reads all occurred').toBeGreaterThanOrEqual(3)
  expect(new Set(servedAssignmentIds)).toEqual(new Set(['assignment-before-failure']))
  expect(apiState.requests.filter((request) => request.pathname.includes('assignment-before-failure'))).toHaveLength(0)
  expect([...new Set(apiState.unexpectedRequests)]).toEqual([])
  expect(runtimeErrors.filter((message) => !/status of 500 \(Internal Server Error\)/.test(message))).toEqual([])
})

test('a reviewed HYROX apply confirms exact assignment, goal truth, and no stale races at 393px', async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 })
  const runtimeErrors = collectRuntimeErrors(page)
  let applied = false
  let savedHyrox = {
    id: 'hyrox-dc',
    race_name: 'HYROX Washington DC',
    race_date: '2026-09-06',
    event_local_date: '2026-09-06',
    event_timezone: 'America/New_York',
    event_kind: 'hyrox',
    event_format: 'individual_open',
    event_category: 'men',
    goal_time_seconds: 6900,
    status: 'upcoming',
  }
  const yonkers = { id: 'yonkers-race', race_name: 'Yonkers Half Marathon', race_date: '2026-09-20', event_kind: 'run_race', status: 'upcoming', distance_miles: 13.1 }
  const army = { id: 'army-race', race_name: 'Army Ten-Miler', race_date: '2026-10-11', event_kind: 'run_race', status: 'upcoming', distance_miles: 10, goal_time_seconds: 5400 }
  const replacementPlan = () => ({
    plan: {
      id: 'hyrox-army-plan',
      plan_data: {
        schemaVersion: 2,
        goals: [
          {
            kind: 'hyrox', raceId: savedHyrox.id, name: savedHyrox.race_name,
            eventLocalDate: savedHyrox.event_local_date, division: savedHyrox.event_format,
            category: savedHyrox.event_category, goalTimeSeconds: savedHyrox.goal_time_seconds,
          },
          { kind: 'run_race', raceId: army.id, name: army.race_name, eventLocalDate: army.race_date, goalTimeSeconds: army.goal_time_seconds },
        ],
        weeks: [],
      },
    },
    user_plan: { id: 'assignment-hyrox-army', current_week: 1, started_at: today, progress: {} },
  })
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/races', () => ({ races: [savedHyrox, yonkers, army] })],
      ['GET /api/plans/my', () => applied ? replacementPlan() : ({
        plan: { id: 'stale-plan', plan_data: { schemaVersion: 2, goals: [
          { raceId: yonkers.id, name: yonkers.race_name, eventLocalDate: yonkers.race_date },
          { raceId: army.id, name: army.race_name, eventLocalDate: army.race_date },
        ] } },
        user_plan: { id: 'assignment-stale', current_week: 1, started_at: today, progress: {} },
      })],
      ['PATCH /api/races/hyrox-dc', (request) => {
        savedHyrox = { ...savedHyrox, ...request.body }
        return { race: savedHyrox }
      }],
      ['POST /api/plans/generate-for-races', () => ({
        candidate_id: 'hyrox-army-candidate',
        candidate_hash: 'sha256:hyrox-army-candidate',
        candidate: { plan_data: {
          schemaVersion: 2,
          schedulePreferences: { runDaysPerWeek: 3 },
          hyroxPolicy: { daysToEventAtGeneration: 23, runwayClass: 'short_runway', sessionsPerWeek: 2, maximumHardLowerBodyDaysPerRollingSeven: 2, equipment: [], missingEquipment: [] },
          goals: [
            { kind: 'hyrox', raceId: savedHyrox.id, name: savedHyrox.race_name, eventLocalDate: savedHyrox.event_local_date, division: savedHyrox.event_format, category: savedHyrox.event_category, goalTimeSeconds: savedHyrox.goal_time_seconds },
            { kind: 'run_race', raceId: army.id, name: army.race_name },
          ],
          weeks: [{ week: 1, phase: 'post_hyrox_recovery', days: [] }],
        } },
      })],
      ['POST /api/plans/candidates/hyrox-army-candidate/apply', () => {
        applied = true
        return { ok: true, plan_id: 'hyrox-army-plan', user_plan_id: 'assignment-hyrox-army' }
      }],
    ]),
  })

  await page.goto('/races')
  await page.getByLabel('Manage HYROX Washington DC').getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByLabel('Format / division').selectOption('doubles')
  await page.getByLabel('Target finish time hours').selectOption('0')
  await page.getByLabel('Target finish time minutes').selectOption('59')
  await page.getByLabel('Target finish time seconds').selectOption('0')
  await expect(page.getByLabel('Optional secondary running race')).toHaveValue(army.id)
  await page.getByRole('button', { name: 'Preview combined HYROX plan', exact: true }).click()
  await page.getByRole('button', { name: 'Apply reviewed HYROX plan', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'Update your HYROX plan' })).toHaveCount(0)
  await expect(page.getByText('HYROX Washington DC and the reviewed HYROX calendar are updated.', { exact: true })).toBeVisible()
  expect(savedHyrox.event_format).toBe('doubles')
  expect(savedHyrox.event_category).toBe('men')
  expect(savedHyrox.goal_time_seconds).toBe(3540)
  expect(requestsFor(apiState, 'POST', '/api/plans/candidates/hyrox-army-candidate/apply')).toHaveLength(1)
  expect(requestsFor(apiState, 'GET', '/api/plans/my').length).toBeGreaterThanOrEqual(3)
  await expect(page.locator('body')).not.toHaveCSS('overflow-x', 'scroll')
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('the current plan item opens its existing calendar without changing navigation or plan state', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const plan = {
    id: 'current-plan-navigation',
    name: 'Current Army Ten-Miler plan',
    type: 'run_only',
    weeks: 1,
    plan_data: {
      schemaVersion: 2,
      planMode: 'run_only',
      goal: { name: 'Army Ten-Miler', dateISO: today, distanceMiles: 10 },
      weeks: [{
        week: 1,
        phase: 'base',
        startDate: today,
        days: [{ date: today, day: todayDay, sessions: [{ id: plannedRun.id, kind: 'run', prescription: plannedRun }] }],
      }],
    },
  }
  const proposal = {
    id: 'current-plan-spacing',
    status: 'proposal',
    decisionStatus: 'pending',
    headline: 'Review this calendar adjustment',
    reason: 'The current calendar and manage controls keep their standard spacing.',
    evidence: [],
    changes: [{
      date: today,
      sessionId: plannedRun.id,
      before: { title: 'Tempo run' },
      after: { title: 'Easy aerobic run' },
      summary: 'Intensity reduced for recovery.',
    }],
  }
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/my', { plan, user_plan: { current_week: 1, started_at: today, progress: { completedSessionIds: [] } } }],
      ['GET /api/plans/adaptation/current', { proposal }],
    ]),
  })

  await page.goto('/run')
  await page.locator('a[href="/plan"]').first().click()
  await expect(page).toHaveURL(/\/plan$/)
  await page.getByRole('button', { name: 'Manage plan', exact: true }).click()

  const section = page.locator('#current-plan-calendar')
  const heading = section.getByRole('heading', { name: 'Army Ten-Miler', exact: true })
  const currentPlanItem = page.getByRole('button', { name: plan.name, exact: true })
  await expect(currentPlanItem).toBeVisible()
  await expect(currentPlanItem.locator('a, button')).toHaveCount(0)
  await expect(currentPlanItem).toHaveAttribute('aria-describedby', 'current-plan-action-details')
  await expect(page.locator('#current-plan-action-details')).toHaveText(`${plan.type} · Week 1 of ${plan.weeks}`)

  const gaps = await page.evaluate(() => {
    const calendar = document.querySelector('#current-plan-calendar > .forged-cal')?.getBoundingClientRect()
    const adaptationButton = [...document.querySelectorAll('#current-plan-calendar > div > button')]
      .find((button) => button.textContent.includes('Review this calendar adjustment'))
    const adaptationPanel = adaptationButton?.parentElement?.getBoundingClientRect()
    const manageButton = [...document.querySelectorAll('#current-plan-calendar > div > button')]
      .find((button) => button.textContent.includes('Manage plan'))
    const managePanel = manageButton?.parentElement?.getBoundingClientRect()
    return {
      calendarToAdaptation: adaptationPanel && calendar ? adaptationPanel.top - calendar.bottom : null,
      adaptationToManage: managePanel && adaptationPanel ? managePanel.top - adaptationPanel.bottom : null,
    }
  })
  expect(gaps.calendarToAdaptation, 'Calendar and adaptation retain the base 16px vertical rhythm').toBeCloseTo(16, 1)
  expect(gaps.adaptationToManage, 'Adaptation and manage retain the base 16px vertical rhythm').toBeCloseTo(16, 1)

  const navigationSnapshot = () => page.evaluate(() => ({
    url: window.location.href,
    hash: window.location.hash,
    length: window.history.length,
    state: window.history.state,
  }))
  const beforeActivation = await navigationSnapshot()
  expect(beforeActivation.state, 'The in-app /run → /plan entry has router history state').not.toBeNull()

  const activateAndExpectUpwardScroll = async (activation) => {
    await currentPlanItem.evaluate((item) => item.scrollIntoView({ behavior: 'auto', block: 'center' }))
    await currentPlanItem.focus()
    const beforeScrollY = await page.evaluate(() => window.scrollY)
    expect(beforeScrollY, `${activation} starts below the current-plan heading`).toBeGreaterThan(0)

    if (activation === 'click') await currentPlanItem.click()
    else await page.keyboard.press('Enter')

    await expect(section).toBeFocused()
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(beforeScrollY)
    await expect.poll(() => section.evaluate((element) => {
      const sectionTop = element.getBoundingClientRect().top
      const scrollMarginTop = Number.parseFloat(getComputedStyle(element).scrollMarginTop) || 0
      return Math.abs(sectionTop - scrollMarginTop) < 1
    }), { message: `${activation} settles at the mobile-safe current-plan offset` }).toBe(true)
    const headingTop = await heading.evaluate((element) => element.getBoundingClientRect().top)
    expect(headingTop, `${activation} brings the current-plan heading into the upper viewport`).toBeGreaterThanOrEqual(0)
    expect(headingTop, `${activation} brings the current-plan heading into the upper viewport`).toBeLessThan(page.viewportSize().height / 2)
  }

  await activateAndExpectUpwardScroll('click')
  await activateAndExpectUpwardScroll('Enter')

  const afterRepeatedActivation = await navigationSnapshot()
  expect(afterRepeatedActivation).toEqual(beforeActivation)

  await page.goBack()
  await expect(page).toHaveURL(/\/run$/)

  await page.locator('a[href="/plan"]').first().click()
  await page.getByRole('button', { name: 'Manage plan', exact: true }).click()
  await currentPlanItem.click()
  const beforeSwipe = await navigationSnapshot()
  expect(beforeSwipe.state, 'Activation preserves non-null router state for swipe-back').not.toBeNull()
  await page.evaluate(() => {
    const target = document.querySelector('main')
    const touchAt = (x) => new Touch({ identifier: 1, target, clientX: x, clientY: 240 })
    window.dispatchEvent(new TouchEvent('touchstart', { touches: [touchAt(4)], bubbles: true }))
    window.dispatchEvent(new TouchEvent('touchmove', { touches: [touchAt(110)], bubbles: true, cancelable: true }))
    window.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touchAt(110)], bubbles: true }))
  })
  await expect(page).toHaveURL(/\/run$/)

  const planWrites = apiState.requests.filter((request) => (
    request.pathname.startsWith('/api/plans/') && request.method !== 'GET'
  ))
  expect(planWrites, 'Opening the active plan must not replace, create, delete, or advance it').toEqual([])
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('Weekly Run Brief preserves mobile naming, recorded-run provenance, prescribed recovery, and Gear target size', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const anchor = new Date(`${today}T12:00:00`)
  const monday = new Date(anchor)
  monday.setDate(anchor.getDate() - ((anchor.getDay() + 6) % 7))
  const todayIndex = (anchor.getDay() + 6) % 7
  const isoAt = (offset) => {
    const date = new Date(monday)
    date.setDate(monday.getDate() + offset)
    return localDateISO(date)
  }
  const availableIndexes = [0, 1, 2, 3, 4, 5, 6].filter((index) => index !== todayIndex)
  const hyroxIndex = availableIndexes[0]
  const recoveryIndex = availableIndexes[1]
  const restIndex = availableIndexes[2]
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
  const transitionRest = 'Move deliberately; use 60-120 seconds between station blocks unless a shorter transition is prescribed.'
  const todayRun = {
    id: 'brief-threshold',
    removal_session_id: 'brief-threshold-remove',
    kind: 'run',
    type: 'threshold',
    title: 'Threshold repeats',
    distance_miles: 5,
    distance_is_estimate: true,
    duration_min: 52,
    prescription: {
      type: 'threshold',
      title: 'Threshold repeats',
      purpose: 'Build sustainable speed without racing the workout.',
      target_zone: 'Zone 3-4',
      pace_target: 'Controlled threshold effort',
      surface: 'trail',
      warmup: ['10 min easy', '3 × 20 sec relaxed strides'],
      steps: ['3 × 6 min controlled', '2 min easy jog after each repeat'],
      recoveries: '2 min easy jog',
      cooldown: ['10 min easy', 'Walk until breathing settles'],
    },
  }
  const hyroxSession = {
    id: 'brief-hyrox',
    kind: 'hyrox',
    sessionType: 'hyrox_compromised_running',
    title: 'HYROX compromised running',
    durationMin: 45,
    purpose: 'Practice deliberate transitions without turning rest into optional work.',
    transitionRest,
    canonicalUnits: 'metric',
    runSequenceMeters: [1000],
    stationSequence: [{ id: 'row', name: 'Row', distanceMeters: 1000, exactStation: true, officialStandard: { distanceMeters: 1000 } }],
  }
  const recoveryRun = {
    id: 'brief-recovery',
    kind: 'run',
    type: 'recovery',
    title: 'Recovery run',
    distance_miles: 3,
    duration_min: 32,
    prescription: {
      type: 'recovery',
      title: 'Recovery run',
      target_zone: 'Zone 1-2',
      pace_target: 'Fully conversational',
      warmup: ['5 min easy walking'],
      steps: ['Stay in Zone 1-2 and keep the effort relaxed'],
      recovery: 'Walk as needed before continuing.',
      cooldown: ['5 min easy walking'],
    },
  }
  const liftSession = {
    id: 'brief-lift',
    removal_session_id: 'brief-lift-remove',
    kind: 'lift',
    type: 'strength',
    title: 'Strength maintenance',
    duration_min: 40,
    prescription: {
      focus: 'full body',
      warmup: ['Bodyweight squat × 10'],
      exercises: [{
        name: 'Rear-Foot-Elevated Split Squat',
        sets: 3,
        reps: '6 each side',
        rpe: '7',
        rest: '90 sec',
        load: 'Choose load for RPE 7',
        cue: 'Keep the front foot planted and torso controlled.',
        progression: 'Add load only after every rep stays stable.',
      }],
      recovery: ['Walk 3 min, then refuel.'],
      progression: 'Repeat the same dose before adding a set.',
    },
  }
  const sessionsByIndex = new Map([
    [todayIndex, [todayRun, liftSession]],
    [hyroxIndex, [hyroxSession]],
    [recoveryIndex, [recoveryRun]],
  ])
  const plan = {
    id: 'weekly-brief-truth-plan',
    name: 'Weekly brief truth plan',
    type: 'hybrid_maintain',
    weeks: 1,
    plan_data: {
      schemaVersion: 2,
      planMode: 'hybrid_maintain',
      goal: { name: 'Autumn Half Marathon', dateISO: isoAt(45), distanceMiles: 13.1 },
      weeks: [{
        week: 1,
        phase: 'build',
        startDate: isoAt(0),
        purpose: 'Keep every weekly summary tied to the saved prescription.',
        days: labels.map((day, index) => ({ date: isoAt(index), day, sessions: sessionsByIndex.get(index) || [] })),
      }],
    },
  }
  const recordedRun = {
    id: 'brief-unscheduled-run',
    type: 'easy',
    date: isoAt(restIndex),
    distance_miles: 3.2,
    duration_seconds: 1920,
    plan_session_id: null,
  }
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/my', { plan, user_plan: { current_week: 1, started_at: isoAt(0), progress: { completedSessionIds: [] } } }],
      ['GET /api/plans/today', executionWith({ run: todayRun, lift: liftSession })],
      ['GET /api/runs', [recordedRun]],
      ['GET /api/gear/shoes', { shoes: [{
        id: 'brief-road-racer', brand: 'Forge Test', model: 'Road Racer', category: 'race', surface: 'road', intent_tags: [],
        total_miles: 20, recommended_miles: 200, is_active: 1, is_retired: 0,
      }] }],
      ['GET /api/profile/hr-zones', {
        profile: { source: 'manual_watch', zoneModel: 'hrr' },
        zones: [
          { zone: 1, minBpm: 120, maxBpm: 134 },
          { zone: 2, minBpm: 134, maxBpm: 148 },
          { zone: 3, minBpm: 148, maxBpm: 162 },
          { zone: 4, minBpm: 162, maxBpm: 176 },
          { zone: 5, minBpm: 176, maxBpm: 190 },
        ],
      }],
    ]),
  })

  await page.goto('/plan')
  const brief = page.getByRole('region', { name: 'Weekly Run Brief' })
  await expect(brief).toBeVisible()
  await expect.soft(brief.getByText('~8.0 mi', { exact: true }), 'F7 weekly total retains an estimate marker').toBeVisible()

  const missionTitle = await brief.locator('.forged-mission-copy strong').textContent()
  const todayRowTitle = await page.locator('.forged-day-row[data-today] .forged-day-title').textContent()
  expect.soft(todayRowTitle, 'F6 week row and mission use the same canonical session name').toBe(missionTitle)

  const restRow = page.locator('.forged-day-row').filter({ hasText: 'Recorded run' })
  await expect.soft(restRow, 'F5 rest-day recorded mileage remains visible').toContainText('3.20 mi')
  await expect.soft(restRow, 'F5 unlinked rest-day provenance remains visible').toContainText('Not scheduled')

  await brief.locator('.forged-gear-warning > summary').click()
  const updateGear = brief.getByRole('link', { name: 'Update Gear' })
  const gearBox = await updateGear.boundingBox()
  expect.soft(gearBox?.height || 0, 'F8 standalone Update Gear link is at least 44px high').toBeGreaterThanOrEqual(44)
  expect.soft(gearBox?.width || 0, 'F8 standalone Update Gear link is at least 44px wide').toBeGreaterThanOrEqual(44)
  const weekLayout = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
  expect.soft(weekLayout.scroll, 'F5/F8 weekly mobile view has no horizontal overflow').toBeLessThanOrEqual(weekLayout.viewport)

  await brief.locator('.forged-mission-card').click()
  const dayBrief = page.getByRole('region', { name: String(missionTitle || '').trim(), exact: true })
  const runSection = page.getByRole('button', { name: 'Start Run', exact: true }).locator('xpath=ancestor::section[1]')
  await expect(dayBrief.getByText(String(missionTitle || '').trim(), { exact: true })).toBeVisible()
  await expect(dayBrief.getByText('Zones 3–4 · 148–176 bpm', { exact: true })).toBeVisible()
  await expect(runSection.getByText('Warm-up', { exact: true })).toBeVisible()
  await expect(runSection.getByText('Structure', { exact: true })).toBeVisible()
  await expect(runSection.getByText('Recoveries: 2 min easy jog', { exact: true })).toBeVisible()
  await expect(runSection.getByText('Cool-down', { exact: true })).toBeVisible()
  await expect(runSection.getByText('~5.0 mi estimated', { exact: true })).toBeVisible()
  await expect(runSection.getByText('Controlled threshold effort', { exact: true })).toBeVisible()
  await expect(runSection.getByText('Zone 3-4', { exact: true })).toBeVisible()
  await expect(runSection.getByRole('button', { name: 'Start Run', exact: true })).toBeVisible()
  await expect(runSection.getByRole('button', { name: /Remove Threshold repeats from this plan/i })).toBeVisible()
  await expect(runSection.getByRole('button', { name: /Export watch workout/i })).toBeVisible()
  await expect(runSection.getByRole('button', { name: /Copy workout/i })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth))

  await page.getByRole('button', { name: 'Calendar' }).click()
  await page.locator('.forged-day-row').filter({ hasText: hyroxSession.title }).click()
  await expect(page.getByText(transitionRest, { exact: false }).first()).toBeVisible()
  await expect.soft(page.getByRole('heading', { name: 'Optional recovery' }), 'F3 prescribed HYROX transition rest is never optional').toHaveCount(0)
  await expect.soft(page.getByText(transitionRest, { exact: false }), 'F3 HYROX transition rest is not duplicated under contradictory labels').toHaveCount(1)

  await page.getByRole('button', { name: 'Calendar' }).click()
  await page.locator('.forged-day-row').filter({ hasText: 'Recovery run' }).click()
  await expect(page.getByText('Recoveries: Walk as needed before continuing.', { exact: true })).toBeVisible()
  await expect.soft(page.getByRole('heading', { name: 'Optional recovery' }), 'F3 prescribed run recovery is never optional').toHaveCount(0)
  expect.soft(await page.evaluate(() => document.documentElement.scrollWidth), 'F3 recovery day has no mobile overflow')
    .toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth))

  await page.getByRole('button', { name: 'Calendar' }).click()
  await page.locator('.forged-day-row').filter({ hasText: 'Full Body strength' }).click()
  const liftSection = page.getByRole('button', { name: 'Start Lift', exact: true }).locator('xpath=ancestor::section[1]')
  const strengthRecipe = liftSection.locator('.forged-exercise').filter({ hasText: 'Rear-Foot-Elevated Split Squat' })
  await expect(strengthRecipe).toContainText('Sets3')
  await expect(strengthRecipe).toContainText('Reps6 each side')
  await expect(strengthRecipe).toContainText('Rest90 sec')
  await expect(strengthRecipe).toContainText('LoadChoose load for RPE 7')
  await expect(strengthRecipe).toContainText('RPE/RIR7')
  await expect(strengthRecipe).toContainText('Keep the front foot planted and torso controlled.')
  await expect(strengthRecipe).toContainText('Add load only after every rep stays stable.')
  await expect(liftSection.getByText('Session progression: Repeat the same dose before adding a set.', { exact: true })).toBeVisible()
  await expect(liftSection.getByText('Walk 3 min, then refuel.', { exact: true })).toBeVisible()
  await expect(liftSection.getByRole('button', { name: 'Start Lift', exact: true })).toBeVisible()
  const removeStrength = liftSection.getByRole('button', { name: /Remove Strength maintenance from this plan/i })
  await expect(removeStrength).toBeVisible()
  await expect(liftSection.getByRole('button', { name: /Export watch workout/i })).toBeVisible()
  await expect(liftSection.getByRole('button', { name: /Copy workout/i })).toBeVisible()

  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('HYROX relay race day shows athlete scope and official team station loads', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const station = (id, name, officialStandard) => ({
    id,
    name,
    exactStation: true,
    readinessClaim: 'official_race_standard',
    officialStandard,
  })
  const officialTeamStationSequence = [
    station('ski_erg', 'SkiErg', { distanceMeters: 1000 }),
    station('sled_push', 'Sled push', { distanceMeters: 50, loadKgIncludingSled: 102 }),
    station('sled_pull', 'Sled pull', { distanceMeters: 50, loadKgIncludingSled: 78 }),
    station('burpee_broad_jump', 'Burpee broad jumps', { distanceMeters: 80 }),
    station('row', 'Row', { distanceMeters: 1000 }),
    station('farmers_carry', 'Farmers carry', { distanceMeters: 200, implements: 2, loadKgPerImplement: 16 }),
    station('sandbag_lunge', 'Sandbag lunges', { distanceMeters: 100, loadKg: 10 }),
    station('wall_ball', 'Wall balls', { repetitions: 100, ballKg: 4, targetHeightMeters: 2.7 }),
  ]
  const relayRace = {
    id: 'hyrox-relay-race-day',
    kind: 'hyrox',
    sessionType: 'hyrox_race',
    title: 'HYROX Relay race',
    purpose: 'Complete this athlete’s assigned relay scope while the team covers the full official order.',
    eventFormat: 'relay',
    participationScope: 'relay_athlete',
    canonicalUnits: 'metric',
    runSequenceMeters: [1000, 1000],
    distanceMeters: 2000,
    distance_miles: 1.24,
    stationSequence: [],
    athleteStationAssignment: {
      stationCount: 2,
      status: 'team_assignment_required',
      instruction: 'Confirm this athlete’s two stations with the relay team before race day.',
    },
    officialTeamStationSequence,
  }
  const plan = {
    id: 'hyrox-relay-plan',
    name: 'HYROX Relay plan',
    type: 'hyrox',
    weeks: 1,
    plan_data: {
      schemaVersion: 2,
      planMode: 'hyrox_build',
      goal: { name: 'HYROX Relay', dateISO: today, kind: 'hyrox', division: 'relay', category: 'women' },
      weeks: [{
        week: 1,
        phase: 'taper_race',
        startDate: today,
        days: [{ date: today, day: todayDay, sessions: [relayRace] }],
      }],
    },
  }
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/my', { plan, user_plan: { current_week: 1, started_at: today, progress: { completedSessionIds: [] } } }],
    ]),
  })

  await page.goto('/plan')
  await page.locator('button').filter({ hasText: 'HYROX Relay race' }).first().click()
  await expect(page.getByText('Athlete scope: 2 × 1,000 m run + 2 team-assigned stations.', { exact: false })).toBeVisible()
  await expect(page.getByText('Official team station order — assign two stations to this athlete', { exact: true })).toBeVisible()
  await expect(page.getByText('102 kg including sled', { exact: false })).toBeVisible()
  await expect(page.getByText('2 × 16 kg', { exact: false })).toBeVisible()
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('active plan run days can be edited and rebuilt without returning to plan setup', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  let plan = {
    id: 'schedule-plan',
    name: 'Army Ten-Miler plan',
    type: 'hybrid_maintain',
    weeks: 1,
    plan_data: {
      schemaVersion: 2,
      planMode: 'hybrid_maintain',
      schedulePreferences: {
        runDaysPerWeek: 3,
        trainingDays: ['Tue', 'Thu', 'Sat'],
        runDaysSource: 'target',
        trainingDaysSource: 'target',
      },
      strengthPolicy: { enabled: true, sessionsPerWeek: 2, goal: 'maintain', equipment: ['dumbbells'] },
      goal: { name: 'Army Ten-Miler', dateISO: today, distanceMiles: 10, goalTimeSeconds: 5400 },
      weeks: [{
        week: 1,
        phase: 'base',
        startDate: today,
        days: [{ date: today, day: todayDay, sessions: [{ id: plannedRun.id, kind: 'run', prescription: plannedRun }] }],
      }],
    },
  }
  const userPlan = { current_week: 1, started_at: today, progress: { completedSessionIds: [] } }
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/my', () => ({ plan, user_plan: userPlan })],
      ['POST /api/plans/generate', ({ body }) => {
        plan = {
          ...plan,
          plan_data: {
            ...plan.plan_data,
            schedulePreferences: {
              runDaysPerWeek: body.target.runDaysPerWeek,
              trainingDays: body.target.trainingDays,
              runDaysSource: 'target',
              trainingDaysSource: 'target',
            },
          },
        }
        return { plan, user_plan_id: 'schedule-user-plan', generation_source: 'evidence_engine' }
      }],
    ]),
  })

  await page.goto('/plan')
  await page.getByRole('button', { name: 'Manage plan', exact: true }).click()
  await expect(page.getByText('3 run days · Tue, Thu, Sat', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Edit days', exact: true }).click()
  await page.getByRole('button', { name: 'Sun', exact: true }).click()
  await page.getByLabel('Runs each week').selectOption('4')
  await expect(page.getByText(/Four days separate quality, easy, steady, and long work/)).toBeVisible()
  await page.getByRole('button', { name: 'Rebuild remaining calendar', exact: true }).click()

  await expect(page.getByText('4 run days · Tue, Thu, Sat, Sun', { exact: true })).toBeVisible()
  const requests = requestsFor(apiState, 'POST', '/api/plans/generate')
  expect(requests).toHaveLength(1)
  expect(requests[0].body.target).toMatchObject({
    runDaysPerWeek: 4,
    trainingDays: ['Tue', 'Thu', 'Sat', 'Sun'],
    planMode: 'hybrid_maintain',
    liftingEnabled: true,
    liftDaysPerWeek: 2,
    distanceMiles: 10,
    goalTimeSeconds: 5400,
  })
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('two-race schedule rebuild preserves both goals when the race list is empty', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  let plan = {
    id: 'dual-race-schedule-plan',
    name: 'Yonkers + Army plan',
    type: 'hybrid_maintain',
    weeks: 1,
    plan_data: {
      schemaVersion: 2,
      planMode: 'hybrid_maintain',
      schedulePreferences: { runDaysPerWeek: 3, trainingDays: ['Tue', 'Thu', 'Sat'] },
      strengthPolicy: { enabled: true, sessionsPerWeek: 2, goal: 'maintain', equipment: ['dumbbells'] },
      goals: [
        { raceId: 'yonkers-half', name: 'Yonkers Half Marathon', date: today, distanceMiles: 13.1 },
        { raceId: 'army-ten', name: 'Army Ten-Miler', date: today, distanceMiles: 10 },
      ],
      weeks: [{
        week: 1,
        phase: 'base',
        startDate: today,
        days: [{ date: today, day: todayDay, sessions: [{ id: plannedRun.id, kind: 'run', prescription: plannedRun }] }],
      }],
    },
  }
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/my', () => ({ plan, user_plan: { current_week: 1, started_at: today, progress: { completedSessionIds: [] } } })],
      ['POST /api/plans/generate-for-races', ({ body }) => {
        plan = {
          ...plan,
          plan_data: {
            ...plan.plan_data,
            schedulePreferences: {
              runDaysPerWeek: body.target.runDaysPerWeek,
              trainingDays: body.target.trainingDays,
            },
          },
        }
        return { plan, user_plan_id: 'dual-race-user-plan', generation_source: 'evidence_engine' }
      }],
    ]),
  })

  await page.goto('/plan')
  await page.getByRole('button', { name: 'Manage plan', exact: true }).click()
  await page.getByRole('button', { name: 'Edit days', exact: true }).click()
  await page.getByRole('button', { name: 'Sun', exact: true }).click()
  await page.getByLabel('Runs each week').selectOption('4')
  await page.getByRole('button', { name: 'Rebuild remaining calendar', exact: true }).click()

  await expect(page.getByText('4 run days · Tue, Thu, Sat, Sun', { exact: true })).toBeVisible()
  const requests = requestsFor(apiState, 'POST', '/api/plans/generate-for-races')
  expect(requests).toHaveLength(1)
  expect(requests[0].body.race_ids).toEqual(['yonkers-half', 'army-ten'])
  expect(requestsFor(apiState, 'POST', '/api/plans/generate-for-race/yonkers-half')).toHaveLength(0)
  expect(requestsFor(apiState, 'POST', '/api/plans/generate')).toHaveLength(0)
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('v2.4 preview stays review-only and exposes canonical truth on both mobile projects', async ({ page }, testInfo) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const planFixture = goalBackwardV24PlanFixture({
    dateISO: today,
    day: todayDay,
    featureMode: 'preview',
    safetyAction: 'NO_RUNNING',
    safetyScope: ['RUN', 'IMPACT'],
    safetyReasonCodes: ['NO_RUNNING', 'MATERIAL_CHANGE_REVIEW_REQUIRED'],
    executability: 'RESTRICTED',
    capability: 'FULLY_STRUCTURED',
  })
  const proposal = {
    id: 'adaptation-v24-mobile-preview',
    revision: 'adaptation-v24-mobile-preview-r1',
    planVersion: 7,
    status: 'proposal',
    decisionStatus: 'pending',
    safetyException: true,
    headline: 'Review your v2.4 preview',
    reason: 'Fresh scoped safety evidence changed an executable run and requires explicit review.',
    evidence: [{
      source: 'injury',
      objective: false,
      freshness: 'fresh',
      detail: 'Synthetic impact restriction applies to running only.',
    }],
    changes: [{
      date: today,
      sessionId: 'v24-mobile-run-session',
      before: { title: 'Canonical four mile run', distance_miles: 4 },
      after: { title: 'Run held by scoped safety', duration_min: 0 },
      summary: 'The active calendar remains unchanged until this preview is reviewed.',
    }],
  }
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/my', planFixture],
      ['GET /api/plans/adaptation/current', { proposal }],
    ]),
  })

  await page.goto('/plan')
  expect(page.viewportSize()).toEqual(testInfo.project.use.viewport)
  await expect(page.getByRole('heading', { name: 'Review your v2.4 preview' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Accept', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Keep original', exact: true })).toBeVisible()
  await expect(page.getByText('The active calendar remains unchanged until this preview is reviewed.')).toBeVisible()

  const manifestSummary = page.locator('summary').filter({ hasText: 'Plan details and export readiness' })
  await expect(manifestSummary).toBeVisible()
  await manifestSummary.click()
  await expect(page.getByText(/No running · Running, Impact activity · No running · Review required because the plan changed materially/)).toBeVisible()
  await expect(page.getByText(/Main workout · Fully supported/).first()).toBeVisible()
  await expect(page.getByText(/Prescription sources: 1 accepted source · Restricted by safety guidance/).first()).toBeVisible()
  await expect(page.getByText(/Event-specific development phase/).first()).toBeVisible()
  const previewCustomerCopy = await openAllTechnicalVerificationAndReadBody(page)
  await expect(page.getByText(/Plan 7 · surface 3/)).toBeVisible()
  expect(previewCustomerCopy.count).toBeGreaterThanOrEqual(1)
  expect(previewCustomerCopy.text, 'Rendered preview copy, including open technical details, contains no underscore symbol').not.toContain('_')
  expect(previewCustomerCopy.text, 'Rendered preview copy contains no raw closed enum token').not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/)
  await expect.poll(() => page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }))).toMatchObject({ viewport: testInfo.project.use.viewport.width })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  expect(requestsFor(apiState, 'POST', '/api/plans/adaptation/adaptation-v24-mobile-preview/accept')).toHaveLength(0)
  expect(requestsFor(apiState, 'POST', '/api/plans/adaptation/adaptation-v24-mobile-preview/keep')).toHaveLength(0)
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('v2.4 full-rest safety and manual capability stay fail-closed on both mobile projects', async ({ page }, testInfo) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const planFixture = goalBackwardV24PlanFixture({
    dateISO: today,
    day: todayDay,
    featureMode: 'on',
    safetyAction: 'FULL_REST',
    safetyScope: ['ALL'],
    safetyReasonCodes: ['FULL_REST'],
    executability: 'NOT_EXECUTABLE',
    workoutFamily: 'hyrox_station_skill',
    capability: 'MANUAL_COMPONENTS_REQUIRED',
  })
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/my', planFixture],
      ['GET /api/plans/adaptation/current', { proposal: null }],
    ]),
  })

  await page.goto('/plan')
  expect(page.viewportSize()).toEqual(testInfo.project.use.viewport)
  const manifestSummary = page.locator('summary').filter({ hasText: 'Plan details and export readiness' })
  await expect(manifestSummary).toBeVisible()
  await manifestSummary.click()
  await expect(page.getByText(/Full rest · All training · Full rest/)).toBeVisible()

  await page.getByRole('button', { name: /Today's mission Canonical station skill/ }).click()
  await expect(page.locator('.forged-day-brief-purpose')).toHaveText('This key training stimulus is required')
  const canonicalDetails = page.locator('summary').filter({ hasText: 'Workout details and export readiness' }).last()
  await expect(canonicalDetails).toBeVisible()
  await canonicalDetails.click()
  await expect(page.getByText(/Role: Supporting session · Capability: Manual setup required/).last()).toBeVisible()
  await expect(page.getByText(/Availability: Cannot be started or exported/).last()).toBeVisible()
  await expect(page.getByText(/Safety: All training · Cannot be started or exported/).last()).toBeVisible()
  await expect(page.getByText(/Goal-based target selection · Medium confidence · Count · 1 accepted evidence source/).last()).toBeVisible()
  await expect(page.getByText(/Event-specific development · HYROX build/)).toBeVisible()
  const fullRestCustomerCopy = await openAllTechnicalVerificationAndReadBody(page)
  await expect(page.getByText(/Revisions: Session 4 · plan 7/).last()).toBeVisible()
  await expect(page.getByText(/Policy: Goal-based target selection · version 1\.0\.0 · 1 accepted evidence source/).last()).toBeVisible()
  expect(fullRestCustomerCopy.count).toBeGreaterThanOrEqual(2)
  expect(fullRestCustomerCopy.text, 'Rendered full-rest copy, including open technical details, contains no underscore symbol').not.toContain('_')
  expect(fullRestCustomerCopy.text, 'Rendered full-rest copy contains no raw closed enum token').not.toMatch(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/)
  await expect(page.getByRole('button', { name: /Start (Run|Lift)/ })).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }))).toMatchObject({ viewport: testInfo.project.use.viewport.width })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})
