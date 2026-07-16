// Forged Hybrid H5 — framework-free smoke for the shared daily-execution
// normalizer. Run: node frontend/test/dailyExecution.smoke.mjs
// Imports the dependency-free core (no axios/api) so it runs under plain node.

import {
  localDateISO,
  normalizeExecution,
  hasExecutableSession,
  formatHrZone,
  completionBody,
  scheduledRunFromExecution,
  scheduledLiftFromExecution,
  recommendationFromExecution,
  runRouteState,
  planSessionIdFromState,
  currentWeekFromState,
  isRetryableCompletionFailure,
} from '../src/lib/dailyExecutionCore.js';

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${msg}`); }
}

const hybridBody = {
  today: { day: 'Mon', date: '2026-07-13', type: 'run' },
  execution: {
    hasPlan: true,
    hasDay: true,
    isRest: false,
    mode: 'hybrid_maintain',
    phase: 'base',
    week: 1,
    goal: { name: 'Army Ten-Miler', distanceMiles: 10 },
    orderGuidance: 'Run first; lift 6h later',
    status: 'planned',
    date: '2026-07-13',
    day: 'Mon',
    sessions: [
      { id: 'run-1', kind: 'run', workout_type: 'easy', distance_miles: 4, target_zone: 'Z2', completed: false, hrZone: { zone: 2, label: 'Easy', minBpm: 134, maxBpm: 148, model: 'hrr', source: 'calibrated' } },
      { id: 'lift-1', kind: 'lift', title: 'Lower', sets: 3, reps: 5, completed: true, },
    ],
    run: { id: 'run-1', kind: 'run', target_zone: 'Z2', completed: false, hrZone: { zone: 2, label: 'Easy', minBpm: 134, maxBpm: 148 } },
    lift: { id: 'lift-1', kind: 'lift', completed: true },
  },
};

const restBody = { today: { day: 'Wed', date: '2026-07-15', type: 'rest', rest: true }, execution: { hasPlan: true, hasDay: true, isRest: true, mode: 'hybrid_maintain', sessions: [], run: null, lift: null, date: '2026-07-15' } };
const noPlanBody = { today: null, execution: { hasPlan: false, hasDay: false, date: '2026-07-13' } };

console.log('\n== normalizeExecution (hybrid) ==');
const h = normalizeExecution(hybridBody);
assert(h.hasPlan && h.hasDay && !h.isRest, 'hybrid day flagged executable');
assert(h.sessions.length === 2 && h.run.id === 'run-1' && h.lift.id === 'lift-1', 'both run+lift sessions with stable ids');
assert(h.mode === 'hybrid_maintain' && h.phase === 'base' && h.week === 1, 'mode/phase/week context normalized');
assert(h.goal && h.goal.name === 'Army Ten-Miler', 'goal preserved');
assert(h.legacyToday && h.legacyToday.date === '2026-07-13', 'legacy today passed through');
assert(hasExecutableSession(h) === true, 'hasExecutableSession true for hybrid day');

console.log('\n== rest + no-plan ==');
const r = normalizeExecution(restBody);
assert(r.hasDay && r.isRest && r.sessions.length === 0 && !r.run && !r.lift, 'rest day yields no run/lift');
assert(hasExecutableSession(r) === false, 'rest day is not executable');
const n = normalizeExecution(noPlanBody);
assert(!n.hasPlan && !n.hasDay && n.sessions.length === 0, 'no-plan normalizes safely');
assert(hasExecutableSession(n) === false, 'no-plan not executable → recommendation fallback');
assert(normalizeExecution(null).hasPlan === false, 'null body normalizes without throwing');

console.log('\n== formatHrZone ==');
assert(formatHrZone(h.run) === 'Zone 2 · 134-148 bpm', 'calibrated bpm band rendered');
assert(formatHrZone({ target_zone: 'Z3' }) === 'Zone 3', 'no profile → plain zone label');
assert(formatHrZone({ target_zone: 'Z2-3' }) === 'Zone 2-3', 'zone range stays readable and never collapses to Zone 23');
assert(formatHrZone({ target_zone: 'Zone 3-4', hrZone: { zone: '3-4', zoneLabel: 'Zone 3-4', minBpm: 149, maxBpm: 176 } }) === 'Zone 3-4 · 149-176 bpm', 'calibrated zone range renders its full label');
assert(formatHrZone({ target_zone: 'Zone 4', hrZone: null }) === 'Zone 4', 'null hrZone → plain label, no invented bpm');
assert(formatHrZone({}) === null, 'no zone info → null');

console.log('\n== localDateISO + completionBody ==');
assert(/^\d{4}-\d{2}-\d{2}$/.test(localDateISO(new Date('2026-07-13T23:30:00'))), 'localDateISO returns YYYY-MM-DD');
assert(localDateISO(new Date(2026, 6, 5)) === '2026-07-05', 'localDateISO pads month/day and stays local');
const body = completionBody('run-1', 2);
assert(body.completed_session_id === 'run-1' && body.current_week === 2, 'completion body carries session id + week');
assert(completionBody('run-1').current_week === undefined, 'completion body omits week when not finite');
assert(completionBody('run-1', null).current_week === undefined, 'completion body never coerces null to week zero');
assert(completionBody('run-1', 0).current_week === undefined, 'completion body rejects week zero');

console.log('\n== scheduled run/lift extractors (calendar preference) ==');
assert(scheduledRunFromExecution(h) && scheduledRunFromExecution(h).id === 'run-1', 'scheduledRunFromExecution returns the executable run');
assert(scheduledLiftFromExecution(h) && scheduledLiftFromExecution(h).id === 'lift-1', 'scheduledLiftFromExecution returns the executable lift');
assert(scheduledRunFromExecution(r) === null, 'rest day yields no scheduled run');
assert(scheduledLiftFromExecution(r) === null, 'rest day yields no scheduled lift');
assert(scheduledRunFromExecution(n) === null, 'no-plan yields no scheduled run');

console.log('\n== recommendationFromExecution (calendar vs fallback) ==');
const calRec = recommendationFromExecution(h);
assert(calRec && calRec.source === 'calendar', 'calendar recommendation is flagged source=calendar');
assert(calRec.recommendationType === 'run' && calRec.planSessionId === 'run-1', 'run preferred; carries planSessionId');
assert(calRec.targetZone === 'Z2', 'targetZone taken from the scheduled run');
const restRec = recommendationFromExecution(r);
assert(restRec && restRec.source === 'calendar' && restRec.recommendationType === 'rest', 'calendar rest stays explicit instead of falling back to an unrelated workout');
assert(recommendationFromExecution(n) === null, 'no-plan → null so callers fall back to next-recommendation');
const stepsRec = recommendationFromExecution(normalizeExecution({ execution: { hasPlan: true, hasDay: true, isRest: false, sessions: [], run: { id: 'run-steps', kind: 'run', steps: ['Warm up', '3 x 5 min', 'Cool down'] } } }));
assert(stepsRec && stepsRec.structure.length === 3, 'run steps remain visible when structure is absent');
const liftOnly = normalizeExecution({ execution: { hasPlan: true, hasDay: true, isRest: false, week: 3, sessions: [{ id: 'lift-9', kind: 'lift', title: 'Upper' }], run: null, lift: { id: 'lift-9', kind: 'lift', title: 'Upper' } } });
const liftRec = recommendationFromExecution(liftOnly);
assert(liftRec && liftRec.recommendationType === 'strength' && liftRec.planSessionId === 'lift-9', 'lift-only day → strength recommendation with lift session id');

console.log('\n== runRouteState + state readers ==');
const rs = runRouteState(h);
assert(rs && rs.planSessionId === 'run-1' && rs.currentWeek === 1, 'runRouteState carries planSessionId + week');
assert(rs.scheduledRun && rs.scheduledRun.id === 'run-1', 'runRouteState embeds the scheduled run');
assert(rs.prescription && rs.prescription.zone === 'Z2', 'runRouteState prescription carries the plan zone');
assert(runRouteState(r) === null && runRouteState(n) === null, 'no executable run → null route state');
assert(planSessionIdFromState({ planSessionId: 42 }) === '42', 'planSessionIdFromState stringifies planSessionId');
assert(planSessionIdFromState({ scheduledRun: { id: 'run-7' } }) === 'run-7', 'planSessionIdFromState falls back to scheduledRun.id');
assert(planSessionIdFromState({ planSessionId: null, scheduledRun: { id: 'group-run-7' } }) === null, 'an explicit null plan id never falls back to a synthetic scheduled-run id');
assert(planSessionIdFromState({ source: 'group_run', planSessionId: 'bad-plan-id', scheduledRun: { id: 'group-run-7' } }) === null, 'group-run provenance can never resolve to plan progress');
assert(planSessionIdFromState(null) === null && planSessionIdFromState({}) === null, 'planSessionIdFromState null-safe');
assert(currentWeekFromState({ currentWeek: '4' }) === 4, 'currentWeekFromState coerces finite numbers');
assert(currentWeekFromState({ currentWeek: 'nope' }) === null && currentWeekFromState(null) === null, 'currentWeekFromState rejects non-finite / null');
assert(currentWeekFromState({ currentWeek: null }) === null && currentWeekFromState({ currentWeek: 0 }) === null, 'currentWeekFromState never emits week zero');

console.log('\n== completion retry policy ==');
assert(isRetryableCompletionFailure(new Error('offline')) === true, 'network completion failure is retryable');
assert(isRetryableCompletionFailure({ response: { status: 503 } }) === true, 'server completion failure is retryable');
assert(isRetryableCompletionFailure({ response: { status: 400 } }) === false, 'deterministic 4xx completion failure is not queued forever');

console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
if (failed) process.exit(1);
console.log('H5 FRONTEND SMOKE OK');
