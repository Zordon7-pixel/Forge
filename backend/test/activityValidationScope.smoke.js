const assert = require('node:assert/strict');
const { withActivityValidationScope: scope, memoizeImmutableActivity: memo } = require('../src/lib/activityValidationScope');
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
  console.log('ACTIVITY VALIDATION SCOPE SMOKE OK: isolated requests, immutable only, no owner/freshness authority');
})().catch(error => { console.error(error); process.exitCode = 1; });
