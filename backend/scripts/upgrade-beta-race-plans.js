#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { dbAll, pool, withUserMutation } = require('../src/db');
const plansRouter = require('../src/routes/plans');
const {
  buildDecisionArtifactDiagnosticBundle,
  buildPlanDiagnosticBundle,
} = require('../src/lib/racePlanDiagnostics');
const {
  ARTIFACT_KINDS,
  PLANNING_POLICY_VERSION,
} = require('../src/lib/goalBackwardContracts');
const {
  buildGoalBackwardApplyEnvelope,
  validateStoredGoalBackwardCandidateBindings,
} = require('../src/lib/planCandidateLifecycle');
const { RACE_PLAN_POLICY_V1, addDays, parseStrictInteger } = require('../src/lib/racePlanPolicy');
const {
  buildBackupManifest,
  getGoalBackwardV24Mode,
  isCurrentRolloutPlan,
  localDateForOffset,
  parseGoalBackwardCohortRefs,
  parseStoredPlan,
  preservedPlanTarget,
  redactedBackupEntry,
  selectProtectedRaces,
  targetRef,
} = require('../src/lib/betaPlanRollout');

const REPO_ROOT = path.resolve(__dirname, '../..');
const FORGED_IOS_APP_ID = 'com.zordontech.forge';
const NATIVE_CLOCK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLOCK_FUTURE_SKEW_MS = 5 * 60 * 1000;
const APPLY_CONFIRMATION = 'APPLY_GOAL_BACKWARD_V24';
const ROLLBACK_CONFIRMATION = 'ROLLBACK_GOAL_BACKWARD_V24';
const SAFE_FAILURE_CODES = new Set([
  'ACTIVE_PLAN_MISSING',
  'APPLY_RESPONSE_INVALID',
  'CANDIDATE_FEASIBILITY_REVIEW_REQUIRED',
  'CANDIDATE_HASH_DRIFT',
  'DEPLOYED_ARTIFACT_MISMATCH',
  'DEPLOYED_ARTIFACT_IDENTITY_MISSING',
  'DEPLOYED_REVISION_MISMATCH',
  'DISPOSABLE_TARGET_NOT_ALLOWLISTED',
  'CUTOVER_INVALID',
  'EXPLICIT_TARGET_NOT_ELIGIBLE',
  'LINEAGE_VERIFICATION_FAILED',
  'MISSING_RACE_AUTHORITY',
  'MISSING_SCHEDULE_AUTHORITY',
  'MISSING_TIMEZONE_AUTHORITY',
  'PLANNING_DATE_CHANGED',
  'POST_APPLY_HASH_MISMATCH',
  'RELEASE_ARTIFACT_VERIFICATION_FAILED',
  'ROLLBACK_LINEAGE_INVALID',
  'ROLLBACK_RESTORE_FAILED',
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

function isPlaceholderUserId(value) {
  const id = String(value || '').trim();
  return !id
    || /^(?:DISPOSABLE_ACCOUNT_ID|USER_ID|PLACEHOLDER|EXAMPLE|user-?\d+)$/i.test(id)
    || /(?:placeholder|replace[_-]?me|example[_-]?id)/i.test(id)
    || id.length > 128;
}

function assertDisposableUserIds(userIds, cohortRefs = parseGoalBackwardCohortRefs()) {
  const refs = new Set(parseGoalBackwardCohortRefs(cohortRefs));
  for (const userId of userIds || []) {
    if (isPlaceholderUserId(userId)) throw rolloutError('DISPOSABLE_TARGET_NOT_ALLOWLISTED');
    if (!refs.has(targetRef(userId))) throw rolloutError('DISPOSABLE_TARGET_NOT_ALLOWLISTED');
  }
  return true;
}

function assertGoalBackwardApplyAuthorized({ apply = false, rollback = false, confirmation, mode } = {}) {
  if (apply) {
    if (mode !== 'on') throw new Error('Apply requires FORGE_GOAL_BACKWARD_V24_MODE=on');
    if (confirmation !== APPLY_CONFIRMATION) throw new Error(`Apply requires --confirm=${APPLY_CONFIRMATION}`);
  }
  if (rollback) {
    if (mode !== 'off') throw new Error('Rollback restoration requires FORGE_GOAL_BACKWARD_V24_MODE=off');
    if (confirmation !== ROLLBACK_CONFIRMATION) throw new Error(`Rollback requires --confirm=${ROLLBACK_CONFIRMATION}`);
  }
  return true;
}

function releaseRevision(value) {
  const revision = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{7,64}$/.test(revision) ? revision : null;
}

function releaseArtifactHash(value) {
  const hash = String(value || '').trim().toLowerCase();
  return /^sha256:[a-f0-9]{64}$/.test(hash) ? hash : null;
}

function assertDeployedArtifactIdentity({
  expectedRevision,
  deployedRevision,
  expectedArtifactHash,
  deployedArtifactHash,
} = {}) {
  const expectedRevisionValue = releaseRevision(expectedRevision);
  const deployedRevisionValue = releaseRevision(deployedRevision);
  const expectedArtifactValue = releaseArtifactHash(expectedArtifactHash);
  const deployedArtifactValue = releaseArtifactHash(deployedArtifactHash);
  if (!expectedRevisionValue || !deployedRevisionValue || !expectedArtifactValue || !deployedArtifactValue) {
    throw rolloutError('DEPLOYED_ARTIFACT_IDENTITY_MISSING');
  }
  if (expectedRevisionValue !== deployedRevisionValue) throw rolloutError('DEPLOYED_REVISION_MISMATCH');
  if (expectedArtifactValue !== deployedArtifactValue) throw rolloutError('DEPLOYED_ARTIFACT_MISMATCH');
  return {
    verified: true,
    source_revision: deployedRevisionValue,
    artifact_hash: deployedArtifactValue,
  };
}

function deployedArtifactIdentityFromEnvironment(env = process.env) {
  return assertDeployedArtifactIdentity({
    expectedRevision: env.FORGE_GOAL_BACKWARD_V24_EXPECTED_REVISION,
    deployedRevision: env.RAILWAY_GIT_COMMIT_SHA || env.FORGE_GOAL_BACKWARD_V24_DEPLOYED_REVISION,
    expectedArtifactHash: env.FORGE_GOAL_BACKWARD_V24_EXPECTED_ARTIFACT_SHA256,
    deployedArtifactHash: env.FORGE_GOAL_BACKWARD_V24_DEPLOYED_ARTIFACT_SHA256,
  });
}

function parseArgs(argv) {
  const options = {
    apply: false,
    backupDir: '',
    confirmation: '',
    rollback: false,
    rollbackManifest: '',
    userIds: [],
  };
  for (const arg of argv) {
    if (arg === '--apply') options.apply = true;
    else if (arg === '--rollback') options.rollback = true;
    else if (arg.startsWith('--confirm=')) options.confirmation = arg.slice('--confirm='.length);
    else if (arg.startsWith('--backup-dir=')) options.backupDir = path.resolve(arg.slice('--backup-dir='.length));
    else if (arg.startsWith('--rollback-manifest=')) options.rollbackManifest = path.resolve(arg.slice('--rollback-manifest='.length));
    else if (arg.startsWith('--planning-date=') || arg.startsWith('--timezone-offset-minutes=')) {
      throw new Error('Operator-supplied planning clocks are not accepted; use fresh authenticated iOS telemetry');
    }
    else if (arg.startsWith('--user-id=')) options.userIds.push(arg.slice('--user-id='.length).trim());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  options.userIds = [...new Set(options.userIds.filter(Boolean))];
  if (options.userIds.some(isPlaceholderUserId)) throw new Error('placeholder user IDs are forbidden');
  if (options.apply && options.rollback) throw new Error('--apply and --rollback are mutually exclusive');
  if (options.apply && options.userIds.length === 0) {
    throw new Error('At least one explicit --user-id is required with --apply');
  }
  if (options.apply && !options.backupDir) {
    throw new Error('--backup-dir is required with --apply so the redacted rollback manifest is stored outside the checkout');
  }
  if (options.apply) options.backupDir = assertExternalBackupDirectory(options.backupDir);
  if (options.rollback && options.userIds.length === 0) {
    throw new Error('At least one explicit --user-id is required with --rollback');
  }
  if (options.rollback && !options.rollbackManifest) {
    throw new Error('--rollback-manifest is required with --rollback');
  }
  if (options.rollback) {
    const manifestDirectory = assertExternalBackupDirectory(path.dirname(options.rollbackManifest));
    options.rollbackManifest = path.join(manifestDirectory, path.basename(options.rollbackManifest));
  }
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

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function timestampMs(value) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function clockFromNativeAppOpen(row, now = new Date()) {
  const nowMs = timestampMs(now);
  const createdAtMs = timestampMs(row?.created_at);
  const props = parseJsonObject(row?.props);
  if (nowMs === null || createdAtMs === null || !props) return null;
  if (createdAtMs > nowMs + CLOCK_FUTURE_SKEW_MS || nowMs - createdAtMs > NATIVE_CLOCK_MAX_AGE_MS) return null;

  const timezoneOffsetMinutes = parseStrictInteger(props.timezone_offset_minutes);
  const buildNumber = parseStrictInteger(props.build_number);
  if (props.platform !== 'ios_native'
    || props.native_runtime !== true
    || props.app_id !== FORGED_IOS_APP_ID
    || buildNumber === null
    || buildNumber <= 0
    || timezoneOffsetMinutes === null
    || Math.abs(timezoneOffsetMinutes) > RACE_PLAN_POLICY_V1.calendar.maximumTimezoneOffsetMinutes) {
    return null;
  }

  return {
    authoritative: true,
    planningDateLocal: localDateForOffset(now, timezoneOffsetMinutes),
    timezoneOffsetMinutes,
    source: 'fresh_native_ios_app_open',
  };
}

function clockFromUnexpiredCandidate(row, now = new Date()) {
  const nowMs = timestampMs(now);
  const createdAtMs = timestampMs(row?.created_at);
  const expiresAtMs = timestampMs(row?.expires_at);
  const timezoneOffsetMinutes = parseStrictInteger(row?.timezone_offset_minutes);
  if (nowMs === null
    || createdAtMs === null
    || expiresAtMs === null
    || row?.status !== 'preview'
    || createdAtMs > nowMs + CLOCK_FUTURE_SKEW_MS
    || expiresAtMs <= nowMs
    || timezoneOffsetMinutes === null
    || Math.abs(timezoneOffsetMinutes) > RACE_PLAN_POLICY_V1.calendar.maximumTimezoneOffsetMinutes) {
    return null;
  }
  const planningDateLocal = localDateForOffset(now, timezoneOffsetMinutes);
  if (row.planning_date_local !== planningDateLocal) return null;
  return {
    authoritative: true,
    planningDateLocal,
    timezoneOffsetMinutes,
    source: 'unexpired_current_candidate',
  };
}

async function planningClockForUser(userId, _options, now, dependencies = {}) {
  const queryAll = dependencies.dbAll || dbAll;
  const nativeEvents = await queryAll(
    `SELECT props, created_at
     FROM events
     WHERE user_id=? AND event_name='app_open'
     ORDER BY created_at DESC LIMIT 20`,
    [userId]
  );
  for (const row of nativeEvents) {
    const clock = clockFromNativeAppOpen(row, now);
    if (clock) return clock;
  }

  const candidates = await queryAll(
    `SELECT planning_date_local, timezone_offset_minutes, status, created_at, expires_at
     FROM plan_generation_candidates
     WHERE user_id=? AND status='preview' AND expires_at>?
     ORDER BY created_at DESC LIMIT 20`,
    [userId, new Date(now).toISOString()]
  );
  for (const row of candidates) {
    const clock = clockFromUnexpiredCandidate(row, now);
    if (clock) return clock;
  }

  return {
    authoritative: false,
    planningDateLocal: null,
    source: 'missing_timezone_authority',
    timezoneOffsetMinutes: null,
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
  const candidate = await plansRouter._test.previewPlanForUser(row.id, request, {
    store: false,
    goalBackwardDependencies: {
      mode: options.mode,
      cohortRefs: options.cohortRefs,
      telemetrySink: () => {},
    },
  });
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

async function verifyGoalBackwardArtifacts(userId, candidateId, expectedCandidateHash, dependencies = {}) {
  const queryAll = dependencies.dbAll || dbAll;
  const candidateRows = await queryAll(
    `SELECT * FROM plan_generation_candidates
     WHERE user_id=? AND id=?
     LIMIT 1`,
    [userId, candidateId],
  );
  const row = candidateRows[0];
  if (!row || row.status !== 'preview' || row.feature_mode !== 'on'
    || String(row.candidate_hash || '') !== String(expectedCandidateHash || '')) {
    throw rolloutError('RELEASE_ARTIFACT_VERIFICATION_FAILED');
  }
  let stored;
  try {
    stored = validateStoredGoalBackwardCandidateBindings(row, { allowedModes: ['on'] });
  } catch (_error) {
    throw rolloutError('RELEASE_ARTIFACT_VERIFICATION_FAILED');
  }
  if (!stored.present || stored.bindings.feature_mode !== 'on') {
    throw rolloutError('RELEASE_ARTIFACT_VERIFICATION_FAILED');
  }
  const artifactRows = await queryAll(
    `SELECT id, user_id, artifact_kind, decision_id, parent_artifact_id,
            plan_generation_candidate_id, schema_version, policy_version,
            revision, content_hash, payload_json, created_at
     FROM planning_pipeline_artifacts
     WHERE user_id=? AND decision_id=?
       AND (plan_generation_candidate_id IS NULL OR plan_generation_candidate_id=?)
     ORDER BY created_at ASC, id ASC
     LIMIT 32`,
    [userId, row.decision_id, candidateId],
  );
  let diagnostic;
  try {
    diagnostic = buildDecisionArtifactDiagnosticBundle({
      targetUserId: userId,
      decisionId: row.decision_id,
      artifactRows,
    });
  } catch (_error) {
    throw rolloutError('RELEASE_ARTIFACT_VERIFICATION_FAILED');
  }
  if (diagnostic.artifact_count !== ARTIFACT_KINDS.length
    || diagnostic.artifacts.map((artifact) => artifact.artifact_kind).join('|') !== ARTIFACT_KINDS.join('|')
    || diagnostic.artifacts.some((artifact) => String(artifact.schema_version) !== '1'
      || artifact.policy_version !== PLANNING_POLICY_VERSION
      || !Number.isSafeInteger(artifact.revision) || artifact.revision < 1)) {
    throw rolloutError('RELEASE_ARTIFACT_VERIFICATION_FAILED');
  }
  let applyEnvelope;
  try {
    applyEnvelope = buildGoalBackwardApplyEnvelope(row);
  } catch (_error) {
    throw rolloutError('RELEASE_ARTIFACT_VERIFICATION_FAILED');
  }
  return {
    applyEnvelope,
    evidence: {
      target_ref: targetRef(userId),
      artifact_count: diagnostic.artifact_count,
      candidate_revision: stored.bindings.candidate_revision,
      athlete_state_revision: stored.bindings.athlete_state_revision,
      surface_revision: stored.bindings.surface_revision,
      policy_version: PLANNING_POLICY_VERSION,
      verified: true,
    },
  };
}

async function restorePreviousAssignment({ userId, priorUserPlanId, appliedUserPlanId }, dependencies = {}) {
  const mutate = dependencies.withUserMutation || withUserMutation;
  const restored = await mutate(userId, async (tx) => {
    const lineage = await tx.get(
      `SELECT prior.status AS prior_status, applied.status AS applied_status,
              applied.supersedes_user_plan_id
       FROM user_plans prior
       JOIN user_plans applied ON applied.user_id=prior.user_id
       WHERE prior.user_id=? AND prior.id=? AND applied.id=?
       FOR UPDATE`,
      [userId, priorUserPlanId, appliedUserPlanId],
    );
    if (lineage?.prior_status !== 'superseded' || lineage?.applied_status !== 'active'
      || String(lineage.supersedes_user_plan_id || '') !== String(priorUserPlanId || '')) {
      throw rolloutError('ROLLBACK_LINEAGE_INVALID');
    }
    const superseded = await tx.run(
      `UPDATE user_plans SET status='superseded'
       WHERE user_id=? AND id=? AND status='active'`,
      [userId, appliedUserPlanId],
    );
    const activated = await tx.run(
      `UPDATE user_plans SET status='active'
       WHERE user_id=? AND id=? AND status='superseded'`,
      [userId, priorUserPlanId],
    );
    await tx.run(
      `UPDATE plan_generation_candidates SET status='superseded'
       WHERE user_id=? AND status='preview' AND feature_mode IN ('shadow','preview','on')`,
      [userId],
    );
    if (Number(superseded?.changes || 0) !== 1 || Number(activated?.changes || 0) !== 1) {
      throw rolloutError('ROLLBACK_RESTORE_FAILED');
    }
    const active = await tx.get(
      `SELECT COUNT(*) AS active_count, MAX(id) AS active_id
       FROM user_plans WHERE user_id=? AND status='active'`,
      [userId],
    );
    if (Number(active?.active_count) !== 1 || String(active?.active_id || '') !== String(priorUserPlanId || '')) {
      throw rolloutError('ROLLBACK_RESTORE_FAILED');
    }
    return true;
  });
  return {
    schema_version: 1,
    target_ref: targetRef(userId),
    restored: restored === true,
    active_assignment: 'previous',
    orphan_active_assignments: 0,
  };
}

function buildCleanupEvidence({
  userId,
  accountPresent,
  activeAssignmentCount,
  openV24CandidateCount,
  orphanAssignmentCount,
} = {}) {
  const evidence = {
    schema_version: 1,
    target_ref: targetRef(userId),
    account_removed: accountPresent === false,
    active_assignment_count: Math.max(0, Number(activeAssignmentCount || 0)),
    open_v24_candidate_count: Math.max(0, Number(openV24CandidateCount || 0)),
    orphan_assignment_count: Math.max(0, Number(orphanAssignmentCount || 0)),
  };
  evidence.cleanup_complete = evidence.account_removed
    && evidence.active_assignment_count === 0
    && evidence.open_v24_candidate_count === 0
    && evidence.orphan_assignment_count === 0;
  return evidence;
}

async function cleanupEvidenceForUser(userId, dependencies = {}) {
  const queryAll = dependencies.dbAll || dbAll;
  const [accountRows, activeRows, candidateRows, orphanRows] = await Promise.all([
    queryAll('SELECT COUNT(*) AS count FROM users WHERE id=?', [userId]),
    queryAll("SELECT COUNT(*) AS count FROM user_plans WHERE user_id=? AND status='active'", [userId]),
    queryAll("SELECT COUNT(*) AS count FROM plan_generation_candidates WHERE user_id=? AND status='preview' AND feature_mode IN ('shadow','preview','on')", [userId]),
    queryAll(`SELECT COUNT(*) AS count FROM user_plans child
      WHERE child.user_id=? AND child.status='active'
        AND child.supersedes_user_plan_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM user_plans prior WHERE prior.user_id=child.user_id AND prior.id=child.supersedes_user_plan_id)`, [userId]),
  ]);
  return buildCleanupEvidence({
    userId,
    accountPresent: Number(accountRows[0]?.count || 0) > 0,
    activeAssignmentCount: Number(activeRows[0]?.count || 0),
    openV24CandidateCount: Number(candidateRows[0]?.count || 0),
    orphanAssignmentCount: Number(orphanRows[0]?.count || 0),
  });
}

async function verifyApply(context, result, expectedCandidateHash) {
  const payload = result?.payload || {};
  const expectedEffectiveFrom = context.candidate.effectiveFrom || addDays(context.clock.planningDateLocal, 1);
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
    evidence: {
      effective_from: expectedEffectiveFrom,
      plan_version: Number(next.plan_version),
      target_ref: context.targetRef,
    },
    privateAssignment: {
      user_plan_id: payload.user_plan_id,
      training_plan_id: payload.plan_id,
    },
  };
}

function readPrivateRollbackManifest(filename) {
  const stats = fs.statSync(filename);
  if (!stats.isFile() || (stats.mode & 0o077) !== 0) throw rolloutError('ROLLBACK_LINEAGE_INVALID');
  const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (parsed?.schema_version !== 2 || !Array.isArray(parsed.entries)) {
    throw rolloutError('ROLLBACK_LINEAGE_INVALID');
  }
  return parsed;
}

async function rollbackFromManifest(options) {
  const manifest = readPrivateRollbackManifest(options.rollbackManifest);
  const evidence = [];
  for (const userId of options.userIds) {
    const entry = manifest.entries.find((candidate) => candidate.target_ref === targetRef(userId));
    if (!entry?.prior_assignment?.user_plan_id || !entry?.applied_assignment?.user_plan_id) {
      throw rolloutError('ROLLBACK_LINEAGE_INVALID');
    }
    evidence.push(await restorePreviousAssignment({
      userId,
      priorUserPlanId: entry.prior_assignment.user_plan_id,
      appliedUserPlanId: entry.applied_assignment.user_plan_id,
    }));
  }
  const rollbackJournal = {
    schema_version: 1,
    source_manifest_hash: `sha256:${require('node:crypto').createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`,
    restored: evidence,
  };
  const directory = path.dirname(options.rollbackManifest);
  const resultFile = writePrivateJson(directory, 'rollback-result', rollbackJournal);
  return { evidence, resultFile };
}

async function run() {
  const options = parseArgs(process.argv.slice(2));
  options.mode = getGoalBackwardV24Mode();
  options.cohortRefs = options.mode === 'off' && !options.rollback
    ? []
    : parseGoalBackwardCohortRefs();
  assertGoalBackwardApplyAuthorized({
    apply: options.apply,
    rollback: options.rollback,
    confirmation: options.confirmation,
    mode: options.mode,
  });
  if (!options.apply && !options.rollback && options.mode === 'off') {
    console.log(JSON.stringify({
      apply_requested: false,
      cohort_count: 0,
      failures: 0,
      mode: 'dry_run',
      previewed: 0,
      skipped: 0,
      writes: 0,
    }));
    return;
  }
  if (options.userIds.length === 0) {
    throw new Error('A non-off release rehearsal requires at least one explicit --user-id');
  }
  assertDisposableUserIds(options.userIds, options.cohortRefs);
  if (options.rollback) {
    const rollback = await rollbackFromManifest(options);
    const cleanup = await Promise.all(options.userIds.map((userId) => cleanupEvidenceForUser(userId)));
    const cleanupFile = writePrivateJson(path.dirname(options.rollbackManifest), 'cleanup-evidence', {
      schema_version: 1,
      records: cleanup,
    });
    console.log(JSON.stringify({
      cleanup_file: cleanupFile,
      mode: 'rollback_restored',
      records: rollback.evidence.length,
      result_file: rollback.resultFile,
    }));
    return;
  }
  const releaseIdentity = options.apply ? deployedArtifactIdentityFromEnvironment() : null;
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
        if (options.apply && context.skipReason !== 'already_current') {
          const applySkipCodes = {
            missing_timezone_authority: 'MISSING_TIMEZONE_AUTHORITY',
            missing_race_authority: 'MISSING_RACE_AUTHORITY',
            missing_schedule_authority: 'MISSING_SCHEDULE_AUTHORITY',
            feasibility_stretch: 'CANDIDATE_FEASIBILITY_REVIEW_REQUIRED',
            feasibility_unsafe: 'CANDIDATE_FEASIBILITY_REVIEW_REQUIRED',
            feasibility_unavailable: 'CANDIDATE_FEASIBILITY_REVIEW_REQUIRED',
          };
          throw rolloutError(applySkipCodes[context.skipReason] || 'ROLLOUT_PREFLIGHT_FAILED');
        }
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
    releaseIdentity,
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
      const artifactVerification = await verifyGoalBackwardArtifacts(
        context.userId,
        stored.id,
        stored.candidateHash,
      );
      assertPlanningDateStable(context, new Date());
      const result = await plansRouter._test.applyPlanCandidate(context.userId, stored.id, {
        ...artifactVerification.applyEnvelope,
        candidate_hash: stored.candidateHash,
        choice: 'train_for_target',
        planning_date_local: context.clock.planningDateLocal,
      }, {
        goalBackwardDependencies: {
          mode: options.mode,
          cohortRefs: options.cohortRefs,
        },
      });
      const verified = await verifyApply(context, result, stored.candidateHash);
      applied.push({ ...verified.evidence, artifact_verification: artifactVerification.evidence });
      const manifestEntry = manifest.entries.find((entry) => entry.target_ref === context.targetRef);
      manifestEntry.applied_assignment = verified.privateAssignment;
      manifestEntry.apply_evidence = verified.evidence;
      manifestEntry.artifact_verification = artifactVerification.evidence;
      replacePrivateJson(backupFile, manifest);
      console.log(JSON.stringify({ mode: 'applied', ...verified.evidence }));
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
  const cleanup = await Promise.all(contexts.map((context) => cleanupEvidenceForUser(context.userId)));
  const cleanupFile = writePrivateJson(options.backupDir, 'cleanup-evidence', {
    schema_version: 1,
    records: cleanup,
  });
  console.log(JSON.stringify({
    ...summary,
    applied: applied.length,
    apply_failures: applyFailures.length,
    cleanup_file: cleanupFile,
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
  assertDeployedArtifactIdentity,
  assertDisposableUserIds,
  assertExternalBackupDirectory,
  assertGoalBackwardApplyAuthorized,
  assertPlanningDateStable,
  assertSupportedCandidate,
  buildCleanupEvidence,
  cleanupEvidenceForUser,
  clockFromNativeAppOpen,
  clockFromUnexpiredCandidate,
  eligibleTesterRows,
  parseArgs,
  planningClockForUser,
  preflightUser,
  replacePrivateJson,
  restorePreviousAssignment,
  rollbackFromManifest,
  run,
  safeFailure,
  verifyApply,
  verifyGoalBackwardArtifacts,
  writePrivateJson,
};
