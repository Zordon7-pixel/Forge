// Explicit synthetic observations, separate from the SQL route evidence fixture.
const assert = require('node:assert/strict');
const { fixture, withObservedWork } = require('./adaptiveCoachingSolver.smoke');
const { buildAdaptiveCoachingCandidate } = require('../src/lib/adaptiveCoachingSolver');
const { buildAdaptiveCoachingFoundation } = require('../src/lib/adaptiveCoachingFoundation');
const { buildOwnedEventMaterial } = require('../src/lib/adaptiveCoachingDomain');
const { addDays } = require('../src/lib/racePlanPolicy');
const { weekday } = require('../src/lib/adaptiveCoachingValidation');
const ALL = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
function solve(date, { runDays = ['Tue','Thu','Sat','Sun'], count = 4, maxSessionMinutes = null,
  weeklyMinutes = 300, consecutiveWeeks = 4, inspectFailure = false } = {}) {
  const offset = Math.round((Date.parse(date) - Date.parse('2026-09-14')) / 86400000);
  const original = require('./adaptiveCoachingDomain.smoke').establishDimensions(
    withObservedWork(fixture(count, 4, weeklyMinutes), { strengthSets: 6, quality: true }));
  // Each replay has independently supplied synthetic prior observations. This
  // is not a future program or proof of future completion of an earlier plan.
  const input = structuredClone(original);
  input.snapshot = require('../src/lib/goalBackwardEvidence').buildEvidenceSnapshot({
    athleteId: original.snapshot.athlete_id, timezone: 'UTC', planningInstant: `${date}T00:00:00Z`,
    runs: original.snapshot.canonical_activities.filter(a => a.activity_kind === 'run').map(a => ({
      id: a.evidence_ids[0], user_id: original.snapshot.athlete_id,
      date: addDays(a.local_activity_date, offset), distance_miles: a.distance_m / 1609.344, duration_seconds: a.duration_s })),
    lifts: [{ id: 'observed-lift', date: addDays('2026-09-10',offset), workout_duration_seconds: 3600, sets: 24, reps: 144 }],
    checkIns: [{ id: 'ready', date, feeling: 4 }],
  });
  input.stateOptions.weeks = input.stateOptions.weeks.map(w => ({...w, week_id: require('../src/lib/racePlanPolicy').mondayFor(addDays(w.week_id,offset))}));
  // Wide-pool fixture has three consecutive observed weeks and one older
  // eligible week: sufficient dose, without asserting a completed foundation gate.
  if (consecutiveWeeks === 3) input.stateOptions.weeks[0].week_id = addDays(input.stateOptions.weeks[0].week_id,-7);
  input.completionPairs = input.completionPairs.map(p => {
    const prescribed = {...p.prescribed_session, scheduled_local_date: addDays(p.prescribed_session.scheduled_local_date,offset)};
    prescribed.content_hash = require('../src/lib/canonicalWorkout').canonicalWorkoutHash(prescribed);
    return {...p, prescribed_session: prescribed,
      observation: {...p.observation, observed_at: `${addDays(p.observation.observed_at.slice(0,10),offset)}T12:00:00Z`}};
  });
  input.context.target.maxSessionMinutes = maxSessionMinutes;
  input.context.target.trainingDays = runDays;
  input.context.target.liftEligibleWeekdays = ALL;
  input.stateOptions.availableDays = ALL;
  input.goals = [{ goal_id: 'army', race_id: 'army', athlete_id: input.snapshot.athlete_id,
    event_kind: 'ROAD_ENDURANCE', distance_miles: 10, target_time_s: 5400,
    event_local_date: '2026-10-11', event_state: 'SCHEDULED', event_revision: 1, source_revision: 1 }];
  const availability = Object.fromEntries([['run',runDays,6],['lift',ALL,17]].map(([kind, days, hour]) => [kind,
    Array.from({length:7}, (_,i) => addDays(date,i)).filter(d => days.includes(weekday(d)))
      .map(d => ({start_at: `${d}T${String(hour).padStart(2,'0')}:00:00Z`, end_at: `${d}T${String(hour+3).padStart(2,'0')}:00:00Z`}))]));
  const foundation = buildAdaptiveCoachingFoundation(input);
  const result = buildAdaptiveCoachingCandidate({ foundation, availability,
    domain: { event_material: buildOwnedEventMaterial(foundation) } });
  if (maxSessionMinutes !== null || inspectFailure) return { foundation, result };
  assert.ok(result.applicable, JSON.stringify(result.deferred_objectives));
  assert.ok(result.selected_candidate?.validation.valid, JSON.stringify(result.search));
  const sessions = result.selected_candidate.sessions;
  for (const kind of ['run','lift']) {
    const rows = sessions.filter(s => s.kind === kind && s.workout_family !== 'rest');
    assert.equal(new Set(rows.map(s => s.scheduled_local_date)).size, rows.length);
    assert.ok(rows.every(s => (kind === 'run' ? runDays : ALL).includes(weekday(s.scheduled_local_date))
      || s.workout_family === 'race' && s.scheduled_local_date === '2026-10-11'));
  }
  console.log(JSON.stringify({ date, phase: result.decision.phase, applicable: result.applicable,
    sessions: sessions.map(s => [s.scheduled_local_date,s.workout_family]), strength: result.strength_dose_receipt }));
  return result;
}
if (require.main === module) {
  const normal = solve('2026-09-20');
  assert.equal(normal.selected_candidate.sessions.filter(s => s.kind === 'run').length,4);
  assert.equal(normal.selected_candidate.sessions.filter(s => s.kind === 'lift').length,4);
  const wide = solve('2026-09-20', { runDays: ALL, count: 3, consecutiveWeeks: 3 });
  assert.equal(wide.selected_candidate.sessions.filter(s => s.kind === 'run').length,3);
  assert.equal(wide.selected_candidate.sessions.filter(s => s.kind === 'lift').length,4);
  // Independent race-week replay: larger explicitly supplied observed volume can
  // support the race plus useful taper touches without exceeding the reduced cap.
  const taper = solve('2026-10-05', { weeklyMinutes: 450 });
  assert.equal(taper.decision.phase, 'TAPER_RACE_WEEK');
  assert.equal(taper.selected_candidate.sessions.filter(s => s.kind === 'run').length, 3);
  assert.equal(taper.selected_candidate.sessions.filter(s => s.kind === 'lift').length, 1);
  assert.equal(taper.strength_dose_receipt.pool_sets, 6);
  assert.equal(taper.strength_dose_receipt.prescribed_sets, 6);
  assert.ok(taper.selected_candidate.sessions.some(s => s.workout_family === 'race'
    && s.scheduled_local_date === '2026-10-11' && s.derived_totals.work_distance_m === 16093));
  const taperRuns = taper.selected_candidate.sessions.filter(s => s.kind === 'run');
  assert.ok(taperRuns.reduce((n,s) => n+s.derived_totals.duration_s,0)
    <= taper.decision.weekly_objectives.dose_policy.running_duration_ceiling_s);
  assert.ok(taper.decision.weekly_objectives.dose_policy.running_factor < 1);
  // Smaller explicitly supplied history cannot fit the observed-pace event
  // prescription inside this policy's taper cap. Goal pace must not replace it.
  const smaller = solve('2026-10-05', { inspectFailure: true });
  assert.equal(smaller.result.applicable, false);
  const event = buildOwnedEventMaterial(smaller.foundation)[0];
  assert.ok(event.derived_totals.duration_s > smaller.result.decision.weekly_objectives.dose_policy.running_duration_ceiling_s);
  // A true time/dose conflict must remain blocked, with its specific explanation.
  const limited = solve('2026-09-20', { runDays: ALL, maxSessionMinutes: 5 });
  assert.equal(limited.result.applicable, false);
  const adapter = require('../src/lib/adaptiveCoachingPreview');
  assert.throws(() => adapter.build({ prepared: { foundation: limited.foundation,
    source_support: { source_limited: false, limits: [] } }, result: limited.result, featureMode: 'on' }), error => {
    assert.equal(adapter.publicGenerationFailure(error).reason_code, 'MEANINGFUL_DOSE_REQUIRED');
    return true;
  });
  assert.throws(() => adapter.build({ prepared: { foundation: smaller.foundation,
    source_support: { source_limited: false, limits: [] } }, result: smaller.result, featureMode: 'on' }), error => {
    assert.equal(adapter.publicGenerationFailure(error).reason_code, 'MEANINGFUL_DOSE_REQUIRED');
    return true;
  });
  assert.equal(adapter.publicGenerationFailure({ generationFailure: { reason_code: 'private raw evidence' } }), null);
  assert.ok(!adapter.publicGenerationFailure({ generationFailure: { reason_code: 'MEANINGFUL_DOSE_REQUIRED',
    message: 'private raw evidence' } }).message.includes('private'));
  console.log('race availability solver regressions passed (independent normal/taper windows and time/dose rejection)');
}
module.exports = { solve };
