-- FORGE PostgreSQL Schema
-- Converted from SQLite better-sqlite3

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS runs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  distance_miles REAL DEFAULT 0,
  duration_seconds INTEGER DEFAULT 0,
  perceived_effort INTEGER DEFAULT 5,
  notes TEXT,
  ai_feedback TEXT,
  run_surface TEXT DEFAULT 'road',
  surface TEXT DEFAULT 'road',
  incline_pct REAL DEFAULT 0,
  treadmill_speed REAL DEFAULT 0,
  route_coords TEXT DEFAULT '[]',
  avg_heart_rate INTEGER,
  max_heart_rate INTEGER,
  min_heart_rate INTEGER,
  heart_rate_zones TEXT DEFAULT '[]',
  cadence_spm REAL,
  elevation_gain REAL,
  elevation_loss REAL,
  pace_avg REAL,
  pace_splits TEXT DEFAULT '[]',
  vo2_max REAL,
  training_effect_aerobic REAL,
  training_effect_anaerobic REAL,
  recovery_time_hours REAL,
  detected_surface_type TEXT,
  temperature_f REAL,
  calories INTEGER DEFAULT 0,
  treadmill_brand TEXT,
  treadmill_model TEXT,
  watch_mode TEXT,
  watch_sync_id TEXT,
  watch_activity_type TEXT,
  watch_normalized_type TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_runs_user_id ON runs(user_id);
CREATE INDEX IF NOT EXISTS idx_runs_user_date ON runs(user_id, date DESC);

CREATE TABLE IF NOT EXISTS lifts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  muscle_groups TEXT DEFAULT '[]',
  intensity TEXT DEFAULT 'moderate',
  notes TEXT,
  exercise_name TEXT,
  sets INTEGER,
  reps INTEGER,
  weight_lbs REAL,
  avg_heart_rate INTEGER,
  max_heart_rate INTEGER,
  min_heart_rate INTEGER,
  set_heart_rate TEXT DEFAULT '[]',
  rest_heart_rate TEXT DEFAULT '[]',
  workout_duration_seconds INTEGER,
  calories INTEGER,
  recovery_heart_rate INTEGER,
  category TEXT DEFAULT 'strength',
  watch_sync_id TEXT,
  watch_activity_type TEXT,
  watch_normalized_type TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lifts_user_id ON lifts(user_id);
CREATE INDEX IF NOT EXISTS idx_lifts_user_date ON lifts(user_id, date DESC);

CREATE TABLE IF NOT EXISTS training_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  week_start TEXT,
  plan_json TEXT,
  name TEXT,
  type TEXT,
  weeks INTEGER,
  description TEXT,
  plan_data JSONB,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_training_plans_user_id ON training_plans(user_id);

CREATE TABLE IF NOT EXISTS user_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
  started_at TEXT,
  current_week INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  progress_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS watch_sync (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
  synced_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS follows (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  follower_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(follower_id, following_id)
);

CREATE TABLE IF NOT EXISTS activity_feed (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id UUID,
  type TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS activity_likes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  activity_id UUID NOT NULL,
  activity_type TEXT DEFAULT 'feed',
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(activity_id, activity_type, user_id)
);

CREATE TABLE IF NOT EXISTS activity_comments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  activity_id UUID NOT NULL,
  activity_type TEXT DEFAULT 'feed',
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT,
  content TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, endpoint)
);
