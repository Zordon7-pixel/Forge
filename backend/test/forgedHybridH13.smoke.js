// Forged Hybrid H13 evidence-backed timed-plan smoke.
// Run: node backend/test/forgedHybridH13.smoke.js

const concurrent = require('../src/lib/concurrentPlan');
const evidence = require('../src/lib/trainingEvidence');

let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) passed += 1;
  else {
    failed += 1;
    console.error(`  FAIL: ${message}`);
  }
}

function sessions(plan) {
  return (plan.weeks || []).flatMap((week) => (week.days || []).flatMap((day) => (
    (day.sessions || []).map((session) => ({ week, day, session }))
  )));
}

console.log('\n== bounded athlete baseline ==');
const baseline = concurrent.estimateWeeklyMileageBaseline([
  { date: '2026-06-15', distance_miles: 3.4, duration_seconds: 2200 },
  { date: '2026-07-03', distance_miles: 3.1, duration_seconds: 2027 },
  { date: '2026-07-06', distance_miles: 5, duration_seconds: 3499 },
  { date: '2026-07-13', distance_miles: 7.31, duration_seconds: 5097 },
  { date: '2026-07-14', distance_miles: 2.17, duration_seconds: 1531 },
  { date: '2026-07-14', distance_miles: 0.2, duration_seconds: 300 },
], { planningDateISO: '2026-07-14', profileWeeklyMiles: 9.1 });
check(baseline.meaningfulRunCount === 5, 'short activity fragments do not inflate the running baseline');
check(baseline.recent14WeeklyMiles > baseline.longTermWeeklyMiles, 'recent consistency is visible alongside the longer history');
check(baseline.weeklyMiles >= baseline.longTermWeeklyMiles, 'a strong recent block is not averaged away');
check(baseline.weeklyMiles <= Math.max(baseline.longTermWeeklyMiles, 9.1) * 1.25 + 0.1, 'recent load cannot create an unbounded mileage jump');

console.log('\n== evidence-backed Army Ten-Miler block ==');
const acuteRunLoad = {
  available: true,
  latestRun: {
    date: '2026-07-13', distanceMiles: 7.312, durationMinutes: 85,
    paceSecondsPerMile: 697, paceLabel: '11:37/mi', isLong: true, isHard: false,
  },
  sevenDayMiles: 9.5,
  loadRatio: 0.83,
  protection: {
    active: true,
    noAdditionalRunOnDate: null,
    hardRunsThrough: '2026-07-15',
    lowerBodyThrough: '2026-07-15',
  },
};
const context = {
  todayISO: '2026-07-14',
  profile: { weekly_miles_current: 9.1, run_days_per_week: 4, lift_days_per_week: 3 },
  target: {
    weeks: 13,
    startDate: '2026-07-13',
    raceDate: '2026-10-11',
    raceName: 'Army Ten-Miler',
    distanceMiles: 10,
    goalType: 'pr',
    goalTimeSeconds: 7800,
    planMode: 'hybrid_maintain',
    trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    runDaysPerWeek: 4,
    liftDaysPerWeek: 3,
  },
  history: {
    weeklyMileageBaseline: 11.4,
    mileageBaseline: baseline,
    recentRunCount: 28,
    recentLiftCount: 2,
    acuteRunLoad,
  },
  recovery: { state: 'caution', available: true, metrics: {} },
  checkin: { date: '2026-07-14', feeling: 3, legs: 2, drive: 2, sleepHours: 6.5, lifeFlags: [] },
};
const plan = concurrent.buildConcurrentPlan(context);
const validation = concurrent.validateConcurrentPlan(plan, context);
const all = sessions(plan);
const runs = all.filter(({ session }) => session.kind === 'run');
const peakWeek = plan.weeks.find((week) => week.phase === 'peak');
const peakLong = peakWeek.days.flatMap((day) => day.sessions).find((session) => session.type === 'long');
const race = runs.find(({ session }) => session.type === 'race');

check(validation.valid, `plan validates: ${validation.errors.join('; ')}`);
check(plan.generationSource === 'evidence_engine', 'plan truthfully identifies the deterministic evidence engine');
check(plan.trainingEvidence.length >= 5 && plan.trainingEvidence.every((source) => /^https:\/\//.test(source.url)), 'plan carries readable public source links');
check(!all.some(({ day, session }) => day.date <= '2026-07-15' && concurrent.isHardRun(session)), 'recent 7.3-mile load protects the next 48 hours');
check(runs.some(({ session }) => session.type === 'recovery' && session.duration_min >= 20), 'immediate recovery is a real time prescription');
check(runs.filter(({ session }) => session.type !== 'race').every(({ session }) => (
  session.prescription_basis === 'time'
  && session.duration_min > 0
  && session.distance_is_estimate === true
  && session.evidence_refs.length > 0
)), 'non-race running is time-primary, retains estimated mileage, and names its evidence');
check(peakWeek.totalMiles >= 18 && peakLong.duration_min >= 90 && peakLong.distance_miles >= 8, 'the PR block builds beyond current capacity before tapering');
check(race.day.date === '2026-10-11' && race.session.distance_miles === 10 && race.session.prescription_basis === 'distance', 'race day preserves the exact date and distance');
check(plan.weeks[11].totalMiles < peakWeek.totalMiles * 0.8, 'the evidence-backed build still tapers before race week');
check(evidence.SOURCES.ingebrigtsen_progression.kind === 'athlete_practice', 'elite practice is labeled as an example, not medical or causal evidence');

console.log('\n== low-mileage high-frequency plan ==');
const lowMileageContext = {
  todayISO: '2026-07-14',
  profile: { weekly_miles_current: 5, run_days_per_week: 5, lift_days_per_week: 0 },
  target: {
    weeks: 11,
    startDate: '2026-07-20',
    raceDate: '2026-10-04',
    raceName: 'Beginner 5K',
    distanceMiles: 3.1,
    goalType: 'completion',
    planMode: 'run_only',
    trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    runDaysPerWeek: 5,
    liftDaysPerWeek: 0,
  },
  history: { weeklyMileageBaseline: 5, recentRunCount: 2, recentLiftCount: 0 },
  recovery: { state: 'normal', available: false, metrics: {} },
};
const lowMileagePlan = concurrent.buildConcurrentPlan(lowMileageContext);
const lowMileageValidation = concurrent.validateConcurrentPlan(lowMileagePlan, lowMileageContext);
const lowMileageRuns = sessions(lowMileagePlan).filter(({ session }) => session.kind === 'run' && session.type !== 'race');
check(lowMileageValidation.valid, `low-mileage plan validates instead of returning a generation 500: ${lowMileageValidation.errors.join('; ')}`);
check(lowMileageRuns.every(({ session }) => Number(session.distance_miles) > 0), 'scaled internal distance estimates remain positive');
const lowMileageQuality = lowMileageRuns.filter(({ session }) => session.workout_id === 'strides');
check(lowMileageQuality.length > 0, 'low-mileage athletes retain a safe speed-development stimulus');
check(lowMileageQuality.every(({ session }) => (
  session.prescription_basis === 'time'
  && session.quality_prescription?.work === '20 sec relaxed fast'
  && /never sprint/i.test(session.quality_prescription?.target || '')
)), 'undersized quality slots become controlled strides instead of oversized interval work');

console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
if (failed) process.exit(1);
console.log('H13 SMOKE OK');
