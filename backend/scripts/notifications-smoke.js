const assert = require('node:assert/strict');

const { normalizeNotification, notificationSourceFromKey } = require('../src/services/notifications');

const normalized = normalizeNotification({
  type: 'activity_synced',
  title: ' Run synced\n',
  body: ' Morning run\r\nis ready. ',
  href: '/run/recap/run-1',
  sourceKey: 'strava:activity:123',
});

assert.deepEqual(normalized, {
  type: 'activity_synced',
  title: 'Run synced',
  body: 'Morning run is ready.',
  href: '/run/recap/run-1',
  sourceKey: 'strava:activity:123',
});
assert.equal(normalizeNotification({ title: 'A', body: 'B' }).sourceKey.startsWith('notification:'), true);
assert.throws(() => normalizeNotification({ title: '', body: 'Missing title' }), /title and body/i);
assert.equal(normalizeNotification({ title: 'A'.repeat(100), body: 'B' }).title.length, 80);
assert.equal(notificationSourceFromKey('strava:activity:123'), 'strava');
assert.equal(notificationSourceFromKey('apple_health:workout:123'), 'apple_health');
assert.equal(notificationSourceFromKey('training-gap:user-1'), 'forged_hybrid');

console.log('Notification normalization smoke OK');
