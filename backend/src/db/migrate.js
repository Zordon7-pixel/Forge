const pg = require('./postgres');
const fs = require('fs');
const path = require('path');
const { seedRaceCatalog } = require('./race-catalog-seed');

async function runAlwaysMigrations() {
  await pg.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS friend_handle TEXT');
  await pg.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS friend_discoverable INTEGER DEFAULT 0');
  await pg.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_friend_handle_lower ON users (LOWER(friend_handle)) WHERE friend_handle IS NOT NULL');

  await pg.query('ALTER TABLE challenges ADD COLUMN IF NOT EXISTS start_date TEXT');
  await pg.query('ALTER TABLE challenges ADD COLUMN IF NOT EXISTS end_date TEXT');
  await pg.query('ALTER TABLE challenges ADD COLUMN IF NOT EXISTS is_seasonal INTEGER DEFAULT 0');
  await pg.query('ALTER TABLE challenges ADD COLUMN IF NOT EXISTS creator_id TEXT REFERENCES users(id) ON DELETE SET NULL');
  await pg.query("ALTER TABLE challenges ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'system'");
  await pg.query("ALTER TABLE challenges ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'system'");
  await pg.query('ALTER TABLE challenges ADD COLUMN IF NOT EXISTS template_type TEXT');
  await pg.query('ALTER TABLE challenges ADD COLUMN IF NOT EXISTS run_target REAL');
  await pg.query('ALTER TABLE challenges ADD COLUMN IF NOT EXISTS run_unit TEXT');
  await pg.query('ALTER TABLE challenges ADD COLUMN IF NOT EXISTS lift_target REAL');
  await pg.query('ALTER TABLE challenges ADD COLUMN IF NOT EXISTS lift_unit TEXT');
  await pg.query("ALTER TABLE challenges ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC'");
  await pg.query("ALTER TABLE challenges ADD COLUMN IF NOT EXISTS verification_policy TEXT NOT NULL DEFAULT 'all_activity'");
  await pg.query('ALTER TABLE challenges ADD COLUMN IF NOT EXISTS participant_limit INTEGER NOT NULL DEFAULT 25');
  await pg.query("ALTER TABLE challenges ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'");
  await pg.query("UPDATE challenges SET kind = 'personal', visibility = 'personal' WHERE id LIKE 'goal-%' AND kind = 'system'");
  await pg.query("UPDATE challenges SET visibility = 'system' WHERE kind = 'system' AND visibility <> 'system'");
  await pg.query('CREATE INDEX IF NOT EXISTS idx_challenges_social_status ON challenges(kind, visibility, status, start_date, end_date)');

  await pg.query("ALTER TABLE user_challenges ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member'");
  await pg.query("ALTER TABLE user_challenges ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'joined'");
  await pg.query('ALTER TABLE user_challenges ADD COLUMN IF NOT EXISTS notifications_muted INTEGER NOT NULL DEFAULT 0');
  await pg.query('ALTER TABLE user_challenges ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ DEFAULT NOW()');
  await pg.query('ALTER TABLE user_challenges ADD COLUMN IF NOT EXISTS left_at TIMESTAMPTZ');
  await pg.query('ALTER TABLE user_challenges ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_user_challenges_challenge_status ON user_challenges(challenge_id, status)');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_user_challenges_user_status ON user_challenges(user_id, status)');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_runs_user_date ON runs(user_id, date DESC)');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_lifts_user_date ON lifts(user_id, date DESC)');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_workout_sessions_user_started ON workout_sessions(user_id, started_at)');

  await pg.query(`
    CREATE TABLE IF NOT EXISTS readiness_scores (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      score_date TEXT NOT NULL,
      score INTEGER NOT NULL,
      band TEXT NOT NULL,
      drivers JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, score_date)
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS idx_readiness_scores_user_date ON readiness_scores(user_id, score_date DESC)');

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
    CREATE TABLE IF NOT EXISTS plan_adjustment_proposals (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_plan_id TEXT,
      plan_id TEXT,
      plan_version TEXT,
      window_start TEXT,
      window_end TEXT,
      planning_date TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      safety_exception INTEGER DEFAULT 0,
      original_json TEXT,
      proposed_json TEXT,
      changes_json TEXT,
      evidence_json TEXT,
      reason TEXT,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      decided_at TIMESTAMPTZ
    )
  `);

  await pg.query('CREATE INDEX IF NOT EXISTS idx_plan_adjustment_proposals_user_status ON plan_adjustment_proposals(user_id, status)');
  await pg.query("CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_adjustment_proposals_pending ON plan_adjustment_proposals(user_id, planning_date, plan_version) WHERE status='pending'");

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

  await pg.query('ALTER TABLE activity_media ADD COLUMN IF NOT EXISTS visibility TEXT');
  await pg.query(`
    UPDATE activity_media
    SET visibility = CASE
      WHEN activity_type IN ('feed', 'post', 'community_post') THEN 'public'
      ELSE 'private'
    END
    WHERE visibility IS NULL
  `);
  await pg.query("ALTER TABLE activity_media ALTER COLUMN visibility SET DEFAULT 'private'");
  await pg.query('ALTER TABLE activity_media ALTER COLUMN visibility SET NOT NULL');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_activity_media_owner_activity ON activity_media(user_id, activity_type, activity_id)');

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

  await pg.query(`
    CREATE TABLE IF NOT EXISTS user_hr_profile (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      max_hr INTEGER,
      resting_hr INTEGER,
      lthr INTEGER,
      custom_zones_json TEXT DEFAULT '[]',
      zone_model TEXT NOT NULL DEFAULT 'hrr',
      source TEXT NOT NULL DEFAULT 'manual',
      updated_at TIMESTAMPTZ DEFAULT now()
    )
  `);

  await pg.query("ALTER TABLE user_hr_profile ADD COLUMN IF NOT EXISTS custom_zones_json TEXT DEFAULT '[]'");
  await pg.query("ALTER TABLE runs ADD COLUMN IF NOT EXISTS workout_metrics_json TEXT DEFAULT '{}'");

  await pg.query(`
    CREATE TABLE IF NOT EXISTS comp_codes (
      code TEXT PRIMARY KEY,
      max_redemptions INTEGER DEFAULT 1,
      redeemed_count INTEGER DEFAULT 0,
      grants_until TEXT,
      active INTEGER DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pg.query(`
    CREATE TABLE IF NOT EXISTS comp_redemptions (
      id TEXT PRIMARY KEY,
      code TEXT NOT NULL REFERENCES comp_codes(code) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      redeemed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(code, user_id)
    )
  `);

  await pg.query('CREATE INDEX IF NOT EXISTS idx_comp_redemptions_user ON comp_redemptions(user_id)');

  await pg.query(`
    CREATE TABLE IF NOT EXISTS race_catalog (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      race_date TEXT NOT NULL,
      city TEXT,
      state TEXT,
      country TEXT DEFAULT 'USA',
      distance_miles REAL NOT NULL,
      event_type TEXT,
      scope TEXT DEFAULT 'regional',
      source TEXT,
      url TEXT,
      lat REAL,
      lng REAL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pg.query('CREATE INDEX IF NOT EXISTS idx_race_catalog_race_date ON race_catalog(race_date)');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_race_catalog_lower_name ON race_catalog(lower(name))');

  await pg.query(`
    ALTER TABLE race_catalog
      ADD COLUMN IF NOT EXISTS elevation_gain_ft INTEGER,
      ADD COLUMN IF NOT EXISTS max_altitude_ft INTEGER,
      ADD COLUMN IF NOT EXISTS terrain TEXT,
      ADD COLUMN IF NOT EXISTS course_profile_json TEXT
  `);

  await pg.query(`
    ALTER TABLE race_events
      ADD COLUMN IF NOT EXISTS elevation_gain_ft INTEGER,
      ADD COLUMN IF NOT EXISTS max_altitude_ft INTEGER,
      ADD COLUMN IF NOT EXISTS terrain TEXT,
      ADD COLUMN IF NOT EXISTS course_profile_json TEXT,
      ADD COLUMN IF NOT EXISTS source TEXT,
      ADD COLUMN IF NOT EXISTS url TEXT
  `);

  await seedRaceCatalog();
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

module.exports = { runMigrations, runAlwaysMigrations };
