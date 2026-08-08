#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ensureUniqueActiveUserPlanIndex } = require('../src/db/migrate');

async function runPlanPersistenceMigrationSmoke() {
  const duplicateSql = [];
  await assert.rejects(
    ensureUniqueActiveUserPlanIndex(async (sql) => {
      duplicateSql.push(sql);
      return { rows: [{ duplicate_users: 1 }] };
    }),
    (err) => err.code === 'DUPLICATE_ACTIVE_USER_PLANS'
      && err.duplicateCount === 1
      && !/user-a/.test(err.message)
  );
  assert.equal(duplicateSql.length, 1, 'duplicate preflight must stop before index creation');

  const cleanSql = [];
  const cleanQuery = async (sql) => {
    cleanSql.push(sql);
    return { rows: [] };
  };
  await ensureUniqueActiveUserPlanIndex(cleanQuery);
  await ensureUniqueActiveUserPlanIndex(cleanQuery);
  assert.equal(cleanSql.filter((sql) => /CREATE UNIQUE INDEX IF NOT EXISTS/.test(sql)).length, 2);

  const migrationSource = require('node:fs').readFileSync(require.resolve('../src/db/migrate'), 'utf8');
  const initSource = fs.readFileSync(path.join(__dirname, '../src/db/index.js'), 'utf8');
  const indexSource = fs.readFileSync(path.join(__dirname, '../src/db/activePlanIndex.js'), 'utf8');
  for (const fragment of [
    'planning_input_revision BIGINT NOT NULL DEFAULT 0',
    'plan_version BIGINT NOT NULL DEFAULT 1',
    'CREATE TABLE IF NOT EXISTS plan_generation_candidates',
    'CREATE TABLE IF NOT EXISTS diagnostic_access_audit',
  ]) {
    assert.ok(migrationSource.includes(fragment), `migration must include ${fragment}`);
  }
  assert.match(initSource, /require\('\.\/activePlanIndex'\)/, 'initDb and migrations share one active-plan index guard');
  assert.match(
    initSource,
    /await client\.query\('COMMIT'\);[\s\S]*await ensureUniqueActiveUserPlanIndex/,
    'schema columns must commit before duplicate detection can request guarded repair'
  );
  assert.doesNotMatch(initSource, /CREATE UNIQUE INDEX IF NOT EXISTS idx_user_plans_one_active_per_user/, 'initDb cannot create the unique index inside the schema transaction');
  assert.match(indexSource, /CREATE UNIQUE INDEX IF NOT EXISTS idx_user_plans_one_active_per_user/, 'shared guard installs the one-active-assignment invariant');
}

if (require.main === module) {
  runPlanPersistenceMigrationSmoke()
    .then(() => console.log('PLAN PERSISTENCE MIGRATION SMOKE OK'))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

module.exports = { runPlanPersistenceMigrationSmoke };
