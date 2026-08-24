import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  applyPlanCandidateWithActivation,
  createSurfaceReconcileLatch,
  PLAN_CANDIDATE_APPLY_TIMEOUT_MS,
  reconcileBlockedPlanSurface,
} from '../src/lib/planCandidateActivation.js'

const clock = { planning_date_local: '2026-08-15', timezone_offset_minutes: 240 }
const hyrox = {
  id: 'hyrox-dc', race_name: 'HYROX Washington DC', event_local_date: '2026-09-06',
  event_format: 'doubles', event_category: 'men', goal_time_seconds: 3540,
}
const stale = {
  plan: { plan_data: { goals: [{ raceId: 'yonkers' }, { raceId: 'army' }] } },
  user_plan: { id: 'assignment-old', supersedes_user_plan_id: null },
}
const activeGoals = [
  { raceId: 'hyrox-dc', eventLocalDate: '2026-09-06', division: 'doubles', category: 'men', goalTimeSeconds: 3540 },
  { raceId: 'army' },
]

function acceptedActive({
  assignmentId = 'assignment-new',
  supersedesUserPlanId = 'assignment-old',
  candidateHash = 'sha256:exact',
  goals = activeGoals,
} = {}) {
  const normalizedCandidateHash = String(candidateHash).replace(/^sha256:/, '')
  const logicalPlanId = `logical-${assignmentId}`
  const decisionHash = 'd'.repeat(64)
  const sessionSetHash = 'e'.repeat(64)
  return {
    plan: {
      id: `stored-${assignmentId}`,
      plan_data: {
        canonical_workout_schema_version: 1,
        plan_id: logicalPlanId,
        plan_revision: 2,
        decision_id: 'decision-applied',
        decision_hash: decisionHash,
        selected_candidate_hash: normalizedCandidateHash,
        canonical_session_set_hash: sessionSetHash,
        goals,
      },
    },
    user_plan: {
      id: assignmentId,
      plan_version: 2,
      supersedes_user_plan_id: supersedesUserPlanId,
    },
    surface_manifest: {
      schema_version: 'goal_backward_surface_manifest_v1',
      status: 'accepted',
      feature_mode: 'on',
      v24_surface_enabled: true,
      identity: {
        plan_id: logicalPlanId,
        plan_revision: 2,
        decision_id: 'decision-applied',
        decision_hash: decisionHash,
        candidate_hash: normalizedCandidateHash,
        canonical_session_set_hash: sessionSetHash,
      },
      sessions: [{ session_id: 'session-applied' }],
    },
  }
}
const active = acceptedActive()
const blockedActive = (() => {
  const response = acceptedActive()
  response.user_plan.plan_version = 1
  response.surface_manifest = {
    ...response.surface_manifest,
    status: 'blocked',
    reason_codes: ['SURFACE_REVISION_MISMATCH'],
    sessions: [],
  }
  return response
})()
const onModeApplyBindings = {
  candidate_id: 'candidate-first-assignment',
  candidate_hash: 'sha256:first-assignment',
  candidate_revision: 1,
  decision_id: 'decision-first-assignment',
  decision_hash: 'd'.repeat(64),
  decision_artifact: {
    artifact_id: 'artifact-first-assignment',
    revision: 1,
    content_hash: `sha256:${'a'.repeat(64)}`,
  },
  active_plan: { training_plan_id: null, user_plan_id: null, plan_revision: null },
  planning_input_revision: 7,
  planning_date_local: clock.planning_date_local,
  planning_timezone: 'America/New_York',
  timezone_offset_minutes: clock.timezone_offset_minutes,
  goal_revisions: { 'goal-hyrox-dc': 2, 'goal-army': 1 },
  goal_fingerprint: `sha256:${'b'.repeat(64)}`,
  athlete_state_revision: 7,
  safety_state_hash: `sha256:${'c'.repeat(64)}`,
  evidence_fingerprint: `sha256:${'e'.repeat(64)}`,
  constraint_fingerprint: `sha256:${'f'.repeat(64)}`,
  policy_fingerprint: `sha256:${'1'.repeat(64)}`,
  lock_revision: 0,
  edit_revision: 0,
  surface_revision: 1,
  export_revision: 1,
}

