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

const REPO_ROOT = path.resolve(__dirname, '../..');
const SAFE_FAILURE_CODES = new Set([
  'ACTIVE_PLAN_MISSING',
  'APPLY_RESPONSE_INVALID',
  'CANDIDATE_FEASIBILITY_REVIEW_REQUIRED',
  'CANDIDATE_HASH_DRIFT',
  'CUTOVER_INVALID',
  'EXPLICIT_TARGET_NOT_ELIGIBLE',
  'LINEAGE_VERIFICATION_FAILED',
  'MISSING_RACE_AUTHORITY',
  'MISSING_SCHEDULE_AUTHORITY',
  'PLANNING_DATE_CHANGED',
  'POST_APPLY_HASH_MISMATCH',
  'ROLLOUT_APPLY_FAILED',
  'ROLLOUT_FATAL',
  'ROLLOUT_PREFLIGHT_FAILED',
]);

function rolloutError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function safeFailure(targetRefValue, error, fallbackCode) {
  const candidate = String(error?.code || '').toUpperCase();
  const code = SAFE_FAILURE_CODES.has(candidate) ? candidate : fallbackCode;
  return { target_ref: targetRefValue, code };
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
  const resolvedAncestor = fs.realpathSync(cursor);
  return path.resolve(resolvedAncestor, ...suffix);
}

function assertExternalBackupDirectory(directory) {
  const resolved = resolvedPathWithoutExistingLeaf(directory);
  const repo = fs.realpathSync(REPO_ROOT);
  if (resolved === repo || resolved.startsWith(`${repo}${path.sep}`)) {
    throw new Error('--backup-dir must resolve outside the repository checkout');
  }
  return resolved;
}

function parseArgs(argv) {
  const options = {
    apply: false,
    backupDir: '',
    confirmation: '',
    defaultTimezoneOffsetMinutes: new Date().getTimezoneOffset(),
    planningDateLocal: '',
    timezoneOffsetExplicit: false,
    userIds: [],
  };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg.startsWith('--confirm=')) options.confirmation = arg.slice('--confirm='.length);
    else if (arg.startsWith('--backup-dir=')) options.backupDir = path.resolve(arg.slice('--backup-dir='.length));
    else if (arg.startsWith('--planning-date=')) options.planningDateLocal = arg.slice('--planning-date='.length);
    else if (arg.startsWith('--timezone-offset-minutes=')) {
      options.defaultTimezoneOffsetMinutes = Number(arg.slice('--timezone-offset-minutes='.length));
      options.timezoneOffsetExplicit = true;
    }
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
  if (options.planningDateLocal && !options.timezoneOffsetExplicit) {
    throw new Error('--planning-date requires an explicit --timezone-offset-minutes');
  }
  if (options.apply && !options.backupDir) {
    throw new Error('--backup-dir is required with --apply so the redacted rollback manifest is stored outside the checkout');
  }
  if (options.apply) options.backupDir = assertExternalBackupDirectory(options.backupDir);
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
      authoritative: true,
      planningDateLocal: options.planningDateLocal,
      timezoneOffsetMinutes: options.defaultTimezoneOffsetMinutes,
      source: 'operator_explicit_offset',
    };
  }
  const recent = await dbGet(
    `SELECT planning_date_local, timezone_offset_minutes
     FROM plan_generation_candidates
     WHERE user_id=?
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  if (!recent && !options.timezoneOffsetExplicit) {
    return {
      authoritative: false,
      planningDateLocal: null,
      source: 'missing_timezone_authority',
      timezoneOffsetMinutes: null,
    };
  }
  const offset = Number.isFinite(Number(recent?.timezone_offset_minutes))
    ? Number(recent.timezone_offset_minutes)
    : options.defaultTimezoneOffsetMinutes;
  return {
    authoritative: true,
    planningDateLocal: localDateForOffset(now, offset),
    timezoneOffsetMinutes: offset,
    source: recent ? 'latest_candidate_offset' : 'operator_default_offset',
  };
}

async function preflightUser(row, options, now) {
  const clock = await planningClockForUser(row.id, options, now);
  if (!clock.authoritative) {
    return {
      clock,
      skipReason: 'missing_timezone_authority',
      targetRef: targetRef(row.id),
      userId: row.id,
    };
  }
  const active = await plansRouter._test.getActivePlanForUser(row.id, null, {
    includeFuture: true,
    planningDateLocal: clock.planningDateLocal,
  });
  if (!active) throw rolloutError('ACTIVE_PLAN_MISSING');
  const activePlan = parseStoredPlan(active.row);
  const races = await dbAll(
    `SELECT id, race_name, race_date, distance_miles, goal_time_seconds, status
     FROM race_events
     WHERE user_id=? AND status='upcoming' AND race_date>=?
     ORDER BY race_date ASC`,
    [row.id, clock.planningDateLocal]
  );
  const protectedRaces = selectProtectedRaces(races, activePlan, clock.planningDateLocal);
  if (!protectedRaces.length) {
    return {
      clock,
      skipReason: 'missing_race_authority',
      targetRef: targetRef(row.id),
      userId: row.id,
    };
  }
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
  let target;
  try {
    target = preservedPlanTarget(activePlan, row);
  } catch (error) {
    if (error?.code !== 'MISSING_SCHEDULE_AUTHORITY') throw error;
    return {
      clock,
      raceIds,
      skipReason: 'missing_schedule_authority',
      targetRef: targetRef(row.id),
      userId: row.id,
    };
  }
  const request = {
    race_ids: raceIds,
    target,
    planning_date_local: clock.planningDateLocal,
    timezone_offset_minutes: clock.timezoneOffsetMinutes,
  };
  const candidate = await plansRouter._test.previewPlanForUser(row.id, request, { store: false });
  const diagnostic = buildPlanDiagnosticBundle({ targetUserId: row.id, candidate });
  const feasibility = String(candidate.plan?.overall_feasibility || '').toLowerCase();
  if (feasibility !== 'supported') {
    return {
      clock,
      raceIds,
      skipReason: feasibility === 'stretch' || feasibility === 'unsafe'
        ? `feasibility_${feasibility}`
        : 'feasibility_unavailable',
      targetRef: targetRef(row.id),
      userId: row.id,
    };
  }
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

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function writePrivateJson(directory, prefix, payload) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = path.join(directory, `${prefix}-${stamp}.json`);
  const descriptor = fs.openSync(filename, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fsyncDirectory(directory);
  return filename;
}

function replacePrivateJson(filename, payload) {
  const directory = path.dirname(filename);
  const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.${Date.now()}.tmp`);
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filename);
  fs.chmodSync(filename, 0o600);
  fsyncDirectory(directory);
  return filename;
}

