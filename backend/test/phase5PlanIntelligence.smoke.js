// Phase 5 deterministic workout taxonomy, evidence, and acceptance matrix.
// Run: node backend/test/phase5PlanIntelligence.smoke.js

const assert = require('node:assert/strict');
const concurrent = require('../src/lib/concurrentPlan');
const taxonomy = require('../src/lib/runWorkoutTaxonomy');
const evidence = require('../src/lib/trainingEvidence');

function sessions(plan) {
  return (plan.weeks || []).flatMap((week) => (week.days || []).flatMap((day) => (
    (day.sessions || []).map((session) => ({ week, day, session }))
  )));
}

function context(overrides = {}) {
  const distanceMiles = Number(overrides.distanceMiles || 13.109);
  const planMode = overrides.planMode || 'hybrid_maintain';
  const baseline = Number(overrides.baseline || (distanceMiles >= 26 ? 22 : 18));
  const meaningfulRunCount = Number(overrides.meaningfulRunCount ?? 20);
  const goalType = overrides.goalType || 'pr';
  const goalTimeSeconds = goalType === 'pr' ? Math.round(distanceMiles * 540) : null;
  return {
    todayISO: overrides.todayISO || '2026-08-03',
    profile: {
      weekly_miles_current: baseline,
      run_days_per_week: overrides.runDaysPerWeek || 4,
      lift_days_per_week: planMode === 'run_only' ? 0 : 2,
      ...(overrides.profile || {}),
    },
    target: {
      weeks: overrides.weeks || 12,
      startDate: overrides.startDate || '2026-08-03',
      raceDate: overrides.raceDate || '2026-10-25',
      raceName: overrides.raceName || 'Acceptance Race',
      distanceMiles,
      goalType,
      ...(goalTimeSeconds ? { goalTimeSeconds } : {}),
      planMode,
      trainingDays: overrides.trainingDays || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
      runDaysPerWeek: overrides.runDaysPerWeek || 4,
      liftDaysPerWeek: planMode === 'run_only' ? 0 : 2,
      ...(overrides.raceTargets ? { raceTargets: overrides.raceTargets } : {}),
    },
    history: {
      weeklyMileageBaseline: baseline,
      recentRunCount: meaningfulRunCount,
      recentLiftCount: planMode === 'run_only' ? 0 : 8,
      mileageBaseline: { meaningfulRunCount },
      ...(overrides.anchored === false ? {} : {
        performanceProfile: {
          targetAnchor: {
            equivalentTimeSeconds: Math.round(distanceMiles * 540),
            date: '2026-07-20',
            kind: 'race',
          },
        },
      }),
      acuteRunLoad: overrides.acuteRunLoad || { available: false, protection: { active: false } },
    },
    recovery: overrides.recovery || { state: 'normal', available: true, metrics: {} },
    ...(overrides.safety ? { safety: overrides.safety } : {}),
  };
}

console.log('\n== canonical workout catalog ==');
const workoutIds = Object.keys(taxonomy.WORKOUTS);
assert.equal(workoutIds.length, new Set(workoutIds).size);
for (const id of workoutIds) {
  assert.equal(taxonomy.WORKOUTS[id].id, id, `${id} keeps a stable persisted ID`);
}
for (const id of workoutIds.filter((candidate) => taxonomy.WORKOUTS[candidate].quality && !['race', 'benchmark_mile'].includes(candidate))) {
  const prescription = taxonomy.prescriptionFor(id, { phase: 'build', weekNumber: 5, weekCount: 12, goalPaceLabel: '9:00/mi' });
  assert.ok(prescription, `${id} has a deterministic prescription`);
  assert.ok(prescription.warmup.length && prescription.steps.length && prescription.cooldown.length, `${id} includes warm-up, work, and cooldown`);
  assert.ok(prescription.quality_prescription.repetitions > 0, `${id} has repetitions`);
  assert.ok(prescription.quality_prescription.work, `${id} has work duration or distance`);
  assert.ok(prescription.quality_prescription.recovery.type && prescription.quality_prescription.recovery.duration, `${id} has recovery detail`);
  assert.ok(prescription.quality_prescription.target && prescription.purpose, `${id} has target and purpose`);
}

