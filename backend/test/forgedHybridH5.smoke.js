// Forged Hybrid H5 unified daily execution smoke.
// Run: node backend/test/forgedHybridH5.smoke.js
//
// DB-free: exercises the pure daily-execution helpers that back GET /plans/today.
// Completion ownership/idempotency at the route level is enforced by the
// req.user.id-scoped PUT /plans/my/progress (Set-based); here we prove the
// display-side completion mapping and the exact-date/HR-zone logic.

const exec = require('../src/lib/dailyExecution');
const schema = require('../src/lib/planSchema');

let passed = 0;
let failed = 0;
function assert(condition, message) {
  if (condition) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${message}`); }
}
function section(name) { console.log(`\n== ${name} ==`); }

const hybridPlan = {
  schemaVersion: 2,
  planMode: 'hybrid_maintain',
  goal: { kind: 'race', name: 'Army Ten-Miler', date: '2026-10-11', distanceMiles: 10, goalType: 'pr' },
  weeks: [
    {
      week: 1,
      phase: 'base',
      startDate: '2026-07-13',
      days: [
        {
          date: '2026-07-13',
          day: 'Mon',
          sessions: [
            { id: 'run-1', kind: 'run', prescription: { workout_type: 'easy', distance_miles: 4, target_zone: 'Z2', description: 'Easy Zone 2' } },
            { id: 'lift-1', kind: 'lift', prescription: { title: 'Lower Body', sets: 3, reps: 5, rest_seconds: 180, rpe: 8, focus: 'squat' } },
          ],
          orderGuidance: 'Run first; lift at least 6 hours later',
          status: 'planned',
        },
        { date: '2026-07-14', day: 'Tue', sessions: [{ id: 'run-2', kind: 'run', prescription: { workout_type: 'intervals', distance_miles: 6, target_zone: 'Z4' } }] },
        { date: '2026-07-15', day: 'Wed', sessions: [] },
      ],
    },
    {
      week: 2,
      phase: 'base',
      startDate: '2026-07-20',
      days: [
        { date: '2026-07-21', day: 'Tue', sessions: [{ id: 'run-3', kind: 'run', prescription: { workout_type: 'tempo', distance_miles: 5, target_zone: 'Z3' } }] },
      ],
    },
  ],
};

const legacyPlan = {
  weeks: [
    {
      week: 1,
      days: [
        { day: 'Mon', type: 'run', workout_type: 'easy', distance_miles: 4, target_zone: 'Z2', description: 'Easy run' },
        { day: 'Tue', type: 'rest', workout_type: 'rest' },
      ],
    },
  ],
};

const hrrProfile = { max_hr: 190, resting_hr: 50, lthr: null, zone_model: 'hrr' };

function build(plan, dateISO, weekdayShort, completedSessionIds, hrProfile) {
  const selection = exec.selectDayForDate(plan, dateISO, weekdayShort);
  return exec.buildDailyExecution({
    plan,
    dateISO,
    weekdayShort,
    selectedEntry: selection ? selection.entry : null,
    selectedWeek: selection ? selection.week : null,
    completedSessionIds: completedSessionIds || [],
    hrProfile: hrProfile || null,
  });
}

section('exact-date selection (not first weekday across weeks)');
const wk2 = exec.selectDayForDate(hybridPlan, '2026-07-21', 'Tue');
assert(wk2 && wk2.entry.date === '2026-07-21' && wk2.entry.sessions[0].id === 'run-3', 'Tuesday resolves to week 2 dated day, not week 1');
const wk1 = exec.selectDayForDate(hybridPlan, '2026-07-14', 'Tue');
assert(wk1 && wk1.entry.date === '2026-07-14' && wk1.entry.sessions[0].id === 'run-2', 'week-1 Tuesday still resolves to its own dated day');

section('hybrid all-session response');
const monday = build(hybridPlan, '2026-07-13', 'Mon', [], hrrProfile);
assert(monday.hasPlan && monday.hasDay && monday.isRest === false, 'monday is an executable plan day');
assert(monday.sessions.length === 2, 'hybrid day exposes BOTH sessions (no flatten to one)');
assert(monday.run && monday.run.id === 'run-1' && monday.lift && monday.lift.id === 'lift-1', 'run and lift both surfaced with stable ids');
assert(monday.lift.sets === 3 && monday.lift.reps === 5 && monday.lift.rpe === 8, 'lift prescription (sets/reps/rpe) preserved');
assert(monday.mode === 'hybrid_maintain' && monday.phase === 'base' && monday.week === 1, 'plan/phase/week context present');
assert(monday.goal && monday.goal.name === 'Army Ten-Miler', 'goal context present');

section('rest day makes no fake sessions');
const rest = build(hybridPlan, '2026-07-15', 'Wed', [], hrrProfile);
assert(rest.hasDay && rest.isRest === true && rest.sessions.length === 0, 'rest day is rest with zero sessions');
assert(rest.run === null && rest.lift === null, 'rest day exposes no run or lift');

section('local date validation helper');
assert(exec.weekdayShortForDate('2026-07-13') === 'Mon', 'valid date resolves weekday');
assert(exec.weekdayShortForDate('not-a-date') === null, 'garbage date returns null');
assert(exec.weekdayShortForDate('2026-13-99') === null, 'impossible date returns null');

section('personalized BPM and no-profile fallback');
const z2 = exec.resolveHrZone('Z2', hrrProfile);
assert(z2 && z2.zone === 2 && Number.isFinite(z2.minBpm) && Number.isFinite(z2.maxBpm) && z2.minBpm < z2.maxBpm, 'Z2 resolves to a calibrated bpm band');
assert(z2.source === 'calibrated', 'resolved band is flagged calibrated');
assert(exec.resolveHrZone('Z2', null) === null, 'no profile -> no invented bpm');
assert(exec.resolveHrZone('Z2', { zone_model: 'hrr', max_hr: null, resting_hr: null }) === null, 'incomplete profile -> no invented bpm');
assert(monday.run.hrZone && monday.run.hrZone.zone === 2, 'run session carries resolved hrZone when profile present');
const noProfile = build(hybridPlan, '2026-07-13', 'Mon', [], null);
assert(noProfile.run.hrZone === null, 'run session hrZone is null when no profile');
assert(exec.zoneNumberFromLabel('Zone 3') === 3 && exec.zoneNumberFromLabel(4) === 4 && exec.zoneNumberFromLabel('easy') === null, 'zone label parsing');

section('completion display mapping + idempotency');
const withRunDone = build(hybridPlan, '2026-07-13', 'Mon', ['run-1'], hrrProfile);
assert(withRunDone.run.completed === true && withRunDone.lift.completed === false, 'only the completed session id is marked complete');
const idempotent = build(hybridPlan, '2026-07-13', 'Mon', ['run-1', 'run-1'], hrrProfile);
assert(idempotent.run.completed === true, 'duplicate completion ids are idempotent');
const foreignId = build(hybridPlan, '2026-07-13', 'Mon', ['some-other-users-session'], hrrProfile);
assert(foreignId.run.completed === false && foreignId.lift.completed === false, 'unrelated session ids never mark this plan complete');

section('legacy plan compatibility');
const legacyMon = build(legacyPlan, '2026-07-13', 'Mon', [], hrrProfile);
assert(legacyMon.hasDay && !legacyMon.isRest && legacyMon.run && legacyMon.run.kind === 'run', 'legacy weekday run day resolves via weekday fallback');
assert(legacyMon.mode === 'run_only', 'legacy run-only plan inferred as run_only');
const legacyRest = build(legacyPlan, '2026-07-14', 'Tue', [], hrrProfile);
assert(legacyRest.hasDay && legacyRest.isRest === true, 'legacy rest day resolves as rest');
assert(schema.getPlanMode(legacyPlan) === 'run_only', 'schema mode inference unchanged for legacy plan');

console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
if (failed) process.exit(1);
console.log('H5 SMOKE OK');
