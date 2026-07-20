// Forged Hybrid H4 transparent adaptation smoke.
// Run: node backend/test/forgedHybridH4.smoke.js

const concurrent = require('../src/lib/concurrentPlan');
const adaptation = require('../src/lib/adaptationEngine');
const schema = require('../src/lib/planSchema');

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${message}`); }
}
function section(name) { console.log(`\n== ${name} ==`); }

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function context(mode = 'hybrid_maintain', overrides = {}) {
  return {
    todayISO: '2026-07-13',
    profile: {
      weekly_miles_current: 18,
      run_days_per_week: mode === 'run_only' ? 3 : 4,
      lift_days_per_week: mode === 'run_only' ? 0 : 3,
      ...(overrides.profile || {}),
    },
    history: { weeklyMileageBaseline: 18, recentRunCount: 20, recentLiftCount: 12, adherenceRate: 0.9, missedWorkouts: 1 },
    recovery: { state: 'normal' },
    target: {
      weeks: 13,
      startDate: '2026-07-13',
      raceDate: '2026-10-11',
      raceName: 'Army Ten-Miler',
      raceId: 'army-10-miler-2026-10-11',
      distanceMiles: 10,
      goalType: 'completion',
      trainingDays: mode === 'run_only' ? ['Tue', 'Thu', 'Sat'] : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      runDaysPerWeek: mode === 'run_only' ? 3 : 4,
      liftDaysPerWeek: mode === 'run_only' ? 0 : 3,
      planMode: mode,
      liftingEnabled: mode !== 'run_only',
      elevation_gain_ft: 190,
      max_altitude_ft: 100,
      terrain: 'road',
      source: 'Army Ten-Miler',
      url: 'https://www.armytenmiler.com/',
      courseProvenance: 'official',
      ...(overrides.target || {}),
    },
  };
}

function allSessions(plan) {
  return plan.weeks.flatMap((week) => schema.getDayEntries(week).flatMap((day) => schema.daySessions(day)));
}

function dayByDate(plan, date) {
  for (const week of plan.weeks) {
    const day = schema.getDayEntries(week).find((entry) => entry.date === date);
    if (day) return day;
  }
  return null;
}

function setHardRun(plan, date, id) {
  for (const week of plan.weeks) {
    for (const day of schema.getDayEntries(week)) {
      if (day.date !== date) continue;
      const sessions = Array.isArray(day.sessions) ? day.sessions : [];
      const run = sessions.find((session) => schema.kindFromSession(session) === 'run');
      if (run) {
        run.id = id;
        run.title = 'Threshold intervals';
        run.type = 'quality';
        run.workout_type = 'run';
        run.intensity = 'Hard';
        run.target_zone = 'Zone 4';
        run.distance_miles = Number(run.distance_miles || 4);
      } else {
        sessions.push({
          id,
          kind: 'run',
          type: 'quality',
          workout_type: 'run',
          title: 'Threshold intervals',
          distance_miles: 4,
          pace_target: 'Threshold effort',
          target_zone: 'Zone 4',
          intensity: 'Hard',
          warmup: ['10 min easy'],
          steps: ['4 x 5 min hard'],
          cooldown: ['10 min easy'],
          progression: 'Hold controlled effort.',
          description: 'Hard threshold session.',
        });
        day.sessions = sessions;
      }
      return;
    }
  }
}

function liftCounts(plan) {
  return plan.weeks.map((week) => schema.getDayEntries(week)
    .flatMap((day) => schema.daySessions(day))
    .filter((session) => schema.kindFromSession(session) === 'lift')
    .length);
}

function lowHealth(date = '2026-07-13') {
  return {
    metrics: {
      readinessScore: { value: 40, source: 'apple_health', asOf: date, freshness: 'fresh', suspect: false },
      sleepHoursLastNight: { value: 5.2, source: 'apple_health', asOf: date, freshness: 'fresh', suspect: false },
    },
  };
}

const army = concurrent.buildConcurrentPlan(context('hybrid_maintain'));
const armyValidation = concurrent.validateConcurrentPlan(army, context('hybrid_maintain'));
assert(armyValidation.valid, `Army schema-v2 plan validates: ${armyValidation.errors.join('; ')}`);
assert(army.goal.raceId === 'army-10-miler-2026-10-11', 'generated plan goal keeps raceId');
assert(army.goal.course?.source === 'Army Ten-Miler' && army.goal.course?.provenance === 'official', 'generated plan goal keeps verified course provenance');

section('no data and unusable health data');
const noData = adaptation.buildAdaptationProposal({ plan: army, planningDateISO: '2026-07-13' });
assert(noData.status === 'keep' && noData.changes.length === 0, 'no health and no check-in keeps the plan');
assert(!JSON.stringify(noData.evidence).includes('Apple Health'), 'no-data proposal does not fabricate an Apple Health cause');

const staleHealth = adaptation.buildAdaptationProposal({
  plan: army,
  planningDateISO: '2026-07-13',
  healthSignals: { metrics: { sleepHoursLastNight: { value: 4.8, source: 'apple_health', asOf: '2026-07-01', freshness: 'stale', suspect: false } } },
});
assert(!staleHealth.evidence.some((item) => item.source === 'apple_health'), 'stale health is not cited as a driver');

const suspectSleep = adaptation.buildAdaptationProposal({
  plan: army,
  planningDateISO: '2026-07-13',
  healthSignals: { metrics: { sleepHoursLastNight: { value: 16, source: 'apple_health', asOf: '2026-07-13', freshness: 'fresh', suspect: true } } },
});
assert(!suspectSleep.evidence.some((item) => item.source === 'apple_health' && item.objective), 'suspect sleep-only metric is not an objective driver');

section('adaptive training-gap consent');
const trainingGapPlan = clone(army);
setHardRun(trainingGapPlan, '2026-07-14', 'gap-hard-run');
const trainingGap = adaptation.buildAdaptationProposal({
  plan: trainingGapPlan,
  planningDateISO: '2026-07-13',
  completion: {
    daysInactive: 5,
    lastActivityDate: '2026-07-08',
    missedWorkouts: 0,
    isPlanStartWindow: true,
    gapPromptEnabled: true,
    freshness: 'recent',
  },
});
assert(trainingGap.status === 'proposal' && trainingGap.changes.length > 0, 'established adaptive athlete gets a pre-plan gap proposal before a demanding run');
assert(trainingGap.headline === 'Everything okay?' && trainingGap.evidence.some((item) => item.signal === 'training_gap' && item.daysInactive === 5), 'training-gap proposal carries user-facing gap evidence');
assert(trainingGap.reason.includes('leave the calendar exactly as it is'), 'training-gap proposal preserves explicit consent');

const optedOutGap = adaptation.buildAdaptationProposal({
  plan: trainingGapPlan,
  planningDateISO: '2026-07-13',
  completion: {
    daysInactive: 5,
    missedWorkouts: 0,
    isPlanStartWindow: true,
    gapPromptEnabled: false,
  },
});
assert(optedOutGap.status === 'keep' && optedOutGap.changes.length === 0, 'structured or skip preference does not create an inactivity adjustment');

const missedGap = adaptation.buildAdaptationProposal({
  plan: trainingGapPlan,
  planningDateISO: '2026-07-13',
  completion: {
    daysInactive: 3,
    missedRuns: 1,
    missedWorkouts: 1,
    isPlanStartWindow: false,
    gapPromptEnabled: true,
  },
});
assert(missedGap.status === 'proposal' && missedGap.evidence.some((item) => item.signal === 'training_gap'), 'one missed scheduled session plus a three-day gap is enough to ask');

const plannedRestGap = adaptation.buildAdaptationProposal({
  plan: trainingGapPlan,
  planningDateISO: '2026-07-13',
  completion: {
    daysInactive: 4,
    missedWorkouts: 0,
    isPlanStartWindow: false,
    gapPromptEnabled: true,
  },
});
assert(plannedRestGap.status === 'keep' && plannedRestGap.changes.length === 0, 'planned rest days do not create a false inactivity prompt mid-plan');

const noHistoryGap = adaptation.buildAdaptationProposal({
  plan: trainingGapPlan,
  planningDateISO: '2026-07-13',
  completion: {
    daysInactive: null,
    missedWorkouts: 1,
    isPlanStartWindow: true,
    gapPromptEnabled: true,
  },
});
assert(noHistoryGap.status === 'keep' && noHistoryGap.changes.length === 0, 'a new athlete with no activity history is not labelled inactive');

section('objective and subjective evidence labels');
const labelled = adaptation.buildAdaptationProposal({
  plan: army,
  planningDateISO: '2026-07-13',
  planVersion: 'v1',
  healthSignals: lowHealth(),
  checkin: { legs: 1, drive: 1, feeling: 2, sleep_hours: 5.5, time_available: 60, life_flags: [] },
});
assert(labelled.status === 'proposal' && labelled.changes.length > 0, 'fresh low readiness produces a proposal');
assert(labelled.evidence.some((item) => item.source === 'apple_health' && item.objective === true), 'Apple Health evidence is labelled objective');
assert(labelled.evidence.some((item) => item.source === 'checkin' && item.objective === false), 'check-in evidence is labelled subjective');
assert(adaptation.proposalMatchesPlanVersion(labelled, 'v1') && !adaptation.proposalMatchesPlanVersion(labelled, 'v2'), 'pure plan-version check models stale proposal conflict');

section('72-hour date boundary');
const boundaryPlan = clone(army);
setHardRun(boundaryPlan, '2026-07-16', 'boundary-plus-72');
setHardRun(boundaryPlan, '2026-07-17', 'boundary-plus-73');
const boundary = adaptation.buildAdaptationProposal({
  plan: boundaryPlan,
  planningDateISO: '2026-07-13',
  healthSignals: lowHealth(),
});
const boundaryApplied = adaptation.applyProposalToPlan(boundaryPlan, boundary);
assert(boundary.changes.some((change) => change.date === '2026-07-16'), 'session exactly at +72h is in-window');
assert(!boundary.changes.some((change) => change.date === '2026-07-17'), '+73h session is not changed');
assert(JSON.stringify(dayByDate(boundaryApplied, '2026-07-17')) === JSON.stringify(dayByDate(boundaryPlan, '2026-07-17')), '+73h day is byte-identical after apply');
assert(JSON.stringify(dayByDate(boundaryApplied, '2026-07-20')) === JSON.stringify(dayByDate(boundaryPlan, '2026-07-20')), 'outside-window future day remains byte-identical');

section('safety exception');
const safety = adaptation.buildAdaptationProposal({
  plan: army,
  planningDateISO: '2026-07-13',
  injuryState: { active: true, bodyPart: 'calf', reason: 'calf pain with altered gait', freshness: 'current' },
});
assert(safety.status === 'proposal' && safety.safetyException === true, 'active injury produces a safety exception proposal');
assert(safety.reason.includes('safety exception') && safety.evidence.some((item) => item.source === 'injury'), 'safety proposal has a labelled safety reason');
assert(safety.changes.some((change) => change.date > adaptation.addDays('2026-07-13', 3)), 'safety exception may extend beyond 72 hours');

section('graded injury and soreness downshift');
const injuryPlan = clone(army);
setHardRun(injuryPlan, '2026-07-13', 'moderate-calf-run');
const healthyReadiness = {
  metrics: {
    readinessScore: { value: 86, source: 'apple_health', asOf: '2026-07-13', freshness: 'fresh', suspect: false },
  },
};
const moderateInjury = adaptation.buildAdaptationProposal({
  plan: injuryPlan,
  planningDateISO: '2026-07-13',
  healthSignals: healthyReadiness,
  injuryState: {
    active: true,
    openInjuries: [{ bodyPart: 'calf', pain_level: 5, date: '2026-07-11', active: true }],
  },
});
const moderateRunChange = moderateInjury.changes.find((change) => change.sessionId === 'moderate-calf-run');
const expectedModerateMiles = Math.max(0.5, Math.round(Number(moderateRunChange?.before.distance_miles || 0) * 0.75 * 10) / 10);
assert(moderateInjury.status === 'proposal' && !moderateInjury.safetyException, 'open moderate injury downshifts without forcing full rest');
assert(moderateRunChange && moderateRunChange.after.distance_miles === expectedModerateMiles, 'moderate calf injury applies the fixed 25% run-volume reduction');
assert(moderateRunChange?.summary.includes('open calf injury') && moderateInjury.evidence.some((item) => item.detail.includes('open calf injury')), 'moderate injury driver cites the injured body part');
assert(healthyReadiness.metrics.readinessScore.value === 86, 'injury rules do not change the passive Apple Health readiness number');

const severeInjury = adaptation.buildAdaptationProposal({
  plan: injuryPlan,
  planningDateISO: '2026-07-13',
  injuryState: {
    active: true,
    openInjuries: [{ bodyPart: 'calf', pain_level: 10, date: '2026-07-13', active: true }],
  },
});
assert(severeInjury.status === 'proposal' && severeInjury.safetyException, 'open severe injury keeps the safety hold path');
assert(severeInjury.changes.some((change) => change.after.kind === 'rest'), 'severe injury rests scheduled training');

const heavyLegsPlan = clone(army);
setHardRun(heavyLegsPlan, '2026-07-13', 'heavy-legs-run');
const heavyLegs = adaptation.buildAdaptationProposal({
  plan: heavyLegsPlan,
  planningDateISO: '2026-07-13',
  checkin: { legs: 1, feeling: 3, drive: 2, sleep_hours: null, time_available: 60, life_flags: [] },
});
const heavyLegsChange = heavyLegs.changes.find((change) => change.sessionId === 'heavy-legs-run');
assert(heavyLegsChange?.after.intensity === 'Moderate', 'Heavy legs trims hard-session intensity instead of swapping to recovery');
assert(heavyLegsChange?.after.distance_miles === heavyLegsChange?.before.distance_miles, 'Heavy legs intensity trim leaves planned volume unchanged');

section('invariant rejection');
const invalidCandidate = clone(army);
invalidCandidate.goal.date = '2026-10-12';
invalidCandidate.goal.distanceMiles = 9;
invalidCandidate.goal.raceId = 'changed-race';
invalidCandidate.weeks[0].phase = 'race';
invalidCandidate.strengthPolicy.minimumSessionsPerWeek = 1;
invalidCandidate.goal.course.elevationGainFt = 9999;
const rejected = adaptation.buildAdaptationProposal({
  plan: army,
  planningDateISO: '2026-07-13',
  candidatePlan: invalidCandidate,
});
assert(rejected.status === 'keep' && rejected.changes.length === 0, 'candidate changing protected invariants is rejected');
assert(/protected race/.test(rejected.reason), 'invariant rejection explains protected metadata');

section('strength floor, apply, rollback, idempotency');
const normal = adaptation.buildAdaptationProposal({
  plan: army,
  planningDateISO: '2026-07-13',
  healthSignals: lowHealth(),
  completion: { adherenceRate: 0.5, missedRuns: 2, missedLifts: 0, freshness: 'recent' },
});
const applied = adaptation.applyProposalToPlan(army, normal);
assert(JSON.stringify(applied) === JSON.stringify(normal.proposedPlan), 'accept applies exactly the stored proposed plan');
const floor = Number(army.strengthPolicy.minimumSessionsPerWeek);
assert(liftCounts(applied).every((count, index) => army.weeks[index].phase === 'race' || count >= floor), 'hybrid strength floor is preserved');
const kept = adaptation.applyProposalToPlan(army, noData);
assert(JSON.stringify(kept) === JSON.stringify(army), 'keep proposal applies as byte-equal original');
const appliedTwice = adaptation.applyProposalToPlan(applied, normal);
assert(JSON.stringify(appliedTwice) === JSON.stringify(applied), 'applying same proposal twice is idempotent');

section('run-only adaptation');
const runOnlyContext = context('run_only', {
  profile: { weekly_miles_current: 12, run_days_per_week: 3, lift_days_per_week: 0 },
});
const runOnly = concurrent.buildConcurrentPlan(runOnlyContext);
assert(concurrent.validateConcurrentPlan(runOnly, runOnlyContext).valid, 'run-only Army plan validates');
assert(!allSessions(runOnly).some((session) => schema.kindFromSession(session) === 'lift'), 'run-only source has no lift sessions');
const runOnlyProposal = adaptation.buildAdaptationProposal({
  plan: runOnly,
  planningDateISO: '2026-07-13',
  healthSignals: lowHealth(),
});
const runOnlyApplied = adaptation.applyProposalToPlan(runOnly, runOnlyProposal);
assert(runOnlyProposal.status === 'proposal' && runOnlyProposal.changes.every((change) => change.kind === 'run'), 'run-only plan adapts runs only');
assert(!allSessions(runOnlyApplied).some((session) => schema.kindFromSession(session) === 'lift'), 'run-only adaptation does not add lift references');

console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
if (failed) process.exit(1);
console.log('H4 SMOKE OK');
