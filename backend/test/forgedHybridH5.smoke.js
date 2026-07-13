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

section('screen consumers wire the shared daily-execution service (static)');
const fs = require('fs');
const path = require('path');
const FE = path.join(__dirname, '..', '..', 'frontend', 'src');
function read(rel) { try { return fs.readFileSync(path.join(FE, rel), 'utf8'); } catch { return ''; } }
const dashboard = read('pages/Dashboard.jsx');
const logRun = read('pages/LogRun.jsx');
const warmup = read('pages/Warmup.jsx');
const activeRun = read('pages/ActiveRun.jsx');
const logLift = read('pages/LogLift.jsx');
const activeWorkout = read('pages/ActiveWorkout.jsx');
const plan = read('pages/Plan.jsx');
const forgedDayView = read('components/calendar/ForgedDayView.jsx');

assert(/from '\.\.\/lib\/dailyExecution'/.test(dashboard) && /recommendationFromExecution/.test(dashboard), 'Dashboard imports the shared service + calendar recommendation');
assert(/from '\.\.\/lib\/dailyExecution'/.test(logRun) && /scheduledRunFromExecution/.test(logRun), 'LogRun imports the shared service + scheduled run');
assert(/from '\.\.\/lib\/dailyExecution'/.test(logLift) && /scheduledLiftFromExecution/.test(logLift), 'LogLift imports the shared service + scheduled lift');
assert(/from '\.\.\/lib\/dailyExecution'/.test(activeRun) && /markSessionComplete/.test(activeRun), 'ActiveRun imports markSessionComplete');
assert(/from '\.\.\/lib\/dailyExecution'/.test(activeWorkout) && /markSessionComplete/.test(activeWorkout), 'ActiveWorkout imports markSessionComplete');
assert(/location\.state/.test(warmup) && /navigate\('\/log-run'/.test(warmup), 'Warmup forwards location.state through the run handoff');
assert(/onStartRun\?\.\(runSession\)/.test(forgedDayView) && /onStartLift\?\.\(liftSession\)/.test(forgedDayView), 'ForgedDayView passes the selected session to start handlers');
assert(/planSessionId/.test(plan) && /scheduledRun/.test(plan), 'Plan hands the selected session id + prescription into navigate state');

section('completion is called ONLY on the success path (static)');
// lastIndexOf targets the CALL SITE (the import line is the first occurrence).
// ActiveRun: markSessionComplete must sit inside the durable-save success block
// (after runId truthy), before the outer save catch; queueSessionComplete only
// after the queued run request.
assert(activeRun.indexOf('if (runId) {') < activeRun.lastIndexOf('markSessionComplete') && activeRun.lastIndexOf('markSessionComplete') < activeRun.indexOf("Failed to save run"), 'ActiveRun completion is inside the runId success block, before the save catch');
assert(activeRun.indexOf("queueRequest('/api/runs', 'POST', payload)") < activeRun.lastIndexOf('queueSessionComplete'), 'ActiveRun offline completion is queued AFTER the run request');
// LogRun: online completion after setShowPostCheckIn(true); offline completion after queueRequest.
assert(logRun.indexOf('setShowPostCheckIn(true)') < logRun.lastIndexOf('markSessionComplete'), 'LogRun online completion runs after the successful save');
assert((logRun.match(/queueSessionComplete\(/g) || []).length >= 2, 'LogRun queues completion on both offline branches');
// ActiveWorkout: completion only after the end PUT resolves, before summary nav.
assert(activeWorkout.indexOf('/end`, {})') < activeWorkout.lastIndexOf('markSessionComplete') && activeWorkout.lastIndexOf('markSessionComplete') < activeWorkout.indexOf('navigate(`/workout/summary/'), 'ActiveWorkout completion sits between a successful end and the summary nav');
// No completion helper is fired before a save/end in any consumer.
assert(!/markSessionComplete[\s\S]{0,120}await api\.(post|put)\('\/(runs|workouts)/.test(activeRun), 'ActiveRun never completes before the save call');

console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
if (failed) process.exit(1);
console.log('H5 SMOKE OK');
