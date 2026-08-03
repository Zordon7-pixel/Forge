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
            {
              id: 'lift-1', kind: 'lift', title: 'Lower Body', focus: 'squat',
              warmup: ['Bodyweight squat x 10'],
              main: [{ name: 'Back squat', sets: 3, reps: 5, rest: '3 min', rpe: 8 }],
              recovery: ['Leave one full day before repeating lower body'],
              progression: 'Add load only when all reps are clean.',
            },
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
    selectedDayIndex: selection ? selection.dayIndex : null,
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
assert(monday.lift.main?.[0]?.sets === 3 && monday.lift.main?.[0]?.reps === 5 && monday.lift.main?.[0]?.rpe === 8, 'top-level lift exercise prescription is preserved');
assert(monday.lift.warmup?.[0] === 'Bodyweight squat x 10' && monday.lift.recovery?.length === 1 && monday.lift.progression, 'top-level lift warmup/recovery/progression are preserved');
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
const z34 = exec.resolveHrZone('Zone 3-4', hrrProfile);
const z3 = exec.resolveHrZone('Z3', hrrProfile);
const z4 = exec.resolveHrZone('Z4', hrrProfile);
assert(z34 && z34.zoneLabel === 'Zone 3-4' && z34.minBpm === z3.minBpm && z34.maxBpm === z4.maxBpm, 'Zone 3-4 resolves across the full calibrated BPM band');
assert(Array.isArray(z34.zones) && z34.zones.join(',') === '3,4', 'resolved range preserves both zone numbers');
assert(exec.resolveHrZone('Z2', null) === null, 'no profile -> no invented bpm');
assert(exec.resolveHrZone('Z2', { zone_model: 'hrr', max_hr: null, resting_hr: null }) === null, 'incomplete profile -> no invented bpm');
assert(monday.run.hrZone && monday.run.hrZone.zone === 2, 'run session carries resolved hrZone when profile present');
const noProfile = build(hybridPlan, '2026-07-13', 'Mon', [], null);
assert(noProfile.run.hrZone === null, 'run session hrZone is null when no profile');
assert(exec.zoneNumberFromLabel('Zone 3') === 3 && exec.zoneNumberFromLabel(4) === 4 && exec.zoneNumberFromLabel('easy') === null, 'zone label parsing');
assert(exec.zoneNumbersFromLabel('Z2-4').join(',') === '2,3,4', 'zone range parser expands ascending zones');
assert(exec.zoneNumbersFromLabel('Z4-2').length === 0 && exec.zoneNumbersFromLabel('Zone 23').length === 0, 'zone range parser rejects reversed and ambiguous labels');

section('completion display mapping + idempotency');
const sessionIds = exec.collectSessionIds(hybridPlan);
assert(sessionIds.has('run-1') && sessionIds.has('lift-1') && sessionIds.has('run-3'), 'active-plan session allowlist contains every stable schema-v2 id');
const legacyIds = exec.collectSessionIds(legacyPlan);
assert(legacyIds.has('0') && !legacyIds.has('1'), 'legacy identifier allowlist matches calendar/compliance rules and excludes rest');
const withRunDone = build(hybridPlan, '2026-07-13', 'Mon', ['run-1'], hrrProfile);
assert(withRunDone.run.completed === true && withRunDone.lift.completed === false, 'only the completed session id is marked complete');
const idempotent = build(hybridPlan, '2026-07-13', 'Mon', ['run-1', 'run-1'], hrrProfile);
assert(idempotent.run.completed === true, 'duplicate completion ids are idempotent');
const foreignId = build(hybridPlan, '2026-07-13', 'Mon', ['some-other-users-session'], hrrProfile);
assert(foreignId.run.completed === false && foreignId.lift.completed === false, 'unrelated session ids never mark this plan complete');

