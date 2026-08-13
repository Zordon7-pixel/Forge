import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  ADAPTATION_DECISION_RETRY_CODE,
  ensureCommittedAdaptationDecision,
  isAdaptationDecisionRetryRequired,
} from '../src/lib/adaptationDecision.js'

for (const surface of ['Plan', 'Today', 'Run plan impact']) {
  assert.throws(
    () => ensureCommittedAdaptationDecision({ status: 202, data: { queued: true, offline: true } }, 'accept'),
    (error) => error.code === ADAPTATION_DECISION_RETRY_CODE && error.refreshRequired === true,
    `${surface} rejects a legacy service-worker queued response`,
  )
  assert.throws(
    () => ensureCommittedAdaptationDecision({ status: 200, data: { ok: true } }, 'keep'),
    (error) => isAdaptationDecisionRetryRequired(error),
    `${surface} rejects a 2xx response without an explicit committed decision`,
  )
  assert.deepEqual(
    ensureCommittedAdaptationDecision({ status: 200, data: { ok: true, status: 'kept' } }, 'keep'),
    { ok: true, status: 'kept' },
    `${surface} accepts an immediate matching server decision`,
  )
}

const sources = [
  ['Plan', new URL('../src/pages/Plan.jsx', import.meta.url), 'setAdaptationProposal(null)'],
  ['Today', new URL('../src/pages/Dashboard.jsx', import.meta.url), 'setTrainingGapProposal(null)'],
  ['Run plan impact', new URL('../src/components/RunPlanImpact.jsx', import.meta.url), 'setDecision(response.data?.status'],
]

for (const [surface, url, successMutation] of sources) {
  const source = fs.readFileSync(url, 'utf8')
  const guardIndex = source.lastIndexOf('ensureCommittedAdaptationDecision(response,')
  const successIndex = source.indexOf(successMutation, guardIndex)
  assert.ok(guardIndex >= 0, `${surface} uses the shared immediate-decision guard`)
  assert.ok(successIndex > guardIndex, `${surface} cannot enter its success state before the guard passes`)
  assert.match(source, /isAdaptationDecisionRetryRequired\(/, `${surface} shows a retry-required state without clearing the proposal`)
}

console.log('ADAPTATION DECISION COMMITMENT SMOKE OK')
