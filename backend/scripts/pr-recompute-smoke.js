#!/usr/bin/env node

const assert = require('assert');
const autoUpdatePRs = require('../src/services/prAuto');

function makeMemoryTx(seedRuns = [], seedPrs = []) {
  const state = {
    runs: seedRuns.map((row) => ({ ...row })),
    personal_records: seedPrs.map((row) => ({ ...row })),
  };

  return {
    state,
    async get(sql, params = []) {
      if (sql.includes("category = 'run' AND label = ?")) {
        const [userId, label] = params;
        return state.personal_records.find((row) => row.user_id === userId && row.category === 'run' && row.label === label) || null;
      }
      if (sql.includes("category='run' AND label=? AND source='auto'")) {
        const [userId, label] = params;
        return state.personal_records.find((row) => row.user_id === userId && row.category === 'run' && row.label === label && row.source === 'auto') || null;
      }
      throw new Error(`Unhandled get SQL: ${sql}`);
    },
    async all(sql, params = []) {
      if (sql.includes('SELECT * FROM runs WHERE user_id=?')) {
        const [userId] = params;
        return state.runs
          .filter((row) => row.user_id === userId)
          .sort((a, b) => String(a.date).localeCompare(String(b.date)));
      }
      throw new Error(`Unhandled all SQL: ${sql}`);
    },
    async run(sql, params = []) {
      if (sql.includes('INSERT INTO personal_records')) {
        const [id, userId, label, value, unit, runId, achievedAt] = params;
        state.personal_records.push({
          id,
          user_id: userId,
          category: 'run',
          label,
          value,
          unit,
          run_id: runId,
          achieved_at: achievedAt,
          source: 'auto',
          discrepancy: 0,
          auto_value: null,
        });
        return { changes: 1 };
      }
      if (/UPDATE\s+personal_records\s+SET\s+value/i.test(sql)) {
        const [value, unit, runId, achievedAt, id] = params;
        const row = state.personal_records.find((item) => item.id === id);
        if (row) {
          Object.assign(row, {
            value,
            unit,
            run_id: runId,
            achieved_at: achievedAt,
            discrepancy: 0,
            auto_value: null,
            source: 'auto',
          });
        }
        return { changes: row ? 1 : 0 };
      }
      if (sql.includes('UPDATE personal_records SET discrepancy')) {
        const [autoValue, id] = params;
        const row = state.personal_records.find((item) => item.id === id);
        if (row) {
          row.discrepancy = 1;
          row.auto_value = autoValue;
        }
        return { changes: row ? 1 : 0 };
      }
      if (sql.includes('DELETE FROM personal_records WHERE id=')) {
        const [id] = params;
        const before = state.personal_records.length;
        state.personal_records = state.personal_records.filter((row) => row.id !== id);
        return { changes: before - state.personal_records.length };
      }
      throw new Error(`Unhandled run SQL: ${sql}`);
    },
  };
}

function getAutoPr(tx, userId, label) {
  return tx.state.personal_records.find((row) => (
    row.user_id === userId && row.category === 'run' && row.label === label && row.source === 'auto'
  ));
}

function getManualPr(tx, userId, label) {
  return tx.state.personal_records.find((row) => (
    row.user_id === userId && row.category === 'run' && row.label === label && row.source === 'manual'
  ));
}

(async () => {
  const tx = makeMemoryTx([
    { id: 'run-a', user_id: 'u1', date: '2026-07-01', distance_miles: 5, duration_seconds: 3000 },
    { id: 'run-b', user_id: 'u1', date: '2026-07-02', distance_miles: 4, duration_seconds: 2400 },
    { id: 'run-c', user_id: 'u1', date: '2026-07-03', distance_miles: 3, duration_seconds: 1800 },
  ]);

  await autoUpdatePRs('u1', tx.state.runs[0], { tx });
  assert.strictEqual(getAutoPr(tx, 'u1', 'Longest Run').run_id, 'run-a');
  assert.strictEqual(getAutoPr(tx, 'u1', 'Longest Run').value, 5);
  tx.state.personal_records.push({
    id: 'manual-1',
    user_id: 'u1',
    category: 'run',
    label: 'Longest Run',
    value: 10,
    unit: 'mi',
    source: 'manual',
    run_id: null,
  });

  tx.state.runs = tx.state.runs.filter((run) => run.id !== 'run-a');
  await autoUpdatePRs.recomputeRunPrCategories('u1', ['Longest Run'], { tx });
  assert.strictEqual(getAutoPr(tx, 'u1', 'Longest Run').run_id, 'run-b');
  assert.strictEqual(getAutoPr(tx, 'u1', 'Longest Run').value, 4);
  assert.strictEqual(getManualPr(tx, 'u1', 'Longest Run').value, 10);

  tx.state.runs = tx.state.runs.map((run) => (
    run.id === 'run-b' ? { ...run, distance_miles: 2, duration_seconds: 1200 } : run
  ));
  await autoUpdatePRs.recomputeRunPrCategories('u1', ['Longest Run'], { tx });
  assert.strictEqual(getAutoPr(tx, 'u1', 'Longest Run').run_id, 'run-c');
  assert.strictEqual(getAutoPr(tx, 'u1', 'Longest Run').value, 3);

  const tx2 = makeMemoryTx([
    { id: 'only-mile', user_id: 'u2', date: '2026-07-01', distance_miles: 1, duration_seconds: 420 },
  ]);
  await autoUpdatePRs('u2', tx2.state.runs[0], { tx: tx2 });
  assert.ok(getAutoPr(tx2, 'u2', 'Fastest Mile'));
  tx2.state.runs = [];
  await autoUpdatePRs.recomputeRunPrCategories('u2', ['Fastest Mile'], { tx: tx2 });
  assert.strictEqual(getAutoPr(tx2, 'u2', 'Fastest Mile'), undefined);

  console.log('PR recompute smoke OK');
})().catch((err) => {
  console.error('PR recompute smoke failed:', err);
  process.exit(1);
});