function fakeApi({ before = stale, after = active, post }) {
  let reads = 0
  return {
    async get(path, config) {
      assert.equal(path, '/plans/my')
      assert.equal(config.headers['Cache-Control'], 'no-cache')
      assert.ok(config.params.forge_refresh)
      reads += 1
      return { data: reads === 1 ? before : after }
    },
    post,
  }
}

{
  const api = fakeApi({
    post: async (_path, _body, config) => {
      assert.equal(config.timeout, PLAN_CANDIDATE_APPLY_TIMEOUT_MS)
      return { data: { ok: true, user_plan_id: 'assignment-new' } }
    },
  })
  const result = await applyPlanCandidateWithActivation({
    api, candidateId: 'candidate / exact', candidateHash: 'sha256:exact', planningClock: clock,
    hyroxRace: hyrox, secondaryRaceId: 'army',
  })
  assert.equal(result.activation.confirmed, true)
  assert.equal(result.reconciled, false)
}

for (const [label, after] of [
  ['missing', (() => {
    const response = acceptedActive({ candidateHash: 'sha256:missing-manifest' })
    delete response.surface_manifest
    return response
  })()],
  ['blocked', {
    ...acceptedActive({ candidateHash: 'sha256:blocked-manifest' }),
    surface_manifest: {
      ...acceptedActive({ candidateHash: 'sha256:blocked-manifest' }).surface_manifest,
      status: 'blocked',
      reason_codes: ['SURFACE_REVISION_MISMATCH'],
      sessions: [],
    },
  }],
  ['ambiguous', (() => {
    const response = acceptedActive({ candidateHash: 'sha256:ambiguous-manifest' })
    response.surface_manifest.identity.plan_revision = 3
    return response
  })()],
]) {
  let postCalls = 0
  const api = fakeApi({
    after,
    post: async () => {
      postCalls += 1
      return { data: { ok: true, user_plan_id: 'assignment-new' } }
    },
  })
  await assert.rejects(
    () => applyPlanCandidateWithActivation({
      api,
      candidateId: `candidate-${label}-manifest`,
      candidateHash: `sha256:${label}-manifest`,
      planningClock: clock,
      hyroxRace: hyrox,
      secondaryRaceId: 'army',
      applyTimeoutMs: 20,
      readTimeoutMs: 20,
    }),
    (error) => error?.code === 'PLAN_APPLY_NOT_CONFIRMED'
      && /public workout surface/.test(error.message),
    `${label} applicable public surface truth cannot confirm Apply`,
  )
  assert.equal(postCalls, 1, `${label} confirmation failure never triggers a blind duplicate Apply`)
}

{
  const noAssignment = { plan: null, user_plan: null }
  const firstAssignment = acceptedActive({
    assignmentId: 'assignment-first',
    supersedesUserPlanId: null,
    candidateHash: 'sha256:first-assignment',
  })
  let committed = false
  let applyBody = null
  const api = {
    async get() { return { data: committed ? firstAssignment : noAssignment } },
    async post(_path, body) {
      applyBody = body
      const expectedBody = {
        ...onModeApplyBindings,
        candidate_hash: 'sha256:first-assignment',
        choice: 'train_for_target',
        ...clock,
      }
      if (JSON.stringify(body) !== JSON.stringify(expectedBody)) {
        const error = new Error('Request failed with status code 409')
        error.response = {
          status: 409,
          data: { code: 'CANDIDATE_REVISION_CHANGED', error: 'Candidate bindings changed after preview. Preview again.' },
        }
        throw error
      }
      committed = true
      return { data: { ok: true, user_plan_id: 'assignment-first' } }
    },
  }
  const result = await applyPlanCandidateWithActivation({
    api,
    candidateId: onModeApplyBindings.candidate_id,
    candidateHash: onModeApplyBindings.candidate_hash,
    applyBindings: onModeApplyBindings,
    planningClock: clock,
    hyroxRace: hyrox,
    secondaryRaceId: 'army',
    applyTimeoutMs: 20,
    readTimeoutMs: 20,
  })
  assert.deepEqual(applyBody, {
    ...onModeApplyBindings,
    candidate_hash: onModeApplyBindings.candidate_hash,
    choice: 'train_for_target',
    ...clock,
  }, 'the reviewed on-mode envelope reaches apply byte-for-byte')
  assert.equal(result.activation.confirmed, true, 'a valid first assignment is confirmed authoritatively')
}

