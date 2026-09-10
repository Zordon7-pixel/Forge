const assert = require('node:assert/strict');
const { calendarOccupancy, sharedRestDay } = require('../src/lib/calendarOccupancy');
const { DAY_ORDER: all, resolveRunSchedule, resolveLiftSchedule } = require('../src/lib/runSchedule');
const { scenario } = require('./programFixtures');
const { validateConcurrentPlan } = require('../src/lib/concurrentPlan');
const { reconcileProgramWeek } = require('../src/lib/programContract');
const { canonicalHash } = require('../src/lib/racePlanPolicy');
const cases = [
  ['disjoint', ['Mon','Tue','Wed','Thu','Fri'], 5, ['Sat','Sun'], 2, 7],
  ['partial-overlap', ['Mon','Tue','Thu','Sat'], 4, ['Mon','Wed','Fri','Sun'], 4, 7],
  ['literal-Hermes-control-corrected', ['Mon','Tue','Thu','Sat'], 4, ['Tue','Wed','Fri','Sun'], 4, 7],
  ['two-overlap', ['Mon','Tue','Thu','Sat'], 4, ['Tue','Thu','Fri','Sun'], 4, 6],
  ['greedy-rest', all, 5, ['Mon','Fri'], 2, 5],
  ['shared', all, 4, all, 4, 4],
  ['six-plus-two', all, 6, all, 2, 6],
];
let forced;
for (const [name, runDays, runs, liftDays, lifts, minimum] of cases) {
  const options = { runDays, runDaysPerWeek: runs, liftEligibleWeekdays: liftDays, liftDays: lifts, count: 3 };
  const receipt = calendarOccupancy({ runCount: runs, liftCount: lifts, runEligibleWeekdays: runDays,
    liftEligibleWeekdays: liftDays, timezone: 'America/New_York' });
  assert.equal(receipt.minimum_occupied_dates, minimum, name);
  assert.equal(receipt.classification, minimum === 7 ? 'FULL_WEEK_OCCUPANCY_REQUESTED' : 'REST_DATE_FEASIBLE');
  assert.equal(Boolean(sharedRestDay(receipt)), minimum < 7);
  assert.ok(Object.isFrozen(receipt) && Object.isFrozen(receipt.intersection));
  const s = scenario(options);
  assert.ok(s.result.selected_candidate, `${name}: ${s.result.program_failure}`);
  assert.deepEqual(s.accepted.programContract.calendar_occupancy, receipt);
  for (const week of s.accepted.weeks) {
    for (const day of week.days) for (const session of day.sessions) {
      if (session.workout_family === 'race') { assert.equal(day.date, s.raceDate); continue; }
      assert.ok((session.kind === 'run' ? runDays : liftDays).includes(day.day), `${name}: ${day.day}`);
    }
    if (['taper', 'race'].includes(week.phase)) continue;
    assert.equal(week.days.filter(day => day.sessions.some(session => session.kind === 'run')).length, runs);
    assert.equal(week.days.filter(day => day.sessions.some(session => session.kind === 'lift')).length, lifts);
    const occupied = week.days.filter(day => day.sessions.length).length;
    assert.ok(minimum === 7 ? occupied === 7 : occupied <= 6, name);
  }
  assert.ok(s.accepted.programReconciliation.every(week => week.valid));
  const forged = structuredClone(s.built.plan);
  forged.calendarOccupancy.classification = minimum === 7 ? 'REST_DATE_FEASIBLE' : 'FULL_WEEK_OCCUPANCY_REQUESTED';
  assert.equal(validateConcurrentPlan(forged, s.context).valid, false, 'Candidate classification never grants authority');
  delete forged.calendarOccupancy;
  assert.equal(validateConcurrentPlan(forged, s.context).valid, false, 'Receipt deletion cannot preserve a new constructor candidate');
  for (const kind of ['run','lift']) {
    const dropped = structuredClone(s.accepted.weeks[1]);
    const day = dropped.days.find(day => day.sessions.some(session => session.kind === kind));
    day.sessions = day.sessions.filter(session => session.kind !== kind);
    assert.equal(reconcileProgramWeek(s.accepted.programContract, dropped).valid, false);
  }
  if (name === 'disjoint') forced = s;
  if (name === 'six-plus-two') {
    const moved = structuredClone(s.accepted.weeks[1]);
    const rest = moved.days.find(day => !day.sessions.length);
    const pair = moved.days.find(day => day.sessions.length > 1 && day.sessions.some(session => session.kind === 'lift'));
    const index = pair.sessions.findIndex(session => session.kind === 'lift');
    rest.sessions.push(pair.sessions.splice(index, 1)[0]);
    const result = reconcileProgramWeek(s.accepted.programContract, moved);
    assert.equal(result.rest_placement_valid, false, 'Feasible rest cannot be lost by spreading otherwise exact counts');
  }
}
for (const [modality, target] of [['run', { runDaysPerWeek: 5, runEligibleWeekdays: ['Mon','Tue'] }],
  ['lift', { liftDaysPerWeek: 4, liftEligibleWeekdays: ['Sat','Sun'] }]]) {
  const result = modality === 'run' ? resolveRunSchedule({}, target) : resolveLiftSchedule({}, target);
  assert.equal(result.details.classification, 'MODALITY_AVAILABILITY_INSUFFICIENT');
  assert.equal(result.details.modality, modality);
}
const outside = structuredClone(forced.accepted.weeks[1]);
const runDay = outside.days.find(day => day.sessions.some(session => session.kind === 'run'));
const weekend = outside.days.find(day => day.day === 'Sat');
weekend.sessions.push(runDay.sessions.shift());
assert.equal(reconcileProgramWeek(forced.accepted.programContract, outside).modality_eligibility_valid, false);
const forgedContract = structuredClone(forced.accepted.programContract);
forgedContract.calendar_occupancy.minimum_occupied_dates = 1;
forgedContract.fingerprint = canonicalHash({ ...forgedContract, fingerprint: undefined });
assert.equal(reconcileProgramWeek(forgedContract, forced.accepted.weeks[1]).occupancy_contract_valid, false);
for (const date of ['2026-09-09','2026-09-13']) {
  const s = scenario({ date, count: 3, runDays: all, runDaysPerWeek: 5, liftDays: 2, liftEligibleWeekdays: ['Mon','Fri'] });
  assert.ok(s.result.selected_candidate, `Partial ${date}: ${s.result.program_failure}`);
  assert.equal(s.accepted.programReconciliation[0].calendar_occupancy.effective_week_kind, 'PARTIAL');
}
console.log('CALENDAR OCCUPANCY OK: seven distinct-set shapes through canonical engine, receipt/count/eligibility/rest/partial negatives');
