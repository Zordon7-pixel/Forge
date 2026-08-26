#!/usr/bin/env node

const assert = require('node:assert/strict');
const planSchema = require('../src/lib/planSchema');

async function run() {
  const today = new Date();
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const ownerId = 'owner';
  const sourcePlan = {
    schemaVersion: 2,
    weeks: [{ days: [{ date, day: 'Wed', sessions: [{ id: 'removed-today-run', kind: 'run', duration_min: 45 }] }] }],
  };
  const identified = planSchema.withRemovalSessionIdentities(sourcePlan, { assignmentStart: date });
  const removalId = identified.weeks[0].days[0].sessions[0].removal_session_id;
  const activeRow = {
    user_plan_id: 'assignment-owner',
    plan_id: 'plan-owner',
    status: 'active',
    started_at: date,
    effective_from: date,
    progress_json: '{}',
    plan_data: sourcePlan,
  };
  const removedRow = {
    ...activeRow,
    progress_json: JSON.stringify({ removedSessionIds: [removalId] }),
  };
  let currentPlanRow = activeRow;
  let reads = [];
  let writes = [];
  let mutationOwnerId = null;
  const tx = {
    async get(sql, params = []) {
      reads.push({ sql, params });
      if (/SELECT id FROM daily_checkins/.test(sql)) return null;
      if (/FROM health_sync/.test(sql)) return null;
      if (/FROM user_plans up/.test(sql) && /JOIN training_plans tp/.test(sql)) return currentPlanRow;
      if (/FROM training_plans WHERE user_id/.test(sql)) return null;
      throw new Error(`unexpected get: ${sql}`);
    },
    async run(sql, params = []) {
      writes.push({ sql, params });
      return { changes: 1 };
    },
  };
  const dbPath = require.resolve('../src/db');
  const routePath = require.resolve('../src/routes/checkin');
  const originalDb = require.cache[dbPath];
  const originalRoute = require.cache[routePath];
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      dbGet: tx.get,
      withUserMutation: async (userId, callback) => {
        mutationOwnerId = userId;
        return callback(tx);
      },
      withPlanningInputMutation: async () => {
        throw new Error('passive compatibility storage must not advance planning authority');
      },
    },
    children: [],
    paths: [],
  };
  delete require.cache[routePath];

  try {
    const router = require('../src/routes/checkin');
    const layer = router.stack.find((item) => item.route?.path === '/' && item.route?.methods?.post);
    const handler = layer?.route?.stack?.at(-1)?.handle;
    assert.equal(typeof handler, 'function');

    async function postLegacyCheckin(planRow, label) {
      currentPlanRow = planRow;
      reads = [];
      writes = [];
      mutationOwnerId = null;
      let statusCode = 200;
      let payload;
      await handler({
        user: { id: ownerId },
        body: { feeling: 3, time_available: 30, life_flags: [], date },
        query: {},
        headers: { 'x-forged-local-date': date },
      }, {
        status(code) { statusCode = code; return this; },
        json(value) { payload = value; return this; },
      });

      assert.equal(statusCode, 200);
      assert.equal(payload.ok, true);
      assert.equal(
        payload.adjustment,
        'Check-in saved for your history. Your accepted plan and today\'s training stay unchanged.',
        `${label} exposes truthful passive-compatibility copy`,
      );
      assert.equal(payload.headline, 'Plan stays as accepted');
      assert.equal(payload.action, 'keep', `${label} returns no plan-mutation action`);
      assert.deepEqual(payload.drivers, [], `${label} returns no plan-mutation drivers`);
      assert.equal(payload.readiness_delta, 0, `${label} returns no readiness authority`);
      assert.equal(Object.hasOwn(payload, 'patch'), false, `${label} returns no executable patch`);
      assert.equal(mutationOwnerId, ownerId, `${label} uses the owner-scoped compatibility mutation`);

      const healthRead = reads.find(({ sql }) => /FROM health_sync/.test(sql));
      assert(healthRead, `${label} resolves compatibility sleep through the real handler`);
      assert.match(healthRead.sql, /WHERE user_id=\?/, `${label} health lookup remains parameterized`);
      assert.deepEqual(healthRead.params, [ownerId], `${label} health lookup remains owner-scoped`);

      const checkinRead = reads.find(({ sql }) => /SELECT id FROM daily_checkins/.test(sql));
      assert(checkinRead, `${label} checks compatibility history through the real handler`);
      assert.match(
        checkinRead.sql,
        /WHERE user_id=\? AND checkin_date=\?/,
        `${label} history lookup remains parameterized and owner-scoped`,
      );
      assert.deepEqual(checkinRead.params, [ownerId, date], `${label} binds owner and local date separately`);
      assert.equal(
        reads.some(({ sql }) => /FROM user_plans|FROM training_plans/.test(sql)),
        false,
        `${label} does not consult an accepted plan to derive an override`,
      );

      const savedCheckin = writes.find(({ sql }) => /INSERT INTO daily_checkins/.test(sql));
      assert(savedCheckin, `${label} remains available for compatibility history/export`);
      assert.match(
        savedCheckin.sql,
        /INSERT INTO daily_checkins \(id, user_id, checkin_date,[\s\S]*VALUES \(\?,\?,\?,\?,\?,\?,\?,\?,\?\)/,
        `${label} history write remains parameterized`,
      );
      assert.equal(savedCheckin.params[1], ownerId, `${label} history write remains owner-scoped`);
      assert.equal(savedCheckin.params[2], date, `${label} history write binds the requested local date`);
      assert.equal(
        writes.some(({ sql }) => /checkin_overrides/i.test(sql)),
        false,
        `${label} never creates, updates, or deletes a check-in override`,
      );
      assert.equal(
        writes.some(({ sql }) => /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:user_plans|training_plans)/i.test(sql)),
        false,
        `${label} never removes or mutates an accepted workout`,
      );
    }

    const activeSnapshot = JSON.parse(JSON.stringify(activeRow));
    const activeBefore = planSchema.planViewsForAssignment(sourcePlan, activeRow);
    assert.equal(planSchema.daySessions(activeBefore.visiblePlan.weeks[0].days[0]).length, 1,
      'active-workout fixture starts with its accepted workout visible');
    await postLegacyCheckin(activeRow, 'active-workout legacy POST');
    const activeAfter = planSchema.planViewsForAssignment(sourcePlan, activeRow);
    assert.deepEqual(activeRow, activeSnapshot, 'active-workout POST leaves assignment progress unchanged');
    assert.deepEqual(activeAfter, activeBefore, 'active-workout POST leaves accepted and visible plan views unchanged');
    assert.equal(planSchema.daySessions(activeAfter.visiblePlan.weeks[0].days[0])[0].id, 'removed-today-run',
      'active-workout POST does not remove the accepted workout');

    const removedSnapshot = JSON.parse(JSON.stringify(removedRow));
    const removedBefore = planSchema.planViewsForAssignment(sourcePlan, removedRow);
    assert.equal(planSchema.daySessions(removedBefore.storedPlan.weeks[0].days[0]).length, 1,
      'no-active-workout fixture retains the immutable accepted workout');
    assert.equal(planSchema.daySessions(removedBefore.visiblePlan.weeks[0].days[0]).length, 0,
      'the pre-existing removal keeps the workout absent from the visible plan');
    await postLegacyCheckin(removedRow, 'no-active-workout legacy POST');
    const removedAfter = planSchema.planViewsForAssignment(sourcePlan, removedRow);
    assert.deepEqual(removedRow, removedSnapshot, 'no-active-workout POST leaves assignment progress unchanged');
    assert.deepEqual(removedAfter, removedBefore, 'no-active-workout POST preserves accepted and visible plan views');
    assert.equal(planSchema.daySessions(removedAfter.storedPlan.weeks[0].days[0])[0].id, 'removed-today-run',
      'no-active-workout POST does not mutate the immutable accepted workout');
    assert.equal(planSchema.daySessions(removedAfter.visiblePlan.weeks[0].days[0]).length, 0,
      'no-active-workout POST does not undo the existing removal visibility state');

    console.log('CHECK-IN REMOVAL VISIBILITY SMOKE OK');
  } finally {
    delete require.cache[routePath];
    if (originalRoute) require.cache[routePath] = originalRoute;
    if (originalDb) require.cache[dbPath] = originalDb;
    else delete require.cache[dbPath];
  }
}

if (require.main === module) run().catch((error) => {
  console.error(error);
  process.exit(1);
});

module.exports = { run };
