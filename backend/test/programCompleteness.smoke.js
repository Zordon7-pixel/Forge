const assert = require('node:assert/strict');
const { scenario } = require('./programFixtures');
const canonical = require('../src/lib/canonicalWorkout');
const combined = require('../src/lib/canonicalCombinedLoad');
const { canonicalHash } = require('../src/lib/racePlanPolicy');
const { validatePipelineArtifact, PROGRAM_ARTIFACT_STORAGE_VERSION } = require('../src/lib/goalBackwardContracts');
const { buildPipelineArtifact, validatedCompleteProgramPlan, assertPersistablePlan, normalizeProgramConstructorBundle } = require('../src/lib/planCandidateLifecycle');

const all = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const rawHistory = Array.from({ length: 28 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 8, 6 - index));
  const distance = date.getUTCDay() === 0 ? 10 : 3;
  return { id: `synthetic-endurance-${index}`, date: date.toISOString().slice(0, 10),
    distance_miles: distance, duration_seconds: distance * 840,
    type: date.getUTCDay() === 0 ? 'long' : 'easy', health_source: 'manual' };
});
const started = performance.now();
const seven = scenario({ trainingAge: 'ADVANCED', count: 28, miles: 28, liftDays: 7, runDays: all, rawHistory });
assert.ok(seven.result.selected_candidate?.validation.valid, JSON.stringify(seven.result.program_failure));
assert.equal(seven.accepted.weeks.length, 5);
const selected = seven.result.selected_candidate;
assert.equal(canonical.validateCanonicalSessionSet(selected.canonical_session_set).valid, true);
const { goalBackwardRetainedWorkComparator, goalBackwardRemovalCarryForwardMaterial } = require('../src/routes/plans')._test;
const eventSession = selected.sessions.find(session => session.workout_family === 'race');
const removedRaceId = eventSession.event_identity.race_id;
const removalState = { request: { operation: 'remove_race', remove_race_id: removedRaceId }, races: [{ id: 'another-owned-goal' }] };
const originalBytes = JSON.stringify(seven.accepted);
const retained = goalBackwardRetainedWorkComparator(removalState, seven.accepted, eventSession.event_identity.athlete_id);
const allSessions = plan => plan.weeks.flatMap(week => week.days.flatMap(day => day.sessions));
assert.deepEqual(allSessions(retained), allSessions(seven.accepted).filter(session => session.session_id !== eventSession.session_id),
  'Explicit canceled event is excluded from retained workload; every shared training session remains byte-identical');
assert.equal(JSON.stringify(seven.accepted), originalBytes, 'Comparator never mutates accepted identity');
const timedRaw = structuredClone(selected.sessions.find(session => session.workout_family === 'easy_run'));
for (const step of timedRaw.steps) { delete step.target.distance_m; delete step.target.reference_pace_range_s_per_km; }
const timed = require('../src/lib/runningDoseAccounting').bindRunningDosePool([timedRaw], {
  policy_version: require('../src/lib/runningDoseAccounting').VERSION, authority: 'CONSERVATIVE_TEMPLATE', allow_effort_only: true,
})[0];
const timedCarryPlan = { ...seven.accepted, weeks: [{ days: [{ date: timed.scheduled_local_date, sessions: [timed] }] }] };
const timedCarryState = { request: { operation: 'remove_race', remove_race_id: 'canceled-secondary' }, races: [{ id: removedRaceId }] };
const timedCarry = goalBackwardRemovalCarryForwardMaterial(timedCarryState, timedCarryPlan, [timed.scheduled_local_date]);
assert.deepEqual(timedCarry, [timed], 'Useful zero-distance/known-duration canonical carry retains exact hashed bytes, not legacy aliases');
assert.equal(canonical.validateCanonicalSession(timedCarry[0]).valid, true);
const forgedTimedPlan = structuredClone(timedCarryPlan); forgedTimedPlan.weeks[0].days[0].sessions[0].steps[0].target.duration_s += 1;
assert.deepEqual(goalBackwardRemovalCarryForwardMaterial(timedCarryState, forgedTimedPlan, [timed.scheduled_local_date]), [],
  'Timed carry does not accept content-hash tampering');
