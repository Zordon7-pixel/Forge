const { PlanningError, MAX_BYTES, TTL_MS } = require('../services/plannedLeg');

// Also present in schema.pg.sql for fresh installations. INTEGER/BIGINT/TEXT
// and parameterized queries work with the existing SQLite test/dev adapters.
const DDL = [
`CREATE TABLE IF NOT EXISTS ors_planning_global (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  day_bucket BIGINT NOT NULL,
  minute_bucket BIGINT NOT NULL,
  day_count INTEGER NOT NULL CHECK (day_count BETWEEN 0 AND 1900),
  minute_count INTEGER NOT NULL CHECK (minute_count BETWEEN 0 AND 35),
  blocked_until BIGINT NOT NULL
);`,
`CREATE TABLE IF NOT EXISTS ors_planning_users (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  day_bucket BIGINT NOT NULL,
  minute_bucket BIGINT NOT NULL,
  day_count INTEGER NOT NULL CHECK (day_count BETWEEN 0 AND 100),
  minute_count INTEGER NOT NULL CHECK (minute_count BETWEEN 0 AND 10)
);`,
`CREATE TABLE IF NOT EXISTS ors_planning_cache (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cache_key TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (length(payload) <= 524288),
  created_ms BIGINT NOT NULL,
  expires_ms BIGINT NOT NULL,
  PRIMARY KEY (user_id, cache_key)
);`,
'CREATE INDEX IF NOT EXISTS idx_ors_planning_cache_age ON ors_planning_cache(created_ms, user_id, cache_key);',
];
async function installPlanningStore(tx) {
  // Caller holds a migration transaction/lock. Never replenish missing budget
  // state on restart: the durable migration marker only permits one seed.
  await tx.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id SERIAL PRIMARY KEY, version TEXT UNIQUE NOT NULL, executed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
  )`);
  const marker = await tx.get('SELECT version FROM schema_migrations WHERE version=?', ['ors-planning-v1']);
  for (const sql of DDL) await tx.run(sql);
  if (!marker) {
    await tx.run(`INSERT INTO ors_planning_global
      (id,day_bucket,minute_bucket,day_count,minute_count,blocked_until) VALUES (1,-1,-1,0,0,0)`);
    await tx.run('INSERT INTO schema_migrations (version) VALUES (?)', ['ors-planning-v1']);
  }
}
const unknown = () => { throw new PlanningError('PLANNING_UNAVAILABLE'); };
const integer = n => Number.isSafeInteger(n) && n >= 0;
function checked(row, dayCap, minuteCap) {
  if (!row || !Number.isSafeInteger(row.day_bucket) || row.day_bucket < -1
    || !Number.isSafeInteger(row.minute_bucket) || row.minute_bucket < -1
    || !integer(row.day_count) || row.day_count > dayCap
    || !integer(row.minute_count) || row.minute_count > minuteCap
    || row.minute_count > row.day_count) unknown();
  if (row.day_bucket === -1 || row.minute_bucket === -1) {
    if (row.day_bucket !== -1 || row.minute_bucket !== -1 || row.day_count !== 0 || row.minute_count !== 0) unknown();
  } else if (Math.floor(row.minute_bucket / 1440) !== row.day_bucket) unknown();
  return row;
}
function counts(row, day, minute) {
  if (row.day_bucket > day || row.minute_bucket > minute) unknown();
  return [row.day_bucket === day ? row.day_count : 0, row.minute_bucket === minute ? row.minute_count : 0];
}
function createPlanningStore({ withUserMutation, dbGet, dialect = 'postgres' }) {
  if (!['postgres', 'sqlite'].includes(dialect)) unknown();
  const clockSql = dialect === 'postgres'
    ? 'SELECT CAST(FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000) AS BIGINT) AS now_ms'
    : "SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now_ms";
  async function now(query = dbGet) {
    const row = await query(clockSql);
    if (!integer(row?.now_ms)) unknown();
    return row.now_ms;
  }
  async function locked(owner, fn) {
    return withUserMutation(owner, async tx => {
      // A write lock serializes reservations AND cache eviction across instances.
      // SQLite adapters use BEGIN IMMEDIATE; PostgreSQL locks this singleton row.
      const lock = await tx.run('UPDATE ors_planning_global SET id=id WHERE id=1');
      if (lock?.changes !== 1) unknown();
      const global = checked(await tx.get('SELECT * FROM ors_planning_global WHERE id=1'), 1900, 35);
      if (!integer(global.blocked_until)) unknown();
      const time = await now(tx.get);
      counts(global, Math.floor(time / TTL_MS), Math.floor(time / 60000));
      return fn(tx, global, time);
    });
  }
  return {
    now,
    lookup: (owner, key) => locked(owner, async (tx, _global, time) => {
      const row = await tx.get('SELECT payload, created_ms, expires_ms FROM ors_planning_cache WHERE user_id=? AND cache_key=?', [owner, key]);
      if (!row) return null;
      if (!integer(row.created_ms) || row.created_ms > time || row.expires_ms !== row.created_ms + TTL_MS
        || typeof row.payload !== 'string' || Buffer.byteLength(row.payload) > MAX_BYTES) unknown();
      return row.expires_ms > time ? row.payload : null;
    }),
    reserve: (owner, units = 1) => locked(owner, async (tx, global, time) => {
      if (!Number.isSafeInteger(units) || units < 1 || units > 3) unknown();
      if (global.blocked_until > time) throw new PlanningError('PROVIDER_RATE_LIMITED', 429,
        Math.min(86400, Math.ceil((global.blocked_until - time) / 1000)));
      const day = Math.floor(time / TTL_MS), minute = Math.floor(time / 60000);
      await tx.run(`INSERT INTO ors_planning_users (user_id,day_bucket,minute_bucket,day_count,minute_count)
        VALUES (?,?,?,0,0) ON CONFLICT (user_id) DO NOTHING`, [owner, day, minute]);
      const user = checked(await tx.get('SELECT * FROM ors_planning_users WHERE user_id=?', [owner]), 100, 10);
      const [gd, gm] = counts(global, day, minute), [ud, um] = counts(user, day, minute);
      if (gd + units > 1900 || ud + units > 100) throw new PlanningError('PLANNING_LIMIT', 429, Math.ceil(((day + 1) * TTL_MS - time) / 1000));
      if (gm + units > 35 || um + units > 10) throw new PlanningError('PLANNING_LIMIT', 429, Math.ceil(((minute + 1) * 60000 - time) / 1000));
      const globalWrite = await tx.run('UPDATE ors_planning_global SET day_bucket=?, minute_bucket=?, day_count=?, minute_count=? WHERE id=1', [day, minute, gd + units, gm + units]);
      const userWrite = await tx.run('UPDATE ors_planning_users SET day_bucket=?, minute_bucket=?, day_count=?, minute_count=? WHERE user_id=?', [day, minute, ud + units, um + units, owner]);
      if (globalWrite?.changes !== 1 || userWrite?.changes !== 1) unknown();
    }),
    checkCooldown: owner => locked(owner, (_tx, global, time) => {
      if (global.blocked_until > time) throw new PlanningError('PROVIDER_RATE_LIMITED', 429,
        Math.min(86400, Math.ceil((global.blocked_until - time) / 1000)));
    }),
    cooldown: (owner, seconds) => locked(owner, async (tx, global, time) => {
      await tx.run('UPDATE ors_planning_global SET blocked_until=? WHERE id=1', [Math.max(global.blocked_until, time + seconds * 1000)]);
    }),
    remainingCooldown: owner => locked(owner, (_tx, global, time) => Math.max(1, Math.min(86400, Math.ceil((global.blocked_until - time) / 1000)))),
    save: (owner, key, payload) => locked(owner, async (tx, _global, time) => {
      if (typeof payload !== 'string' || Buffer.byteLength(payload) > MAX_BYTES) unknown();
      // Only disposable planning artifacts are evicted, never recorded evidence.
      await tx.run('DELETE FROM ors_planning_cache WHERE expires_ms<=?', [time]);
      await tx.run(`INSERT INTO ors_planning_cache (user_id,cache_key,payload,created_ms,expires_ms)
        VALUES (?,?,?,?,?) ON CONFLICT (user_id,cache_key) DO UPDATE SET
        payload=excluded.payload, created_ms=excluded.created_ms, expires_ms=excluded.expires_ms`, [owner, key, payload, time, time + TTL_MS]);
      const count = await tx.get('SELECT COUNT(*) AS n FROM ors_planning_cache');
      if (!integer(count?.n)) unknown();
      if (count.n > 10000) {
        const victims = await tx.all('SELECT user_id,cache_key FROM ors_planning_cache ORDER BY created_ms,user_id,cache_key LIMIT ?', [count.n - 10000]);
        for (const victim of victims) await tx.run('DELETE FROM ors_planning_cache WHERE user_id=? AND cache_key=?', [victim.user_id, victim.cache_key]);
      }
    }),
  };
}
module.exports = { createPlanningStore, installPlanningStore, DDL };
