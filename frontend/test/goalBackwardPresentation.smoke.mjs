import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import {
  canonicalUnitLabel,
  capabilityLabel,
  confidenceLabel,
  executabilityLabel,
  feasibilityLabel,
  goalBackwardPresentationMappings,
  humanizeMachineValue,
  phaseLabel,
  reasonCodeLabel,
  safetyActionLabel,
  safetyScopeLabel,
  safetyScopeList,
  sessionRoleLabel,
  technicalFactLabel,
} from '../src/lib/goalBackwardPresentation.js'

const require = createRequire(import.meta.url)
const contracts = require('../../backend/src/lib/goalBackwardContracts.js')

const expected = Object.freeze({
  phases: Object.freeze({
    FOUNDATION: 'Foundation',
    DEVELOPMENT: 'Development',
    EVENT_SPECIFIC_DEVELOPMENT: 'Event-specific development',
    SHARPENING: 'Sharpening',
    TAPER_RACE_WEEK: 'Race-week taper',
    POST_RACE_TRANSITION: 'Post-race transition',
  }),
  roles: Object.freeze({
    PRIMARY_KEY: 'Main workout',
    SUPPORTING: 'Supporting session',
    RECOVERY: 'Recovery session',
    REST: 'Rest day',
    ASSESSMENT: 'Fitness assessment',
  }),
  capabilities: Object.freeze({
    FULLY_STRUCTURED: 'Fully supported',
    PARTIALLY_STRUCTURED: 'Partially supported',
    MANUAL_COMPONENTS_REQUIRED: 'Manual setup required',
    NOT_EXPORTABLE: 'Export unavailable',
  }),
  executability: Object.freeze({
    EXECUTABLE: 'Ready to start and export',
    RESTRICTED: 'Restricted by safety guidance',
    NOT_EXECUTABLE: 'Cannot be started or exported',
  }),
  safetyActions: Object.freeze({
    NORMAL: 'No added restriction',
    MONITOR: 'Monitor and continue with care',
    MODIFY_IMPACT: 'Reduce impact',
    NO_RUNNING: 'No running',
    NO_LOWER_BODY: 'No lower-body training',
    NO_HIGH_INTENSITY: 'No high-intensity training',
    MODIFIED_SESSION_ONLY: 'Modified session only',
    FULL_REST: 'Full rest',
    PROFESSIONAL_ASSESSMENT_RECOMMENDED: 'Professional assessment recommended',
  }),
  safetyScopes: Object.freeze({
    ALL: 'All training',
    RUN: 'Running',
    IMPACT: 'Impact activity',
    LOWER_BODY: 'Lower-body training',
    HIGH_INTENSITY: 'High-intensity training',
  }),
  confidence: Object.freeze({
    HIGH: 'High confidence',
    MEDIUM: 'Medium confidence',
    LOW: 'Low confidence',
    INSUFFICIENT: 'Not enough evidence',
  }),
  feasibility: Object.freeze({
    supported: 'On track',
    unvalidated: 'Target needs evidence',
    at_risk: 'At risk',
    not_currently_supported: 'Not currently supported',
  }),
  canonicalUnits: Object.freeze({
    m: 'Meters',
    s: 'Seconds',
    bpm: 'Beats per minute',
    kg: 'Kilograms',
    count: 'Count',
    ordinal: 'Ordinal scale',
  }),
})

function assertExactMap(values, labels, formatter, name) {
  assert.deepEqual(values, Object.keys(labels), `${name} fixture stays aligned with the backend closed enum`)
  for (const [value, label] of Object.entries(labels)) {
    assert.equal(formatter(value), label, `${name} ${value}`)
  }
}

assertExactMap(contracts.PLANNING_PHASES, expected.phases, phaseLabel, 'phase')
assertExactMap(contracts.CANONICAL_SESSION_ROLES, expected.roles, sessionRoleLabel, 'session role')
assertExactMap(contracts.CANONICAL_EXPORT_CAPABILITIES, expected.capabilities, capabilityLabel, 'capability')
assertExactMap(['EXECUTABLE', 'RESTRICTED', 'NOT_EXECUTABLE'], expected.executability, executabilityLabel, 'executability')
assertExactMap(contracts.SAFETY_ACTIONS, expected.safetyActions, safetyActionLabel, 'safety action')
assertExactMap(Object.keys(expected.safetyScopes), expected.safetyScopes, safetyScopeLabel, 'safety scope')
assertExactMap(contracts.CONFIDENCE_CLASSES, expected.confidence, confidenceLabel, 'confidence')
assertExactMap(contracts.FEASIBILITY_STATUSES, expected.feasibility, feasibilityLabel, 'feasibility')
assertExactMap(contracts.CANONICAL_UNITS.filter(Boolean), expected.canonicalUnits, canonicalUnitLabel, 'canonical unit')
assert.equal(canonicalUnitLabel(null), 'Unit unavailable', 'missing canonical units stay honest')

