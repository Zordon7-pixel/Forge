// Real synthetic owner/SQLite preview entry plus exact pure solver equivalence.
const assert = require('node:assert/strict');
const f = require('./raceAvailabilityApply.smoke');
const validation = require('../src/lib/activityValidationScope');
const shadow = require('../src/lib/adaptiveCoachingShadow');
const { fixture, windows } = require('./adaptiveCoachingSolver.smoke');
const { buildAdaptiveCoachingCandidate } = require('../src/lib/adaptiveCoachingSolver');
const canonical = require('../src/lib/canonicalWorkout');
async function main() {
  const input = { foundationInput: fixture(2, 0, 180), availability: windows() };
  const uncached = buildAdaptiveCoachingCandidate(input);
  const cached = validation.withActivityValidationScope(() => buildAdaptiveCoachingCandidate(input));
  assert.deepEqual(cached, uncached, 'Complete result, search, physiology, intent, hashes and artifacts stay identical');
  assert.ok(cached.selected_candidate);
  const session = cached.selected_candidate.sessions.find(s => s.workout_semantics);
  validation.withActivityValidationScope(() => {
    assert.equal(canonical.validateCanonicalSession(session).valid, true);
    const changed = JSON.parse(JSON.stringify(session));
    assert.equal(canonical.validateCanonicalSession(changed).valid, true);
    changed.workout_semantics.source.prescribed_steps_hash = 'tampered';
    assert.equal(canonical.validateCanonicalSession(changed).valid, false, 'Mutable input cannot retain earlier approval');
  });

  const athlete = await f.armyFixture();
  const req = { ...athlete.req, race_ids: [] }, opts = { ...f.options('off'), store: false };
  const before = f.snapshot(), prepare = shadow.prepare;
  const marker = Object.freeze({ scopeProbe: true });
  let calculations = 0, calls = 0;
  shadow.prepare = (...args) => {
    calls++;
    const calculate = () => { calculations++; return true; };
    validation.memoizeImmutableActivity('canonical-session', marker, calculate);
    validation.memoizeImmutableActivity('canonical-session', marker, calculate);
    return prepare(...args);
  };
  try {
    const first = await f.plans.previewPlanForUser(athlete.owner, req, opts);
    const second = await f.plans.previewPlanForUser(athlete.owner, req, opts);
    assert.equal(calls, 2);
    assert.equal(calculations, 2, 'Each asynchronous preview gets its own inventory; duplicate pure work is reused only inside it');
    assert.equal(first.candidateHash, second.candidateHash);
    assert.deepEqual(first.plan, second.plan);
    assert.deepEqual(f.snapshot(), before, 'Read-only preview does not mutate fixture rows');
    await assert.rejects(f.plans.previewPlanForUser(athlete.owner,
      { ...req, race_ids: ['foreign'] }, opts), e => e.code === 'RACE_NOT_FOUND');
    assert.equal(calls, 2, 'Owner checks still precede preparation and are not cached');
    f.db.prepare("UPDATE race_events SET event_local_date='invalid' WHERE id='army' AND user_id=?").run(athlete.owner);
    await assert.rejects(f.plans.previewPlanForUser(athlete.owner, athlete.req, opts), e => e.code === 'INVALID_RACE_DATE');
    assert.equal(calls, 2, 'Fresh persisted input is re-read despite previous previews');
  } finally { shadow.prepare = prepare; }
  console.log('GENERATION VALIDATION SCOPE OK: exact solver equality, request isolation, mutable tamper, owner/freshness checks');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => f.close());
