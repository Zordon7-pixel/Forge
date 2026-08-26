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
    /const withPassiveCompatibilityMutation = database\.withUserMutation \|\| database\.withPlanningInputMutation;/,
    'stale-client check-in storage must prefer the user-scoped mutation transaction'
  );
  const checkinPost = checkin.match(
    /router\.post\('\/', auth, async \(req, res\) => \{([\s\S]*?)\n\}\);\n\nrouter\.post\('\/preview'/
  )?.[1];
  assert.equal(typeof checkinPost, 'string', 'daily check-in POST route must remain present and authenticated');
  const compatibilityTransaction = checkinPost.match(
    /await withPassiveCompatibilityMutation\(req\.user\.id, async \(tx\) => \{([\s\S]*?)\n    \}\);/
  )?.[1];
  assert.equal(
    typeof compatibilityTransaction,
    'string',
    'daily check-in compatibility storage must run under the owner-scoped mutation transaction'
  );
  assert.match(
    compatibilityTransaction,
    /'SELECT id FROM daily_checkins WHERE user_id=\? AND checkin_date=\? FOR UPDATE',\s*\[req\.user\.id, today\]/,
    'daily check-in lookup must parameterize owner and date under the transaction lock'
  );
  assert.match(
    compatibilityTransaction,
    /'UPDATE daily_checkins SET [^']+ WHERE id=\? AND user_id=\?',\s*\[feeling, legs, drive, time_available, resolvedSleepHours, JSON\.stringify\(life_flags\), existing\.id, req\.user\.id\]/,
    'daily check-in update must remain owner scoped and parameterized'
  );
  assert.match(
    compatibilityTransaction,
    /'INSERT INTO daily_checkins \(id, user_id, checkin_date, [^']+\) VALUES \(\?,\?,\?,\?,\?,\?,\?,\?,\?\)',\s*\[id, req\.user\.id, today,/,
    'daily check-in compatibility insert must parameterize owner and date'
  );
  assert.doesNotMatch(
    compatibilityTransaction,
    /\bcheckin_overrides\b/i,
    'stale-client check-in storage must never write or delete check-in overrides'
  );
  assert.doesNotMatch(
    compatibilityTransaction,
    /\b(?:UPDATE|INSERT INTO|DELETE FROM)\s+(?:user_plans|training_plans)\b/i,
    'stale-client check-in storage must never mutate an accepted plan'
  );
  assert.doesNotMatch(
    checkinPost,
    /\bcomputeCheckinDirective\(/,
    'stale-client check-in POST must not derive a new execution directive'
  );
  assert.match(
    checkinPost,
    /adjustment: 'Check-in saved for your history\. Your accepted plan and today\\'s training stay unchanged\.'[\s\S]*headline: 'Plan stays as accepted'[\s\S]*drivers: \[\][\s\S]*action: 'keep'[\s\S]*readiness_delta: 0/,
    'accepted plan execution must remain unchanged after compatibility storage'
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
