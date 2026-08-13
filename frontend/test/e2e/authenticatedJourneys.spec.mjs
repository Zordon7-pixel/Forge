import { expect, test } from '@playwright/test'
import { createQaToken, installAuthenticatedApi, qaResponse } from './support/mockApi.mjs'

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

const today = localDateISO()
const todayDay = dayLabel()

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
  await page.getByRole('button', { name: 'Finish', exact: true }).click()

  await expect(page).toHaveURL(/\/$/)
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

test('check-in hands off through warm-up, run save, recovery check-in, and recap reload', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  let savedRun = null
  let checkInPayload = null
  const apiState = await installAuthenticatedApi(page, {
    user: { sex: 'female' },
    responses: new Map([
      ['POST /api/checkin/preview', { headline: 'Easy aerobic work fits today.', drivers: [{ label: 'Fresh legs' }] }],
      ['POST /api/checkin', { headline: 'Easy aerobic work fits today.', adjustment: 'Easy aerobic work fits today.', drivers: [{ label: 'Fresh legs', detail: 'No recovery limiter detected.' }] }],
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
      ['PATCH /api/runs/journey-run/check-in', (request) => {
        checkInPayload = request.body
        savedRun = { ...savedRun, ...request.body }
        return { run: savedRun, feedbackStatus: 'pending' }
      }],
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

  await page.goto('/checkin')
  await page.getByRole('button', { name: 'Fresh', exact: true }).click()
  await page.getByRole('button', { name: 'Fired up', exact: true }).click()
  await page.getByRole('button', { name: '45 min', exact: true }).click()
  await page.getByRole('button', { name: 'All good', exact: true }).click()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  await page.getByRole('button', { name: 'Prepare to Run', exact: true }).click()
  await page.getByRole('button', { name: 'Start Warm-Up', exact: true }).click()
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
  await expect(page.getByRole('heading', { name: 'How did that run feel?' })).toBeVisible()
  await page.getByRole('radio', { name: '5', exact: true }).click()
  await page.getByRole('radio', { name: 'None - felt great', exact: true }).click()
  await page.getByRole('radio', { name: 'Energized', exact: true }).click()
  await page.getByTestId('post-run-checkin-page-submit').click()
  await page.getByRole('status', { name: 'Run forged' }).click()
  await expect(page.getByRole('tab', { name: 'Summary' })).toBeVisible()

  expect(savedRun.plan_session_id).toBe(plannedRun.id)
  expect(checkInPayload).toEqual({ perceived_effort: 5, pain_level: 'none', post_energy: 'high' })
  expect(requestsFor(apiState, 'POST', '/api/runs')).toHaveLength(1)
  expect(requestsFor(apiState, 'PUT', '/api/plans/my/progress')).toHaveLength(1)
  expect(requestsFor(apiState, 'PATCH', '/api/runs/journey-run/check-in')).toHaveLength(1)

  await page.reload()
  await expect(page.getByRole('tab', { name: 'Summary' })).toBeVisible()
  expect(requestsFor(apiState, 'POST', '/api/runs')).toHaveLength(1)
  expect(requestsFor(apiState, 'PATCH', '/api/runs/journey-run/check-in')).toHaveLength(1)
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
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/my', { plan, user_plan: { current_week: 1, started_at: today, progress: { completedSessionIds: [] } } }],
      ['GET /api/plans/adaptation/current', { proposal }],
      ['POST /api/plans/adaptation/journey-adaptation/keep', { ok: true }],
    ]),
  })

  await page.goto('/plan')
  await expect(page.getByText('One transparent change', { exact: true })).toBeVisible()
  expect(requestsFor(apiState, 'POST', '/api/plans/adaptation/journey-adaptation/keep')).toHaveLength(0)
  await page.getByRole('button', { name: 'Keep original', exact: true }).click()
  await expect(page.getByText('One transparent change', { exact: true })).toHaveCount(0)
  expect(requestsFor(apiState, 'POST', '/api/plans/adaptation/journey-adaptation/keep')).toHaveLength(1)
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
  expect(requestsFor(apiState, 'POST', '/api/plans/adaptation/stale-adaptation/accept')).toHaveLength(1)
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
      ['GET /api/plans/my', {
        plan: { id: 'race-plan', plan_data: { schemaVersion: 2, goals: [{ raceId: race.id, name: race.race_name, dateISO: race.race_date }] } },
        user_plan: { current_week: 1, started_at: today, progress: {} },
      }],
      ['POST /api/races/yonkers-race/removal-preview', {
        requires_apply: true,
        candidate_id: 'remove-yonkers-candidate',
        candidate_hash: 'sha256:remove-yonkers',
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
