-- FORGE PostgreSQL Schema
-- Converted from SQLite better-sqlite3

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
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  subscription_status TEXT DEFAULT 'free',
  subscription_ends_at TEXT,
  friend_handle TEXT,
  friend_discoverable INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_friend_handle_lower ON users (LOWER(friend_handle)) WHERE friend_handle IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_consents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  consent_type TEXT NOT NULL DEFAULT 'medical_waiver',
  version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  ip TEXT,
  UNIQUE(user_id, consent_type, version)
);

CREATE INDEX IF NOT EXISTS idx_user_consents_user_type ON user_consents(user_id, consent_type);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  distance_miles REAL DEFAULT 0,
  duration_seconds INTEGER DEFAULT 0,
  perceived_effort INTEGER DEFAULT 5,
  notes TEXT,
  ai_feedback TEXT,
  ai_feedback_requested_at TIMESTAMPTZ,
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
  pain_level TEXT,
  post_energy TEXT,
  treadmill_brand TEXT,
  treadmill_model TEXT,
  watch_mode TEXT,
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
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_runs_user_id ON runs(user_id);
CREATE INDEX IF NOT EXISTS idx_runs_user_date ON runs(user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_runs_health_source_workout ON runs(user_id, health_source, health_source_workout_id);

CREATE TABLE IF NOT EXISTS run_import_tombstones (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_key TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, source_key)
);

CREATE INDEX IF NOT EXISTS idx_run_import_tombstones_user ON run_import_tombstones(user_id);

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
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_shoe_catalog_brand_model ON shoe_catalog(LOWER(brand), LOWER(model));

CREATE TABLE IF NOT EXISTS gear_shoes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  nickname TEXT,
  color TEXT,
  purchase_date TEXT,
  category TEXT DEFAULT 'daily_trainer',
  surface TEXT DEFAULT 'road',
  intent_tags TEXT DEFAULT '[]',
  wet_ok INTEGER,
  cushion TEXT,
  catalog_id TEXT REFERENCES shoe_catalog(id) ON DELETE SET NULL,
  recommended_miles INTEGER DEFAULT 450,
  is_retired INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gear_shoes_user ON gear_shoes(user_id);
CREATE INDEX IF NOT EXISTS idx_gear_shoes_catalog_id ON gear_shoes(catalog_id);

CREATE TABLE IF NOT EXISTS user_hr_profile (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  max_hr INTEGER,
  resting_hr INTEGER,
  lthr INTEGER,
  custom_zones_json TEXT DEFAULT '[]',
  zone_model TEXT NOT NULL DEFAULT 'hrr',
  source TEXT NOT NULL DEFAULT 'manual',
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lifts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
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
  start_date TEXT,
  end_date TEXT,
  is_seasonal INTEGER DEFAULT 0,
  creator_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'system' CHECK (kind IN ('system', 'personal', 'social')),
  visibility TEXT NOT NULL DEFAULT 'system' CHECK (visibility IN ('system', 'personal', 'private', 'friends')),
  template_type TEXT CHECK (template_type IS NULL OR template_type IN ('running_distance', 'running_time', 'running_consistency', 'strength_consistency', 'hybrid_balance')),
  run_target REAL,
  run_unit TEXT,
  lift_target REAL,
  lift_unit TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  verification_policy TEXT NOT NULL DEFAULT 'all_activity' CHECK (verification_policy IN ('all_activity', 'device_only')),
  participant_limit INTEGER NOT NULL DEFAULT 25 CHECK (participant_limit BETWEEN 2 AND 50),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_challenges_social_status ON challenges(kind, visibility, status, start_date, end_date);

CREATE TABLE IF NOT EXISTS user_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  challenge_id TEXT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  progress REAL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  status TEXT NOT NULL DEFAULT 'joined' CHECK (status IN ('invited', 'joined', 'declined', 'left', 'removed')),
  notifications_muted INTEGER NOT NULL DEFAULT 0,
  invited_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  joined_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  left_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  UNIQUE(user_id, challenge_id)
);

CREATE INDEX IF NOT EXISTS idx_user_challenges_challenge_status ON user_challenges(challenge_id, status);
CREATE INDEX IF NOT EXISTS idx_user_challenges_user_status ON user_challenges(user_id, status);

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
);

CREATE INDEX IF NOT EXISTS idx_group_runs_owner_status_start ON group_runs(owner_id, status, starts_at);
CREATE INDEX IF NOT EXISTS idx_group_runs_status_start ON group_runs(status, starts_at);

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
);

CREATE INDEX IF NOT EXISTS idx_group_run_members_run_status ON group_run_members(group_run_id, status);
CREATE INDEX IF NOT EXISTS idx_group_run_members_user_status ON group_run_members(user_id, status);

