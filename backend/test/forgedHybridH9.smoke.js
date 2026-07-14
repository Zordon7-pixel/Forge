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
    date: '2026-07-13', type: 'easy', watch_activity_type: 'Running', distance_miles: 7.312, duration_seconds: 5097, perceived_effort: 5,
    avg_heart_rate: 150, pace_avg: null, health_source: 'apple_health', created_at: '2026-07-13T15:49:36.728Z',
  },
  {
    date: '2026-07-13', type: 'walk', watch_activity_type: 'Walking', distance_miles: 0.287, duration_seconds: 369, perceived_effort: 5,
    avg_heart_rate: 129, pace_avg: null, health_source: 'apple_health', created_at: '2026-07-13T18:26:25.120Z',
  },
  {
    date: '2026-07-03', type: 'easy', watch_activity_type: 'Running', distance_miles: 3.115, duration_seconds: 2027, perceived_effort: 5,
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
check(acute.sevenDayMiles === 7.3 && acute.loadRatio === 0.8, 'seven-day run load excludes the later Apple Health walk');
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
check(!protectedSessions.some(({ week, session }) => week.week === 1 && (session.type === 'long' || concurrent.isHardRun(session))), 'a completed long run leaves only easy remaining running in the current week');
check((protectedPlan.weeks[0].days.find((day) => day.date === '2026-07-14')?.whyToday || '').includes('7.3 mi'), 'day view explains the exact recent-run reason');
check(protectedPlan.inputSummary.recentRun?.paceLabel === '11:37/mi', 'persisted input summary records the run used by planning');
check(protectedPlan.inputSummary.appleHealth?.readinessScore === 58 && protectedPlan.inputSummary.checkin?.feeling === 3, 'persisted input summary records Apple Health and check-in inputs');
const acceptedProtected = concurrent.selectPlanCandidate(protectedPlan, context);
check(acceptedProtected.source === 'ai_validated', 'a candidate that already respects recent-run protection is accepted');
check(acceptedProtected.plan.acuteLoadAdjustment?.latestRun?.distanceMiles === 7.312, 'accepted candidates retain acute-load provenance');

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

section('lower-body strength preservation');
const swappedCandidate = JSON.parse(JSON.stringify(unsafeCandidate));
const swappedWednesday = swappedCandidate.weeks[0].days.find((day) => day.date === '2026-07-15');
const swappedThursday = swappedCandidate.weeks[0].days.find((day) => day.date === '2026-07-16');
const originalUpper = swappedWednesday.sessions.find((session) => session.kind === 'lift');
const originalLower = swappedThursday.sessions.find((session) => session.kind === 'lift');
swappedWednesday.sessions = swappedWednesday.sessions.filter((session) => session.kind !== 'lift').concat(originalLower);
swappedThursday.sessions = swappedThursday.sessions.filter((session) => session.kind !== 'lift').concat(originalUpper);
const swappedPlan = concurrent.applyAcuteRunProtection(swappedCandidate, context);
const swappedSessions = sessions(swappedPlan);
check(swappedSessions.some(({ day, session }) => day.date === '2026-07-15' && session.kind === 'lift' && /upper/i.test(session.focus)), 'a protected lower lift swaps with an existing safe later upper lift');
check(swappedSessions.some(({ day, session }) => day.date === '2026-07-16' && session.kind === 'lift' && /lower/i.test(session.focus)), 'the lower-body stimulus lands outside the protected window after a swap');

const relocatedCandidate = JSON.parse(JSON.stringify(unsafeCandidate));
const relocatedMonday = relocatedCandidate.weeks[0].days.find((day) => day.date === '2026-07-13');
const relocatedWednesday = relocatedCandidate.weeks[0].days.find((day) => day.date === '2026-07-15');
const relocatedThursday = relocatedCandidate.weeks[0].days.find((day) => day.date === '2026-07-16');
const relocatedUpper = relocatedWednesday.sessions.find((session) => session.kind === 'lift');
const relocatedLower = relocatedThursday.sessions.find((session) => session.kind === 'lift');
relocatedMonday.sessions.push(relocatedUpper);
relocatedWednesday.sessions = relocatedWednesday.sessions.filter((session) => session.kind !== 'lift').concat(relocatedLower);
relocatedThursday.sessions = relocatedThursday.sessions.filter((session) => session.kind !== 'lift');
const relocatedPlan = concurrent.applyAcuteRunProtection(relocatedCandidate, context);
const relocatedSessions = sessions(relocatedPlan);
check(!relocatedSessions.some(({ day, session }) => day.date <= '2026-07-15' && session.kind === 'lift' && /lower/i.test(session.focus)), 'relocation clears lower-body work from the protected window');
check(relocatedSessions.some(({ day, session }) => day.date === '2026-07-16' && session.id === relocatedLower.id && /lower/i.test(session.focus)), 'a lower lift with no later upper partner moves intact to a safe available day');
check(relocatedPlan.weeks[0].days.find((day) => day.date === '2026-07-16').whyToday.includes('strength floor'), 'relocation explains that the weekly strength floor was preserved');

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
const yesterday = recentRuns.summarizeRecentRunLoad(rows, { todayISO: '2026-07-14', weeklyBaseline: 9.1, recoveryState: 'caution' });
check(yesterday.protection.active && yesterday.latestRun.daysSince === 1, 'yesterday\'s long run keeps the remaining protection window active');
check(yesterday.protection.noAdditionalRunOnDate === null && yesterday.protection.hardRunsThrough === '2026-07-15', 'yesterday does not block today as a duplicate while preserving hard-run protection');
const afterRecovery = recentRuns.summarizeRecentRunLoad(rows.concat({
  date: '2026-07-14', type: 'easy', watch_activity_type: 'Running', distance_miles: 2.173, duration_seconds: 1531,
  avg_heart_rate: 138, health_source: 'apple_health', created_at: '2026-07-14T12:52:00.000Z',
}), { todayISO: '2026-07-14', weeklyBaseline: 11.4, recoveryState: 'caution' });
check(afterRecovery.latestRun.distanceMiles === 2.173, 'the most recent recovery run remains the latest-run truth');
check(afterRecovery.protectiveRun.distanceMiles === 7.312 && afterRecovery.protection.anchorDate === '2026-07-13', 'a short recovery run does not hide yesterday\'s long-run protection anchor');
check(afterRecovery.protection.noAdditionalRunOnDate === '2026-07-14' && afterRecovery.protection.hardRunsThrough === '2026-07-15', 'today\'s run blocks a duplicate while the prior long run controls the hard-session window');
check(afterRecovery.currentWeek.miles === 9.5 && afterRecovery.currentWeek.longRunCompleted, 'current-week load records both runs and recognizes that the long run is already complete');
const recoveryWeekContext = {
  ...context,
  todayISO: '2026-07-14',
  target: { ...context.target, startDate: '2026-07-13', raceDate: '2026-10-11', weeks: 13 },
  history: { ...context.history, weeklyMileageBaseline: 11.4, acuteRunLoad: afterRecovery },
};
const recoveryWeekPlan = concurrent.buildConcurrentPlan(recoveryWeekContext);
const recoveryWeekValidation = concurrent.validateConcurrentPlan(recoveryWeekPlan, recoveryWeekContext);
const recoveryWeekRuns = sessions(recoveryWeekPlan).filter(({ week, session }) => week.week === 1 && session.kind === 'run');
check(recoveryWeekValidation.valid, `a midweek regeneration validates against completed-plus-planned load: ${recoveryWeekValidation.errors.join('; ')}`);
check(recoveryWeekRuns.every(({ day }) => day.date > '2026-07-14'), 'a regenerated plan does not schedule replacement runs on already completed or past dates');
check(!recoveryWeekRuns.some(({ session }) => session.type === 'long'), 'a completed 7.3-mile long run prevents a second long run in the same week');
check(recoveryWeekPlan.weeks[0].completedMilesAtGeneration === 9.5, 'the plan records current-week completed mileage separately from remaining prescriptions');
const stale = recentRuns.summarizeRecentRunLoad(rows, { todayISO: '2026-07-17', weeklyBaseline: 9.1, recoveryState: 'caution' });
check(stale.available && !stale.protection.active, 'run older than 72 hours remains visible but does not alter the plan');

console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
if (failed) process.exit(1);
console.log('H9 SMOKE OK');
