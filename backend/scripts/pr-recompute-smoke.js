#!/usr/bin/env node

const assert = require('assert');
const autoUpdatePRs = require('../src/services/prAuto');

// Exercise real in-memory SQL rather than an SQL-string imitation.
const fs = require('node:fs');
const path = require('node:path');
const { createDb } = require('../test/helpers/adaptiveShadowDb');
const fixtures = [];
function makeSqliteTx(seedRuns = []) {
  const fixture = createDb({ syntheticProfileFields: false });
  fixtures.push(fixture);
  const { db, tx } = fixture;
  const startup = fs.readFileSync(path.join(__dirname, '../src/db/index.js'), 'utf8');
  const ddl = startup.match(/CREATE TABLE IF NOT EXISTS personal_records \([\s\S]*?\n\s*\);/)[0];
  db.exec(ddl.replace(/DEFAULT \(to_char\(NOW\(\), 'YYYY-MM-DD'\)\)/g, 'DEFAULT CURRENT_TIMESTAMP'));
  for (const userId of new Set(seedRuns.map(run => run.user_id))) {
    db.prepare("INSERT INTO users(id,name,email,password_hash) VALUES (?,'Synthetic',?,'')").run(userId, `${userId}@example.invalid`);
  }
  for (const run of seedRuns) {
    db.prepare("INSERT INTO runs(id,user_id,date,distance_miles,duration_seconds,type) VALUES (?,?,?,?,?,'easy')")
      .run(run.id, run.user_id, run.date, run.distance_miles, run.duration_seconds);
  }
  return { ...tx, db };
}

function getAutoPr(tx, userId, label) {
  return tx.db.prepare("SELECT * FROM personal_records WHERE user_id=? AND category='run' AND label=? AND source='auto'").get(userId, label);
}

function getManualPr(tx, userId, label) {
  return tx.db.prepare("SELECT * FROM personal_records WHERE user_id=? AND category='run' AND label=? AND source='manual'").get(userId, label);
}

(async () => {
  const tx = makeSqliteTx([
    { id: 'run-a', user_id: 'u1', date: '2026-07-01', distance_miles: 5, duration_seconds: 3000 },
    { id: 'run-b', user_id: 'u1', date: '2026-07-02', distance_miles: 4, duration_seconds: 2400 },
    { id: 'run-c', user_id: 'u1', date: '2026-07-03', distance_miles: 3, duration_seconds: 1800 },
  ]);

  await autoUpdatePRs('u1', await tx.get('SELECT * FROM runs WHERE id=? AND user_id=?', ['run-a', 'u1']), { tx, strictErrors: true });
  assert.strictEqual(getAutoPr(tx, 'u1', 'Longest Run').run_id, 'run-a');
  assert.strictEqual(getAutoPr(tx, 'u1', 'Longest Run').value, 5);
  await tx.run("INSERT INTO personal_records(id,user_id,category,label,value,unit,source) VALUES ('manual-1','u1','run','Longest Run',10,'mi','manual')");
  await tx.run('DELETE FROM runs WHERE id=? AND user_id=?', ['run-a', 'u1']);
  await autoUpdatePRs.recomputeRunPrCategories('u1', ['Longest Run'], { tx });
  assert.strictEqual(getAutoPr(tx, 'u1', 'Longest Run').run_id, 'run-b');
  assert.strictEqual(getAutoPr(tx, 'u1', 'Longest Run').value, 4);
  assert.strictEqual(getManualPr(tx, 'u1', 'Longest Run').value, 10);

  await tx.run('UPDATE runs SET distance_miles=?, duration_seconds=? WHERE id=? AND user_id=?', [2, 1200, 'run-b', 'u1']);
  await autoUpdatePRs.recomputeRunPrCategories('u1', ['Longest Run'], { tx });
  assert.strictEqual(getAutoPr(tx, 'u1', 'Longest Run').run_id, 'run-c');
  assert.strictEqual(getAutoPr(tx, 'u1', 'Longest Run').value, 3);

  const tx2 = makeSqliteTx([
    { id: 'only-mile', user_id: 'u2', date: '2026-07-01', distance_miles: 1, duration_seconds: 420 },
  ]);
  await autoUpdatePRs('u2', await tx2.get('SELECT * FROM runs WHERE id=? AND user_id=?', ['only-mile', 'u2']), { tx: tx2, strictErrors: true });
  assert.ok(getAutoPr(tx2, 'u2', 'Fastest Mile'));
  await tx2.run('DELETE FROM runs WHERE id=? AND user_id=?', ['only-mile', 'u2']);
  await autoUpdatePRs.recomputeRunPrCategories('u2', ['Fastest Mile'], { tx: tx2 });
  assert.strictEqual(getAutoPr(tx2, 'u2', 'Fastest Mile'), undefined);

  console.log('PR recompute smoke OK');
})().catch((err) => {
  console.error('PR recompute smoke failed:', err);
  process.exitCode = 1;
}).finally(() => { for (const { db } of fixtures) db.close(); });
