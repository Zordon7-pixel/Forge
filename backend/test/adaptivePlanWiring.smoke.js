const assert = require('node:assert/strict');

function localISO(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function addDays(dateISO, amount) {
  const date = new Date(`${dateISO}T12:00:00`);
  date.setDate(date.getDate() + amount);
  return localISO(date);
}

function mondayFor(dateISO) {
  const date = new Date(`${dateISO}T12:00:00`);
  return addDays(dateISO, -((date.getDay() + 6) % 7));
}

function withoutRemovalMarkers(value) {
  if (Array.isArray(value)) return value.map(withoutRemovalMarkers);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'removal_session_id')
    .map(([key, nested]) => [key, withoutRemovalMarkers(nested)]));
}

async function run() {
  const dbModulePath = require.resolve('../src/db');
  const plansRoutePath = require.resolve('../src/routes/plans');
  const originalDb = require.cache[dbModulePath];
  const originalPlansRoute = require.cache[plansRoutePath];
  const todayISO = localISO();
  const currentMonday = mondayFor(todayISO);
  const planData = {
    schemaVersion: 2,
    weeks: [0, 1].map((offset) => ({
      week: offset + 1,
      startDate: addDays(currentMonday, offset * 7),
      totalMiles: offset === 0 ? 10 : 25,
      days: [{
        date: addDays(currentMonday, offset * 7),
        day: 'Mon',
        sessions: [
          { id: `run-${offset + 1}`, kind: 'run', type: 'easy', target_zone: 'Zone 2', intensity: 'Easy' },
          { id: `lift-${offset + 1}`, kind: 'lift', type: 'strength', main: [{ name: 'Barbell back squat' }] },
        ],
      }],
    })),
  };
  const assignment = {
    id: 'adaptive-assignment',
    plan_id: 'adaptive-plan',
    name: 'Adaptive wiring smoke',
    type: 'hybrid',
    weeks: 2,
    description: 'Adaptive response metadata',
    plan_data: planData,
    progress_json: JSON.stringify({ completedSessionIds: [] }),
    started_at: currentMonday,
    current_week: 1,
    status: 'active',
  };
  let dataAvailable = true;
  const runs = [0, 1, 2, 3].map((weekIndex) => ({
    date: addDays(currentMonday, -28 + weekIndex * 7),
    distance_miles: 10,
    type: 'run',
  }));
  const mockDb = {
    dbGet: async (sql) => {
      if (sql.includes('FROM user_plans up')) return { ...assignment };
      if (sql.includes('FROM user_hr_profile')) {
        return dataAvailable ? { max_hr: 190, resting_hr: 50, lthr: null, zone_model: 'hrr' } : null;
      }
      if (sql.includes('FROM health_sync')) {
        return dataAvailable ? {
          sleep_hours_last_night: 8,
          sleep_end_at: `${todayISO}T07:00:00Z`,
          synced_at: `${todayISO}T08:00:00Z`,
        } : null;
      }
      return null;
    },
    dbAll: async (sql) => {
      if (sql.includes('FROM runs')) return dataAvailable ? runs : [];
      if (sql.includes('FROM readiness_scores')) {
        return dataAvailable ? [{ score_date: addDays(todayISO, -1), score: 80, band: 'GREEN' }] : [];
      }
      return [];
    },
    dbRun: async () => ({ changes: 0 }),
    withTransaction: async () => { throw new Error('GET /plans/my must remain read-only'); },
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
    const router = require('../src/routes/plans');
    const handler = router.stack.find((layer) => layer.route?.path === '/my' && layer.route?.methods?.get)?.route?.stack?.at(-1)?.handle;
    assert.equal(typeof handler, 'function');
    const invoke = async () => {
      let payload;
      let statusCode = 200;
      const response = {
        status(code) { statusCode = code; return this; },
        json(value) { payload = value; return this; },
      };
      await handler({ user: { id: 'adaptive-user' } }, response);
      return { payload, statusCode };
    };

    const adaptive = await invoke();
    assert.equal(adaptive.statusCode, 200);
    const adaptivePlan = adaptive.payload.plan.plan_data;
    assert.deepEqual(adaptivePlan.weeks[0].days[0].sessions[0].targetBpmRange, { minBpm: 134, maxBpm: 148 });
    assert.equal(adaptivePlan.weeks[1].rampDecision.decision, 'ADVANCE');
    assert.equal(adaptivePlan.weeks[1].rampDecision.targetMiles, 11);
    assert.equal(adaptivePlan.weeks[1].totalMiles, 25, 'the served planned mileage must remain unchanged');
    assert.equal(Object.hasOwn(adaptivePlan.weeks[0].days[0].sessions[1], 'adjustedForGear'), false);

    dataAvailable = false;
    const noProfiles = await invoke();
    assert.equal(noProfiles.statusCode, 200);
    assert.equal(
      JSON.stringify(withoutRemovalMarkers(noProfiles.payload.plan.plan_data)),
      JSON.stringify(planData),
      'read-only delivery adds only server-issued removal markers',
    );
  } finally {
    delete require.cache[plansRoutePath];
    if (originalPlansRoute) require.cache[plansRoutePath] = originalPlansRoute;
    if (originalDb) require.cache[dbModulePath] = originalDb;
    else delete require.cache[dbModulePath];
  }

  console.log('adaptive plan wiring smoke passed');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
