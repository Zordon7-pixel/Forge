#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  ACCOUNT_DELETE_QUERIES,
  ACCOUNT_EXPORT_TABLES,
  ACCOUNT_SECRET_TABLES,
  ACCOUNT_SOCIAL_DELETE_QUERIES,
} = require('../src/lib/accountDataCoverage');

const root = path.resolve(__dirname, '..');
const srcDir = path.join(root, 'src');
const userOwnedColumnPattern = /\b(user_id|follower_id|following_id|created_by_user_id|requester_id|addressee_id|owner_id|consumed_by_id|blocker_id|blocked_id|reporter_id|subject_user_id|reviewed_by_id)\b/i;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    return entry.isFile() && fullPath.endsWith('.js') ? [fullPath] : [];
  });
}

function collectUserOwnedTables() {
  const tables = new Map();
  for (const file of walk(srcDir)) {
    const content = fs.readFileSync(file, 'utf8');
    const createTablePattern = /CREATE TABLE IF NOT EXISTS\s+([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)/g;
    let match;
    while ((match = createTablePattern.exec(content))) {
      const [, table, body] = match;
      if (!userOwnedColumnPattern.test(body)) continue;
      if (!tables.has(table)) tables.set(table, []);
      tables.get(table).push(path.relative(root, file));
    }
  }
  return tables;
}

function collectDeleteTables() {
  const tables = new Set();
  for (const [sql] of [...ACCOUNT_SOCIAL_DELETE_QUERIES, ...ACCOUNT_DELETE_QUERIES]) {
    const match = String(sql).match(/(?:DELETE FROM|UPDATE)\s+([a-zA-Z0-9_]+)/i);
    if (match) tables.add(match[1]);
  }
  return tables;
}

const userOwnedTables = collectUserOwnedTables();
const exportTables = new Set(ACCOUNT_EXPORT_TABLES.map((entry) => entry.table));
const deleteTables = collectDeleteTables();
const secretTables = new Set(ACCOUNT_SECRET_TABLES);

const missingExport = [];
const missingDelete = [];

for (const [table, files] of userOwnedTables.entries()) {
  if (!exportTables.has(table) && !secretTables.has(table)) {
    missingExport.push({ table, files });
  }
  if (!deleteTables.has(table)) {
    missingDelete.push({ table, files });
  }
}

if (missingExport.length || missingDelete.length) {
  if (missingExport.length) {
    console.error('Missing account export coverage:');
    for (const item of missingExport) {
      console.error(`- ${item.table} (${item.files.join(', ')})`);
    }
  }
  if (missingDelete.length) {
    console.error('Missing account deletion coverage:');
    for (const item of missingDelete) {
      console.error(`- ${item.table} (${item.files.join(', ')})`);
    }
  }
  process.exit(1);
}

const { runAccountDeletionAtomicitySmoke } = require('../test/accountDeletionAtomicity.smoke');

runAccountDeletionAtomicitySmoke()
  .then(() => {
    console.log(`Account data coverage OK: ${userOwnedTables.size} user-owned tables checked.`);
    console.log('Account deletion atomicity OK: mid-delete rollback checked.');
  })
  .catch((err) => {
    console.error('Account deletion atomicity check failed:', err);
    process.exitCode = 1;
  });
