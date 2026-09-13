// Synthetic local measurements explicitly supplied per week. No production
// source/coverage claim and no conversion of future sessions into completions.
const assert = require('node:assert/strict');
const { fixture, withObservedWork } = require('./adaptiveCoachingSolver.smoke');
const { validatePipelineArtifact } = require('../src/lib/goalBackwardContracts');
const { buildEvidenceSnapshot } = require('../src/lib/goalBackwardEvidence');
const { buildCanonicalSession, validateCanonicalSessionSet } = require('../src/lib/canonicalWorkout');
const { buildAdaptiveCoachingFoundation } = require('../src/lib/adaptiveCoachingFoundation');
const { buildAdaptiveCoachingCandidate } = require('../src/lib/adaptiveCoachingSolver');
const { buildOwnedEventMaterial } = require('../src/lib/adaptiveCoachingDomain');
const { addDays, peakLongRunDemand, STRESS_TAXONOMY_V1 } = require('../src/lib/racePlanPolicy');
const clone = v => JSON.parse(JSON.stringify(v));
const start = '2026-09-14', owner = 'solver-fixture';
const templates = withObservedWork(fixture(), { quality: true }).completionPairs;
const goal = { goal_id: 'endurance', race_id: 'endurance-race', athlete_id: owner, priority: 'A',
  event_kind: 'ROAD_ENDURANCE', distance_miles: 13.109, target_time_s: 6000,
  event_local_date: '2026-11-18', event_state: 'SCHEDULED', event_revision: 2, source_revision: 3 };