{
  let committed = false
  const committedActive = acceptedActive({ candidateHash: 'sha256:timeout' })
  const api = {
    async get() { return { data: committed ? committedActive : stale } },
    async post() {
      committed = true
      const error = new Error('gateway timed out after commit')
      error.code = 'ETIMEDOUT'
      throw error
    },
  }
  const result = await applyPlanCandidateWithActivation({
    api, candidateId: 'candidate-timeout', candidateHash: 'sha256:timeout', planningClock: clock,
    hyroxRace: hyrox, secondaryRaceId: 'army', applyTimeoutMs: 20, readTimeoutMs: 20,
  })
  assert.equal(result.activation.confirmed, true)
  assert.equal(result.reconciled, true, 'timeout-after-commit reconciles from exact successor assignment and goals')
}

{
  const serverError = new Error('server unavailable')
  serverError.response = { status: 500 }
  const api = fakeApi({ before: stale, after: stale, post: async () => { throw serverError } })
  await assert.rejects(
    () => applyPlanCandidateWithActivation({
      api, candidateId: 'candidate-failed', candidateHash: 'sha256:failed', planningClock: clock,
      hyroxRace: hyrox, secondaryRaceId: 'army', applyTimeoutMs: 20, readTimeoutMs: 20,
    }),
    (error) => error?.code === 'PLAN_APPLY_FAILED_UNCHANGED' && error.priorStateConfirmed === true,
    'server failure reports unchanged only after the same assignment is authoritatively re-read',
  )
}

{
  const noAssignment = { plan: null, user_plan: null }
  const serverError = new Error('server unavailable')
  serverError.response = { status: 500 }
  const api = fakeApi({ before: noAssignment, after: noAssignment, post: async () => { throw serverError } })
  await assert.rejects(
    () => applyPlanCandidateWithActivation({
      api, candidateId: 'candidate-no-assignment', candidateHash: 'sha256:no-assignment', planningClock: clock,
      hyroxRace: null, secondaryRaceId: '', applyTimeoutMs: 20, readTimeoutMs: 20,
    }),
    (error) => error?.code === 'PLAN_APPLY_STATE_UNKNOWN' && error.priorStateConfirmed === false,
    'empty assignment identities never confirm an unchanged active calendar',
  )
}

{
  const replayActive = acceptedActive({ candidateHash: 'sha256:replay' })
  const api = fakeApi({
    before: replayActive,
    after: replayActive,
    post: async () => ({ data: { ok: true, user_plan_id: 'assignment-new', replay: true } }),
  })
  const replay = await applyPlanCandidateWithActivation({
    api, candidateId: 'candidate-replay', candidateHash: 'sha256:replay', planningClock: clock,
    hyroxRace: hyrox, secondaryRaceId: 'army', applyTimeoutMs: 20, readTimeoutMs: 20,
  })
  assert.equal(replay.activation.confirmed, true)
  assert.equal(replay.replay, true, 'idempotent replay binds the returned assignment identity to the same exact goals')
}

{
  const foundation = acceptedActive({
    assignmentId: 'assignment-foundation',
    candidateHash: 'sha256:foundation',
    goals: [],
  })
  const api = fakeApi({
    after: foundation,
    post: async () => ({ data: { ok: true, user_plan_id: 'assignment-foundation' } }),
  })
  const result = await applyPlanCandidateWithActivation({
    api, candidateId: 'candidate-foundation', candidateHash: 'sha256:foundation', planningClock: clock,
    hyroxRace: null, secondaryRaceId: '', applyTimeoutMs: 20, readTimeoutMs: 20,
  })
  assert.equal(result.activation.confirmed, true, 'foundation ignores the retained owned race only for activation truth')
}

