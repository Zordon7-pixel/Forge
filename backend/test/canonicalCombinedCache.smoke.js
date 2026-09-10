const assert = require('node:assert/strict');
const { scenario } = require('./programFixtures');
const canonical = require('../src/lib/canonicalWorkout');
const { canonicalHash } = require('../src/lib/racePlanPolicy');
const { immutableOwnJson } = require('../src/lib/immutableOwnJson');
const combined = require('../src/lib/canonicalCombinedLoad');
const original = scenario({ count: 3, liftDays: 4 }).result.selected_candidate.workload_evidence.canonical_load_source;
const freeze = (value, seen = new WeakSet()) => {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    Object.values(Object.getOwnPropertyDescriptors(value)).forEach(descriptor => {
      if (Object.hasOwn(descriptor, 'value')) freeze(descriptor.value, seen);
    });
    Object.freeze(value);
  }
  return value;
};
const rehash = value => {
  const { content_hash, ...content } = value;
  value.content_hash = canonicalHash(content);
  return value;
};
let validations = 0;
const validate = canonical.validateCanonicalSessionSet;
canonical.validateCanonicalSessionSet = (...args) => { validations++; return validate(...args); };
function twice(source, expectCached) {
  const evaluate = () => combined.evaluateCanonicalCombinedLoad(source.canonical_session_set.sessions, source, source.context_hash);
  const first = evaluate(); assert.equal(first.valid, true);
  const before = validations;
  const second = evaluate(); assert.deepEqual(second, first);
  assert.equal(validations - before, expectCached ? 0 : 1,
    'Only closed immutable own JSON may skip repeated canonical source validation');
}
try {
  twice(freeze(structuredClone(original)), true);
  const accessor = structuredClone(original);
  let reads = 0;
  Object.defineProperty(accessor, 'diagnostic', { enumerable: true, get() { reads++; return 1; } });
  rehash(accessor); freeze(accessor);
  const beforeGuard = reads;
  assert.equal(immutableOwnJson(accessor), false);
  assert.equal(reads, beforeGuard, 'Cache eligibility must not execute accessors');
  twice(accessor, false);
  const symbol = structuredClone(original);
  symbol[Symbol('hidden-state')] = { mutable: true };
  freeze(symbol);
  twice(symbol, false);
  const proxied = new Proxy(freeze(structuredClone(original)), {});
  assert.equal(immutableOwnJson(proxied), false);
  twice(proxied, false);
  const custom = structuredClone(original);
  Object.setPrototypeOf(custom, { mutable: true }); freeze(custom);
  twice(custom, false);
  const mutable = structuredClone(original);
  Object.freeze(mutable);
  twice(mutable, false);
  mutable.canonical_session_set.prescribed_dose_versions.running = 'tampered';
  assert.equal(combined.evaluateCanonicalCombinedLoad(mutable.canonical_session_set.sessions, mutable, mutable.context_hash).valid, false,
    'A shallow-frozen source is revalidated after nested mutation');
  const cyclic = structuredClone(original);
  cyclic.self = cyclic; freeze(cyclic);
  assert.equal(immutableOwnJson(cyclic), false);
  assert.throws(() => combined.evaluateCanonicalCombinedLoad(cyclic.canonical_session_set.sessions, cyclic, cyclic.context_hash),
    'A cyclic source cannot obtain cached canonical verification');
  twice(freeze(structuredClone(original)), true, 'Rejected graphs cannot poison a later valid cache entry');
} finally { canonical.validateCanonicalSessionSet = validate; }
console.log('CANONICAL COMBINED CACHE OK: closed JSON memoization, accessor/proxy/symbol/cycle/custom/mutation negatives');
