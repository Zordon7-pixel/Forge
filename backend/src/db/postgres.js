const { Pool } = require('pg');

// PostgreSQL connection pool
let pool;

function initPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      // Optional: connection timeout
      connectionTimeoutMillis: 5000,
    });

    // Log connection errors
    pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
    });
  }
  return pool;
}

/**
 * Execute a query against PostgreSQL
 * @param {string} text - SQL query string
 * @param {array} params - Query parameters (for parameterized queries)
 * @returns {Promise<{rows: array}>} Result with rows array
 */
async function query(text, params) {
  const client = await initPool().connect();
  try {
    const result = await client.query(text, params);
    return result;
  } finally {
    client.release();
  }
}

/**
 * Get a single row (like better-sqlite3's .get())
 */
async function getOne(text, params) {
  const result = await query(text, params);
  return result.rows[0] || null;
}

/**
 * Get all rows (like better-sqlite3's .all())
 */
async function getAll(text, params) {
  const result = await query(text, params);
  return result.rows || [];
}

/**
 * Run an INSERT/UPDATE/DELETE (like better-sqlite3's .run())
 */
async function run(text, params) {
  const result = await query(text, params);
  return {
    changes: result.rowCount,
    lastID: result.lastInsertRowid, // Note: PostgreSQL doesn't have lastInsertRowid; use RETURNING clause if needed
  };
}

/**
 * Close the pool gracefully
 */
async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = {
  query,
  getOne,
  getAll,
  run,
  close,
  initPool,
};
