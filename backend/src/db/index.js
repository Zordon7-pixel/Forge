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
`);

// Add is_pro column to users if not exists
const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!cols.includes('is_pro')) {
  db.prepare("ALTER TABLE users ADD COLUMN is_pro INTEGER DEFAULT 0").run();
}

module.exports = db;
