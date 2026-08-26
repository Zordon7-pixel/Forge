import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  ADAPTATION_DECISION_RETRY_CODE,
  adaptationProposalDecisionIdentity,
  ensureCommittedAdaptationDecision,
  isAdaptationDecisionRetryRequired,
  isSettledAdaptationProposal,
} from '../src/lib/adaptationDecision.js'

const settledProposal = {
  id: 'adaptation-1',
  revision: 'revision-1',
  planVersion: 'plan-version-1',
}
const settledIdentities = new Set([adaptationProposalDecisionIdentity(settledProposal)])
assert.equal(isSettledAdaptationProposal({ ...settledProposal, decisionStatus: 'pending' }, settledIdentities), true)
assert.equal(isSettledAdaptationProposal({ ...settledProposal, revision: 'revision-2' }, settledIdentities), false)
assert.equal(isSettledAdaptationProposal({ ...settledProposal, planVersion: 'plan-version-2' }, settledIdentities), false)
assert.equal(isSettledAdaptationProposal({ ...settledProposal, id: 'adaptation-2' }, settledIdentities), false)

const previewProposal = {
  id: null,
  decisionStatus: 'preview',
  previewFingerprint: 'preview-fingerprint-1',
  revision: 'preview-revision-1',
  planVersion: 'plan-version-1',
  planningDate: '2026-08-26',
}
const previewIdentities = new Set([adaptationProposalDecisionIdentity(previewProposal)])
assert.equal(isSettledAdaptationProposal({ ...previewProposal }, previewIdentities), true)
assert.equal(isSettledAdaptationProposal({ ...previewProposal, previewFingerprint: 'preview-fingerprint-2' }, previewIdentities), false)

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

const previewSurfaces = [
  ['Plan', new URL('../src/pages/Plan.jsx', import.meta.url), 'decideAdaptation', 'adaptationProposal', 'decideAdaptation'],
  ['Today', new URL('../src/pages/Dashboard.jsx', import.meta.url), 'decideTrainingGap', 'trainingGapProposal', 'onDecision'],
]

for (const [surface, url, handlerName, proposalName, buttonHandler] of previewSurfaces) {
  const source = fs.readFileSync(url, 'utf8')
  const handlerStart = source.indexOf(`const ${handlerName}`)
  const handlerEnd = source.indexOf('\n  const ', handlerStart + 10)
  const handler = source.slice(handlerStart, handlerEnd > handlerStart ? handlerEnd : undefined)
  assert.ok(handlerStart >= 0, `${surface} exposes its adaptation decision handler`)
  assert.match(handler, new RegExp(`${proposalName}\\?\\.decisionStatus === ['\"]preview['\"]`), `${surface} recognizes an id:null preview as actionable`)
  assert.match(handler, /\/plans\/adaptation\/preview\/\$\{decision\}/, `${surface} posts preview choices to the explicit server decision endpoint`)
  assert.match(handler, /preview_fingerprint\s*:/, `${surface} binds the preview fingerprint`)
  assert.match(handler, /proposal_revision\s*:/, `${surface} binds the preview revision`)
  assert.match(handler, /proposal_plan_version\s*:/, `${surface} binds the authoritative plan version`)
  assert.match(handler, /planning_date\s*:/, `${surface} binds the phone-local planning date`)
  assert.doesNotMatch(handler, new RegExp(`if \\(!${proposalName}\\?\\.id\\) return`), `${surface} does not silently discard an id:null preview click`)

  const acceptClick = new RegExp(`onClick=\\{\\(\\) => ${buttonHandler}\\(['\"]accept['\"]\\)\\}`)
  const keepClick = new RegExp(`onClick=\\{\\(\\) => ${buttonHandler}\\(['\"]keep['\"]\\)\\}`)
  assert.match(source, acceptClick, `${surface} Accept button issues the explicit decision`)
  assert.match(source, keepClick, `${surface} Keep button issues the explicit decision`)
  if (surface === 'Today') {
    assert.match(source, /onDecision=\{decideTrainingGap\}/, 'Today prompt delegates both buttons to the preview-capable decision handler')
  }
}

const runImpactSource = fs.readFileSync(new URL('../src/components/RunPlanImpact.jsx', import.meta.url), 'utf8')
assert.match(
  runImpactSource,
  /proposal\?\.decisionStatus === 'pending'/,
  'Run plan impact remains actionable only for a persisted pending proposal',
)
assert.doesNotMatch(
  runImpactSource,
  /\/plans\/adaptation\/preview\//,
  'Run plan impact does not regain preview decision authority',
)

console.log('ADAPTATION DECISION COMMITMENT SMOKE OK')
