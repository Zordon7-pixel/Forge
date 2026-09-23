const assert = require('node:assert/strict');
const { classifyCompletionOutcome: classify, summarizeCompletionOutcomes: summarize, translateCompletionEvidence } = require('../src/lib/adaptationEngine');
const { buildCompletionOutcomeEvidence, buildCompletionOutcomeRevisions } = require('../src/lib/planningRevision');
const { latestCompletionPairs, QUALITY_FAMILIES } = require('../src/lib/completionOutcomeContract');
const { buildFamilyProgression } = require('../src/lib/adaptiveCoachingProgression');
const { fixture, withObservedWork } = require('./adaptiveCoachingSolver.smoke');
const { buildAdaptiveCoachingFoundation } = require('../src/lib/adaptiveCoachingFoundation');
const { buildAdaptiveSessionSelection } = require('../src/lib/adaptiveCoachingSelection');
const { canonicalHash } = require('../src/lib/racePlanPolicy');
const UNKNOWN = 'UNSCORABLE_INSUFFICIENT_EVIDENCE';
const easy = { session_id: 'easy', workout_family: 'easy_run', duration_s: 3000 };
const observe = (observation, prescribedSession = easy) => classify({ prescribedSession, observation: {
  evidence_id: 'observed-activity', linked_session_id: prescribedSession.session_id,
  observed_at: '2026-09-12T12:00:00Z', quality_state: 'COMPLETE', completed: true, ...observation,
} });
for (const value of [undefined, null, '', ' ', false, true, [], {}, -1, '-1', NaN, Infinity, 'invalid']) {
  const outcome = observe({ observed_duration_s: value, target_met: true, outcome: 'ON_TARGET' });
  assert.equal(outcome.outcome, UNKNOWN);
  assert.equal(outcome.scorable, false);
  assert.equal(outcome.observed_to_prescribed_ratio, null);
  assert.equal(outcome.dose_outcome, null);
  assert.ok(outcome.reason_codes.includes('COMPLETION_METRICS_UNAVAILABLE'));
  const persisted = buildCompletionOutcomeEvidence(outcome, { athleteId: 'synthetic', createdAt: '2026-09-13T12:00:00Z' });
  assert.equal(persisted.value.observed_to_prescribed_ratio, null);
}
assert.equal(observe({ observed_duration_s: 0 }).outcome, 'UNDER_TARGET', 'observed zero is not absent');
assert.equal(observe({ observed_duration_s: '3000' }).outcome, 'ON_TARGET', 'legacy numeric string supported');
assert.equal(observe({ observed_duration_s: 3600, target_met: true, outcome: 'ON_TARGET' }).outcome, 'ABOVE_TARGET');
assert.equal(observe({ observed_duration_s: 1500, outcome: 'ABOVE_TARGET' }).outcome, 'UNDER_TARGET');
for (const quality_state of ['CONFLICT', 'CORRUPTED', 'UNKNOWN', 'MISSING', 'STALE', 'invalid']) {
  const untrusted = observe({ observed_duration_s: 3000, quality_state });
  assert.equal(untrusted.outcome, UNKNOWN);
  assert.equal(untrusted.observed_to_prescribed_ratio, null);
}
assert.equal(observe({ observed_duration_s: 1e308 }, { ...easy, duration_s: 1e-308 }).outcome, UNKNOWN, 'overflow is not valid precision');
assert.equal(observe({ observed_duration_s: 1e308 }, { ...easy, duration_s: 1 }).outcome, UNKNOWN, 'serialization precision cannot overflow');
for (const value of [null, undefined, '', ' ', false, [], {}, -1, NaN, Infinity]) {
  const outcome = { ...observe({ observed_duration_s: 3000 }), observed_to_prescribed_ratio: value };
  assert.equal(buildCompletionOutcomeEvidence(outcome, { athleteId: 'synthetic', createdAt: '2026-09-13T12:00:00Z' }).value.observed_to_prescribed_ratio, null);
}
const zero = buildCompletionOutcomeEvidence(observe({ observed_duration_s: 0 }), { athleteId: 'synthetic', createdAt: '2026-09-13T12:00:00Z' });
assert.equal(zero.value.observed_to_prescribed_ratio, 0);