{
  const api = fakeApi({
    before: stale,
    after: stale,
    post: async () => ({ data: { queued: true, offline: true } }),
  })
  await assert.rejects(
    () => applyPlanCandidateWithActivation({
      api, candidateId: 'candidate-offline', candidateHash: 'sha256:offline', planningClock: clock,
      hyroxRace: hyrox, secondaryRaceId: 'army', applyTimeoutMs: 20, readTimeoutMs: 20,
    }),
    (error) => error?.code === 'PLAN_APPLY_FAILED_UNCHANGED' && /was not queued/.test(error.message),
    'an old service worker 202 can never be treated as applied',
  )
}

{
  let current = structuredClone(blockedActive)
  let postCalls = 0
  let acceptedReads = 0
  const phases = []
  const api = {
    async post(path, body) {
      postCalls += 1
      assert.equal(path, '/plans/my/surface-reconcile')
      assert.equal(body, undefined, 'the owner-scoped repair sends no client-controlled body')
      current = structuredClone(active)
      return { data: { ok: true, accepted: true, reconciled: true } }
    },
    async get(path) {
      assert.equal(path, '/plans/my')
      acceptedReads += 1
      return { data: structuredClone(current) }
    },
  }
  const firstMount = await reconcileBlockedPlanSurface({
    api,
    planResponse: structuredClone(current),
    latch: createSurfaceReconcileLatch(),
    onState: (state) => phases.push(state.phase),
  })
  assert.deepEqual(phases, ['recovering', 'accepted'])
  assert.equal(firstMount.phase, 'accepted')
  assert.equal(firstMount.response.surface_manifest.status, 'accepted')
  assert.ok(firstMount.response.surface_manifest.sessions.length > 0,
    'the accepted refetch exposes the real executable surface')
  assert.equal(postCalls, 1)
  assert.equal(acceptedReads, 1)

  const remount = await reconcileBlockedPlanSurface({
    api,
    planResponse: structuredClone(current),
    latch: createSurfaceReconcileLatch(),
  })
  assert.equal(remount.phase, 'not_applicable')
  assert.equal(postCalls, 1, 'reload/remount after server repair sends no duplicate POST')
  assert.equal(acceptedReads, 1, 'accepted remount needs no recovery refetch')
}

{
  let postCalls = 0
  let getCalls = 0
  const api = {
    async post(path, body) {
      postCalls += 1
      assert.equal(path, '/plans/my/surface-reconcile')
      assert.equal(body, undefined)
      const error = new Error('conflict')
      error.response = { status: 409, data: { error: 'This plan needs a reviewed rebuild.' } }
      throw error
    },
    async get() { getCalls += 1; return { data: active } },
  }
  const result = await reconcileBlockedPlanSurface({
    api,
    planResponse: structuredClone(blockedActive),
    latch: createSurfaceReconcileLatch(),
  })
  assert.equal(result.phase, 'review')
  assert.equal(result.response.surface_manifest.status, 'blocked')
  assert.equal(postCalls, 1)
  assert.equal(getCalls, 0, 'a nonrepairable 409 remains blocked without a misleading GET')
}

{
  const partialCanonical = {
    plan: {
      id: 'stored-partial-canonical',
      plan_data: {
        selected_candidate_hash: `sha256:${'a'.repeat(64)}`,
        weeks: [],
      },
    },
    user_plan: { id: 'assignment-partial-canonical', plan_version: 1 },
    surface_manifest: null,
  }
  let postCalls = 0
  const api = {
    async post(path, body) {
      postCalls += 1
      assert.equal(path, '/plans/my/surface-reconcile')
      assert.equal(body, undefined)
      const error = new Error('review required')
      error.response = { status: 409, data: { error: 'This plan needs a reviewed rebuild.' } }
      throw error
    },
    async get() { throw new Error('not expected') },
  }
  const result = await reconcileBlockedPlanSurface({
    api,
    planResponse: partialCanonical,
    latch: createSurfaceReconcileLatch(),
  })
  assert.equal(result.phase, 'review')
  assert.equal(postCalls, 1,
    'any canonical marker receives owner-scoped reconciliation instead of a dead-end blocked banner')
}

