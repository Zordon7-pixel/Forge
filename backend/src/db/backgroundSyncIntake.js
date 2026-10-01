'use strict';
const { Pool } = require('pg');
const { performance } = require('node:perf_hooks');

const LIMITS = Object.freeze({ acquisition: 150, lock: 150, statement: 750, idle: 1000, whole: 1200 });
const unavailable = () => Object.assign(new Error('Durable webhook intake unavailable'), { code: 'STRAVA_INTAKE_UNAVAILABLE', status: 503 });
const positional = sql => { let index = 0; return sql.replace(/\?/g, () => `$${++index}`); };

// Deliberately separate from authenticated/planning transactions: no user row
// is read/locked. Pool size is finite and acquisition wait is independently bounded.
function createIntakeTransaction(pool) {
  return async function transaction(fn, { signal } = {}) {
    const deadline = performance.now() + LIMITS.whole;
    let client, released = false, closed = false, began = false, committing = false;
    let timer, acquireTimer, rejectDeadline;
    const failure = unavailable();
    const release = destroy => {
      if (client && !released) { released = true; client.removeListener?.('error', cancel); client.release(destroy); }
    };
    const cancel = () => {
      closed = true;
      // pg release(true) ends/destroys the active socket, cancelling outstanding
      // work at the server. No continuation can enqueue COMMIT after this flag.
      release(true);
      rejectDeadline(failure);
    };
    const expired = new Promise((_resolve, reject) => { rejectDeadline = reject; });
    const query = async (sql, params = []) => {
      if (closed || signal?.aborted || performance.now() >= deadline) throw failure;
      const result = await client.query(positional(sql), params);
      if (closed || signal?.aborted || performance.now() >= deadline) throw failure;
      return result;
    };
    const work = async () => {
      acquireTimer = setTimeout(cancel, LIMITS.acquisition);
      const acquired = await pool.connect();
      clearTimeout(acquireTimer);
      client = acquired;
      if (closed) { release(true); throw failure; }
      client.on?.('error', cancel);
      const tx = {
        dialect: 'postgres',
        get: async (sql, params) => (await query(sql, params)).rows[0] || null,
        all: async (sql, params) => (await query(sql, params)).rows,
        run: async (sql, params) => ({ changes: (await query(sql, params)).rowCount }),
      };
      try {
        await query('BEGIN'); began = true;
        await query("SET LOCAL lock_timeout='150ms'; SET LOCAL statement_timeout='750ms'; SET LOCAL idle_in_transaction_session_timeout='1000ms'");
        const result = await fn(tx);
        committing = true;
        await query('COMMIT'); began = false;
        return result;
      } catch (error) {
        // COMMIT errors are uncertain, never acknowledged or retried here.
        if (began && !closed && !committing) {
          try { await query('ROLLBACK'); began = false; }
          catch (_rollbackError) { release(true); }
        }
        throw failure;
      } finally { release(closed || began || committing && closed); }
    };
    timer = setTimeout(cancel, LIMITS.whole);
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (signal?.aborted) throw failure;
      return await Promise.race([work(), expired]);
    } finally {
      closed = true;
      clearTimeout(timer); clearTimeout(acquireTimer);
      signal?.removeEventListener('abort', cancel);
    }
  };
}

let intakePool, transaction, closing;
function getIntakeTransaction() {
  if (closing) throw unavailable();
  if (!transaction) {
    intakePool = new Pool({ connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 4, connectionTimeoutMillis: LIMITS.acquisition, idleTimeoutMillis: 10000 });
    intakePool.on('error', () => console.error('[strava/intake] idle database connection unavailable'));
    transaction = createIntakeTransaction(intakePool);
  }
  return transaction;
}
function closeIntakePool() {
  if (closing) return closing;
  closing = (async () => {
    if (!intakePool) return;
    let timer;
    try { await Promise.race([intakePool.end(), new Promise((_, reject) => { timer = setTimeout(() => reject(unavailable()), 5000); })]); }
    finally { clearTimeout(timer); }
  })();
  return closing;
}
module.exports = { createIntakeTransaction, getIntakeTransaction, closeIntakePool, LIMITS };
