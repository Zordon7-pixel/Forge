#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const repair = require('../scripts/repair-active-plan-assignments');

async function run() {
  assert.throws(
    () => repair.parseArgs(['--apply']),
    /requires --confirm=REPAIR_DUPLICATE_ACTIVE_PLANS/
  );
  assert.deepEqual(repair.parseArgs(['--user-id=a', '--user-id=a']).userIds, ['a']);

  const queries = [];
  const duplicates = await repair.findDuplicateActivePlans(async (sql, params) => {
    queries.push({ sql, params });
    return [{ user_id: 'a', active_count: 2 }];
  }, ['a']);
  assert.equal(duplicates.length, 1);
  assert.match(queries[0].sql, /status='active'/);
  assert.deepEqual(queries[0].params, ['a']);

  const rows = [
    { id: 'older', plan_version: 9, effective_from: '2026-08-09', created_at: '2026-08-01T12:00:00Z' },
    { id: 'newer', plan_version: 1, effective_from: '2026-08-01', created_at: '2026-08-08T12:00:00Z' },
  ];
  assert.equal(repair.orderAssignments(rows)[0].id, 'newer', 'repair survivor ordering matches the active resolver created_at ordering');

  const writes = [];
  let lockedSelect = '';
  const result = await repair.repairDuplicateActivePlansForUser('a', async (userId, fn, options) => {
    assert.equal(userId, 'a');
    assert.equal(options.userLock, 'update');
    return fn({
      all: async (sql, params) => {
        lockedSelect = sql;
        assert.match(sql, /FOR UPDATE/);
        assert.deepEqual(params, ['a']);
        return rows;
      },
      run: async (sql, params) => {
        writes.push({ sql, params });
        return { changes: 1 };
      },
    });
  });
  assert.deepEqual(result, { activeCount: 1, repaired: 1 });
  assert.equal(writes.length, 1);
  assert.ok(writes.every((write) => /WHERE id=\? AND user_id=\? AND status='active'/.test(write.sql)));
  assert.match(writes[0].sql, /SET status='superseded'/);
  assert.deepEqual(writes[0].params, ['older', 'a'], 'repair leaves the deterministic newest assignment active and demotes only the older duplicate');
  assert.doesNotMatch(lockedSelect, /plan_version|lineage_id|supersedes_user_plan_id|effective_from/, 'repair remains usable before the new lifecycle columns exist');
  const railwayConfig = fs.readFileSync(path.resolve(__dirname, '../../railway.toml'), 'utf8');
  assert.match(
    railwayConfig,
    /preDeployCommand = "cd backend && npm run check:active-plans"/,
    'Railway blocks a new release before traffic cutover when duplicate active assignments exist'
  );
  const lifecycleSource = fs.readFileSync(path.resolve(__dirname, '../src/lib/planAssignmentLifecycle.js'), 'utf8');
  assert.match(lifecycleSource, /ORDER BY up\.created_at DESC, up\.id DESC/, 'runtime and repair use the same deterministic tie-breaker');

  console.log('ACTIVE PLAN REPAIR SMOKE OK (15)');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
