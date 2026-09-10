const assert = require('node:assert/strict');
const { scenario } = require('./programFixtures');
const canonical = require('../src/lib/canonicalWorkout');
const activity = require('../src/lib/activityCanonicalSuccessor');
const { immutableOwnJson } = require('../src/lib/immutableOwnJson');
const { resolveSessionStress } = require('../src/lib/goalBackwardLoad');

const fixture = scenario({ count: 3, liftDays: 4 });
assert.ok(fixture.accepted);
const source = fixture.result.selected_candidate.canonical_session_set;
const mutable = JSON.parse(JSON.stringify(source));
const before = JSON.stringify(mutable);
const snapshot = activity.canonicalSetPayload(mutable);
assert.ok(immutableOwnJson(snapshot));
assert.equal(canonical.validateCanonicalSessionSet(snapshot).valid, true);
assert.equal(JSON.stringify(snapshot), before, 'Freezing does not change canonical identity or material');
assert.equal(Object.isFrozen(mutable), false, 'The caller-owned payload is not frozen in place');
const selected = snapshot.sessions.find(session => session.kind === 'run');
const initialDose = resolveSessionStress(selected);
require('../src/lib/activityValidationScope').withActivityValidationScope(() => {
  const first = activity.canonicalSetPayload(JSON.parse(before));
  const same = activity.canonicalSetPayload(JSON.parse(before));
  assert.equal(same, first, 'Closed snapshots of byte-identical persisted programs share immutable request identity');
  assert.equal(canonical.validateCanonicalSessionSet(same).valid, true);
  const tampered = JSON.parse(before); tampered.plan_revision++;
  const changedSet = activity.canonicalSetPayload(tampered);
  assert.notEqual(changedSet, first);
  assert.equal(canonical.validateCanonicalSessionSet(changedSet).valid, false);
  const expectedHash = canonical.canonicalWorkoutHash(selected);
  const validation = canonical.validateCanonicalSession(selected);
  assert.equal(validation.valid, true);
  assert.equal(canonical.canonicalWorkoutHash(selected), expectedHash);
  assert.deepEqual(canonical.validateCanonicalSession(selected), validation);
  assert.throws(() => { validation.violations.push({ code: 'injected' }); }, TypeError);
  const changed = JSON.parse(JSON.stringify(selected));
  const originalHash = canonical.canonicalWorkoutHash(changed);
  changed.plan_revision++;
  assert.notEqual(canonical.canonicalWorkoutHash(changed), originalHash, 'Mutable hash input must be recalculated');
  assert.equal(canonical.validateCanonicalSession(changed).valid, false, 'Mutable changed identity is not an earlier validation');
  const frozenBad = Object.freeze({ ...selected, content_hash: '0'.repeat(64) });
  assert.equal(canonical.validateCanonicalSession(frozenBad).valid, false, 'A new immutable object does not inherit another object approval');
  assert.equal(canonical.canonicalWorkoutHash(42), canonical.canonicalWorkoutHash(42), 'Primitive input keeps original hash semantics');
  assert.equal(canonical.validateCanonicalSession(null).valid, false);
});
const alteredReturn = resolveSessionStress(selected);
alteredReturn.vector[0] = -100;
assert.deepEqual(resolveSessionStress(selected), initialDose, 'Mutating a memo result cannot alter a later calculation');
mutable.sessions[0].steps = [];
assert.equal(JSON.stringify(snapshot), before, 'Later input mutation cannot poison an owned immutable snapshot');
assert.equal(canonical.validateCanonicalSessionSet(activity.canonicalSetPayload(mutable)).valid, false,
  'A new invocation revalidates changed material; no prior approval is reused');
assert.notEqual(activity.canonicalSetPayload(JSON.parse(before)), snapshot, 'Each mutable request obtains its own snapshot');

let executed = 0;
const malformedParents = [
  Object.freeze({ get sessions() { executed++; return []; } }),
  new Proxy({}, { ownKeys() { executed++; return []; }, get() { executed++; return null; } }),
  Object.freeze({ value: new Date() }), Object.freeze({ value: new Map() }), Object.freeze({ value: new Set() }),
  Object.freeze({ [Symbol('hidden')]: true }), Object.freeze({ toJSON() { executed++; return {}; } }),
];
const cycle = {}; cycle.self = cycle; Object.freeze(cycle); malformedParents.push(cycle);
for (const parent of malformedParents) {
  assert.throws(() => activity.buildActivityCanonicalSuccessor({ parent }), /ACTIVITY_PARENT_IDENTITY_INVALID/);
}
assert.equal(executed, 0, 'Snapshot eligibility never evaluates accessors, proxies or serialization hooks');
console.log('ACTIVITY IMMUTABLE PRESCRIPTION SMOKE OK: exact identity, detached snapshot, fresh tamper validation, immutable dose reuse');
