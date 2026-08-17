#!/usr/bin/env node

const assert = require('node:assert/strict');
const {
  ARTIFACT_KINDS,
  CLOSED_UNIONS,
  CONTRACT_VERSIONS,
  FEATURE_MODES,
  MAX_PIPELINE_ARTIFACT_BYTES,
  REDACTION_KEYS,
  REASON_CODE_FAMILIES,
  REASON_CODE_MIGRATION_ALIASES,
  REQUIRED_REASON_CODES,
  TRUTH_CLASSES,
  assertPipelineArtifact,
  assertPipelineLinks,
  validatePipelineArtifact,
  validatePipelineLinks,
  normalizeReasonCode,
} = require('../src/lib/goalBackwardContracts');

const hash = (character) => `sha256:${character.repeat(64)}`;

function artifact(kind, parentArtifactId = null, overrides = {}) {
  return {
    id: `artifact-${kind}`,
    user_id: 'athlete-ref-synthetic',
    artifact_kind: kind,
    decision_id: 'decision-synthetic',
    parent_artifact_id: parentArtifactId,
    plan_generation_candidate_id: kind === 'evidence_snapshot'
      || kind === 'athlete_state'
      || kind === 'planning_decision'
      ? null
      : 'candidate-synthetic',
    schema_version: 1,
    policy_version: 'goal-backward-planning-policy-v1',
    revision: 1,
    content_hash: hash('a'),
    payload_json: { source_refs: ['source-synthetic'] },
    created_at: '2026-08-14T12:00:00.000Z',
    ...overrides,
  };
}

