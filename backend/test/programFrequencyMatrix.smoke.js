const assert = require('node:assert/strict');
const { scenario } = require('./programFixtures');
const all = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
for (let count = 1; count <= 7; count += 1) {
  const fixture = scenario({ runDays: all.slice(0, count), liftDays: 0, count: 3 });
  assert.ok(fixture.result.selected_candidate?.validation.valid, JSON.stringify({ count, failure: fixture.result.program_failure,
    week: fixture.result.failed_program_week }));
  assert.equal(fixture.accepted.weeks.length, 5);
  for (const week of fixture.accepted.weeks.filter(week => !['race', 'taper'].includes(week.phase))) {
    assert.equal(week.days.filter(day => day.sessions.some(session => session.kind === 'run')).length, count);
    assert.equal(week.days.flatMap(day => day.sessions).filter(session => session.kind === 'lift').length, 0);
  }
  if (count === 1) {
    assert.equal(fixture.accepted.programReconciliation[0].entries[0].outcome, 'DISCLOSED_ADJUSTMENT');
    assert.equal(fixture.accepted.programReconciliation[0].entries[0].rule, 'EXPLICIT_SINGLE_RUNNING_DAY_DOSE');
    const canonical = fixture.result.selected_candidate.canonical_session_set.sessions[0];
    assert.ok(canonical.derived_totals.duration_s >= 1200);
    assert.ok(canonical.derived_totals.distance_m < 14000, 'Do not stuff prior14mi weekly workload into one session');
    const source = fixture.result.selected_candidate.workload_evidence.canonical_load_source;
    const frequency = source.frequency_dose_contract;
    const input = { candidate: { sessions: source.canonical_session_set.sessions },
      canonical_load_source: source, canonical_load_context_hash: source.context_hash,
      frequency_dose_contract: frequency, planning_date_local: frequency.planning_date,
      candidate_window_end_local: frequency.end_date, recent_normal_running: { status: 'PROVISIONAL',
        median_distance_m: 22531, confidence: 'LOW', evidence_ids: ['synthetic-observed-load'] }, phase: 'FOUNDATION', training_age_class: 'BEGINNER' };
    const { evaluateMaterialDose } = require('../src/lib/goalBackwardRecoveryMaterial');
    assert.equal(evaluateMaterialDose(input).valid, true);
    assert.equal(evaluateMaterialDose({ ...input, frequency_dose_contract: null }).valid, false);
    assert.equal(evaluateMaterialDose({ ...input, frequency_dose_contract: { ...frequency, requested_run_days: 2 } }).valid, false);
    const forged = structuredClone(source); delete forged.frequency_dose_contract;
    assert.equal(evaluateMaterialDose({ ...input, canonical_load_source: forged }).valid, false);
  }
}
let aspirationDose = null;
for (const goalTimeSeconds of [3600, 5400, 7200]) {
  const fixture = scenario({ count: 3, liftDays: 4, goalTimeSeconds });
  assert.ok(fixture.result.selected_candidate?.validation.valid);
  assert.equal(fixture.accepted.goal.goalTimeSeconds, goalTimeSeconds);
  assert.equal(fixture.accepted.overall_feasibility, 'unvalidated');
  const dose = fixture.result.selected_candidate.sessions.map(session => ({
    date: session.scheduled_local_date, family: session.workout_family,
    targets: session.steps.map(step => step.target),
  })).sort((a, b) => a.date.localeCompare(b.date) || a.family.localeCompare(b.family));
  if (aspirationDose) assert.deepEqual(dose, aspirationDose, 'Ambition alone cannot invent capability or change unvalidated training dose');
  else aspirationDose = dose;
}
console.log('COMPLETE PROGRAM FREQUENCY GATE OK: actual accepted1–7 running days, independent0 lifts, explicit dose disclosure');
