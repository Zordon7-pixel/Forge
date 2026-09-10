const assert = require('node:assert/strict');
const { activityAssessment, runCompletionEvidence } = require('../src/lib/activityReconciliation');
const { buildObservation, measure, canonicalLiftActivities, validateObservation, currentWeekPhysicalMaterial } = require('../src/lib/activityObservation');
const { canonicalHash } = require('../src/lib/racePlanPolicy');
const { explicitNoPlanMatchSnapshot } = require('../src/lib/plannedRunMatch');
const assess = runs => activityAssessment({ athleteId: 'synthetic', runs, planningDateLocal: '2026-09-10',
  observationInstant: '2026-09-10T16:00:00Z', timezone: 'America/New_York' });
const observed = runs => {
  const assessment = assess(runs);
  return { assessment, artifact: buildObservation({ ownerId: 'synthetic', planningDate: '2026-09-10',
    timezone: 'America/New_York', planningInputRevision: 3, assessment }) };
};
const short = { date: '2026-09-09', distance_miles: 1, duration_seconds: 600, perceived_effort: 2 };
const easy = observed([{ ...short, id: 'one' }, { ...short, id: 'two' }]);
assert.equal(easy.artifact.runs.length, 2);
assert.equal(easy.artifact.current_week.canonical_activity_count, 2);
assert.equal(easy.artifact.current_week.known_distance_lower_bound_m, 3218);
assert.equal(easy.assessment.recentRunLoad.protection.active, false);
assert.equal(easy.artifact.observed_v3_vector_state, 'NOT_AVAILABLE');
assert.ok(easy.artifact.runs.every(row => !Object.hasOwn(row, 'workout_family') && !Object.hasOwn(row, 'vector')));
assert.equal(easy.artifact.physical_windows.find(window => window.days === 7).duration_s, 1200);
const imported = { ...short, health_source: 'apple_health', health_source_workout_id: 'source-id',
  health_start_at: '2026-09-09T12:24:00Z' };
assert.equal(observed([{ ...imported, id: 'a' }, { ...imported, id: 'b' }]).artifact.runs.length, 1);
for (const delta of [{ perceived_effort: 9 }, { pain_level: 'moderate', post_energy: 'low' },
  { distance_miles: 10, duration_seconds: 6600 }]) {
  assert.equal(observed([{ ...short, id: 'protected', ...delta }]).assessment.recentRunLoad.protection.active, true);
}
assert.deepEqual(measure(undefined), { state: 'UNKNOWN', value: null });
assert.deepEqual(measure(0), { state: 'VALID_ZERO', value: 0 });
const unknown = observed([{ id: 'unknown', date: short.date, duration_seconds: 600 }]);
assert.equal(unknown.artifact.runs[0].distance_m.state, 'UNKNOWN');
assert.equal(unknown.artifact.runs[0].duration_s.value, 600);
assert.equal(unknown.artifact.current_week.distance_state, 'PARTIAL');
assert.notEqual(observed([]).artifact.coverage_state, 'COMPLETE');
const many = observed(Array.from({ length: 9 }, (_, index) => ({ ...short, id: `unique-${index}` })));
assert.equal(many.artifact.current_week.canonical_activity_ids.length, 9, 'All identities are bound; no four-ID truncation');
assert.ok(Object.isFrozen(many.artifact.current_week.canonical_activity_ids));
const observationContext = artifact => ({ owner_id: artifact.owner_id, planning_date: artifact.planning_date,
  timezone: artifact.timezone, planning_input_revision: artifact.planning_input_revision,
  observation_hash: artifact.content_hash, recent_run_load_hash: canonicalHash(artifact.recent_run_load) });
assert.equal(validateObservation(JSON.parse(JSON.stringify(many.artifact)), observationContext(many.artifact)), true);
const lowerBound = currentWeekPhysicalMaterial(many.artifact, { sessions: [] }, observationContext(many.artifact));
assert.equal(lowerBound.canonical_activity_count, 9);
assert.equal(lowerBound.completion_credit_claimed, false);
assert.equal(lowerBound.observed_plus_remaining_physical_lower_bound.candidate_running_m, 9 * 1609);
assert.deepEqual(lowerBound.observed_plus_remaining_physical_lower_bound.completed_running_credit.evidence_ids,
  [`observation:${many.artifact.content_hash}`]);
