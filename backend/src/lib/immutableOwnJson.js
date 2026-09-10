const { types: { isProxy } } = require('node:util');
const verified = new WeakSet();

// A memo key must be immutable data, not merely a shallow-frozen wrapper.
function immutableOwnJson(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object') return !['function', 'symbol', 'bigint'].includes(typeof value);
  if (verified.has(value)) return true;
  if (isProxy(value) || !Object.isFrozen(value)
    || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const valid = Reflect.ownKeys(descriptors).every(key => typeof key === 'string' && key !== 'toJSON')
    && Object.values(descriptors).every(descriptor => Object.hasOwn(descriptor, 'value')
    && immutableOwnJson(descriptor.value, seen));
  seen.delete(value);
  if (valid) verified.add(value);
  return valid;
}

module.exports = { immutableOwnJson };
