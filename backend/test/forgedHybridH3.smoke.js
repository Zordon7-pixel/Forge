// Forged Hybrid H3 deterministic concurrent-plan smoke.
// Run: node backend/test/forgedHybridH3.smoke.js

const engine = require('../src/lib/concurrentPlan');
const schema = require('../src/lib/planSchema');
const raceCourse = require('../src/lib/raceCourse');

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${message}`); }
}
function section(name) { console.log(`\n== ${name} ==`); }

const BASE = {
  todayISO: '2026-07-13',
  profile: { weekly_miles_current: 18, run_days_per_week: 4, lift_days_per_week: 2 },
  history: { weeklyMileageBaseline: 18, recentRunCount: 20, recentLiftCount: 12, adherenceRate: 0.9, missedWorkouts: 1 },
  recovery: { state: 'normal' },
};

function context(mode, overrides = {}) {
  return {
    ...BASE,
    ...overrides,
    profile: { ...BASE.profile, ...(overrides.profile || {}) },
    history: { ...BASE.history, ...(overrides.history || {}) },
    recovery: { ...BASE.recovery, ...(overrides.recovery || {}) },
    target: {
      weeks: 8,
      startDate: '2026-07-13',
      distanceMiles: 10,
      trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      runDaysPerWeek: 4,
      liftDaysPerWeek: mode === 'hybrid_build' ? 3 : mode === 'hybrid_maintain' ? 2 : 0,
      planMode: mode,
      liftingEnabled: mode !== 'run_only',
      ...(overrides.target || {}),
    },
  };
}

function allSessions(plan) {
  return plan.weeks.flatMap((week) => week.days.flatMap((day) => day.sessions));
}

function trustedCourseEnvelope({ id, name, raceDate, elevationGainFt }) {
  return JSON.stringify(raceCourse.buildCatalogCourseEnvelope({
    id,
    name,
    race_date: raceDate,
    elevation_gain_ft: elevationGainFt,
    terrain: 'road',
    source: 'H3 fixture',
  }, { asOf: '2026-07-13T00:00:00.000Z', provenance: 'curated' }));
}

function liftSetVolume(plan, weekIndex = 0) {
  return plan.weeks[weekIndex].days
    .flatMap((day) => day.sessions)
    .filter((session) => session.kind === 'lift')
    .flatMap((session) => session.main)
    .reduce((sum, exercise) => sum + Number(exercise.sets || 0), 0);
}

function completeLiftFields(plan) {
  return allSessions(plan).filter((session) => session.kind === 'lift').every((session) => (
    session.focus && Array.isArray(session.warmup) && session.warmup.length
    && Array.isArray(session.recovery) && session.recovery.length && session.progression
    && Array.isArray(session.main) && session.main.length >= 2
    && session.main.every((exercise) => ['name', 'sets', 'reps', 'rest', 'load', 'cue', 'progression'].every((field) => exercise[field] !== undefined && exercise[field] !== '') && (exercise.rpe || exercise.rir))
  ));
}

section('run-only novice + low recovery');
const noviceLowContext = context('run_only', {
  profile: { weekly_miles_current: 7, run_days_per_week: 3, lift_days_per_week: 0 },
  history: { weeklyMileageBaseline: 7, adherenceRate: 0.5, missedWorkouts: 5 },
  recovery: { state: 'low' },
  target: { trainingDays: ['Tue', 'Thu', 'Sat'], runDaysPerWeek: 3 },
});
const noviceLow = engine.buildConcurrentPlan(noviceLowContext);
const noviceValidation = engine.validateConcurrentPlan(noviceLow, noviceLowContext);
assert(noviceValidation.valid, `novice run-only validates: ${noviceValidation.errors.join('; ')}`);
assert(allSessions(noviceLow).every((session) => session.kind === 'run'), 'run-only has zero lift/cross/conditioning sessions');
assert(noviceLow.strengthPolicy.enabled === false, 'run-only strength policy disabled');
assert(noviceLow.weeks.every((week) => week.days.length === 7 && week.days.some((day) => day.sessions.length === 0)), 'every week has seven days and a full rest day');

section('acute recovery does not rewrite the full block');
const noviceHigh = engine.buildConcurrentPlan(context('run_only', {
  profile: { weekly_miles_current: 7, run_days_per_week: 3, lift_days_per_week: 0 },
  history: { weeklyMileageBaseline: 7, adherenceRate: 0.95, missedWorkouts: 0 },
  recovery: { state: 'high' },
  target: { trainingDays: ['Tue', 'Thu', 'Sat'], runDaysPerWeek: 3 },
}));
assert(noviceLow.weeks[0].totalMiles === noviceHigh.weeks[0].totalMiles, 'one recovery snapshot and inferred missed sessions do not reduce the full block');
assert(noviceLow.inputSummary.adherenceBand === 'low' && noviceHigh.inputSummary.recoveryState === 'high', 'bounded input summary records adherence/recovery bands');

section('hybrid maintain and build prescriptions');
const maintainContext = context('hybrid_maintain');
const buildContext = context('hybrid_build', { profile: { weekly_miles_current: 30, run_days_per_week: 5, lift_days_per_week: 3 }, target: { runDaysPerWeek: 5 } });
const maintain = engine.buildConcurrentPlan(maintainContext);
const build = engine.buildConcurrentPlan(buildContext);
const maintainValidation = engine.validateConcurrentPlan(maintain, maintainContext);
const buildValidation = engine.validateConcurrentPlan(build, buildContext);
assert(maintainValidation.valid, `hybrid maintain validates: ${maintainValidation.errors.join('; ')}`);
assert(buildValidation.valid, `hybrid build validates: ${buildValidation.errors.join('; ')}`);
assert(completeLiftFields(maintain) && completeLiftFields(build), 'all lift sessions and exercises contain complete prescriptions');
assert(liftSetVolume(build) > liftSetVolume(maintain), 'hybrid build uses meaningfully more lifting volume than maintain');
assert(!allSessions(build).some((session) => /circuit|ruck|sled|injury prevention/i.test(`${session.title} ${session.description}`)), 'hybrid plans contain no conditioning-circuit or injury-prevention substitutes');
assert(build.weeks.slice(0, -1).every((week) => week.days.flatMap((day) => day.sessions).filter((session) => session.kind === 'lift').length >= build.strengthPolicy.minimumSessionsPerWeek), 'hybrid build preserves strength floor outside race week');

const highFrequencyContext = context('hybrid_build', {
  target: { trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], runDaysPerWeek: 6, liftDaysPerWeek: 3 },
});
const highFrequency = engine.buildConcurrentPlan(highFrequencyContext);
const highFrequencyValidation = engine.validateConcurrentPlan(highFrequency, highFrequencyContext);
assert(highFrequencyValidation.valid, `six-run/three-lift plan validates: ${highFrequencyValidation.errors.join('; ')}`);
assert(highFrequency.weeks.every((week) => week.days.some((day) => day.sessions.length === 0)), 'six-run/three-lift plan preserves a full rest day');

section('interference, deload, taper, and race');
const raceContext = context('hybrid_maintain', {
  target: { weeks: 13, startDate: '2026-07-13', raceDate: '2026-10-11', raceName: 'Army Ten-Miler', distanceMiles: 10, liftDaysPerWeek: 3 },
});
const army = engine.buildConcurrentPlan(raceContext);
const armyValidation = engine.validateConcurrentPlan(army, raceContext);
assert(armyValidation.valid, `13-week Army plan validates: ${armyValidation.errors.join('; ')}`);
assert(army.weeks.length === 13 && army.goal.date === '2026-10-11' && army.goal.distanceMiles === 10, 'Army plan preserves 13 weeks, race date, and distance');
assert(army.weeks[12].days[6].date === '2026-10-11' && army.weeks[12].days[6].sessions.some((session) => session.type === 'race'), 'Army race session lands on exact Sunday race date');
assert(army.weeks.some((week) => week.phase === 'deload') && army.weeks[11].phase === 'taper' && army.weeks[12].phase === 'race', 'plan includes deload, taper, and race phases');
assert(army.weeks.filter((week) => week.phase === 'deload').every((week) => week.totalMiles < army.weeks[week.week - 2].totalMiles * 0.9), 'deload weeks reduce mileage');
assert(army.weeks[11].totalMiles < army.weeks[10].totalMiles * 0.8, 'taper cuts mileage at least 20%');
let interferenceSafe = true;
for (const week of army.weeks) {
  const sessionsByDay = week.days.map((day) => day.sessions);
  const hard = sessionsByDay.map((sessions, index) => sessions.some(engine.isHardRun) ? index : -99).filter((index) => index >= 0);
  const lower = sessionsByDay.map((sessions, index) => sessions.some((session) => session.kind === 'lift' && /lower/i.test(session.focus)) ? index : -99).filter((index) => index >= 0);
  if (lower.some((lowerIndex) => hard.some((hardIndex) => Math.abs(lowerIndex - hardIndex) <= 1))) interferenceSafe = false;
}
assert(interferenceSafe, 'lower-body strength never conflicts with adjacent hard/long run');

const movedRace = JSON.parse(JSON.stringify(army));
const raceDay = movedRace.weeks[12].days[6];
raceDay.date = '2026-10-10';
const movedRaceValidation = engine.validateConcurrentPlan(movedRace, raceContext);
assert(!movedRaceValidation.valid && movedRaceValidation.errors.some((error) => /exact race session|target date/.test(error)), 'validator rejects a race session moved off the target date');

const shiftedCalendar = JSON.parse(JSON.stringify(army));
shiftedCalendar.weeks[0].startDate = '2026-07-20';
const shiftedValidation = engine.validateConcurrentPlan(shiftedCalendar, raceContext);
assert(!shiftedValidation.valid && shiftedValidation.errors.some((error) => /startDate must be 2026-07-13/.test(error)), 'validator rejects a shifted calendar anchor');

const hillyContext = context('run_only', {
  target: {
    weeks: 13,
    startDate: '2026-07-13',
    raceDate: '2026-10-11',
    raceName: 'Hilly Ten-Miler',
    distanceMiles: 10,
    elevation_gain_ft: 1200,
    source: 'H3 fixture',
    course_profile_json: trustedCourseEnvelope({ id: 'hilly-ten-2026-10-11', name: 'Hilly Ten-Miler', raceDate: '2026-10-11', elevationGainFt: 1200 }),
  },
});
const hillyPlan = engine.buildConcurrentPlan(hillyContext);
assert(engine.validateConcurrentPlan(hillyPlan, hillyContext).valid, 'deterministic hilly race plan validates');
const noHillPlan = JSON.parse(JSON.stringify(hillyPlan));
for (const session of allSessions(noHillPlan)) {
  if (session.kind === 'run') {
    session.title = session.title.replace(/hill|course-specific/ig, 'rolling');
    session.type = session.type.replace(/hill/ig, 'quality');
    session.description = session.description.replace(/hill|course-specific/ig, 'rolling');
  }
}
const noHillValidation = engine.validateConcurrentPlan(noHillPlan, hillyContext);
assert(!noHillValidation.valid && noHillValidation.errors.some((error) => /hilly race plan/.test(error)), 'validator rejects a hilly race plan with no hill-specific session');

const farWindow = engine.racePlanWindow('2027-04-19', '2026-07-12');
assert(farWindow.weeks === 20 && farWindow.startDate === '2026-12-07' && farWindow.startsLater, 'far race uses a capped 20-week window ending on race week');
const farRaceContext = context('hybrid_maintain', {
  target: { weeks: farWindow.weeks, startDate: farWindow.startDate, raceDate: '2027-04-19', raceName: 'Boston Marathon', distanceMiles: 26.2 },
});
const farRacePlan = engine.buildConcurrentPlan(farRaceContext);
assert(engine.validateConcurrentPlan(farRacePlan, farRaceContext).valid, 'far-race deterministic fallback validates and reaches exact race day');
assert(allSessions(farRacePlan).some((session) => session.type === 'race' && session.distance_miles === 26.2), 'far-race plan preserves exact race distance');

const customDistanceContext = context('run_only', {
  target: { weeks: 13, startDate: '2026-07-13', raceDate: '2026-10-11', raceName: 'Custom course', distanceMiles: 6.25 },
});
const customDistancePlan = engine.buildConcurrentPlan(customDistanceContext);
assert(engine.validateConcurrentPlan(customDistancePlan, customDistanceContext).valid, 'custom race distance validates without one-decimal truncation');
assert(allSessions(customDistancePlan).some((session) => session.type === 'race' && session.distance_miles === 6.25), 'custom race session preserves exact distance');
assert(engine.racePlanWindow('2026-07-11', '2026-07-12') === null, 'past race date is rejected before generation');

const oneWeekHillyContext = context('run_only', {
  target: {
    weeks: 1,
    startDate: '2026-07-13',
    raceDate: '2026-07-19',
    raceName: 'Immediate hilly race',
    distanceMiles: 10,
    elevation_gain_ft: 1000,
    source: 'H3 fixture',
    course_profile_json: trustedCourseEnvelope({ id: 'immediate-hilly-2026-07-19', name: 'Immediate hilly race', raceDate: '2026-07-19', elevationGainFt: 1000 }),
    trainingDays: ['Sun'],
    runDaysPerWeek: 1,
  },
});
assert(engine.validateConcurrentPlan(engine.buildConcurrentPlan(oneWeekHillyContext), oneWeekHillyContext).valid, 'one-week hilly race remains feasible without inventing a prep session');

const lowFrequencyLongContext = context('run_only', {
  target: { weeks: 20, startDate: '2026-07-13', raceDate: '2026-11-29', raceName: 'Low-frequency race', distanceMiles: 10, trainingDays: ['Sat'], runDaysPerWeek: 1 },
});
const lowFrequencyLongPlan = engine.buildConcurrentPlan(lowFrequencyLongContext);
assert(engine.validateConcurrentPlan(lowFrequencyLongPlan, lowFrequencyLongContext).valid, '20-week one-day plan preserves measurable deloads');

section('stable ids and candidate rejection');
const repeated = engine.buildConcurrentPlan(raceContext);
assert(JSON.stringify(army) === JSON.stringify(repeated), 'deterministic generation is byte-stable for the same inputs');
const ids = allSessions(army).map((session) => session.id);
assert(ids.length === new Set(ids).size && ids.every(Boolean), 'all session ids are present and globally unique');

const validAiCandidate = JSON.parse(JSON.stringify(maintain));
const firstRun = allSessions(validAiCandidate).find((session) => session.kind === 'run');
firstRun.title = 'AI-authored valid aerobic run';
const accepted = engine.selectPlanCandidate(validAiCandidate, maintainContext);
assert(accepted.source === 'ai_validated' && allSessions(accepted.plan).some((session) => session.title === 'AI-authored valid aerobic run'), 'valid AI candidate is accepted without semantic reshaping');

const wrongMode = JSON.parse(JSON.stringify(maintain));
wrongMode.planMode = 'run_only';
allSessions(wrongMode)[0].title = 'SENTINEL PARTIAL AI';
const rejectedWrongMode = engine.selectPlanCandidate(wrongMode, maintainContext);
assert(rejectedWrongMode.source === 'deterministic_fallback', 'wrong-mode AI candidate is rejected wholesale');
assert(!JSON.stringify(rejectedWrongMode.plan).includes('SENTINEL PARTIAL AI'), 'invalid candidate content is not partially salvaged');
assert(rejectedWrongMode.plan.generationValidationErrors.some((error) => /planMode/.test(error)), 'fallback records bounded validation reason');

const incompleteStrength = JSON.parse(JSON.stringify(build));
const brokenLift = allSessions(incompleteStrength).find((session) => session.kind === 'lift');
delete brokenLift.main[0].load;
const incompleteValidation = engine.validateConcurrentPlan(incompleteStrength, buildContext);
assert(!incompleteValidation.valid && incompleteValidation.errors.some((error) => /load is required/.test(error)), 'incomplete strength prescription is rejected');

console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
if (failed) process.exit(1);
console.log('H3 SMOKE OK');