assert.equal(lowerBound.physical_distance_state, 'KNOWN', 'Unknown performance comparator does not erase known physical distance');
assert.equal(lowerBound.absolute_safety_budget_claimed, false);
for (const mutate of [
  value => { value.current_week.known_distance_lower_bound_m += 1; },
  value => { value.current_week.canonical_activity_ids.pop(); },
  value => { value.current_week.canonical_activity_count -= 1; },
  value => { value.current_week.through_local_date = '2026-09-11'; },
  value => { value.runs[0].workout_family = 'easy_run'; },
  value => { value.runs[0].duration_s = { state:'KNOWN',value:null }; },
  value => { value.qualified_completed_session_ids = ['same','same']; },
]) {
  const forged = structuredClone(many.artifact); mutate(forged);
  const { content_hash, ...body } = forged; forged.content_hash = canonicalHash(body);
  assert.equal(validateObservation(forged, observationContext(forged)), false, 'Rehashed internally contradictory observation fails');
}
const lifts = canonicalLiftActivities([{ id:'a', date:short.date,watch_sync_id:'same-owned-source' },
  { id:'b',date:short.date,watch_sync_id:'same-owned-source' },{ id:'manual-1',date:short.date },{id:'manual-2',date:short.date}], 'synthetic');
assert.equal(lifts.length, 3);
assert.ok(lifts.every(row => row.observed_v3_vector_state === 'NOT_AVAILABLE' && !row.vector));
assert.ok(lifts.flatMap(row => row.records).every(row => row.load_lbs.state === 'UNKNOWN' && row.sets.state === 'UNKNOWN'));
assert.throws(() => canonicalLiftActivities([{id:'foreign',user_id:'foreign'}],'synthetic'), /OWNER/);

// Screenshot-derived physical totals only. The year is an explicit synthetic
// test assumption; no RPE, zones, symptoms, location or baseline were supplied.
const screenshots = [
  { id: 'synthetic-sep8', date: '2026-09-08', health_start_at: '2026-09-08T13:07:00Z', distance_miles: 5.01, duration_seconds: 3239, avg_heart_rate: 150 },
  { id: 'synthetic-sep9', date: '2026-09-09', health_start_at: '2026-09-09T12:24:00Z', distance_miles: 3.51, duration_seconds: 2402, avg_heart_rate: 149 },
];
const evidence = observed(screenshots);
assert.equal(evidence.artifact.current_week.known_distance_lower_bound_m, 13712, 'Canonical meter precision preserves the 8.52-mile evidence; summary miles may round');
assert.equal(evidence.artifact.physical_windows.find(window => window.days === 7).duration_s, 5641);
assert.ok(evidence.artifact.runs.every(row => row.rpe.state === 'UNKNOWN' && row.pain.state === 'UNKNOWN' && row.energy.state === 'UNKNOWN'));
const replay = screenshots.flatMap((row, index) => [row, { ...row, id: `reimport-${index}` }]
  .map(value => ({ ...value, health_source: 'apple_health', health_source_workout_id: `synthetic-source-${index}` })));
assert.equal(observed(replay).artifact.runs.length, 2);
assert.equal(observed(replay).artifact.current_week.known_distance_lower_bound_m, 13712);
for (const rows of [screenshots, screenshots.map(row => ({ ...row, planned_session_json: explicitNoPlanMatchSnapshot() }))]) {
  assert.equal(runCompletionEvidence([{ session_id: 'unrelated', scheduled_local_date: short.date }], assess(rows))[0].completed, false);
}
console.log('ACTIVITY PHYSICAL OBSERVATION SMOKE OK: identity, unknowns, protections, complete digest, screenshot-only physical evidence');
