const assert = require('node:assert/strict');
const { acceptPlanningClock } = require('../src/lib/racePlanPolicy');
const check = (date, offset, zone = 'America/New_York') => acceptPlanningClock({
  planning_date_local: date, timezone_offset_minutes: offset, planning_timezone: zone,
}, date);
assert.equal(check('2026-09-10', 240).planningTimezone, 'America/New_York');
assert.equal(check('2026-01-10', 300).valid, true);
assert.equal(check('2026-09-10', 300).reason, 'PLANNING_TIMEZONE_OFFSET_MISMATCH');
assert.equal(check('2026-01-10', 240).reason, 'PLANNING_TIMEZONE_OFFSET_MISMATCH');
assert.equal(check('2026-03-08', 300).valid, true);
assert.equal(check('2026-03-08', 240).valid, true);
assert.equal(check('2026-11-01', 300).valid, true);
assert.equal(check('2026-11-01', 240).valid, true);
assert.equal(check('2026-09-10', 240, 'Invalid/Zone').reason, 'INVALID_PLANNING_TIMEZONE');
assert.equal(check('2026-09-10', 0, 'UTC').valid, true);
const legacy = acceptPlanningClock({ planning_date_local: '2026-09-10', timezone_offset_minutes: 240 }, '2026-09-10');
assert.equal(legacy.valid, true);
assert.equal(Object.hasOwn(legacy, 'planningTimezone'), false, 'Legacy offset does not manufacture an IANA zone');
console.log('PROGRAM TIMEZONE GATE OK: explicit IANA authority, DST transition offsets, mismatch and legacy compatibility');