for (const family of QUALITY_FAMILIES) {
  const session = { ...easy, session_id: family, workout_family: family, role: 'PRIMARY_KEY' };
  const outcome = observe({ observed_duration_s: 3000, observed_work_duration_s: 1800,
    target_met: true, outcome: 'ON_TARGET', interval_target_met: true, interval_comparison: { verified: true } }, session);
  assert.equal(outcome.outcome, UNKNOWN);
  assert.equal(outcome.scorable, false);
  assert.equal(outcome.dose_outcome, 'ON_TARGET');
  assert.equal(outcome.observed_to_prescribed_ratio, 1);
  assert.ok(outcome.reason_codes.includes('QUALITY_EXECUTION_UNVERIFIED'));
  assert.ok(!outcome.reason_codes.includes('KEY_SESSION_COMPLETED_ON_TARGET'));
  assert.equal(summarize([outcome, outcome]).material_adaptation_eligible, false);
  assert.equal(summarize([{ ...outcome, scorable: true, designated_assessment: true }]).material_adaptation_eligible, false);
}
assert.equal(observe({ observed_duration_s: 3000 }, { ...easy, title: 'Intervals RACE TEMPO',
  steps: [{ type: 'repeat', repeat_count: 6, children: [{ type: 'run', target: { duration_s: 20, cadence_range: { minimum: 170, maximum: 180 } } }] }] }).outcome,
  'ON_TARGET', 'opaque title and accessory cadence do not promote canonical easy family to quality');
for (const [observation, expected] of [[{ pain_limited: true }, 'PAIN_LIMITED'], [{ excessive_strain: true }, 'EXCESSIVE_STRAIN'],
  [{ completed: false }, 'INCOMPLETE'], [{ quality_state: 'PARTIAL', observed_duration_s: 0 }, 'UNSCORABLE_PARTIAL_SYNC']]) {
  assert.equal(observe(observation).outcome, expected);
}
const assessment = observe({ observed_duration_s: 3000 }, { ...easy, workout_family: 'assessment', role: 'ASSESSMENT' });
assert.equal(summarize([assessment]).material_adaptation_eligible, true, 'measured designated assessment semantics retained');
assert.equal(summarize([observe({}, { ...easy, role: 'ASSESSMENT' })]).material_adaptation_eligible, false);
const partial = observe({ quality_state: 'PARTIAL', observed_duration_s: 3000 });
assert.equal(partial.dose_outcome, null);
assert.equal(partial.observed_to_prescribed_ratio, null);
const translated = translateCompletionEvidence({ completionObservations: [{ evidence_id: 'unknown', linked_session_id: 'easy', target_met: true }] }, [easy]);
assert.equal(translated[0].outcome, UNKNOWN);

const snapshot = { evidence_snapshot_id: 'before', athlete_id: 'synthetic', evidence_snapshot_revision: 1,
  evidence: [{ evidence_id: 'observed-activity', truth_class: 'OBSERVED', value: { duration_s: 3000 } }] };
const state = { athlete_state_id: 'state-before', athlete_id: 'synthetic', evidence_snapshot_id: 'before', athlete_state_revision: 1 };
const revisions = buildCompletionOutcomeRevisions({ evidenceSnapshot: snapshot, athleteState: state,
  outcomes: [observe({})], createdAt: '2026-09-13T12:00:00Z' });
assert.deepEqual(revisions.evidence_snapshot.evidence[0], snapshot.evidence[0], 'unknown evaluation retains observed load');
assert.equal(revisions.outcome_evidence[0].value.observed_to_prescribed_ratio, null);
assert.equal(revisions.athlete_state.completion_outcomes[0].scorable, false);

const input = withObservedWork(fixture(4, 0, 240), { quality: true });
const qualityPair = input.completionPairs.find(p => p.prescribed_session.workout_family === 'threshold_run');
// The default fixture may have no required quality objective; add a road goal.
input.goals = [{ goal_id: 'road', athlete_id: input.snapshot.athlete_id, event_kind: 'ROAD_ENDURANCE',
  distance_miles: 13.109, target_time_s: 6000, event_local_date: '2026-11-15', event_state: 'SCHEDULED' }];
