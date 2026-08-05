const user = {
  id: 'qa-user-001',
  email: 'qa@forgedhybrid.test',
  name: 'QA Athlete',
  onboarded: true,
  waiver_current: true,
  subscription_status: 'beta',
  entitlement: { effectivePremiumAccess: true, accessSource: 'beta', paidTier: null },
}

function responseFor(method, pathname) {
  const key = `${method} ${pathname}`
  const responses = new Map([
    ['POST /api/events', { ok: true }],
    ['GET /api/auth/me', { user }],
    ['GET /api/auth/me/stats', { day: {}, today: {} }],
    ['GET /api/users/settings', {}],
    ['GET /api/users/goal', null],
    ['GET /api/runs', []],
    ['GET /api/runs/load-analysis', {}],
    ['GET /api/runs/next-recommendation', null],
    ['GET /api/runs/age-graded-performance', {}],
    ['GET /api/lifts', []],
    ['GET /api/workouts', { sessions: [] }],
    ['GET /api/races', { races: [] }],
    ['GET /api/races/next', { race: null }],
    ['GET /api/plans/my', { plan: null, user_plan: null }],
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
    ['GET /api/ai/workout-recommendation', null],
  ])
  return responses.has(key) ? { matched: true, body: responses.get(key) } : { matched: false, body: null }
}

export async function installAuthenticatedApi(page) {
  const state = { unexpectedRequests: [] }
  const payload = {
    id: user.id,
    email: user.email,
    name: user.name,
    onboarded: true,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const token = `qa.${encoded}.signature`

  await page.addInitScript((value) => localStorage.setItem('forge_token', value), token)
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    const response = responseFor(method, url.pathname)
    if (!response.matched) state.unexpectedRequests.push(`${method} ${url.pathname}`)
    await route.fulfill({
      status: response.matched ? 200 : 501,
      contentType: 'application/json',
      body: JSON.stringify(response.matched ? response.body : { error: 'Unmocked QA API request' }),
    })
  })
  return state
}
