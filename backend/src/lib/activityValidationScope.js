const { AsyncLocalStorage } = require('node:async_hooks');
const { immutableOwnJson } = require('./immutableOwnJson');
const { isDeepStrictEqual, types: { isProxy } } = require('node:util');
const requestScope = new AsyncLocalStorage();
const NAMES = new Set(['canonical-set', 'activity-set', 'predecessor', 'canonical-session', 'workout-hash']);
const SNAPSHOTS = Symbol('strict-owned-program-snapshots');
const SNAPSHOT_LIMITS = Object.freeze({ entries: 16, bytes: 32 * 1024 * 1024 });

// This scope contains pure immutable-graph results, not database, ownership,
// freshness or acceptance decisions. Every HTTP request gets a new inventory.
function withActivityValidationScope(callback) {
  return requestScope.run(new Map(), callback);
}

function memoizeImmutableActivity(name, input, calculate) {
  const scope = requestScope.getStore();
  if (!scope || !NAMES.has(name) || !input || typeof input !== 'object' || !immutableOwnJson(input)) return calculate();
  let entries = scope.get(name);
  if (!entries) { entries = new WeakMap(); scope.set(name, entries); }
  if (entries.has(input)) return entries.get(input);
  const result = calculate();
  // Returned validation results and reconstructed parents must also be truly
  // immutable. Exceptions and mutable results are never retained.
  if (immutableOwnJson(result)) entries.set(input, result);
  return result;
}

// Eligibility for structural reuse is deliberately narrower than the existing
// immutable memo predicate. JSON serialization alone erases hidden fields,
// undefined, sparse arrays and -0. Rejected shapes merely remain uncached.
function strictFrozenJson(value, verified, active = new WeakSet()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!value || typeof value !== 'object' || isProxy(value)) return false;
  if (verified.has(value)) return true;
  if (active.has(value) || !Object.isFrozen(value)) return false;
  const array = Array.isArray(value);
  if (Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== 'string' || key === 'toJSON')) return false;
  if (array && (keys.length !== value.length + 1
    || !keys.every(key => key === 'length' || /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length))) return false;
  active.add(value);
  const valid = keys.every(key => {
    const descriptor = descriptors[key];
    return Object.hasOwn(descriptor, 'value')
      && descriptor.enumerable === !(array && key === 'length')
      && strictFrozenJson(descriptor.value, verified, active);
  });
  active.delete(value);
  if (valid) verified.add(value);
  return valid;
}

// Never invoke object serialization hooks, even inherited hooks. The complete
// own JSON is indexed; deep equality still distinguishes -0 and prototypes.
function strictJsonText(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + Array.from({ length: value.length }, (_, index) => strictJsonText(value[index])).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + strictJsonText(value[key])).join(',') + '}';
}

function internImmutableProgramSnapshot(input) {
  const scope = requestScope.getStore();
  if (!scope || !input || typeof input !== 'object') return input;
  let inventory = scope.get(SNAPSHOTS);
  if (!inventory) {
    inventory = { verified: new WeakSet(), identities: new WeakMap(), entries: new Map(), count: 0, bytes: 0 };
    scope.set(SNAPSHOTS, inventory);
  }
  if (inventory.identities.has(input)) return inventory.identities.get(input);
  if (!strictFrozenJson(input, inventory.verified)) return input;
  const text = strictJsonText(input);
  const matches = inventory.entries.get(text) || [];
  const existing = matches.find(value => isDeepStrictEqual(value, input));
  if (existing) { inventory.identities.set(input, existing); return existing; }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (inventory.count >= SNAPSHOT_LIMITS.entries || inventory.bytes + bytes > SNAPSHOT_LIMITS.bytes) return input;
  inventory.entries.set(text, [...matches, input]);
  inventory.count++; inventory.bytes += bytes;
  inventory.identities.set(input, input);
  return input;
}

module.exports = { withActivityValidationScope, memoizeImmutableActivity, internImmutableProgramSnapshot, SNAPSHOT_LIMITS };
