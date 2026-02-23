const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../../../forge.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
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
    created_at TEXT DEFAULT (datetime('now'))
  );

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
    created_at TEXT DEFAULT (datetime('now'))
  );

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
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS lifts (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    date TEXT NOT NULL,
    muscle_groups TEXT DEFAULT '[]',
    intensity TEXT DEFAULT 'moderate',
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS training_plans (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    week_start TEXT NOT NULL,
    plan_json TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ai_usage (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    call_type TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS workout_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    notes TEXT,
    muscle_groups TEXT DEFAULT '[]',
    total_seconds INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS workout_sets (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES workout_sessions(id),
    user_id TEXT REFERENCES users(id),
    exercise_name TEXT NOT NULL,
    muscle_group TEXT,
    set_number INTEGER DEFAULT 1,
    reps INTEGER,
    weight_lbs REAL,
    logged_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS personal_records (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    label TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT NOT NULL,
    run_id TEXT,
    lift_id TEXT,
    achieved_at TEXT DEFAULT (datetime('now')),
    notes TEXT,
    source TEXT DEFAULT 'auto',
    discrepancy INTEGER DEFAULT 0,
    auto_value REAL
  );

  CREATE TABLE IF NOT EXISTS badges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    icon TEXT,
    category TEXT,
    requirement_type TEXT,
    requirement_value REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS user_badges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    badge_id INTEGER NOT NULL,
    earned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (badge_id) REFERENCES badges(id),
    UNIQUE(user_id, badge_id)
  );

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
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_challenges (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    challenge_id TEXT NOT NULL,
    progress REAL DEFAULT 0,
    joined_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    UNIQUE(user_id, challenge_id)
  );

  CREATE TABLE IF NOT EXISTS step_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    log_date TEXT NOT NULL,
    steps INTEGER DEFAULT 0,
    source TEXT DEFAULT 'manual',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, log_date)
  );

  CREATE TABLE IF NOT EXISTS activity_likes (
    id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL,
    activity_type TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(activity_id, activity_type, user_id)
  );

  CREATE TABLE IF NOT EXISTS activity_comments (
    id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL,
    activity_type TEXT NOT NULL,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS activity_media (
    id TEXT PRIMARY KEY,
    activity_id TEXT NOT NULL,
    activity_type TEXT NOT NULL,
    user_id TEXT NOT NULL,
    data TEXT NOT NULL,
    mime_type TEXT DEFAULT 'image/jpeg',
    created_at TEXT DEFAULT (datetime('now'))
  );

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
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS route_likes (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    route_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, route_id)
  );
`);

// Add is_pro column to users if not exists
const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!cols.includes('is_pro')) {
  db.prepare("ALTER TABLE users ADD COLUMN is_pro INTEGER DEFAULT 0").run();
}
if (!cols.includes('sex')) {
  db.prepare("ALTER TABLE users ADD COLUMN sex TEXT DEFAULT 'male'").run();
}
if (!cols.includes('weight_lbs')) {
  db.prepare("ALTER TABLE users ADD COLUMN weight_lbs REAL").run();
}

// Exercises table — community library
db.prepare(`CREATE TABLE IF NOT EXISTS exercises (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name TEXT NOT NULL,
  muscle_group TEXT NOT NULL,
  secondary_muscles TEXT DEFAULT '',
  instructions TEXT DEFAULT '',
  how_to_image_url TEXT DEFAULT '',
  is_system INTEGER DEFAULT 1,
  created_by_user_id TEXT DEFAULT NULL,
  approved INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
)`).run();

// Migrations for existing exercises table
const exCols = db.prepare("PRAGMA table_info(exercises)").all().map(c => c.name);
if (!exCols.includes('instructions')) db.prepare("ALTER TABLE exercises ADD COLUMN instructions TEXT DEFAULT ''").run();
if (!exCols.includes('how_to_image_url')) db.prepare("ALTER TABLE exercises ADD COLUMN how_to_image_url TEXT DEFAULT ''").run();
if (!exCols.includes('is_system')) db.prepare("ALTER TABLE exercises ADD COLUMN is_system INTEGER DEFAULT 1").run();
if (!exCols.includes('created_by_user_id')) db.prepare("ALTER TABLE exercises ADD COLUMN created_by_user_id TEXT DEFAULT NULL").run();
if (!exCols.includes('approved')) db.prepare("ALTER TABLE exercises ADD COLUMN approved INTEGER DEFAULT 1").run();
if (!exCols.includes('secondary_muscles')) db.prepare("ALTER TABLE exercises ADD COLUMN secondary_muscles TEXT DEFAULT ''").run();

const runCols = db.prepare("PRAGMA table_info(runs)").all().map(c => c.name);
if (!runCols.includes('calories')) {
  db.prepare("ALTER TABLE runs ADD COLUMN calories INTEGER DEFAULT 0").run();
}
if (!runCols.includes('run_surface')) db.prepare("ALTER TABLE runs ADD COLUMN run_surface TEXT DEFAULT 'outdoor'").run();
if (!runCols.includes('incline_pct')) db.prepare("ALTER TABLE runs ADD COLUMN incline_pct REAL DEFAULT 0").run();
if (!runCols.includes('treadmill_speed')) db.prepare("ALTER TABLE runs ADD COLUMN treadmill_speed REAL DEFAULT 0").run();
if (!runCols.includes('pain_level')) db.prepare("ALTER TABLE runs ADD COLUMN pain_level TEXT").run();
if (!runCols.includes('post_energy')) db.prepare("ALTER TABLE runs ADD COLUMN post_energy TEXT").run();
if (!runCols.includes('surface')) db.prepare("ALTER TABLE runs ADD COLUMN surface TEXT DEFAULT 'road'").run();
if (!runCols.includes('route_coords')) db.prepare("ALTER TABLE runs ADD COLUMN route_coords TEXT DEFAULT '[]'").run();
if (!runCols.includes('avg_heart_rate')) db.prepare("ALTER TABLE runs ADD COLUMN avg_heart_rate INTEGER").run();
if (!runCols.includes('watch_mode')) db.prepare("ALTER TABLE runs ADD COLUMN watch_mode TEXT").run();
if (!runCols.includes('watch_sync_id')) db.prepare("ALTER TABLE runs ADD COLUMN watch_sync_id TEXT").run();
if (!runCols.includes('watch_activity_type')) db.prepare("ALTER TABLE runs ADD COLUMN watch_activity_type TEXT").run();
if (!runCols.includes('watch_normalized_type')) db.prepare("ALTER TABLE runs ADD COLUMN watch_normalized_type TEXT").run();
if (!runCols.includes('max_heart_rate')) db.prepare("ALTER TABLE runs ADD COLUMN max_heart_rate INTEGER").run();
if (!runCols.includes('min_heart_rate')) db.prepare("ALTER TABLE runs ADD COLUMN min_heart_rate INTEGER").run();
if (!runCols.includes('heart_rate_zones')) db.prepare("ALTER TABLE runs ADD COLUMN heart_rate_zones TEXT DEFAULT '[]'").run();
if (!runCols.includes('cadence_spm')) db.prepare("ALTER TABLE runs ADD COLUMN cadence_spm REAL").run();
if (!runCols.includes('elevation_gain')) db.prepare("ALTER TABLE runs ADD COLUMN elevation_gain REAL").run();
if (!runCols.includes('elevation_loss')) db.prepare("ALTER TABLE runs ADD COLUMN elevation_loss REAL").run();
if (!runCols.includes('pace_avg')) db.prepare("ALTER TABLE runs ADD COLUMN pace_avg REAL").run();
if (!runCols.includes('pace_splits')) db.prepare("ALTER TABLE runs ADD COLUMN pace_splits TEXT DEFAULT '[]'").run();
if (!runCols.includes('vo2_max')) db.prepare("ALTER TABLE runs ADD COLUMN vo2_max REAL").run();
if (!runCols.includes('training_effect_aerobic')) db.prepare("ALTER TABLE runs ADD COLUMN training_effect_aerobic REAL").run();
if (!runCols.includes('training_effect_anaerobic')) db.prepare("ALTER TABLE runs ADD COLUMN training_effect_anaerobic REAL").run();
if (!runCols.includes('recovery_time_hours')) db.prepare("ALTER TABLE runs ADD COLUMN recovery_time_hours REAL").run();
if (!runCols.includes('detected_surface_type')) db.prepare("ALTER TABLE runs ADD COLUMN detected_surface_type TEXT").run();
if (!runCols.includes('temperature_f')) db.prepare("ALTER TABLE runs ADD COLUMN temperature_f REAL").run();
if (!runCols.includes('treadmill_brand')) db.prepare("ALTER TABLE runs ADD COLUMN treadmill_brand TEXT").run();
if (!runCols.includes('treadmill_model')) db.prepare("ALTER TABLE runs ADD COLUMN treadmill_model TEXT").run();
if (!runCols.includes('gps_available')) db.prepare("ALTER TABLE runs ADD COLUMN gps_available INTEGER DEFAULT 1").run();
try { db.prepare("ALTER TABLE runs ADD COLUMN cadence_avg REAL").run() } catch (_) {}
try { db.prepare("ALTER TABLE runs ADD COLUMN vo2max REAL").run() } catch (_) {}
try { db.prepare("ALTER TABLE runs ADD COLUMN temperature_c REAL").run() } catch (_) {}
try { db.prepare("ALTER TABLE runs ADD COLUMN calories_watch INTEGER").run() } catch (_) {}

const runCols2 = db.prepare("PRAGMA table_info(runs)").all().map(c => c.name);
if (!runCols2.includes('shoe_id')) db.prepare("ALTER TABLE runs ADD COLUMN shoe_id TEXT").run();

const liftCols = db.prepare("PRAGMA table_info(lifts)").all().map(c => c.name);
if (!liftCols.includes('exercise_name')) {
  db.prepare("ALTER TABLE lifts ADD COLUMN exercise_name TEXT").run();
}
if (!liftCols.includes('sets')) {
  db.prepare("ALTER TABLE lifts ADD COLUMN sets INTEGER").run();
}
if (!liftCols.includes('reps')) {
  db.prepare("ALTER TABLE lifts ADD COLUMN reps INTEGER").run();
}
if (!liftCols.includes('weight_lbs')) {
  db.prepare("ALTER TABLE lifts ADD COLUMN weight_lbs REAL").run();
}
if (!liftCols.includes('watch_sync_id')) db.prepare("ALTER TABLE lifts ADD COLUMN watch_sync_id TEXT").run();
if (!liftCols.includes('watch_activity_type')) db.prepare("ALTER TABLE lifts ADD COLUMN watch_activity_type TEXT").run();
if (!liftCols.includes('watch_normalized_type')) db.prepare("ALTER TABLE lifts ADD COLUMN watch_normalized_type TEXT").run();
if (!liftCols.includes('avg_heart_rate')) db.prepare("ALTER TABLE lifts ADD COLUMN avg_heart_rate INTEGER").run();
if (!liftCols.includes('max_heart_rate')) db.prepare("ALTER TABLE lifts ADD COLUMN max_heart_rate INTEGER").run();
if (!liftCols.includes('min_heart_rate')) db.prepare("ALTER TABLE lifts ADD COLUMN min_heart_rate INTEGER").run();
if (!liftCols.includes('set_heart_rate')) db.prepare("ALTER TABLE lifts ADD COLUMN set_heart_rate TEXT DEFAULT '[]'").run();
if (!liftCols.includes('rest_heart_rate')) db.prepare("ALTER TABLE lifts ADD COLUMN rest_heart_rate TEXT DEFAULT '[]'").run();
if (!liftCols.includes('workout_duration_seconds')) db.prepare("ALTER TABLE lifts ADD COLUMN workout_duration_seconds INTEGER").run();
if (!liftCols.includes('calories')) db.prepare("ALTER TABLE lifts ADD COLUMN calories INTEGER").run();
if (!liftCols.includes('recovery_heart_rate')) db.prepare("ALTER TABLE lifts ADD COLUMN recovery_heart_rate INTEGER").run();
if (!liftCols.includes('category')) db.prepare("ALTER TABLE lifts ADD COLUMN category TEXT DEFAULT 'strength'").run();

const prCols = db.prepare("PRAGMA table_info(personal_records)").all().map(c => c.name);
if (!prCols.includes('source')) db.prepare("ALTER TABLE personal_records ADD COLUMN source TEXT DEFAULT 'auto'").run();
if (!prCols.includes('discrepancy')) db.prepare("ALTER TABLE personal_records ADD COLUMN discrepancy INTEGER DEFAULT 0").run();
if (!prCols.includes('auto_value')) db.prepare("ALTER TABLE personal_records ADD COLUMN auto_value REAL").run();

// Schedule preference columns
const userCols2 = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols2.includes('schedule_type')) db.prepare("ALTER TABLE users ADD COLUMN schedule_type TEXT DEFAULT 'adaptive'").run();
if (!userCols2.includes('lifestyle')) db.prepare("ALTER TABLE users ADD COLUMN lifestyle TEXT DEFAULT 'works_fulltime'").run();
if (!userCols2.includes('preferred_workout_time')) db.prepare("ALTER TABLE users ADD COLUMN preferred_workout_time TEXT DEFAULT 'evening'").run();
if (!userCols2.includes('preferred_workout_days')) db.prepare("ALTER TABLE users ADD COLUMN preferred_workout_days TEXT DEFAULT '[]'").run();
if (!userCols2.includes('missed_workout_pref')) db.prepare("ALTER TABLE users ADD COLUMN missed_workout_pref TEXT DEFAULT 'adjust_week'").run();
if (!userCols2.includes('weekly_workout_days')) db.prepare("ALTER TABLE users ADD COLUMN weekly_workout_days INTEGER DEFAULT 4").run();
if (!userCols2.includes('injury_mode')) db.prepare("ALTER TABLE users ADD COLUMN injury_mode INTEGER DEFAULT 0").run();
if (!userCols2.includes('injury_description')) db.prepare("ALTER TABLE users ADD COLUMN injury_description TEXT DEFAULT ''").run();
if (!userCols2.includes('injury_date')) db.prepare("ALTER TABLE users ADD COLUMN injury_date TEXT DEFAULT ''").run();
if (!userCols2.includes('injury_limitations')) db.prepare("ALTER TABLE users ADD COLUMN injury_limitations TEXT DEFAULT ''").run();
if (!userCols2.includes('distance_unit')) db.prepare("ALTER TABLE users ADD COLUMN distance_unit TEXT DEFAULT 'miles'").run();
if (!userCols2.includes('theme')) db.prepare("ALTER TABLE users ADD COLUMN theme TEXT DEFAULT 'dark'").run();
if (!userCols2.includes('age')) db.prepare("ALTER TABLE users ADD COLUMN age INTEGER").run();
if (!userCols2.includes('max_heart_rate')) db.prepare("ALTER TABLE users ADD COLUMN max_heart_rate INTEGER").run();

// Add username column to users if not exists
const userCols3 = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols3.includes('username')) {
  db.prepare("ALTER TABLE users ADD COLUMN username TEXT DEFAULT NULL").run();
}

// Add units preference column (metric/imperial)
const userCols4 = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols4.includes('units')) {
  db.prepare("ALTER TABLE users ADD COLUMN units TEXT DEFAULT 'imperial'").run();
}

try { db.exec('ALTER TABLE users ADD COLUMN step_goal INTEGER DEFAULT 10000') } catch (_) {}
try { db.prepare('ALTER TABLE workout_sessions ADD COLUMN ai_feedback TEXT').run() } catch (_) {}
try { db.prepare('ALTER TABLE saved_workouts ADD COLUMN community_workout_id TEXT').run() } catch (_) {}
try { db.prepare('ALTER TABLE saved_workouts ADD COLUMN saved_at TEXT DEFAULT (datetime(\'now\'))').run() } catch (_) {}

// Add seasonal columns to badges if missing
try { db.prepare("ALTER TABLE badges ADD COLUMN window_start TEXT").run() } catch (_) {}
try { db.prepare("ALTER TABLE badges ADD COLUMN window_end TEXT").run() } catch (_) {}
try { db.prepare("ALTER TABLE badges ADD COLUMN color TEXT DEFAULT '#EAB308'").run() } catch (_) {}

// Seed seasonal badges
const seasonalBadges = [
  { slug: 'cherry-blossom', name: 'Cherry Blossom Run', description: 'Run 20 miles during cherry blossom season.', icon: 'Flower2', category: 'seasonal', requirement_type: 'miles_in_window', requirement_value: 20, window_start: '03-20', window_end: '04-20', color: '#f472b6' },
  { slug: 'chinese-new-year', name: 'Year of the Snake', description: 'Complete 12 workouts during Lunar New Year celebrations.', icon: 'Zap', category: 'seasonal', requirement_type: 'workouts_in_window', requirement_value: 12, window_start: '01-29', window_end: '02-28', color: '#ef4444' },
  { slug: 'st-patrick', name: 'Lucky Miles', description: 'Run 3.1 miles during St. Patrick\'s Day week.', icon: 'Star', category: 'seasonal', requirement_type: 'miles_in_window', requirement_value: 3.1, window_start: '03-10', window_end: '03-17', color: '#22c55e' },
  { slug: 'independence', name: 'Independence Sprint', description: 'Run 7.6 miles during Independence Day week.', icon: 'Flame', category: 'seasonal', requirement_type: 'miles_in_window', requirement_value: 7.6, window_start: '07-01', window_end: '07-07', color: '#3b82f6' },
  { slug: 'turkey-trot', name: 'Turkey Trot', description: 'Run 3.1 miles during Thanksgiving week.', icon: 'Trophy', category: 'seasonal', requirement_type: 'miles_in_window', requirement_value: 3.1, window_start: '11-24', window_end: '11-30', color: '#f97316' },
  { slug: 'winter-grind', name: 'Winter Grind', description: 'Log 20 workouts in December.', icon: 'Medal', category: 'seasonal', requirement_type: 'workouts_in_window', requirement_value: 20, window_start: '12-01', window_end: '12-31', color: '#60a5fa' },
  { slug: 'summer-solstice', name: 'Solstice Warrior', description: 'Run 6.2 miles during the longest week of the year.', icon: 'Sun', category: 'seasonal', requirement_type: 'miles_in_window', requirement_value: 6.2, window_start: '06-18', window_end: '06-24', color: '#fbbf24' },
  { slug: 'valentines', name: 'Heart Mileage', description: 'Run 14 miles during Valentine\'s week.', icon: 'Heart', category: 'seasonal', requirement_type: 'miles_in_window', requirement_value: 14, window_start: '02-10', window_end: '02-14', color: '#f43f5e' },
  { slug: 'halloween', name: 'Halloween Hustle', description: 'Log 31 workouts during October.', icon: 'Zap', category: 'seasonal', requirement_type: 'workouts_in_window', requirement_value: 31, window_start: '10-01', window_end: '10-31', color: '#f97316' },
  { slug: 'new-year-warrior', name: 'New Year Warrior', description: 'Log 20 workouts in January to start the year strong.', icon: 'Crown', category: 'seasonal', requirement_type: 'workouts_in_window', requirement_value: 20, window_start: '01-01', window_end: '01-31', color: '#a855f7' },
]

const seasonalStmt = db.prepare("INSERT OR IGNORE INTO badges (slug, name, description, icon, category, requirement_type, requirement_value, window_start, window_end, color) VALUES (?,?,?,?,?,?,?,?,?,?)")
seasonalBadges.forEach(b => seasonalStmt.run(b.slug, b.name, b.description, b.icon, b.category, b.requirement_type, b.requirement_value, b.window_start, b.window_end, b.color))

db.exec(`
  CREATE TABLE IF NOT EXISTS watch_sync (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    synced_at TEXT DEFAULT (datetime('now'))
  );
`);

const watchCols = db.prepare("PRAGMA table_info(watch_sync)").all().map(c => c.name);
const addWatchCol = (name, sqlType) => { if (!watchCols.includes(name)) db.prepare(`ALTER TABLE watch_sync ADD COLUMN ${name} ${sqlType}`).run(); };
addWatchCol('activity_type', 'TEXT');
addWatchCol('activity_name', 'TEXT');
addWatchCol('normalized_type', 'TEXT');
addWatchCol('routed_section', 'TEXT');
addWatchCol('distance_miles', 'REAL');
addWatchCol('duration_seconds', 'INTEGER');
addWatchCol('avg_pace', 'REAL');
addWatchCol('pace_splits_json', "TEXT DEFAULT '[]'");
addWatchCol('avg_heart_rate', 'INTEGER');
addWatchCol('max_heart_rate', 'INTEGER');
addWatchCol('min_heart_rate', 'INTEGER');
addWatchCol('heart_rate_zones_json', "TEXT DEFAULT '[]'");
addWatchCol('cadence_spm', 'REAL');
addWatchCol('elevation_gain', 'REAL');
addWatchCol('elevation_loss', 'REAL');
addWatchCol('route_coords', "TEXT DEFAULT '[]'");
addWatchCol('vo2_max', 'REAL');
addWatchCol('training_effect_aerobic', 'REAL');
addWatchCol('training_effect_anaerobic', 'REAL');
addWatchCol('recovery_time_hours', 'REAL');
addWatchCol('detected_surface_type', 'TEXT');
addWatchCol('temperature_f', 'REAL');
addWatchCol('calories', 'INTEGER');
addWatchCol('exercise_name', 'TEXT');
addWatchCol('sets', 'INTEGER');
addWatchCol('reps', 'INTEGER');
addWatchCol('weight_lbs', 'REAL');
addWatchCol('set_heart_rate_json', "TEXT DEFAULT '[]'");
addWatchCol('rest_heart_rate_json', "TEXT DEFAULT '[]'");
addWatchCol('workout_duration_seconds', 'INTEGER');
addWatchCol('recovery_heart_rate', 'INTEGER');
addWatchCol('incline_pct', 'REAL');
addWatchCol('belt_speed_mph', 'REAL');
addWatchCol('treadmill_brand', 'TEXT');
addWatchCol('treadmill_model', 'TEXT');
addWatchCol('watch_mode', 'TEXT');
addWatchCol('raw_payload', 'TEXT');

db.exec(`
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
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS daily_checkins (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    checkin_date TEXT NOT NULL,
    feeling INTEGER DEFAULT 3,
    time_available INTEGER DEFAULT 60,
    life_flags TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, checkin_date)
  );

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
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS saved_workouts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    source_workout_id TEXT,
    workout_name TEXT NOT NULL,
    target TEXT,
    warmup_json TEXT DEFAULT '[]',
    main_json TEXT DEFAULT '[]',
    recovery_json TEXT DEFAULT '[]',
    explanation TEXT,
    rest_notes TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS journal_entries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    source TEXT NOT NULL,
    content TEXT NOT NULL,
    session_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS milestones_seen (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    milestone_key TEXT NOT NULL,
    seen_at TEXT DEFAULT (datetime('now')),
    UNIQUE(user_id, milestone_key)
  );

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
    synced_at TEXT DEFAULT (datetime('now'))
  );
`);

// Stretches table — category-based guided stretch sessions
db.prepare(`CREATE TABLE IF NOT EXISTS stretches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  duration INTEGER DEFAULT 30,
  duration_label TEXT,
  cue TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`).run();

const stretchCols = db.prepare("PRAGMA table_info(stretches)").all().map(c => c.name);
if (!stretchCols.includes('category')) db.prepare("ALTER TABLE stretches ADD COLUMN category TEXT").run();

module.exports = db;
