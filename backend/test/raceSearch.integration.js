// Gates A/C: actual Express routes, auth, premium middleware, PostgreSQL adapter,
// deterministic preview + apply. No repository/database/provider mocks.
// Run with exact installed lock dependencies; creates its OWN disposable cluster.
// RACE_QA_ARTIFACT_DIR=/absolute/evidence node backend/test/raceSearch.integration.js
// --probe-postgres needs no npm packages. Never accepts an existing DATABASE_URL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const Module = require('node:module');
const root = path.resolve(__dirname, '../..');

function artifactDir() {
  const dir = process.env.RACE_QA_ARTIFACT_DIR;
  assert.ok(dir && path.isAbsolute(dir), 'Set RACE_QA_ARTIFACT_DIR to a durable absolute evidence directory');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function exactDependencies(part) {
  const dir = path.join(root, part);
  const wanted = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'))).packages;
  const failures = [];
  for (const [key, value] of Object.entries(wanted)) {
    if (!key.startsWith('node_modules/') || value.optional) continue;
    const file = path.join(dir, key, 'package.json');
    if (!fs.existsSync(file)) { failures.push(`${key}: missing`); continue; }
    if (JSON.parse(fs.readFileSync(file)).version !== value.version) failures.push(`${key}: version differs from lock`);
  }
  fs.writeFileSync(path.join(artifactDir(), `${part}-dependencies.json`), JSON.stringify({ part, failures }, null, 2));
  assert.deepEqual(failures, [], `${part}: exact installed dependencies required; no download or incompatible reuse`);
}
function identity() {
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(r.status, 0); return r.stdout.trim();
  };
  const paths = [...new Set([...git('diff', '--name-only', 'HEAD').split('\n'), ...git('ls-files', '--others', '--exclude-standard').split('\n')])].filter(Boolean).sort();
  return { head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'),
    dirty: paths.length > 0, paths: Object.fromEntries(paths.map(p => [p, fs.existsSync(path.join(root,p)) ? createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex') : null])) };
}
function scratchDir(prefix) {
  // Host TMPDIR is system /var/folders; do not silently use it for test data.
  const base = process.env.RACE_QA_SCRATCH_DIR || '/Users/zordon/.hermes/cache/scratch';
  assert.ok(path.isAbsolute(base), 'RACE_QA_SCRATCH_DIR must be absolute');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}
function bounded(label, work, milliseconds = 10000) {
  let timer;
  return Promise.race([
    Promise.resolve().then(work),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}: timed out after ${milliseconds}ms`)), milliseconds); }),
  ]).finally(() => clearTimeout(timer)); // referenced timer prevents an empty exit on unsettled promises
}
async function cleanupSteps(steps) {
  const errors = [];
  for (const [label, action, milliseconds = 10000] of steps) {
    try { await bounded(label, action, milliseconds); } catch (error) { console.error(`CLEANUP FAILED ${label}: ${error.message}`); errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Harness cleanup failed; see individual errors');
}
async function runGuarded(name, work, { cleanup = async () => {}, timeoutMs = 300000 } = {}) {
  const file = path.join(artifactDir(), `${name}-${randomUUID()}-receipt.json`);
  const receipt = { name, status: 'running', startedAt: new Date().toISOString(), candidate: identity() };
  const save = () => fs.writeFileSync(file, JSON.stringify(receipt, null, 2));
  save(); console.log(`START ${name}; receipt=${file}`);
  const onExit = () => {
    if (receipt.status === 'running') {
      receipt.status = 'failed'; receipt.error = 'Execution exited before assertions and cleanup completed';
      save(); console.error(`FAIL ${name}: ${receipt.error}`); process.exitCode = 1;
    }
  };
  process.on('exit', onExit);
  let failure;
  try { await bounded(name, work, timeoutMs); } catch (error) { failure = error; }
  try { await bounded(`${name} cleanup`, () => cleanup(failure), 60000); } catch (error) { failure = failure ? new AggregateError([failure,error], 'Execution and cleanup failed') : error; }
  receipt.finishedAt = new Date().toISOString();
  receipt.status = failure ? 'failed' : 'completed';
  if (failure) receipt.error = require('node:util').inspect(failure, { depth: 5 });
  save(); process.removeListener('exit', onExit);
  console.log(`${failure ? 'FAIL' : 'COMPLETED'} ${name}; receipt=${file}`);
  if (failure) throw failure;
}
function startCluster() {
  const dir = scratchDir('frs-');
  const bin = process.env.RACE_QA_PG_BIN || '/opt/homebrew/bin';
  const log = path.join(artifactDir(), `postgres-${path.basename(dir)}.log`);
  const run = (cmd, args, allowed = [0]) => {
    const result = spawnSync(path.join(bin, cmd), args, { encoding: 'utf8',
      env: { PATH: process.env.PATH, TMPDIR: dir, LC_ALL: 'C' } });
    fs.appendFileSync(log, `${cmd} ${args.join(' ')}\nexit=${result.status}\n${result.stdout || ''}${result.stderr || ''}${result.error?.message || ''}\n`);
    assert.ok(allowed.includes(result.status), `${cmd} failed (exit ${result.status}); see ${log}. Not a PostgreSQL pass.`);
    return result.status;
  };
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    try {
      // Only this invocation's mkdtemp-owned data directory can ever be stopped.
      if (fs.existsSync(path.join(dir,'data','PG_VERSION')) && run('pg_ctl', ['-D',path.join(dir,'data'),'status'], [0,3]) === 0) {
        run('pg_ctl', ['-D',path.join(dir,'data'),'-m','smart','-t','15','-w','stop']);
      }
      stopped = true;
    } finally {
      const serverLog = path.join(dir,'postgres.log');
      if (fs.existsSync(serverLog)) fs.copyFileSync(serverLog, path.join(artifactDir(), `postgres-server-${path.basename(dir)}.log`));
    }
  };
  try {
    run('initdb', ['-D',path.join(dir,'data'),'-A','trust','-U','race_qa','--no-locale','--encoding=UTF8','--no-clean']);
    run('pg_ctl', ['-D',path.join(dir,'data'),'-l',path.join(dir,'postgres.log'),'-o',`-k ${dir} -h '' -p 55481`,'-t','30','-w','start']);
    return { dir, url: `postgresql://race_qa@localhost:55481/postgres?host=${encodeURIComponent(dir)}`, stop };
  } catch (error) {
    try { stop(); } catch (cleanupError) { throw new AggregateError([error,cleanupError], 'Cluster startup and owned-cluster cleanup failed'); }
    throw error;
  }
}
function socketAllowed(args, dir) {
  // net.connect passes a normalized argument array; pg calls Socket.connect(path, undefined).
  const values = Array.isArray(args[0]) ? args[0] : args;
  const first = values[0];
  const socketPath = `${dir}/.s.PGSQL.55481`;
  if (typeof first === 'string' && first.startsWith('/')) return first === socketPath;
  if (first && typeof first === 'object') {
    if (first.path != null) return first.path === socketPath; // HTTP Agent explicitly sets path:null
    return first.host === '127.0.0.1' && Number(first.port) > 0 && Number(first.port) <= 65535;
  }
  return Number(first) > 0 && Number(first) <= 65535 && values[1] === '127.0.0.1';
}
function installSocketGuard(dir, onForbidden) {
  const net = require('node:net');
  const originalConnect = net.Socket.prototype.connect;
  const ownedSockets = new Set();
  net.Socket.prototype.connect = function (...args) {
    if (!socketAllowed(args, dir)) {
      onForbidden();
      // pg installs its error listener AFTER connect(). Match native async failure
      // so pg-pool removes its pending client instead of stranding pool.end().
      process.nextTick(() => this.destroy(new Error('EXTERNAL_NETWORK_FORBIDDEN')));
      return this;
    }
    ownedSockets.add(this);
    this.once('close', () => ownedSockets.delete(this));
    return originalConnect.apply(this,args);
  };
  return { ownedSockets, restore() { net.Socket.prototype.connect = originalConnect; } };
}
function isolateEnvironment() {
  // Process-local only. Do not load .env or inherit provider credentials/config.
  const allowed = new Set(['PATH','HOME','TMPDIR','LANG','TZ','PLAYWRIGHT_BROWSERS_PATH','RACE_QA_ARTIFACT_DIR','RACE_QA_PG_BIN','RACE_QA_SCRATCH_DIR']);
  for (const key of Object.keys(process.env)) if (!allowed.has(key)) delete process.env[key];
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = randomUUID();
  process.env.FORGE_BETA_ACCESS = 'false';
  process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'off';
}
const today = () => new Date().toISOString().slice(0,10);
const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days*86400000).toISOString().slice(0,10);
function planningClock() { return { planning_date_local: today(), timezone_offset_minutes: 0, planning_timezone: 'UTC' }; }

async function startFixture() {
  exactDependencies('backend');
  isolateEnvironment();
  const cluster = startCluster();
  process.env.DATABASE_URL = cluster.url;
  let db, server;
  const originalFetch = global.fetch;
  const http = require('node:http'), https = require('node:https');
  let forbiddenRequests = 0;
  const deny = () => { forbiddenRequests++; throw new Error('EXTERNAL_NETWORK_FORBIDDEN'); };
  // Enforce no paid provider traffic even if a route changes in a future patch.
  const { ownedSockets, restore } = installSocketGuard(cluster.dir, () => forbiddenRequests++);
  global.fetch = (url, options) => {
    if (new URL(url).hostname !== '127.0.0.1') return deny();
    return originalFetch(url, options);
  };
  const originals = [http.request,http.get,https.request,https.get];
  https.request = https.get = deny;
  // Browser uses Vite's proxy, Node tests use fetch. No outbound http clients needed.
  const localHttp = (original) => (...args) => {
    const first = args[0];
    const host = typeof first === 'string' || first instanceof URL ? new URL(first).hostname : first?.hostname || first?.host;
    if (host !== '127.0.0.1') return deny();
    return original(...args);
  };
  http.request = localHttp(originals[0]); http.get = localHttp(originals[1]);
  let cleanupPromise;
  const cleanup = () => cleanupPromise ||= (async () => {
    try {
      await cleanupSteps([
        ['HTTP server close', () => server && new Promise((resolve,reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); })],
        ['route pool end', () => db?.pool.end()],
        ['migration pool end', () => db && require('../src/db/postgres').close()],
      ]);
    } finally {
      // FIN only, on sockets opened by this fixture. No process termination or
      // existing-service stop; a busy/stuck cleanup stays a failed receipt.
      try {
        await bounded('owned socket FIN', () => Promise.all([...ownedSockets].filter(socket => !socket.destroyed).map(socket =>
          new Promise(resolve => { socket.once('close', resolve); socket.end(resolve); }))), 5000);
      } finally {
        try { cluster.stop(); } finally {
          global.fetch = originalFetch;
          restore();
          [http.request,http.get,https.request,https.get] = originals;
        }
      }
    }
  })();
  try {
    return await bounded('fixture startup', async () => {
      db = require('../src/db');
      await db.initDb();
      await db.pool.query(fs.readFileSync(path.join(root,'backend/src/db/schema.pg.sql'),'utf8'));
      // Execute real migration DDL, omitting ONLY production catalog data seeds.
      // No route, database implementation or planner is substituted.
      const filename = require.resolve('../src/db/migrate');
      let source = fs.readFileSync(filename, 'utf8');
      for (const call of ['await seedRaceCatalog();','await seedShoeCatalog();']) {
        assert.equal(source.split(call).length, 2, 'seed omission must have exactly one target');
        source = source.replace(call, '/* Test fixtures are seeded below instead. */');
      }
      const migration = new Module(filename, module);
      migration.filename = filename; migration.paths = Module._nodeModulePaths(path.dirname(filename));
      migration._compile(source, filename);
      await migration.exports.runAlwaysMigrations();
      assert.equal((await db.dbGet('SELECT COUNT(*) AS n FROM race_catalog')).n, 0, 'no production seed');
      const users = {};
      for (const role of ['pro','beta','free']) {
        const id = randomUUID(), password = randomUUID();
        const hash = await require('bcryptjs').hash(password, 4);
        await db.dbRun(`INSERT INTO users (id,name,email,password_hash,is_pro,subscription_status,weekly_miles_current,run_days_per_week,lift_days_per_week,onboarded) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [id, `Synthetic ${role}`, `${role}@example.invalid`, hash, role === 'pro' ? 1 : 0, 'free', 12, 3, 0, 1]);
        // All observations are synthetic, local-only and owned by this new account.
        for (let days = 3; days <= 59; days += 2) {
          await db.dbRun(`INSERT INTO runs (id,user_id,date,type,distance_miles,duration_seconds,perceived_effort) VALUES (?,?,?,?,?,?,?)`,
            [randomUUID(),id,addDays(today(),-days),'easy',4,2400,3]);
        }
        users[role] = { id, password, email: `${role}@example.invalid`, token: require('jsonwebtoken').sign({ id }, process.env.JWT_SECRET, { expiresIn: '1h' }) };
      }
      const date = addDays(today(),56);
      const catalog = [
        ['generic','River and Trail Half Marathon','Meadow','VA',date],
        ['apostrophe',"Women's River Ten-Miler",'Washington','DC',date],
        ['brand-fixture',"Rock 'n' Roll Half Marathon",'Meadow','VA',date],
        ['past','Old River Half Marathon','Meadow','VA',addDays(today(),-1)],
      ];
      for (const [id,name,city,state,raceDate] of catalog) await db.dbRun(
        'INSERT INTO race_catalog (id,name,city,state,race_date,distance_miles,scope) VALUES (?,?,?,?,?,?,?)',
        [id,name,city,state,raceDate,13.1,'local']);
      const express = require('express');
      const app = express();
      app.use(express.json());
      app.use('/api/auth', require('../src/routes/auth'));
      app.use('/api/races', require('../src/routes/races'));
      app.use('/api/plans', require('../src/routes/plans'));
      server = http.createServer(app);
      await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1',resolve); });
      const base = `http://127.0.0.1:${server.address().port}`;
      const call = async (url, { role = 'pro', body, method = body ? 'POST' : 'GET' } = {}) => {
        const res = await global.fetch(base+'/api'+url, { method, headers: { 'content-type':'application/json', ...(role ? { authorization:`Bearer ${users[role].token}` } : {}) }, ...(body ? { body:JSON.stringify(body) } : {}) });
        return { status:res.status, body:await res.json() };
      };
      return { base, users, db, date, call, setBeta(value) { process.env.FORGE_BETA_ACCESS = String(value); },
        async close() { try { assert.equal(forbiddenRequests,0,'no external network attempt'); } finally { await cleanup(); } } };
    }, 120000);
  } catch (error) {
    try { await cleanup(); } catch (cleanupError) { throw new AggregateError([error,cleanupError], 'Fixture startup and cleanup failed'); }
    throw error;
  }
}
async function integration(fixture) {
  const { call, db, users } = fixture;
  const search = q => call('/races/catalog?q='+encodeURIComponent(q));
  assert.equal((await call('/races/catalog?q=river',{role:null})).status,401);
  for (const q of ['River Trail Half','the River and Trail Half Marathon','River & Trail Half','Meadow VA','Women’s River Ten-Miler','womens river 10 miler','Washington D.C.',
    'rock and roll half marathon',"rock'n'roll half marathon",'rock n roll half marathon','rock & roll half-marathon']) {
    const result = await search(q); assert.equal(result.status,200,q); assert.ok(result.body.races.length >= 1,q);
    assert.deepEqual(Object.keys(result.body),['races']);
  }
  for (const q of ['zznotaracexx','the of and n','%_']) assert.deepEqual((await search(q)).body.races,[]);
  console.log('PASS A: real PostgreSQL catalog, auth401, multi-word/location and spelling variants');
  for (const url of ['/plans/generate-for-race/missing','/plans/candidates/missing/apply']) {
    const r=await call(url,{role:'free',body:{}}); assert.equal(r.status,402); assert.equal(r.body.upgrade,true);
  }
  console.log('PASS unchanged free/non-beta generation AND apply HTTP402');
  for (const [role, catalog] of [['pro',true],['pro',false],['beta',false]]) {
    fixture.setBeta(role === 'beta');
    const before = await db.dbGet('SELECT COUNT(*) AS n FROM user_plans WHERE user_id=?',[users[role].id]);
    const race = catalog ? await call('/races/from-catalog/generic',{role,body:{}})
      : await call('/races',{role,body:{race_name:`Arbitrary ${role} Sunrise Event`,race_date:fixture.date,distance_miles:13.1,status:'upcoming'}});
    assert.ok([200,201].includes(race.status),JSON.stringify(race.body));
    const target = {distanceMiles:13.1,trainingDays:['Tue','Thu','Sat'],runEligibleWeekdays:['Tue','Thu','Sat'],liftEligibleWeekdays:['Tue','Thu','Sat'],runDaysPerWeek:3,liftingEnabled:false,liftDaysPerWeek:0,planMode:'run_only',equipment:[]};
    const preview = await call('/plans/generate-for-race/'+race.body.race.id,{role,body:{target,...planningClock()}});
    assert.equal(preview.status,201,JSON.stringify(preview.body));
    assert.equal(preview.body.requires_apply,true);
    const applied = await call('/plans/candidates/'+preview.body.candidate_id+'/apply',{role,body:{...preview.body.apply_bindings,candidate_hash:preview.body.candidate_hash,choice:'train_for_target',...planningClock()}});
    assert.equal(applied.status,200,JSON.stringify(applied.body));
    const after = await db.dbGet('SELECT COUNT(*) AS n FROM user_plans WHERE user_id=?',[users[role].id]);
    assert.equal(after.n,before.n+1);
    const stored = await db.dbGet("SELECT tp.plan_data FROM training_plans tp JOIN user_plans up ON up.plan_id=tp.id WHERE up.user_id=? AND up.status='active'",[users[role].id]);
    assert.ok(JSON.parse(stored.plan_data).weeks.length>0);
    console.log(`PASS real deterministic preview/apply/persistence ${role} ${catalog?'catalog':'manual'}`);
  }
  fixture.setBeta(false);
  assert.equal((await db.dbGet('SELECT COUNT(*) AS n FROM user_plans WHERE user_id=?',[users.free.id])).n,0);
}
function unitTests() {
// Dependency-free domain/date checks. These are NOT HTTP/database/browser E2E.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const course = require('../src/lib/raceCourse');
const tokens = course.normalizeCatalogSearchTokens;
for (const query of ['rock and roll half marathon', "rock'n'roll half marathon", "Rock 'n' Roll Half Marathon", 'rock n roll half marathon', 'Rock & Roll Half-Marathon', 'the rock ’n’ roll halfmarathon']) {
  assert.deepEqual(tokens(query), ['rock', 'roll', 'half', 'marathon'], query);
}
for (const query of ["River Women's Half", 'River Women’s Half', 'River Womens Half', 'the River Womens Half']) {
  assert.deepEqual(tokens(query), ['river', 'womens', 'half'], query);
}
assert.deepEqual(tokens('Festival of the River and Trail'), tokens('Festival River & Trail'));
assert.deepEqual(tokens('Meadow Ten-Miler'), tokens('Meadow 10 miler'));
assert.deepEqual(tokens('Meadow tenmiler'), tokens('Meadow 10 miler'));
assert.deepEqual(tokens('Washington D.C.'), ['washington', 'dc']);
assert.deepEqual(tokens('and n & the of'), []);
assert.deepEqual(tokens(null), []);
assert.deepEqual(tokens('constructor'), ['constructor'], 'object prototype is not an alias');
assert.deepEqual(tokens('rnr'), ['rnr'], 'no brand abbreviation expansion');
assert.deepEqual(tokens('atm'), ['atm'], 'no event abbreviation expansion');
assert.deepEqual(tokens('rocknroll'), ['rocknroll'], 'no compact branded mapping');
assert.equal(tokens(Array(40).fill('unique').map((v,i) => v+i).join(' ')).length, 8);
assert.equal(tokens('a'.repeat(200))[0].length, 40);
assert.ok(!tokens('a'.repeat(160)+' late').includes('late'));
const source = fs.readFileSync(path.join(__dirname, '../../frontend/src/pages/PlanCatalog.jsx'), 'utf8');
if (process.argv.includes('--dates')) {
  // Execute the actual small date helpers, not a duplicate test implementation.
  const helper = name => source.match(new RegExp(`function ${name}\\([^]*?\\n}`))[0];
  for (const instant of ['2026-11-02T12:00:00Z','2026-11-02T23:59:59Z','2026-10-31T12:00:00Z']) {
    class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [instant])); } }
    const ctx = vm.createContext({ Date: FixedDate });
    vm.runInContext(['localTodayISO', 'isValidISODate', 'weeksToRace'].map(helper).join('\n'), ctx);
    assert.equal(ctx.isValidISODate('2026-11-02'), true);
    for (const invalid of ['2026-02-30','2026-13-01','bad','2026-11-02T00:00:00Z']) assert.equal(ctx.isValidISODate(invalid), false);
    const today = ctx.localTodayISO();
    const shifted = days => new Date(Date.parse(today+'T12:00:00Z')+days*86400000).toISOString().slice(0,10);
    assert.equal(ctx.weeksToRace(today), 1, 'today is not past at any local time');
    assert.equal(ctx.weeksToRace(shifted(-1)), null);
    assert.equal(ctx.weeksToRace(shifted(7)), 1, 'seven calendar dates remain one week across DST');
  }
  console.log(`PASS local date semantics ${process.env.TZ}`);
} else {
  for (const TZ of ['UTC', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Honolulu']) {
    const child = spawnSync(process.execPath, [__filename, '--unit', '--dates'], { env: { ...process.env, TZ }, encoding: 'utf8' });
    process.stdout.write(child.stdout); process.stderr.write(child.stderr);
    assert.equal(child.status, 0);
  }
  console.log('PASS generic and exact-query normalization, bounds, no branded aliases, four date-only timezones');
}

}
module.exports = { artifactDir, exactDependencies, identity, startCluster, startFixture, planningClock,
  scratchDir, bounded, cleanupSteps, runGuarded, socketAllowed, installSocketGuard };
if (require.main === module) {
  if (process.argv.includes('--unit')) {
    // Dependency-free canonical checks require no browser/evidence environment.
    unitTests();
  } else {
    let fixture;
    const probe = process.argv.includes('--probe-postgres');
    runGuarded(probe ? 'postgres-probe' : 'backend-integration', async () => {
      if (probe) { const cluster = startCluster(); cluster.stop(); return; }
      fixture = await startFixture();
      await integration(fixture);
    }, { cleanup: () => fixture?.close() }).catch(error => { console.error(error); process.exitCode = 1; });
  }
}
