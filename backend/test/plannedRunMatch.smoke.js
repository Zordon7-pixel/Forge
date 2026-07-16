const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  findPlannedRunForDate,
  hasMeaningfulPlannedRun,
  matchPlannedRunInPlan,
} = require('../src/lib/plannedRunMatch');

let passed = 0;
function check(condition, message) { assert.ok(condition, message); passed += 1; }

const plan = {
  schemaVersion: 2,
  weeks: [{
    days: [{
      date: '2026-07-14',
      sessions: [
        { id: 'run-1', kind: 'run', title: 'Recovery run', distance_miles: 2, target_zone: 'Zone 1-2', steps: ['Stay easy'] },
        { id: 'lift-1', kind: 'lift', title: 'Upper body' },
      ],
    }],
  }],
};

const exact = matchPlannedRunInPlan(plan, '2026-07-14', 'plan-1');
check(exact?.sessionId === 'run-1', 'hybrid day selects its single run session')
check(exact?.distanceMiles === 2 && exact?.targetZone === 'Zone 1-2', 'snapshot preserves objective prescription targets')
check(exact?.matchSource === 'scheduled_date' && exact?.planId === 'plan-1', 'inferred match is explicitly sourced')
check(matchPlannedRunInPlan(plan, '2026-07-15') === null, 'wrong date never falls back to weekday')
check(matchPlannedRunInPlan({ weeks: [{ days: [{ day: 'Tue', sessions: plan.weeks[0].days[0].sessions }] }] }, '2026-07-14') === null, 'undated legacy day is not guessed')

const ambiguous = JSON.parse(JSON.stringify(plan));
ambiguous.weeks[0].days[0].sessions.push({ id: 'run-2', kind: 'run', title: 'Second run' });
check(matchPlannedRunInPlan(ambiguous, '2026-07-14') === null, 'two scheduled runs on one date remain ambiguous')
check(hasMeaningfulPlannedRun(JSON.stringify(exact)), 'stored snapshot is recognized')
check(!hasMeaningfulPlannedRun('{}') && !hasMeaningfulPlannedRun('bad json'), 'empty and malformed snapshots fail closed')

const queries = [];
findPlannedRunForDate('user-1', '2026-07-14', {
  get: async (sql, params) => {
    queries.push({ sql, params });
    return { id: 'plan-1', plan_data: plan };
  },
}).then((found) => {
  check(found?.sessionId === 'run-1', 'active assigned plan resolves through injected DB lookup')
  check(queries[0].sql.includes('up.user_id=?') && queries[0].params[0] === 'user-1', 'active-plan lookup is owner scoped')

  const importSource = fs.readFileSync(path.join(__dirname, '../src/routes/import.js'), 'utf8');
  const runsSource = fs.readFileSync(path.join(__dirname, '../src/routes/runs.js'), 'utf8');
  check(importSource.includes("item.section === 'run' ? await findPlannedRunForDate"), 'walks and non-run imports cannot claim a run prescription')
  check(/UPDATE runs SET[\s\S]*WHERE id=\? AND user_id=\?/.test(importSource), 'import enrichment update remains owner scoped')
  check(runsSource.includes('!hasMeaningfulPlannedRun(run.planned_session_json)'), 'run detail preserves an existing immutable snapshot')
  check(runsSource.includes('resolvedPlannedSession = scheduledRun'), 'manual run save freezes an exact-date scheduled target before insert')
  check(runsSource.includes('isRunActivity({ type, watch_activity_type, watch_normalized_type })'), 'manual non-run activities cannot claim a run prescription')

  console.log(`PASSED: ${passed}  FAILED: 0`);
  console.log('PLANNED RUN MATCH SMOKE OK');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
