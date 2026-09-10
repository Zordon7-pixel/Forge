const assert = require('node:assert/strict');
const { scenario } = require('./programFixtures');
const { canonicalStrengthExercise } = require('../src/lib/strengthDoseAccounting');
const { deriveScopedRecoveryState } = require('../src/lib/goalBackwardRecoveryMaterial');
const all = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const { ownedRoadPhaseReplan, projectedRoadWindow } = require('../src/lib/roadPhaseReplan');
const phaseFixture = { userId: 'phase-owner', planningDate: '2026-09-14',
  state: { inputHash: 'fixed-evidence', request: {}, planningConstraints: { locks: [], manual_edits: [] }, races: [
    { id: 'later', user_id: 'phase-owner', event_kind: 'run_race', distance_miles: 10, event_local_date: '2027-01-24' },
    { id: 'added', user_id: 'phase-owner', event_kind: 'run_race', distance_miles: 5, event_local_date: '2026-09-20' },
  ] }, activePlan: { programContract: { version: 'complete-road-program-v1' }, canonical_session_set_hash: 'a'.repeat(64),
    goals: [{ raceId: 'later' }], weeks: [{ startDate: '2026-09-14', phase: 'base' }] },
  newPlan: { weeks: [{ startDate: '2026-09-14', phase: 'race' }] } };
assert.equal(ownedRoadPhaseReplan(phaseFixture).policy, 'TAPER_VOLUME_REDUCTION');
for (const mutate of [
  x => { x.state.races.pop(); },
  x => { x.newPlan.weeks[0].phase = 'base'; },
  x => { x.newPlan.weeks[0].phase = 'taper'; },
  x => { x.state.races[1].user_id = 'another-owner'; },
  x => { x.state.races[1].event_local_date = '2026-10-20'; },
  x => { x.state.planningConstraints.locks.push({ date: '2026-09-16' }); },
  x => { x.state.planningConstraints.manual_edits.push({ date: '2026-09-16' }); },
  x => { x.state.races.shift(); },
]) { const bad = structuredClone(phaseFixture); mutate(bad); assert.equal(ownedRoadPhaseReplan(bad), null); }
const projectionGoals = phaseFixture.state.races.map(race => ({ athlete_id: race.user_id, race_id: race.id,
  goal_id: `goal-${race.id}`, event_local_date: race.event_local_date, event_kind: 'ROAD_ENDURANCE', event_state: 'SCHEDULED' }));
const project = planningDate => projectedRoadWindow({ goals: projectionGoals, athleteId: 'phase-owner',
  observationDate: '2026-09-10', planningDate });
const recoveryProjection = project('2026-09-21');
assert.equal(recoveryProjection.state, 'PLANNED_POST_EVENT_RECOVERY');
assert.equal(recoveryProjection.recovery_window_end, '2026-09-27');
assert.equal(project('2026-09-28').state, 'NEXT_FUTURE_GOAL');
assert.equal(project('2026-09-28').next_goal_id, 'goal-later');
assert.ok(projectionGoals.every(goal => goal.event_state === 'SCHEDULED'), 'Projected windows never mutate observed race lifecycle');
assert.equal(projectedRoadWindow({ goals: projectionGoals, athleteId: 'phase-owner',
  observationDate: '2026-09-22', planningDate: '2026-09-28' }), null,
  'An event already elapsed when observed cannot be represented as a future-event projection');
const overlap = projectedRoadWindow({ goals: [...projectionGoals, { ...projectionGoals[1],
  race_id: 'overlap', goal_id: 'goal-overlap', event_local_date: '2026-09-23' }],
  athleteId: 'phase-owner', observationDate: '2026-09-10', planningDate: '2026-09-21' });
assert.equal(overlap.recovery_goal_id, null, 'Projected recovery cannot replace the next exact owned event');
const { selectGoalBackwardPhase } = require('../src/lib/goalBackwardDecisionEngine');
assert.notEqual(selectGoalBackwardPhase({ goal: projectionGoals[1], planning_date_local: '2026-10-12',
  event_policy: require('../src/lib/racePlanPolicy').EVENT_POLICY_REGISTRY_V1.policies.road_10mile_v1 }).phase,
  'TAPER_RACE_WEEK', 'A negative days-to-event value never creates perpetual taper');
