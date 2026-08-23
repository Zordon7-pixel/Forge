import assert from 'node:assert/strict'
import {
  applyPlanCandidateWithActivation,
  PLAN_CANDIDATE_APPLY_TIMEOUT_MS,
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

console.log('PLAN CANDIDATE ACTIVATION LIFECYCLE SMOKE OK')
