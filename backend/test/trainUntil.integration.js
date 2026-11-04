// Real unchanged runtime preview/validation/generation, in process. Only the DB
// seam is synthetic storage. No HTTP/auth, PG, apply, inference or production QA.
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const Module = require('node:module');

async function main() {
  // Explicit read-only dependency reuse; no installs or worktree symlinks.
  if (process.env.TRAIN_UNTIL_BACKEND_DEPS) {
    process.env.NODE_PATH = path.join(process.env.TRAIN_UNTIL_BACKEND_DEPS, 'node_modules');
    Module._initPaths();
    console.log('DEPENDENCIES: existing external packages; exact-lock host QA still required');
  }
  const allowedEnv = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'NODE_PATH']);
  for (const key of Object.keys(process.env)) if (!allowedEnv.has(key)) delete process.env[key];
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'synthetic-local-train-until-test-only';
  process.env.FORGE_BETA_ACCESS = 'false';
  process.env.FORGE_GOAL_BACKWARD_V24_MODE = 'off';
  // No provider request or real connection is permitted, even accidentally.
  const forbidden = () => { throw new Error('NETWORK_FORBIDDEN_IN_SYNTHETIC_TEST'); };
  global.fetch = forbidden;
  require('node:net').Socket.prototype.connect = forbidden;
  for (const protocol of ['node:http', 'node:https']) {
    require(protocol).request = forbidden;
    require(protocol).get = forbidden;
  }
  const ownerId = '11111111-1111-4111-8111-111111111111';
  const start = '2026-11-03'; // Tuesday: route target anchor differs from emitted Monday week.
  const user = { id: ownerId, weekly_miles_current: 20, run_days_per_week: 3,
    lift_days_per_week: 0, preferred_workout_days: '["Tue","Thu","Sat"]',
    goal_type: 'race', comeback_mode: 0, injury_notes: '', planning_input_revision: 0 };
  let reads = 0, mutations = 0;
  const tx = {
    async get(sql, params = []) {
      reads++;
      if (/FROM users WHERE id\s*=\s*\?/.test(sql)) {
        assert.equal(params[0], ownerId);
        return { ...user };
      }
      if (/SELECT MAX\(date\) AS last_date FROM (runs|lifts)/.test(sql) || sql.includes('MAX(substr(started_at')) return { last_date: null };
      if (/SELECT max_hr|SELECT max_heart_rate/.test(sql)) return { ...user };
      // Isolated empty storage: no active plans, races, health or injury rows.
      return null;
    },
    async all() { reads++; return []; },
    async run() { mutations++; throw new Error('UNEXPECTED_STORAGE_WRITE'); },
  };
  const dbPath = require.resolve('../src/db');
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
    dbGet: tx.get, dbAll: tx.all, dbRun: tx.run,
    runWithUserContext: (_id, fn) => fn(),
    withUserMutation: async (id, fn) => { assert.equal(id, ownerId); return fn(tx); },
    withPlanningInputMutation: forbidden,
  } };
  const plans = require('../src/routes/plans')._test;
  const { loadTrainUntilHelper } = await import(pathToFileURL(path.resolve(__dirname, '../../frontend/test/trainUntil.smoke.mjs')).href);
  const convert = loadTrainUntilHelper();
  const target = { distanceMiles: 6.2, trainingDays: ['Tue','Thu','Sat'], runEligibleWeekdays: ['Tue','Thu','Sat'],
    runDaysPerWeek: 3, liftEligibleWeekdays: ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],
    liftingEnabled: false, liftDaysPerWeek: 0, planMode: 'run_only', equipment: [] };
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [`${start}T12:00:00Z`])); }
    static now() { return Date.parse(`${start}T12:00:00Z`); }
  }
  global.Date = FixedDate;
  let failures = 0;
  try {
    for (let weeks = 4; weeks <= 20; weeks++) {
      const date = new RealDate(RealDate.parse(`${start}T12:00:00Z`) + weeks * 7 * 86400000).toISOString().slice(0,10);
      const ui = convert(date, start);
      assert.equal(ui.weeks, weeks);
      assert.equal(ui.error, '');
      try {
        const candidate = await plans.previewPlanForUser(ownerId, { target: { ...target, weeks: ui.weeks },
          planning_date_local: start, timezone_offset_minutes: 0, planning_timezone: 'UTC' }, { store: false });
        assert.equal(candidate.plan.weeks.length, weeks);
        assert.equal(candidate.diagnostics.snapshot.context.target.startDate, start);
        assert.equal(candidate.plan.weeks[0].startDate, '2026-11-02'); // Existing generator aligns output to Monday.
        assert.equal(candidate.diagnostics.snapshot.request.target.weeks, weeks);
        assert.equal(candidate.diagnostics.snapshot.request.target.raceDate, undefined);
        console.log(`PASS UI ${date} -> target.weeks=${weeks}; real runtime preview, validation and generation`);
      } catch (error) {
        failures++;
        console.error(`FAIL real generation for UI weeks=${weeks}: ${error.code || error.name}: ${error.message}`);
        if (error.details) console.error(JSON.stringify(error.details));
      }
    }
    // Bypassing the UI with raw numeric values exercises the inherited clamp.
    for (const [rawWeeks, generatedWeeks] of [[3, 4], [21, 20]]) {
      const candidate = await plans.previewPlanForUser(ownerId, { target: { ...target, weeks: rawWeeks },
        planning_date_local: start, timezone_offset_minutes: 0, planning_timezone: 'UTC' }, { store: false });
      assert.equal(candidate.plan.weeks.length, generatedWeeks);
      console.log(`PASS inherited backend clamp ${rawWeeks} -> ${generatedWeeks}; not backend rejection`);
    }
    const before = reads;
    for (const days of [-1, 0, 21, 141]) {
      const date = new RealDate(RealDate.parse(`${start}T12:00:00Z`) + days * 86400000).toISOString().slice(0,10);
      const ui = convert(date, start);
      assert.equal(ui.weeks, null);
      assert.ok(ui.error); // Frontend gate does not call preview on these dates.
    }
    assert.ok(convert('2027-02-29', start).error);
    assert.equal(reads, before);
    assert.equal(mutations, 0);
    console.log('PASS invalid range/calendar conversion blocked in frontend; zero storage writes. Backend numeric weeks are clamped, NOT rejected.');
    if (failures) throw new Error(`${failures}/17 real generation cases failed; inherited generator is unchanged, not waived`);
  } finally { global.Date = RealDate; }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
