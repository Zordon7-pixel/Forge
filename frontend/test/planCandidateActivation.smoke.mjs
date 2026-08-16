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
const active = {
  plan: { plan_data: { goals: [
    { raceId: 'hyrox-dc', eventLocalDate: '2026-09-06', division: 'doubles', category: 'men', goalTimeSeconds: 3540 },
    { raceId: 'army' },
  ] } },
  user_plan: { id: 'assignment-new', supersedes_user_plan_id: 'assignment-old' },
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

{
  let committed = false
  const api = {
    async get() { return { data: committed ? active : stale } },
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
  const api = fakeApi({
    before: active,
    after: active,
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
  const foundation = {
    plan: { plan_data: { goals: [] } },
    user_plan: { id: 'assignment-foundation', supersedes_user_plan_id: 'assignment-old' },
  }
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
