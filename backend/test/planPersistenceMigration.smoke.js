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
  const schemaSource = fs.readFileSync(path.join(__dirname, '../src/db/schema.pg.sql'), 'utf8');
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
  const additiveTables = [
    'planning_pipeline_artifacts',
    'planning_evidence_corrections',
    'planning_constraints',
    'plan_candidate_rejections',
  ];
  for (const table of additiveTables) {
    const fragment = `CREATE TABLE IF NOT EXISTS ${table}`;
    assert.ok(migrationSource.includes(fragment), `always migrations must include ${fragment}`);
    assert.ok(schemaSource.includes(fragment), `fresh schema must include ${fragment}`);
  }
  const candidateBindings = [
    'decision_id',
    'candidate_revision',
    'athlete_state_revision',
    'safety_state_hash',
    'goal_revisions_json',
    'lock_revision',
    'edit_revision',
    'surface_revision',
    'export_revision',
    'feature_mode',
    'selected_candidate_hash',
    'material_change_json',
  ];
  for (const column of candidateBindings) {
    assert.match(
      migrationSource,
      new RegExp(`ALTER TABLE plan_generation_candidates ADD COLUMN IF NOT EXISTS ${column}\\b`),
      `already-applied databases add nullable/default-safe ${column}`,
    );
    assert.match(schemaSource, new RegExp(`\\b${column}\\b`), `fresh schema includes ${column}`);
  }
  for (const source of [migrationSource, schemaSource]) {
    assert.match(source, /artifact_kind[\s\S]*evidence_snapshot[\s\S]*surface_manifest/);
    assert.match(source, /idx_pipeline_artifacts_user_decision_kind/);
    assert.match(source, /idx_pipeline_artifacts_candidate_kind/);
    assert.match(source, /idx_pipeline_artifacts_user_kind_created/);
    assert.match(source, /UNIQUE\s*\(user_id, artifact_kind, content_hash, revision\)/);
    assert.match(source, /constraint_kind[\s\S]*day_lock[\s\S]*session_lock[\s\S]*manual_edit/);
    assert.match(source, /idx_planning_constraints_scope_revision/);
    assert.match(source, /raw_evidence_ref[\s\S]*corrected_canonical_value_json[\s\S]*reason[\s\S]*attribution_json/);
    assert.match(source, /UNIQUE\s*\(user_id, candidate_hash, evidence_fingerprint, constraint_fingerprint, policy_fingerprint\)/);
  }
  assert.doesNotMatch(
    migrationSource,
    /(?:UPDATE|DELETE FROM|DROP TABLE)\s+(?:planning_pipeline_artifacts|planning_evidence_corrections|planning_constraints|plan_candidate_rejections)/i,
    'M24 migrations remain additive and preserve legacy data',
  );
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
