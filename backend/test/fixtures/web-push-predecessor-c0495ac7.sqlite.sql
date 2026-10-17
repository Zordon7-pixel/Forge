-- Immutable actual predecessor catalog at c0495ac747008004f416fe8391bdc020bd24d719.
-- backgroundSyncSchema.js SHA256 541509f1e163d40f5613c1a629f2dee26947e9657a9b3f1e59b1c1f76ddd31d4.
-- Generated only in guarded disposable databases; no account/provider data.
CREATE TABLE users (
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
  contact_discoverable INTEGER DEFAULT 0,
  planning_input_revision BIGINT NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  distance_miles REAL DEFAULT 0,
  duration_seconds INTEGER DEFAULT 0,
  perceived_effort INTEGER DEFAULT 5,
  notes TEXT,
  ai_feedback TEXT,
  ai_feedback_requested_at TEXT,
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
  workout_metric_streams_json TEXT DEFAULT '{}',
  plan_session_id TEXT,
  planned_session_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE user_notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  href TEXT,
  source_key TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, source_key)
);
CREATE TABLE schema_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT UNIQUE NOT NULL, executed_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE "strava_tokens"(id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
       access_token TEXT,refresh_token TEXT,expires_at BIGINT,athlete_id BIGINT,athlete_name TEXT,connected_at TEXT DEFAULT CURRENT_TIMESTAMP,
       connection_generation TEXT NOT NULL,token_revision BIGINT NOT NULL DEFAULT 1 CHECK(token_revision>=1),refresh_lease_token TEXT,refresh_lease_until TEXT,
       CHECK((refresh_lease_token IS NULL)=(refresh_lease_until IS NULL)));
CREATE TABLE "push_subscriptions"(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       endpoint TEXT NOT NULL,keys_p256dh TEXT NOT NULL,keys_auth TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,
       active INTEGER NOT NULL DEFAULT 0 CHECK(active IN(0,1)),generation TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
       disclosure TEXT NOT NULL DEFAULT 'GENERIC' CHECK(disclosure IN('GENERIC','SAVED_RUN')),UNIQUE(user_id,endpoint));
