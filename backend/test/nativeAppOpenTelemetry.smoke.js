const assert = require('node:assert/strict');
const eventsRouter = require('../src/routes/events');

const { FORGED_IOS_APP_ID, normalizeEventProps, sanitizeProps } = eventsRouter._test;
const nativeProps = {
  app_id: FORGED_IOS_APP_ID,
  app_version: '1.0.5',
  build_number: 19,
  native_runtime: true,
  platform: 'ios_native',
  timezone_offset_minutes: 240,
};

assert.deepEqual(normalizeEventProps('app_open', nativeProps), nativeProps);
assert.deepEqual(
  normalizeEventProps('app_open', { ...nativeProps, build_number: '19', timezone_offset_minutes: '0' }),
  { ...nativeProps, build_number: 19, timezone_offset_minutes: 0 },
);
for (const malformedOffset of ['   ', '\t', false, [], {}]) {
  assert.throws(
    () => normalizeEventProps('app_open', { ...nativeProps, timezone_offset_minutes: malformedOffset }),
    (error) => error?.code === 'INVALID_NATIVE_APP_OPEN',
  );
}
assert.throws(
  () => normalizeEventProps('app_open', { ...nativeProps, app_id: 'com.example.other' }),
  (error) => error?.code === 'INVALID_NATIVE_APP_OPEN',
);
assert.throws(
  () => normalizeEventProps('app_open', { ...nativeProps, native_runtime: false }),
  (error) => error?.code === 'INVALID_NATIVE_APP_OPEN',
);
assert.deepEqual(
  sanitizeProps({ platform: 'web', native_runtime: false, email: 'blocked@example.com' }),
  { platform: 'web', native_runtime: false },
);

console.log('NATIVE APP OPEN TELEMETRY SMOKE OK');
