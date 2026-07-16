const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  MAX_SEEN_SEQUENCE,
  SEEN_SETTING_KEY,
  parseStoredSequence,
  validateIncomingSequence,
} = require('../src/routes/releases')._test;

let passed = 0;
function check(condition, message) {
  assert.ok(condition, message);
  passed += 1;
}

check(SEEN_SETTING_KEY === 'whats_new_seen_sequence', 'route exposes only the bounded release-state key');
check(parseStoredSequence(undefined) === 0, 'missing state normalizes to zero');
check(parseStoredSequence('12') === 12, 'stored decimal state parses');
check(parseStoredSequence('bad') === 0, 'malformed stored state fails closed');
check(parseStoredSequence(MAX_SEEN_SEQUENCE + 1) === 0, 'oversized stored state fails closed');
check(validateIncomingSequence(0), 'zero is a valid initial acknowledgement');
check(validateIncomingSequence(MAX_SEEN_SEQUENCE), 'maximum sequence is valid');
for (const invalid of [-1, MAX_SEEN_SEQUENCE + 1, 1.5, '1', [], {}, null, undefined]) {
  check(!validateIncomingSequence(invalid), `invalid input is rejected: ${String(invalid)}`);
}

const source = fs.readFileSync(path.join(__dirname, '../src/routes/releases.js'), 'utf8');
check(source.includes("router.get('/state', auth"), 'GET state is authenticated');
check(source.includes("router.put('/state', auth"), 'PUT state is authenticated');
check(/WHERE user_id=\? AND key=\?/.test(source), 'reads are user and key scoped');
check(/WHERE id=\? AND user_id=\? AND key=\?/.test(source), 'updates are id, user, and key scoped');
check(source.includes('Math.max(parseStoredSequence(existing?.value), seenSequence)'), 'writes cannot regress state');

console.log(`PASSED: ${passed}  FAILED: 0`);
console.log('RELEASE STATE SMOKE OK');
