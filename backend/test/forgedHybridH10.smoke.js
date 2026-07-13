// Forged Hybrid H10 prescription integrity and strength-data smoke.
// Run: node backend/test/forgedHybridH10.smoke.js

const concurrent = require('../src/lib/concurrentPlan');
const integrity = require('../src/lib/prescriptionIntegrity');
const strength = require('../src/lib/strengthPrescription');

let passed = 0;
let failed = 0;
function check(condition, message) {
  if (condition) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${message}`); }
}
function section(name) { console.log(`\n== ${name} ==`); }
function liftSessions(plan, weekIndex = null) {
  return (plan.weeks || [])
    .filter((week, index) => weekIndex === null || index === weekIndex)
    .flatMap((week) => (week.days || []).flatMap((day) => day.sessions || []))
    .filter((session) => session.kind === 'lift');
}
function setVolume(plan, weekIndex) {
  return liftSessions(plan, weekIndex).flatMap((session) => session.main || []).reduce((sum, exercise) => sum + Number(exercise.sets || 0), 0);
}

section('persisted recovery contradiction repair');
const corruptPlan = {
  schemaVersion: 2,
  weeks: [{
    week: 1,
    days: [{
      date: '2026-07-14',
      day: 'Tue',
      sessions: [{
        id: 'h3-w1-tue-run',
        kind: 'run',
        type: 'recovery',
        title: 'Recovery run',
        distance_miles: 0.9,
        target_zone: 'Zone 1-2',
        intensity: 'Recovery',
        warmup: ['12 min easy running', '4 x 20 sec relaxed strides'],
        steps: ['6-8 x 60 sec uphill', 'Jog down fully between repetitions'],
        cooldown: ['10 min easy running'],
      }],
    }],
  }],
};
const repaired = integrity.repairPlanPrescriptions(corruptPlan);
const repairedRun = repaired.weeks[0].days[0].sessions[0];
check(repaired !== corruptPlan && repaired.prescriptionIntegrityAdjusted, 'repair is immutable and marks the response plan');
check(repairedRun.type === 'recovery' && repairedRun.target_zone === 'Zone 1-2', 'recovery identity is preserved');
check(repairedRun.steps.some((step) => /stay in zone 1-2/i.test(step)), 'safe recovery structure replaces stale hard work');
check(!repairedRun.steps.some((step) => /hill|repeat|interval/i.test(step)), 'hill and interval instructions cannot survive inside recovery');
check(corruptPlan.weeks[0].days[0].sessions[0].steps[0].includes('uphill'), 'stored source object is not mutated on read');
const staleSteady = integrity.repairRecoverySession({ kind: 'run', type: 'recovery', title: 'Recovery run', target_zone: 'Zone 1-2', pace_target: 'Comfortably steady', steps: ['Run the middle continuously at steady effort'] });
check(staleSteady.steps.some((step) => /stay in zone 1-2/i.test(step)) && !staleSteady.steps.some((step) => /steady effort/i.test(step)), 'converted steady runs receive the same coherent recovery repair');
const hardRun = { kind: 'run', type: 'hills', title: 'Controlled hill repeats', target_zone: 'Zone 3', steps: ['6 x 60 sec uphill'] };
check(integrity.repairRecoverySession(hardRun) === hardRun, 'a real hill workout is not rewritten');

section('recent lifting history summary');
const exerciseHistory = strength.summarizeRecentExercises([
  { exercise_name: 'Dumbbell Bench Press', reps: 8, weight_lbs: 55, logged_at: '2026-07-12T18:00:00Z' },
  { exercise_name: 'Dumbbell Bench Press', reps: 8, weight_lbs: 50, logged_at: '2026-07-05T18:00:00Z' },
  { exercise_name: 'Barbell Back Squat', reps: 5, weight_lbs: 185, logged_at: '2026-07-10T18:00:00Z' },
]);
const benchHistory = exerciseHistory.find((exercise) => /bench/.test(exercise.normalizedName));
check(benchHistory?.sets === 2 && benchHistory.latestWeightLbs === 55 && benchHistory.latestReps === 8, 'latest usable load/reps pair is retained with aggregate set count');
check(benchHistory?.estimatedOneRepMaxLbs === 70, 'bounded recent set produces a transparent estimated max for planning context');
const staleHeavyHistory = strength.summarizeRecentExercises([
  { exercise_name: 'Dumbbell Bench Press', reps: 8, weight_lbs: 45, logged_at: '2026-07-12T18:00:00Z' },
  { exercise_name: 'Dumbbell Bench Press', reps: 3, weight_lbs: 80, logged_at: '2026-06-20T18:00:00Z' },
]);
check(staleHeavyHistory[0]?.estimatedOneRepMaxLbs === 57, 'the displayed latest-set provenance cannot hide an older heavier load estimate');

function context(overrides = {}) {
  return {
    todayISO: '2026-07-13',
    profile: { weekly_miles_current: 12, run_days_per_week: 3, lift_days_per_week: 2 },
    target: {
      weeks: 4,
      startDate: '2026-07-13',
      distanceMiles: 10,
      trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      runDaysPerWeek: 3,
      liftDaysPerWeek: 2,
      planMode: 'hybrid_maintain',
      liftingEnabled: true,
      equipment: ['barbell', 'dumbbell', 'rack', 'bench', 'cable', 'machines'],
      ...(overrides.target || {}),
    },
    history: {
      weeklyMileageBaseline: 12,
      recentRunCount: 8,
      recentLiftCount: 4,
      recentExercises: exerciseHistory,
      adherenceRate: 0.85,
      missedWorkouts: 0,
      ...(overrides.history || {}),
    },
    recovery: { state: 'normal', available: true, readinessScore: 72, metrics: {}, ...(overrides.recovery || {}) },
    checkin: { date: '2026-07-13', feeling: 4, legs: 2, drive: 2, sleepHours: 7.5, lifeFlags: [] },
  };
}

section('data-driven strength details');
const normal = concurrent.buildConcurrentPlan(context());
const allLifts = liftSessions(normal);
const bench = allLifts.flatMap((session) => session.main).find((exercise) => exercise.name === 'Dumbbell bench press');
check(concurrent.validateConcurrentPlan(normal, context()).valid, 'data-driven deterministic plan validates');
check(bench?.load === '52.5 lb starting load' && /recent 55 lb x 8 set/i.test(bench?.loadSource), 'matching exercise load is conservatively estimated from the latest logged set');
check(/2-3 min|60-90 sec/.test(allLifts[0]?.main[0]?.rest || ''), 'every lift has an explicit evidence-informed rest interval');
check(allLifts.every((session) => session.main.every((exercise) => exercise.sets && exercise.reps && exercise.rest && exercise.load && exercise.rpe && exercise.progression)), 'every exercise includes sets, reps, rest, load, effort, and progression');
check(allLifts.every((session) => session.prescriptionBasis?.watchDataRole.includes('does not estimate lifting loads')), 'plan states the bounded role of watch data');

section('recovery and missing-data behavior');
const caution = concurrent.buildConcurrentPlan(context({ recovery: { state: 'caution', available: true, readinessScore: 58 } }));
check(setVolume(caution, 0) < setVolume(normal, 0), 'caution recovery reduces first-week working sets');
check(setVolume(caution, 1) === setVolume(normal, 1), 'one recovery snapshot does not suppress every future week');
const cautionSelected = concurrent.selectPlanCandidate(normal, context({ recovery: { state: 'caution', available: true, readinessScore: 58 } }));
check(cautionSelected.source === 'ai_validated' && setVolume(cautionSelected.plan, 0) < setVolume(normal, 0), 'validated AI plans receive the same first-week recovery reduction');
const noLiftHistory = concurrent.buildConcurrentPlan(context({ history: { recentExercises: [], recentLiftCount: 0 } }));
check(liftSessions(noLiftHistory).flatMap((session) => session.main).every((exercise) => /RIR/.test(exercise.load) && !/\d+\s*lb starting/i.test(exercise.load)), 'missing lift history uses RPE/RIR instead of invented pounds');
const barbellBenchOnly = strength.summarizeRecentExercises([
  { exercise_name: 'Barbell Bench Press', reps: 5, weight_lbs: 225, logged_at: '2026-07-12T18:00:00Z' },
]);
const modalitySafe = concurrent.buildConcurrentPlan(context({ history: { recentExercises: barbellBenchOnly } }));
const dumbbellBench = liftSessions(modalitySafe).flatMap((session) => session.main).find((exercise) => exercise.name === 'Dumbbell bench press');
check(/RIR/.test(dumbbellBench.load) && !/225/.test(`${dumbbellBench.load} ${dumbbellBench.loadSource}`), 'barbell history is never reused as a dumbbell load');

section('equipment and candidate validation');
const minimalContext = context({ target: { equipment: ['bodyweight', 'resistance_bands'] } });
const minimal = concurrent.buildConcurrentPlan(minimalContext);
check(liftSessions(minimal).flatMap((session) => session.main).every((exercise) => !/barbell|dumbbell|machine|cable/i.test(exercise.name)), 'minimal-equipment plans do not prescribe unavailable gym equipment');
const invalid = JSON.parse(JSON.stringify(normal));
liftSessions(invalid)[0].main[0].sets = 7;
const selected = concurrent.selectPlanCandidate(invalid, context());
check(selected.source === 'deterministic_fallback' && selected.validationErrors.some((error) => /sets must be/.test(error)), 'AI candidate with unsafe set count is rejected for deterministic fallback');

console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
if (failed) process.exit(1);
console.log('H10 SMOKE OK');