console.log('\n== verified evidence registry ==');
const registry = evidence.validateRegistry();
assert.equal(registry.valid, true, registry.errors.join('; '));
for (const source of Object.values(evidence.SOURCES)) {
  assert.equal(source.executable, false);
  assert.equal(source.productionRuleApproved, false);
  assert.equal(source.qualifiedReviewer, null);
  assert.equal(Object.isFrozen(source), true);
  assert.equal(Object.isFrozen(source.dosageBounds), true);
  assert.equal(Object.isFrozen(source.contraindications), true);
}
for (const id of workoutIds) {
  for (const ref of evidence.runEvidenceRefs(id)) assert.ok(evidence.SOURCES[ref], `${id} resolves evidence ${ref}`);
}

console.log('\n== PR plan quality progression ==');
const prContext = context();
const prPlan = concurrent.buildConcurrentPlan(prContext);
const prValidation = concurrent.validateConcurrentPlan(prPlan, prContext);
assert.equal(prValidation.valid, true, prValidation.errors.join('; '));
const prRuns = sessions(prPlan).filter(({ session }) => session.kind === 'run');
const prWorkoutIds = new Set(prRuns.map(({ session }) => session.workout_id));
assert.ok([...prWorkoutIds].some((id) => taxonomy.WORKOUTS[id]?.family === 'hills'), 'PR plan includes hill development');
assert.ok([...prWorkoutIds].some((id) => ['speed', 'intervals'].includes(taxonomy.WORKOUTS[id]?.family)), 'PR plan includes speed or interval development');
assert.ok(prWorkoutIds.has('tempo_threshold'), 'PR plan includes threshold development');
assert.ok(prWorkoutIds.has('race_pace_intervals'), 'PR plan includes race-pace work');
assert.ok(prWorkoutIds.has('sharpening_strides'), 'PR plan includes taper sharpening');
assert.ok(prRuns.filter(({ session }) => taxonomy.isQualityWorkout(session.workout_id) && session.workout_id !== 'race').every(({ session }) => (
  session.quality_prescription?.repetitions > 0
  && session.quality_prescription?.work
  && session.quality_prescription?.recovery?.duration
  && session.quality_prescription?.target
  && session.purpose
)), 'every planned quality run is fully actionable');
for (const { week, session } of prRuns.filter(({ session }) => session.workout_id === 'race_pace_intervals')) {
  const workMinutes = Number.parseInt(session.quality_prescription.work, 10);
  const minimumDuration = Math.ceil(15 + (4 * 20 / 60) + (3 * workMinutes) + (2 * 3) + 10);
  assert.ok(session.duration_min >= minimumDuration, `week ${week.week} race-pace duration covers the full prescription`);
}

const mismatchedPlan = JSON.parse(JSON.stringify(prPlan));
const mismatchedThreshold = sessions(mismatchedPlan).find(({ session }) => session.workout_id === 'tempo_threshold').session;
mismatchedThreshold.target_zone = 'Zone 2';
mismatchedThreshold.pace_target = 'Easy conversational running';
const mismatchValidation = concurrent.validateConcurrentPlan(mismatchedPlan, prContext);
assert.equal(mismatchValidation.valid, false);
assert.ok(mismatchValidation.errors.some((error) => error.includes('canonical tempo_threshold prescription')));

console.log('\n== race, goal, and mode matrix ==');
for (const distanceMiles of [3.1, 6.2, 10, 13.109, 26.2]) {
  for (const planMode of ['run_only', 'hybrid_maintain']) {
    for (const goalType of ['completion', 'pr']) {
      const matrixContext = context({ distanceMiles, planMode, goalType });
      const matrixPlan = concurrent.buildConcurrentPlan(matrixContext);
      const matrixValidation = concurrent.validateConcurrentPlan(matrixPlan, matrixContext);
      assert.equal(matrixValidation.valid, true, `${distanceMiles}/${planMode}/${goalType}: ${matrixValidation.errors.join('; ')}`);
      assert.ok(sessions(matrixPlan).some(({ session }) => session.workout_id === 'race' && Number(session.distance_miles) === distanceMiles));
      if (goalType === 'pr') {
        const trainingIds = new Set(sessions(matrixPlan).map(({ session }) => session.workout_id));
        assert.ok([...trainingIds].some((id) => taxonomy.isQualityWorkout(id) && id !== 'race'), `${distanceMiles} PR plan has quality work`);
      }
      if (planMode === 'run_only') assert.equal(sessions(matrixPlan).some(({ session }) => session.kind === 'lift'), false);
    }
  }
}