assert.deepEqual(goalBackwardRetainedWorkComparator(removalState, seven.accepted, 'wrong-owner'), seven.accepted);
assert.deepEqual(goalBackwardRetainedWorkComparator({ ...removalState, races: [{ id: removedRaceId }] }, seven.accepted,
  eventSession.event_identity.athlete_id), seven.accepted, 'An event still in owned goals cannot be excluded');
for (const mutate of [session => { session.event_identity.race_id = 'other'; },
  session => { session.event_identity.event_local_date = '2026-10-10'; },
  session => { session.workout_family = 'easy_run'; }, session => { session.content_hash = 'forged'; }]) {
  const altered = structuredClone(seven.accepted);
  mutate(allSessions(altered).find(session => session.session_id === eventSession.session_id));
  assert.deepEqual(allSessions(goalBackwardRetainedWorkComparator(removalState, altered,
    eventSession.event_identity.athlete_id)), allSessions(altered), 'Labels and mismatched canonical identity never erase workload');
}
for (const week of seven.accepted.weeks.slice(0, 3)) {
  const sessions = week.days.flatMap(day => day.sessions);
  assert.equal(sessions.filter(session => session.kind === 'run').length, 7);
  assert.equal(sessions.filter(session => session.kind === 'lift').length, 7);
  assert.ok(sessions.every(session => session.steps.length > 0));
}
assert.ok(seven.accepted.programReconciliation.every(week => week.valid));
assert.ok(seven.accepted.programReconciliation.at(-1).entries.every(entry => entry.outcome === 'DISCLOSED_ADJUSTMENT'));

const source = selected.workload_evidence.canonical_load_source;
const { sourceBoundTaperRunAdjustment, reconcileProgramWeek } = require('../src/lib/programContract');
const sourceRuns = source.canonical_session_set.sessions.filter(session => session.kind === 'run');
const taperWeek = { startDate: '2026-09-07', phase: 'taper',
  runFrequencyAdjustment: { policy: 'TAPER_RUNNING_VOLUME_DISTRIBUTION', requested: 7, prescribed: 1,
    explanation: 'Retain the independently selected useful taper work.' },
  days: all.map((day, index) => ({ date: `2026-09-${String(7 + index).padStart(2, '0')}`, sessions: [] })) };
const taperAdjustment = sourceBoundTaperRunAdjustment(taperWeek, source, source.context_hash);
assert.equal(taperAdjustment.prescribed, sourceRuns.length, 'Adjustment follows the independent source, not constructor-only metadata');
assert.equal(taperAdjustment.constructor_prescribed, 1);
assert.equal(taperAdjustment.authoritative_source_hash, source.content_hash);
assert.deepEqual(taperAdjustment.authoritative_session_ids, sourceRuns.map(session => session.session_id));
assert.equal(sourceBoundTaperRunAdjustment(taperWeek, source, 'wrong-context'), null);
assert.equal(sourceBoundTaperRunAdjustment({ ...taperWeek, phase: 'base' }, source, source.context_hash), null);
assert.equal(sourceBoundTaperRunAdjustment(taperWeek, { ...source, content_hash: '0'.repeat(64) }, source.context_hash), null);
const droppedSourceRunWeek = { ...taperWeek, runFrequencyAdjustment: taperAdjustment,
  days: taperWeek.days.map(day => ({ ...day, sessions: sourceRuns.slice(1).filter(session => session.scheduled_local_date === day.date) })) };
const sourceContract = { ...seven.accepted.programContract, planning_date: '2026-09-07', lift_days_per_week: 0 };
assert.equal(reconcileProgramWeek(sourceContract, droppedSourceRunWeek).valid, false,
  'Dropping a selected candidate run cannot rewrite the independently bound taper expectation');
