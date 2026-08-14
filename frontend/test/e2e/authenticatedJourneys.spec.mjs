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

test('planned rest day does not prompt for a readiness check-in', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/today', restExecution()],
    ]),
  })

  await page.goto('/')
  await expect(page.getByRole('heading', { name: "Review today's plan" })).toBeVisible()
  await expect(page.getByText('Rest and recovery are scheduled today. No check-in is needed unless you choose to train.', { exact: true })).toBeVisible()
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
  await expect(page.getByRole('heading', { name: 'Morning Check-In Required' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Go to Check-In' })).toBeVisible()

  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('unscheduled rest guidance asks for a current check-in without claiming scheduled rest', async ({ page }) => {
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
  await expect(page.getByRole('button', { name: 'Check in', exact: true })).toBeVisible()
  await expect(page.getByText('An extra run is already logged today. Recovery is still the guidance for today.', { exact: true })).toBeVisible()
  await expect(page.getByText(/Rest and recovery are scheduled today/)).toHaveCount(0)

  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('check-in recovery remains guidance and never offers the rest-labelled run', async ({ page }) => {
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
  await expect(page.getByRole('button', { name: 'Edit check-in', exact: true }).last()).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Recovery is the plan today' })).toHaveCount(0)

  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('legacy empty check-in rest stays truthful and closes every workout handoff', async ({ page }) => {
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
  await expect(page.getByRole('button', { name: 'Edit check-in', exact: true })).toBeVisible()
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
  expect([320, 393]).toContain(page.viewportSize()?.width)
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
  await expect(page.getByRole('button', { name: 'Edit check-in', exact: true })).toBeVisible()
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
  expect([320, 393]).toContain(page.viewportSize()?.width)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth))
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('submitting a safety check-in cannot turn its rest-labelled run slot into Prepare to Run', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  let checkinSaved = false
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/checkin/today', () => checkinSaved ? {
        feeling: 3,
        legs: 3,
        drive: 3,
        sleep_hours: null,
        life_flags: ['sick'],
      } : null],
      ['POST /api/checkin/preview', {
        headline: 'Recovery is the safer call today.',
        drivers: [{ label: 'Not well', detail: 'Training is paused while you are not feeling well.' }],
      }],
      ['POST /api/checkin', (request) => {
        checkinSaved = true
        expect(request.body).toMatchObject({ legs: 3, drive: 3, time_available: 45, life_flags: ['sick'] })
        return {
          headline: 'Recovery is the safer call today.',
          adjustment: 'Rest day from today\'s check-in.',
          drivers: [{ label: 'Not well', detail: 'Training is paused while you are not feeling well.' }],
        }
      }],
      ['GET /api/plans/today', checkinRecoveryExecution()],
    ]),
  })

  await page.goto('/checkin')
  await page.getByRole('button', { name: 'Fresh', exact: true }).click()
  await page.getByRole('button', { name: 'Fired up', exact: true }).click()
  await page.getByRole('button', { name: '45 min', exact: true }).click()
  await page.getByRole('button', { name: 'Not well', exact: true }).click()
  await page.getByRole('button', { name: 'Done', exact: true }).click()

  await expect(page.getByRole('button', { name: 'View Today', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Prepare to Run', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start Warm-Up', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Skip, start the run', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'View Today', exact: true }).click()
  await expect(page.getByRole('button', { name: 'View recovery', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'View recovery', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit check-in', exact: true }).last()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start run', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start lift', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Map route', exact: true })).toHaveCount(0)

  expect(requestsFor(apiState, 'POST', '/api/checkin')).toHaveLength(1)
  assertCleanApiAndRuntime(apiState, runtimeErrors)
})

test('lift-only safety rest cannot expose strength or workout starts even with a stale lift payload', async ({ page }) => {
  const runtimeErrors = collectRuntimeErrors(page)
  let checkinSaved = false
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/checkin/today', () => checkinSaved ? {
        feeling: 3,
        legs: 3,
        drive: 3,
        sleep_hours: null,
        life_flags: ['sick'],
      } : null],
      ['POST /api/checkin/preview', {
        headline: 'Recovery is the safer call today.',
        drivers: [{ label: 'Not well', detail: 'Training is paused while you are not feeling well.' }],
      }],
      ['POST /api/checkin', () => {
        checkinSaved = true
        return {
          action: 'rest',
          headline: 'Recovery is the safer call today.',
          adjustment: "Rest day from today's check-in.",
          drivers: [{ label: 'Not well', detail: 'Training is paused while you are not feeling well.' }],
        }
      }],
      // Deliberately retain a stale strength session while the canonical day
      // directive says rest. The phone must fail closed independently.
      ['GET /api/plans/today', liftOnlyCheckinRecoveryExecution({ patchSession: false })],
      ['GET /api/plans/my', activePlanWithTodaySessions([plannedLift])],
    ]),
  })

  await page.goto('/checkin')
  await page.getByRole('button', { name: 'Fresh', exact: true }).click()
  await page.getByRole('button', { name: 'Fired up', exact: true }).click()
  await page.getByRole('button', { name: '45 min', exact: true }).click()
  await page.getByRole('button', { name: 'Not well', exact: true }).click()
  await page.getByRole('button', { name: 'Done', exact: true }).click()

  await expect(page.getByRole('button', { name: 'View Today', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review Strength Workout', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start workout', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Start lift', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: 'View Today', exact: true }).click()
  await expect(page).not.toHaveURL(/\/log-lift/)
  await expect(page.getByRole('button', { name: 'View recovery', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'View recovery', exact: true }).click()
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
  expect([320, 393]).toContain(page.viewportSize()?.width)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth))

  expect(requestsFor(apiState, 'POST', '/api/checkin')).toHaveLength(1)
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
  expect([320, 393]).toContain(page.viewportSize()?.width)
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
  expect([320, 393]).toContain(page.viewportSize()?.width)
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
  expect([320, 393]).toContain(page.viewportSize()?.width)
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
  expect([320, 393]).toContain(page.viewportSize()?.width)
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
  expect([320, 393]).toContain(page.viewportSize()?.width)
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
  expect([320, 393]).toContain(page.viewportSize()?.width)
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
  const apiState = await installAuthenticatedApi(page, {
    responses: new Map([
      ['GET /api/plans/my', { plan, user_plan: { current_week: 1, started_at: today, progress: { completedSessionIds: [] } } }],
      ['GET /api/plans/adaptation/current', { proposal }],
      ['POST /api/plans/adaptation/journey-adaptation/keep', () => {
        keepAttempts += 1
        return keepAttempts === 1
          ? qaResponse({ queued: true, offline: true }, 202)
          : { ok: true, status: 'kept' }
      }],
    ]),
  })

  await page.goto('/plan')
  await expect(page.getByText('One transparent change', { exact: true })).toBeVisible()
  expect(requestsFor(apiState, 'POST', '/api/plans/adaptation/journey-adaptation/keep')).toHaveLength(0)
  await page.getByRole('button', { name: 'Keep original', exact: true }).click()
  await expect(page.getByText(/Forge did not save this choice immediately/)).toBeVisible()
  await expect(page.getByText('One transparent change', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Keep original', exact: true }).click()
  await expect(page.getByText('One transparent change', { exact: true })).toHaveCount(0)
  const keepRequests = requestsFor(apiState, 'POST', '/api/plans/adaptation/journey-adaptation/keep')
  expect(keepRequests).toHaveLength(2)
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