function run() {
  assert.deepEqual(TRUTH_CLASSES, ['OBSERVED', 'DERIVED', 'PRESCRIBED', 'EXPLANATION']);
  assert.deepEqual(FEATURE_MODES, ['off', 'shadow', 'preview', 'on']);
  assert.equal(new Set(ARTIFACT_KINDS).size, 7);
  assert.deepEqual(ARTIFACT_KINDS, [
    'evidence_snapshot',
    'athlete_state',
    'planning_decision',
    'candidate_week',
    'validator_result',
    'canonical_session_set',
    'surface_manifest',
  ]);

  const requiredVersionKeys = [
    'evidence_schema_version',
    'athlete_state_schema_version',
    'planning_policy_version',
    'event_policy_registry_version',
    'stress_taxonomy_version',
    'target_policy_version',
    'target_conversion_registry_version',
    'planning_decision_schema_version',
    'canonical_workout_schema_version',
    'hyrox_ruleset_id',
    'hyrox_ruleset_version',
  ];
  assert.deepEqual(Object.keys(CONTRACT_VERSIONS), requiredVersionKeys);
  for (const key of requiredVersionKeys) {
    assert.notEqual(CONTRACT_VERSIONS[key], null, `${key} must be independently queryable`);
    assert.notEqual(CONTRACT_VERSIONS[key], undefined, `${key} must be independently queryable`);
  }
  assert.equal(Object.isFrozen(CONTRACT_VERSIONS), true);
  assert.equal(Object.isFrozen(CLOSED_UNIONS), true);
  for (const values of Object.values(CLOSED_UNIONS)) {
    assert.equal(Object.isFrozen(values), true, 'closed union members cannot be mutated at runtime');
  }
  assert.deepEqual(CLOSED_UNIONS.evidence_quality_states, ['COMPLETE', 'PARTIAL', 'FAILED_SYNC', 'CONFLICT', 'CORRUPTED']);
  assert.deepEqual(CLOSED_UNIONS.evidence_value_states, ['KNOWN', 'VALID_ZERO', 'UNKNOWN', 'MISSING', 'STALE']);
  assert.deepEqual(CLOSED_UNIONS.evidence_freshness_classes, ['FRESH', 'STALE', 'EXPIRED', 'TIMELESS']);

  const expectedReasonCodes = [
    'EVIDENCE_UNKNOWN',
    'EVIDENCE_MISSING',
    'FAILED_SYNC',
    'PARTIAL_SYNC',
    'EVIDENCE_CONFLICT_UNRESOLVED',
    'MANUAL_CORRECTION_APPLIED',
    'VALID_ZERO_CONFIRMED',
    'EVIDENCE_STALE',
    'RECENT_LOAD_MAINTAIN',
    'TAPER_VOLUME_REDUCTION',
    'RECOVERY_VOLUME_REDUCTION',
    'TRAINING_GAP_REBUILD',
    'SCHEDULE_CONSTRAINT',
    'CROSS_MODAL_FATIGUE_LIMIT',
    'PHASE_SPECIFIC_OVERLOAD',
    'RECENT_NORMAL_INSUFFICIENT',
    'MATERIAL_UNDERTRAINING',
    'HARD_DAY_STACK_TO_PROTECT_RECOVERY',
    'FOUNDATION_ENTRY',
    'DEVELOPMENT_ENTRY',
    'EVENT_SPECIFIC_ENTRY',
    'SHARPENING_ENTRY',
    'TAPER_ENTRY',
    'POST_RACE_TRANSITION',
    'REQUIRED_EXPOSURE_UNPLACEABLE',
    'PREMATURE_TAPER_PREVENTED',
    'LATE_BUILD_PREVENTED',
    'KEY_SESSION_COMPLETED_ON_TARGET',
    'EXCESSIVE_STRAIN',
    'MISSED_SESSION_SKIP',
    'MISSED_SESSION_RESCHEDULE',
    'NO_WORKOUT_DEBT',
    'ADAPTATION_REJECTED',
    'IDENTICAL_REJECTED_CANDIDATE_SUPPRESSED',
    'PAIN_MONITOR',
    'MODIFY_IMPACT',
    'NO_RUNNING',
    'NO_LOWER_BODY',
    'NO_HIGH_INTENSITY',
    'FULL_REST',
    'ILLNESS_RECOVERY',
    'PROFESSIONAL_ASSESSMENT_RECOMMENDED',
    'ILLNESS_STATUS_NEEDS_UPDATE',
    'INJURY_SCOPE',
    'BELOW_PRESENTATION_FLOOR_EXCEPTION',
    'PACE_EVIDENCE_STALE',
    'PACE_EVIDENCE_MISSING',
    'HR_RPE_FALLBACK',
    'ASSESSMENT_REQUIRED',
    'STATION_BENCHMARK_MISSING',
    'TRANSITION_BENCHMARK_MISSING',
    'DIVISION_UNKNOWN',
    'RULESET_UNSUPPORTED',
    'TEAM_INDIVIDUAL_BURDEN_UNKNOWN',
    'ENVIRONMENT_EFFORT_OVERRIDE',
    'UNKNOWN_INVENTORY',
    'PARTIAL_SHOE_MILEAGE',
    'MATERIAL_CHANGE_REVIEW_REQUIRED',
    'ATHLETE_LOCK_CONFLICT',
    'ATHLETE_EDIT_PRESERVED',
    'STALE_PLAN_REVISION',
    'STALE_ATHLETE_STATE',
    'RACE_REVISION_CHANGED',
    'DUPLICATE_APPLY_IDEMPOTENT',
    'DERIVED_TOTAL_MISMATCH',
    'SESSION_ROLE_UNJUSTIFIED',
    'WORKOUT_FAMILY_UNRESOLVED',
    'EXPORT_CAPABILITY_PARTIAL',
    'EXPORT_MANUAL_COMPONENT_REQUIRED',
    'SURFACE_REVISION_MISMATCH',
  ];
  assert.deepEqual(REQUIRED_REASON_CODES, expectedReasonCodes);
  assert.equal(new Set(REQUIRED_REASON_CODES).size, REQUIRED_REASON_CODES.length);
  assert.equal(REQUIRED_REASON_CODES.length, 70);
  assert.deepEqual(REQUIRED_REASON_CODES, Object.values(REASON_CODE_FAMILIES).flat());
  assert.equal(REQUIRED_REASON_CODES.includes('NO_IMPACT'), false, 'migration alias is never persisted');
  assert.deepEqual(REASON_CODE_MIGRATION_ALIASES, { NO_IMPACT: 'MODIFY_IMPACT' });
  assert.equal(normalizeReasonCode('NO_IMPACT'), null);
  assert.equal(normalizeReasonCode('NO_IMPACT', { allowMigrationAlias: true }), 'MODIFY_IMPACT');
  for (const key of ['access_token', 'email', 'phone', 'provider_payload', 'route_coordinates', 'secret']) {
    assert.equal(REDACTION_KEYS.includes(key), true, `${key} must be rejected from artifacts`);
  }

  const validArtifact = artifact('evidence_snapshot');
  assert.deepEqual(validatePipelineArtifact(validArtifact), {
    valid: true,
    errors: [],
    bytes: Buffer.byteLength(JSON.stringify(validArtifact.payload_json), 'utf8'),
  });
  assert.equal(assertPipelineArtifact(validArtifact), validArtifact);
  const badKind = validatePipelineArtifact(artifact('model_thoughts'));
  assert.equal(badKind.valid, false);
  assert.equal(badKind.errors.some((error) => error.code === 'ARTIFACT_KIND_INVALID'), true);
  const privatePayload = validatePipelineArtifact(artifact('evidence_snapshot', null, {
    payload_json: { nested: { accessToken: 'must-not-persist' } },
  }));
  assert.equal(privatePayload.valid, false);
  assert.equal(privatePayload.errors.some((error) => error.code === 'ARTIFACT_REDACTION_REQUIRED'), true);
  const lossyPayload = validatePipelineArtifact(artifact('evidence_snapshot', null, {
    payload_json: { distance_m: Number.POSITIVE_INFINITY },
  }));
  assert.equal(lossyPayload.valid, false);
  assert.equal(lossyPayload.errors.some((error) => error.code === 'ARTIFACT_PAYLOAD_NOT_CANONICAL_JSON'), true);
  assert.equal(validatePipelineArtifact(artifact('evidence_snapshot', null, {
    payload_json: { provenance: { provider_payload_hash: hash('b') } },
  })).valid, true, 'provider payload hashes remain available without retaining raw payloads');
  const oversized = validatePipelineArtifact(artifact('evidence_snapshot', null, {
    payload_json: { value: 'x'.repeat(MAX_PIPELINE_ARTIFACT_BYTES) },
  }));
  assert.equal(oversized.valid, false);
  assert.equal(oversized.errors.some((error) => error.code === 'ARTIFACT_PAYLOAD_TOO_LARGE'), true);
  assert.throws(
    () => assertPipelineArtifact(artifact('evidence_snapshot', null, { revision: 0 })),
    (error) => error?.code === 'INVALID_PIPELINE_ARTIFACT' && error?.status === 422,
  );

  const artifacts = [];
  let parentArtifactId = null;
  for (const kind of ARTIFACT_KINDS) {
    const current = artifact(kind, parentArtifactId);
    artifacts.push(current);
    parentArtifactId = current.id;
  }
  assert.deepEqual(validatePipelineLinks(artifacts), { valid: true, errors: [] });
  assert.equal(assertPipelineLinks(artifacts), artifacts);
  const broken = artifacts.map((entry) => ({ ...entry }));
  broken[5].parent_artifact_id = broken[2].id;
  assert.equal(validatePipelineLinks(broken).valid, false);
  assert.throws(
    () => assertPipelineLinks(artifacts.slice(0, -1)),
    (error) => error?.code === 'INVALID_PIPELINE_LINKS' && error?.status === 422,
  );

  console.log('ok - TRUTH-01 closed truth/version/reason contracts');
  console.log('ok - OBS-01 bounded redacted diagnostic artifacts');
  console.log('ok - PIPE-01 seven linked pipeline artifacts');
  console.log('GOAL BACKWARD CONTRACTS SMOKE OK (3)');
}

if (require.main === module) run();

module.exports = { run };