function assertPlanningDateStable(context, now = new Date()) {
  const current = localDateForOffset(now, context.clock.timezoneOffsetMinutes);
  if (current !== context.clock.planningDateLocal) throw rolloutError('PLANNING_DATE_CHANGED');
  return current;
}

function assertSupportedCandidate(candidate) {
  if (String(candidate?.plan?.overall_feasibility || '').toLowerCase() !== 'supported') {
    throw rolloutError('CANDIDATE_FEASIBILITY_REVIEW_REQUIRED');
  }
}

async function verifyApply(context, result, expectedCandidateHash) {
  const payload = result?.payload || {};
  const expectedEffectiveFrom = addDays(context.clock.planningDateLocal, 1);
  if (result?.status !== 200) throw rolloutError('APPLY_RESPONSE_INVALID');
  if (payload.candidate_hash !== expectedCandidateHash) throw rolloutError('POST_APPLY_HASH_MISMATCH');
  if (payload.effective_from !== expectedEffectiveFrom) throw rolloutError('CUTOVER_INVALID');
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
    throw rolloutError('LINEAGE_VERIFICATION_FAILED');
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
  const eligibleIds = new Set(rows.map((row) => String(row.id)));
  const unmatchedUserIds = options.userIds.filter((userId) => !eligibleIds.has(String(userId)));
  if (unmatchedUserIds.length && options.apply) {
    unmatchedUserIds.forEach((userId) => console.error(JSON.stringify({
      code: 'EXPLICIT_TARGET_NOT_ELIGIBLE',
      mode: 'target_rejected',
      target_ref: targetRef(userId),
    })));
    throw rolloutError('EXPLICIT_TARGET_NOT_ELIGIBLE');
  }
  const now = new Date();
  const contexts = [];
  const failures = [];
  const skipped = unmatchedUserIds.map((userId) => ({
    target_ref: targetRef(userId),
    reason: 'not_eligible',
  }));
  skipped.forEach((entry) => console.log(JSON.stringify({ mode: 'skipped', ...entry })));
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
      const failure = safeFailure(ref, err, 'ROLLOUT_PREFLIGHT_FAILED');
      failures.push(failure);
      console.error(JSON.stringify({ mode: 'preflight_failed', ...failure }));
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
  const resultJournal = {
    schema_version: 1,
    started_at: new Date().toISOString(),
    completed_at: null,
    applied,
    failures: applyFailures,
  };
  const resultFile = writePrivateJson(options.backupDir, 'apply-result', resultJournal);
  console.log(JSON.stringify({ mode: 'result_journal_started', result_file: resultFile }));
  for (const context of contexts) {
    try {
      assertPlanningDateStable(context, new Date());
      const stored = await plansRouter._test.previewPlanForUser(context.userId, context.request, { store: true });
      assertSupportedCandidate(stored);
      if (stored.candidateHash !== context.candidate.candidateHash) {
        throw rolloutError('CANDIDATE_HASH_DRIFT');
      }
      assertPlanningDateStable(context, new Date());
      const result = await plansRouter._test.applyPlanCandidate(context.userId, stored.id, {
        candidate_hash: stored.candidateHash,
        choice: 'train_for_target',
        planning_date_local: context.clock.planningDateLocal,
      });
      const verified = await verifyApply(context, result, stored.candidateHash);
      applied.push(verified);
      console.log(JSON.stringify({ mode: 'applied', ...verified }));
    } catch (err) {
      const failure = safeFailure(context.targetRef, err, 'ROLLOUT_APPLY_FAILED');
      applyFailures.push(failure);
      console.error(JSON.stringify({ mode: 'apply_failed', ...failure }));
    } finally {
      replacePrivateJson(resultFile, resultJournal);
    }
  }
  resultJournal.completed_at = new Date().toISOString();
  replacePrivateJson(resultFile, resultJournal);
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
      console.error(JSON.stringify({
        code: safeFailure('rollout', err, 'ROLLOUT_FATAL').code,
        mode: 'fatal',
      }));
      process.exitCode = 1;
    })
    .finally(async () => {
      await pool.end().catch(() => console.error(JSON.stringify({ code: 'POOL_CLOSE_FAILED', mode: 'cleanup_failed' })));
    });
}

module.exports = {
  assertExternalBackupDirectory,
  assertPlanningDateStable,
  assertSupportedCandidate,
  eligibleTesterRows,
  parseArgs,
  planningClockForUser,
  preflightUser,
  replacePrivateJson,
  run,
  safeFailure,
  verifyApply,
  writePrivateJson,
};
