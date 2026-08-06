import { expect, test } from '@playwright/test'
import { createQaToken, installAuthenticatedApi } from './support/mockApi.mjs'

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
  main: [{ name: 'Goblet Squat', sets: 3, reps: '8', rest: '90 sec', cue: 'Brace before each rep.' }],
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
