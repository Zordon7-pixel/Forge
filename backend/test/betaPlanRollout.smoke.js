const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
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
  assert.deepEqual(
    selectProtectedRaces(races, activePlan, '2026-08-08').map((race) => race.id),
    ['race-a1', 'race-a2'],
    'existing protected race goals take precedence over an unrelated earlier race',
  );

  const target = preservedPlanTarget(activePlan, {
    run_days_per_week: 2,
    lift_days_per_week: 1,
    preferred_workout_days: '[2,4]',
  });
  assert.deepEqual(target.trainingDays, ['Mon', 'Wed', 'Fri', 'Sat'], 'active plan weekdays take precedence over stale profile weekdays');
  assert.equal(target.runDaysPerWeek, 4);
  assert.equal(target.planMode, 'hybrid_maintain');
  assert.equal(target.liftingEnabled, true);
  assert.equal(target.liftDaysPerWeek, 2);
  assert.deepEqual(target.equipment, ['dumbbells']);
  assert.equal(isCurrentRolloutPlan({
    ...activePlan,
    engineVersion: RACE_PLAN_POLICY_V1.engineVersion,
    policyVersion: RACE_PLAN_POLICY_V1.version,
  }, ['race-a2', 'race-a1']), true);
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
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  const scriptSource = fs.readFileSync(path.join(__dirname, '../scripts/upgrade-beta-race-plans.js'), 'utf8');
  assert.match(scriptSource, /u\.onboarded=1/);
  assert.match(scriptSource, /up\.user_id=u\.id AND up\.status='active'/);
  assert.doesNotMatch(scriptSource, /OR EXISTS \(SELECT 1 FROM training_plans tp WHERE tp\.user_id=u\.id\)/);
  assert.match(scriptSource, /race\.user_id=u\.id AND race\.status='upcoming'/);
  assert.match(scriptSource, /WHERE user_id=\? AND status='upcoming' AND race_date>=\?/);
  assert.match(scriptSource, /previewPlanForUser\(row\.id, request, \{ store: false \}\)/);
  assert.match(scriptSource, /writePrivateJson\(options\.backupDir, 'pre-apply'/);
  assert.match(scriptSource, /previewPlanForUser\(context\.userId, context\.request, \{ store: true \}\)/);
  assert.match(scriptSource, /applyPlanCandidate\(context\.userId, stored\.id/);
  assert.ok(
    scriptSource.indexOf("writePrivateJson(options.backupDir, 'pre-apply'")
      < scriptSource.indexOf('previewPlanForUser(context.userId, context.request, { store: true })'),
    'redacted rollback manifest must be durable before the first write',
  );
  assert.doesNotMatch(scriptSource, /(?:UPDATE|DELETE)\s+(?:users|user_plans|training_plans|race_events)/i);

  console.log('BETA PLAN ROLLOUT SMOKE OK (35)');
}

run();