assert.equal(combined.evaluateCanonicalCombinedLoad(source.canonical_session_set.sessions, source, source.context_hash).valid, true);
for (const mutate of [...['taxonomy','running','strength','combined'].map(key => value => { value.versions[key] = 'wrong-version'; }),
  value => { value.base_vector[0] += 1; }, value => { value.context_hash = 'wrong'; }]) {
  const forged = structuredClone(source); mutate(forged);
  assert.equal(combined.evaluateCanonicalCombinedLoad(source.canonical_session_set.sessions, forged, source.context_hash).state, 'INVALID_LOAD_ARTIFACT');
}
const increasedSource = structuredClone(source.canonical_session_set.sessions);
for (const session of increasedSource) if (['easy_run','recovery_run'].includes(session.workout_family)) {
  for (const step of session.steps) step.target.duration_s *= 10;
}
const poolSource = source.canonical_session_set.sessions.find(session => session.running_dose).running_dose.source;
const downgradedSource = structuredClone(poolSource);
delete downgradedSource.normalization; delete downgradedSource.normalization_hash;
const downgradedSet = structuredClone(source.canonical_session_set);
downgradedSet.sessions = require('../src/lib/runningDoseAccounting').bindRunningDosePool(downgradedSet.sessions, downgradedSource);
downgradedSet.session_content_hashes = downgradedSet.sessions.map(s => ({ session_id: s.session_id, content_hash: s.content_hash }));
downgradedSet.content_hash = canonical.canonicalSessionSetHash(downgradedSet);
downgradedSet.candidate_hash = canonicalHash({ candidate_skeleton_hash: downgradedSet.candidate_skeleton_hash,
  canonical_session_set_hash: downgradedSet.content_hash });
assert.equal(canonical.validateCanonicalSessionSet(downgradedSet).valid, true,
  'Negative has valid canonical hashes, not merely a malformed envelope');
assert.throws(() => combined.buildCanonicalLoadSource(downgradedSet, { contextHash: source.context_hash }),
  /Independent source set is invalid/, 'V3 source cannot downgrade to an isolated default conversion');
const forgedSource = structuredClone(source);
forgedSource.canonical_session_set = downgradedSet;
forgedSource.base_vector = combined.sumBase(downgradedSet.sessions);
const { content_hash: ignoredSourceHash, ...forgedSourceContent } = forgedSource;
forgedSource.content_hash = canonicalHash(forgedSourceContent);
assert.equal(combined.evaluateCanonicalCombinedLoad(downgradedSet.sessions, forgedSource, source.context_hash).state,
  'INVALID_LOAD_ARTIFACT', 'Rehashed source and candidate still need independently bound normalization');
const increased = require('../src/lib/runningDoseAccounting').bindRunningDosePool(increasedSource, poolSource);
assert.equal(combined.evaluateCanonicalCombinedLoad(increased, source, source.context_hash).state, 'UNSUPPORTED_OVERAGE',
  'A valid larger canonical prescription cannot promote its own source budget');
const distanceOnly = structuredClone(source.canonical_session_set.sessions);
const protectedIndex = distanceOnly.findIndex(session => !session.running_dose
  && !session.workout_family.startsWith('strength_') && session.steps.some(step => step.target?.distance_m > 0));
assert.ok(protectedIndex >= 0, 'Distance guard fixture contains genuine protected running work');
const protectedRun = distanceOnly[protectedIndex];
protectedRun.steps.find(step => step.target?.distance_m > 0).target.distance_m += 1000;
delete protectedRun.content_hash; delete protectedRun.canonical_workout_schema_version;
distanceOnly[protectedIndex] = canonical.buildCanonicalSession(protectedRun);
assert.deepEqual(combined.sumBase(distanceOnly), combined.sumBase(source.canonical_session_set.sessions),
  'Protected-family ordinal vector is unchanged; this negative specifically requires the independent distance guard');
assert.ok(combined.evaluateCanonicalCombinedLoad(distanceOnly, source, source.context_hash).violations
  .some(value => value.reason === 'CANONICAL_SOURCE_RUNNING_DISTANCE_EXCEEDED'));