// Recorded measurement scenario, independent of any generated candidate.
const measuredLongs = [10000, 10000, 10800, 11664, 12597, 13604, 14692, 15867, 16093];
function history(week, failing = false) {
  const runs = [], pairs = [], weeks = [];
  for (let w = -4; w < week; w++) {
    const date = addDays(start, w * 7), meters = measuredLongs[Math.max(0, Math.min(w + 1, measuredLongs.length - 1))];
    const failed = failing && w >= week - 2;
    const rows = [
      { family: 'long_aerobic', distance: meters, seconds: Math.ceil(meters / 2.3), day: 4 },
      { family: 'threshold_run', distance: 5520, seconds: 2400, day: 1 },
      ...[0, 2, 6].map(day => ({ family: 'easy_run', distance: 8280, seconds: 3600, day })),
    ];
    let distance = 0, duration = 0;
    for (const [i, row] of rows.entries()) {
      const id = `measured-${w}-${i}`, actualSeconds = failed && i === 0 ? Math.floor(row.seconds * 0.5) : row.seconds;
      const actualMeters = failed && i === 0 ? Math.floor(row.distance * 0.5) : row.distance;
      const localDate = addDays(date, row.day);
      runs.push({ id, user_id: owner, date: localDate, distance_miles: actualMeters / 1609.344, duration_seconds: actualSeconds });
      distance += actualMeters; duration += actualSeconds;
      if (i > 1) continue;
      const template = templates.find(p => p.prescribed_session.workout_family === row.family);
      const old = template.prescribed_session;
      const prescribed = buildCanonicalSession({ ...old, session_id: id, scheduled_local_date: localDate,
        steps: old.steps.map(s => ({ ...s, target: { ...s.target,
          ...(s.step_role === 'WORK' && i === 0 ? { duration_s: row.seconds - 600 } : {}),
          distance_m: s.step_role === 'WORK' ? row.distance - 1380 : 690 } })) });
      pairs.push({ prescribed_session: prescribed, observation: { linked_session_id: id, evidence_id: id,
        observed_at: `${localDate}T12:00:00Z`, quality_state: 'COMPLETE', completed: !(failed && i === 0),
        target_met: !(failed && i === 0), observed_duration_s: actualSeconds,
        observed_work_duration_s: Math.max(1, actualSeconds - (i === 0 ? 600 : 1200)), observed_distance_m: actualMeters } });
    }
    // Explicit complete synthetic history, summed from the supplied measurements.
    weeks.push({ week_id: date, distance_m: distance, duration_s: duration, forge_native_coverage: true,
      stress_dimensions: Object.fromEntries(STRESS_TAXONOMY_V1.dimensions.map(k => [k, 20])),
      modality_eligibility: Object.fromEntries(STRESS_TAXONOMY_V1.dimensions.map(k => [k, { eligible: true }])) });
  }
  return { runs, pairs, weeks };
}
function inputAt(week, { failing = false, goals = [goal], recorded = history(week, failing) } = {}) {
  const date = addDays(start, week * 7);
  return { snapshot: buildEvidenceSnapshot({ athleteId: owner, timezone: 'UTC', planningInstant: `${date}T00:00:00Z`,
    runs: recorded.runs, checkIns: [{ id: `ready-${date}`, date, feeling: 4 }] }),
    context: { target: { runDaysPerWeek: 5, liftDaysPerWeek: 0, trainingDays: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'] } },
    stateOptions: { trainingAgeClass: 'ESTABLISHED', weeks: recorded.weeks }, goals: clone(goals),
    completionPairs: recorded.pairs, weeklyMileageHistory: recorded.weeks.map(w => w.distance_m / 1609.344), readinessTrend: 'stable' };
}
function solve(input, events = false) {
  const foundation = buildAdaptiveCoachingFoundation(input), date = foundation.athlete_state.planning_date_local;
  const result = buildAdaptiveCoachingCandidate({ foundation, availability: { run: Array.from({ length: 7 }, (_, i) => ({
    start_at: `${addDays(date, i)}T06:00:00Z`, end_at: `${addDays(date, i)}T09:00:00Z` })), lift: [] },
    ...(events ? { domain: { event_material: buildOwnedEventMaterial(foundation) } } : {}) });
  assert.ok(result.selected_candidate, JSON.stringify({ date, deferred: result.deferred_objectives, rejects: result.search.rejection_counts, tested: result.search.tested_candidates }));
  assert.equal(result.applicable, true);
  assert.equal(result.selected_candidate.validation.valid, true);
  assert.equal(validateCanonicalSessionSet(result.selected_candidate.canonical_session_set).valid, true);
  assert.equal(result.accepted_surface_manifest, null);
  return result;
}
const sessions = r => r.selected_candidate.sessions.filter(s => s.workout_family !== 'rest');
const long = r => sessions(r).find(s => s.workout_family === 'long_aerobic');
const doses = [];
let previousState = null;
for (let week = 0; week <= 7; week++) {
  const input = inputAt(week), before = JSON.stringify(input.snapshot);
  input.stateOptions.previousState = previousState;
  const r = solve(input);
  const state = r.artifacts.find(a => a.artifact_kind === 'athlete_state').payload_json;
  assert.equal(state.athlete_state_revision, week + 1);
  previousState = state;
  assert.ok(r.artifacts.every(a => validatePipelineArtifact(a).valid));
  const demand = r.decision.weekly_objectives.long_run_demand, session = long(r);
  assert.ok(session);
  assert.ok(session.derived_totals.distance_m <= demand.observed_next_level_ceiling_m);
  assert.ok(session.derived_totals.distance_m <= demand.registry_peak_distance_m);
  assert.equal(demand.demand_is_observation, false);
  assert.equal(demand.future_success_assumed, false);
  assert.equal(JSON.stringify(input.snapshot), before);
  assert.equal(r.artifacts.find(a => a.artifact_kind === 'planning_decision')?.payload_json?.weekly_objectives?.long_run_demand?.registry_peak_distance_m, Math.round(peakLongRunDemand(goal.distance_miles, 'pr') * 1609.344));
  doses.push(session.derived_totals.distance_m);
  console.log(JSON.stringify({ week, phase: r.decision.phase, long_m: session.derived_totals.distance_m,
    long_s: session.derived_totals.duration_s, demand, sessions: sessions(r).map(s => [s.workout_family, s.derived_totals.duration_s]) }));
}
assert.ok(doses.every((n, i) => !i || n >= doses[i - 1]));
assert.equal(doses.at(-1), Math.round(peakLongRunDemand(goal.distance_miles, 'pr') * 1609.344));
const good = solve(inputAt(4)), bad = solve(inputAt(4, { failing: true }));
assert.equal(bad.decision.weekly_objectives.progression.find(p => p.family === 'long_run').action, 'REGRESS');
assert.ok(long(bad).derived_totals.distance_m < long(good).derived_totals.distance_m);
const stale = solve(inputAt(5, { recorded: history(4) }));
assert.notEqual(stale.decision.weekly_objectives.progression.find(p => p.family === 'long_run').action, 'ADVANCE');
assert.ok(!long(stale) || long(stale).derived_totals.distance_m <= long(good).derived_totals.distance_m);
assert.equal(stale.decision.weekly_objectives.long_run_demand.observed_success_distance_m, good.decision.weekly_objectives.long_run_demand.observed_success_distance_m);
assert.equal(solve(inputAt(4)).result_hash, good.result_hash);
console.log('ok - deterministic observed multiweek long demand, failure regression, calendar-only hold');
const taper = solve(inputAt(8), true);
assert.equal(taper.decision.phase, 'TAPER_RACE_WEEK');
assert.ok(sessions(taper).some(s => s.workout_family === 'threshold_run'));
assert.ok(sessions(taper).filter(s => s.kind === 'run').length >= 3);
assert.ok(sessions(taper).reduce((n,s) => n+s.derived_totals.duration_s,0) < sessions(solve(inputAt(7))).reduce((n,s) => n+s.derived_totals.duration_s,0));
assert.ok(sessions(taper).every(s => s.workout_family !== 'race'), 'future race is not executed early');
assert.equal(sessions(taper).filter(s => s.kind === 'run').length, 5, 'supported recovery touches do not become extra calendar rest chains');
assert.equal(taper.rest_days.length, 2);
assert.ok(sessions(taper).filter(s => s.workout_family === 'recovery_run').every(s => s.derived_totals.duration_s >= 1200));
console.log(JSON.stringify({ taper_sessions: sessions(taper).map(s => [s.scheduled_local_date, s.workout_family, s.derived_totals.duration_s]), taper_rest: taper.rest_days }));
console.log('ok - registry taper reduces actual dose and retains supported touches');
const first = { ...goal, goal_id: 'first', race_id: 'first-event', event_kind: 'ROAD_SHORT',
  distance_miles: 5000 / 1609.344, target_time_s: null, event_local_date: '2026-09-19',
  course_facts: { elevation_m: 9999, source: 'FIRST_EVENT_ONLY' } };
const second = { ...goal, priority: 'B', target_time_s: null };
const dualGoals = [first, second];
const raceWeek = solve(inputAt(0, { goals: dualGoals }), true);
assert.equal(raceWeek.decision.active_goal_id, first.goal_id);
assert.equal(raceWeek.decision.phase, 'TAPER_RACE_WEEK');
const race = sessions(raceWeek).find(s => s.workout_family === 'race');
assert.equal(race.derived_totals.work_distance_m, 5000);
assert.equal(race.event_identity.athlete_id, owner);
assert.equal(race.event_identity.event_local_date, first.event_local_date);
assert.equal(race.event_identity.event_revision, first.event_revision);
const recoveringGoals = [{ ...first, event_state: 'COMPLETED' }, second];
const recovery = solve(inputAt(1, { goals: recoveringGoals }));
assert.equal(recovery.decision.phase, 'POST_RACE_TRANSITION');
assert.ok(sessions(recovery).every(s => !['threshold_run','long_aerobic','race'].includes(s.workout_family)));
const nextInput = inputAt(2, { goals: [{ ...recoveringGoals[0], transition_exit_met: true }, second] });
nextInput.phaseEvidence = { goal_id: first.goal_id, event_revision: first.event_revision,
  source_revision: first.source_revision, event_local_date: first.event_local_date,
  peak_exposure_complete: true, development_gate_complete: true, safe_useful_peak_fits: true };
nextInput.stateOptions.performanceAnchors = nextInput.snapshot.canonical_activities.slice(0, 2).map(a => ({
  evidence_id: a.evidence_ids[0], goal_id: second.goal_id, specificity: 'EVENT_SPECIFIC', verified: true,
  observed_local_date: a.local_activity_date }));
nextInput.feasibilityByGoal = { [second.goal_id]: { workload_path_passes: true, mandatory_exposures_complete: true } };
const next = solve(nextInput);
assert.equal(next.decision.goal_gap[0].feasibility_status, 'SUPPORTED');
const bound = clone(nextInput);
bound.phaseEvidence = { ...bound.phaseEvidence, goal_id: second.goal_id,
  event_local_date: second.event_local_date, event_revision: second.event_revision, source_revision: second.source_revision };
assert.equal(buildAdaptiveCoachingFoundation(bound).decision.phase, 'SHARPENING');
for (const key of ['event_revision', 'source_revision', 'event_local_date']) {
  const wrong = clone(bound); wrong.phaseEvidence[key] = key === 'event_local_date' ? '2026-12-25' : 999;
  assert.equal(buildAdaptiveCoachingFoundation(wrong).decision.phase, 'DEVELOPMENT');
}
assert.equal(next.decision.active_goal_id, second.goal_id);
assert.equal(next.decision.phase, 'DEVELOPMENT');
assert.ok(long(next).derived_totals.distance_m > 10000);
assert.ok(sessions(next).some(s => s.workout_family === 'threshold_run' && s.derived_totals.work_duration_s >= 1200));
assert.ok(next.decision.weekly_objectives.objectives.filter(o => o.role !== 'REST').every(o => o.goal_ids.every(id => id === second.goal_id)));
assert.equal(next.decision.goal_gap[0].goal.priority, 'B');
assert.ok(!JSON.stringify(next.decision).includes('FIRST_EVENT_ONLY'));
assert.ok(!JSON.stringify(sessions(next)).includes('FIRST_EVENT_ONLY'));
const foreign = clone(nextInput); foreign.goals[1].athlete_id = 'foreign';
assert.equal(buildAdaptiveCoachingFoundation(foreign).decision.active_goal_id, null);
const postponed = clone(nextInput); postponed.goals[1].event_local_date = '2026-12-02'; postponed.goals[1].event_revision++;
assert.equal(buildAdaptiveCoachingFoundation(postponed).decision.weekly_objectives.long_run_demand.event_local_date, '2026-12-02');
assert.equal(buildAdaptiveCoachingFoundation(postponed).decision.weekly_objectives.long_run_demand.event_revision, 3);
console.log('ok - dual owned event taper, explicit recovery exit, successor exposure/dose and no inherited course facts');
const sparseInput = inputAt(0); sparseInput.completionPairs = []; sparseInput.stateOptions.weeks = [];
sparseInput.weeklyMileageHistory = [];
const sparse = buildAdaptiveCoachingFoundation(sparseInput);
assert.equal(sparse.decision.weekly_objectives.long_run_demand.observed_success_distance_m, null);
assert.equal(sparse.decision.weekly_objectives.long_run_demand.next_distance_ceiling_m, null);
assert.equal(sparse.decision.weekly_objectives.long_run_demand.runway_supports_peak, null);
assert.equal(sparse.athlete_state.recent_normal_running.median_duration_s, null);
assert.equal(sparse.decision.goal_gap[0].training_pace_authority, false);
console.log('ok - sparse observation and weekly coverage stay explicitly unknown');
console.log('adaptive multiweek assertion groups passed');
