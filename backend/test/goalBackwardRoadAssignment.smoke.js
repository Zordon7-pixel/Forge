#!/usr/bin/env node

const assert = require('node:assert/strict');

const plansRouter = require('../src/routes/plans');
const {
  buildGoalBackwardCandidateSkeleton,
  completeRoleMaterialAssignment,
  materializeGoalBackwardCandidate,
} = require('../src/lib/racePlanCandidateEngine');

const METERS_PER_MILE = 1609.344;

function assignmentDecision(roles) {
  return {
    decision_id: 'decision-adversarial-road-assignment',
    decision_hash: 'a'.repeat(64),
    phase: 'DEVELOPMENT',
    primary_goal_id: 'goal-adversarial-road-assignment',
    plan_revision: 1,
    timezone: 'America/New_York',
    training_age_class: 'ESTABLISHED',
    safety_state: { action: 'NORMAL', scope: [] },
    active_goals: [{
      goal_id: 'goal-adversarial-road-assignment',
      event_kind: 'ROAD_ENDURANCE',
      priority: 'A',
    }],
    evidence_used: [],
    role_multiset: roles,
  };
}

function overlappingRoles(options = {}) {
  return [
    {
      requirement_id: 'broad-quality',
      any_of: ['threshold_run', 'interval_run'],
      role: 'PRIMARY_KEY',
    },
    {
      requirement_id: 'threshold-only',
      any_of: ['threshold_run'],
      role: 'PRIMARY_KEY',
      ...(options.pinned === true ? { candidate_material_id: 'shared-threshold' } : {}),
    },
  ];
}

function overlappingMaterial() {
  return [
    {
      id: 'shared-threshold',
      session_id: 'shared-threshold',
      kind: 'run',
      workout_family: 'threshold_run',
      prescription_basis: 'distance',
      distance_m: 5000,
      duration_min: 35,
    },
    {
      id: 'alternate-interval',
      session_id: 'alternate-interval',
      kind: 'run',
      workout_family: 'interval_run',
      prescription_basis: 'distance',
      distance_m: 4500,
      duration_min: 35,
    },
  ];
}

function skeletonFor(roles, material = overlappingMaterial()) {
  return buildGoalBackwardCandidateSkeleton({
    decision: assignmentDecision(roles),
    legacy_road_candidate_material: material,
    validate: false,
  });
}

function assertStableDecimal(value, digits, message) {
  assert.equal(typeof value, 'number', message);
  assert.equal(Number.isFinite(value), true, message);
  const factor = 10 ** digits;
  assert.ok(Math.abs((value * factor) - Math.round(value * factor)) < 1e-7, message);
}

function checkAdversarialCompleteAssignment() {
  const roles = overlappingRoles();
  const skeleton = skeletonFor(roles);
  assert.deepEqual(
    skeleton.sessions.map((session) => session.candidate_material_id),
    ['alternate-interval', 'shared-threshold'],
    'an earlier overlapping role must not consume the later role\'s only valid material',
  );

  const pinnedRoles = overlappingRoles({ pinned: true });
  const pinned = skeletonFor(pinnedRoles);
  assert.deepEqual(
    pinned.sessions.map((session) => session.candidate_material_id),
    ['alternate-interval', 'shared-threshold'],
    'a pinned material ID must be reserved before compatible unpinned roles are assigned',
  );

  const repeats = Array.from({ length: 5 }, () => skeletonFor(pinnedRoles));
  assert.equal(new Set(repeats.map((entry) => entry.candidate_hash)).size, 1);
  assert.equal(new Set(repeats.map((entry) => JSON.stringify(entry.sessions))).size, 1);

  const normalizedMaterial = overlappingMaterial().map((session) => ({
    material_id: session.session_id,
    workout_family: session.workout_family,
  }));
  assert.deepEqual(
    completeRoleMaterialAssignment(pinnedRoles, normalizedMaterial)
      .map((material) => material.material_id),
    ['alternate-interval', 'shared-threshold'],
  );
  assert.equal(
    completeRoleMaterialAssignment(pinnedRoles, normalizedMaterial.slice(0, 1)),
    null,
    'an impossible one-to-one assignment must fail closed',
  );
}

