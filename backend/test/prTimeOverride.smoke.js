const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  STANDARD_TIME_PRS,
  standardTimePrForDistance,
  nearestStandardTimePr,
  manualTimePrLabel,
  legacyManualTimePrLabel,
  validDate,
} = require('../src/routes/prs')._test;

let passed = 0;
function check(condition, message) { assert.ok(condition, message); passed += 1; }

check(STANDARD_TIME_PRS.length === 7, 'seven standard race distances are supported');
check(STANDARD_TIME_PRS.some((distance) => distance.label === '10 Mile' && distance.target === 10), '10-mile PRs are supported for Army Ten-Miler planning');
check(standardTimePrForDistance(6.214)?.label === '10K', '10K distance resolves canonically');
check(standardTimePrForDistance('3.107')?.label === '5K', 'numeric form values resolve');
check(standardTimePrForDistance(7) === null, 'arbitrary distances are rejected');
check(nearestStandardTimePr(9.7)?.label === '10 Mile', 'an overlapping 15K/10-mile effort belongs only to its nearest standard distance');
check(nearestStandardTimePr(9.5)?.label === '15K', 'the nearest-distance classifier still recognizes 15K efforts');
check(manualTimePrLabel({ label: '10K' }) === 'Time PR: 10K', 'manual label is stable');
check(legacyManualTimePrLabel({ target: 6.214 }) === 'Time PR (6.214mi)', 'legacy rows remain discoverable');
check(validDate('2020-01-02') === '2020-01-02', 'valid past date survives');
check(validDate('not-a-date') === null, 'malformed dates fail closed');
check(validDate('2999-01-01') === null, 'future dates fail closed');

const source = fs.readFileSync(path.join(__dirname, '../src/routes/prs.js'), 'utf8');
check(source.includes("category='time_pr'"), 'time reads include manual records');
check(source.includes('manual_record_id'), 'time response marks its manual override');
check(/UPDATE personal_records[\s\S]*WHERE id=\? AND user_id=\?/.test(source), 'manual update remains owner scoped');
check(source.includes('Math.abs(item.target - miles) <= 0.002'), 'distance boundary is deterministic');
check(source.includes('ORDER BY achieved_at DESC, id DESC'), 'manual override lookup uses columns present in production');
check(!source.includes('ORDER BY achieved_at DESC, created_at DESC'), 'manual override lookup does not require a nonexistent created_at column');

console.log(`PASSED: ${passed}  FAILED: 0`);
console.log('PR TIME OVERRIDE SMOKE OK');