const { immutableOwnJson } = require('../src/lib/immutableOwnJson');
const immutable = Object.freeze({ nested: Object.freeze({ dose: 1 }) });
assert.equal(immutableOwnJson(immutable), true);
const cycle = {}; cycle.self = cycle; Object.freeze(cycle);
let getterCalls = 0;
const accessor = Object.freeze({ get dose() { getterCalls++; return 1; } });
for (const value of [Object.freeze({ nested: { dose: 1 } }), Object.freeze(new Date()),
  Object.freeze(new Map()), Object.freeze(new Set()), Object.freeze(Object.create({ custom: true })),
  Object.freeze({ fn() {} }), Object.freeze({ toJSON() { return {}; } }), accessor,
  new Proxy(immutable, {}), cycle]) assert.equal(immutableOwnJson(value), false);
assert.equal(getterCalls, 0, 'Cache eligibility never invokes an accessor');
const a = {}, b = { a }; a.b = b; a.mutable = {}; Object.freeze(a); Object.freeze(b);
assert.equal(immutableOwnJson(a), false);
assert.equal(immutableOwnJson(b), false, 'A cyclic failed traversal cannot contaminate verified descendants');
const { canonicalPrescriptionHash } = require('../src/lib/goalBackwardValidators');
for (const primitive of [42, 'malformed']) assert.equal(canonicalPrescriptionHash(primitive),
  canonicalPrescriptionHash({}), 'Derived memoization preserves legacy empty-prescription handling for non-object inputs');
const mutableHashInput = Object.freeze({ sessions: [{ session_id: 'mutable-dose', duration_min: 20 }] });
const beforeHash = canonicalPrescriptionHash(mutableHashInput);
mutableHashInput.sessions[0].duration_min = 40;
assert.notEqual(canonicalPrescriptionHash(mutableHashInput), beforeHash, 'Shallow-frozen prescription hashes recompute after nested mutation');
const rawHistory = Array.from({ length: 28 }, (_, index) => {
  const date = new Date(Date.UTC(2026, 8, 6 - index)).toISOString().slice(0, 10);
  const miles = new Date(`${date}T12:00Z`).getUTCDay() === 0 ? 10 : 3;
  return { id: `review-run-${index}`, date, distance_miles: miles,
    duration_seconds: miles * 840, type: miles === 10 ? 'long' : 'easy', source: 'manual' };
});
const snapshotMutation = scenario({ liftDays: 0, count: 3, constructOnly: true });
assert.throws(() => require('../src/routes/plans')._test.computeGoalBackwardShadowDiagnostics({
  userId: snapshotMutation.owner, state: snapshotMutation.state, built: snapshotMutation.built,
  planningDateLocal: snapshotMutation.date,
}, { inspectProgramWindow() { snapshotMutation.state.planningInputRevision++; } }),
error => error.code === 'GOAL_EXPANSION_CARRY_FORWARD_SOURCE_INVALID' && error.message.includes('PROGRAM_SNAPSHOT_CHANGED'),
'An intra-invocation changed evidence revision invalidates the private inventory before the next window');
const offWeekdayEvent = scenario({ runDays: ['Mon', 'Wed', 'Fri'], liftEligibleWeekdays: ['Mon', 'Wed', 'Fri'],
  liftDays: 2, count: 3, constructOnly: true });
const additionalRace = { ...offWeekdayEvent.state.races[0], id: 'off-weekday-secondary',
  race_date: '2026-09-20', event_local_date: '2026-09-20', distance_miles: 5, goal_time_seconds: 2700 };
offWeekdayEvent.state.races.unshift(additionalRace);
offWeekdayEvent.target.raceTargets.unshift({ raceId: additionalRace.id, raceDate: additionalRace.race_date,
  distanceMiles: 5, goalTimeSeconds: 2700 });
offWeekdayEvent.state.inputHash = `sha256:${require('../src/lib/racePlanPolicy').canonicalHash({
  context: offWeekdayEvent.context, races: offWeekdayEvent.state.races })}`;
offWeekdayEvent.built = require('../src/routes/plans')._test.buildDeterministicCandidate(offWeekdayEvent.context,
  { planningDateLocal: offWeekdayEvent.date });
const offWeekdayProgram = require('../src/routes/plans')._test.computeGoalBackwardShadowDiagnostics({
  userId: offWeekdayEvent.owner, state: offWeekdayEvent.state, built: offWeekdayEvent.built,
  planningDateLocal: offWeekdayEvent.date });
assert.ok(offWeekdayProgram.selected_candidate?.validation.valid, JSON.stringify(offWeekdayProgram.program_failure));
assert.deepEqual(offWeekdayProgram.selected_candidate.sessions.filter(session => session.workout_family === 'race')
  .map(session => session.scheduled_local_date), ['2026-09-20', '2026-10-11']);
assert.ok(offWeekdayProgram.selected_candidate.sessions.filter(session => session.workout_family !== 'race')
  .every(session => [1, 3, 5].includes(new Date(`${session.scheduled_local_date}T12:00Z`).getUTCDay())),
  'Owned Sunday events do not widen ordinary Monday/Wednesday/Friday modality availability');
