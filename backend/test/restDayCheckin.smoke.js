#!/usr/bin/env node

const assert = require('node:assert/strict');
const checkinRouter = require('../src/routes/checkin');

const ownerId = 'rest-day-checkin-owner';
const planningDate = '2026-08-14';

function assignedPlan(day, overrides = {}) {
  const planData = overrides.planData || {
    schema_version: 2,
    weeks: [{
      week: 1,
      days: [day],
    }],
  };
  return {
    user_plan_id: 'up-rest-checkin',
    plan_id: 'tp-rest-checkin',
    id: 'tp-rest-checkin',
    status: 'active',
    started_at: overrides.startedAt || planningDate,
    effective_from: overrides.startedAt || planningDate,
    progress_json: JSON.stringify(overrides.progress || {}),
    plan_data: JSON.stringify(planData),
  };
}

function databaseFor(day, overrides = {}) {
  const row = assignedPlan(day, overrides);
  return {
    get: async (sql, params = []) => {
      assert.equal(params.includes(ownerId), true, 'check-in plan reads stay owner-scoped');
      if (/up\.status\s*=\s*'active'/.test(sql)) return { ...row };
      return null;
    },
  };
}

const feelGreat = {
  feeling: 5,
  legs: 3,
  drive: 3,
  time_available: 60,
  life_flags: ['all_good'],
};

async function run() {
  const restDay = {
    id: 'rest-2026-08-14',
    date: planningDate,
    day: 'Fri',
    type: 'rest',
    rest: true,
    sessions: [],
  };
  assert.deepEqual(
    checkinRouter._test.resolveTodayPlanState(JSON.parse(assignedPlan(restDay).plan_data), planningDate),
    { hasPlannedDay: true, isRestDay: true, day: null },
    'check-in distinguishes a scheduled rest day from a missing plan day'
  );

  const restDirective = await checkinRouter._test.computeCheckinDirective(
    ownerId,
    feelGreat,
    databaseFor(restDay),
    { planningDateLocal: planningDate }
  );
  assert.equal(restDirective.action, 'keep', 'fresh legs and high drive never derive a rest action');
  assert.equal(restDirective.plannedRestDay, true, 'the directive preserves the scheduled-rest provenance');
  assert.equal(restDirective.hasWorkoutToday, false, 'a rest day never creates a phantom workout override');
  assert.equal(restDirective.headline, 'Rest day stays scheduled');
  assert.match(restDirective.adjustment, /did not add an unplanned workout/i);
  assert.match(restDirective.adjustment, /move a missed session/i);

  const runDay = {
    id: 'run-day-2026-08-14',
    date: planningDate,
    day: 'Fri',
    sessions: [{
      id: 'easy-run-2026-08-14',
      type: 'easy_run',
      title: 'Easy run',
      duration_minutes: 40,
      distance_miles: 4,
      target_zone: 'Zone 2',
    }],
  };
  const runDirective = await checkinRouter._test.computeCheckinDirective(
    ownerId,
    feelGreat,
    databaseFor(runDay),
    { planningDateLocal: planningDate }
  );
  assert.equal(runDirective.action, 'keep', 'feel-great check-in keeps a scheduled workout');
  assert.equal(runDirective.plannedRestDay, false);
  assert.equal(runDirective.hasWorkoutToday, true);
  assert.doesNotMatch(runDirective.headline, /rest/i, 'feel-great does not manufacture a rest result');

  const removablePlan = {
    schemaVersion: 2,
    startDate: planningDate,
    weeks: [{
      week: 1,
      days: [runDay],
    }],
  };
  const identified = require('../src/lib/planSchema').withRemovalSessionIdentities(removablePlan, { assignmentStart: planningDate });
  const identifiedDay = identified.weeks[0].days[0];
  const removalMarker = require('../src/lib/planSchema').removalSessionIdentifier(identifiedDay, identifiedDay.sessions[0]);
  assert(removalMarker, 'test plan resolves a stable removal marker');
  const removedDirective = await checkinRouter._test.computeCheckinDirective(
    ownerId,
    feelGreat,
    databaseFor(runDay, { planData: removablePlan, progress: { removedSessionIds: [removalMarker] } }),
    { planningDateLocal: planningDate }
  );
  assert.equal(removedDirective.plannedRestDay, false, 'an emptied-by-removal day is not relabeled as planned rest');
  assert.equal(removedDirective.hasWorkoutToday, false, 'removed session stays absent from the visible plan');
  assert.equal(removedDirective.headline, 'No active workout to adjust');
  assert.equal(
    require('../src/lib/dailyExecution').restSourceForPlanEntries(identifiedDay, { ...identifiedDay, sessions: [] }),
    'removed',
    'canonical /plans/today provenance distinguishes a removed-empty day'
  );
  assert.equal(
    require('../src/lib/dailyExecution').restSourceForPlanEntries(restDay, restDay),
    'planned',
    'canonical /plans/today provenance identifies an authored rest day'
  );

  const undatedMultiweekPlan = {
    schemaVersion: 2,
    startDate: '2026-08-03',
    weeks: [
      { week: 1, days: [{ day: 'Fri', sessions: [{ id: 'week-1-friday-run', kind: 'run', duration_minutes: 35 }] }] },
      { week: 2, days: [{ day: 'Fri', type: 'rest', rest: true, sessions: [] }] },
    ],
  };
  const undatedViews = checkinRouter._test.activePlanViews({ row: assignedPlan(null, {
    planData: undatedMultiweekPlan,
    startedAt: '2026-08-03',
  }) });
  assert.equal(undatedViews.storedPlan.weeks[1].days[0].date, planningDate, 'assignment normalization dates the correct later week');
  const laterWeekDirective = await checkinRouter._test.computeCheckinDirective(
    ownerId,
    feelGreat,
    databaseFor(null, { planData: undatedMultiweekPlan, startedAt: '2026-08-03' }),
    { planningDateLocal: planningDate }
  );
  assert.equal(laterWeekDirective.plannedRestDay, true, 'check-in selects the canonical later-week rest day, not the first matching weekday');
  assert.equal(laterWeekDirective.hasWorkoutToday, false);

  console.log('REST-DAY CHECK-IN SMOKE OK (24)');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