console.log('\n== conservative comeback and recovery safety ==');
const comebackContext = context({ baseline: 4, meaningfulRunCount: 2, planMode: 'run_only', runDaysPerWeek: 3, anchored: false });
const comebackPlan = concurrent.buildConcurrentPlan(comebackContext);
const comebackValidation = concurrent.validateConcurrentPlan(comebackPlan, comebackContext);
assert.equal(comebackValidation.valid, true, comebackValidation.errors.join('; '));
const comebackQuality = sessions(comebackPlan).filter(({ session }) => taxonomy.isQualityWorkout(session.workout_id) && !['race', 'sharpening_strides', 'benchmark_mile'].includes(session.workout_id));
assert.ok(comebackQuality.length > 0);
assert.ok(comebackQuality.every(({ session }) => session.workout_id === 'strides'), 'comeback plan uses strides instead of oversized intervals');

const establishedComebackContext = context({
  profile: { comeback_mode: 1, injury_notes: 'Active calf tightness' },
  safety: { activeInjury: true, comebackMode: true, injuryNotesPresent: true },
  recovery: { state: 'low', available: true, metrics: {} },
});
const establishedComebackPlan = concurrent.buildConcurrentPlan(establishedComebackContext);
const establishedComebackValidation = concurrent.validateConcurrentPlan(establishedComebackPlan, establishedComebackContext);
assert.equal(establishedComebackValidation.valid, true, establishedComebackValidation.errors.join('; '));
const establishedQuality = sessions(establishedComebackPlan)
  .filter(({ session }) => taxonomy.isQualityWorkout(session.workout_id) && session.workout_id !== 'race');
assert.ok(establishedQuality.length > 0);
assert.ok(establishedQuality.every(({ session }) => session.workout_id === 'strides'), 'active injury/comeback blocks hills, intervals, threshold, progression, and race-pace work');
assert.equal(sessions(establishedComebackPlan).some(({ session }) => session.workout_id === 'benchmark_mile'), false);

const transientLowContext = context({
  recovery: { state: 'low', available: true, metrics: {} },
  acuteRunLoad: {
    available: true,
    protection: { active: false },
    currentWeek: { startDate: '2026-08-03', runCount: 0, runDates: [], miles: 0, longRunCompleted: false },
  },
});
const transientLowPlan = concurrent.buildConcurrentPlan(transientLowContext);
const transientLowValidation = concurrent.validateConcurrentPlan(transientLowPlan, transientLowContext);
assert.equal(transientLowValidation.valid, true, transientLowValidation.errors.join('; '));
const transientCurrentQuality = sessions({ weeks: [transientLowPlan.weeks[0]] })
  .filter(({ session }) => taxonomy.isQualityWorkout(session.workout_id) && session.workout_id !== 'race');
assert.ok(transientCurrentQuality.every(({ session }) => session.workout_id === 'strides'), 'low recovery protects only the actionable current week');
assert.ok(sessions({ weeks: transientLowPlan.weeks.slice(1) }).some(({ session }) => (
  taxonomy.isQualityWorkout(session.workout_id) && !['race', 'strides'].includes(session.workout_id)
)), 'future quality progression remains after a transient low-recovery day');

const protectedContext = context({
  acuteRunLoad: {
    available: true,
    latestRun: { date: '2026-08-02', distanceMiles: 8, durationMinutes: 88, isLong: true, isHard: false },
    protectiveRun: { date: '2026-08-02', distanceMiles: 8, durationMinutes: 88, isLong: true, isHard: false },
    protection: { active: true, anchorDate: '2026-08-02', hardRunsThrough: '2026-08-04', lowerBodyThrough: '2026-08-04' },
  },
});
const protectedPlan = concurrent.buildConcurrentPlan(protectedContext);
const protectedValidation = concurrent.validateConcurrentPlan(protectedPlan, protectedContext);
assert.equal(protectedValidation.valid, true, protectedValidation.errors.join('; '));
assert.ok(sessions(protectedPlan).some(({ day, session }) => day.date <= '2026-08-04' && session.workout_id === 'recovery_run'));
assert.ok(protectedPlan.weeks[0].days.some((day) => day.whyToday && /Adjusted after your 8 mi run/.test(day.whyToday)));

