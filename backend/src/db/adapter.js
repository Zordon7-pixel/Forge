/**
 * Database Adapter
 * Switches between SQLite (sync) and PostgreSQL (async) based on DATABASE_URL env var
 *
 * If DATABASE_URL is set → Use PostgreSQL
 * Otherwise → Use SQLite with sync-wrapped interface
 */

const sqliteDb = require('./index'); // SQLite connection
const pgClient = require('./postgres'); // PostgreSQL connection

const usePostgres = !!process.env.DATABASE_URL;

/**
 * Prepare and execute a query (compatible with both SQLite and PostgreSQL)
 * Returns a promise-based interface
 */
class PreparedStatement {
  constructor(sql, params = []) {
    this.sql = sql;
    this.params = params;
  }

  /**
   * Get a single row (like better-sqlite3's .get())
   */
  async get(params = this.params) {
    if (usePostgres) {
      return pgClient.getOne(this.sql, params);
    } else {
      // Synchronous SQLite wrapped in Promise
      return Promise.resolve(
        sqliteDb.prepare(this.sql).get(...params)
      );
    }
  }

  /**
   * Get all rows (like better-sqlite3's .all())
   */
  async all(params = this.params) {
    if (usePostgres) {
      return pgClient.getAll(this.sql, params);
    } else {
      // Synchronous SQLite wrapped in Promise
      return Promise.resolve(
        sqliteDb.prepare(this.sql).all(...params)
      );
    }
  }

  /**
   * Run a statement (INSERT/UPDATE/DELETE)
   */
  async run(params = this.params) {
    if (usePostgres) {
      return pgClient.run(this.sql, params);
    } else {
      // Synchronous SQLite wrapped in Promise
      return Promise.resolve(
        sqliteDb.prepare(this.sql).run(...params)
      );
    }
  }
}

/**
 * Main adapter object
 */
const db = {
  /**
   * Prepare a statement (returns PreparedStatement for async interface)
   */
  prepare(sql) {
    if (usePostgres) {
      return {
        get: (params) => pgClient.getOne(sql, params),
        all: (params) => pgClient.getAll(sql, params),
        run: (params) => pgClient.run(sql, params),
      };
    } else {
      // SQLite: return the synchronous prepared statement from better-sqlite3
      return sqliteDb.prepare(sql);
    }
  },

  /**
   * Execute raw SQL (for schema/migrations)
   */
  async exec(sql) {
    if (usePostgres) {
      const statements = sql.split(';')
        .map(stmt => stmt.trim())
        .filter(stmt => stmt.length > 0);
      
      for (const stmt of statements) {
        await pgClient.query(stmt);
      }
    } else {
      sqliteDb.exec(sql);
    }
  },

  /**
   * Close database connection
   */
  async close() {
    if (usePostgres) {
      await pgClient.close();
    } else {
      sqliteDb.close();
    }
  },

  /**
   * Get connection status
   */
  isPostgres: usePostgres,
  isSQLite: !usePostgres,
};

module.exports = db;
