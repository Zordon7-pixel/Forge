const assert = require('node:assert/strict');
const { scenario } = require('./programFixtures');
const { validateCanonicalSessionSet } = require('../src/lib/canonicalWorkout');
const began = performance.now();
let cases = 0;
for (let start = 7; start <= 13; start += 1) {
  for (let race = 5; race <= 11; race += 1) {
    const date = `2026-09-${String(start).padStart(2, '0')}`;
    const raceDate = `2026-10-${String(race).padStart(2, '0')}`;
    const fixture = scenario({ date, raceDate, count: 3, liftDays: 4 });
    assert.ok(fixture.result.selected_candidate?.validation.valid, JSON.stringify({ date, raceDate,
      failure: fixture.result.program_failure, week: fixture.result.failed_program_week, source: fixture.result.source_failure }));
    const set = fixture.result.selected_candidate.canonical_session_set;
    assert.equal(validateCanonicalSessionSet(set).valid, true);
    assert.ok(set.sessions.every(session => session.scheduled_local_date >= date && session.scheduled_local_date <= raceDate));
    const events = set.sessions.filter(session => session.workout_family === 'race');
    assert.equal(events.length, 1); assert.equal(events[0].scheduled_local_date, raceDate);
    assert.equal(events[0].event_identity.race_id, 'synthetic-army-10-miler');
    assert.ok(fixture.accepted.programReconciliation.every(week => week.valid));
    for (const week of fixture.accepted.weeks.filter(week => week.startDate >= date && !['race', 'taper'].includes(week.phase))) {
      assert.equal(week.days.filter(day => day.sessions.some(session => session.kind === 'run')).length, 4);
      assert.equal(week.days.filter(day => day.sessions.some(session => session.kind === 'lift')).length, 4);
    }
    cases += 1;
  }
}
console.log(JSON.stringify({ gate: 'program-seven-by-seven-calendar', status: 'PASS', cases, elapsed_ms: Math.round(performance.now() - began) }));
