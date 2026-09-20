import { expect, test } from '@playwright/test'
import { installAuthenticatedApi, qaLocalDateISO, qaResponse } from './support/mockApi.mjs'
import { deriveTravelTrainingChoices } from '../../src/lib/travelTraining.js'

const run = { id: 'near-me-run', kind: 'run', type: 'easy', distance_miles: 4, completed: false,
  steps: [{ step_id: 'synthetic-run', type: 'run', target: { duration_s: 1200, rpe_range: { minimum: 2, maximum: 4 } } }] }
const date = qaLocalDateISO()
const scheduled = { hasPlan: true, hasDay: true, isRest: false, date, week: 5, sessions: [run], run, lift: null }
const recovery = { ...scheduled, isRest: true, sessions: [], run: null }
const generatedRoute = { distanceMiles: '4.1', elevationPreference: 'flat', coordinates: [[40, -73], [40.001, -73.001]], elevationProfile: [], notice: 'Synthetic route only' }

async function openRun(page, { kind = 'scheduled', autoOpen = true, responses = [] } = {}) {
  const execution = kind === 'scheduled' ? scheduled : recovery
  const choices = deriveTravelTrainingChoices({ execution, readiness: { available: true, score: 80, band: 'GREEN' },
    adaptationProposal: { status: 'proposal', evidence: [{ signal: 'run_gap', daysSinceRun: 8 }] }, travelContext: { status: 'away' } })
  const choice = choices.choices.find(value => value.kind === `${kind}_run`)
  expect(choice).toBeTruthy()
  const state = await installAuthenticatedApi(page, { responses: [
    ['GET /api/plans/today', { today: { date, type: 'easy' }, execution }],
    ['GET /api/routes/planner-status', { available: true }],
    ['POST /api/routes/generate', { route: generatedRoute }],
    ...responses,
  ] })
  await page.route('https://*.tile.openstreetmap.org/**', route => route.fulfill({ status: 204 }))
  // Seed the actual TravelTrainingPrompt handoff using its choice derivation.
  await page.addInitScript(state => {
    if (location.pathname === '/log-run') history.replaceState({ usr: state, key: 'near-me', idx: 0 }, '')
  }, { ...choice.routeState, openRoutePlanner: autoOpen })
  await page.context().grantPermissions(['geolocation'])
  await page.context().setGeolocation({ latitude: 40, longitude: -73 })
  await page.goto('/log-run')
  return state
}