CREATE TABLE background_sync_control (
 id TEXT PRIMARY KEY CHECK(id='strava'),
 activation_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 eligibility_bootstrapped INTEGER NOT NULL DEFAULT 0 CHECK(eligibility_bootstrapped IN(0,1)),
 paused INTEGER NOT NULL DEFAULT 0 CHECK(paused IN(0,1)),
 next_allowed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 quarter_start TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 quarter_used INTEGER NOT NULL DEFAULT 0 CHECK(quarter_used>=0),
 day_start TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 day_used INTEGER NOT NULL DEFAULT 0 CHECK(day_used>=0)
, observed_quarter_cap INTEGER CONSTRAINT bg_provider_quarter_cap CHECK(observed_quarter_cap IS NULL OR (typeof(observed_quarter_cap)='integer' AND observed_quarter_cap BETWEEN 1 AND 60)), observed_day_cap INTEGER CONSTRAINT bg_provider_day_cap CHECK(observed_day_cap IS NULL OR (typeof(observed_day_cap)='integer' AND observed_day_cap BETWEEN 1 AND 600)), provider_limits_epoch INTEGER NOT NULL DEFAULT 1 CONSTRAINT bg_provider_limits_epoch CHECK((typeof(provider_limits_epoch)='integer' AND provider_limits_epoch BETWEEN 1 AND 9000000000000000)));
CREATE TABLE strava_ingress_bindings (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL UNIQUE,
 athlete_id TEXT NOT NULL UNIQUE CHECK((length(athlete_id) BETWEEN 1 AND 30 AND athlete_id NOT GLOB '*[^0-9]*')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
 -- Deliberately NO FK to users/tokens. Guard/cleanup triggers below are mandatory.
);
CREATE TABLE provider_activity_links (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider TEXT NOT NULL CHECK(provider='strava'),
 object_id TEXT NOT NULL CHECK((length(object_id) BETWEEN 1 AND 30 AND object_id NOT GLOB '*[^0-9]*')),
 run_id TEXT,
 state TEXT NOT NULL CHECK(state IN('ACTIVE','PROVIDER_UNAVAILABLE','USER_DELETED')),
 legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN(0,1)),
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(user_id,provider,object_id),
 FOREIGN KEY(user_id,run_id) REFERENCES runs(user_id,id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
 CHECK(state<>'USER_DELETED' OR run_id IS NULL)
);
CREATE TABLE run_save_eligibility (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL,
 eligible INTEGER NOT NULL CHECK(eligible IN(0,1)),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 reason TEXT NOT NULL CHECK(reason IN('LEGACY','NEW_AFTER_ACTIVATION','LATE_HISTORICAL','UNKNOWN_START')),
 PRIMARY KEY(user_id,run_id),
 FOREIGN KEY(user_id,run_id) REFERENCES runs(user_id,id) ON DELETE CASCADE,
 CHECK(eligible=(reason='NEW_AFTER_ACTIVATION'))
);
CREATE TABLE activity_notification_events (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 run_id TEXT,
 notification_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('ACTIVE','MERGED','CANCELLED')),
 merged_into TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(user_id,id), UNIQUE(user_id,id,notification_id),
 FOREIGN KEY(user_id,run_id) REFERENCES runs(user_id,id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(user_id,notification_id) REFERENCES user_notifications(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,merged_into) REFERENCES activity_notification_events(user_id,id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
 CHECK((state='ACTIVE' AND run_id IS NOT NULL AND merged_into IS NULL)
 OR (state='MERGED' AND run_id IS NULL AND merged_into IS NOT NULL AND merged_into<>id)
 OR (state='CANCELLED' AND run_id IS NULL AND merged_into IS NULL))
);
CREATE TABLE web_push_claims (
 endpoint_hash TEXT PRIMARY KEY CHECK((length(endpoint_hash)=64 AND endpoint_hash NOT GLOB '*[^a-f0-9]*')),
 claim_revision BIGINT NOT NULL DEFAULT 0 CHECK(claim_revision>=0),
 proof_hash TEXT NOT NULL CHECK((length(proof_hash)=64 AND proof_hash NOT GLOB '*[^a-f0-9]*')),
 subscription_id TEXT UNIQUE REFERENCES push_subscriptions(id) ON DELETE SET NULL,
 last_operation_id TEXT,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE web_push_challenges (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 subscription_id TEXT NOT NULL,
 proof_hash TEXT NOT NULL CHECK((length(proof_hash)=64 AND proof_hash NOT GLOB '*[^a-f0-9]*')),
 expected_revision BIGINT NOT NULL CHECK(expected_revision>=0),
 operation_id TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 consumed_at TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(user_id,subscription_id) REFERENCES push_subscriptions(user_id,id) ON DELETE CASCADE,
 UNIQUE(user_id,operation_id),
 CHECK(expires_at>created_at)
);
CREATE TABLE notification_deliveries (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL, notification_id TEXT NOT NULL,
 transport TEXT NOT NULL CHECK(transport='WEB_PUSH'),
 target_id TEXT NOT NULL,
 target_generation TEXT NOT NULL,
 disclosure TEXT NOT NULL CHECK(disclosure IN('GENERIC','SAVED_RUN')),
 state TEXT NOT NULL CHECK(state IN('PENDING','LEASED','RETRY','ACCEPTED','CANCELLED','DEAD','EXPIRED')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at TEXT NOT NULL,
 lease_token TEXT, lease_until TEXT,
 accepted_at TEXT, transport_receipt_id TEXT, last_error_code TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(event_id,transport,target_id,target_generation),
 FOREIGN KEY(user_id,event_id,notification_id) REFERENCES activity_notification_events(user_id,id,notification_id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,target_id) REFERENCES push_subscriptions(user_id,id) ON DELETE CASCADE,
 CHECK((state='LEASED')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK(state='LEASED' OR (lease_token IS NULL AND lease_until IS NULL)),
 CHECK((state='ACCEPTED')=(accepted_at IS NOT NULL)),
 CHECK(expires_at>created_at),
 CHECK(last_error_code IS NULL OR length(last_error_code)<=80)
);
CREATE TABLE web_push_setup_operations (
 challenge_id TEXT PRIMARY KEY REFERENCES web_push_challenges(id) ON DELETE CASCADE,
 endpoint_hash BLOB NOT NULL CHECK(length(endpoint_hash)=32),
 client_nonce_hash BLOB NOT NULL CHECK(length(client_nonce_hash)=32),
 session_hash BLOB NOT NULL CHECK(length(session_hash)=32),
 request_hash BLOB NOT NULL CHECK(length(request_hash)=32),
 auth_epoch TEXT NOT NULL CHECK(length(auth_epoch)=36),
 send_state TEXT NOT NULL DEFAULT 'RESERVED'
   CHECK(send_state IN ('RESERVED','ATTEMPTED','ACCEPTED','FAILED','UNKNOWN')),
 send_attempted_at_ms BIGINT,
 cancelled_at_ms BIGINT,
 handoff_hash BLOB CHECK(handoff_hash IS NULL OR length(handoff_hash)=32),
 handoff_client_id TEXT CHECK(handoff_client_id IS NULL OR length(handoff_client_id) BETWEEN 1 AND 256),
 handoff_until_ms BIGINT,
 handoff_consumed_at_ms BIGINT,
 handoff_count INTEGER NOT NULL DEFAULT 0 CHECK(handoff_count BETWEEN 0 AND 3),
 failed_confirm_count INTEGER NOT NULL DEFAULT 0 CHECK(failed_confirm_count BETWEEN 0 AND 5),
 confirm_hash BLOB CHECK(confirm_hash IS NULL OR length(confirm_hash)=32),
 result_generation TEXT,
 result_revision BIGINT CHECK(result_revision IS NULL OR result_revision>=1),
 retain_until_ms BIGINT NOT NULL CHECK(retain_until_ms>0),
 CHECK((send_state='RESERVED' AND send_attempted_at_ms IS NULL)
    OR (send_state<>'RESERVED' AND send_attempted_at_ms IS NOT NULL)),
 CHECK((handoff_hash IS NULL AND handoff_client_id IS NULL AND handoff_until_ms IS NULL AND handoff_consumed_at_ms IS NULL)
    OR (handoff_hash IS NOT NULL AND handoff_client_id IS NOT NULL AND handoff_until_ms IS NOT NULL)),
 CHECK((confirm_hash IS NULL AND result_generation IS NULL AND result_revision IS NULL)
    OR (confirm_hash IS NOT NULL AND result_generation IS NOT NULL AND result_revision IS NOT NULL))
);
CREATE TABLE web_push_setup_rate_buckets (
 dimension TEXT NOT NULL CHECK(dimension IN ('GLOBAL','USER','ENDPOINT','IP')),
 key_hash BLOB NOT NULL CHECK(length(key_hash)=32),
 window_start_ms BIGINT NOT NULL CHECK(window_start_ms>=0 AND window_start_ms%600000=0),
 used_count INTEGER NOT NULL CHECK(used_count BETWEEN 1 AND 100),
 PRIMARY KEY(dimension,key_hash,window_start_ms)
);
CREATE TABLE strava_connection_fences (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 epoch TEXT NOT NULL CHECK (length(epoch) = 64 AND epoch NOT GLOB '*[^0-9a-f]*')
);
CREATE TABLE "provider_event_jobs" (
 id TEXT PRIMARY KEY,
 binding_id TEXT NOT NULL REFERENCES strava_ingress_bindings(id) ON DELETE CASCADE,
 object_type TEXT NOT NULL CHECK(object_type IN('activity','athlete')),
 object_id TEXT NOT NULL CHECK((length(object_id) BETWEEN 1 AND 30 AND object_id NOT GLOB '*[^0-9]*')),
 last_fingerprint TEXT NOT NULL CHECK((length(last_fingerprint)=64 AND last_fingerprint NOT GLOB '*[^a-f0-9]*')),
 reported_event_time BIGINT NOT NULL CHECK(reported_event_time>=0),
 last_aspect TEXT NOT NULL CHECK(last_aspect IN('create','update','delete')),
 requested_revision BIGINT NOT NULL DEFAULT 1 CHECK(requested_revision BETWEEN 1 AND 9000000000000000),
 processed_revision BIGINT NOT NULL DEFAULT 0 CHECK(processed_revision>=0 AND processed_revision<=requested_revision),
 state TEXT NOT NULL CHECK(state IN('PENDING','LEASED','RETRY','DONE','DEAD')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 available_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 lease_token TEXT, lease_until TEXT, leased_revision BIGINT,
 last_fetch_at TEXT, last_error_code TEXT,
 first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 episode_started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CONSTRAINT bg_jobs_episode_finite CHECK(typeof(episode_started_at)='text' AND julianday(episode_started_at) IS NOT NULL),
 UNIQUE(binding_id,object_type,object_id),
 CHECK((state='LEASED')=(lease_token IS NOT NULL AND lease_until IS NOT NULL AND leased_revision IS NOT NULL)),
 CHECK(state='LEASED' OR (lease_token IS NULL AND lease_until IS NULL AND leased_revision IS NULL)),
 CHECK(leased_revision IS NULL OR leased_revision BETWEEN 1 AND requested_revision),
 CHECK(last_error_code IS NULL OR length(last_error_code)<=80));
CREATE UNIQUE INDEX strava_unique_athlete ON strava_tokens(athlete_id) WHERE athlete_id IS NOT NULL;
CREATE UNIQUE INDEX runs_owned_key ON runs(user_id,id);
CREATE UNIQUE INDEX inbox_owned_key ON user_notifications(user_id,id);
CREATE UNIQUE INDEX bg_active_run_notice ON activity_notification_events(user_id,run_id) WHERE state='ACTIVE';
CREATE UNIQUE INDEX bg_active_endpoint ON push_subscriptions(endpoint) WHERE active;
CREATE UNIQUE INDEX bg_push_owned_key ON push_subscriptions(user_id,id);
CREATE INDEX bg_delivery_due ON notification_deliveries(state,available_at,id);
CREATE TRIGGER bg_binding_insert BEFORE INSERT ON strava_ingress_bindings BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) THEN RAISE(ABORT,'owner absent') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM strava_tokens WHERE user_id=NEW.user_id AND connection_generation=NEW.id AND CAST(athlete_id AS TEXT)=NEW.athlete_id) THEN RAISE(ABORT,'connection absent') END;
END;
CREATE TRIGGER bg_binding_update BEFORE UPDATE ON strava_ingress_bindings BEGIN
 SELECT CASE WHEN NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.athlete_id<>OLD.athlete_id THEN RAISE(ABORT,'binding immutable') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id) THEN RAISE(ABORT,'owner absent') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM strava_tokens WHERE user_id=NEW.user_id AND connection_generation=NEW.id AND CAST(athlete_id AS TEXT)=NEW.athlete_id) THEN RAISE(ABORT,'connection absent') END;
END;
CREATE TRIGGER bg_token_delete BEFORE DELETE ON strava_tokens BEGIN
 DELETE FROM strava_ingress_bindings WHERE id=OLD.connection_generation AND user_id=OLD.user_id;
END;
CREATE TRIGGER bg_token_update BEFORE UPDATE OF connection_generation,athlete_id ON strava_tokens
 WHEN NEW.connection_generation<>OLD.connection_generation OR NEW.athlete_id IS NOT OLD.athlete_id BEGIN
 DELETE FROM strava_ingress_bindings WHERE id=OLD.connection_generation AND user_id=OLD.user_id;
END;
CREATE TRIGGER bg_user_delete BEFORE DELETE ON users BEGIN
 DELETE FROM strava_ingress_bindings WHERE user_id=OLD.id;
END;
CREATE TRIGGER bg_target_delete BEFORE DELETE ON push_subscriptions BEGIN
 DELETE FROM web_push_claims WHERE subscription_id=OLD.id;
END;
CREATE TRIGGER bg_activation_immutable BEFORE UPDATE ON background_sync_control
 WHEN NEW.activation_at IS NOT OLD.activation_at OR (OLD.eligibility_bootstrapped=1 AND NEW.eligibility_bootstrapped<>1)
 BEGIN SELECT RAISE(ABORT,'background activation immutable'); END;
CREATE TRIGGER bg_activation_no_delete BEFORE DELETE ON background_sync_control
 BEGIN SELECT RAISE(ABORT,'background activation immutable'); END;
CREATE INDEX bg_jobs_due ON provider_event_jobs(state,available_at,id);
INSERT INTO schema_migrations(id,version,executed_at) VALUES(1,'background-sync-v2-v3','2026-10-01 12:31:42');
INSERT INTO schema_migrations(id,version,executed_at) VALUES(2,'background-sync-strava-fence-v1','2026-10-01 12:31:42');
INSERT INTO schema_migrations(id,version,executed_at) VALUES(3,'background-sync-provider-limits-v1','2026-10-01 12:31:42');
INSERT INTO schema_migrations(id,version,executed_at) VALUES(4,'background-sync-event-episode-v1','2026-10-01 12:31:42');
INSERT INTO background_sync_control(id,activation_at,eligibility_bootstrapped,paused,next_allowed_at,quarter_start,quarter_used,day_start,day_used,observed_quarter_cap,observed_day_cap,provider_limits_epoch) VALUES('strava','2026-10-01 12:31:42',1,0,'2026-10-01 12:31:42','2026-10-01 12:31:42',0,'2026-10-01 12:31:42',0,NULL,NULL,1);
