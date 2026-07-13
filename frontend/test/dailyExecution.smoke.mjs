// Forged Hybrid H5 — framework-free smoke for the shared daily-execution
// normalizer. Run: node frontend/test/dailyExecution.smoke.mjs
// Imports the dependency-free core (no axios/api) so it runs under plain node.

import {
  localDateISO,
  normalizeExecution,
  hasExecutableSession,
  formatHrZone,
  completionBody,
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
assert(formatHrZone({ target_zone: 'Zone 4', hrZone: null }) === 'Zone 4', 'null hrZone → plain label, no invented bpm');
assert(formatHrZone({}) === null, 'no zone info → null');

console.log('\n== localDateISO + completionBody ==');
assert(/^\d{4}-\d{2}-\d{2}$/.test(localDateISO(new Date('2026-07-13T23:30:00'))), 'localDateISO returns YYYY-MM-DD');
assert(localDateISO(new Date(2026, 6, 5)) === '2026-07-05', 'localDateISO pads month/day and stays local');
const body = completionBody('run-1', 2);
assert(body.completed_session_id === 'run-1' && body.current_week === 2, 'completion body carries session id + week');
assert(completionBody('run-1').current_week === undefined, 'completion body omits week when not finite');

console.log(`\nPASSED: ${passed}  FAILED: ${failed}`);
if (failed) process.exit(1);
console.log('H5 FRONTEND SMOKE OK');
