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

// Exercise library table (shared across all users)
db.exec(`
  CREATE TABLE IF NOT EXISTS exercises (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    muscle_group TEXT NOT NULL,
    is_custom INTEGER DEFAULT 0,
    created_by TEXT REFERENCES users(id),
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

const exerciseCount = db.prepare('SELECT COUNT(*) as cnt FROM exercises').get().cnt;
if (exerciseCount === 0) {
  const defaultExercises = [
    // Chest
    { name: 'Bench Press', group: 'chest' },
    { name: 'Incline Bench Press', group: 'chest' },
    { name: 'Decline Bench Press', group: 'chest' },
    { name: 'Dumbbell Fly', group: 'chest' },
    { name: 'Cable Crossover', group: 'chest' },
    { name: 'Push-ups', group: 'chest' },
    { name: 'Dips', group: 'chest' },
    // Back
    { name: 'Pull-ups', group: 'back' },
    { name: 'Lat Pulldown', group: 'back' },
    { name: 'Barbell Row', group: 'back' },
    { name: 'Seated Cable Row', group: 'back' },
    { name: 'Single Arm Dumbbell Row', group: 'back' },
    { name: 'T-Bar Row', group: 'back' },
    { name: 'Deadlift', group: 'back' },
    // Legs
    { name: 'Squat', group: 'legs' },
    { name: 'Leg Press', group: 'legs' },
    { name: 'Romanian Deadlift', group: 'legs' },
    { name: 'Leg Curl', group: 'legs' },
    { name: 'Leg Extension', group: 'legs' },
    { name: 'Lunges', group: 'legs' },
    { name: 'Calf Raises', group: 'legs' },
    { name: 'Hip Thrust', group: 'legs' },
    // Shoulders
    { name: 'Overhead Press', group: 'shoulders' },
    { name: 'Dumbbell Shoulder Press', group: 'shoulders' },
    { name: 'Lateral Raise', group: 'shoulders' },
    { name: 'Front Raise', group: 'shoulders' },
    { name: 'Face Pull', group: 'shoulders' },
    { name: 'Arnold Press', group: 'shoulders' },
    { name: 'Upright Row', group: 'shoulders' },
    // Arms
    { name: 'Barbell Curl', group: 'arms' },
    { name: 'Dumbbell Curl', group: 'arms' },
    { name: 'Hammer Curl', group: 'arms' },
    { name: 'Preacher Curl', group: 'arms' },
    { name: 'Tricep Pushdown', group: 'arms' },
    { name: 'Skull Crushers', group: 'arms' },
    { name: 'Overhead Tricep Extension', group: 'arms' },
    { name: 'Diamond Push-ups', group: 'arms' },
    // Core
    { name: 'Plank', group: 'core' },
    { name: 'Crunches', group: 'core' },
    { name: 'Leg Raises', group: 'core' },
    { name: 'Russian Twists', group: 'core' },
    { name: 'Ab Rollout', group: 'core' },
    { name: 'Cable Crunch', group: 'core' },
    { name: 'Hanging Knee Raise', group: 'core' },
  ];
  const { v4: uuidv4 } = require('uuid');
  const insertEx = db.prepare('INSERT INTO exercises (id, name, muscle_group) VALUES (?, ?, ?)');
  defaultExercises.forEach(ex => insertEx.run(uuidv4(), ex.name, ex.group));
}

const runCols = db.prepare("PRAGMA table_info(runs)").all().map(c => c.name);
if (!runCols.includes('calories')) {
  db.prepare("ALTER TABLE runs ADD COLUMN calories INTEGER DEFAULT 0").run();
}

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

module.exports = db;
