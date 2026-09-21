// Synthetic Phase3 ON route replay. No production DB, API, or runtime env changes.
const assert = require('node:assert/strict');
const { createDb } = require('./helpers/adaptiveShadowDb');
const fixture = createDb(), { db } = fixture;
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fixture.exports };
const RealDate = Date, DATE = '2026-09-20', NOW = `${DATE}T12:00:00Z`;
global.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return RealDate.parse(NOW); }
};
const shadow = require('../src/lib/adaptiveCoachingShadow');
const realPrepare = shadow.prepare, realCompute = shadow.compute;
let prepared, result;
shadow.prepare = input => { prepared = realPrepare(input); return prepared; };
shadow.compute = input => { result = realCompute(input); return result; };
const plans = require('../src/routes/plans')._test;
const { addDays } = require('../src/lib/racePlanPolicy');
const ALL = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const OWNER = '11111111-1111-4111-8111-111111111111';
const request = { planning_date_local: DATE, planning_timezone: 'America/New_York', timezone_offset_minutes: 240,
  race_ids: ['army'], target: { runDaysPerWeek: 4, trainingDays: ['Tue','Thu','Sat','Sun'],
    liftDaysPerWeek: 4, liftEligibleWeekdays: ALL, liftingEnabled: true, strengthGoal: 'maintain',
    equipment: ['barbell','dumbbell','rack','bench','cable','machines'] } };
const options = { goalBackwardDependencies: { mode: 'on', audience: 'all', telemetrySink: () => {} } };
async function main() {
  db.exec('ALTER TABLE race_events ADD COLUMN elevation_gain_ft REAL');
  db.exec('ALTER TABLE race_events ADD COLUMN terrain TEXT');
  db.prepare(`INSERT INTO users(id,name,email,password_hash,timezone,training_age_class,planning_input_revision)
    VALUES (?,'Synthetic','race-availability@example.invalid','','America/New_York','ESTABLISHED',1)`).run(OWNER);
  db.prepare(`INSERT INTO race_events(id,user_id,race_name,race_date,event_local_date,event_timezone,distance_miles,
    goal_time_seconds,event_kind,location,elevation_gain_ft,terrain) VALUES ('army',?,'Army 10-Miler','2026-10-11',
    '2026-10-11','America/New_York',10,5400,'run_race','Washington, DC',190,'road')`).run(OWNER);
  for (let i = 1; i <= 28; i++) db.prepare(`INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds,created_at)
    VALUES (?,?,?,'easy',4,2400,?)`).run(`observed-${i}`, OWNER, addDays(DATE,-i), `${addDays(DATE,-i)}T12:00:00Z`);
  db.prepare(`INSERT INTO daily_checkins(id,user_id,checkin_date,feeling,time_available,created_at)
    VALUES ('ready',?,?,4,180,?)`).run(OWNER, DATE, NOW);
  const before = Object.fromEntries(['users','race_events','training_plans','user_plans','plan_generation_candidates','planning_pipeline_artifacts']
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  await assert.rejects(plans.previewPlanForUser(OWNER, request, options), error => {
    console.log('Phase3 rejection', JSON.stringify({ code: error.code, details: error.details,
      message: error.message, support: prepared?.source_support, status: result?.status }));
    assert.equal(error.code, 'GOAL_BACKWARD_GENERATION_FAILED');
    assert.equal(error.details.reason_code, 'CANONICAL_STRENGTH_LINK_ABSENT');
    assert.match(error.message, /completed strength.*linked/i);
    return true;
  });
  for (const [table, rows] of Object.entries(before)) assert.deepEqual(
    db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(), rows, `${table} unchanged on rejection`);
  assert.deepEqual(prepared.foundation.athlete_state.adaptive_foundation.capacities, { run: 4, lift: 4 });
  assert.equal(new Set(prepared.availability.lift.map(w => w.start_at.slice(0,10))).size, 7);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM user_plans').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM plan_generation_candidates').get().n, 0);
  for (const [modality, target] of [['run', { trainingDays: ['Tue','Thu'] }], ['lift', { liftEligibleWeekdays: ['Mon','Wed'] }]]) {
    await assert.rejects(plans.previewPlanForUser(OWNER, { ...request, target: { ...request.target, ...target } }, options), e => {
      assert.equal(e.code, 'MODALITY_AVAILABILITY_INSUFFICIENT');
      assert.equal(e.details.modality, modality);
      assert.equal(e.details.requested, 4); assert.equal(e.details.available, 2); return true;
    });
  }
  console.log('race availability route regressions passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => { global.Date = RealDate; db.close(); });