const rollingDistance = combined.validateRollingCanonicalLoad(distanceOnly, [source]);
assert.equal(rollingDistance.valid, false);
assert.ok(rollingDistance.windows.some(window => window.actual.every((value, index) => value <= window.source[index] + 1e-6)
  && window.actual_distance_m > window.source_distance_m), 'Rolling distance cannot hide behind an unchanged dose vector');

const artifact = buildPipelineArtifact({ userId: 'synthetic-artifact-owner', kind: 'canonical_session_set',
  decisionId: selected.canonical_session_set.decision_id, planGenerationCandidateId: 'synthetic-candidate',
  payload: selected.canonical_session_set });
assert.equal(validatePipelineArtifact(artifact).valid, true);
const spoof = { ...artifact, payload_json: { program_storage_version: PROGRAM_ARTIFACT_STORAGE_VERSION,
  program_contract: selected.canonical_session_set.program_contract,
  sessions: [{ canonical_workout_schema_version: 1 }], padding: 'x'.repeat(300000) } };
spoof.content_hash = `sha256:${canonicalHash(spoof.payload_json)}`;
assert.equal(validatePipelineArtifact(spoof).valid, false, 'Version and self-hashed contract do not authorize an enlarged malformed payload');
const oversized = structuredClone(artifact);
oversized.payload_json.padding = 'x'.repeat(4194304);
assert.ok(validatePipelineArtifact(oversized).errors.some(error => error.code === 'ARTIFACT_PAYLOAD_TOO_LARGE'));
const legacy = { ...artifact, artifact_kind: 'validator_result', payload_json: { padding: 'x'.repeat(300000) } };
assert.ok(validatePipelineArtifact(legacy).errors.some(error => error.code === 'ARTIFACT_PAYLOAD_TOO_LARGE'));
const longestStarted = performance.now();
const longest = scenario({ raceDate: '2027-01-24', trainingAge: 'ADVANCED', count: 28,
  miles: 28, liftDays: 7, runDays: all, rawHistory });
assert.ok(longest.result.selected_candidate?.validation.valid, JSON.stringify({ failure: longest.result.program_failure,
  week: longest.result.failed_program_week, boundary: longest.result.program_boundary_diagnostics }));
assert.equal(longest.accepted.weeks.length, 20);
assert.ok(longest.accepted.programReconciliation.every(week => week.valid));
for (const week of longest.accepted.weeks.filter(week => !['taper','race'].includes(week.phase))) {
  const sessions = week.days.flatMap(day => day.sessions);
  assert.equal(sessions.filter(session => session.kind === 'run').length, 7);
  assert.equal(sessions.filter(session => session.kind === 'lift').length, 7);
}
const longestSet = longest.result.selected_candidate.canonical_session_set;
const expansionCarry = require('../src/routes/plans')._test.goalBackwardGoalExpansionCarryForwardMaterial;
const expansionState = { request: {}, races: [{ id: longest.accepted.goals[0].raceId }, { id: 'synthetic-added-race' }] };
// The production reader receives a stored JSON value, not the constructor's
// shared in-memory object graph. Keep the own-data parser's alias rejection.
const persistedLongest = JSON.parse(JSON.stringify(longest.accepted));
const sharedGraph = structuredClone(persistedLongest);
sharedGraph.shared_alias = sharedGraph.programContract;
assert.throws(() => expansionCarry('synthetic-artifact-owner', expansionState, sharedGraph, null, ['2026-09-07']),
  error => error.code === 'GOAL_EXPANSION_CARRY_FORWARD_SOURCE_INVALID' && /PLAN_SNAPSHOT_INVALID/.test(error.message),
  'Stored JSON cannot contain shared graph aliases; the outer parser remains fail-closed');
assert.throws(() => expansionCarry('synthetic-artifact-owner', expansionState, persistedLongest, null, ['2026-09-07']),
  error => error.code === 'GOAL_EXPANSION_CARRY_FORWARD_SOURCE_INVALID' && /OWN_DATA_SNAPSHOT_INVALID/.test(error.message),
  'Maximum program passes outer bounded snapshot and still requires actual authenticated stored source');
