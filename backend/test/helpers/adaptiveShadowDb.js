// Real in-memory SQLite transactions, foreign keys, uniqueness and savepoints.
// DDL is read from the repository schema; only PostgreSQL syntax is translated.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
function createDb() {
  const db = new DatabaseSync(':memory:');
  db.function('pg_column_size', s => Buffer.byteLength(String(s)));
  db.function('char_length', s => String(s).length);
  const schema = fs.readFileSync(path.join(__dirname, '../../src/db/schema.pg.sql'), 'utf8');
  const tables = new Set(['users', 'runs', 'lifts', 'workout_sessions', 'workout_sets', 'health_sync',
    'injury_logs', 'daily_checkins', 'race_events', 'training_plans', 'user_plans', 'planning_constraints',
    'provider_import_receipts', 'watch_sync', 'activity_measured_receipts', 'planning_evidence_corrections', 'planning_pipeline_artifacts', 'plan_generation_candidates', 'plan_candidate_rejections']);
  const translate = sql => sql.replace(/\s+FOR (?:KEY SHARE|UPDATE)/g, '').replace(/::(?:jsonb|date|text|timestamptz)/g, '')
    .replace(/\bNOW\(\)/gi, 'CURRENT_TIMESTAMP').replace(/\bILIKE\b/g, 'LIKE');
  for (const match of schema.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \([\s\S]*?\n\);/g)) {
    if (tables.has(match[1])) db.exec(translate(match[0]));
  }
  for (const match of schema.matchAll(/ALTER TABLE (\w+) ADD COLUMN IF NOT EXISTS [^;]+;/g)) {
    if (tables.has(match[1])) {
      const sql = translate(match[0]).replace('ADD COLUMN IF NOT EXISTS', 'ADD COLUMN');
      try { db.exec(sql); } catch (e) { if (!e.message.includes('duplicate column')) throw e; }
    }
  }
  // Fields from the existing startup additive migrations, absent in baseline DDL.
  for (const [table, columns] of Object.entries({ users: ['timezone TEXT', 'training_age_class TEXT', 'preferred_workout_days TEXT', 'run_eligible_weekdays TEXT', 'lift_eligible_weekdays TEXT'],
    watch_sync: ['sync_uuid TEXT'], runs: ['plan_session_id TEXT', 'planned_session_json TEXT'] })) {
    for (const column of columns) { try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`); }
      catch (e) { if (!e.message.includes('duplicate column')) throw e; } }
  }
  const startup = fs.readFileSync(path.join(__dirname, '../../src/db/index.js'), 'utf8');
  for (const match of startup.matchAll(/CREATE TABLE IF NOT EXISTS (\w+) \([\s\S]*?\n\s*\);/g)) {
    if (tables.has(match[1]) && !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(match[1])) db.exec(translate(match[0]));
  }
  db.exec('PRAGMA foreign_keys=ON');
  const calls = [], hooks = {};
  const tx = {};
  for (const method of ['get', 'all', 'run']) tx[method] = async (sql, params = []) => {
    calls.push({ method, sql, params });
    if (/ALTER TABLE watch_sync ADD COLUMN IF NOT EXISTS/.test(sql)) return { changes: 0 };
    if (hooks.before) await hooks.before(method, sql, params);
    try { return db.prepare(translate(sql))[method](...params); }
    catch (error) { error.test_sql = sql; throw error; }
  };
  let transactions = 0;
  async function withUserMutation(userId, fn) {
    transactions++;
    if (hooks.beforeTransaction) await hooks.beforeTransaction(transactions);
    db.exec('BEGIN');
    try { const result = await fn(tx); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return { db, tx, calls, hooks, exports: { dbGet: tx.get, dbAll: tx.all, dbRun: tx.run,
    withUserMutation, withPlanningInputMutation: require('../../src/lib/planningRevision').createPlanningInputMutationRunner(withUserMutation), withTransaction: fn => withUserMutation(null, fn) } };
}
module.exports = { createDb };
