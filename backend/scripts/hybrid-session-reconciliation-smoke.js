const assert = require('assert');
const fs = require('fs');
const path = require('path');
const reconciliation = require('../src/lib/hybridReconciliation');

let checks = 0;
function check(value, message) {
  assert.ok(value, message);
  checks += 1;
}

const plan = {
  schemaVersion: 2,
  planMode: 'hybrid_maintain',
  weeks: [{
    days: [
      {
        date: '2026-07-20',
        day: 'Mon',
        sessions: [
          { id: 'run-1', kind: 'run', title: 'Easy aerobic run' },
          { id: 'lift-1', kind: 'lift', title: 'Strength maintenance', focus: 'Upper body' },
        ],
      },
      { date: '2026-07-21', day: 'Tue', sessions: [] },
      { date: '2026-07-22', day: 'Wed', sessions: [{ id: 'run-2', kind: 'run', title: 'Quality run' }] },
    ],
  }],
};

const base = {
  plan,
  planningDateISO: '2026-07-20',
  completedSessionIds: [],
  reconciliations: {},
  runDates: ['2026-07-20'],
  liftDates: [],
};

check(reconciliation.buildCurrentPrompt({ ...base, localHour: 19 }) === null, 'same-day prompt waits until the evening');
const eveningPrompt = reconciliation.buildCurrentPrompt({ ...base, localHour: 20 });
check(eveningPrompt?.liftSessionId === 'lift-1', 'run-only hybrid day produces a lift reconciliation prompt');
check(eveningPrompt?.runTitle === 'Easy aerobic run', 'prompt preserves the paired run title');
check(reconciliation.buildCurrentPrompt({ ...base, localHour: 20, liftDates: ['2026-07-20'] }) === null, 'recorded lift resolves the hybrid day');
check(reconciliation.buildCurrentPrompt({ ...base, localHour: 20, completedSessionIds: ['lift-1'] }) === null, 'manual completion resolves the hybrid day');

const key = reconciliation.reconciliationKey('2026-07-20', 'lift-1');
check(reconciliation.buildCurrentPrompt({
  ...base,
  localHour: 20,
  reconciliations: { [key]: { response: 'completed_untracked', sessionDate: '2026-07-20' } },
}) === null, 'completed-without-tracking is terminal without fabricating a lift');
check(reconciliation.buildCurrentPrompt({
  ...base,
  localHour: 20,
  reconciliations: { [key]: { response: 'later', respondedDate: '2026-07-20', sessionDate: '2026-07-20' } },
}) === null, 'doing-it-later hides the prompt for the rest of that day');
check(reconciliation.buildCurrentPrompt({
  ...base,
  planningDateISO: '2026-07-21',
  localHour: 9,
  reconciliations: { [key]: { response: 'later', respondedDate: '2026-07-20', sessionDate: '2026-07-20' } },
})?.liftSessionId === 'lift-1', 'doing-it-later rechecks the next day if the lift remains absent');

const pattern = reconciliation.patternSummary({
  a: { response: 'life_event', sessionDate: '2026-07-01' },
  b: { response: 'skipped', sessionDate: '2026-07-08' },
  c: { response: 'life_event', sessionDate: '2026-07-15' },
  d: { response: 'completed_untracked', sessionDate: '2026-07-18' },
}, '2026-07-21');
check(pattern.count === 3, 'pattern counts only life-event and skipped decisions');
check(pattern.reviewRecommended === true, 'three schedule misses trigger a plan-fit review suggestion');

const candidate = reconciliation.findCandidate(plan, '2026-07-20', 'lift-1');
const moved = reconciliation.moveLiftToNextAvailableRestDay(plan, candidate, '2026-07-20');
check(moved.adjusted === true, 'life-event adjustment can move strength to the next rest day');
check(moved.movedFrom === 'Mon' && moved.movedTo === 'Tue', 'adjustment reports the exact calendar move');
check(plan.weeks[0].days[0].sessions.length === 2, 'copy-on-write helper does not mutate the source plan');

const routeSource = fs.readFileSync(path.join(__dirname, '../src/routes/plans.js'), 'utf8');
check(routeSource.includes("router.get('/reconciliation/current', auth"), 'read endpoint requires authentication');
check(routeSource.includes("router.post('/reconciliation/respond', auth"), 'decision endpoint requires authentication');
check(routeSource.includes("UPDATE user_plans SET progress_json=? WHERE id=? AND user_id=?"), 'progress mutation is owner scoped');
check(routeSource.includes('Strength session marked complete without inventing workout metrics.'), 'untracked completion copy states the truth boundary');
check(routeSource.includes("['life_event', 'skipped'].includes(reconciliation.response)"), 'acknowledged schedule context is excused from the old missed-workout score');
check(routeSource.includes('reconciliationState,'), 'a reconciliation invalidates stale completion-driven adaptation proposals');

console.log(`HYBRID SESSION RECONCILIATION SMOKE OK (${checks})`);
