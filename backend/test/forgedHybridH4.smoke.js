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

section('adaptive run-gap consent');
const trainingGapPlan = clone(army);
setHardRun(trainingGapPlan, '2026-07-14', 'gap-hard-run');
const trainingGap = adaptation.buildAdaptationProposal({
  plan: trainingGapPlan,
  planningDateISO: '2026-07-13',
  completion: {
    daysSinceRun: 7,
    lastRunDate: '2026-07-06',
    missedWorkouts: 0,
    gapPromptEnabled: true,
    freshness: 'recent',
  },
});
assert(trainingGap.status === 'proposal' && trainingGap.changes.length > 0, 'seven days without a run produces a bounded re-entry proposal');
assert(trainingGap.headline === 'Ready to ease back into running?' && trainingGap.evidence.some((item) => item.signal === 'run_gap' && item.daysSinceRun === 7), 'run-gap proposal carries user-facing gap evidence');
assert(trainingGap.reason.includes('leave the calendar exactly as it is'), 'run-gap proposal preserves explicit consent');

const optedOutGap = adaptation.buildAdaptationProposal({
  plan: trainingGapPlan,
  planningDateISO: '2026-07-13',
  completion: {
    daysSinceRun: 8,
    lastRunDate: '2026-07-05',
    missedWorkouts: 0,
    gapPromptEnabled: false,
  },
});
assert(optedOutGap.status === 'keep' && optedOutGap.changes.length === 0, 'structured or skip preference does not create an inactivity adjustment');

const decidedGap = adaptation.buildAdaptationProposal({
  plan: trainingGapPlan,
  planningDateISO: '2026-07-13',
  completion: {
    adaptationEnabled: false,
    gapPromptEnabled: false,
    adherenceRate: 0.2,
    missedWorkouts: 5,
    missedRuns: 3,
    daysSinceRun: 9,
    lastRunDate: '2026-07-04',
  },
});
assert(decidedGap.status === 'keep' && decidedGap.changes.length === 0, 'a decided completion prompt cannot regenerate from the same low-adherence evidence');

const decidedGapWithSafety = adaptation.buildAdaptationProposal({
  plan: trainingGapPlan,
  planningDateISO: '2026-07-13',
  completion: { adaptationEnabled: false, missedWorkouts: 5, daysSinceRun: 9, lastRunDate: '2026-07-04' },
  injuryState: { active: true, bodyPart: 'ankle', reason: 'new ankle pain' },
});
assert(decidedGapWithSafety.status === 'proposal' && decidedGapWithSafety.safetyException, 'completion suppression does not hide a fresh safety signal');

const missedGap = adaptation.buildAdaptationProposal({
  plan: trainingGapPlan,
  planningDateISO: '2026-07-13',
  completion: {
    daysSinceRun: 6,
    lastRunDate: '2026-07-07',
    missedRuns: 1,
    missedWorkouts: 1,
    gapPromptEnabled: true,
  },
});
assert(missedGap.status === 'keep' && !missedGap.evidence.some((item) => item.signal === 'run_gap'), 'six days without a run does not trigger the seven-day prompt');

const plannedRestGap = adaptation.buildAdaptationProposal({
  plan: trainingGapPlan,
  planningDateISO: '2026-07-13',
  completion: {
    daysSinceRun: 4,
    lastRunDate: '2026-07-09',
    missedWorkouts: 0,
    gapPromptEnabled: true,
  },
});
assert(plannedRestGap.status === 'keep' && plannedRestGap.changes.length === 0, 'planned rest days do not create a false inactivity prompt mid-plan');

const noHistoryGap = adaptation.buildAdaptationProposal({
  plan: trainingGapPlan,
  planningDateISO: '2026-07-13',
  completion: {
    daysSinceRun: null,
    lastRunDate: null,
    missedWorkouts: 1,
    gapPromptEnabled: true,
  },
});
assert(noHistoryGap.status === 'keep' && noHistoryGap.changes.length === 0, 'a new athlete with no activity history is not labelled inactive');

section('objective evidence authority and subjective input inertness');
const subjectiveOnly = adaptation.buildAdaptationProposal({
  plan: army,
  planningDateISO: '2026-07-13',
  planVersion: 'v1',
  checkin: {
    legs: 1,
    drive: 1,
    feeling: 1,
    sleep_hours: 2,
    time_available: 5,
    life_flags: ['sick', 'injured', 'sore'],
    perceived_effort: 10,
    pain_level: 10,
    post_energy: 'low',
  },
});
const subjectiveBaseline = adaptation.buildAdaptationProposal({
  plan: army,
  planningDateISO: '2026-07-13',
  planVersion: 'v1',
});
assert(JSON.stringify(subjectiveOnly) === JSON.stringify(subjectiveBaseline), 'subjective check-in, effort, pain, and energy inputs have zero adaptation authority');
assert(subjectiveOnly.status === 'keep' && subjectiveOnly.changes.length === 0, 'subjective-only input keeps the accepted calendar unchanged');
assert(!subjectiveOnly.evidence.some((item) => ['checkin', 'post_run_checkin'].includes(item.source)), 'subjective input is absent from adaptation evidence');

