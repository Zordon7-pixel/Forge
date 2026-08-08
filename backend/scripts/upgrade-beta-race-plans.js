#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { dbAll, dbGet, pool } = require('../src/db');
const plansRouter = require('../src/routes/plans');
const { buildPlanDiagnosticBundle } = require('../src/lib/racePlanDiagnostics');
const { RACE_PLAN_POLICY_V1, addDays } = require('../src/lib/racePlanPolicy');
const {
  assertApplyAuthorized,
  buildBackupManifest,
  isCurrentRolloutPlan,
  localDateForOffset,
  parseStoredPlan,
  preservedPlanTarget,
  redactedBackupEntry,
  selectProtectedRaces,
  targetRef,
} = require('../src/lib/betaPlanRollout');

function parseArgs(argv) {
  const options = {
    apply: false,
    backupDir: '',
    confirmation: '',
    defaultTimezoneOffsetMinutes: new Date().getTimezoneOffset(),
    planningDateLocal: '',
    userIds: [],
  };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg.startsWith('--confirm=')) options.confirmation = arg.slice('--confirm='.length);
    else if (arg.startsWith('--backup-dir=')) options.backupDir = path.resolve(arg.slice('--backup-dir='.length));
    else if (arg.startsWith('--planning-date=')) options.planningDateLocal = arg.slice('--planning-date='.length);
    else if (arg.startsWith('--timezone-offset-minutes=')) options.defaultTimezoneOffsetMinutes = Number(arg.slice('--timezone-offset-minutes='.length));
    else if (arg.startsWith('--user-id=')) options.userIds.push(arg.slice('--user-id='.length).trim());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.planningDateLocal && !/^\d{4}-\d{2}-\d{2}$/.test(options.planningDateLocal)) {
    throw new Error('--planning-date must use YYYY-MM-DD');
  }
  if (!Number.isFinite(options.defaultTimezoneOffsetMinutes)
    || options.defaultTimezoneOffsetMinutes < -840
    || options.defaultTimezoneOffsetMinutes > 840) {
    throw new Error('--timezone-offset-minutes must be between -840 and 840');
  }
  if (options.apply && !options.backupDir) {
    throw new Error('--backup-dir is required with --apply so the redacted rollback manifest is stored outside the checkout');
  }
  options.userIds = [...new Set(options.userIds.filter(Boolean))];
  return options;
}

async function eligibleTesterRows(options) {
  const params = [];
  let userFilter = '';
  if (options.userIds.length) {
    userFilter = `AND u.id IN (${options.userIds.map(() => '?').join(',')})`;
    params.push(...options.userIds);
  }
  return dbAll(
    `SELECT u.id, u.run_days_per_week, u.lift_days_per_week, u.preferred_workout_days
     FROM users u
     WHERE u.onboarded=1
       ${userFilter}
       AND EXISTS (SELECT 1 FROM user_plans up WHERE up.user_id=u.id AND up.status='active')
       AND EXISTS (
         SELECT 1 FROM race_events race
         WHERE race.user_id=u.id AND race.status='upcoming'
       )
     ORDER BY u.id`,
    params
  );
}

