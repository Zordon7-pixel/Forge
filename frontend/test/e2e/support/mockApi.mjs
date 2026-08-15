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

function fixtureHash(character) {
  return character.repeat(64)
}

export function goalBackwardV24PlanFixture({
  dateISO,
  day,
  featureMode = 'preview',
  safetyAction = 'NO_RUNNING',
  safetyScope = ['RUN', 'IMPACT'],
  safetyReasonCodes = ['NO_RUNNING'],
  executability = 'RESTRICTED',
  workoutFamily = 'easy_run',
  capability = 'FULLY_STRUCTURED',
} = {}) {
  const hybrid = workoutFamily.startsWith('hyrox_')
  const sessionId = hybrid ? 'v24-mobile-hybrid-session' : 'v24-mobile-run-session'
  const step = hybrid
    ? {
        step_id: 'v24-mobile-station-step',
        type: 'station',
        order: 1,
        workout_family: workoutFamily,
        target: { repetitions: 20 },
        provenance: [{
          evidence_ids: ['v24-mobile-station-evidence'],
          athlete_state_field: 'station_benchmark',
          policy_id: 'goal_backward_target_hierarchy_v1',
          policy_version: '1.0.0',
          confidence: 'MEDIUM',
          derived_at: `${dateISO}T12:00:00.000Z`,
          decision_id: 'decision-v24-mobile',
          canonical_unit: 'count',
        }],
      }
    : {
        step_id: 'v24-mobile-run-step',
        type: 'run',
        order: 1,
        workout_family: workoutFamily,
        target: { distance_m: 6437, rpe_range: { minimum: 2, maximum: 4 } },
        provenance: [{
          evidence_ids: ['v24-mobile-run-evidence'],
          athlete_state_field: 'recent_normal_running.median_distance_m',
          policy_id: 'goal_backward_target_hierarchy_v1',
          policy_version: '1.0.0',
          confidence: 'HIGH',
          derived_at: `${dateISO}T12:00:00.000Z`,
          decision_id: 'decision-v24-mobile',
          canonical_unit: 'm',
        }],
      }
  const canonicalSession = {
    canonical_workout_schema_version: 1,
    session_id: sessionId,
    session_revision: 4,
    plan_id: 'plan-v24-mobile',
    plan_revision: 7,
    decision_id: 'decision-v24-mobile',
    goal_ids: ['goal-v24-mobile'],
    phase: 'EVENT_SPECIFIC_DEVELOPMENT',
    role: hybrid ? 'SUPPORTING' : 'PRIMARY_KEY',
    workout_family: workoutFamily,
    title: hybrid ? 'Canonical station skill' : 'Canonical four mile run',
    purpose_reason_codes: hybrid ? ['KEY_STIMULUS_REQUIRED'] : ['RECENT_LOAD_MAINTAIN'],
    scheduled_local_date: dateISO,
    timezone: 'America/New_York',
    stress_vector: hybrid ? [2, 1, 2, 2, 2, 2, 2, 2] : [2, 2, 1, 0, 0, 1, 1, 0],
    steps: [step],
    derived_totals: hybrid
      ? { distance_m: 0, duration_s: 0, repetitions: 20 }
      : { distance_m: 6437, duration_s: 0 },
    target_provenance: step.provenance,
    success_criteria: ['Complete only the accepted canonical work.'],
    adjustment_criteria: ['Reduce the dose if the accepted criteria require it.'],
    stop_criteria: ['Stop for sharp pain or altered mechanics.'],
    safety_scope: safetyScope,
    executability,
    capability: {
      classification: capability,
      manual_step_ids: hybrid ? [step.step_id] : [],
      unsupported_step_ids: [],
    },
    content_hash: fixtureHash(hybrid ? 'f' : 'c'),
  }
  const purpose = 'Review the accepted v2.4 prescription without changing the active calendar.'
  const planData = {
    schemaVersion: 2,
    canonical_workout_schema_version: 1,
    plan_id: canonicalSession.plan_id,
    plan_revision: canonicalSession.plan_revision,
    decision_id: canonicalSession.decision_id,
    decision_hash: fixtureHash('d'),
    selected_candidate_id: 'candidate-v24-mobile',
    selected_candidate_hash: fixtureHash('a'),
    canonical_session_set_hash: fixtureHash('b'),
    planMode: hybrid ? 'hyrox_build' : 'run_only',
    overall_feasibility: safetyAction === 'FULL_REST' ? 'at_risk' : 'unvalidated',
    reasons: safetyReasonCodes,
    purpose,
    goals: [{
      raceId: 'race-v24-mobile',
      date: dateISO,
      distanceMiles: hybrid ? null : 10,
      priority: 'A',
      feasibility_status: safetyAction === 'FULL_REST' ? 'at_risk' : 'unvalidated',
    }],
    weeks: [{
      week: 1,
      startDate: dateISO,
      phase: canonicalSession.phase,
      purpose,
      days: [{ date: dateISO, day, sessions: [canonicalSession] }],
    }],
  }
  const surfaceManifest = {
    schema_version: 'goal_backward_surface_manifest_v1',
    surface_revision: 3,
    feature_mode: featureMode,
    v24_surface_enabled: true,
    status: 'accepted',
    identity: {
      decision_id: canonicalSession.decision_id,
      decision_hash: planData.decision_hash,
      candidate_id: planData.selected_candidate_id,
      candidate_revision: 2,
      candidate_hash: planData.selected_candidate_hash,
      plan_id: canonicalSession.plan_id,
      plan_revision: canonicalSession.plan_revision,
      canonical_session_set_hash: planData.canonical_session_set_hash,
      athlete_state_revision: 9,
      safety_state_hash: `sha256:${fixtureHash('e')}`,
      goal_revisions: { 'goal-v24-mobile': 5 },
    },
    purpose,
    feasibility: { status: planData.overall_feasibility, reason_codes: planData.reasons },
    safety: { action: safetyAction, scope: safetyScope, reason_codes: safetyReasonCodes },
    weeks: [{ week: 1, start_date: dateISO, phase: canonicalSession.phase, purpose }],
    sessions: [canonicalSession],
  }
  return {
    plan: { id: canonicalSession.plan_id, name: 'Synthetic v2.4 plan', weeks: 1, plan_data: planData },
    user_plan: {
      id: 'assignment-v24-mobile',
      plan_version: canonicalSession.plan_revision,
      current_week: 1,
      started_at: dateISO,
      progress: { completedSessionIds: [] },
    },
    surface_manifest: surfaceManifest,
  }
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
