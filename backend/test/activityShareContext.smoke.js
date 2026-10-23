// Real authenticated route and SQLite, synthetic rows only; no production DB.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createDb } = require('./helpers/adaptiveShadowDb');
const fixture = createDb({ syntheticProfileFields: false });
const { db, calls } = fixture;
const startup = fs.readFileSync(path.join(__dirname, '../src/db/index.js'), 'utf8');
const ddl = startup.match(/CREATE TABLE IF NOT EXISTS personal_records \([\s\S]*?\n\s*\);/)[0];
db.exec(ddl.replace(/DEFAULT \(to_char\(NOW\(\), 'YYYY-MM-DD'\)\)/g, 'DEFAULT CURRENT_TIMESTAMP'));
fixture.exports.runWithUserContext = (_id, next) => next();
const dbPath = require.resolve('../src/db');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fixture.exports };
const aiPath = require.resolve('../src/services/ai');
require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {} };
process.env.JWT_SECRET = 'synthetic-share-context-test-only';
const jwt = require('jsonwebtoken');
const router = require('../src/routes/runs');
const route = router.stack.find(layer => layer.route?.path === '/:id/share-context').route;
assert.equal(route.methods.get, true);
assert.equal(route.stack[0].handle, require('../src/middleware/auth'));
for (const user of ['owner', 'foreign']) {
  db.prepare("INSERT INTO users(id,name,email,password_hash) VALUES (?,'Synthetic',?,'')").run(user, `${user}@example.invalid`);
  db.prepare("INSERT INTO runs(id,user_id,date,type,distance_miles,duration_seconds) VALUES (?,?,'2026-10-19T03:30:00Z','easy',5,3000)").run(`${user}-run`, user);
  db.prepare("INSERT INTO personal_records(id,user_id,category,label,value,unit,run_id) VALUES (?,?,'time_pr','Time PR: 5K',2678,'seconds','owner-run')").run(`${user}-pr`, user);
  db.prepare("INSERT INTO workout_sessions(id,user_id,started_at,ended_at,total_seconds) VALUES (?,?,'2026-10-19T03:45:00Z','2026-10-19T04:05:00Z',1200)").run(`${user}-session`, user);
  // Foreign set intentionally references owner's session: both ownership clauses matter.
  db.prepare("INSERT INTO workout_sets(id,user_id,session_id,exercise_name,set_number,reps,weight_lbs) VALUES (?,?,'owner-session','Squat',1,5,100)").run(`${user}-set`, user);
  db.prepare("INSERT INTO lifts(id,user_id,date,exercise_name,sets,reps,weight_lbs) VALUES (?,?,'2026-10-18','Press',3,8,50)").run(`${user}-lift`, user);
}
db.prepare("INSERT INTO personal_records(id,user_id,category,label,value,unit,run_id) VALUES ('unrelated','owner','run','Latest other PR',9,'mi','other-run')").run();
db.prepare("INSERT INTO workout_sessions(id,user_id,started_at,ended_at) VALUES ('old','owner','2026-10-16','2026-10-16')").run();
db.prepare("INSERT INTO workout_sessions(id,user_id,started_at) VALUES ('active','owner','2026-10-18')").run();
db.prepare("INSERT INTO runs(id,user_id,date,type) VALUES ('plain','owner','2026-10-18','easy')").run();
db.prepare("INSERT INTO runs(id,user_id,date,type) VALUES ('walk','owner','2026-10-18','walk')").run();
db.prepare("INSERT INTO workout_sets(id,user_id,session_id,exercise_name,reps,weight_lbs) VALUES ('owner-foreign-session','owner','foreign-session','Foreign session',9,999)").run();
// A same-day PR with no exact run link must never decorate this run.
db.prepare("INSERT INTO personal_records(id,user_id,category,label,value,unit,achieved_at) VALUES ('date-only','owner','time_pr','Phantom',1,'seconds','2026-10-18')").run();
(async () => {
  const { activityShareModels } = await import(pathToFileURL(path.join(__dirname, '../../frontend/src/lib/shareStudioModel.js')));

  // Invoke the registered middleware chain without opening a socket (sandbox).
  // Auth/JWT, handler, parameterized SQL and in-memory DB are the real modules.
  const request = async (id, day = '2026-10-18', user = 'owner') => {
    const result = { status: 200 };
    const req = { params: { id }, query: { local_date: day },
      headers: user ? { authorization: `Bearer ${jwt.sign({ id: user }, process.env.JWT_SECRET)}` } : {} };
    const res = { status(code) { result.status = code; return this; }, json(data) { result.data = JSON.parse(JSON.stringify(data)); return this; } };
    let index = 0;
    const next = () => route.stack[index++]?.handle(req, res, next);
    await next();
    return result;
  };
  assert.equal((await request('owner-run', undefined, null)).status, 401);
  assert.equal((await request('owner-run', undefined, 'foreign')).status, 404);
  assert.equal((await request('missing')).status, 404);
  assert.equal((await request('walk')).status, 404);
  for (const day of ['', null, ['2026-10-18'], {}, '2026-02-30', '2025-02-29', '2026-13-01', '2026-10-18T00:00:00Z', '2026-10-18 OR 1=1', 'garbage']) assert.equal((await request('owner-run', day)).status, 400);
  const result = await request('owner-run');
  assert.equal(result.status, 200);
  assert.deepEqual(result.data, {
    run_id: 'owner-run', local_date: '2026-10-18',
    prs: [{ label: 'Time PR: 5K', value: 2678, unit: 'seconds', run_id: 'owner-run' }],
    sessions: [{ id: 'owner-session', started_at: '2026-10-19T03:45:00Z', ended_at: '2026-10-19T04:05:00Z', total_seconds: 1200, calories_burned: null }],
    sets: [{ session_id: 'owner-session', set_number: 1, exercise_name: 'Squat', reps: 5, weight_lbs: 100 }],
    lifts: [{ date: '2026-10-18', exercise_name: 'Press', sets: 3, reps: 8, weight_lbs: 50, workout_duration_seconds: null, calories: null, avg_heart_rate: null }],
  });
  assert.doesNotMatch(JSON.stringify(result.data), /user_id|foreign|notes|created_at|achieved_at|route_coords|password/);
  const activity = { id: 'owner-run', date: '2026-10-19T03:30:00Z', distance_miles: 5, duration_seconds: 3000 };
  const model = (context, timezone = 'America/New_York') => activityShareModels(activity, context, { timezone }, true);
  assert.equal(model(result.data).run.pr.value, '44:38');
  assert.equal(model(result.data).hybrid.hero.value, '1:10:00');
  assert.equal(model(result.data).hybrid.lift.stats.find(s => s.key === 'volume').value, '500', 'only sets linked to the owned session');
  assert.equal(model({ ...result.data, run_id: 'another-run' }).run.pr, null);
  assert.equal(model({ ...result.data, run_id: 'another-run' }).hybrid, null);
  assert.equal(model(result.data, 'Asia/Tokyo').hybrid, null, 'stale local day rejected');
  const tokyo = await request('owner-run', '2026-10-19');
  assert.equal(model(tokyo.data, 'Asia/Tokyo').hybrid.kind, 'hybrid');
  // Query includes neighboring UTC dates; adapters, not host timezone/SQL date,
  // enforce the actual activity-local day. No fabricated empty/session PR side.
  db.prepare("UPDATE workout_sessions SET started_at='2026-10-19T04:00:00Z' WHERE id='owner-session'").run();
  db.prepare("DELETE FROM lifts WHERE user_id='owner'").run();
  const midnight = await request('owner-run');
  assert.equal(model(midnight.data).hybrid, null);
  db.prepare("UPDATE workout_sessions SET started_at='2026-10-19T03:59:59Z' WHERE id='owner-session'").run();
  assert.equal(model((await request('owner-run')).data).hybrid.kind, 'hybrid');
  db.prepare("UPDATE workout_sessions SET started_at='2026-10-18T23:59:59-04:00' WHERE id='owner-session'").run();
  assert.equal(model((await request('owner-run')).data).hybrid.kind, 'hybrid', 'recorded offset date preserved');
  db.prepare("UPDATE workout_sessions SET ended_at=NULL WHERE id='owner-session'").run();
  assert.equal(model((await request('owner-run')).data).hybrid, null, 'unfinished session excluded');
  assert.equal((await request('owner-run', '2028-02-29')).status, 200);
  assert.equal((await request('plain')).data.prs.length, 0);
  assert.equal((await request("owner-run' OR 1=1 --")).status, 404);
  for (const call of calls) {
    assert.equal(call.method === 'get' || call.method === 'all', true, 'no writes');
    assert.match(call.sql, /user_id=\?|SELECT id FROM users WHERE id = \?/);
    assert.ok(call.params.includes('owner') || call.params.includes('foreign'));
  }
  console.log('ACTIVITY SHARE CONTEXT OK (auth, exact PR, foreign run/PR/session/set/lift, parameterization, date window, no writes)');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { db.close(); });