function checkRouteRepairUsesCompleteAssignment() {
  const roles = overlappingRoles({ pinned: true });
  const selected = [overlappingMaterial()[0]];
  const repaired = plansRouter._test.goalBackwardRequiredRoadMaterial(
    selected,
    overlappingMaterial(),
    { role_multiset: roles },
    'ROAD_ENDURANCE',
  );
  assert.deepEqual(
    repaired.map((session) => session.session_id),
    ['shared-threshold', 'alternate-interval'],
    'repair must add the alternate material when the pinned desired material is already selected',
  );
  assert.deepEqual(
    plansRouter._test.goalBackwardSelectedMaterialIds(repaired, roles),
    ['alternate-interval', 'shared-threshold'],
  );
}

function checkRoadTopUpPrecision() {
  const roles = [
    {
      requirement_id: 'easy', any_of: ['easy_run'], role: 'SUPPORTING',
      candidate_material_id: 'easy-material',
    },
    {
      requirement_id: 'long', any_of: ['long_aerobic'], role: 'PRIMARY_KEY',
      candidate_material_id: 'long-material',
    },
  ];
  const material = [
    {
      id: 'easy-material', session_id: 'easy-material', kind: 'run',
      workout_family: 'easy_run', prescription_basis: 'distance',
      distance_m: 3000, duration_min: 25,
    },
    {
      id: 'long-material', session_id: 'long-material', kind: 'run',
      workout_family: 'long_aerobic', prescription_basis: 'distance',
      distance_m: 5000, duration_min: 35,
    },
  ];
  const requiredRunningM = 10001;
  const options = {
    enabled: true,
    projectionPaceSecondsPerMile: 600,
    roles,
  };
  const toppedUp = plansRouter._test.goalBackwardTopUpRoadRunningMaterial(
    material,
    requiredRunningM,
    options,
  );
  const repeated = plansRouter._test.goalBackwardTopUpRoadRunningMaterial(
    material,
    requiredRunningM,
    options,
  );
  assert.deepEqual(repeated, toppedUp, 'repeat top-up generation must be byte-stable');
  assert.notEqual(toppedUp, material);
  for (const session of toppedUp) {
    assert.ok(session.distance_miles > 0 && session.duration_min > 0);
    assertStableDecimal(session.distance_miles, 6, 'road top-up miles use at most six decimals');
    assertStableDecimal(session.duration_min, 0, 'road top-up minutes use whole-minute precision');
  }
  const displayedCoverageM = toppedUp.reduce((sum, session) => (
    sum + Math.round(session.distance_miles * METERS_PER_MILE)
  ), 0);
  assert.ok(
    displayedCoverageM >= requiredRunningM,
    `stable miles must preserve exact-or-above canonical coverage: ${displayedCoverageM} < ${requiredRunningM}`,
  );

  const decision = assignmentDecision(roles);
  const placements = {
    easy: { scheduled_local_date: '2026-09-01', workout_family: 'easy_run' },
    long: { scheduled_local_date: '2026-09-03', workout_family: 'long_aerobic' },
  };
  const skeleton = buildGoalBackwardCandidateSkeleton({
    decision,
    placements,
    legacy_road_candidate_material: toppedUp,
    validate: false,
  });
  const canonical = materializeGoalBackwardCandidate(skeleton, {
    decision,
    candidate_plan_id: 'plan-road-top-up-precision',
    candidate_plan_revision: 2,
    timezone: decision.timezone,
  });
  const repeatedCanonical = materializeGoalBackwardCandidate(skeleton, {
    decision,
    candidate_plan_id: 'plan-road-top-up-precision',
    candidate_plan_revision: 2,
    timezone: decision.timezone,
  });
  assert.equal(repeatedCanonical.candidate_hash, canonical.candidate_hash);
  assert.deepEqual(
    canonical.sessions.map((session) => session.distance_miles),
    toppedUp.map((session) => session.distance_miles),
    'the accepted presenter surface preserves the bounded source-mile precision',
  );
  assert.deepEqual(
    canonical.sessions.map((session) => session.duration_min),
    toppedUp.map((session) => session.duration_min),
    'the accepted presenter surface preserves whole-minute top-up precision',
  );
  const canonicalRunningM = canonical.sessions.reduce((sum, session) => (
    sum + session.derived_totals.distance_m
  ), 0);
  assert.ok(
    canonicalRunningM >= requiredRunningM,
    `canonical materialization must preserve exact-or-above coverage: ${canonicalRunningM} < ${requiredRunningM}`,
  );
}

function run() {
  checkAdversarialCompleteAssignment();
  checkRouteRepairUsesCompleteAssignment();
  checkRoadTopUpPrecision();
  console.log('GOAL BACKWARD ROAD ASSIGNMENT SMOKE OK');
}

if (require.main === module) run();

module.exports = { run };
