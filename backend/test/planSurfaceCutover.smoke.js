#!/usr/bin/env node

const assert = require('node:assert/strict');
const checkinRouter = require('../src/routes/checkin');
const statsRouter = require('../src/routes/stats');
const plansRouter = require('../src/routes/plans');

const ownerId = 'surface-cutover-owner';
const oldPlan = {
  user_plan_id: 'up-old',
  id: 'tp-old',
  started_at: '2026-08-01',
  effective_from: '2026-08-01',
  status: 'superseded',
  supersedes_user_plan_id: null,
  plan_data: JSON.stringify({
    weeks: [
      { week: 1, days: [{ date: '2026-08-08', day: 'Sat', type: 'run', distance: 7, duration: 70 }] },
      { week: 2, days: [{ date: '2026-08-15', day: 'Sat', type: 'run', distance: 9, duration: 90 }] },
    ],
  }),
};
const newPlan = {
  user_plan_id: 'up-new',
  id: 'tp-new',
  started_at: '2026-08-09',
  effective_from: '2026-08-09',
  status: 'active',
  supersedes_user_plan_id: 'up-old',
  plan_data: JSON.stringify({
    weeks: [{ week: 1, days: [{ date: '2026-08-09', day: 'Sun', type: 'run', distance: 3, duration: 30 }] }],
  }),
};

function createDatabase() {
  const calls = [];
  return {
    calls,
    get: async (sql, params = []) => {
      calls.push({ sql, params });
      assert.equal(params.includes(ownerId), true, 'every plan lookup must remain owner-scoped');
      if (/up\.status\s*=\s*'active'/.test(sql)) return { ...newPlan };
      if (sql.includes('up.id=?') && params[0] === 'up-old') return { ...oldPlan };
      return null;
    },
  };
}

async function run() {
  assert.equal(
    plansRouter._test.candidateEffectiveFrom({ source: 'assigned' }, '2026-08-08'),
    '2026-08-09',
    'an assigned-plan replacement protects the current calendar day'
  );
  assert.equal(
    plansRouter._test.candidateEffectiveFrom({ source: 'legacy' }, '2026-08-08'),
    '2026-08-08',
    'a legacy replacement without assignment lineage starts on the visible planning day'
  );
  assert.equal(
    plansRouter._test.candidateEffectiveFrom(null, '2026-08-08'),
    '2026-08-08',
    'a first plan starts on the visible planning day'
  );

  for (const [surface, resolve] of [
    ['Train', (database) => plansRouter._test.getActivePlanForUser(ownerId, database, { planningDateLocal: '2026-08-08' })],
    ['Check-In', (database) => checkinRouter._test.getActivePlanForUser(ownerId, database, { planningDateLocal: '2026-08-08' })],
    ['Stats', (database) => statsRouter._test.getActivePlanForUser(ownerId, '2026-08-08', database)],
  ]) {
    const database = createDatabase();
    const selected = await resolve(database);
    assert.equal(selected.row.user_plan_id, 'up-old', `${surface} must keep today's predecessor before cutover`);
    assert.ok(database.calls.some((call) => call.params[0] === 'up-old'));
  }

  const tomorrow = await statsRouter._test.getActivePlanForUser(ownerId, '2026-08-09', createDatabase());
  assert.equal(tomorrow.row.user_plan_id, 'up-new', 'all surfaces may use the replacement on effective_from');

  const parsedOldPlan = JSON.parse(oldPlan.plan_data);
  const selectedDay = checkinRouter._test.normalizeTodayEntry(parsedOldPlan, '2026-08-08');
  assert.equal(selectedDay.distance, 7, 'check-in targets the exact dated workout, not the first matching weekday');

  const removalIdentified = require('../src/lib/planSchema').withRemovalSessionIdentities(parsedOldPlan, {
    assignmentStart: oldPlan.effective_from,
  });
  const removalId = removalIdentified.weeks[0].days[0].removal_session_id;
  const removedActive = {
    source: 'assigned',
    row: { ...oldPlan, progress_json: JSON.stringify({ removedSessionIds: [removalId] }) },
  };
  const removedVisiblePlan = checkinRouter._test.visibleActivePlan(removedActive);
  assert.equal(
    checkinRouter._test.normalizeTodayEntry(removedVisiblePlan, '2026-08-08'),
    null,
    'check-in does not adapt a removed workout'
  );

  const request = {
    body: {},
    get(name) {
      if (name === 'x-forged-local-date') return '2026-08-08';
      if (name === 'x-forged-timezone-offset-minutes') return '240';
      return null;
    },
    query: {},
  };
  assert.deepEqual(plansRouter._test.withRequestPlanningClock(request, {}), {
    planning_date_local: '2026-08-08',
    timezone_offset_minutes: '240',
  });

  let response;
  const res = {
    status(status) {
      return { json(payload) { response = { payload, status }; } };
    },
  };
  const internal = new Error('database secret and stack detail');
  const originalConsoleError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.map(String).join(' '));
  try {
    plansRouter._test.sendCandidateError(res, internal, 'smoke');
  } finally {
    console.error = originalConsoleError;
  }
  assert.deepEqual(response, {
    status: 500,
    payload: { error: 'Unable to process this plan request.', code: 'PLAN_REQUEST_FAILED' },
  });
  assert.match(logged.join('\n'), /database secret and stack detail/, 'internal failures remain available in server logs');

  console.log('PLAN SURFACE CUTOVER SMOKE OK (16)');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
