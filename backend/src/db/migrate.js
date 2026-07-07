const pg = require('./postgres');
const fs = require('fs');
const path = require('path');

async function runAlwaysMigrations() {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS checkin_overrides (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      action TEXT NOT NULL,
      patch_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, date)
    )
  `);

  await pg.query(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      event_name TEXT NOT NULL,
      props JSONB,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pg.query('CREATE INDEX IF NOT EXISTS idx_events_user_created_at ON events(user_id, created_at)');

  await pg.query(`
    CREATE TABLE IF NOT EXISTS user_consents (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      consent_type TEXT NOT NULL DEFAULT 'medical_waiver',
      version TEXT NOT NULL,
      accepted_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      ip TEXT,
      UNIQUE(user_id, consent_type, version)
    )
  `);

  await pg.query('CREATE INDEX IF NOT EXISTS idx_user_consents_user_type ON user_consents(user_id, consent_type)');
}

/**
 * Run all migrations idempotently
 * Creates migrations table if it doesn't exist, then runs schema SQL
 */
async function runMigrations() {
  try {
    // Ensure migrations tracking table exists
    await pg.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id SERIAL PRIMARY KEY,
        version TEXT UNIQUE NOT NULL,
        executed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Read the schema SQL file
    const schemaPath = path.join(__dirname, 'schema.pg.sql');
    const schemaSql = fs.readFileSync(schemaPath, 'utf-8');

    // Check if schema has already been run
    const migrationVersion = 'schema-001-initial';
    const existing = await pg.getOne(
      'SELECT version FROM schema_migrations WHERE version = $1',
      [migrationVersion]
    );

    if (existing) {
      await runAlwaysMigrations();
      console.log('✅ Migrations already applied. Schema is up-to-date.');
      return;
    }

    // Execute the schema SQL
    // Split by semicolons and execute each statement
    const statements = schemaSql
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0);

    for (const statement of statements) {
      await pg.query(statement);
    }

    await runAlwaysMigrations();

    // Record the migration as completed
    await pg.query(
      'INSERT INTO schema_migrations (version) VALUES ($1)',
      [migrationVersion]
    );

    console.log('✅ PostgreSQL migrations completed successfully.');
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    throw error;
  }
}

// Run migrations if this is the main module
if (require.main === module) {
  runMigrations()
    .then(() => {
      console.log('Migration runner finished.');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Fatal migration error:', error);
      process.exit(1);
    });
}

module.exports = { runMigrations };