section('legacy plan compatibility');
const legacyMon = build(legacyPlan, '2026-07-13', 'Mon', [], hrrProfile);
assert(legacyMon.hasDay && !legacyMon.isRest && legacyMon.run && legacyMon.run.kind === 'run', 'legacy weekday run day resolves via weekday fallback');
assert(legacyMon.run.id === '0', 'legacy daily execution exposes the calendar/compliance fallback session id');
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
assert(
  /location\.state/.test(warmup)
    && /navigate\('\/run\/active'/.test(warmup)
    && /navigate\(returnTo/.test(warmup),
  'Warmup forwards location.state through scheduled and manual run handoffs'
);
assert(/onStartRun\?\.\(runSession\)/.test(forgedDayView) && /onStartLift\?\.\(liftSession\)/.test(forgedDayView), 'ForgedDayView passes the selected session to start handlers');
assert(/planSessionId/.test(plan) && /scheduledRun/.test(plan), 'Plan hands the selected session id + prescription into navigate state');
assert(/workoutTarget/.test(plan) && /target_zone/.test(plan), 'Plan hands the exact run target into ActiveRun');
assert(!/disabled=\{!canStart\}/.test(forgedDayView), 'calendar start actions are not silently disabled outside the scheduled date');
assert(/confirmOffScheduleStart/.test(plan) && /isScheduledToday/.test(forgedDayView), 'off-schedule starts require explicit confirmation while keeping the plan session');
assert(/<RoutePlanner/.test(plan) && /Map this run/.test(plan) && /plannedRoute/.test(plan), 'the selected calendar run exposes route planning and carries the planned course into execution');
assert(logRun.indexOf('Start Scheduled Run') < logRun.indexOf('routePlannerStatus.available &&'), 'scheduled run start is available even when route planning is unavailable');
assert(/navigate\('\/warmup'/.test(logRun) && /startAfterWarmup:\s*true/.test(logRun), 'scheduled run keeps the warm-up before ActiveRun');
assert(/target_zone:\s*submittedScheduledRun\?\.targetZone/.test(logRun), 'LogRun stores the raw plan zone, not display-only BPM text');
assert(/target_zone:\s*workoutTarget\?\.zone/.test(activeRun), 'ActiveRun stores the scheduled plan zone');
assert(/execution\?\.hasPlan && execution\?\.hasDay/.test(logRun), 'LogRun does not reinterpret a calendar rest/lift day as a run');
const plansRoute = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'plans.js'), 'utf8');
assert(/withTransaction\(async \(tx\)/.test(plansRoute) && /FOR UPDATE OF up/.test(plansRoute), 'plan progress read-modify-write is transactionally locked');
assert(/collectSessionIds\(parsed\)/.test(plansRoute), 'plan progress rejects session ids outside the active plan');
assert(/requestedWeek < 1/.test(plansRoute), 'plan progress rejects week zero at the API boundary');

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
assert((logRun.match(/queueSessionComplete\(/g) || []).length >= 3 && /isRetryableCompletionFailure/.test(logRun), 'LogRun queues retryable online completion failures');
assert((activeRun.match(/queueSessionComplete\(/g) || []).length >= 2 && /isRetryableCompletionFailure/.test(activeRun), 'ActiveRun queues retryable online completion failures');
// ActiveWorkout: completion only after the end PUT resolves, before summary nav.
assert(activeWorkout.indexOf('/end`, {})') < activeWorkout.lastIndexOf('markSessionComplete') && activeWorkout.lastIndexOf('markSessionComplete') < activeWorkout.indexOf('navigate(`/workout/summary/'), 'ActiveWorkout completion sits between a successful end and the summary nav');
assert(/queueSessionComplete/.test(activeWorkout) && /planProgressNotice/.test(activeWorkout), 'ActiveWorkout queues retryable completion failures and surfaces the result');
// No completion helper is fired before a save/end in any consumer.
assert(!/markSessionComplete[\s\S]{0,120}await api\.(post|put)\('\/(runs|workouts)/.test(activeRun), 'ActiveRun never completes before the save call');

async function runProgressRouteHarness() {
  section('progress route behavior (real handler, mocked transaction boundary)');
  const dbModulePath = require.resolve('../src/db');
  const plansRoutePath = require.resolve('../src/routes/plans');
  const originalDbModule = require.cache[dbModulePath];
  const originalPlansRoute = require.cache[plansRoutePath];
  let routeRow = null;
  let legacyRow = null;
  let selectParams = null;
  let updateParams = null;
  let insertParams = null;

  const tx = {
    get: async (sql, params) => {
      selectParams = params;
      if (sql.includes('FROM user_plans up')) return routeRow ? { ...routeRow } : null;
      if (sql.includes('FROM training_plans tp')) return legacyRow ? { ...legacyRow } : null;
      return null;
    },
    all: async () => [],
    run: async (sql, params) => {
      if (sql.includes('INSERT INTO user_plans')) {
        insertParams = params;
        routeRow = {
          id: params[0],
          current_week: params[4],
          progress_json: params[6],
          weeks: legacyRow.weeks,
          plan_data: legacyRow.plan_data,
          plan_json: legacyRow.plan_json,
        };
        return { changes: 1 };
      }
      updateParams = params;
      routeRow.current_week = params[0];
      routeRow.progress_json = params[1];
      return { changes: 1 };
    },
  };
  const mockDb = {
    dbGet: async () => null,
    dbAll: async () => [],
    dbRun: async () => ({ changes: 0 }),
    withTransaction: async (fn) => fn(tx),
  };
  require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: mockDb,
    children: [],
    paths: [],
  };
  delete require.cache[plansRoutePath];

  try {
    const plansRouter = require('../src/routes/plans');
    const layer = plansRouter.stack.find((item) => item.route?.path === '/my/progress' && item.route?.methods?.put);
    const handler = layer?.route?.stack?.at(-1)?.handle;
    assert(typeof handler === 'function', 'progress route handler is registered');

    const invoke = async (body) => {
      let statusCode = 200;
      let payload = null;
      const response = {
        status(code) { statusCode = code; return this; },
        json(value) { payload = value; return this; },
      };
      await handler({ body, user: { id: 'user-h5' } }, response);
      return { statusCode, payload };
    };
    const freshRow = () => ({
      id: 'user-plan-h5',
      current_week: 1,
      progress_json: JSON.stringify({ completedSessionIds: [] }),
      weeks: hybridPlan.weeks.length,
      plan_data: hybridPlan,
      plan_json: null,
    });

    routeRow = freshRow();
    legacyRow = null;
    updateParams = null;
    let response = await invoke({ completed_session_id: 'run-1', current_week: 1 });
    assert(response.statusCode === 200 && response.payload?.completedSessionIds?.includes('run-1'), 'valid completion returns 200 and records the plan session');
    assert(selectParams?.[0] === 'user-h5' && updateParams?.[3] === 'user-h5', 'progress SELECT and UPDATE bind the authenticated user id');

    response = await invoke({ completed_session_id: 'run-1', current_week: 1 });
    const repeated = JSON.parse(routeRow.progress_json).completedSessionIds.filter((id) => id === 'run-1');
    assert(response.statusCode === 200 && repeated.length === 1, 'duplicate completion remains idempotent through the route');

    routeRow = freshRow();
    updateParams = null;
    response = await invoke({ completed_session_id: 'foreign-session', current_week: 1 });
    assert(response.statusCode === 400 && response.payload?.error === 'Invalid plan session' && updateParams === null, 'unknown session returns 400 without writing');

    routeRow = freshRow();
    response = await invoke({ current_week: 0 });
    assert(response.statusCode === 400 && response.payload?.error === 'Invalid plan week', 'week zero returns 400');
    response = await invoke({ current_week: hybridPlan.weeks.length + 1 });
    assert(response.statusCode === 400 && response.payload?.error === 'Invalid plan week', 'week above the plan length returns 400');

    routeRow = null;
    legacyRow = {
      legacy_plan_id: 'legacy-plan-h5',
      week_start: '2026-07-13',
      weeks: legacyPlan.weeks.length,
      plan_data: legacyPlan,
      plan_json: JSON.stringify(legacyPlan),
    };
    insertParams = null;
    response = await invoke({ completed_session_id: 'foreign-session' });
    assert(response.statusCode === 400 && insertParams === null, 'invalid legacy session is rejected before creating an assignment');

    routeRow = null;
    insertParams = null;
    response = await invoke({ current_week: 0 });
    assert(response.statusCode === 400 && insertParams === null, 'invalid legacy week is rejected before creating an assignment');

    routeRow = null;
    insertParams = null;
    response = await invoke({ completed_session_id: '0', current_week: 1 });
    assert(response.statusCode === 200 && response.payload?.completedSessionIds?.includes('0'), 'valid legacy completion lazily creates progress and succeeds');
    assert(insertParams?.[1] === 'user-h5' && insertParams?.[2] === 'legacy-plan-h5', 'legacy assignment INSERT binds the user and owned plan ids');

    routeRow = null;
    legacyRow = null;
    response = await invoke({ completed_session_id: 'run-1' });
    assert(response.statusCode === 404 && response.payload?.error === 'No assigned plan', 'missing active plan returns 404');
  } finally {
    delete require.cache[plansRoutePath];
    if (originalPlansRoute) require.cache[plansRoutePath] = originalPlansRoute;
    if (originalDbModule) require.cache[dbModulePath] = originalDbModule;
    else delete require.cache[dbModulePath];
  }
}

runProgressRouteHarness()
  .then(() => {
    console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
    if (failed) process.exit(1);
    console.log('H5 SMOKE OK');
  })
  .catch((err) => {
    console.error('  FAIL: progress route harness crashed:', err);
    process.exit(1);
  });
