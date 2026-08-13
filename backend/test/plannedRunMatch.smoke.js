const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const planSchema = require('../src/lib/planSchema');
const {
  allocatePlanSessionRunEvidence,
  explicitNoPlanMatchSnapshot,
  findPlannedRunForDate,
  findPlanSessionRunEvidence,
  hasMeaningfulPlannedRun,
  isExplicitlyUnlinkedRun,
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

const explicitExtra = explicitNoPlanMatchSnapshot();
check(isExplicitlyUnlinkedRun(explicitExtra) && !hasMeaningfulPlannedRun(explicitExtra), 'an explicit extra-run marker is durable without becoming a prescription')
const evidenceRuns = [
  { id: 'extra', date: '2026-07-14', plan_session_id: null, planned_session_json: JSON.stringify(explicitExtra) },
  { id: 'other-plan', date: '2026-07-14', plan_session_id: 'run-2', planned_session_json: '{}' },
  { id: 'legacy', date: '2026-07-15', plan_session_id: null, planned_session_json: '{}' },
  { id: 'exact', date: '2026-07-20', plan_session_id: 'run-1', planned_session_json: '{}' },
];
check(findPlanSessionRunEvidence(evidenceRuns, { sessionId: 'run-1', date: '2026-07-14' })?.id === 'exact', 'exact session evidence wins regardless of activity date')
check(findPlanSessionRunEvidence(evidenceRuns, { sessionId: 'run-3', date: '2026-07-14' })?.id === 'legacy', 'legacy unlinked evidence may match within the existing one-day tolerance')
check(findPlanSessionRunEvidence(evidenceRuns, { sessionId: 'run-3', date: '2026-07-14', dateToleranceDays: 0 }) === null, 'explicit extras and differently linked runs cannot block a same-day make-up')

const allocationSessions = [
  { sessionId: 'run-mon', date: '2026-07-13' },
  { sessionId: 'run-tue', date: '2026-07-14' },
];
const allocationRuns = [
  { id: 'legacy-tue', date: '2026-07-14', plan_session_id: null, planned_session_json: '{}' },
];
const progressAllocation = allocatePlanSessionRunEvidence(allocationSessions, allocationRuns, {
  completedSessionIds: ['run-mon'],
});
check(progressAllocation[0].evidence === null && progressAllocation[1].evidence?.id === 'legacy-tue', 'progress-completed sessions do not consume another session evidence')
const exactDateAllocation = allocatePlanSessionRunEvidence(allocationSessions, allocationRuns);
check(exactDateAllocation[0].evidence === null && exactDateAllocation[1].evidence?.id === 'legacy-tue', 'exact-date legacy allocation runs before adjacent-date fallback globally')

const queries = [];
findPlannedRunForDate('user-1', '2026-07-14', {
  get: async (sql, params) => {
    queries.push({ sql, params });
    return {
      id: 'plan-1',
      user_plan_id: 'up-1',
      effective_from: '2026-07-14',
      plan_data: plan,
    };
  },
}).then(async (found) => {
  check(found?.sessionId === 'run-1', 'active assigned plan resolves through injected DB lookup')
  check(/up\.user_id\s*=\s*\?/.test(queries[0].sql) && queries[0].params[0] === 'user-1', 'active-plan lookup is owner scoped')

  const identifiedPlan = planSchema.withRemovalSessionIdentities(plan, { assignmentStart: '2026-07-14' });
  const removedRunId = identifiedPlan.weeks[0].days[0].sessions[0].removal_session_id;
  const removedRun = await findPlannedRunForDate('user-1', '2026-07-14', {
    get: async () => ({
      id: 'plan-1',
      user_plan_id: 'up-1',
      effective_from: '2026-07-14',
      progress_json: JSON.stringify({ removedSessionIds: [removedRunId] }),
      plan_data: plan,
    }),
  });
  check(removedRun === null, 'a recorded run cannot be linked to a removed planned session')

  const predecessorPlan = JSON.parse(JSON.stringify(plan));
  predecessorPlan.weeks[0].days[0].sessions[0].title = 'Protected predecessor run';
  const replacementPlan = {
    schemaVersion: 2,
    weeks: [{
      days: [{
        date: '2026-07-15',
        sessions: [{ id: 'replacement-run', kind: 'run', title: 'Replacement run' }],
      }],
    }],
  };
  const cutoverQueries = [];
  const cutover = await findPlannedRunForDate('user-1', '2026-07-14', {
    get: async (sql, params) => {
      cutoverQueries.push({ sql, params });
      if (/up\.status\s*=\s*'active'/.test(sql)) {
        return {
          id: 'plan-new',
          user_plan_id: 'up-new',
          effective_from: '2026-07-15',
          supersedes_user_plan_id: 'up-old',
          plan_data: replacementPlan,
        };
      }
      if (/up\.id\s*=\s*\?/.test(sql) && params[0] === 'up-old') {
        return {
          id: 'plan-old',
          user_plan_id: 'up-old',
          effective_from: '2026-07-01',
          plan_data: predecessorPlan,
        };
      }
      return null;
    },
  });
  check(cutover?.planId === 'plan-old' && cutover?.title === 'Protected predecessor run', 'rollout-day run matching follows the protected predecessor until replacement cutover')
  check(cutoverQueries.some(({ sql, params }) => /up\.id\s*=\s*\?/.test(sql) && params[0] === 'up-old' && params[1] === 'user-1'), 'predecessor lookup remains owner scoped')

  const importSource = fs.readFileSync(path.join(__dirname, '../src/routes/import.js'), 'utf8');
  const runsSource = fs.readFileSync(path.join(__dirname, '../src/routes/runs.js'), 'utf8');
  const aiSource = fs.readFileSync(path.join(__dirname, '../src/services/ai.js'), 'utf8');
  check(importSource.includes("item.section === 'run' ? await findPlannedRunForDate"), 'walks and non-run imports cannot claim a run prescription')
  check(/UPDATE runs SET[\s\S]*WHERE id=\? AND user_id=\?/.test(importSource), 'import enrichment update remains owner scoped')
  check(runsSource.includes('!isExplicitlyUnlinkedRun(run.planned_session_json)') && runsSource.includes('!hasMeaningfulPlannedRun(run.planned_session_json)'), 'run detail preserves explicit opt-out and existing immutable snapshots')
  check(runsSource.includes('resolvedPlannedSession = scheduledRun'), 'manual run save freezes an exact-date scheduled target before insert')
  check(runsSource.includes('isRunActivity({ type, watch_activity_type, watch_normalized_type })'), 'manual non-run activities cannot claim a run prescription')
  check(aiSource.includes('hasMeaningfulPlannedRun(plannedSession)'), 'AI feedback excludes explicit opt-out metadata from planned-prescription context')

  console.log(`PASSED: ${passed}  FAILED: 0`);
  console.log('PLANNED RUN MATCH SMOKE OK');
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
