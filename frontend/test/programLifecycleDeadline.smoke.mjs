import assert from 'node:assert/strict'
import api from '../src/lib/api.js'
import { previewAndApplyPlan } from '../src/lib/planCandidates.js'
import { registerPlanCandidateReviewer } from '../src/lib/planCandidateReview.js'

const prior = api.post
const calls = []
const unregister = registerPlanCandidateReviewer(async () => 'apply')
try {
  api.post = async (path, body, config) => {
    calls.push({ path, body, config })
    return path.endsWith('/apply') ? { data: { ok: true } }
      : { data: { requires_apply: true, candidate_id: 'synthetic', candidate_hash: 'bound-hash', plan: { plan_data: {} } } }
  }
  await previewAndApplyPlan('/plans/generate-for-races', { race_ids: ['synthetic'] })
  assert.equal(calls[0].config.timeout, 90000)
  assert.equal(calls[1].config.timeout, 45000)
  assert.equal(calls[1].body.candidate_hash, 'bound-hash')
  assert.equal(api.defaults.timeout, 15000, 'Unrelated global API deadline remains unchanged')
  calls.length = 0
  await previewAndApplyPlan('/plans/generate-for-races', {}, { timeout: 80000, headers: { 'x-test': 'retained' } })
  assert.equal(calls[0].config.timeout, 80000)
  assert.equal(calls[1].config.timeout, 45000)
  assert.equal(calls[1].config.headers['x-test'], 'retained')
} finally { api.post = prior; unregister() }
console.log('PROGRAM LIFECYCLE DEADLINES OK: explicit generation/apply limits across shared entrypoints')