const expanded = scenario({ date: '2026-09-10', raceDate: '2027-01-24', runDays: all,
  liftDays: 7, miles: 28, count: 28, rawHistory, constructOnly: true });
expanded.target.raceTargets.unshift({ raceId: 'secondary', raceDate: '2026-09-20',
  raceName: 'Secondary', distanceMiles: 5, goalTimeSeconds: 2700 });
const expandedCandidate = require('../src/routes/plans')._test.buildDeterministicCandidate(expanded.context,
  { planningDateLocal: expanded.date });
assert.equal(expandedCandidate.validation.valid, true, JSON.stringify(expandedCandidate.validation.errors));
const opening = expandedCandidate.plan.weeks[0].days;
assert.equal(opening.find(day => day.date === '2026-09-10').sessions.find(s => s.kind === 'run').workout_id, 'sharpening_strides');
assert.equal(opening.find(day => day.date === '2026-09-11').sessions.find(s => s.kind === 'run').workout_id, 'easy_aerobic',
  'Optional progression yields to existing goal-bound sharpening under unchanged demanding spacing');
const concurrent = require('../src/lib/concurrentPlan');
for (const observations of [rawHistory, [{ id: 'old-race', date: '2025-01-01',
  distance_miles: 10, duration_seconds: 5400, type: 'race', health_source: 'manual' }]]) {
  const unqualified = structuredClone(expanded.context);
  unqualified.history.recentRuns = observations;
  unqualified.history.performanceProfile = concurrent.buildRunPerformanceProfile(observations,
    { todayISO: expanded.date, targetDistanceMiles: 10 });
  assert.equal(unqualified.history.performanceProfile.targetAnchor, null);
  const candidate = require('../src/routes/plans')._test.buildDeterministicCandidate(unqualified,
    { planningDateLocal: expanded.date });
  assert.equal(candidate.validation.valid, true, JSON.stringify(candidate.validation.errors));
  assert.equal(candidate.plan.goal.goalTimeSeconds, 5400);
  assert.ok(candidate.plan.weeks[0].days.flatMap(day => day.sessions)
    .some(session => session.workout_id === 'benchmark_mile'), 'Needed assessment survives optional progression conflicts');
  assert.ok(candidate.plan.weeks.slice(0, 2).flatMap(week => week.days.flatMap(day => day.sessions))
    .filter(session => session.kind === 'run' && session.type !== 'race')
    .every(session => !session.goal_pace_seconds_per_mile), 'Unknown performance does not require aspirational numerical race pace');
}
let constructors = 0;
for (const mode of ['hybrid_maintain','hybrid_build']) for (const recoveryState of ['NORMAL','LOW']) {
  for (let runs = 1; runs <= 7; runs++) for (let lifts = 0; lifts <= 7; lifts++) {
    const options = { runDays: all, runDaysPerWeek: runs, liftEligibleWeekdays: all,
      liftDays: lifts, planMode: mode, recoveryState, count: 3 };
    let fixture;
    try { fixture = scenario({ ...options, constructOnly: true }); }
    catch (error) { throw new Error(JSON.stringify(options) + ': ' + error.message); }
    assert.equal(fixture.built.validation.valid, true, JSON.stringify(options));
    constructors++;
    if (!lifts) assert.equal(fixture.built.plan.planMode, 'run_only', 'Explicit zero lifts wins a stale hybrid mode');
    for (const week of fixture.built.plan.weeks) {
      if (week.phase === 'taper') assert.equal(week.days.flatMap(day => day.sessions).filter(s => s.kind === 'lift').length, Math.min(lifts, 2));
    }
  }
}
for (const [mode, runs, lifts, recoveryState] of [
  ['hybrid_build',4,2,'LOW'], ['hybrid_build',4,3,'LOW'], ['hybrid_build',4,3,'NORMAL'],
  ['hybrid_build',4,4,'NORMAL'], ['hybrid_maintain',1,7,'NORMAL'],
  ['hybrid_maintain',4,7,'NORMAL'], ['hybrid_maintain',7,4,'NORMAL'],
]) {
  const fixture = scenario({ runDays: all, runDaysPerWeek: runs, liftEligibleWeekdays: all,
    liftDays: lifts, planMode: mode, recoveryState, count: 3 });
  assert.ok(fixture.result.selected_candidate?.validation.valid, JSON.stringify({ mode,runs,lifts,recoveryState,
    failure: fixture.result.program_failure, week: fixture.result.failed_program_week }));
  assert.equal(fixture.accepted.weeks.length, 5);
  for (const week of fixture.accepted.weeks.filter(w => !['taper','race'].includes(w.phase))) {
    assert.equal(week.days.filter(day => day.sessions.some(s => s.kind === 'run')).length, runs);
    assert.equal(week.days.filter(day => day.sessions.some(s => s.kind === 'lift')).length, lifts);
  }
}
const sourceExercise = { name: 'Dumbbell bench press', sets: 2, reps: '6', rest: '180 sec', rpe: '7-8',
  load: '45 lb starting load', loadSource: 'Conservative estimate from a recent Dumbbell bench press set: 45 lb x 8',
  progression: 'Repeat45 lb until every set stays at7-8 RPE or easier, then add5 lb.' };
