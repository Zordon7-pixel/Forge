const assert = require('node:assert/strict');
const {
  computeHybridStreak,
  detectHybridMilestones,
  filterNewHybridMilestones,
} = require('../src/lib/streaks');

function run(date, miles = 2) {
  return {
    date,
    distance_miles: miles,
    duration_seconds: miles * 600,
    type: 'easy',
  };
}

function lift(date) {
  return {
    date,
    exercise_name: 'Back Squat',
    sets: 3,
    reps: 8,
    weight_lbs: 95,
  };
}

function plan(days, currentWeek = 1) {
  return {
    row: {
      week_start: '2026-07-13',
      current_week: currentWeek,
      progress_json: '{}',
      plan_json: JSON.stringify({
        weeks: [
          {
            week: 1,
            startDate: '2026-07-13',
            phase: 'base',
            days,
          },
        ],
      }),
    },
  };
}

const mixedWeekPlan = plan([
  { day: 'Mon', sessions: [{ id: 'mon-run', kind: 'run', distance_miles: 2 }] },
  { day: 'Tue', type: 'rest', title: 'Recovery day' },
  { day: 'Wed', sessions: [{ id: 'wed-lift', kind: 'lift', title: 'Strength' }] },
  { day: 'Thu', sessions: [{ id: 'thu-run', kind: 'run', distance_miles: 2 }] },
  { day: 'Fri', sessions: [{ id: 'fri-lift', kind: 'lift', title: 'Strength' }] },
  { day: 'Sat', type: 'rest', title: 'Recovery day' },
  { day: 'Sun', sessions: [{ id: 'sun-run', kind: 'run', distance_miles: 2 }] },
]);

const qualifying = computeHybridStreak({
  activePlan: mixedWeekPlan,
  runs: [run('2026-07-13'), run('2026-07-16')],
  lifts: [lift('2026-07-15')],
  now: new Date('2026-07-16T12:00:00Z'),
});

assert.equal(qualifying.currentStreak, 4, 'scheduled run/rest/lift/run should build a 4-day streak');
assert.equal(qualifying.longestStreak, 4, 'longest streak should include qualifying days plus rest grace');
assert.equal(qualifying.unit, 'day');
assert.equal(qualifying.graceUsed, true, 'planned rest day should use grace without breaking the streak');
assert.equal(
  qualifying.states.find((state) => state.date === '2026-07-14')?.reason,
  'planned_rest_grace',
  'the planned rest day should be the grace day'
);

const broken = computeHybridStreak({
  activePlan: mixedWeekPlan,
  runs: [run('2026-07-13'), run('2026-07-16')],
  lifts: [lift('2026-07-15')],
  now: new Date('2026-07-18T12:00:00Z'),
});

assert.equal(broken.currentStreak, 0, 'a true missed scheduled lift after grace is spent should break the current streak');
assert.equal(
  broken.states.find((state) => state.date === '2026-07-17')?.reason,
  'missed_required_activity',
  'missed scheduled modality should not count as balanced activity'
);

const runOnlyUnplanned = computeHybridStreak({
  runs: ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18', '2026-07-19'].map((date) => run(date)),
  lifts: [],
  now: new Date('2026-07-19T12:00:00Z'),
});

assert.equal(runOnlyUnplanned.currentStreak, 0, 'unplanned run-only activity should not max a hybrid streak');
assert.equal(runOnlyUnplanned.longestStreak, 0, 'unplanned default requires run and lift balance');

const sevenDayPlan = plan([
  { day: 'Mon', sessions: [{ id: 'd1-run', kind: 'run' }] },
  { day: 'Tue', sessions: [{ id: 'd2-lift', kind: 'lift' }] },
  { day: 'Wed', sessions: [{ id: 'd3-run', kind: 'run' }] },
  { day: 'Thu', sessions: [{ id: 'd4-lift', kind: 'lift' }] },
  { day: 'Fri', sessions: [{ id: 'd5-run', kind: 'run' }] },
  { day: 'Sat', sessions: [{ id: 'd6-lift', kind: 'lift' }] },
  { day: 'Sun', sessions: [{ id: 'd7-run', kind: 'run' }] },
]);
const sevenDayRuns = ['2026-07-13', '2026-07-15', '2026-07-17', '2026-07-19'].map((date) => run(date, 1.5));
const sevenDayLifts = ['2026-07-14', '2026-07-16', '2026-07-18'].map((date) => lift(date));
const sevenDayStreak = computeHybridStreak({
  activePlan: sevenDayPlan,
  runs: sevenDayRuns,
  lifts: sevenDayLifts,
  now: new Date('2026-07-19T12:00:00Z'),
});
const candidates = detectHybridMilestones({
  streak: sevenDayStreak,
  runs: sevenDayRuns,
  lifts: sevenDayLifts,
  activePlan: sevenDayPlan,
});
const firstFire = filterNewHybridMilestones(candidates, new Set());
const secondFire = filterNewHybridMilestones(candidates, new Set(firstFire.map((milestone) => milestone.key)));

assert.equal(firstFire.length, 1, 'the 7-day hybrid streak milestone should fire once on first crossing');
assert.equal(firstFire[0].key, 'hybrid_streak_7');
assert.equal(secondFire.length, 0, 'seen milestone keys should not fire again');

console.log('hybridStreaks smoke passed');