console.log('\n== Aug 6 current-week dual-race regression ==');
const races = [
  { raceId: 'yonkers-half-2026', raceName: 'Yonkers Half Marathon', raceDate: '2026-09-20', distanceMiles: 13.109, goalType: 'pr', goalTimeSeconds: 7200 },
  { raceId: 'army-ten-miler-2026', raceName: 'Army 10-Miler', raceDate: '2026-10-11', distanceMiles: 10, goalType: 'pr', goalTimeSeconds: 5220 },
];
const window = concurrent.racePlanWindow('2026-10-11', '2026-08-06');
assert.equal(window.startDate, '2026-08-03');
assert.equal(window.weeks, 10);
const currentWeekContext = context({
  todayISO: '2026-08-06',
  startDate: window.startDate,
  weeks: window.weeks,
  raceDate: races[1].raceDate,
  raceName: races[1].raceName,
  distanceMiles: races[1].distanceMiles,
  runDaysPerWeek: 3,
  trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  raceTargets: races,
  acuteRunLoad: {
    available: true,
    protection: { active: false },
    currentWeek: { startDate: '2026-08-03', runCount: 0, runDates: [], miles: 0, longRunCompleted: false },
  },
});
const currentWeekPlan = concurrent.buildConcurrentPlan(currentWeekContext);
const currentWeekValidation = concurrent.validateConcurrentPlan(currentWeekPlan, currentWeekContext);
assert.equal(currentWeekValidation.valid, true, currentWeekValidation.errors.join('; '));
assert.equal(currentWeekPlan.weeks[0].startDate, '2026-08-03');
assert.equal(currentWeekPlan.weeks[0].days.filter((day) => day.date < '2026-08-06').every((day) => day.sessions.length === 0), true);
assert.deepEqual(
  currentWeekPlan.weeks[0].days.filter((day) => day.sessions.some((session) => session.kind === 'run')).map((day) => day.date),
  ['2026-08-06', '2026-08-07', '2026-08-08']
);
assert.deepEqual(currentWeekPlan.goals.map((goal) => goal.raceId), races.map((race) => race.raceId));

console.log('\n== late-week hybrid strength-floor regression ==');
for (const lateWeekFixture of [
  { todayISO: '2026-08-07', trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], expectedLifts: 1 },
  { todayISO: '2026-08-09', trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], expectedLifts: 1 },
]) {
  const lateWeekContext = context({
    todayISO: lateWeekFixture.todayISO,
    startDate: '2026-08-03',
    runDaysPerWeek: 3,
    trainingDays: lateWeekFixture.trainingDays,
    acuteRunLoad: {
      available: true,
      protection: { active: false },
      currentWeek: { startDate: '2026-08-03', runCount: 0, runDates: [], miles: 0, longRunCompleted: false },
    },
  });
  const lateWeekPlan = concurrent.buildConcurrentPlan(lateWeekContext);
  const lateWeekValidation = concurrent.validateConcurrentPlan(lateWeekPlan, lateWeekContext);
  assert.equal(lateWeekValidation.valid, true, `${lateWeekFixture.todayISO}: ${lateWeekValidation.errors.join('; ')}`);
  const currentWeekLifts = sessions({ weeks: [lateWeekPlan.weeks[0]] })
    .filter(({ session }) => session.kind === 'lift');
  assert.equal(currentWeekLifts.length, lateWeekFixture.expectedLifts);
  assert.equal(lateWeekPlan.weeks[0].days
    .filter((day) => day.date < lateWeekFixture.todayISO)
    .every((day) => day.sessions.length === 0), true);
  for (const futureWeek of lateWeekPlan.weeks.slice(1).filter((week) => week.phase !== 'race')) {
    const futureLifts = sessions({ weeks: [futureWeek] }).filter(({ session }) => session.kind === 'lift');
    assert.ok(futureLifts.length >= lateWeekPlan.strengthPolicy.minimumSessionsPerWeek, `${lateWeekFixture.todayISO}: week ${futureWeek.week} restores the full lift floor`);
  }
}

console.log('PHASE 5 PLAN INTELLIGENCE SMOKE OK');
