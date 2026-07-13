// Forged Hybrid H9 recent-run load and plan safety smoke.
// Run: node backend/test/forgedHybridH9.smoke.js

const recentRuns = require('../src/lib/recentRunLoad');
const concurrent = require('../src/lib/concurrentPlan');
const adaptation = require('../src/lib/adaptationEngine');

let passed = 0;
let failed = 0;
function check(condition, message) {
  if (condition) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${message}`); }
}
function section(name) { console.log(`\n== ${name} ==`); }
function sessions(plan) { return (plan.weeks || []).flatMap((week) => (week.days || []).flatMap((day) => (day.sessions || []).map((session) => ({ week, day, session })))); }

const rows = [
  {
    date: '2026-07-13', distance_miles: 7.312, duration_seconds: 5097, perceived_effort: 5,
    avg_heart_rate: 150, pace_avg: null, health_source: 'apple_health', created_at: '2026-07-13T15:49:36.728Z',
  },
  {
    date: '2026-07-13', distance_miles: 0.287, duration_seconds: 369, perceived_effort: 5,
    avg_heart_rate: 129, pace_avg: null, health_source: 'apple_health', created_at: '2026-07-13T18:26:25.120Z',
  },
  {
    date: '2026-07-03', distance_miles: 3.115, duration_seconds: 2027, perceived_effort: 5,
    avg_heart_rate: 161, pace_avg: null, health_source: 'apple_health', created_at: '2026-07-08T08:38:03.982Z',
  },
];

section('primary run and computed pace');
const acute = recentRuns.summarizeRecentRunLoad(rows, {
  todayISO: '2026-07-13',
  weeklyBaseline: 9.1,
  recoveryState: 'caution',
});
check(acute.available && acute.latestRun.distanceMiles === 7.312, 'largest meaningful run wins over a later short Apple Health segment');
check(acute.latestRun.paceSecondsPerMile === 697 && acute.latestRun.paceLabel === '11:37/mi', 'pace is computed from duration when pace_avg is absent');
check(acute.sevenDayMiles === 7.6 && acute.loadRatio === 0.84, 'seven-day load includes all valid run segments');
check(acute.latestRun.isLong && !acute.latestRun.isHard, '85-minute 7.3-mile run is long without inventing hard effort');
check(acute.protection.noAdditionalRunOnDate === '2026-07-13', 'same-day duplicate running is blocked');
check(acute.protection.hardRunsThrough === '2026-07-15' && acute.protection.lowerBodyThrough === '2026-07-15', 'caution recovery protects demanding running and lower body for 72 hours');

const context = {
  todayISO: '2026-07-13',
  profile: { weekly_miles_current: 9.1, run_days_per_week: 4, lift_days_per_week: 2 },
  target: {
    weeks: 8,
    startDate: '2026-07-13',
    distanceMiles: 10,
    planMode: 'hybrid_maintain',
    trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    runDaysPerWeek: 4,
    liftDaysPerWeek: 2,
  },
  history: { weeklyMileageBaseline: 9.1, recentRunCount: 28, recentLiftCount: 2, adherenceRate: 0.7, acuteRunLoad: acute },
  recovery: {
    state: 'caution', available: true, readinessScore: 58, syncedAt: '2026-07-13T18:26:00Z',
    metrics: { sleepHoursLastNight: 6.5, hrvMs: 42, restingHeartRate: 59 },
  },
  checkin: { date: '2026-07-13', feeling: 3, legs: 2, drive: 2, sleepHours: 6.5, lifeFlags: [] },
};

section('initial plan protection');
const protectedPlan = concurrent.buildConcurrentPlan(context);
const validation = concurrent.validateConcurrentPlan(protectedPlan, context);
const protectedSessions = sessions(protectedPlan);
check(validation.valid, `protected deterministic plan validates: ${validation.errors.join('; ')}`);
check(!protectedSessions.some(({ day, session }) => day.date === '2026-07-13' && session.kind === 'run'), 'plan does not prescribe a second run on the completed date');
check(!protectedSessions.some(({ day, session }) => day.date <= '2026-07-15' && concurrent.isHardRun(session)), 'no hard run remains inside the protected window');
check(!protectedSessions.some(({ day, session }) => day.date <= '2026-07-15' && session.kind === 'lift' && /lower/i.test(String(session.focus || ''))), 'no lower-body lift remains inside the protected window');
check(protectedSessions.some(({ day, session }) => day.date === '2026-07-14' && session.type === 'recovery'), 'next demanding run becomes an explicit recovery run');
check((protectedPlan.weeks[0].days.find((day) => day.date === '2026-07-14')?.whyToday || '').includes('7.3 mi'), 'day view explains the exact recent-run reason');
check(protectedPlan.inputSummary.recentRun?.paceLabel === '11:37/mi', 'persisted input summary records the run used by planning');
check(protectedPlan.inputSummary.appleHealth?.readinessScore === 58 && protectedPlan.inputSummary.checkin?.feeling === 3, 'persisted input summary records Apple Health and check-in inputs');

section('unsafe AI candidate rejection');
const unsafeContext = {
  ...context,
  history: { ...context.history, acuteRunLoad: null },
  recovery: { state: 'normal', available: false, metrics: {} },
};
const unsafeCandidate = concurrent.buildConcurrentPlan(unsafeContext);
const selected = concurrent.selectPlanCandidate(unsafeCandidate, context);
check(selected.source === 'deterministic_fallback', 'AI candidate that conflicts with recent load is rejected');
check(selected.validationErrors.some((error) => /recent-run/.test(error)), 'AI rejection records the recent-run safety violation');
check(concurrent.validateConcurrentPlan(selected.plan, context).valid, 'selected fallback remains valid after acute protection');

section('live adaptation evidence');
const proposal = adaptation.buildAdaptationProposal({
  plan: unsafeCandidate,
  planningDateISO: '2026-07-13',
  recentRunLoad: acute,
});
check(proposal.status === 'proposal' && proposal.changes.length > 0, 'recent run produces a transparent 72-hour proposal');
check(proposal.evidence.some((item) => item.source === 'recent_run' && item.detail.includes('7.3 mi')), 'proposal shows objective recent-run evidence');
check(proposal.changes.some((change) => change.after?.type === 'recovery'), 'proposal changes demanding running to recovery');
check(proposal.changes.filter((change) => change.after?.type === 'recovery').every((change) =>
  Array.isArray(change.after.steps)
  && change.after.steps.some((step) => /zone 1-2/i.test(step))
  && !change.after.steps.some((step) => /hill|repeat|interval/i.test(step))),
'recovery adaptations replace hard-workout steps instead of retaining hill or interval instructions');
check(proposal.changes.every((change) => change.date <= '2026-07-16'), 'normal recent-run proposal stays inside the 72-hour window');

section('stale run does not overreach');
const stale = recentRuns.summarizeRecentRunLoad(rows, { todayISO: '2026-07-17', weeklyBaseline: 9.1, recoveryState: 'caution' });
check(stale.available && !stale.protection.active, 'run older than 72 hours remains visible but does not alter the plan');

console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
if (failed) process.exit(1);
console.log('H9 SMOKE OK');