for (const kind of ['scheduled', 'recovery']) {
  test(`${kind} Run near me opens without losing the shell or workout identity`, async ({ page }) => {
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const api = await openRun(page, { kind })
    await expect(page.getByRole('button', { name: 'Generate route', exact: true })).toBeVisible()
    await expect(page.getByText(/Startup Error/)).toHaveCount(0)
    if (kind === 'scheduled') await expect(page.getByText('Run · 20 min · RPE: 2–4', { exact: false })).toBeVisible()
    const handoff = await page.evaluate(() => history.state.usr)
    expect(handoff.planSessionId).toBe(kind === 'scheduled' ? run.id : null)
    expect(handoff.currentWeek).toBe(kind === 'scheduled' ? 5 : null)
    await page.getByRole('button', { name: 'Generate route', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Start this route', exact: true })).toBeVisible()
    expect(api.requestsFor('POST', '/api/routes/generate')[0].body.distanceMiles).toBe(kind === 'scheduled' ? 4 : 2)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize().width + 1)
    await page.getByRole('button', { name: 'Manual', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Save Run', exact: true })).toBeVisible()
    expect(errors).toEqual([])
    expect(api.unexpectedRequests).toEqual([])
  })
}

test('normal collapsed route opening and malformed provider responses remain recoverable', async ({ page }) => {
  let attempts = 0
  const api = await openRun(page, { autoOpen: false, responses: [
    ['POST /api/routes/generate', () => ++attempts === 1 ? { route: { ...generatedRoute, coordinates: [[null, 0], [0, 1]] } } : { route: generatedRoute }],
    ['POST /api/routes/search-start', { places: [null] }],
  ] })
  await expect(page.getByRole('button', { name: 'Generate route', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Plan an elevation route' }).click()
  await page.getByRole('button', { name: 'Generate route', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('invalid route')
  await expect(page.getByRole('button', { name: 'Start this route' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Generate route', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start this route' })).toBeVisible()
  await page.getByRole('button', { name: 'Another place', exact: true }).click()
  await page.getByLabel('City, landmark, or address').fill('Synthetic park')
  await page.getByRole('button', { name: 'Search starting places' }).click()
  await expect(page.getByRole('alert')).toContainText('Please try again')
  await expect(page.getByRole('button', { name: 'Start Scheduled Run' })).toBeVisible()
  expect(api.unexpectedRequests).toEqual([])
})

test('availability and request failures expose local retry and preserve manual logging', async ({ page }) => {
  let attempts = 0
  await openRun(page, { responses: [
    ['GET /api/routes/planner-status', () => ++attempts === 1 ? qaResponse({ error: 'Unavailable' }, 503) : { available: true }],
    ['POST /api/routes/generate', qaResponse({ error: { invalid: true } }, 503)],
  ] })
  await page.getByRole('button', { name: 'Retry route availability' }).click()
  await page.getByRole('button', { name: 'Generate route', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.getByText(/Startup Error/)).toHaveCount(0)
  await page.getByRole('button', { name: 'Manual', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save Run', exact: true })).toBeVisible()
})

test('planner render exceptions stay inside the local boundary', async ({ page }) => {
  // A synthetic module throwing on render tests the boundary, independently of
  // provider validation. No application code or global boundary is replaced.
  await page.route('**/assets/RoutePlanner-*.js', route => route.fulfill({ contentType: 'text/javascript', body: 'export default function Planner(){if(!window.syntheticPlannerReady) throw new Error("Synthetic planner render failure"); return "Synthetic planner recovered"}' }))
  await openRun(page)
  await expect(page.getByRole('alert')).toContainText('route planner could not open')
  await expect(page.getByRole('button', { name: 'Retry route planner' })).toBeVisible()
  await page.evaluate(() => { window.syntheticPlannerReady = true })
  await page.getByRole('button', { name: 'Retry route planner' }).click()
  await expect(page.getByText('Synthetic planner recovered')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start Scheduled Run' })).toBeVisible()
  await page.getByRole('button', { name: 'Manual', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save Run', exact: true })).toBeVisible()
  await expect(page.getByText(/Startup Error/)).toHaveCount(0)
})

for (const kind of ['scheduled', 'recovery']) {
  test(`${kind} travel prompt tap navigates to the expanded planner`, async ({ page }) => {
    const execution = kind === 'scheduled' ? scheduled : recovery
    const day = new Date().toLocaleDateString('en-US', { weekday: 'short' })
    await page.context().grantPermissions(['geolocation'])
    await page.context().setGeolocation({ latitude: 40, longitude: -73 })
    await installAuthenticatedApi(page, { responses: [
      ['GET /api/plans/my', {
        plan: { id: 'synthetic-plan', name: 'Synthetic plan', type: 'run_only', weeks: 5,
          plan_data: { schemaVersion: 2, planMode: 'run_only', weeks: [{ week: 5, phase: 'base', startDate: date,
            days: [{ date, day, sessions: execution.sessions }] }] } },
        user_plan: { current_week: 5, started_at: date, progress: { completedSessionIds: [] } },
      }],
      ['GET /api/plans/today', { today: { date, day, type: kind === 'scheduled' ? 'run' : 'rest' }, execution }],
      ['GET /api/plans/adaptation/current', { proposal: kind === 'recovery'
        ? { status: 'proposal', evidence: [{ signal: 'run_gap', daysSinceRun: 8 }], changes: [] } : null }],
      ['GET /api/checkin/today', { life_flags: ['traveling'], sleep_hours: 7 }],
      ['GET /api/recovery/readiness', { available: true, score: 80, band: 'GREEN' }],
      ['POST /api/travel-context', { status: 'away', confidence: 'high', distanceBand: 'over_150_miles' }],
      ['GET /api/routes/planner-status', { available: true }],
    ] })
    await page.goto('/plan')
    await page.getByRole('button', { name: /^Run near me\./ }).click()
    await expect(page).toHaveURL(/\/log-run$/)
    await expect(page.getByRole('button', { name: 'Generate route', exact: true })).toBeVisible()
    const state = await page.evaluate(() => history.state.usr)
    expect(state.openRoutePlanner).toBe(true)
    expect(state.planSessionId).toBe(kind === 'scheduled' ? run.id : null)
  })
}

test('denied location stays local and makes no route request', async ({ page }) => {
  const api = await openRun(page)
  await page.evaluate(() => {
    navigator.geolocation.getCurrentPosition = (_success, failure) => failure({ code: 1, PERMISSION_DENIED: 1 })
  })
  await page.getByRole('button', { name: 'Generate route', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Allow location access')
  expect(api.requestsFor('POST', '/api/routes/generate')).toHaveLength(0)
  await expect(page.getByRole('button', { name: 'Start Scheduled Run' })).toBeVisible()
})