CREATE TABLE IF NOT EXISTS app_feedback (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  type TEXT DEFAULT 'bug',
  message TEXT NOT NULL,
  page TEXT,
  severity TEXT,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  assigned_to TEXT,
  support_note TEXT,
  linked_ref TEXT,
  reviewed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'bug';
ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS page TEXT;
ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS severity TEXT;
ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new';
ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS assigned_to TEXT;
ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS support_note TEXT;
ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS linked_ref TEXT;
ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE app_feedback ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS idx_app_feedback_user_created ON app_feedback(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_feedback_status_created ON app_feedback(status, created_at DESC);

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
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_exercise_image_requests_status_seen
  ON exercise_image_requests(status, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS training_plans (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
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
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES training_plans(id) ON DELETE CASCADE,
  started_at TEXT,
  current_week INTEGER DEFAULT 1,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  progress_json TEXT DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS watch_sync (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
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
  raw_payload TEXT,
  synced_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_watch_sync_user_garmin_id ON watch_sync(user_id, garmin_activity_id);

CREATE TABLE IF NOT EXISTS health_sync (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
  synced_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_settings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, key)
);

CREATE TABLE IF NOT EXISTS garmin_sleep (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  calendar_date TEXT NOT NULL,
  sleep_start_gmt TIMESTAMPTZ,
  sleep_end_gmt TIMESTAMPTZ,
  deep_sleep_seconds INTEGER,
  light_sleep_seconds INTEGER,
  rem_sleep_seconds INTEGER,
  awake_seconds INTEGER,
  unmeasurable_seconds INTEGER,
  confirmation_type TEXT,
  retro INTEGER DEFAULT 0,
  synced_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_garmin_sleep_user_date ON garmin_sleep(user_id, calendar_date);
CREATE INDEX IF NOT EXISTS idx_garmin_sleep_user_synced ON garmin_sleep(user_id, synced_at DESC);

CREATE TABLE IF NOT EXISTS follows (
  id TEXT PRIMARY KEY,
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  following_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(follower_id, following_id)
);

CREATE TABLE IF NOT EXISTS friendships (
  id TEXT PRIMARY KEY,
  requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_low_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'removed')),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  responded_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CHECK (requester_id <> addressee_id),
  CHECK (user_low_id = LEAST(requester_id, addressee_id)),
  CHECK (user_high_id = GREATEST(requester_id, addressee_id)),
  UNIQUE(user_low_id, user_high_id)
);

CREATE INDEX IF NOT EXISTS idx_friendships_requester_status ON friendships(requester_id, status);
CREATE INDEX IF NOT EXISTS idx_friendships_addressee_status ON friendships(addressee_id, status);

CREATE TABLE IF NOT EXISTS friend_invites (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (char_length(token_hash) = 64),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  consumed_by_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_friend_invites_owner_active ON friend_invites(owner_id, expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS user_blocks (
  id TEXT PRIMARY KEY,
  blocker_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CHECK (blocker_id <> blocked_id),
  UNIQUE(blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id);

CREATE TABLE IF NOT EXISTS social_reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  subject_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  category TEXT NOT NULL CHECK (category IN ('harassment', 'spam', 'impersonation', 'unsafe_content', 'other')),
  context_type TEXT NOT NULL CHECK (context_type IN ('profile', 'friendship', 'challenge', 'activity')),
  context_id TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'closed')),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  reviewed_at TIMESTAMPTZ,
  reviewed_by_id TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_social_reports_status_created ON social_reports(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_reports_reporter ON social_reports(reporter_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_reports_subject ON social_reports(subject_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS activity_feed (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shop_id TEXT,
  type TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  props JSONB,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_events_user_created_at ON events(user_id, created_at);

CREATE TABLE IF NOT EXISTS activity_media (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL,
  activity_type TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  mime_type TEXT DEFAULT 'image/jpeg',
  visibility TEXT NOT NULL DEFAULT 'private',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_activity_media_owner_activity ON activity_media(user_id, activity_type, activity_id);

CREATE TABLE IF NOT EXISTS activity_likes (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL,
  activity_type TEXT DEFAULT 'feed',
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(activity_id, activity_type, user_id)
);

CREATE TABLE IF NOT EXISTS activity_comments (
  id TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL,
  activity_type TEXT DEFAULT 'feed',
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT,
  content TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  keys_p256dh TEXT NOT NULL,
  keys_auth TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, endpoint)
);

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
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, checkin_date)
);

CREATE TABLE IF NOT EXISTS readiness_scores (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score_date TEXT NOT NULL,
  score INTEGER NOT NULL,
  band TEXT NOT NULL,
  drivers JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, score_date)
);

CREATE INDEX IF NOT EXISTS idx_readiness_scores_user_date ON readiness_scores(user_id, score_date DESC);

CREATE TABLE IF NOT EXISTS checkin_overrides (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  action TEXT NOT NULL,
  patch_json TEXT DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, date)
);

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
);

CREATE INDEX IF NOT EXISTS idx_plan_adjustment_proposals_user_status ON plan_adjustment_proposals(user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_adjustment_proposals_pending ON plan_adjustment_proposals(user_id, planning_date, plan_version) WHERE status='pending';

CREATE TABLE IF NOT EXISTS comp_codes (
  code TEXT PRIMARY KEY,
  max_redemptions INTEGER DEFAULT 1,
  redeemed_count INTEGER DEFAULT 0,
  grants_until TEXT,
  active INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS comp_redemptions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL REFERENCES comp_codes(code) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(code, user_id)
);

CREATE INDEX IF NOT EXISTS idx_comp_redemptions_user ON comp_redemptions(user_id);
