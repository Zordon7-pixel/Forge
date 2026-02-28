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
    try {
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_pro INTEGER DEFAULT 0');
      console.log('is_pro');
    } catch (err) {}
    try {
      await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS sex TEXT DEFAULT 'male'");
      console.log('sex');
    } catch (err) {}
    try {
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS weight_lbs REAL');
      console.log('weight_lbs');
    } catch (err) {}
    try {
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS height_ft INTEGER DEFAULT 5');
      console.log('height_ft');
    } catch (err) {}
    try {
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS height_in INTEGER DEFAULT 8');
      console.log('height_in');
    } catch (err) {}
    try {
      await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS schedule_type TEXT DEFAULT 'adaptive'");
      console.log('schedule_type');
    } catch (err) {}
    try {
      await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS lifestyle TEXT DEFAULT 'works_fulltime'");
      console.log('lifestyle');
    } catch (err) {}
    try {
      await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_workout_time TEXT DEFAULT 'evening'");
      console.log('preferred_workout_time');
    } catch (err) {}
    try {
      await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_workout_days TEXT DEFAULT '[]'");
      console.log('preferred_workout_days');
    } catch (err) {}
    try {
      await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS missed_workout_pref TEXT DEFAULT 'adjust_week'");
      console.log('missed_workout_pref');
    } catch (err) {}
    try {
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS weekly_workout_days INTEGER DEFAULT 4');
      console.log('weekly_workout_days');
    } catch (err) {}
    try {
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS injury_mode INTEGER DEFAULT 0');
      console.log('injury_mode');
    } catch (err) {}
    try {
      await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS injury_description TEXT DEFAULT ''");
      console.log('injury_description');
    } catch (err) {}
    try {
      await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS injury_date TEXT DEFAULT ''");
      console.log('injury_date');
    } catch (err) {}
    try {
      await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS injury_limitations TEXT DEFAULT ''");
      console.log('injury_limitations');
    } catch (err) {}
    try {
      await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS distance_unit TEXT DEFAULT 'miles'");
      console.log('distance_unit');
    } catch (err) {}
    try {
      await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS theme TEXT DEFAULT 'dark'");
      console.log('theme');
    } catch (err) {}
    try {
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS age INTEGER');
      console.log('age');
    } catch (err) {}
    try {
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS max_heart_rate INTEGER');
      console.log('max_heart_rate');
    } catch (err) {}
    try {
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT');
      console.log('username');
    } catch (err) {}
    try {
      await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS units TEXT DEFAULT 'imperial'");
      console.log('units');
    } catch (err) {}
    try {
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS step_goal INTEGER DEFAULT 10000');
      console.log('step_goal');
    } catch (err) {}
    try {
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_goal_miles REAL');
      console.log('monthly_goal_miles');
    } catch (err) {}
    try {
      await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS monthly_goal_mode TEXT DEFAULT 'auto'");
      console.log('monthly_goal_mode');
    } catch (err) {}
    try {
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT');
      console.log('stripe_customer_id');
    } catch (err) {}
    try {
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT');
      console.log('stripe_subscription_id');
    } catch (err) {}
    try {
      await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT 'free'");
      console.log('subscription_status');
    } catch (err) {}
    try {
      await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_ends_at TEXT');
      console.log('subscription_ends_at');
    } catch (err) {}
    try {
      await client.query("UPDATE users SET subscription_status = 'free' WHERE subscription_status IS NULL");
    } catch (err) {}
    try {
      await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS fitness_level TEXT DEFAULT 'beginner'");
      console.log('fitness_level');
    } catch (err) {}
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
        gps_available INTEGER DEFAULT 1,
        shoe_id TEXT,
        pain_level TEXT,
        post_energy TEXT,
        calories_watch INTEGER,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS gear_shoes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        brand TEXT NOT NULL,
        model TEXT NOT NULL,
        nickname TEXT,
        color TEXT,
        purchase_date TEXT,
        recommended_miles INTEGER DEFAULT 450,
        is_retired INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

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
      CREATE TABLE IF NOT EXISTS activity_media (
        id TEXT PRIMARY KEY,
        activity_id TEXT NOT NULL,
        activity_type TEXT NOT NULL,
        user_id TEXT NOT NULL,
        data TEXT NOT NULL,
        mime_type TEXT DEFAULT 'image/jpeg',
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

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
        raw_payload TEXT,
        synced_at TEXT DEFAULT to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      );
    `);

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
        time_available INTEGER DEFAULT 60,
        sleep_hours REAL,
        life_flags TEXT DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, checkin_date)
      );
    `);
    await client.query('ALTER TABLE daily_checkins ADD COLUMN IF NOT EXISTS sleep_hours REAL');

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
        description: 'Runner-first 5K progression with strength for injury prevention.',
        planData: {
          weeks: Array.from({ length: 8 }).map((_, i) => ({
            week: i + 1,
            sessions: [
              { id: `w${i + 1}-mon`, day: 'Mon', type: 'rest', title: 'Rest + mobility' },
              { id: `w${i + 1}-tue`, day: 'Tue', type: 'run', title: 'Easy run', distance_miles: 2 + i * 0.2 },
              { id: `w${i + 1}-wed`, day: 'Wed', type: 'strength', title: 'Strength injury prevention' },
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
              { id: `10k-${i + 1}-wed`, day: 'Wed', type: 'strength', title: 'Strength injury prevention' },
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
              { id: `half-${i + 1}-wed`, day: 'Wed', type: 'strength', title: 'Strength injury prevention' },
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
              { id: `m-${i + 1}-wed`, day: 'Wed', type: 'strength', title: 'Strength injury prevention' },
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

module.exports = { pool, dbGet, dbAll, dbRun, initDb };