{
  let postCalls = 0
  let getCalls = 0
  const latch = createSurfaceReconcileLatch()
  const api = {
    async post(path, body) {
      postCalls += 1
      assert.equal(path, '/plans/my/surface-reconcile')
      assert.equal(body, undefined)
      if (postCalls === 1) throw new TypeError('network unavailable')
      return { data: { ok: true, accepted: true, reconciled: true } }
    },
    async get(path) {
      assert.equal(path, '/plans/my')
      getCalls += 1
      return { data: structuredClone(active) }
    },
  }
  const transient = await reconcileBlockedPlanSurface({
    api,
    planResponse: structuredClone(blockedActive),
    latch,
  })
  assert.equal(transient.phase, 'retry')
  assert.equal(transient.response.surface_manifest.status, 'blocked')

  const rerender = await reconcileBlockedPlanSurface({
    api,
    planResponse: structuredClone(blockedActive),
    latch,
  })
  assert.equal(rerender.phase, 'retry')
  assert.equal(postCalls, 1, 'a transient failure cannot create an automatic render loop')

  const retried = await reconcileBlockedPlanSurface({
    api,
    planResponse: structuredClone(blockedActive),
    latch,
    manualRetry: true,
  })
  assert.equal(retried.phase, 'accepted')
  assert.equal(retried.response.surface_manifest.status, 'accepted')
  assert.equal(postCalls, 2, 'one explicit manual retry performs one additional POST')
  assert.equal(getCalls, 1, 'manual retry success refetches the accepted plan exactly once')
}

for (const response of [active, stale]) {
  let postCalls = 0
  const result = await reconcileBlockedPlanSurface({
    api: {
      async post() { postCalls += 1; return { data: { ok: true } } },
      async get() { throw new Error('not expected') },
    },
    planResponse: structuredClone(response),
    latch: createSurfaceReconcileLatch(),
  })
  assert.equal(result.phase, 'not_applicable')
  assert.equal(postCalls, 0, 'accepted and legacy plans send zero reconciliation requests')
}

{
  let postCalls = 0
  const latch = createSurfaceReconcileLatch()
  const api = {
    async post() {
      postCalls += 1
      const error = new TypeError('offline')
      throw error
    },
    async get() { throw new Error('not expected') },
  }
  await reconcileBlockedPlanSurface({ api, planResponse: structuredClone(blockedActive), latch })
  const otherOwnerState = structuredClone(blockedActive)
  otherOwnerState.user_plan.id = 'assignment-other-owner'
  await reconcileBlockedPlanSurface({ api, planResponse: otherOwnerState, latch })
  assert.equal(postCalls, 2, 'an account/assignment change receives a fresh owner-isolated latch')
}

{
  const planSource = fs.readFileSync(new URL('../src/pages/Plan.jsx', import.meta.url), 'utf8')
  const blockerStart = planSource.indexOf("calendarModel?.surface?.status === 'blocked'")
  const blockerEnd = planSource.indexOf('{/* Active plan:', blockerStart)
  const blockerSource = planSource.slice(blockerStart, blockerEnd)
  assert.match(blockerSource, /Restoring your reviewed plan/)
  assert.match(blockerSource, /Retry recovery/)
  assert.match(blockerSource, /Review and rebuild plan/)
  assert.match(blockerSource, /!\['recovering', 'retry'\]\.includes\(surfaceRecoveryPhase\)/,
    'a blocked idle state always exposes the reviewed rebuild action')
  assert.match(blockerSource, /navigate\('\/plan-catalog'/,
    'a nonrepairable blocker leads to the existing reviewed-plan flow')
  assert.doesNotMatch(blockerSource, /SURFACE_REVISION_MISMATCH|reason_codes|Start (?:run|lift|workout)/,
    'the blocked state renders no raw enum or execution affordance')
}

console.log('PLAN CANDIDATE ACTIVATION LIFECYCLE SMOKE OK')
