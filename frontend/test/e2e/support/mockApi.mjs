export const DEFAULT_USER = {
  id: 'qa-user-001',
  email: 'qa@forgedhybrid.test',
  name: 'QA Athlete',
  onboarded: true,
  waiver_current: true,
  subscription_status: 'beta',
  entitlement: { effectivePremiumAccess: true, accessSource: 'beta', paidTier: null },
}

export function createQaToken(claims = {}) {
  const payload = {
    id: DEFAULT_USER.id,
    email: DEFAULT_USER.email,
    name: DEFAULT_USER.name,
    onboarded: true,
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claims,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `qa.${encoded}.signature`
}

export function qaResponse(body, status = 200) {
  return { __qaResponse: true, status, body }
}

function defaultResponses(user) {
  return new Map([
    ['POST /api/events', { ok: true }],
    ['GET /api/auth/me', { user }],
    ['GET /api/auth/me/stats', { day: {}, today: {} }],
    ['GET /api/users/settings', {}],
    ['GET /api/users/goal', null],
    ['GET /api/runs', []],
    ['GET /api/runs/load-analysis', {}],
    ['GET /api/runs/next-recommendation', null],
    ['GET /api/runs/age-graded-performance', {}],
    ['GET /api/lifts', { lifts: [] }],
    ['GET /api/workouts', { sessions: [] }],
    ['GET /api/races', { races: [] }],
    ['GET /api/races/next', { race: null }],
    ['GET /api/plans/my', { plan: null, user_plan: null }],
    ['GET /api/plans/current', { plan: null }],
    ['GET /api/plans/today', { today: null, execution: { hasPlan: false, hasDay: false, sessions: [] } }],
    ['GET /api/plans/adaptation/current', { proposal: null }],
    ['GET /api/plans/reconciliation/current', { reconciliation: null }],
    ['GET /api/plans/compliance', null],
    ['GET /api/routes/planner-status', { available: false, requiresPro: false }],
    ['GET /api/releases/state', { seenSequence: 999 }],
    ['GET /api/recovery/readiness', { available: false }],
    ['GET /api/recovery/readiness/history', { days: [] }],
    ['GET /api/injury/active', { injuries: [], safetyUnavailable: false }],
    ['GET /api/gear/shoes', { shoes: [] }],
    ['GET /api/group-runs', { group_runs: [] }],
    ['GET /api/notifications', { notifications: [] }],
    ['GET /api/notifications/push/config', { configured: false }],
    ['GET /api/social/activity-posts', { posts: [] }],
    ['GET /api/social/friends', {
      friends: [], incoming: [], outgoing: [], blocked: [],
      discovery: { handle: '', discoverable: false, contact_discoverable: false },
      limits: { active_invite_count: 0, active_invites: 5, friends: 100 },
    }],
    ['GET /api/profile/hr-zones', { zones: [] }],
    ['GET /api/health/sync', {}],
    ['GET /api/body/drivers', { summary: 'No recovery signals yet.', limiter: null, drivers: [] }],
    ['GET /api/checkin/today', null],
    ['GET /api/coach/warning', { warning: false }],
    ['GET /api/recap/weekly', null],
    ['GET /api/stats/engagement', {}],
    ['GET /api/stats/hybrid-score', {}],
    ['GET /api/stats/hybrid-streak', {}],
    ['GET /api/watch-sync/recent', {}],
    ['GET /api/watch-sync/status', { connected: false }],
    ['GET /api/stretches/recommended', { stretches: [] }],
    ['GET /api/ai/workout-recommendation', null],
  ])
}

function requestBody(request) {
  const raw = request.postData()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function normalizeResponse(value) {
  if (value?.__qaResponse) return value
  return qaResponse(value)
}

export async function installAuthenticatedApi(page, options = {}) {
  const user = { ...DEFAULT_USER, ...(options.user || {}) }
  const responses = new Map(defaultResponses(user))
  for (const [key, value] of options.responses || []) responses.set(key, value)

  const state = {
    requests: [],
    unexpectedRequests: [],
    requestsFor(method, pathname) {
      return this.requests.filter((request) => request.method === method && request.pathname === pathname)
    },
  }
  const token = options.token || createQaToken({
    id: user.id,
    email: user.email,
    name: user.name,
    onboarded: user.onboarded !== false,
  })

  await page.addInitScript((value) => localStorage.setItem('forge_token', value), token)
  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()
    const key = `${method} ${url.pathname}`
    const entry = {
      method,
      pathname: url.pathname,
      search: Object.fromEntries(url.searchParams),
      body: requestBody(request),
    }
    state.requests.push(entry)

    if (!responses.has(key)) {
      state.unexpectedRequests.push(key)
      await route.fulfill({
        status: 501,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Unmocked QA API request' }),
      })
      return
    }

    const configured = responses.get(key)
    const resolved = typeof configured === 'function'
      ? await configured(entry, state)
      : configured
    const response = normalizeResponse(resolved)
    await route.fulfill({
      status: response.status,
      contentType: 'application/json',
      body: JSON.stringify(response.body),
    })
  })
  return state
}
