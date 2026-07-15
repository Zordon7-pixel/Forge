const { Pool, types } = require('pg');

// Parse int8 (bigint) as JavaScript integer — COUNT(*) returns int8 in PG
types.setTypeParser(20, parseInt);
// Parse numeric as float — SUM() returns numeric in PG
types.setTypeParser(1700, parseFloat);
// Return timestamps as strings, not Date objects — keeps existing .slice(0,10) code working
types.setTypeParser(1114, val => val);
types.setTypeParser(1184, val => val);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Convert SQLite-style ? placeholders to PostgreSQL $1, $2, $3...
function toPositional(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// dbGet — returns first row or null
async function dbGet(sql, params = []) {
  const r = await pool.query(toPositional(sql), params);
  return r.rows[0] || null;
}

// dbAll — returns all rows
async function dbAll(sql, params = []) {
  const r = await pool.query(toPositional(sql), params);
  return r.rows;
}

// dbRun — execute INSERT/UPDATE/DELETE, returns { changes: rowCount }
async function dbRun(sql, params = []) {
  const r = await pool.query(toPositional(sql), params);
  return { changes: r.rowCount };
}

async function withTransaction(fn) {
  const client = await pool.connect();
  const query = async (sql, params = []) => client.query(toPositional(sql), params);
  query.get = async (sql, params = []) => {
    const r = await query(sql, params);
    return r.rows[0] || null;
  };
  query.all = async (sql, params = []) => {
    const r = await query(sql, params);
    return r.rows;
  };
  query.run = async (sql, params = []) => {
    const r = await query(sql, params);
    return { changes: r.rowCount };
  };

  try {
    await client.query('BEGIN');
    const result = await fn(query);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        weekly_miles_current REAL DEFAULT 0,
        goal_type TEXT DEFAULT 'fitness',
        goal_race_date TEXT,
        goal_race_distance TEXT,
        injury_notes TEXT,
        comeback_mode INTEGER DEFAULT 0,
        onboarded INTEGER DEFAULT 0,
        coach_personality TEXT DEFAULT 'mentor',
        run_days_per_week INTEGER DEFAULT 3,
        lift_days_per_week INTEGER DEFAULT 2,
        is_pro INTEGER DEFAULT 0,
        sex TEXT DEFAULT 'male',
        weight_lbs REAL,
        schedule_type TEXT DEFAULT 'adaptive',
        lifestyle TEXT DEFAULT 'works_fulltime',
        preferred_workout_time TEXT DEFAULT 'evening',
        preferred_workout_days TEXT DEFAULT '[]',
        missed_workout_pref TEXT DEFAULT 'adjust_week',
        weekly_workout_days INTEGER DEFAULT 4,
        injury_mode INTEGER DEFAULT 0,
        injury_description TEXT DEFAULT '',
        injury_date TEXT DEFAULT '',
        injury_limitations TEXT DEFAULT '',
        distance_unit TEXT DEFAULT 'miles',
        theme TEXT DEFAULT 'dark',
        age INTEGER,
        max_heart_rate INTEGER,
        username TEXT,
        friend_handle TEXT,
        friend_discoverable INTEGER DEFAULT 0,
        units TEXT DEFAULT 'imperial',
        step_goal INTEGER DEFAULT 10000,
        monthly_goal_miles REAL,
        monthly_goal_mode TEXT DEFAULT 'auto',
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        subscription_status TEXT DEFAULT 'free',
        subscription_ends_at TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    const userColumnMigrations = [
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS is_pro INTEGER DEFAULT 0',
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS sex TEXT DEFAULT 'male'",
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS weight_lbs REAL',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS height_ft INTEGER DEFAULT 5',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS height_in INTEGER DEFAULT 8',
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS schedule_type TEXT DEFAULT 'adaptive'",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS lifestyle TEXT DEFAULT 'works_fulltime'",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_workout_time TEXT DEFAULT 'evening'",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_workout_days TEXT DEFAULT '[]'",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS missed_workout_pref TEXT DEFAULT 'adjust_week'",
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_workout_days INTEGER DEFAULT 4',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS injury_mode INTEGER DEFAULT 0',
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS injury_description TEXT DEFAULT ''",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS injury_date TEXT DEFAULT ''",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS injury_limitations TEXT DEFAULT ''",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS distance_unit TEXT DEFAULT 'miles'",
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT DEFAULT 'dark'",
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS age INTEGER',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS max_heart_rate INTEGER',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS friend_handle TEXT',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS friend_discoverable INTEGER DEFAULT 0',
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS units TEXT DEFAULT 'imperial'",
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS step_goal INTEGER DEFAULT 10000',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_goal_miles REAL',
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_goal_mode TEXT DEFAULT 'auto'",
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT',
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'free'",
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_ends_at TEXT',
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS fitness_level TEXT DEFAULT 'beginner'",
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS current_streak INTEGER DEFAULT 0',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS longest_streak INTEGER DEFAULT 0',
      "ALTER TABLE users ADD COLUMN IF NOT EXISTS streak_milestones TEXT DEFAULT '[]'",
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS streak_updated_at TEXT',
    ];
    for (const migration of userColumnMigrations) {
      await client.query(migration);
    }
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_friend_handle_lower ON users (LOWER(friend_handle)) WHERE friend_handle IS NOT NULL');
    await client.query("UPDATE users SET subscription_status = 'free' WHERE subscription_status IS NULL");
    await client.query("UPDATE users SET subscription_status = 'pro' WHERE subscription_status IN ('active', 'trialing')");
    await client.query("UPDATE users SET subscription_status = 'cancelled' WHERE subscription_status IN ('canceled', 'past_due', 'unpaid')");
    console.log('✅ Schema migration: users table columns ensured');

    await client.query(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id),
        date TEXT NOT NULL,
        type TEXT NOT NULL,
        distance_miles REAL DEFAULT 0,
        duration_seconds INTEGER DEFAULT 0,
        perceived_effort INTEGER DEFAULT 5,
        notes TEXT,
        ai_feedback TEXT,
        ai_feedback_requested_at TIMESTAMPTZ,
        calories INTEGER DEFAULT 0,
        calories_burned INTEGER,
        run_surface TEXT DEFAULT 'outdoor',
        surface TEXT DEFAULT 'road',
        incline_pct REAL DEFAULT 0,
        treadmill_speed REAL DEFAULT 0,
        route_coords TEXT DEFAULT '[]',
        watch_mode TEXT,
        avg_heart_rate INTEGER,
        max_heart_rate INTEGER,
        min_heart_rate INTEGER,
        heart_rate_zones TEXT DEFAULT '[]',
        cadence_spm REAL,
        cadence_avg REAL,
        elevation_gain REAL,
        elevation_loss REAL,
        pace_avg REAL,
        pace_splits TEXT DEFAULT '[]',
        vo2_max REAL,
        vo2max REAL,
        training_effect_aerobic REAL,
        training_effect_anaerobic REAL,
        recovery_time_hours REAL,
        detected_surface_type TEXT,
        temperature_f REAL,
        temperature_c REAL,
        treadmill_brand TEXT,
        treadmill_model TEXT,
        watch_sync_id TEXT,
        watch_activity_type TEXT,
        watch_normalized_type TEXT,
        health_source TEXT,
        health_source_workout_id TEXT,
        health_start_at TEXT,
        health_end_at TEXT,
        workout_metrics_json TEXT DEFAULT '{}',
        plan_session_id TEXT,
        planned_session_json TEXT DEFAULT '{}',
        gps_available INTEGER DEFAULT 1,
        shoe_id TEXT,
        pain_level TEXT,
        post_energy TEXT,
        calories_watch INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query("ALTER TABLE runs ADD COLUMN IF NOT EXISTS health_source TEXT");
    await client.query('ALTER TABLE runs ADD COLUMN IF NOT EXISTS ai_feedback_requested_at TIMESTAMPTZ');
    await client.query("ALTER TABLE runs ADD COLUMN IF NOT EXISTS health_source_workout_id TEXT");
    await client.query("ALTER TABLE runs ADD COLUMN IF NOT EXISTS health_start_at TEXT");
    await client.query("ALTER TABLE runs ADD COLUMN IF NOT EXISTS health_end_at TEXT");
    await client.query("ALTER TABLE runs ADD COLUMN IF NOT EXISTS workout_metrics_json TEXT DEFAULT '{}'");
    await client.query('ALTER TABLE runs ADD COLUMN IF NOT EXISTS plan_session_id TEXT');
    await client.query("ALTER TABLE runs ADD COLUMN IF NOT EXISTS planned_session_json TEXT DEFAULT '{}'");
    await client.query("ALTER TABLE runs ADD COLUMN IF NOT EXISTS pain_level TEXT");
    await client.query("ALTER TABLE runs ADD COLUMN IF NOT EXISTS post_energy TEXT");
    await client.query('CREATE INDEX IF NOT EXISTS idx_runs_health_source_workout ON runs(user_id, health_source, health_source_workout_id)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS run_import_tombstones (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_key TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, source_key)
      );
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_run_import_tombstones_user ON run_import_tombstones(user_id)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS gear_shoes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        brand TEXT NOT NULL,
        model TEXT NOT NULL,
        nickname TEXT,
        color TEXT,
        purchase_date TEXT,
        category TEXT DEFAULT 'daily_trainer',
        recommended_miles INTEGER DEFAULT 450,
        is_retired INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query("ALTER TABLE gear_shoes ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'daily_trainer'");

    await client.query(`
      CREATE TABLE IF NOT EXISTS lifts (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id),
        date TEXT NOT NULL,
        muscle_groups TEXT DEFAULT '[]',
        intensity TEXT DEFAULT 'moderate',
        notes TEXT,
        exercise_name TEXT,
        sets INTEGER,
        reps INTEGER,
        weight_lbs REAL,
        watch_sync_id TEXT,
        watch_activity_type TEXT,
        watch_normalized_type TEXT,
        avg_heart_rate INTEGER,
        max_heart_rate INTEGER,
        min_heart_rate INTEGER,
        set_heart_rate TEXT DEFAULT '[]',
        rest_heart_rate TEXT DEFAULT '[]',
        workout_duration_seconds INTEGER,
        calories INTEGER,
        recovery_heart_rate INTEGER,
        category TEXT DEFAULT 'strength',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS training_plans (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id),
        week_start TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query('ALTER TABLE training_plans ADD COLUMN IF NOT EXISTS name TEXT');
    await client.query('ALTER TABLE training_plans ADD COLUMN IF NOT EXISTS type TEXT');
    await client.query('ALTER TABLE training_plans ADD COLUMN IF NOT EXISTS weeks INTEGER');
    await client.query('ALTER TABLE training_plans ADD COLUMN IF NOT EXISTS description TEXT');
    await client.query('ALTER TABLE training_plans ADD COLUMN IF NOT EXISTS plan_data JSONB');

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_plans (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan_id TEXT NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
        started_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD'),
        current_week INTEGER DEFAULT 1,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        progress_json TEXT DEFAULT '{}'
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_usage (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id),
        call_type TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS workout_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        notes TEXT,
        muscle_groups TEXT DEFAULT '[]',
        total_seconds INTEGER DEFAULT 0,
        ai_feedback TEXT,
        calories_burned INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS workout_sets (
        id TEXT PRIMARY KEY,
        session_id TEXT REFERENCES workout_sessions(id),
        user_id TEXT REFERENCES users(id),
        exercise_name TEXT NOT NULL,
        muscle_group TEXT,
        set_number INTEGER DEFAULT 1,
        reps INTEGER,
        weight_lbs REAL,
        logged_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS personal_records (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        category TEXT NOT NULL,
        label TEXT NOT NULL,
        value REAL NOT NULL,
        unit TEXT NOT NULL,
        run_id TEXT,
        lift_id TEXT,
        achieved_at TEXT DEFAULT (to_char(NOW(), 'YYYY-MM-DD')),
        notes TEXT,
        source TEXT DEFAULT 'auto',
        discrepancy INTEGER DEFAULT 0,
        auto_value REAL
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS badges (
        id SERIAL PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        icon TEXT,
        category TEXT,
        requirement_type TEXT,
        requirement_value REAL,
        window_start TEXT,
        window_end TEXT,
        color TEXT DEFAULT '#EAB308',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_badges (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        badge_id INTEGER NOT NULL,
        earned_at TIMESTAMPTZ DEFAULT NOW(),
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (badge_id) REFERENCES badges(id),
        UNIQUE(user_id, badge_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS challenges (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        type TEXT DEFAULT 'virtual_course',
        target_value REAL NOT NULL,
        unit TEXT DEFAULT 'miles',
        badge_color TEXT DEFAULT '#EAB308',
        is_featured INTEGER DEFAULT 0,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Seasonal challenge columns
    await client.query('ALTER TABLE challenges ADD COLUMN IF NOT EXISTS start_date TEXT');
    await client.query('ALTER TABLE challenges ADD COLUMN IF NOT EXISTS end_date TEXT');
    await client.query('ALTER TABLE challenges ADD COLUMN IF NOT EXISTS is_seasonal INTEGER DEFAULT 0');
    await client.query('ALTER TABLE challenges ADD COLUMN IF NOT EXISTS creator_id TEXT REFERENCES users(id) ON DELETE SET NULL');
    await client.query("ALTER TABLE challenges ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'system'");
    await client.query("ALTER TABLE challenges ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'system'");
    await client.query('ALTER TABLE challenges ADD COLUMN IF NOT EXISTS template_type TEXT');
    await client.query('ALTER TABLE challenges ADD COLUMN IF NOT EXISTS run_target REAL');
    await client.query('ALTER TABLE challenges ADD COLUMN IF NOT EXISTS run_unit TEXT');
    await client.query('ALTER TABLE challenges ADD COLUMN IF NOT EXISTS lift_target REAL');
    await client.query('ALTER TABLE challenges ADD COLUMN IF NOT EXISTS lift_unit TEXT');
    await client.query("ALTER TABLE challenges ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC'");
    await client.query("ALTER TABLE challenges ADD COLUMN IF NOT EXISTS verification_policy TEXT NOT NULL DEFAULT 'all_activity'");
    await client.query('ALTER TABLE challenges ADD COLUMN IF NOT EXISTS participant_limit INTEGER NOT NULL DEFAULT 25');
    await client.query("ALTER TABLE challenges ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'");
    await client.query("UPDATE challenges SET kind = 'personal', visibility = 'personal' WHERE id LIKE 'goal-%' AND kind = 'system'");
    await client.query("UPDATE challenges SET visibility = 'system' WHERE kind = 'system' AND visibility <> 'system'");
    await client.query('CREATE INDEX IF NOT EXISTS idx_challenges_social_status ON challenges(kind, visibility, status, start_date, end_date)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_challenges (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        challenge_id TEXT NOT NULL,
        progress REAL DEFAULT 0,
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TEXT,
        UNIQUE(user_id, challenge_id)
      );
    `);
    await client.query("ALTER TABLE user_challenges ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member'");
    await client.query("ALTER TABLE user_challenges ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'joined'");
    await client.query('ALTER TABLE user_challenges ADD COLUMN IF NOT EXISTS notifications_muted INTEGER NOT NULL DEFAULT 0');
    await client.query('ALTER TABLE user_challenges ADD COLUMN IF NOT EXISTS invited_at TIMESTAMPTZ DEFAULT NOW()');
    await client.query('ALTER TABLE user_challenges ADD COLUMN IF NOT EXISTS left_at TIMESTAMPTZ');
    await client.query('ALTER TABLE user_challenges ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()');
    await client.query('CREATE INDEX IF NOT EXISTS idx_user_challenges_challenge_status ON user_challenges(challenge_id, status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_user_challenges_user_status ON user_challenges(user_id, status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_runs_user_date ON runs(user_id, date DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_lifts_user_date ON lifts(user_id, date DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_workout_sessions_user_started ON workout_sessions(user_id, started_at)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS step_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        log_date TEXT NOT NULL,
        steps INTEGER DEFAULT 0,
        source TEXT DEFAULT 'manual',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, log_date)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_likes (
        id TEXT PRIMARY KEY,
        activity_id TEXT NOT NULL,
        activity_type TEXT NOT NULL,
        user_id TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(activity_id, activity_type, user_id)
      );
    `);
    await client.query("ALTER TABLE activity_likes ADD COLUMN IF NOT EXISTS activity_type TEXT DEFAULT 'feed'");

    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_comments (
        id TEXT PRIMARY KEY,
        activity_id TEXT NOT NULL,
        activity_type TEXT NOT NULL,
        user_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query("ALTER TABLE activity_comments ADD COLUMN IF NOT EXISTS activity_type TEXT DEFAULT 'feed'");
    await client.query("ALTER TABLE activity_comments ADD COLUMN IF NOT EXISTS text TEXT");
    await client.query("UPDATE activity_comments SET text = content WHERE text IS NULL");

    await client.query(`
      CREATE TABLE IF NOT EXISTS follows (
        id TEXT PRIMARY KEY,
        follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        following_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(follower_id, following_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS friendships (
        id TEXT PRIMARY KEY,
        requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_low_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        user_high_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'removed')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        responded_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        CHECK (requester_id <> addressee_id),
        CHECK (user_low_id = LEAST(requester_id, addressee_id)),
        CHECK (user_high_id = GREATEST(requester_id, addressee_id)),
        UNIQUE(user_low_id, user_high_id)
      );
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_friendships_requester_status ON friendships(requester_id, status)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_friendships_addressee_status ON friendships(addressee_id, status)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS friend_invites (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        consumed_by_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_friend_invites_owner_active ON friend_invites(owner_id, expires_at) WHERE consumed_at IS NULL');

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_blocks (
        id TEXT PRIMARY KEY,
        blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        CHECK (blocker_id <> blocked_id),
        UNIQUE(blocker_id, blocked_id)
      );
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS social_reports (
        id TEXT PRIMARY KEY,
        reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        subject_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
        category TEXT NOT NULL CHECK (category IN ('harassment', 'spam', 'impersonation', 'unsafe_content', 'other')),
        context_type TEXT NOT NULL CHECK (context_type IN ('profile', 'friendship', 'challenge', 'activity')),
        context_id TEXT,
        note TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'closed')),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        reviewed_at TIMESTAMPTZ,
        reviewed_by_id TEXT REFERENCES users(id) ON DELETE SET NULL
      );
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_social_reports_status_created ON social_reports(status, created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_social_reports_reporter ON social_reports(reporter_id, created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_social_reports_subject ON social_reports(subject_user_id, created_at DESC)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_feed (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        shop_id TEXT,
        type TEXT NOT NULL,
        data JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        event_name TEXT NOT NULL,
        props JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_events_user_created_at ON events(user_id, created_at)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS activity_media (
        id TEXT PRIMARY KEY,
        activity_id TEXT NOT NULL,
        activity_type TEXT NOT NULL,
        user_id TEXT NOT NULL,
        data TEXT NOT NULL,
        mime_type TEXT DEFAULT 'image/jpeg',
        visibility TEXT NOT NULL DEFAULT 'private',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_activity_media_owner_activity ON activity_media(user_id, activity_type, activity_id)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS shared_routes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        run_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        route_coords TEXT DEFAULT '[]',
        distance_miles REAL DEFAULT 0,
        duration_seconds INTEGER DEFAULT 0,
        avg_pace REAL,
        surface TEXT,
        city TEXT,
        likes_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS route_likes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        route_id TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, route_id)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS exercises (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        muscle_group TEXT NOT NULL,
        secondary_muscles TEXT DEFAULT '',
        instructions TEXT DEFAULT '',
        how_to_image_url TEXT DEFAULT '',
        is_system INTEGER DEFAULT 1,
        created_by_user_id TEXT DEFAULT NULL,
        approved INTEGER DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS watch_sync (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        garmin_activity_id TEXT,
        activity_type TEXT,
        activity_name TEXT,
        normalized_type TEXT,
        routed_section TEXT,
        distance_miles REAL,
        duration_seconds INTEGER,
        avg_pace REAL,
        pace_splits_json TEXT DEFAULT '[]',
        avg_heart_rate INTEGER,
        max_heart_rate INTEGER,
        min_heart_rate INTEGER,
        heart_rate_zones_json TEXT DEFAULT '[]',
        cadence_spm REAL,
        elevation_gain REAL,
        elevation_loss REAL,
        route_coords TEXT DEFAULT '[]',
        vo2_max REAL,
        training_effect_aerobic REAL,
        training_effect_anaerobic REAL,
        recovery_time_hours REAL,
        detected_surface_type TEXT,
        temperature_f REAL,
        calories INTEGER,
        exercise_name TEXT,
        sets INTEGER,
        reps INTEGER,
        weight_lbs REAL,
        set_heart_rate_json TEXT DEFAULT '[]',
        rest_heart_rate_json TEXT DEFAULT '[]',
        workout_duration_seconds INTEGER,
        recovery_heart_rate INTEGER,
        incline_pct REAL,
        belt_speed_mph REAL,
        treadmill_brand TEXT,
        treadmill_model TEXT,
        watch_mode TEXT,
        sync_uuid TEXT,
        raw_payload TEXT,
        synced_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      );
    `);
    await client.query('ALTER TABLE watch_sync ADD COLUMN IF NOT EXISTS garmin_activity_id TEXT');
    await client.query('ALTER TABLE watch_sync ADD COLUMN IF NOT EXISTS sync_uuid TEXT');
    await client.query('CREATE INDEX IF NOT EXISTS idx_watch_sync_user_garmin_id ON watch_sync(user_id, garmin_activity_id)');
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_watch_sync_user_sync_uuid ON watch_sync(user_id, sync_uuid) WHERE sync_uuid IS NOT NULL');

    await client.query(`
      CREATE TABLE IF NOT EXISTS health_sync (
        id SERIAL PRIMARY KEY,
        user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
        steps_today INTEGER,
        calories_today INTEGER,
        avg_heart_rate_last_run INTEGER,
        total_miles_this_week NUMERIC(10,2),
        resting_heart_rate INTEGER,
        hrv_ms INTEGER,
        sleep_hours_last_night NUMERIC(4,1),
        active_minutes_this_week INTEGER,
        workout_count_this_week INTEGER,
        last_workout_type TEXT,
        last_workout_duration_seconds INTEGER,
        last_workout_calories INTEGER,
        training_metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        synced_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query('ALTER TABLE health_sync ADD COLUMN IF NOT EXISTS resting_heart_rate INTEGER');
    await client.query('ALTER TABLE health_sync ADD COLUMN IF NOT EXISTS hrv_ms INTEGER');
    await client.query('ALTER TABLE health_sync ADD COLUMN IF NOT EXISTS sleep_hours_last_night NUMERIC(4,1)');
    await client.query('ALTER TABLE health_sync ADD COLUMN IF NOT EXISTS active_minutes_this_week INTEGER');
    await client.query('ALTER TABLE health_sync ADD COLUMN IF NOT EXISTS workout_count_this_week INTEGER');
    await client.query('ALTER TABLE health_sync ADD COLUMN IF NOT EXISTS last_workout_type TEXT');
    await client.query('ALTER TABLE health_sync ADD COLUMN IF NOT EXISTS last_workout_duration_seconds INTEGER');
    await client.query('ALTER TABLE health_sync ADD COLUMN IF NOT EXISTS last_workout_calories INTEGER');
    await client.query("ALTER TABLE health_sync ADD COLUMN IF NOT EXISTS training_metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb");

    await client.query(`
      CREATE TABLE IF NOT EXISTS user_settings (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key TEXT NOT NULL,
        value TEXT,
        updated_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, key)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS garmin_sleep (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        calendar_date TEXT NOT NULL,
        sleep_start_gmt TEXT,
        sleep_end_gmt TEXT,
        deep_sleep_seconds INTEGER,
        light_sleep_seconds INTEGER,
        rem_sleep_seconds INTEGER,
        awake_seconds INTEGER,
        unmeasurable_seconds INTEGER,
        confirmation_type TEXT,
        retro INTEGER DEFAULT 0,
        synced_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      );
    `);
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_garmin_sleep_user_date ON garmin_sleep(user_id, calendar_date)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_garmin_sleep_user_synced ON garmin_sleep(user_id, synced_at DESC)');

    await client.query(`
      CREATE TABLE IF NOT EXISTS race_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        race_name TEXT NOT NULL,
        race_date TEXT NOT NULL,
        distance_miles REAL NOT NULL,
        location TEXT,
        goal_time_seconds INTEGER,
        status TEXT DEFAULT 'upcoming',
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_checkins (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        checkin_date TEXT NOT NULL,
        feeling INTEGER DEFAULT 3,
        legs INTEGER,
        drive INTEGER,
        time_available INTEGER DEFAULT 60,
        sleep_hours REAL,
        life_flags TEXT DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, checkin_date)
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS readiness_scores (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        score_date TEXT NOT NULL,
        score INTEGER NOT NULL,
        band TEXT NOT NULL,
        drivers TEXT NOT NULL DEFAULT '[]',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, score_date)
      );
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_readiness_scores_user_date ON readiness_scores(user_id, score_date DESC)');
    await client.query('ALTER TABLE daily_checkins ADD COLUMN IF NOT EXISTS sleep_hours REAL');
    await client.query('ALTER TABLE daily_checkins ADD COLUMN IF NOT EXISTS legs INTEGER');
    await client.query('ALTER TABLE daily_checkins ADD COLUMN IF NOT EXISTS drive INTEGER');

    await client.query(`
      CREATE TABLE IF NOT EXISTS checkin_overrides (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        action TEXT NOT NULL,
        patch_json TEXT DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, date)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS community_workouts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        workout_name TEXT NOT NULL,
        target TEXT,
        warmup_json TEXT DEFAULT '[]',
        main_json TEXT DEFAULT '[]',
        recovery_json TEXT DEFAULT '[]',
        explanation TEXT,
        rest_notes TEXT,
        usage_count INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS community_posts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        workout_id TEXT,
        run_id TEXT,
        title TEXT NOT NULL,
        body TEXT,
        workout_type TEXT,
        stats_json TEXT DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS saved_workouts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        source_workout_id TEXT,
        community_workout_id TEXT,
        workout_name TEXT NOT NULL,
        target TEXT,
        warmup_json TEXT DEFAULT '[]',
        main_json TEXT DEFAULT '[]',
        recovery_json TEXT DEFAULT '[]',
        explanation TEXT,
        rest_notes TEXT,
        saved_at TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS journal_entries (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        source TEXT NOT NULL,
        content TEXT NOT NULL,
        session_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS milestones_seen (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        milestone_key TEXT NOT NULL,
        seen_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, milestone_key)
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS stretches (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        duration INTEGER DEFAULT 30,
        duration_label TEXT,
        cue TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        used INTEGER DEFAULT 0
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS injury_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        date TEXT,
        body_part TEXT,
        pain_level INTEGER,
        notes TEXT,
        cleared INTEGER DEFAULT 0,
        created_at TEXT
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pt_exercises (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        date TEXT NOT NULL,
        name TEXT NOT NULL,
        sets INTEGER DEFAULT 3,
        reps INTEGER DEFAULT 10,
        completed INTEGER DEFAULT 0,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS pt_milestones (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        date TEXT NOT NULL,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS suggested_goals (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        source_milestone TEXT,
        title TEXT NOT NULL,
        description TEXT,
        type TEXT DEFAULT 'endurance',
        target_value REAL,
        target_unit TEXT,
        difficulty TEXT DEFAULT 'moderate',
        status TEXT DEFAULT 'suggested',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS app_feedback (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        type TEXT DEFAULT 'bug',
        message TEXT NOT NULL,
        page TEXT,
        severity TEXT,
        category TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query("ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'bug'");
    await client.query('ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS page TEXT');
    await client.query('ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS severity TEXT');
    await client.query('ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS category TEXT');
    await client.query('ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()');

    await client.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL,
        keys_p256dh TEXT NOT NULL,
        keys_auth TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, endpoint)
      );
    `);

    // Seed core badges (ON CONFLICT DO NOTHING = INSERT OR IGNORE)
    const coreBadges = [
      ['first-run',   'First Run',          'You completed your first run!',  'Flame',   'achievement', 'run_count',   1,    null, null, '#EAB308'],
      ['10-runs',     '10 Runs Club',        '10 runs completed',              'Zap',     'achievement', 'run_count',   10,   null, null, '#EAB308'],
      ['50-runs',     '50 Runs Club',        '50 runs completed',              'Award',   'achievement', 'run_count',   50,   null, null, '#EAB308'],
      ['century',     'Century',             '100 runs completed',             'Crown',   'achievement', 'run_count',   100,  null, null, '#EAB308'],
      ['first-mile',  'First Mile',          'You ran your first mile!',       'Star',    'achievement', 'total_miles', 1,    null, null, '#EAB308'],
      ['marathon',    'Marathon Distance',   '26.2 miles total',               'Trophy',  'achievement', 'total_miles', 26.2, null, null, '#EAB308'],
      ['100-miles',   '100 Mile Club',       '100 total miles logged',         'Medal',   'achievement', 'total_miles', 100,  null, null, '#EAB308'],
      ['500-miles',   '500 Mile Club',       '500 total miles logged',         'Crown',   'achievement', 'total_miles', 500,  null, null, '#EAB308'],
      ['week-warrior','Week Warrior',        '7-day run streak',               'Flame',   'monthly',     'streak',      7,    null, null, '#EAB308'],
      ['iron-will',   'Iron Will',           '30-day run streak',              'Zap',     'monthly',     'streak',      30,   null, null, '#EAB308'],
      ['pr-breaker',  'PR Breaker',          'You set a personal record',      'Trophy',  'achievement', 'pr',          1,    null, null, '#EAB308'],
      ['new-year',    'New Year Runner',     'Ran on January 1st',             'Star',    'holiday',     'new_year',    1,    null, null, '#EAB308'],
    ];
    const seasonalBadges = [
      ['cherry-blossom',    'Cherry Blossom Run',    'Run 20 miles during cherry blossom season.',       'Flower2', 'seasonal', 'miles_in_window',    20, '03-20', '04-20', '#f472b6'],
      ['chinese-new-year',  'Year of the Snake',     'Complete 12 workouts during Lunar New Year.',      'Zap',     'seasonal', 'workouts_in_window', 12, '01-29', '02-28', '#ef4444'],
      ['st-patrick',        'Lucky Miles',           "Run 3.1 miles during St. Patrick's Day week.",     'Star',    'seasonal', 'miles_in_window',    3.1,'03-10', '03-17', '#22c55e'],
      ['independence',      'Independence Sprint',   'Run 7.6 miles during Independence Day week.',      'Flame',   'seasonal', 'miles_in_window',    7.6,'07-01', '07-07', '#3b82f6'],
      ['turkey-trot',       'Turkey Trot',           'Run 3.1 miles during Thanksgiving week.',          'Trophy',  'seasonal', 'miles_in_window',    3.1,'11-24', '11-30', '#f97316'],
      ['winter-grind',      'Winter Grind',          'Log 20 workouts in December.',                     'Medal',   'seasonal', 'workouts_in_window', 20, '12-01', '12-31', '#60a5fa'],
      ['summer-solstice',   'Solstice Warrior',      'Run 6.2 miles during the longest week.',           'Sun',     'seasonal', 'miles_in_window',    6.2,'06-18', '06-24', '#fbbf24'],
      ['valentines',        'Heart Mileage',         "Run 14 miles during Valentine's week.",            'Heart',   'seasonal', 'miles_in_window',    14, '02-10', '02-14', '#f43f5e'],
      ['halloween',         'Halloween Hustle',      'Log 31 workouts during October.',                  'Zap',     'seasonal', 'workouts_in_window', 31, '10-01', '10-31', '#f97316'],
      ['new-year-warrior',  'New Year Warrior',      'Log 20 workouts in January.',                      'Crown',   'seasonal', 'workouts_in_window', 20, '01-01', '01-31', '#a855f7'],
    ];

    for (const b of [...coreBadges, ...seasonalBadges]) {
      await client.query(
        `INSERT INTO badges (slug, name, description, icon, category, requirement_type, requirement_value, window_start, window_end, color)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (slug) DO NOTHING`,
        b
      );
    }

    const defaultPlans = [
      {
        id: 'plan-5k-default',
        name: '5K Builder',
        type: '5K',
        weeks: 8,
        description: '5K progression that balances quality running with protected strength sessions.',
        planData: {
          weeks: Array.from({ length: 8 }).map((_, i) => ({
            week: i + 1,
            sessions: [
              { id: `w${i + 1}-mon`, day: 'Mon', type: 'rest', title: 'Rest + mobility' },
              { id: `w${i + 1}-tue`, day: 'Tue', type: 'run', title: 'Easy run', distance_miles: 2 + i * 0.2 },
              { id: `w${i + 1}-wed`, day: 'Wed', type: 'strength', title: 'Strength maintenance' },
              { id: `w${i + 1}-thu`, day: 'Thu', type: 'run', title: 'Quality intervals', distance_miles: 2.5 + i * 0.25 },
              { id: `w${i + 1}-fri`, day: 'Fri', type: 'rest', title: 'Recovery walk' },
              { id: `w${i + 1}-sat`, day: 'Sat', type: 'run', title: 'Long easy run', distance_miles: 3 + i * 0.4 },
              { id: `w${i + 1}-sun`, day: 'Sun', type: 'run', title: 'Shakeout', distance_miles: 1.5 + i * 0.1 },
            ],
          })),
        },
      },
      {
        id: 'plan-10k-default',
        name: '10K Progression',
        type: '10K',
        weeks: 10,
        description: 'Build sustainable 10K fitness through controlled volume.',
        planData: {
          weeks: Array.from({ length: 10 }).map((_, i) => ({
            week: i + 1,
            sessions: [
              { id: `10k-${i + 1}-mon`, day: 'Mon', type: 'rest', title: 'Rest + mobility' },
              { id: `10k-${i + 1}-tue`, day: 'Tue', type: 'run', title: 'Easy run', distance_miles: 3 + i * 0.25 },
              { id: `10k-${i + 1}-wed`, day: 'Wed', type: 'strength', title: 'Strength maintenance' },
              { id: `10k-${i + 1}-thu`, day: 'Thu', type: 'run', title: 'Tempo', distance_miles: 3.5 + i * 0.25 },
              { id: `10k-${i + 1}-fri`, day: 'Fri', type: 'rest', title: 'Rest' },
              { id: `10k-${i + 1}-sat`, day: 'Sat', type: 'run', title: 'Long run', distance_miles: 4 + i * 0.5 },
              { id: `10k-${i + 1}-sun`, day: 'Sun', type: 'run', title: 'Recovery run', distance_miles: 2 + i * 0.15 },
            ],
          })),
        },
      },
      {
        id: 'plan-half-default',
        name: 'Half Marathon Build',
        type: 'Half Marathon',
        weeks: 12,
        description: 'Structured half marathon prep with durable weekly rhythm.',
        planData: {
          weeks: Array.from({ length: 12 }).map((_, i) => ({
            week: i + 1,
            sessions: [
              { id: `half-${i + 1}-mon`, day: 'Mon', type: 'rest', title: 'Rest' },
              { id: `half-${i + 1}-tue`, day: 'Tue', type: 'run', title: 'Easy run', distance_miles: 3.5 + i * 0.25 },
              { id: `half-${i + 1}-wed`, day: 'Wed', type: 'strength', title: 'Strength maintenance' },
              { id: `half-${i + 1}-thu`, day: 'Thu', type: 'run', title: 'Tempo/threshold', distance_miles: 4 + i * 0.3 },
              { id: `half-${i + 1}-fri`, day: 'Fri', type: 'rest', title: 'Rest' },
              { id: `half-${i + 1}-sat`, day: 'Sat', type: 'run', title: 'Long run', distance_miles: 6 + i * 0.6 },
              { id: `half-${i + 1}-sun`, day: 'Sun', type: 'run', title: 'Recovery run', distance_miles: 2 + i * 0.2 },
            ],
          })),
        },
      },
      {
        id: 'plan-marathon-default',
        name: 'Marathon Builder',
        type: 'Marathon',
        weeks: 16,
        description: 'Marathon progression anchored in easy mileage and long-run durability.',
        planData: {
          weeks: Array.from({ length: 16 }).map((_, i) => ({
            week: i + 1,
            sessions: [
              { id: `m-${i + 1}-mon`, day: 'Mon', type: 'rest', title: 'Rest + mobility' },
              { id: `m-${i + 1}-tue`, day: 'Tue', type: 'run', title: 'Easy run', distance_miles: 4 + i * 0.25 },
              { id: `m-${i + 1}-wed`, day: 'Wed', type: 'strength', title: 'Strength maintenance' },
              { id: `m-${i + 1}-thu`, day: 'Thu', type: 'run', title: 'Marathon pace work', distance_miles: 5 + i * 0.35 },
              { id: `m-${i + 1}-fri`, day: 'Fri', type: 'rest', title: 'Recovery day' },
              { id: `m-${i + 1}-sat`, day: 'Sat', type: 'run', title: 'Long run', distance_miles: 8 + i * 0.8 },
              { id: `m-${i + 1}-sun`, day: 'Sun', type: 'run', title: 'Recovery run', distance_miles: 3 + i * 0.2 },
            ],
          })),
        },
      },
      {
        id: 'plan-strength-default',
        name: 'Strength Beginner',
        type: 'Strength Beginner',
        weeks: 8,
        description: 'Two short strength sessions weekly to keep runners resilient.',
        planData: {
          weeks: Array.from({ length: 8 }).map((_, i) => ({
            week: i + 1,
            sessions: [
              { id: `sb-${i + 1}-mon`, day: 'Mon', type: 'strength', title: 'Lower body stability' },
              { id: `sb-${i + 1}-tue`, day: 'Tue', type: 'run', title: 'Easy run', distance_miles: 2.5 + i * 0.2 },
              { id: `sb-${i + 1}-wed`, day: 'Wed', type: 'rest', title: 'Rest' },
              { id: `sb-${i + 1}-thu`, day: 'Thu', type: 'strength', title: 'Core + posterior chain' },
              { id: `sb-${i + 1}-fri`, day: 'Fri', type: 'run', title: 'Moderate run', distance_miles: 3 + i * 0.25 },
              { id: `sb-${i + 1}-sat`, day: 'Sat', type: 'run', title: 'Long run', distance_miles: 4 + i * 0.35 },
              { id: `sb-${i + 1}-sun`, day: 'Sun', type: 'rest', title: 'Rest' },
            ],
          })),
        },
      },
    ];

    for (const p of defaultPlans) {
      await client.query(`
        INSERT INTO training_plans (id, user_id, week_start, plan_json, name, type, weeks, description, plan_data)
        VALUES ($1, NULL, to_char(NOW(), 'YYYY-MM-DD'), $2, $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          type = EXCLUDED.type,
          weeks = EXCLUDED.weeks,
          description = EXCLUDED.description,
          plan_data = EXCLUDED.plan_data
      `, [p.id, JSON.stringify({ weeks: p.planData.weeks }), p.name, p.type, p.weeks, p.description, JSON.stringify(p.planData)]);
    }

    await client.query('COMMIT');
    console.log('[DB] PostgreSQL schema ready');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, dbGet, dbAll, dbRun, withTransaction, initDb };
