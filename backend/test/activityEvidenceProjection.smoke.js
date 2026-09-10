const assert = require('node:assert/strict');
const { buildAdaptationInputs } = require('../src/routes/plans')._test;

// Exercise the real route input builder and its actual SELECT projection. A
// helper-only fixture would hide the deployed loss of rated effort/symptoms.
async function main() {
  const observed = { id: 'own-manual', date: '2026-09-09', type: 'easy',
    distance_miles: 2, duration_seconds: 1500, perceived_effort: 9,
    pain_level: 'severe', post_energy: 'low', plan_session_id: null,
    planned_session_json: { schemaVersion: 1, planMatchMode: 'explicit_none' } };
  const queries = [];
  let checkins = [];
  const database = {
    get: async (sql, params) => {
      assert.equal(params[/MAX\(\(started_at/.test(sql) ? 1 : 0], 'owned-user');
      if (/MAX\(date\).*FROM runs/s.test(sql)) return { last_date: observed.date };
      if (/schedule_type/.test(sql)) return { schedule_type: 'adaptive' };
      return null;
    },
    all: async (sql, params) => {
      assert.equal(params[0], 'owned-user');
      if (/FROM daily_checkins/.test(sql)) return checkins;
      if (!/FROM runs/.test(sql)) return [];
      const projection = sql.match(/SELECT ([\s\S]*?) FROM runs/)[1];
      queries.push(projection);
      return [Object.fromEntries(Object.entries(observed).filter(([key]) =>
        new RegExp(`\\b${key}\\b`).test(projection)))];
    },
  };
  const result = await buildAdaptationInputs('owned-user', { weeks: [] },
    { row: { progress_json: {} } }, '2026-09-10', { database, strictReads: true });
  assert.equal(result.recentRunLoad.protection.active, true);
  assert.equal(result.recentRunLoad.protection.postRunSevere, true);
  assert.equal(result.recentRunLoad.protection.hardRunsThrough, '2026-09-12');
  assert.equal(result.recentRunLoad.protectiveRun.perceivedEffort, 9);
  assert.equal(result.recentRunLoad.protectiveRun.postRunEnergy, 'low');
  assert.ok(queries.some(sql => /plan_session_id/.test(sql) && /planned_session_json/.test(sql)
    && /health_source_workout_id/.test(sql)));
  checkins = [{ id:'checkin',checkin_date:'2026-09-10',feeling:1,legs:1,drive:1,life_flags:['sick','injured'] }];
  const changed = await buildAdaptationInputs('owned-user', { weeks: [] },
    { row: { progress_json: {} } }, '2026-09-10', { database, strictReads: true });
  assert.notEqual(changed.activitySnapshot.fingerprint,result.activitySnapshot.fingerprint);
  for (const key of ['healthSignals','completion','recentRunLoad','injuryState']) {
    assert.deepEqual(changed[key],result[key], 'Legacy check-in changes freshness only; it cannot invent a physiological planning driver');
  }
  console.log('activity evidence route projection smoke: PASS');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
