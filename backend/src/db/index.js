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
    notes TEXT
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

module.exports = db;
