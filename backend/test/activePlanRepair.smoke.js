#!/usr/bin/env node

const assert = require('node:assert/strict');
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
    { id: 'older', plan_version: 2, effective_from: '2026-08-01', created_at: '2026-08-01T12:00:00Z' },
    { id: 'newer', plan_version: 3, effective_from: '2026-08-09', created_at: '2026-08-08T12:00:00Z' },
  ];
  assert.equal(repair.orderAssignments(rows)[0].id, 'newer');

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

  console.log('ACTIVE PLAN REPAIR SMOKE OK (13)');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
