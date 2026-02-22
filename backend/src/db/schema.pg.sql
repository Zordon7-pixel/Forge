-- FORGE PostgreSQL Schema
-- Converted from SQLite better-sqlite3

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
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

-- Create index on email for auth lookups
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Runs table
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
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for run queries
CREATE INDEX IF NOT EXISTS idx_runs_user_id ON runs(user_id);
CREATE INDEX IF NOT EXISTS idx_runs_user_date ON runs(user_id, date DESC);

-- Lifts table
CREATE TABLE IF NOT EXISTS lifts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  muscle_groups TEXT DEFAULT '[]',
  intensity TEXT DEFAULT 'moderate',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for lift queries
CREATE INDEX IF NOT EXISTS idx_lifts_user_id ON lifts(user_id);
CREATE INDEX IF NOT EXISTS idx_lifts_user_date ON lifts(user_id, date DESC);

-- Training plans table
CREATE TABLE IF NOT EXISTS training_plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Create index for plan queries
CREATE INDEX IF NOT EXISTS idx_training_plans_user_id ON training_plans(user_id);

-- Coach feedback table (for future use)
CREATE TABLE IF NOT EXISTS coach_feedback (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id UUID REFERENCES runs(id) ON DELETE SET NULL,
  lift_id UUID REFERENCES lifts(id) ON DELETE SET NULL,
  feedback_type TEXT,
  feedback_text TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Create index for coach feedback queries
CREATE INDEX IF NOT EXISTS idx_coach_feedback_user_id ON coach_feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_coach_feedback_run_id ON coach_feedback(run_id);
CREATE INDEX IF NOT EXISTS idx_coach_feedback_lift_id ON coach_feedback(lift_id);
