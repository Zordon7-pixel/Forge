#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { dbAll, pool, withUserMutation } = require('../src/db');

const APPLY_CONFIRMATION = 'REPAIR_DUPLICATE_ACTIVE_PLANS';
const REPO_ROOT = path.resolve(__dirname, '../..');

function targetRef(userId) {
  return `athlete_${crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 12)}`;
}

function resolvedPathWithoutExistingLeaf(inputPath) {
  let cursor = path.resolve(inputPath);
  const suffix = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    suffix.unshift(path.basename(cursor));
    cursor = parent;
  }
  return path.resolve(fs.realpathSync(cursor), ...suffix);
}

function assertExternalBackupDirectory(directory) {
  const resolved = resolvedPathWithoutExistingLeaf(directory);
  const repo = fs.realpathSync(REPO_ROOT);
  if (resolved === repo || resolved.startsWith(`${repo}${path.sep}`)) {
    throw new Error('--backup-dir must resolve outside the repository checkout');
  }
  return resolved;
}

function parseArgs(argv = []) {
  const options = { apply: false, backupDir: '', confirmation: '', userIds: [] };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg.startsWith('--confirm=')) options.confirmation = arg.slice('--confirm='.length);
    else if (arg.startsWith('--backup-dir=')) options.backupDir = arg.slice('--backup-dir='.length);
    else if (arg.startsWith('--user-id=')) options.userIds.push(arg.slice('--user-id='.length).trim());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  options.userIds = [...new Set(options.userIds.filter(Boolean))];
  if (options.apply && options.confirmation !== APPLY_CONFIRMATION) {
    throw new Error(`--apply requires --confirm=${APPLY_CONFIRMATION}`);
  }
  if (options.apply && !options.backupDir) throw new Error('--backup-dir is required with --apply');
  if (options.apply) options.backupDir = assertExternalBackupDirectory(options.backupDir);
  return options;
}

async function findDuplicateActivePlans(all = dbAll, userIds = []) {
  const params = [];
  let ownerFilter = '';
  if (userIds.length) {
    ownerFilter = ` AND user_id IN (${userIds.map(() => '?').join(',')})`;
    params.push(...userIds);
  }
  return all(
    `SELECT user_id, COUNT(*)::int AS active_count
     FROM user_plans
     WHERE status='active'${ownerFilter}
     GROUP BY user_id
     HAVING COUNT(*) > 1
     ORDER BY user_id`,
    params
  );
}

function orderAssignments(rows = []) {
  return [...rows].sort((left, right) => {
    const version = Number(right.plan_version || 0) - Number(left.plan_version || 0);
    if (version) return version;
    const effective = String(right.effective_from || right.started_at || '')
      .localeCompare(String(left.effective_from || left.started_at || ''));
    if (effective) return effective;
    const created = String(right.created_at || '').localeCompare(String(left.created_at || ''));
    return created || String(right.id).localeCompare(String(left.id));
  });
}

async function repairDuplicateActivePlansForUser(userId, mutationRunner = withUserMutation) {
  return mutationRunner(userId, async (tx) => {
    const rows = orderAssignments(await tx.all(
      `SELECT id, user_id, plan_id, status, started_at, created_at, plan_version,
              lineage_id, supersedes_user_plan_id, effective_from
       FROM user_plans
       WHERE user_id=? AND status='active'
       ORDER BY plan_version DESC, effective_from DESC NULLS LAST, created_at DESC, id DESC
       FOR UPDATE`,
      [userId]
    ));
    if (rows.length <= 1) return { activeCount: rows.length, repaired: 0 };

    const keeper = rows[0];
    const lineageId = keeper.lineage_id || keeper.id;
    const immediatePredecessor = rows[1]?.id || null;
    const keeperUpdate = await tx.run(
      `UPDATE user_plans
       SET lineage_id=COALESCE(lineage_id, ?),
           supersedes_user_plan_id=COALESCE(supersedes_user_plan_id, ?)
       WHERE id=? AND user_id=? AND status='active'`,
      [lineageId, immediatePredecessor, keeper.id, userId]
    );
    if (keeperUpdate.changes !== 1) throw new Error('Active plan repair lost the selected keeper');

    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index];
      const predecessorId = rows[index + 1]?.id || null;
      const result = await tx.run(
        `UPDATE user_plans
         SET status='superseded',
             lineage_id=COALESCE(lineage_id, ?),
             supersedes_user_plan_id=COALESCE(supersedes_user_plan_id, ?)
         WHERE id=? AND user_id=? AND status='active'`,
        [lineageId, predecessorId, row.id, userId]
      );
      if (result.changes !== 1) throw new Error('Active plan repair could not demote a duplicate assignment');
    }
    return { activeCount: 1, repaired: rows.length - 1 };
  }, { userLock: 'update' });
}

function writeBackup(directory, rowsByUser) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const filename = path.join(directory, `active-plan-repair-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(filename, `${JSON.stringify({ created_at: new Date().toISOString(), rows: rowsByUser }, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return filename;
}

async function loadRepairBackupRows(duplicates) {
  const rows = [];
  for (const duplicate of duplicates) {
    const assignments = await dbAll(
      `SELECT id, user_id, plan_id, status, started_at, created_at, plan_version,
              lineage_id, supersedes_user_plan_id, effective_from
       FROM user_plans WHERE user_id=? AND status='active'
       ORDER BY plan_version DESC, created_at DESC, id DESC`,
      [duplicate.user_id]
    );
    rows.push({ target_ref: targetRef(duplicate.user_id), assignments });
  }
  return rows;
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const duplicates = await findDuplicateActivePlans(dbAll, options.userIds);
  duplicates.forEach((row) => console.log(JSON.stringify({
    active_count: Number(row.active_count),
    mode: 'duplicate',
    target_ref: targetRef(row.user_id),
  })));
  if (!duplicates.length) {
    console.log(JSON.stringify({ duplicates: 0, mode: 'preflight', writes: 0 }));
    return;
  }
  if (!options.apply) {
    console.error(JSON.stringify({ duplicates: duplicates.length, mode: 'preflight_failed', writes: 0 }));
    process.exitCode = 1;
    return;
  }

  const backupFile = writeBackup(options.backupDir, await loadRepairBackupRows(duplicates));
  let repaired = 0;
  for (const duplicate of duplicates) {
    const result = await repairDuplicateActivePlansForUser(duplicate.user_id);
    repaired += result.repaired;
    console.log(JSON.stringify({ mode: 'repaired', repaired: result.repaired, target_ref: targetRef(duplicate.user_id) }));
  }
  const remaining = await findDuplicateActivePlans(dbAll, options.userIds);
  if (remaining.length) throw new Error('Duplicate active plans remain after repair');
  console.log(JSON.stringify({ backup_file: backupFile, duplicates: duplicates.length, mode: 'repair_complete', repaired }));
}

if (require.main === module) {
  run()
    .catch((err) => {
      console.error(JSON.stringify({ error: err.message, mode: 'fatal' }));
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end().catch((err) => console.error(JSON.stringify({ error: err.message, mode: 'pool_close_failed' })));
    });
}

module.exports = {
  APPLY_CONFIRMATION,
  assertExternalBackupDirectory,
  findDuplicateActivePlans,
  orderAssignments,
  parseArgs,
  repairDuplicateActivePlansForUser,
  run,
  targetRef,
};
