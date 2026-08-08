#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const routeDir = path.join(__dirname, '..', 'src', 'routes');
const readRoute = (name) => fs.readFileSync(path.join(routeDir, name), 'utf8');
const count = (source, pattern) => [...source.matchAll(pattern)].length;

function runPlanningMutationRoutesSmoke() {
  const runs = readRoute('runs.js');
  const workouts = readRoute('workouts.js');
  const lifts = readRoute('lifts.js');
  const health = readRoute('health.js');
  const imports = readRoute('import.js');

  assert.ok(count(runs, /withPlanningInputMutation\(/g) >= 4, 'run create/update/check-in/delete must use planning mutation transactions');
  assert.match(runs, /insertResult\.changes === 0[\s\S]*planningInputUnchanged/, 'idempotent run replay must not advance revision');
  assert.ok(count(workouts, /withPlanningInputMutation\(/g) >= 6, 'strength session writes must use planning mutation transactions');
  assert.match(workouts, /planningInputUnchanged\(false\)/, 'missing workout delete must not advance revision');
  assert.equal(count(lifts, /withPlanningInputMutation\(/g), 3, 'lift create/update/delete must use planning mutation transactions');
  assert.equal(count(health, /withPlanningInputMutation\(/g), 1, 'Health aggregate upsert must advance revision once');
  assert.match(imports, /withPlanningInputMutation\(userId,[\s\S]*outcome\.changed[\s\S]*planningInputUnchanged/, 'imports must advance only when activity data changes');
  assert.match(imports, /updateRunPrs\(userId, importedItem\.runId, \{ tx \}\)/, 'import PR enrichment must share the owner transaction');
}

if (require.main === module) {
  runPlanningMutationRoutesSmoke();
  console.log('PLANNING MUTATION ROUTES SMOKE OK');
}

module.exports = { runPlanningMutationRoutesSmoke };
