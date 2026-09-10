const assert = require('node:assert/strict');
const { planVersionFor } = require('../src/routes/plans')._test;
const clone = value => JSON.parse(JSON.stringify(value));
const reordered = value => Array.isArray(value) ? value.map(reordered)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reordered(value[key])])) : value;
const plan = { schemaVersion: 2, plan_revision: 3,
  programContract: { timezone: 'America/New_York', goals: [{ id: 'owned-goal', target_time_s: 5400 }] },
  weeks: [{ days: [{ date: '2026-09-12', sessions: [{ id: 'run', kind: 'run', duration_min: 20, target: { rpe: [2, 4] } }] }] }] };
const active = { source: 'assigned', row: { id: 'owned-plan', user_plan_id: 'owned-assignment', progress_json: {
  hybridSessionReconciliations: { b: { response: 'life_event' }, a: { response: 'skipped' } },
  missedSessionOutcomes: { missed: { reason: 'no_time' } }, completedSessionIds: ['completed'] } } };
const snapshot = { fingerprint: 'unchanged-physical-evidence', planningInputRevision: 10 };
const version = planVersionFor(active, plan, snapshot);
assert.deepEqual(reordered(plan), plan);
assert.notEqual(JSON.stringify(reordered(plan)), JSON.stringify(plan));
assert.equal(planVersionFor(reordered(active), reordered(plan), snapshot), version,
  'JSONB ordering of identical complete plan/progress must not create another coaching decision');
assert.equal(planVersionFor({ ...active, row: { ...active.row, progress_json: JSON.stringify(reordered(active.row.progress_json)) } }, plan, snapshot), version);
for (const change of [
  value => { value.plan_revision++; },
  value => { value.programContract.goals[0].target_time_s = 4500; },
  value => { value.programContract.timezone = 'UTC'; },
  value => { value.weeks[0].days[0].sessions[0].duration_min++; },
  value => { value.weeks[0].days[0].sessions[0].target.rpe.reverse(); },
  value => { value.weeks[0].days[0].sessions[0].distance_m = null; },
]) {
  const changed = clone(plan); change(changed);
  assert.notEqual(planVersionFor(active, changed, snapshot), version, 'All material/revision/goal/unknown fields and array order remain bound');
}
for (const change of [
  value => { value.source = 'legacy'; },
  value => { value.row.id = 'other-plan'; },
  value => { value.row.user_plan_id = 'other-assignment'; },
  value => { value.row.progress_json.missedSessionOutcomes.missed.reason = 'illness'; },
  value => { value.row.progress_json.hybridSessionReconciliations.a.response = 'life_event'; },
  value => { value.row.progress_json.completedSessionIds.push('newly-completed'); },
]) {
  const changed = clone(active); change(changed);
  assert.notEqual(planVersionFor(changed, plan, snapshot), version, 'Assignment, source and athlete outcomes remain bound');
}
assert.notEqual(planVersionFor(active, plan, { ...snapshot, fingerprint: 'new-physical-evidence' }), version);
assert.equal(planVersionFor(active, plan, { ...snapshot, planningInputRevision: 11 }), version,
  'Settled semantic identity is separate from the unchanged strict input-revision accept guard');
console.log('ACTIVITY PLAN VERSION SMOKE OK: full JSONB-order-independent identity, no real change suppression');
