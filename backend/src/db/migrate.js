const pg = require('./postgres');
const fs = require('fs');
const path = require('path');
const { seedRaceCatalog } = require('./race-catalog-seed');
const { seedShoeCatalog } = require('./shoe-catalog-seed');

async function runAlwaysMigrations() {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS activity_import_claims (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      source_key TEXT NOT NULL,
      claim_token TEXT NOT NULL,
      activity_kind TEXT,
      activity_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(user_id, source_key)
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS idx_activity_import_claims_activity ON activity_import_claims(user_id, activity_kind, activity_id)');
  await pg.query("ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new'");
  await pg.query('ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS assigned_to TEXT');
  await pg.query('ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS support_note TEXT');
  await pg.query('ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS linked_ref TEXT');
  await pg.query('ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ');
  await pg.query('ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_app_feedback_status_created ON app_feedback(status, created_at DESC)');
  await pg.query(`
    CREATE TABLE IF NOT EXISTS exercise_image_requests (
      id TEXT PRIMARY KEY,
      canonical_key TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      example_text TEXT,
      source TEXT,
      known_exercise INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'new',
      occurrence_count INTEGER NOT NULL DEFAULT 1,
      assigned_to TEXT,
      support_note TEXT,
      linked_ref TEXT,
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS idx_exercise_image_requests_status_seen ON exercise_image_requests(status, last_seen_at DESC)');

  await pg.query(`
    CREATE TABLE IF NOT EXISTS user_notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      href TEXT,
      source_key TEXT NOT NULL,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, source_key)
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS idx_user_notifications_user_unread ON user_notifications(user_id, read_at, created_at DESC)');

  await pg.query(`
    CREATE TABLE IF NOT EXISTS shoe_catalog (
      id TEXT PRIMARY KEY,
      brand TEXT NOT NULL,
      model TEXT NOT NULL,
      model_version TEXT,
      release_year INTEGER,
      aliases TEXT NOT NULL DEFAULT '[]',
      category TEXT NOT NULL,
      surface TEXT NOT NULL,
      intent_tags TEXT NOT NULL DEFAULT '[]',
      drop_mm REAL,
      heel_stack_mm REAL,
      forefoot_stack_mm REAL,
      cushioning TEXT,
      stability TEXT,
      plate_type TEXT,
      rocker TEXT,
      terrain TEXT,
      lug_depth_mm REAL,
      weight_g REAL,
      spec_basis TEXT,
      recommended_miles_min INTEGER NOT NULL,
      recommended_miles_max INTEGER NOT NULL,
      wet_ok INTEGER,
      regions TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      source_urls TEXT NOT NULL DEFAULT '[]',
      verified_fields TEXT NOT NULL DEFAULT '[]',
      verification_status TEXT NOT NULL DEFAULT 'pending',
      confidence TEXT NOT NULL DEFAULT 'low',
      verified_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS idx_shoe_catalog_brand_model ON shoe_catalog(LOWER(brand), LOWER(model))');
  await pg.query("ALTER TABLE gear_shoes ADD COLUMN IF NOT EXISTS surface TEXT DEFAULT 'road'");
  await pg.query("ALTER TABLE gear_shoes ADD COLUMN IF NOT EXISTS intent_tags TEXT DEFAULT '[]'");
  await pg.query('ALTER TABLE gear_shoes ADD COLUMN IF NOT EXISTS wet_ok INTEGER');
  await pg.query('ALTER TABLE gear_shoes ADD COLUMN IF NOT EXISTS cushion TEXT');
  await pg.query('ALTER TABLE gear_shoes ADD COLUMN IF NOT EXISTS catalog_id TEXT');
  await pg.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'gear_shoes_catalog_id_fkey'
          AND conrelid = 'gear_shoes'::regclass
      ) THEN
        ALTER TABLE gear_shoes
          ADD CONSTRAINT gear_shoes_catalog_id_fkey
          FOREIGN KEY (catalog_id) REFERENCES shoe_catalog(id) ON DELETE SET NULL;
      END IF;
    END $$
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS idx_gear_shoes_catalog_id ON gear_shoes(catalog_id)');

  await pg.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS friend_handle TEXT');
  await pg.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS friend_discoverable INTEGER DEFAULT 0');
  await pg.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS contact_discoverable INTEGER DEFAULT 0');
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

  await pg.query(`
    CREATE TABLE IF NOT EXISTS group_runs (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      timezone TEXT NOT NULL,
      duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 10 AND 480),
      run_type TEXT NOT NULL,
      goal_mode TEXT NOT NULL CHECK (goal_mode IN ('distance', 'time', 'open')),
      target_distance_miles REAL,
      target_duration_minutes INTEGER,
      pace_note TEXT,
      target_zone TEXT,
      workout_structure TEXT,
      meetup_area TEXT NOT NULL,
      meetup_details TEXT,
      notes TEXT,
      route_json JSONB,
      participant_limit INTEGER NOT NULL DEFAULT 25 CHECK (participant_limit BETWEEN 2 AND 25),
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'completed', 'cancelled')),
      completed_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (
        (goal_mode = 'distance' AND target_distance_miles IS NOT NULL
          AND target_distance_miles BETWEEN 0.1 AND 200 AND target_duration_minutes IS NULL)
        OR (goal_mode = 'time' AND target_distance_miles IS NULL
          AND target_duration_minutes IS NOT NULL AND target_duration_minutes BETWEEN 10 AND 480)
        OR (goal_mode = 'open' AND target_distance_miles IS NULL AND target_duration_minutes IS NULL)
      ),
      CHECK (
        route_json IS NULL OR CASE
          WHEN jsonb_typeof(route_json) = 'object'
            AND jsonb_typeof(route_json->'coordinates') = 'array'
          THEN jsonb_array_length(route_json->'coordinates') BETWEEN 2 AND 800
          ELSE FALSE
        END
      )
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS idx_group_runs_owner_status_start ON group_runs(owner_id, status, starts_at)');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_group_runs_status_start ON group_runs(status, starts_at)');

  await pg.query(`
    CREATE TABLE IF NOT EXISTS group_run_members (
      id TEXT PRIMARY KEY,
      group_run_id TEXT NOT NULL REFERENCES group_runs(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('invited', 'going', 'declined', 'left', 'removed')),
      muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
      invited_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      joined_at TIMESTAMPTZ,
      left_at TIMESTAMPTZ,
      removed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, group_run_id)
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS idx_group_run_members_run_status ON group_run_members(group_run_id, status)');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_group_run_members_user_status ON group_run_members(user_id, status)');

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
      trigger_run_id TEXT,
      episode_key TEXT,
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

  await pg.query('ALTER TABLE plan_adjustment_proposals ADD COLUMN IF NOT EXISTS trigger_run_id TEXT');
  await pg.query('ALTER TABLE plan_adjustment_proposals ADD COLUMN IF NOT EXISTS episode_key TEXT');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_plan_adjustment_proposals_user_status ON plan_adjustment_proposals(user_id, status)');
  await pg.query(`
    DO $$
    DECLARE
      index_exists BOOLEAN := FALSE;
      existing_predicate TEXT;
    BEGIN
      SELECT EXISTS (
        SELECT 1
        FROM pg_class index_class
        JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace
        WHERE index_class.relname = 'idx_plan_adjustment_proposals_pending'
          AND index_namespace.nspname = current_schema()
      ) INTO index_exists;

      IF index_exists THEN
        SELECT pg_get_expr(index_record.indpred, index_record.indrelid)
        INTO existing_predicate
        FROM pg_index index_record
        JOIN pg_class index_class ON index_class.oid = index_record.indexrelid
        JOIN pg_namespace index_namespace ON index_namespace.oid = index_class.relnamespace
        WHERE index_class.relname = 'idx_plan_adjustment_proposals_pending'
          AND index_namespace.nspname = current_schema();
      END IF;

      IF NOT index_exists THEN
        EXECUTE 'CREATE UNIQUE INDEX idx_plan_adjustment_proposals_pending ON plan_adjustment_proposals(user_id, planning_date, plan_version) WHERE status=''pending'' AND trigger_run_id IS NULL';
      ELSIF existing_predicate IS NULL OR POSITION('trigger_run_id IS NULL' IN existing_predicate) = 0 THEN
        EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_adjustment_proposals_pending_replacement ON plan_adjustment_proposals(user_id, planning_date, plan_version) WHERE status=''pending'' AND trigger_run_id IS NULL';
        EXECUTE 'DROP INDEX idx_plan_adjustment_proposals_pending';
        EXECUTE 'ALTER INDEX idx_plan_adjustment_proposals_pending_replacement RENAME TO idx_plan_adjustment_proposals_pending';
      END IF;
    END $$
  `);
  await pg.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_adjustment_proposals_run ON plan_adjustment_proposals(user_id, trigger_run_id) WHERE trigger_run_id IS NOT NULL');
  await pg.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_adjustment_proposals_episode ON plan_adjustment_proposals(user_id, episode_key) WHERE episode_key IS NOT NULL AND trigger_run_id IS NULL');

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
    CREATE TABLE IF NOT EXISTS community_posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      workout_id TEXT,
      run_id TEXT,
      title TEXT NOT NULL,
      body TEXT,
      workout_type TEXT,
      stats_json TEXT DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pg.query('CREATE INDEX IF NOT EXISTS idx_community_posts_user_created ON community_posts(user_id, created_at DESC)');
  await pg.query('CREATE INDEX IF NOT EXISTS idx_community_posts_user_run ON community_posts(user_id, run_id)');

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
  await seedShoeCatalog();
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
