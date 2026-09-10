const { AsyncLocalStorage } = require('node:async_hooks');
const { immutableOwnJson } = require('./immutableOwnJson');
const requestScope = new AsyncLocalStorage();
const NAMES = new Set(['canonical-set', 'activity-set', 'predecessor']);

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

module.exports = { withActivityValidationScope, memoizeImmutableActivity };
