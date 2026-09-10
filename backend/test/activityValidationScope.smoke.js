const assert = require('node:assert/strict');
const { withActivityValidationScope: scope, memoizeImmutableActivity: memo,
  internImmutableProgramSnapshot: intern, SNAPSHOT_LIMITS } = require('../src/lib/activityValidationScope');
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};
const snapshot = overrides => freeze({ owner: 'synthetic-owner', context: { observed_at: '2026-09-10', input_revision: 2 },
  source: { identity: 'original' }, revision: 3, values: [0, 'known', null], ...overrides });
const outsideA = snapshot(), outsideB = snapshot();
assert.equal(intern(outsideA), outsideA); assert.equal(intern(outsideB), outsideB);
scope(() => {
  const first = intern(snapshot());
  assert.equal(intern(snapshot()), first, 'Exact immutable complete own data can share identity inside one request');
  for (const changed of [snapshot({ owner: 'another' }), snapshot({ context: { observed_at: '2026-09-11', input_revision: 2 } }),
    snapshot({ context: { observed_at: '2026-09-10', input_revision: 3 } }), snapshot({ revision: 4 }), snapshot({ source: { identity: 'changed' } })]) {
    assert.equal(intern(changed), changed, 'Changed owner, observation, source or revision cannot inherit earlier identity');
  }
  const zero = freeze({ value: 0 }), negativeZero = freeze({ value: -0 });
  assert.equal(intern(zero), zero); assert.equal(intern(negativeZero), negativeZero, 'Serialized zero collision is not structural equality');
  scope(() => assert.notEqual(intern(snapshot()), first, 'Nested/new request inventory is independent'));
});
let internHooks = 0;
const hidden = number => Object.freeze(Object.defineProperty({ x: 1 }, 'hidden', { value: number, enumerable: false }));
assert.equal(require('node:util').isDeepStrictEqual(hidden(1), hidden(2)), true, 'Comparator alone erases hidden own differences');
const hole = []; hole.length = 1; Object.freeze(hole);
const extraArray = [1]; extraArray.extra = 2; Object.freeze(extraArray);
const internCycle = {}; internCycle.self = internCycle; Object.freeze(internCycle);
const invalidShapes = [hidden(1), hidden(2), freeze({ x: undefined }), freeze({ x: NaN }), freeze({ x: Infinity }),
  Object.freeze(Object.create(null)), Object.freeze(Object.create({ custom: true })), hole, extraArray, internCycle,
  Object.freeze({ [Symbol('hidden')]: 1 }), Object.freeze({ get value() { internHooks++; return 1; } }),
  new Proxy({}, { ownKeys() { internHooks++; return []; }, get() { internHooks++; return 1; } }),
  Object.freeze({ toJSON() { internHooks++; return {}; } }), { x: 1 }, Object.freeze({ mutable: {} })];