const target = canonicalStrengthExercise(sourceExercise).target;
assert.equal(target.load_kg, 20.4);
assert.deepEqual(canonicalStrengthExercise({ ...sourceExercise, load: '20.4 kg starting load' }).target, target,
  'Previously stored metric adapters retain their known load on canonical regeneration');
const known = scenario({ liftDays: 4, count: 3, recentExercises: [{ name: 'Dumbbell bench press',
  normalizedName: 'dumbbell bench press', latestWeightLbs: 45, latestReps: 8 }] });
assert.ok(known.result.selected_candidate?.validation.valid);
const { resolveSessionStress } = require('../src/lib/goalBackwardLoad');
const immutableSession = known.result.selected_candidate.canonical_session_set.sessions[0];
const expectedStress = resolveSessionStress(immutableSession);
const modifiedResult = resolveSessionStress(immutableSession);
modifiedResult.vector[0] = -100;
assert.deepEqual(resolveSessionStress(immutableSession), expectedStress, 'A caller cannot mutate a cached derived-dose result');
let knownLoads = 0;
for (const session of known.accepted.weeks.flatMap(w => w.days.flatMap(d => d.sessions)).filter(s => s.kind === 'lift')) {
  for (const [index, exercise] of session.main.entries()) {
    if (session.steps[index].target.load_kg !== undefined) {
      assert.match(exercise.load, / lb starting load$/);
      assert.match(exercise.loadSource, / lb x /);
      assert.match(exercise.progression, / lb /);
      assert.deepEqual(canonicalStrengthExercise(exercise).target, session.steps[index].target);
      knownLoads++;
    }
  }
}
assert.ok(knownLoads > 0, 'Known load fixtures actually execute the canonical/display round trip');
const scopeInput = { planning_date_local: '2026-09-07', observation_date_local: '2026-09-07',
  candidate_window_end_local: '2026-09-13', timezone: 'America/New_York', evidence_snapshot_id: 'same-observation',
  context: { recovery: { state: 'LOW' } } };
const acute = deriveScopedRecoveryState(scopeInput);
const future = deriveScopedRecoveryState({ ...scopeInput, planning_date_local: '2026-09-28', candidate_window_end_local: '2026-10-04' });
assert.deepEqual(future.scopes, acute.scopes, 'A future plan window cannot reissue an old acute snapshot');
assert.equal(future.recovery_state, 'UNKNOWN');
assert.equal(acute.scopes[0].action, 'NO_HIGH_INTENSITY');
assert.equal(require('../src/lib/racePlanPolicy').acceptPlanningClock({ planning_date_local: '2026-09-28',
  timezone_offset_minutes: 240, planning_timezone: 'America/New_York' }, '2026-09-07').reason,
  'STALE_PLANNING_DATE', 'A client cannot move the actual planning clock forward to expire current recovery');
assert.throws(() => require('../src/routes/plans')._test.assertCandidatePlanningDateCurrent({
  planning_date_local: '2026-09-28', timezone_offset_minutes: 240,
}, new Date('2026-09-07T12:00:00Z')), error => error.code === 'CANDIDATE_PLANNING_DATE_CHANGED');
for (const context of [{ safety: { activeInjury: true } },
  { checkin: { lifeFlags: ['sick'] }, recovery: { state: 'LOW', syncedAt: '2026-09-07T12:00:00Z', available: true } }]) {
  const restricted = deriveScopedRecoveryState({ ...scopeInput, context,
    planning_date_local: '2026-09-28', candidate_window_end_local: '2026-10-04' });
  assert.equal(restricted.recovery_state, 'RECOVERY');
  assert.equal(restricted.scopes[0].scope_kind, 'BLOCK', 'Chronic injury and corroborated illness are not waived');
}
console.log(`PROGRAM REVIEW REGRESSIONS OK: ${constructors} crossed constructors, complete mixed-frequency/mode/recovery plans, phase floors, known load and observed acute scope`);
