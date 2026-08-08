#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const routeDir = path.join(__dirname, '..', 'src', 'routes');
const readRoute = (name) => fs.readFileSync(path.join(routeDir, name), 'utf8');
const count = (source, pattern) => [...source.matchAll(pattern)].length;

function runPlanningProfileRoutesSmoke() {
  const races = readRoute('races.js');
  const checkin = readRoute('checkin.js');
  const injury = readRoute('injury.js');
  const hrProfile = readRoute('hrProfile.js');
  const auth = readRoute('auth.js');

  assert.ok(
    count(races, /withPlanningInputMutation\(req\.user\.id/g) >= 5,
    'race create/catalog/GPX/edit/delete must use planning mutation transactions'
  );
  assert.match(
    races,
    /DELETE FROM race_events WHERE id=\? AND user_id=\?/,
    'race delete must remain owner scoped'
  );
  assert.match(
    races,
    /FOR UPDATE[\s\S]*planningInputUnchanged\(\{ validationError:/,
    'race edits must validate after acquiring the owner lock without advancing rejected input'
  );

  assert.match(
    checkin,
    /withPlanningInputMutation\(req\.user\.id,[\s\S]*daily_checkins[\s\S]*checkin_overrides/,
    'daily check-in and override must commit in one planning transaction'
  );
  assert.match(
    checkin,
    /UPDATE daily_checkins[\s\S]*WHERE id=\? AND user_id=\?/,
    'daily check-in update must remain owner scoped'
  );

  assert.ok(
    count(injury, /withPlanningInputMutation\(/g) >= 4,
    'injury create/resolve/clear writes must use planning mutation transactions'
  );
  assert.match(
    injury,
    /UPDATE injury_logs SET cleared=1 WHERE id=\? AND user_id=\?/,
    'single injury clear must remain owner scoped'
  );
  assert.match(
    injury,
    /planningInputUnchanged\(0\)/,
    'empty injury resolution must not advance revision'
  );

  assert.equal(
    count(hrProfile, /withPlanningInputMutation\(req\.user\.id/g),
    2,
    'field-test and manual HR profile changes must advance planning revision'
  );
  assert.match(
    auth,
    /router\.put\('\/me\/profile'[\s\S]*withPlanningInputMutation\(req\.user\.id/,
    'profile and schedule preferences must use the planning owner lock'
  );
  assert.match(
    auth,
    /router\.post\('\/injury'[\s\S]*withPlanningInputMutation\(req\.user\.id/,
    'legacy injury preference write must use the planning owner lock'
  );
}

if (require.main === module) {
  runPlanningProfileRoutesSmoke();
  console.log('PLANNING PROFILE ROUTES SMOKE OK');
}

module.exports = { runPlanningProfileRoutesSmoke };
