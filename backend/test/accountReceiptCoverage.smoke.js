#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const {
  ACCOUNT_EXPORT_TABLES,
  ACCOUNT_DELETE_QUERIES,
  ACCOUNT_SOCIAL_DELETE_QUERIES,
} = require('../src/lib/accountDataCoverage');

const TABLES = ['activity_measured_receipts', 'provider_import_receipts'];
const OWNER = 'receipt-owner';
const OTHER = 'receipt-other';
const PASSWORD = 'synthetic-password';

async function runAccountReceiptCoverageSmoke() {
  const sqlite = new DatabaseSync(':memory:');
  const dbPath = require.resolve('../src/db');
  const authPath = require.resolve('../src/routes/auth');
  const middlewarePath = require.resolve('../src/middleware/auth');
  const boundedPath = require.resolve('../src/db/backgroundSyncWorker');
  const cached = [dbPath, authPath, middlewarePath,boundedPath].map(id => [id, require.cache[id]]);
  const originalConsoleError = console.error;
  const errors = [];
  let failBeforeUserDelete = false;
  let commits = 0;
  let rollbacks = 0;
  const receiptDeletes = [];
  const sqlErrors = [];
  let wrappers=0,closed=0,passwordReads=0;
  try {
    sqlite.exec('PRAGMA foreign_keys = ON; CREATE TABLE users (id TEXT PRIMARY KEY, password_hash TEXT);');
    for (const user of [OWNER, OTHER]) {
      sqlite.prepare('INSERT INTO users VALUES (?, ?)').run(user, bcrypt.hashSync(PASSWORD, 4));
    }
    // Use the checked-in schema without loading the application's database or environment.
    const schema = fs.readFileSync(path.join(__dirname, '../src/db/schema.pg.sql'), 'utf8');
    for (const table of TABLES) {
      const ddl = schema.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`))?.[0];
      assert.ok(ddl, `${table} schema must exist`);
      sqlite.exec(ddl.replace('JSONB', 'TEXT').replace('pg_column_size(payload_json)', 'length(payload_json)')
        .replace('TIMESTAMPTZ', 'TEXT'));
      // Insert out of order, with identical timestamps and overlapping owner/revision bindings.
      for (const user of [OTHER, OWNER]) {
        for (const revision of [1, 3, 2]) {
          const payload = table === TABLES[0]
            ? { version: 'activity-measured-v1', completeness: 'PARTIAL',
              actual: { duration_s: 600, distance_m: null, work_duration_s: null, sets: null },
              binding: { plan_revision: 7, session_revision: 2, expected_revision: revision - 1 },
              supersedes_receipt_id: revision === 1 ? null : `${table}-${user}-${revision - 1}` }
            : { version: 'garmin-terminal-coverage-v1', status: revision === 3 ? 'FAILED' : 'PARTIAL',
              terminal: false, pages: 0, unknown_items: 0, failed_items: revision === 3 ? 1 : 0, bindings: [] };
          const common = [`${table}-${user}-${revision}`, user];
          const binding = table === TABLES[0] ? ['lift', 'shared-activity', 'shared-plan', 'shared-session'] : ['garmin'];
          const values = [...common, ...binding, revision, JSON.stringify(payload), `synthetic-hash-${user}-${revision}`, '2026-09-13T00:00:00Z'];
          sqlite.prepare(`INSERT INTO ${table} VALUES (${values.map(() => '?').join(',')})`).run(...values);
        }
      }
    }
    const rows = (table, owner) => sqlite.prepare(`SELECT * FROM ${table}${owner ? ' WHERE user_id = ?' : ''} ORDER BY revision DESC, id ASC`)
      .all(...(owner ? [owner] : [])).map(row => ({ ...row }));
    const before = Object.fromEntries(TABLES.map(table => [table, rows(table)]));
    const userBefore = sqlite.prepare('SELECT * FROM users ORDER BY id').all();
    const receiptSql = sql => TABLES.some(table => new RegExp(`\\b${table}\\b`).test(sql));
    const runSql = (sql, params) => {
      try { return sqlite.prepare(sql).all(...params); }
      catch (err) { sqlErrors.push(err.message); throw err; }
    };
    const unrelatedDeletes = new Set([...ACCOUNT_SOCIAL_DELETE_QUERIES, ...ACCOUNT_DELETE_QUERIES]
      .map(([sql]) => sql).filter(sql => !receiptSql(sql)));
    const db = {
      pool: Object.freeze({connect:()=>{throw new Error('Receipt fixture must not acquire a real PG connection');}}),
      dbGet: async (sql, params) => {
        assert.match(sql, /FROM users WHERE id = \?/);
        return sqlite.prepare('SELECT id FROM users WHERE id = ?').get(...params);
      },
      dbAll: async (sql, params) => receiptSql(sql) ? runSql(sql, params) : [],
      dbRun: async () => { throw new Error('Write outside account transaction'); },
      withTransaction: async (fn, options) => {
        assert.deepEqual(options, { userIds: [OWNER], userLock: 'update', requireUserIds: [OWNER] });
        sqlite.exec('BEGIN');
        try {
          const result = await fn({
            get: async (sql, params) => {
              if(sql === "SELECT 1 AS present FROM web_push_setup_rate_buckets WHERE dimension='USER' LIMIT 1")return null;
              assert.equal(sql,'SELECT id, password_hash FROM users WHERE id = ?');assert.deepEqual(params,[OWNER]);passwordReads++;
              return sqlite.prepare(sql).get(...params);
            }, // Unrelated empty setup fixture; receipt queries remain real.
            all: async (sql, params) => {
              const emptyAuthority = new Set([
                'SELECT c.endpoint_hash,c.incarnation,c.subscription_id FROM web_push_claims c JOIN push_subscriptions p ON p.id=c.subscription_id WHERE p.user_id=? ORDER BY c.endpoint_hash FOR UPDATE OF c',
                'SELECT id FROM push_subscriptions WHERE user_id=? ORDER BY id FOR UPDATE',
                'SELECT id FROM web_push_challenges WHERE user_id=? ORDER BY id FOR UPDATE',
                'SELECT o.challenge_id FROM web_push_setup_operations o JOIN web_push_challenges c ON c.id=o.challenge_id WHERE c.user_id=? ORDER BY o.challenge_id FOR UPDATE OF o',
                'SELECT id FROM notification_deliveries WHERE user_id=? ORDER BY id FOR UPDATE',
              ]);
              if(emptyAuthority.has(sql.replace(/\s+/g,' ').trim())){assert.deepEqual(params,[OWNER]);return [];}
              assert.match(sql, /FROM challenges c/);
              assert.deepEqual(params, [OWNER]);
              return []; // No social fixtures; receipt SQL below always executes in SQLite.
            },
            run: async (sql, params) => {
              if (receiptSql(sql)) {
                assert.deepEqual(params, [OWNER]);
                receiptDeletes.push(sql);
                return sqlite.prepare(sql).run(...params);
              }
              if (sql === 'DELETE FROM users WHERE id = ?') {
                for (const table of TABLES) {
                  assert.deepEqual(rows(table, OWNER), [], `${table} explicitly deleted before user cascade`);
                  assert.deepEqual(rows(table, OTHER), before[table].filter(row => row.user_id === OTHER));
                }
                if (failBeforeUserDelete) throw new Error('synthetic failure after both receipt deletes');
                return sqlite.prepare(sql).run(...params);
              }
              assert.ok(unrelatedDeletes.has(sql), `Unexpected SQL: ${sql}`);
              return { changes: 0 };
            },
          });
          sqlite.exec('COMMIT');
          commits++;
          return result;
        } catch (err) {
          sqlite.exec('ROLLBACK');
          rollbacks++;
          throw err;
        }
      },
    };
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
    require.cache[boundedPath]={id:boundedPath,filename:boundedPath,loaded:true,exports:{createWorkerDatabase:({pool})=>{
      assert.equal(pool,db.pool);wrappers++;
      return {withOwnerMutation:async(owner,fn,{signal})=>{
        assert.equal(owner,OWNER);assert.ok(signal instanceof AbortSignal);assert.equal(signal.aborted,false);
        return db.withTransaction(fn,{userIds:[OWNER],userLock:'update',requireUserIds:[OWNER]});
      },close:async()=>{closed++;}};
    }}};
    delete require.cache[authPath];
    delete require.cache[middlewarePath];
    const router = require('../src/routes/auth');
    const invoke = async (routePath, method, owner) => {
      const route = router.stack.find(layer => layer.route?.path === routePath && layer.route.methods[method]);
      const handler = route?.route.stack.at(-1)?.handle;
      assert.equal(typeof handler, 'function');
      const response = { statusCode: 200, payload: null,
        status(code) { this.statusCode = code; return this; },
        setHeader() {}, json(payload) { this.payload = JSON.parse(JSON.stringify(payload)); return this; } };
      await handler({ user: { id: owner }, body: { password: PASSWORD, confirm: 'DELETE' } }, response);
      return response;
    };
    for (const owner of [OWNER, OTHER]) {
      const response = await invoke('/me/export', 'get', owner);
      assert.equal(response.statusCode, 200);
      for (const table of TABLES) {
        assert.equal(ACCOUNT_EXPORT_TABLES.filter(entry => entry.key === table).length, 1);
        assert.ok(response.payload.metadata.categories_included.includes(table));
        assert.deepEqual(response.payload[table], before[table].filter(row => row.user_id === owner),
          'Export must retain all columns, null payload values, hashes, and every revision for this owner only');
        assert.deepEqual(response.payload[table].map(row => row.revision), [3, 2, 1]);
      }
      const actual = JSON.parse(response.payload.activity_measured_receipts[0].payload_json).actual;
      assert.equal(actual.distance_m, null);
      assert.equal(actual.work_duration_s, null);
      assert.equal(actual.sets, null);
      assert.equal(JSON.parse(response.payload.provider_import_receipts[0].payload_json).status, 'FAILED');
    }
    assert.deepEqual(sqlErrors, [], 'Export safeAll must not conceal invalid receipt SQL');
    console.error = (...args) => errors.push(args.map(String).join(' '));
    failBeforeUserDelete = true;
    const failed = await invoke('/account', 'delete', OWNER);
    assert.equal(failed.statusCode, 500);
    assert.deepEqual(failed.payload, { error: 'Failed to delete account' });
    assert.ok(errors.some(error => error.includes('synthetic failure after both receipt deletes')));
    assert.equal(rollbacks, 1);
    assert.equal(commits, 0);
    assert.equal(receiptDeletes.length, 2, 'Both receipt deletes must execute before rollback');
    for (const table of TABLES) assert.deepEqual(rows(table), before[table], `${table} restored byte-for-byte`);
    assert.deepEqual(sqlite.prepare('SELECT * FROM users ORDER BY id').all(), userBefore);

    failBeforeUserDelete = false;
    const success = await invoke('/account', 'delete', OWNER);
    assert.equal(success.statusCode, 200);
    assert.deepEqual(success.payload, { ok: true });
    assert.equal(commits, 1);
    assert.equal(rollbacks, 1);
    assert.equal(receiptDeletes.length, 4);
    for (const table of TABLES) assert.deepEqual(rows(table), before[table].filter(row => row.user_id === OTHER));
    assert.deepEqual(sqlite.prepare('SELECT id FROM users').all().map(row => row.id), [OTHER]);
    assert.equal(passwordReads,2);assert.equal(wrappers,2);assert.equal(closed,2,'success and rollback both close their borrowed wrapper');
  } finally {
    console.error = originalConsoleError;
    for (const [id, module] of cached) {
      if (module) require.cache[id] = module;
      else delete require.cache[id];
    }
    sqlite.close();
  }
}

if (require.main === module) {
  runAccountReceiptCoverageSmoke()
    .then(() => console.log('Account receipt coverage smoke OK: owner exports, null/revision truth, owner deletion, SQLite rollback.'))
    .catch(err => { console.error(err); process.exitCode = 1; });
}

module.exports = { runAccountReceiptCoverageSmoke };
