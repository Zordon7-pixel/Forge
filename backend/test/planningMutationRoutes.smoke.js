#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  advancePlanningMutationRevisions,
} = require('../src/lib/planningRevision');

const routeDir = path.join(__dirname, '..', 'src', 'routes');
const readRoute = (name) => fs.readFileSync(path.join(routeDir, name), 'utf8');
const count = (source, pattern) => [...source.matchAll(pattern)].length;

function runPlanningMutationRoutesSmoke() {
  const runs = readRoute('runs.js');
  const workouts = readRoute('workouts.js');
  const lifts = readRoute('lifts.js');
  const health = readRoute('health.js');
  const imports = readRoute('import.js');
  const races = readRoute('races.js');

  assert.ok(count(runs, /withPlanningInputMutation\(/g) >= 4, 'run create/update/check-in/delete must use planning mutation transactions');
  assert.match(runs, /insertResult\.changes === 0[\s\S]*planningInputUnchanged/, 'idempotent run replay must not advance revision');
  assert.ok(count(workouts, /withPlanningInputMutation\(/g) >= 6, 'strength session writes must use planning mutation transactions');
  assert.match(workouts, /planningInputUnchanged\(false\)/, 'missing workout delete must not advance revision');
  assert.equal(count(lifts, /withPlanningInputMutation\(/g), 3, 'lift create/update/delete must use planning mutation transactions');
  assert.equal(count(health, /withPlanningInputMutation\(/g), 1, 'Health aggregate upsert must advance revision once');
  assert.match(imports, /withPlanningInputMutation\(userId,[\s\S]*outcome\.changed[\s\S]*planningInputUnchanged/, 'imports must advance only when activity data changes');
  assert.match(imports, /updateRunPrs\(userId, importedItem\.runId, \{ tx \}\)/, 'import PR enrichment must share the owner transaction');
  assert.match(races, /transitionRaceEventLifecycle\(race, body\)/, 'race lifecycle mutations use the explicit transition contract');
  assert.match(races, /advancePlanningMutationRevisions\([\s\S]*\{ event: changed \}\)/,
    'event mutations advance the shared goal/planning revision contract in production');
  assert.match(races, /if \(!lifecycle\.changed\) return planningInputUnchanged\(/,
    'a non-empty semantic no-op PATCH exits before the race write and planning revision increment');
  assert.match(races, /planningInputUnchanged/, 'invalid and no-op race mutations cannot advance planning revisions');

  const event = advancePlanningMutationRevisions({
    planning_input_revision: 8, goal_revision: 2, athlete_state_revision: 5,
    lock_revision: 3, edit_revision: 4,
  }, { event: true });
  assert.deepEqual(event, {
    planning_input_revision: 9, goal_revision: 3, athlete_state_revision: 5,
    lock_revision: 3, edit_revision: 4,
  });
  const safety = advancePlanningMutationRevisions(event, { safety: true });
  assert.equal(safety.planning_input_revision, 10);
  assert.equal(safety.athlete_state_revision, 6);
  const lock = advancePlanningMutationRevisions(safety, { constraint: 'lock' });
  assert.equal(lock.planning_input_revision, 11);
  assert.equal(lock.athlete_state_revision, 7);
  assert.equal(lock.lock_revision, 4);
  const edit = advancePlanningMutationRevisions(lock, { constraint: 'edit' });
  assert.equal(edit.planning_input_revision, 12);
  assert.equal(edit.athlete_state_revision, 8);
  assert.equal(edit.edit_revision, 5);
}

if (require.main === module) {
  runPlanningMutationRoutesSmoke();
  console.log('PLANNING MUTATION ROUTES SMOKE OK');
}

module.exports = { runPlanningMutationRoutesSmoke };