const withGoal = buildAdaptiveCoachingFoundation(input);
const selection = buildAdaptiveSessionSelection(withGoal);
assert.ok(selection.entries.some(e => e.workout_family === 'threshold_run'), 'known dose permits HOLD selection, not a new plan blocker');
const held = selection.entries.find(e => e.workout_family === 'threshold_run');
assert.equal(held.progression.action, 'HOLD');
assert.equal(held.progression.previous_success, false);
assert.equal(held.progression.current_level_basis, 'OBSERVED_DOSE_ONLY');
assert.ok(held.quality_work_s <= qualityPair.observation.observed_work_duration_s);
assert.equal(canonicalHash(input.snapshot), canonicalHash(withGoal.artifacts[0].payload_json), 'selection does not rewrite observed evidence');

const revised = { ...qualityPair, observation: { ...qualityPair.observation,
  measured_receipt_id: 'new', measured_receipt_revision: 2, quality_state: 'PARTIAL', completed: false } };
const original = { ...qualityPair, observation: { ...qualityPair.observation, measured_receipt_id: 'old', measured_receipt_revision: 1 } };
const older = { ...original, observation: { ...original.observation, measured_receipt_id: 'older' } };
function permutations(a) { return a.length < 2 ? [a] : a.flatMap((v, i) => permutations(a.filter((_, j) => i !== j)).map(rest => [v, ...rest])); }
for (const order of permutations([original, revised, older])) {
  const resolved = latestCompletionPairs(order);
  assert.equal(resolved[0].observation.measured_receipt_revision, 2);
  assert.equal(resolved[0].observation.quality_state, 'PARTIAL');
  const modified = { ...withGoal, athlete_state: { ...withGoal.athlete_state,
    adaptive_foundation: { ...withGoal.athlete_state.adaptive_foundation, completion_pairs: order } } };
  assert.ok(!buildAdaptiveSessionSelection(modified).entries.some(e => e.workout_family === 'threshold_run'), 'correction cannot resurrect earlier complete dose');
  const ledger = buildFamilyProgression({ athleteState: withGoal.athlete_state, completionPairs: order, phase: 'DEVELOPMENT' }).find(p => p.family === 'threshold');
  assert.equal(ledger.action, 'HOLD');
  assert.equal(ledger.current_level, null);
  assert.equal(ledger.observed_outcomes[0].outcome, 'UNSCORABLE_PARTIAL_SYNC');
  const translated = translateCompletionEvidence({ completionObservations: order.map(p => p.observation) }, [qualityPair.prescribed_session]);
  assert.equal(translated.length, 1);
  assert.equal(translated[0].outcome, 'UNSCORABLE_PARTIAL_SYNC', 'adaptation translator respects measured correction revision');
}
const conflicting = { ...original, observation: { ...original.observation, observed_duration_s: 100 } };
const hashes = permutations([original, conflicting, original]).map(order => canonicalHash(latestCompletionPairs(order)));
assert.equal(new Set(hashes).size, 1, 'ambiguous equal-revision observations resolve independently of input order');
assert.equal(observe(latestCompletionPairs([original, conflicting])[0].observation).outcome, UNKNOWN);
assert.deepEqual(latestCompletionPairs([original, original]), [original], 'exact replay is one exposure');
const recoveryLedger = buildFamilyProgression({ athleteState: { ...withGoal.athlete_state, recovery_state: 'RECOVERY' },
  completionPairs: [original], phase: 'DEVELOPMENT' }).find(p => p.family === 'threshold');
assert.equal(recoveryLedger.action, 'REGRESS', 'poor recovery overrides known held dose');
const safetyLedger = buildFamilyProgression({ athleteState: { ...withGoal.athlete_state, safety_action: 'FULL_REST' },
  completionPairs: [original], phase: 'DEVELOPMENT' }).find(p => p.family === 'threshold');
assert.equal(safetyLedger.action, 'OMIT');
assert.equal(translateCompletionEvidence({ completionObservations: [{ evidence_id: 'unlinked-one' }, { evidence_id: 'unlinked-two' }] }).length, 2);
const unlinked = [{ evidence_id: 'unlinked-one' }, { evidence_id: 'unlinked-two' }];
assert.deepEqual(translateCompletionEvidence({ completionObservations: unlinked }),
  translateCompletionEvidence({ completionObservations: [...unlinked].reverse() }), 'independent unlinked observations retain deterministic ordering');
console.log('PASS execution truth: missing/invalid/zero, spoof containment, quality dose versus success, null serialization, safety/assessment, observed load, HOLD selection, ordered corrections and replay');