const labelled = adaptation.buildAdaptationProposal({
  plan: army,
  planningDateISO: '2026-07-13',
  planVersion: 'v1',
  healthSignals: lowHealth(),
  checkin: { legs: 1, drive: 1, feeling: 2, sleep_hours: 5.5, time_available: 60, life_flags: [] },
});
assert(labelled.status === 'proposal' && labelled.changes.length > 0, 'fresh low readiness produces a proposal');
assert(labelled.evidence.some((item) => item.source === 'apple_health' && item.objective === true), 'Apple Health evidence is labelled objective');
assert(!labelled.evidence.some((item) => ['checkin', 'post_run_checkin'].includes(item.source)), 'subjective check-in fields do not enter objective recovery evidence');
assert(adaptation.proposalMatchesPlanVersion(labelled, 'v1') && !adaptation.proposalMatchesPlanVersion(labelled, 'v2'), 'pure plan-version check models stale proposal conflict');

const passiveLoadPlan = clone(army);
setHardRun(passiveLoadPlan, '2026-07-14', 'passive-load-run');
const passiveLoad = adaptation.buildAdaptationProposal({
  plan: passiveLoadPlan,
  planningDateISO: '2026-07-13',
  recentRunLoad: {
    protectiveRun: {
      date: '2026-07-12',
      distanceMiles: 7.3,
      durationMinutes: 75,
      paceLabel: '10:16/mi',
      avgHeartRate: 148,
      daysSince: 1,
    },
    protection: {
      active: true,
      noAdditionalRunOnDate: null,
      hardRunsThrough: '2026-07-15',
      lowerBodyThrough: '2026-07-15',
      upperBodyOptionalThrough: '2026-07-14',
      postRunSevere: false,
    },
  },
});
assert(passiveLoad.status === 'proposal' && passiveLoad.changes.some((change) => change.sessionId === 'passive-load-run'), 'passive recent training load can create the allowed bounded proposal');
assert(passiveLoad.evidence.some((item) => item.source === 'recent_run' && item.objective === true), 'passive recent-load evidence is labelled objective');

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

section('graded structured injury and soreness downshift');
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
    openInjuries: [{ bodyPart: 'calf', pain_level: 5, date: '2026-07-11', active: true, notes: 'calf soreness' }],
  },
});
const moderateRunChange = moderateInjury.changes.find((change) => change.sessionId === 'moderate-calf-run');
const expectedModerateMiles = Math.max(0.5, Math.round(Number(moderateRunChange?.before.distance_miles || 0) * 0.75 * 10) / 10);
assert(moderateInjury.status === 'proposal' && !moderateInjury.safetyException, 'structured open moderate injury/soreness downshifts without forcing full rest');
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
  checkin: {
    legs: 1,
    feeling: 3,
    drive: 2,
    sleep_hours: null,
    time_available: 60,
    life_flags: [],
    perceived_effort: 10,
    pain_level: 10,
    post_energy: 'low',
  },
});
const heavyLegsBaseline = adaptation.buildAdaptationProposal({
  plan: heavyLegsPlan,
  planningDateISO: '2026-07-13',
});
assert(JSON.stringify(heavyLegs) === JSON.stringify(heavyLegsBaseline), 'subjective heavy legs, effort, pain, and energy leave the adaptation result unchanged');
assert(heavyLegs.status === 'keep' && heavyLegs.changes.length === 0, 'subjective heavy legs cannot trim or replace a hard session');
assert(!heavyLegs.evidence.some((item) => ['checkin', 'post_run_checkin'].includes(item.source)), 'heavy-legs questionnaire input is absent from adaptation evidence');

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
const attributedChange = normal.changes[0];
const attributedDay = dayByDate(applied, attributedChange.date);
const attributedSession = schema.daySessions(attributedDay)
  .find((session) => String(session.id) === String(attributedChange.sessionId));
assert(attributedSession?.adjusted === true, 'accepted schema-v2 adaptation persists its adjusted marker');
assert(attributedSession?.adjustment_reason === attributedChange.summary, 'accepted schema-v2 adaptation persists the exact reviewed change summary');
const floor = Number(army.strengthPolicy.minimumSessionsPerWeek);
assert(liftCounts(applied).every((count, index) => army.weeks[index].phase === 'race' || count >= floor), 'hybrid strength floor is preserved');
const kept = adaptation.applyProposalToPlan(army, noData);
assert(JSON.stringify(kept) === JSON.stringify(army), 'keep proposal applies as byte-equal original');
const appliedTwice = adaptation.applyProposalToPlan(applied, normal);
assert(JSON.stringify(appliedTwice) === JSON.stringify(applied), 'applying same proposal twice is idempotent');

const legacyPlan = {
  weeks: [{ sessions: [{
    id: 'legacy-tempo',
    date: '2026-07-13',
    day: 'Mon',
    type: 'tempo',
    workout_type: 'run',
    title: 'Legacy tempo',
    distance_miles: 4,
  }] }],
};
const legacySummary = 'Legacy tempo changes to an easy run from the accepted recovery proposal.';
const legacyApplied = adaptation.applyProposalToPlan(legacyPlan, {
  changes: [{
    date: '2026-07-13',
    sessionId: 'legacy-tempo',
    summary: legacySummary,
    after: {
      id: 'legacy-tempo',
      date: '2026-07-13',
      day: 'Mon',
      type: 'easy',
      workout_type: 'run',
      title: 'Easy run',
      distance_miles: 3,
    },
  }],
});
const legacyEntry = legacyApplied.weeks[0].sessions[0];
assert(legacyEntry.adjusted === true, 'accepted legacy adaptation persists its adjusted marker');
assert(legacyEntry.adjustment_reason === legacySummary, 'accepted legacy adaptation persists the exact reviewed change summary');

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