async function planningClockForUser(userId, options, now) {
  if (options.planningDateLocal) {
    return {
      planningDateLocal: options.planningDateLocal,
      timezoneOffsetMinutes: options.defaultTimezoneOffsetMinutes,
      source: 'operator',
    };
  }
  const recent = await dbGet(
    `SELECT planning_date_local, timezone_offset_minutes
     FROM plan_generation_candidates
     WHERE user_id=?
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  const offset = Number.isFinite(Number(recent?.timezone_offset_minutes))
    ? Number(recent.timezone_offset_minutes)
    : options.defaultTimezoneOffsetMinutes;
  return {
    planningDateLocal: localDateForOffset(now, offset),
    timezoneOffsetMinutes: offset,
    source: recent ? 'latest_candidate_offset' : 'operator_default_offset',
  };
}

async function preflightUser(row, options, now) {
  const clock = await planningClockForUser(row.id, options, now);
  const active = await plansRouter._test.getActivePlanForUser(row.id, null, {
    includeFuture: true,
    planningDateLocal: clock.planningDateLocal,
  });
  if (!active) throw new Error('active plan disappeared during preflight');
  const activePlan = parseStoredPlan(active.row);
  const races = await dbAll(
    `SELECT id, race_name, race_date, distance_miles, goal_time_seconds, status
     FROM race_events
     WHERE user_id=? AND status='upcoming' AND race_date>=?
     ORDER BY race_date ASC`,
    [row.id, clock.planningDateLocal]
  );
  const protectedRaces = selectProtectedRaces(races, activePlan, clock.planningDateLocal);
  if (!protectedRaces.length) throw new Error('no compatible future owned race is available');
  const raceIds = protectedRaces.map((race) => String(race.id));
  if (isCurrentRolloutPlan(activePlan, raceIds)) {
    return {
      clock,
      raceIds,
      skipReason: 'already_current',
      targetRef: targetRef(row.id),
      userId: row.id,
    };
  }
  const target = preservedPlanTarget(activePlan, row);
  const request = {
    race_ids: raceIds,
    target,
    planning_date_local: clock.planningDateLocal,
    timezone_offset_minutes: clock.timezoneOffsetMinutes,
  };
  const candidate = await plansRouter._test.previewPlanForUser(row.id, request, { store: false });
  const diagnostic = buildPlanDiagnosticBundle({ targetUserId: row.id, candidate });
  return {
    active,
    activePlan,
    candidate,
    clock,
    diagnostic,
    raceIds,
    request,
    targetRef: targetRef(row.id),
    userId: row.id,
  };
}

function writePrivateJson(directory, prefix, payload) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = path.join(directory, `${prefix}-${stamp}.json`);
  const descriptor = fs.openSync(filename, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8' });
  } finally {
    fs.closeSync(descriptor);
  }
  return filename;
}

async function verifyApply(context, result) {
  const payload = result?.payload || {};
  const expectedEffectiveFrom = addDays(context.clock.planningDateLocal, 1);
  if (result?.status !== 200 || payload.effective_from !== expectedEffectiveFrom) {
    throw new Error('candidate apply did not return the required next-day cutover');
  }
  const rows = await dbAll(
    `SELECT id, plan_id, status, plan_version, lineage_id, supersedes_user_plan_id, effective_from
     FROM user_plans
     WHERE user_id=? AND (id=? OR id=?)
     ORDER BY created_at ASC`,
    [context.userId, context.active.row.user_plan_id, payload.user_plan_id]
  );
  const prior = rows.find((row) => String(row.id) === String(context.active.row.user_plan_id));
  const next = rows.find((row) => String(row.id) === String(payload.user_plan_id));
  if (prior?.status !== 'superseded'
    || next?.status !== 'active'
    || String(next?.supersedes_user_plan_id || '') !== String(prior?.id || '')
    || next?.effective_from !== expectedEffectiveFrom) {
    throw new Error('post-apply assignment lineage verification failed');
  }
  return {
    effective_from: expectedEffectiveFrom,
    plan_version: Number(next.plan_version),
    target_ref: context.targetRef,
  };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  const betaAccessEnabled = String(process.env.FORGE_BETA_ACCESS || '').toLowerCase() === 'true';
  assertApplyAuthorized({
    apply: options.apply,
    confirmation: options.confirmation,
    betaAccessEnabled,
  });
  const rows = await eligibleTesterRows(options);
  if (options.apply && rows.length === 0) {
    throw new Error('No eligible beta tester plans matched the controlled rollout cohort');
  }
  const now = new Date();
  const contexts = [];
  const failures = [];
  const skipped = [];
  for (const row of rows) {
    try {
      const context = await preflightUser(row, options, now);
      if (context.skipReason) {
        skipped.push({ target_ref: context.targetRef, reason: context.skipReason });
        console.log(JSON.stringify({ mode: 'skipped', target_ref: context.targetRef, reason: context.skipReason }));
        continue;
      }
      contexts.push(context);
      console.log(JSON.stringify({
        candidate_hash: context.candidate.candidateHash,
        clock_source: context.clock.source,
        feasibility: context.diagnostic.candidate.feasibility,
        mode: 'preflight',
        protected_races: context.raceIds.length,
        target_ref: context.targetRef,
      }));
    } catch (err) {
      const ref = targetRef(row.id);
      failures.push({ target_ref: ref, error: err.message });
      console.error(JSON.stringify({ mode: 'preflight_failed', target_ref: ref, error: err.message }));
    }
  }

  const summary = {
    apply_requested: options.apply,
    cohort_count: rows.length,
    failures: failures.length,
    mode: options.apply ? 'apply' : 'dry_run',
    previewed: contexts.length,
    skipped: skipped.length,
  };
  if (failures.length) {
    console.error(JSON.stringify({ ...summary, aborted_before_writes: true }));
    process.exitCode = 1;
    return;
  }
  if (!options.apply) {
    console.log(JSON.stringify({ ...summary, writes: 0 }));
    return;
  }
  if (contexts.length === 0) {
    console.log(JSON.stringify({ ...summary, applied: 0, apply_failures: 0, writes: 0 }));
    return;
  }

  const manifest = buildBackupManifest({
    entries: contexts.map((context) => redactedBackupEntry({
      userId: context.userId,
      active: context.active,
      activePlan: context.activePlan,
      candidate: context.candidate,
      raceIds: context.raceIds,
      planningDateLocal: context.clock.planningDateLocal,
    })),
  });
  const backupFile = writePrivateJson(options.backupDir, 'pre-apply', manifest);
  console.log(JSON.stringify({ backup_file: backupFile, mode: 'backup_written', records: manifest.entries.length }));

  const applied = [];
  const applyFailures = [];
  for (const context of contexts) {
    try {
      const stored = await plansRouter._test.previewPlanForUser(context.userId, context.request, { store: true });
      const result = await plansRouter._test.applyPlanCandidate(context.userId, stored.id, {
        candidate_hash: stored.candidateHash,
        choice: 'train_for_target',
        planning_date_local: context.clock.planningDateLocal,
      });
      const verified = await verifyApply(context, result);
      applied.push(verified);
      console.log(JSON.stringify({ mode: 'applied', ...verified }));
    } catch (err) {
      const failure = { target_ref: context.targetRef, error: err.message };
      applyFailures.push(failure);
      console.error(JSON.stringify({ mode: 'apply_failed', ...failure }));
    }
  }
  const resultFile = writePrivateJson(options.backupDir, 'apply-result', {
    schema_version: 1,
    completed_at: new Date().toISOString(),
    applied,
    failures: applyFailures,
  });
  console.log(JSON.stringify({
    ...summary,
    applied: applied.length,
    apply_failures: applyFailures.length,
    result_file: resultFile,
  }));
  if (applyFailures.length) process.exitCode = 1;
}

if (require.main === module) {
  run()
    .catch((err) => {
      console.error('[upgrade-beta-race-plans] fatal:', err.message);
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end().catch((err) => console.error('[upgrade-beta-race-plans] pool close failed:', err.message));
    });
}

module.exports = {
  eligibleTesterRows,
  parseArgs,
  planningClockForUser,
  preflightUser,
  run,
  verifyApply,
  writePrivateJson,
};