assert.equal(contracts.REQUIRED_REASON_CODES.length, 70, 'reason-code contract retains its expected closed size')
for (const code of contracts.REQUIRED_REASON_CODES) {
  assert.equal(Object.hasOwn(goalBackwardPresentationMappings.reasonCodes, code), true, `${code} has an explicit presentation mapping`)
  assert.equal(reasonCodeLabel(code), goalBackwardPresentationMappings.reasonCodes[code], `${code} uses its explicit presentation mapping`)
  assert.doesNotMatch(reasonCodeLabel(code), /_/, `${code} is underscore-free for customers`)
}

assert.equal(reasonCodeLabel('RECENT_LOAD_MAINTAIN'), 'Maintain the recent training load')
assert.equal(reasonCodeLabel('RECENT_LOAD_MAINTAIN', { sentence: true }), 'Maintain the recent training load.')
assert.equal(reasonCodeLabel('MATERIAL_UNDERTRAINING'), 'The proposed week reduces training too far without a qualifying reason')
assert.equal(reasonCodeLabel('MATERIAL_CHANGE_REVIEW_REQUIRED'), 'Review required because the plan changed materially')
assert.equal(reasonCodeLabel('MONITOR_RECOVERY'), 'Monitor recovery')
assert.equal(reasonCodeLabel('KEY_STIMULUS_REQUIRED'), 'This key training stimulus is required')
assert.equal(reasonCodeLabel('LIMITER_THRESHOLD'), 'Develop the current threshold limiter')
assert.equal(reasonCodeLabel('GOAL_EXPOSURES_SUPPORTED'), 'The required goal-specific training is supported')

assert.equal(safetyScopeList(['RUN', 'IMPACT']), 'Running, Impact activity')
assert.equal(safetyScopeList(['ALL']), 'All training')
assert.equal(safetyScopeList([]), 'No scoped restriction')

const unknown = 'SURPRISE_NEW_ENUM_VALUE'
for (const formatter of [
  phaseLabel,
  sessionRoleLabel,
  capabilityLabel,
  executabilityLabel,
  safetyActionLabel,
  safetyScopeLabel,
  reasonCodeLabel,
  confidenceLabel,
  feasibilityLabel,
  canonicalUnitLabel,
]) {
  const label = formatter(unknown)
  assert.equal(label, 'Surprise new enum value')
  assert.doesNotMatch(label, /_/)
}
assert.equal(humanizeMachineValue('unknown_title_value', { casing: 'title' }), 'Unknown Title Value')

const sourceIdentifiers = {
  decision_id: 'decision_with_underscores',
  session_id: 'session_with_underscores',
  evidence_ids: ['evidence_with_underscores'],
}
const sourceIdentifierBytes = Buffer.from(JSON.stringify(sourceIdentifiers))
assert.equal(technicalFactLabel(sourceIdentifiers.decision_id), 'Unavailable')
assert.equal(technicalFactLabel('sha256:abcdef0123456789'), 'sha256:abcdef0123456789')
assert.deepEqual(Buffer.from(JSON.stringify(sourceIdentifiers)), sourceIdentifierBytes, 'presentation leaves source identifier bytes unchanged')

const apiValues = {
  phase: 'EVENT_SPECIFIC_DEVELOPMENT',
  role: 'PRIMARY_KEY',
  capability: 'FULLY_STRUCTURED',
  executability: 'RESTRICTED',
  action: 'NO_RUNNING',
  scope: ['RUN', 'IMPACT'],
  reasons: ['RECENT_LOAD_MAINTAIN', 'MATERIAL_CHANGE_REVIEW_REQUIRED'],
}
const before = structuredClone(apiValues)
phaseLabel(apiValues.phase)
sessionRoleLabel(apiValues.role)
capabilityLabel(apiValues.capability)
executabilityLabel(apiValues.executability)
safetyActionLabel(apiValues.action)
safetyScopeList(apiValues.scope)
apiValues.reasons.map((reason) => reasonCodeLabel(reason))
assert.deepEqual(apiValues, before, 'presentation helpers never mutate source/API enum values')

console.log(`GOAL-BACKWARD PRESENTATION SMOKE OK (${contracts.REQUIRED_REASON_CODES.length} reason codes + all closed presentation enums)`)
