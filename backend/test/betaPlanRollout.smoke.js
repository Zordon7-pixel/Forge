const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  authoritativePlanTarget,
  assertApplyAuthorized,
  assertRedactedBackup,
  buildBackupManifest,
  isCurrentRolloutPlan,
  localDateForOffset,
  preservedPlanTarget,
  redactedBackupEntry,
  selectProtectedRaces,
  targetRef,
} = require('../src/lib/betaPlanRollout');
const { RACE_PLAN_POLICY_V1 } = require('../src/lib/racePlanPolicy');
const { resolveRunSchedule } = require('../src/lib/runSchedule');
const rolloutScript = require('../scripts/upgrade-beta-race-plans');

function run() {
  const races = [
    { id: 'race-early', race_date: '2026-09-01', status: 'upcoming' },
    { id: 'race-a1', race_date: '2026-09-20', status: 'upcoming' },
    { id: 'race-a2', race_date: '2026-10-11', status: 'upcoming' },
    { id: 'race-past', race_date: '2026-07-01', status: 'upcoming' },
  ];
  const activePlan = {
    planMode: 'hybrid_maintain',
    goals: [{ raceId: 'race-a1' }, { raceId: 'race-a2' }],
    schedulePreferences: { trainingDays: [1, 3, 5, 6], runDaysPerWeek: 4 },
    strengthPolicy: { enabled: true, sessionsPerWeek: 2, goal: 'maintain', equipment: ['dumbbells'] },
  };
  const currentProfile = {
    run_days_per_week: 5,
    lift_days_per_week: 2,
    preferred_workout_days: JSON.stringify(['Mon', 'Tue', 'Wed', 'Thu', 'Sat']),
  };
  assert.deepEqual(
    selectProtectedRaces(races, activePlan, '2026-08-08').map((race) => race.id),
    ['race-a1', 'race-a2'],
    'existing protected race goals take precedence over an unrelated earlier race',
  );
  assert.deepEqual(
    selectProtectedRaces(races, { goals: [{ raceId: 'race-a2' }] }, '2026-08-08').map((race) => race.id),
    ['race-a2'],
    'a one-race plan stays a one-race plan during rollout',
  );
  assert.deepEqual(selectProtectedRaces(races, {}, '2026-08-08'), [], 'rollout never guesses a race for an unanchored plan');
  assert.deepEqual(
    selectProtectedRaces(races, { goals: [{ raceId: 'missing-race' }] }, '2026-08-08'),
    [],
    'rollout refuses a plan whose protected race no longer belongs to the account',
  );

  const target = preservedPlanTarget(activePlan, currentProfile);
  assert.equal(Object.hasOwn(target, 'trainingDays'), false, 'rollout never sends stale plan weekdays as an explicit target');
  assert.equal(Object.hasOwn(target, 'runDaysPerWeek'), false, 'rollout never sends stale plan frequency as an explicit target');
  assert.equal(target.planMode, 'hybrid_maintain');
  assert.equal(target.liftingEnabled, true);
  assert.equal(target.liftDaysPerWeek, 2);
  assert.deepEqual(target.equipment, ['dumbbells']);
  assert.deepEqual(resolveRunSchedule(currentProfile, target, { requireCompleteSelection: true }), {
    valid: true,
    runDaysPerWeek: 5,
    trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Sat'],
    runDaysSource: 'profile',
    trainingDaysSource: 'profile',
    explicitSelection: false,
    legacyAdjusted: false,
  }, 'candidate generation reads the current profile without creating an apply-time profile write');
  assert.equal(authoritativePlanTarget(activePlan, { ...currentProfile, preferred_workout_days: null }).valid, false);
  assert.equal(authoritativePlanTarget({ ...activePlan, planMode: '' }, currentProfile).valid, false);
  assert.equal(authoritativePlanTarget({ ...activePlan, strengthPolicy: { enabled: false } }, currentProfile).valid, false);
  assert.equal(
    authoritativePlanTarget({
      ...activePlan,
      strengthPolicy: { enabled: true, sessionsPerWeek: 2, goal: 'maintain' },
    }, currentProfile).valid,
    false,
    'lifting rollout requires an authoritative equipment selection',
  );
  assert.deepEqual(
    preservedPlanTarget({
      ...activePlan,
      planMode: 'run_only',
      strengthPolicy: {},
    }, currentProfile).equipment,
    [],
    'run-only rollout does not require strength equipment',
  );
  assert.equal(isCurrentRolloutPlan({
    ...activePlan,
    engineVersion: RACE_PLAN_POLICY_V1.engineVersion,
    invariantVersion: RACE_PLAN_POLICY_V1.invariantVersion,
    policyVersion: RACE_PLAN_POLICY_V1.version,
  }, ['race-a2', 'race-a1']), true);
  assert.equal(isCurrentRolloutPlan({
    ...activePlan,
    engineVersion: RACE_PLAN_POLICY_V1.engineVersion,
    policyVersion: RACE_PLAN_POLICY_V1.version,
  }, ['race-a2', 'race-a1']), false, 'rollout invariant version is part of current-plan identity');
  assert.equal(isCurrentRolloutPlan(activePlan, ['race-a1', 'race-a2']), false);

  assert.equal(localDateForOffset('2026-08-08T02:00:00.000Z', 240), '2026-08-07');
  assert.equal(localDateForOffset('2026-08-08T02:00:00.000Z', -600), '2026-08-08');
  assert.throws(() => localDateForOffset(new Date(), 900), /between -840 and 840/);

  assert.doesNotThrow(() => assertApplyAuthorized({ apply: false }));
  assert.throws(
    () => assertApplyAuthorized({ apply: true, confirmation: RACE_PLAN_POLICY_V1.rollout.betaApplyConfirmation, betaAccessEnabled: false }),
    /FORGE_BETA_ACCESS/,
  );
  assert.throws(
    () => assertApplyAuthorized({ apply: true, confirmation: 'WRONG', betaAccessEnabled: true }),
    /Apply requires/,
  );
  assert.doesNotThrow(() => assertApplyAuthorized({
    apply: true,
    confirmation: RACE_PLAN_POLICY_V1.rollout.betaApplyConfirmation,
    betaAccessEnabled: true,
  }));

  assert.equal(rolloutScript.parseArgs([]).apply, false, 'rollout defaults to a no-write dry run');
  assert.throws(() => rolloutScript.parseArgs(['--apply']), /--backup-dir is required/);
  assert.throws(() => rolloutScript.parseArgs([
    '--apply',
    `--backup-dir=${path.resolve(__dirname, '../rollout-backup')}`,
  ]), /outside the repository checkout/);
  const parsed = rolloutScript.parseArgs([
    '--apply',
    '--backup-dir=/tmp/forged-rollout-test',
    `--confirm=${RACE_PLAN_POLICY_V1.rollout.betaApplyConfirmation}`,
    '--planning-date=2026-08-08',
    '--timezone-offset-minutes=240',
    '--user-id=user-1',
    '--user-id=user-1',
  ]);
  assert.equal(parsed.apply, true);
  assert.deepEqual(parsed.userIds, ['user-1']);
  assert.equal(parsed.planningDateLocal, '2026-08-08');
  assert.equal(parsed.timezoneOffsetExplicit, true);
  assert.throws(
    () => rolloutScript.parseArgs(['--planning-date=2026-08-08']),
    /requires an explicit --timezone-offset-minutes/,
  );
  assert.equal(rolloutScript.parseArgs([]).timezoneOffsetExplicit, false);

  const rawUserId = 'private-beta-user-id';
  const entry = redactedBackupEntry({
    userId: rawUserId,
    active: { row: { user_plan_id: 'up-old', id: 'tp-old', plan_version: 3, lineage_id: 'lineage-1', effective_from: '2026-07-01' } },
    activePlan: { weeks: [{ health: 'forbidden' }] },
    candidate: { candidateHash: 'sha256:candidate' },
    raceIds: ['race-a1', 'race-a2'],
    planningDateLocal: '2026-08-08',
  });
  const manifest = buildBackupManifest({ entries: [entry], createdAt: '2026-08-08T12:00:00Z' });
  const serialized = JSON.stringify(manifest);
  assert.equal(serialized.includes(rawUserId), false);
  assert.equal(serialized.includes('forbidden'), false);
  assert.match(entry.target_ref, /^sha256:/);
  assert.equal(entry.candidate.expected_effective_from, '2026-08-09');
  assert.throws(() => assertRedactedBackup({ phone_number: '555-0100' }), /Forbidden backup field/);
  assert.equal(targetRef(rawUserId), entry.target_ref);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'forged-rollout-smoke-'));
  try {
    const filename = rolloutScript.writePrivateJson(temp, 'manifest', manifest);
    assert.equal(fs.statSync(temp).mode & 0o777, 0o700);
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    rolloutScript.replacePrivateJson(filename, { schema_version: 1, status: 'updated' });
    assert.deepEqual(JSON.parse(fs.readFileSync(filename, 'utf8')), { schema_version: 1, status: 'updated' });
    assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  assert.equal(
    rolloutScript.assertPlanningDateStable({ clock: { planningDateLocal: '2026-08-08', timezoneOffsetMinutes: 0 } }, new Date('2026-08-08T12:00:00Z')),
    '2026-08-08',
  );
  assert.throws(
    () => rolloutScript.assertPlanningDateStable({ clock: { planningDateLocal: '2026-08-08', timezoneOffsetMinutes: 0 } }, new Date('2026-08-09T00:00:01Z')),
    /PLANNING_DATE_CHANGED/,
  );
  assert.doesNotThrow(() => rolloutScript.assertSupportedCandidate({ plan: { overall_feasibility: 'supported' } }));
  assert.throws(() => rolloutScript.assertSupportedCandidate({ plan: { overall_feasibility: 'stretch' } }), /CANDIDATE_FEASIBILITY_REVIEW_REQUIRED/);
  assert.throws(() => rolloutScript.assertSupportedCandidate({ plan: { overall_feasibility: 'unsafe' } }), /CANDIDATE_FEASIBILITY_REVIEW_REQUIRED/);
  assert.deepEqual(
    rolloutScript.safeFailure('sha256:test', new Error('private database detail'), 'ROLLOUT_APPLY_FAILED'),
    { target_ref: 'sha256:test', code: 'ROLLOUT_APPLY_FAILED' },
    'unknown errors are reduced to a safe operational code',
  );

  const scriptSource = fs.readFileSync(path.join(__dirname, '../scripts/upgrade-beta-race-plans.js'), 'utf8');
  assert.match(scriptSource, /u\.onboarded=1/);
  assert.match(scriptSource, /up\.user_id=u\.id AND up\.status='active'/);
  assert.doesNotMatch(scriptSource, /OR EXISTS \(SELECT 1 FROM training_plans tp WHERE tp\.user_id=u\.id\)/);
  assert.match(scriptSource, /race\.user_id=u\.id AND race\.status='upcoming'/);
  assert.match(scriptSource, /WHERE user_id=\? AND status='upcoming' AND race_date>=\?/);
  assert.match(scriptSource, /skipReason: 'missing_timezone_authority'/);
  assert.match(scriptSource, /previewPlanForUser\(row\.id, request, \{ store: false \}\)/);
  assert.match(scriptSource, /writePrivateJson\(options\.backupDir, 'pre-apply'/);
  assert.match(scriptSource, /previewPlanForUser\(context\.userId, context\.request, \{ store: true \}\)/);
  assert.match(scriptSource, /applyPlanCandidate\(context\.userId, stored\.id/);
  assert.match(scriptSource, /stored\.candidateHash !== context\.candidate\.candidateHash/);
  assert.match(scriptSource, /throw rolloutError\('CANDIDATE_HASH_DRIFT'\)/);
  assert.match(scriptSource, /assertSupportedCandidate\(stored\)/);
  assert.match(scriptSource, /unmatchedUserIds[\s\S]*EXPLICIT_TARGET_NOT_ELIGIBLE/);
  assert.doesNotMatch(scriptSource, /err\.message|error:\s*err/);
  assert.ok(
    scriptSource.indexOf("writePrivateJson(options.backupDir, 'pre-apply'")
      < scriptSource.indexOf('previewPlanForUser(context.userId, context.request, { store: true })'),
    'redacted rollback manifest must be durable before the first write',
  );
  assert.ok(
    scriptSource.indexOf("writePrivateJson(options.backupDir, 'apply-result'")
      < scriptSource.indexOf('for (const context of contexts)'),
    'the durable result journal exists before the first account write',
  );
  assert.match(scriptSource, /finally \{[\s\S]*replacePrivateJson\(resultFile, resultJournal\)/);
  assert.doesNotMatch(scriptSource, /(?:UPDATE|DELETE)\s+(?:users|user_plans|training_plans|race_events)/i);
  assert.doesNotMatch(
    String(rolloutScript.verifyApply),
    /assertPlanningDateStable/,
    'post-commit verification does not mislabel a successful apply when midnight follows the transaction'
  );

  console.log('BETA PLAN ROLLOUT SMOKE OK');
}

run();