for (const mutate of [plan => { plan.programContract.version = 'spoof'; },
  plan => { plan.padding = 'x'.repeat(4194304); }]) {
  const invalid = structuredClone(persistedLongest); mutate(invalid);
  assert.throws(() => expansionCarry('synthetic-artifact-owner', expansionState, invalid, null, ['2026-09-07']),
    error => error.code === 'GOAL_EXPANSION_CARRY_FORWARD_SOURCE_INVALID' && /PLAN_SNAPSHOT_INVALID/.test(error.message),
    'Actual outer expansion reader rejects non-versioned or oversized material instead of widening legacy limits');
}
const longestArtifact = buildPipelineArtifact({ userId: 'synthetic-artifact-owner', kind: 'canonical_session_set',
  decisionId: longestSet.decision_id, planGenerationCandidateId: 'synthetic-longest', payload: longestSet });
assert.equal(validatePipelineArtifact(longestArtifact).valid, true);
assert.equal(validatedCompleteProgramPlan(longest.accepted), true);
const { strictRemovalPlanSnapshot } = require('../src/routes/plans')._test;
assert.equal(strictRemovalPlanSnapshot({ plan_data: JSON.stringify(longest.accepted) },
  longest.accepted.programContract.planning_date, longest.accepted.goals[0].raceId).plan.weeks.length, 20,
  'The actual removal snapshot reader accepts a bounded canonical maximum horizon');
const corruptRemoval = structuredClone(longest.accepted); corruptRemoval.weeks[0].days.find(day => day.sessions.length).sessions[0].content_hash = '0'.repeat(64);
assert.throws(() => strictRemovalPlanSnapshot({ plan_data: JSON.stringify(corruptRemoval) },
  longest.accepted.programContract.planning_date, longest.accepted.goals[0].raceId),
  'A versioned removal cannot silently regenerate away corrupt accepted canonical content');
assert.doesNotThrow(() => assertPersistablePlan(longest.accepted));
const preliminary = normalizeProgramConstructorBundle({ plan: longest.built.plan, snapshot: {}, trace: {} }).plan;
assert.throws(() => assertPersistablePlan(preliminary), error => error.code === 'PRELIMINARY_PROGRAM_NOT_PERSISTABLE');
assert.throws(() => assertPersistablePlan(structuredClone(preliminary)), error => error.code === 'PLAN_CANDIDATE_TOO_LARGE');
for (const mutate of [plan => { plan.programCanonicalIdentity.content_hash = '0'.repeat(64); },
  plan => { plan.programContract.end_date = '2028-01-01'; },
  plan => { plan.weeks[1].days[0].sessions[0].scheduled_local_date = '2028-01-01'; }]) {
  const forgedPlan = structuredClone(longest.accepted); mutate(forgedPlan);
  assert.equal(validatedCompleteProgramPlan(forgedPlan), false);
  assert.throws(() => assertPersistablePlan(forgedPlan));
}
const { ownDataJsonSnapshot, ownMaterializedProgramSnapshot } = require('../src/lib/goalBackwardRecoveryMaterial');
assert.ok(ownMaterializedProgramSnapshot(longestSet), 'Version-scoped own-data parser supports an actual maximal legal program');
const largeLegacy = { values: Array(60000).fill(0) };
assert.equal(ownDataJsonSnapshot(largeLegacy, { maximumNodes: 500000 }), null, 'Untrusted legacy parser bound remains unchanged');
assert.equal(ownMaterializedProgramSnapshot(largeLegacy), null, 'An enlarged arbitrary object is not a versioned program');
console.log(JSON.stringify({ gate: 'max-horizon-complete-program', weeks: 20, sessions: longestSet.sessions.length,
  json_bytes: Buffer.byteLength(JSON.stringify(longestSet)), generation_ms: Math.round(performance.now() - longestStarted) }));
console.log(`COMPLETE PROGRAM GATE OK: raw-observation 7/7, five-week canonical identity, explicit phase adjustments, source authority and storage-spoof guards (${Math.round(performance.now() - started)}ms)`);
