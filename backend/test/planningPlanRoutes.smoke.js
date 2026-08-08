const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '../src/routes/plans.js'), 'utf8');

function count(pattern) {
  return (source.match(pattern) || []).length;
}

assert.doesNotMatch(source, /withTransaction\(/, 'plan routes must not bypass planning revision transactions');
assert.ok(
  count(/withPlanningInputMutation\(/g) >= 10,
  'generation, assignment, progress, reconciliation, adaptation, race-link, and rescheduling must share the planning owner lock'
);
assert.match(
  source,
  /persistConcurrentPlan[\s\S]*withPlanningInputMutation\(userId[\s\S]*plan_version, lineage_id, effective_from/,
  'new evidence plans must persist revision lineage and effective date under the owner lock'
);
assert.match(
  source,
  /router\.put\('\/my\/progress'[\s\S]*planningInputUnchanged\([\s\S]*idempotent: true/,
  'idempotent plan progress writes must not advance planning revision'
);
assert.match(
  source,
  /router\.post\('\/reconciliation\/respond'[\s\S]*withPlanningInputMutation\(req\.user\.id[\s\S]*planningInputUnchanged/,
  'hybrid reconciliation must version real changes and preserve no-op revisions'
);
assert.match(
  source,
  /router\.post\('\/reschedule-missed'[\s\S]*withPlanningInputMutation\(req\.user\.id[\s\S]*updateActivePlanData\(active, req\.user\.id/,
  'missed-run rescheduling must use the owner-scoped plan helper under the planning lock'
);
assert.match(
  source,
  /UPDATE training_plans SET plan_data=\? WHERE id=\? AND user_id=\?/,
  'assigned plan JSON updates must remain owner-scoped'
);

console.log('Planning plan-route smoke OK.');
