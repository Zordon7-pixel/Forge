const assert = require('node:assert/strict');
const plans = require('../src/routes/plans')._test;
const { canonicalHash } = require('../src/lib/racePlanPolicy');
const { racePlanWindow } = require('../src/lib/concurrentPlan');

function scenario(options = {}) {
  const date = options.date || '2026-09-07';
  const raceDate = options.raceDate || '2026-10-11';
  const owner = 'synthetic-plan-completeness';
  const miles = options.miles ?? 14;
  const count = options.count ?? 8;
  const runDays = options.runDays || ['Tue', 'Thu', 'Sat', 'Sun'];
  const liftDays = options.liftDays ?? 2;
  const race = {
    id: 'synthetic-army-10-miler', user_id: owner, race_name: 'Army 10-Miler',
    race_date: raceDate, event_local_date: raceDate, event_timezone: 'America/New_York',
    event_kind: 'run_race', distance_miles: 10, goal_time_seconds: options.goalTimeSeconds || 5400,
    location: 'Washington, DC', status: 'upcoming',
  };
  const window = racePlanWindow(raceDate, date);
  const target = {
    raceDate, raceId: race.id, raceName: race.race_name, distanceMiles: 10,
    goalTimeSeconds: options.goalTimeSeconds || 5400, goalType: 'pr', trainingDays: runDays,
    runDaysPerWeek: runDays.length, liftingEnabled: liftDays > 0,
    liftDaysPerWeek: liftDays, planMode: liftDays > 0 ? 'hybrid_maintain' : 'run_only',
    strengthGoal: 'maintain', equipment: ['barbell', 'dumbbell', 'rack', 'bench', 'cable', 'machines'],
    weeks: window.weeks, startDate: window.startDate, todayISO: date,
    nowISO: `${date}T12:00:00.000Z`,
  };
  target.raceTargets = [{
    raceDate, raceId: race.id, raceName: race.race_name, distanceMiles: 10,
    goalTimeSeconds: options.goalTimeSeconds || 5400, goalType: 'pr',
  }];
  const currentWeek = {
    startDate: racePlanWindow(date, date).startDate, miles: 0,
    knownDistanceLowerBoundMiles: 0, distanceState: 'KNOWN', unknownDistanceRunCount: 0,
    runCount: 0, runDates: [], longRunCompleted: false,
  };
  const context = {
    todayISO: date,
    profile: {
      id: owner, timezone: 'America/New_York', weekly_miles_current: miles,
      run_days_per_week: runDays.length, lift_days_per_week: liftDays,
      ...(options.trainingAge ? { training_age_class: options.trainingAge } : {}),
    },
    target,
    history: {
      weeklyMileageBaseline: miles,
      mileageBaseline: { observedLowerBoundWeeklyMiles: miles, meaningfulRunCount: count },
      recentRunCount: count, recentLiftCount: 8,
      acuteRunLoad: { latestRun: { date: '2026-09-06', paceSecondsPerMile: 840 }, currentWeek },
      runLoadInput: {
        load_input_state: 'COMPLETE', load_input_confidence: 'HIGH', recent_normal_confidence: 'HIGH',
        recent_normal: { status: 'ESTABLISHED', median_distance_m: Math.round(miles * 1609.344) },
        windows: [], unresolved_conflicts: [], reason_codes: [],
      },
      previousTwoWeeksPassed: true, modalityHistory: {},
      performanceProfile: { targetAnchor: {
        equivalentTimeSeconds: 5700, date: options.anchorDate || '2025-12-08',
        kind: 'observed_distance_band', runId: 'synthetic-performance-anchor',
      } },
    },
    recovery: { state: 'NORMAL', available: true, metrics: {} },
    safety: { activeInjury: false, comebackMode: false, injuryNotesPresent: false },
  };
  if (options.rawHistory) context.history.recentRuns = options.rawHistory;
  const built = plans.buildDeterministicCandidate(context, { planningDateLocal: date });
  assert.equal(built.validation.valid, true, JSON.stringify(built.validation.errors));
  const state = {
    target, context, races: [race], inputHash: `sha256:${canonicalHash({ target, context })}`,
    planningInputRevision: 1,
    planningConstraints: { locks: [], manual_edits: [], lock_revision: 0, edit_revision: 0, constraint_fingerprint: null },
    active: null, activePlan: null, activeCanonicalCarryForwardSource: null,
    request: { race_ids: [race.id], planning_date_local: date, timezone_offset_minutes: 240 },
  };
  if (options.constructOnly) return { date, raceDate, target, context, state, built, owner };
  const result = plans.computeGoalBackwardShadowDiagnostics({ userId: owner, state, built, planningDateLocal: date });
  const accepted = plans.applicableGoalBackwardPlan(built.plan, result);
  return { date, raceDate, target, context, state, built, result, accepted };
}

function summarize(plan) {
  if (!plan) return null;
  return {
    mode: plan.planMode,
    weeks: plan.weeks.length,
    requestedRunDays: plan.schedulePreferences?.runDaysPerWeek,
    strengthPolicy: plan.strengthPolicy,
    weeklySessions: plan.weeks.map((week) => {
      const sessions = (week.days || []).flatMap((day) => day.sessions || [day]);
      return {
        start: week.startDate,
        dates: (week.days || []).map((day) => day.date),
        runs: sessions.filter((session) => session.kind === 'run').length,
        lifts: sessions.filter((session) => session.kind === 'lift' || /^strength_/.test(session.workout_family || '')).length,
        families: sessions.map((session) => session.workout_family || session.type || session.kind),
      };
    }),
  };
}

module.exports = { scenario, summarize };