scope(() => { for (const input of invalidShapes) assert.equal(intern(input), input, 'Ineligible shapes stay uncached, not rejected as training'); });
scope(() => {
  intern(freeze({}));
  const omitted = freeze({ x: undefined }), prototype = Object.freeze(Object.create(null));
  assert.equal(intern(omitted), omitted, 'Undefined field cannot alias absent field');
  assert.equal(intern(prototype), prototype, 'Null prototype cannot alias ordinary object');
  intern(freeze({ x: null }));
  for (const number of [NaN, Infinity, -Infinity]) {
    const nonfinite = freeze({ x: number });
    assert.equal(intern(nonfinite), nonfinite, 'Nonfinite-to-null serialization collision cannot reuse identity');
  }
  intern(freeze({ x: 1 }));
  const hiddenValue = hidden(1);
  assert.equal(intern(hiddenValue), hiddenValue, 'Hidden field cannot alias visible-only object');
  intern(freeze([null]));
  assert.equal(intern(hole), hole, 'Sparse array cannot alias explicit null element');
});
const inheritedHook = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
try {
  Object.defineProperty(Object.prototype, 'toJSON', { configurable: true, value() { internHooks++; return {}; } });
  scope(() => { const first = intern(snapshot()); assert.equal(intern(snapshot()), first); });
} finally {
  if (inheritedHook) Object.defineProperty(Object.prototype, 'toJSON', inheritedHook);
  else delete Object.prototype.toJSON;
}
assert.equal(internHooks, 0);
scope(() => {
  for (let index = 0; index < SNAPSHOT_LIMITS.entries; index++) intern(freeze({ index }));
  const overflowA = freeze({ index: 999 }), overflowB = freeze({ index: 999 });
  assert.equal(intern(overflowA), overflowA); assert.equal(intern(overflowB), overflowB, 'Entry overflow falls back without interning');
});
scope(() => {
  const padding = 'x'.repeat(SNAPSHOT_LIMITS.bytes + 1);
  const largeA = freeze({ padding }), largeB = freeze({ padding });
  assert.equal(intern(largeA), largeA); assert.equal(intern(largeB), largeB, 'Byte overflow falls back without changing values');
});
const value = Object.freeze({ immutable: Object.freeze({ count: 1 }) });
let calls = 0;
const calculate = () => { calls++; return Object.freeze({ valid: true }); };
memo('canonical-set', value, calculate); memo('canonical-set', value, calculate);
assert.equal(calls, 2, 'No approval or computation cache exists outside the request scope');
scope(() => {
  const first = memo('canonical-set', value, calculate);
  assert.equal(memo('canonical-set', value, calculate), first);
  assert.equal(calls, 3);
  scope(() => memo('canonical-set', value, calculate));
  assert.equal(calls, 4, 'Even the same immutable object is rechecked in a different request scope');
  assert.equal(memo('canonical-set', value, calculate), first);
});
scope(() => memo('canonical-set', value, calculate));
assert.equal(calls, 5);
scope(() => {
  const mutable = { count: 1 }, shallow = Object.freeze({ mutable });
  let checks = 0;
  const read = () => { checks++; return mutable.count; };
  assert.equal(memo('activity-set', shallow, read), 1);
  mutable.count = 2;
  assert.equal(memo('activity-set', shallow, read), 2);
  assert.equal(checks, 2, 'Shallow freezing cannot retain validation across mutation');
  let unstable = 0;
  const mutableResult = () => ({ value: ++unstable });
  assert.notEqual(memo('predecessor', value, mutableResult), memo('predecessor', value, mutableResult));
  assert.throws(() => memo('canonical-set', value, () => { throw new Error('uncached failure'); }), /uncached failure/);
  assert.equal(memo('canonical-set', value, () => true), true, 'Exceptions are not memoized');
});
let touched = 0;
const cycle = {}; cycle.self = cycle; Object.freeze(cycle);
const rejected = [cycle, Object.freeze({ value: new Date() }), Object.freeze({ value: new Map() }),
  Object.freeze({ value: new Set() }), Object.freeze({ [Symbol('hidden')]: 1 }),
  Object.freeze({ get value() { touched++; return 1; } }),
  new Proxy({}, { ownKeys() { touched++; return []; }, get() { touched++; return 1; } }),
  Object.freeze({ toJSON() { touched++; return {}; } }), Object.freeze(Object.create({ custom: true }))];
scope(() => {
  for (const input of rejected) {
    let calculations = 0;
    const calculate = () => { calculations++; return false; };
    memo('canonical-set', input, calculate); memo('canonical-set', input, calculate);
    assert.equal(calculations, 2, 'Unproven immutable graphs never receive retained validation');
  }
});
assert.equal(touched, 0);
(async () => {
  let concurrent = 0;
  await Promise.all([0, 1].map(() => scope(async () => {
    const calculate = () => { concurrent++; return true; };
    memo('activity-set', value, calculate);
    await new Promise(resolve => setImmediate(resolve));
    memo('activity-set', value, calculate);
  })));
  assert.equal(concurrent, 2, 'Concurrent asynchronous requests do not share results');
  const asynchronous = await Promise.all([0, 1].map(() => scope(async () => {
    const first = intern(snapshot());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(intern(snapshot()), first);
    return first;
  })));
  assert.notEqual(asynchronous[0], asynchronous[1], 'No asynchronous cross-request snapshot reuse');
  console.log('ACTIVITY VALIDATION SCOPE SMOKE OK: isolated requests, immutable only, no owner/freshness authority');
})().catch(error => { console.error(error); process.exitCode = 1; });
