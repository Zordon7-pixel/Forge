-- Immutable actual predecessor catalog at c0495ac747008004f416fe8391bdc020bd24d719.
-- backgroundSyncSchema.js SHA256 541509f1e163d40f5613c1a629f2dee26947e9657a9b3f1e59b1c1f76ddd31d4.
-- Generated only in guarded disposable databases; no account/provider data.
-- Restore sequence state captured from the same frozen predecessor producer.
--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11 (Homebrew)
-- Dumped by pg_dump version 17.11 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: bg_activation_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bg_activation_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.activation_at IS DISTINCT FROM OLD.activation_at
   OR (OLD.eligibility_bootstrapped AND NOT NEW.eligibility_bootstrapped) THEN
  RAISE EXCEPTION 'background activation immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;


--
-- Name: bg_binding_owner_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bg_binding_owner_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='UPDATE' AND (NEW.id<>OLD.id OR NEW.user_id<>OLD.user_id OR NEW.athlete_id<>OLD.athlete_id) THEN
  RAISE EXCEPTION 'binding immutable' USING ERRCODE='23514';
 END IF;
 PERFORM 1 FROM users WHERE id=NEW.user_id FOR KEY SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'owner absent' USING ERRCODE='23503'; END IF;
 PERFORM 1 FROM strava_tokens WHERE user_id=NEW.user_id
  AND connection_generation=NEW.id AND athlete_id::text=NEW.athlete_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'connection absent' USING ERRCODE='23503'; END IF;
 RETURN NEW;
END $$;


--
-- Name: bg_delete_target_claim(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bg_delete_target_claim() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 DELETE FROM web_push_claims WHERE subscription_id=OLD.id;
 RETURN OLD;
END $$;


--
-- Name: bg_erase_user_binding(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bg_erase_user_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 DELETE FROM strava_ingress_bindings WHERE user_id=OLD.id;
 RETURN OLD;
END $$;


--
-- Name: bg_retire_token_binding(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.bg_retire_token_binding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM strava_ingress_bindings WHERE id=OLD.connection_generation AND user_id=OLD.user_id;
  RETURN OLD;
 END IF;
 IF NEW.connection_generation<>OLD.connection_generation OR NEW.athlete_id IS DISTINCT FROM OLD.athlete_id THEN
  DELETE FROM strava_ingress_bindings WHERE id=OLD.connection_generation AND user_id=OLD.user_id;
 END IF;
 RETURN NEW;
END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: activity_notification_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activity_notification_events (
    id text NOT NULL,
    user_id text NOT NULL,
    run_id text,
    notification_id text NOT NULL,
    state text NOT NULL,
    merged_into text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT activity_notification_events_check CHECK ((((state = 'ACTIVE'::text) AND (run_id IS NOT NULL) AND (merged_into IS NULL)) OR ((state = 'MERGED'::text) AND (run_id IS NULL) AND (merged_into IS NOT NULL) AND (merged_into <> id)) OR ((state = 'CANCELLED'::text) AND (run_id IS NULL) AND (merged_into IS NULL)))),
    CONSTRAINT activity_notification_events_state_check CHECK ((state = ANY (ARRAY['ACTIVE'::text, 'MERGED'::text, 'CANCELLED'::text])))
);


--
-- Name: background_sync_control; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.background_sync_control (
    id text NOT NULL,
    activation_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    eligibility_bootstrapped boolean DEFAULT false NOT NULL,
    paused boolean DEFAULT false NOT NULL,
    next_allowed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    quarter_start timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    quarter_used integer DEFAULT 0 NOT NULL,
    day_start timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    day_used integer DEFAULT 0 NOT NULL,
    observed_quarter_cap integer,
    observed_day_cap integer,
    provider_limits_epoch bigint DEFAULT 1 NOT NULL,
    CONSTRAINT background_sync_control_day_used_check CHECK ((day_used >= 0)),
    CONSTRAINT background_sync_control_id_check CHECK ((id = 'strava'::text)),
    CONSTRAINT background_sync_control_quarter_used_check CHECK ((quarter_used >= 0)),
    CONSTRAINT bg_provider_day_cap CHECK (((observed_day_cap >= 1) AND (observed_day_cap <= 600))),
    CONSTRAINT bg_provider_limits_epoch CHECK (((provider_limits_epoch >= 1) AND (provider_limits_epoch <= '9000000000000000'::bigint))),
    CONSTRAINT bg_provider_quarter_cap CHECK (((observed_quarter_cap >= 1) AND (observed_quarter_cap <= 60)))
);


--
-- Name: notification_deliveries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_deliveries (
    id text NOT NULL,
    user_id text NOT NULL,
    event_id text NOT NULL,
    notification_id text NOT NULL,
    transport text NOT NULL,
    target_id text NOT NULL,
    target_generation text NOT NULL,
    disclosure text NOT NULL,
    state text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    lease_token text,
    lease_until timestamp with time zone,
    accepted_at timestamp with time zone,
    transport_receipt_id text,
    last_error_code text,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT notification_deliveries_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT notification_deliveries_check CHECK (((state = 'LEASED'::text) = ((lease_token IS NOT NULL) AND (lease_until IS NOT NULL)))),
    CONSTRAINT notification_deliveries_check1 CHECK (((state = 'LEASED'::text) OR ((lease_token IS NULL) AND (lease_until IS NULL)))),
    CONSTRAINT notification_deliveries_check2 CHECK (((state = 'ACCEPTED'::text) = (accepted_at IS NOT NULL))),
    CONSTRAINT notification_deliveries_check3 CHECK ((expires_at > created_at)),
    CONSTRAINT notification_deliveries_disclosure_check CHECK ((disclosure = ANY (ARRAY['GENERIC'::text, 'SAVED_RUN'::text]))),
    CONSTRAINT notification_deliveries_last_error_code_check CHECK (((last_error_code IS NULL) OR (length(last_error_code) <= 80))),
    CONSTRAINT notification_deliveries_state_check CHECK ((state = ANY (ARRAY['PENDING'::text, 'LEASED'::text, 'RETRY'::text, 'ACCEPTED'::text, 'CANCELLED'::text, 'DEAD'::text, 'EXPIRED'::text]))),
    CONSTRAINT notification_deliveries_transport_check CHECK ((transport = 'WEB_PUSH'::text))
);


--
-- Name: provider_activity_links; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_activity_links (
    user_id text NOT NULL,
    provider text NOT NULL,
    object_id text NOT NULL,
    run_id text,
    state text NOT NULL,
    legacy boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT provider_activity_links_check CHECK (((state <> 'USER_DELETED'::text) OR (run_id IS NULL))),
    CONSTRAINT provider_activity_links_object_id_check CHECK ((object_id ~ '^[0-9]{1,30}$'::text)),
    CONSTRAINT provider_activity_links_provider_check CHECK ((provider = 'strava'::text)),
    CONSTRAINT provider_activity_links_state_check CHECK ((state = ANY (ARRAY['ACTIVE'::text, 'PROVIDER_UNAVAILABLE'::text, 'USER_DELETED'::text])))
);


--
-- Name: provider_event_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_event_jobs (
    id text NOT NULL,
    binding_id text NOT NULL,
    object_type text NOT NULL,
    object_id text NOT NULL,
    last_fingerprint text NOT NULL,
    reported_event_time bigint NOT NULL,
    last_aspect text NOT NULL,
    requested_revision bigint DEFAULT 1 NOT NULL,
    processed_revision bigint DEFAULT 0 NOT NULL,
    state text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    lease_token text,
    lease_until timestamp with time zone,
    leased_revision bigint,
    last_fetch_at timestamp with time zone,
    last_error_code text,
    first_seen_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    episode_started_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT bg_jobs_episode_finite CHECK (isfinite(episode_started_at)),
    CONSTRAINT provider_event_jobs_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT provider_event_jobs_check CHECK (((processed_revision >= 0) AND (processed_revision <= requested_revision))),
    CONSTRAINT provider_event_jobs_check1 CHECK (((state = 'LEASED'::text) = ((lease_token IS NOT NULL) AND (lease_until IS NOT NULL) AND (leased_revision IS NOT NULL)))),
    CONSTRAINT provider_event_jobs_check2 CHECK (((state = 'LEASED'::text) OR ((lease_token IS NULL) AND (lease_until IS NULL) AND (leased_revision IS NULL)))),
    CONSTRAINT provider_event_jobs_check3 CHECK (((leased_revision IS NULL) OR ((leased_revision >= 1) AND (leased_revision <= requested_revision)))),
    CONSTRAINT provider_event_jobs_last_aspect_check CHECK ((last_aspect = ANY (ARRAY['create'::text, 'update'::text, 'delete'::text]))),
    CONSTRAINT provider_event_jobs_last_error_code_check CHECK (((last_error_code IS NULL) OR (length(last_error_code) <= 80))),
    CONSTRAINT provider_event_jobs_last_fingerprint_check CHECK ((last_fingerprint ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT provider_event_jobs_object_id_check CHECK ((object_id ~ '^[0-9]{1,30}$'::text)),
    CONSTRAINT provider_event_jobs_object_type_check CHECK ((object_type = ANY (ARRAY['activity'::text, 'athlete'::text]))),
    CONSTRAINT provider_event_jobs_reported_event_time_check CHECK ((reported_event_time >= 0)),
    CONSTRAINT provider_event_jobs_requested_revision_check CHECK (((requested_revision >= 1) AND (requested_revision <= '9000000000000000'::bigint))),
    CONSTRAINT provider_event_jobs_state_check CHECK ((state = ANY (ARRAY['PENDING'::text, 'LEASED'::text, 'RETRY'::text, 'DONE'::text, 'DEAD'::text])))
);


--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscriptions (
    id text NOT NULL,
    user_id text NOT NULL,
    endpoint text NOT NULL,
    keys_p256dh text NOT NULL,
    keys_auth text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    active boolean DEFAULT false NOT NULL,
    generation text DEFAULT (gen_random_uuid())::text NOT NULL,
    disclosure text DEFAULT 'GENERIC'::text NOT NULL,
    CONSTRAINT bg_disclosure CHECK ((disclosure = ANY (ARRAY['GENERIC'::text, 'SAVED_RUN'::text])))
);


--
-- Name: run_save_eligibility; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.run_save_eligibility (
    user_id text NOT NULL,
    run_id text NOT NULL,
    eligible boolean NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    reason text NOT NULL,
    CONSTRAINT run_save_eligibility_check CHECK ((eligible = (reason = 'NEW_AFTER_ACTIVATION'::text))),
    CONSTRAINT run_save_eligibility_reason_check CHECK ((reason = ANY (ARRAY['LEGACY'::text, 'NEW_AFTER_ACTIVATION'::text, 'LATE_HISTORICAL'::text, 'UNKNOWN_START'::text])))
);


--
-- Name: runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.runs (
    id text NOT NULL,
    user_id text NOT NULL,
    date text NOT NULL,
    type text NOT NULL,
    distance_miles real DEFAULT 0,
    duration_seconds integer DEFAULT 0,
    perceived_effort integer DEFAULT 5,
    notes text,
    ai_feedback text,
    ai_feedback_requested_at timestamp with time zone,
    run_surface text DEFAULT 'road'::text,
    surface text DEFAULT 'road'::text,
    incline_pct real DEFAULT 0,
    treadmill_speed real DEFAULT 0,
    route_coords text DEFAULT '[]'::text,
    avg_heart_rate integer,
    max_heart_rate integer,
    min_heart_rate integer,
    heart_rate_zones text DEFAULT '[]'::text,
    cadence_spm real,
    elevation_gain real,
    elevation_loss real,
    pace_avg real,
    pace_splits text DEFAULT '[]'::text,
    vo2_max real,
    training_effect_aerobic real,
    training_effect_anaerobic real,
    recovery_time_hours real,
    detected_surface_type text,
    temperature_f real,
    calories integer DEFAULT 0,
    pain_level text,
    post_energy text,
    treadmill_brand text,
    treadmill_model text,
    watch_mode text,
    watch_sync_id text,
    watch_activity_type text,
    watch_normalized_type text,
    health_source text,
    health_source_workout_id text,
    health_start_at text,
    health_end_at text,
    workout_metrics_json text DEFAULT '{}'::text,
    workout_metric_streams_json text DEFAULT '{}'::text,
    plan_session_id text,
    planned_session_json text DEFAULT '{}'::text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    id integer NOT NULL,
    version text NOT NULL,
    executed_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: schema_migrations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.schema_migrations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: schema_migrations_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.schema_migrations_id_seq OWNED BY public.schema_migrations.id;


--
-- Name: strava_connection_fences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.strava_connection_fences (
    user_id text NOT NULL,
    epoch text NOT NULL,
    CONSTRAINT strava_connection_fences_epoch_check CHECK ((epoch ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: strava_ingress_bindings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.strava_ingress_bindings (
    id text NOT NULL,
    user_id text NOT NULL,
    athlete_id text NOT NULL,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT strava_ingress_bindings_athlete_id_check CHECK ((athlete_id ~ '^[0-9]{1,30}$'::text))
);


--
-- Name: strava_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.strava_tokens (
    id integer NOT NULL,
    user_id text,
    access_token text,
    refresh_token text,
    expires_at bigint,
    athlete_id bigint,
    athlete_name text,
    connected_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    connection_generation text NOT NULL,
    token_revision bigint DEFAULT 1 NOT NULL,
    refresh_lease_token text,
    refresh_lease_until timestamp with time zone,
    CONSTRAINT bg_refresh_shape CHECK (((token_revision >= 1) AND ((refresh_lease_token IS NULL) = (refresh_lease_until IS NULL))))
);


--
-- Name: strava_tokens_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.strava_tokens_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: strava_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.strava_tokens_id_seq OWNED BY public.strava_tokens.id;


--
-- Name: user_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_notifications (
    id text NOT NULL,
    user_id text NOT NULL,
    type text NOT NULL,
    title text NOT NULL,
    body text NOT NULL,
    href text,
    source_key text NOT NULL,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    weekly_miles_current real DEFAULT 0,
    goal_type text DEFAULT 'fitness'::text,
    goal_race_date text,
    goal_race_distance text,
    injury_notes text,
    comeback_mode integer DEFAULT 0,
    onboarded integer DEFAULT 0,
    coach_personality text DEFAULT 'mentor'::text,
    run_days_per_week integer DEFAULT 3,
    lift_days_per_week integer DEFAULT 2,
    is_pro integer DEFAULT 0,
    stripe_customer_id text,
    stripe_subscription_id text,
    subscription_status text DEFAULT 'free'::text,
    subscription_ends_at text,
    friend_handle text,
    friend_discoverable integer DEFAULT 0,
    contact_discoverable integer DEFAULT 0,
    planning_input_revision bigint DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: web_push_challenges; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.web_push_challenges (
    id text NOT NULL,
    user_id text NOT NULL,
    subscription_id text NOT NULL,
    proof_hash text NOT NULL,
    expected_revision bigint NOT NULL,
    operation_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    consumed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT web_push_challenges_check CHECK ((expires_at > created_at)),
    CONSTRAINT web_push_challenges_expected_revision_check CHECK ((expected_revision >= 0)),
    CONSTRAINT web_push_challenges_proof_hash_check CHECK ((proof_hash ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: web_push_claims; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.web_push_claims (
    endpoint_hash text NOT NULL,
    claim_revision bigint DEFAULT 0 NOT NULL,
    proof_hash text NOT NULL,
    subscription_id text,
    last_operation_id text,
    updated_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT web_push_claims_claim_revision_check CHECK ((claim_revision >= 0)),
    CONSTRAINT web_push_claims_endpoint_hash_check CHECK ((endpoint_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT web_push_claims_proof_hash_check CHECK ((proof_hash ~ '^[a-f0-9]{64}$'::text))
);


--
-- Name: web_push_setup_operations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.web_push_setup_operations (
    challenge_id text NOT NULL,
    endpoint_hash bytea NOT NULL,
    client_nonce_hash bytea NOT NULL,
    session_hash bytea NOT NULL,
    request_hash bytea NOT NULL,
    auth_epoch text NOT NULL,
    send_state text DEFAULT 'RESERVED'::text NOT NULL,
    send_attempted_at_ms bigint,
    cancelled_at_ms bigint,
    handoff_hash bytea,
    handoff_client_id text,
    handoff_until_ms bigint,
    handoff_consumed_at_ms bigint,
    handoff_count integer DEFAULT 0 NOT NULL,
    failed_confirm_count integer DEFAULT 0 NOT NULL,
    confirm_hash bytea,
    result_generation text,
    result_revision bigint,
    retain_until_ms bigint NOT NULL,
    CONSTRAINT web_push_setup_operations_auth_epoch_check CHECK ((length(auth_epoch) = 36)),
    CONSTRAINT web_push_setup_operations_check CHECK ((((send_state = 'RESERVED'::text) AND (send_attempted_at_ms IS NULL)) OR ((send_state <> 'RESERVED'::text) AND (send_attempted_at_ms IS NOT NULL)))),
    CONSTRAINT web_push_setup_operations_check1 CHECK ((((handoff_hash IS NULL) AND (handoff_client_id IS NULL) AND (handoff_until_ms IS NULL) AND (handoff_consumed_at_ms IS NULL)) OR ((handoff_hash IS NOT NULL) AND (handoff_client_id IS NOT NULL) AND (handoff_until_ms IS NOT NULL)))),
    CONSTRAINT web_push_setup_operations_check2 CHECK ((((confirm_hash IS NULL) AND (result_generation IS NULL) AND (result_revision IS NULL)) OR ((confirm_hash IS NOT NULL) AND (result_generation IS NOT NULL) AND (result_revision IS NOT NULL)))),
    CONSTRAINT web_push_setup_operations_client_nonce_hash_check CHECK ((length(client_nonce_hash) = 32)),
    CONSTRAINT web_push_setup_operations_confirm_hash_check CHECK (((confirm_hash IS NULL) OR (length(confirm_hash) = 32))),
    CONSTRAINT web_push_setup_operations_endpoint_hash_check CHECK ((length(endpoint_hash) = 32)),
    CONSTRAINT web_push_setup_operations_failed_confirm_count_check CHECK (((failed_confirm_count >= 0) AND (failed_confirm_count <= 5))),
    CONSTRAINT web_push_setup_operations_handoff_client_id_check CHECK (((handoff_client_id IS NULL) OR ((length(handoff_client_id) >= 1) AND (length(handoff_client_id) <= 256)))),
    CONSTRAINT web_push_setup_operations_handoff_count_check CHECK (((handoff_count >= 0) AND (handoff_count <= 3))),
    CONSTRAINT web_push_setup_operations_handoff_hash_check CHECK (((handoff_hash IS NULL) OR (length(handoff_hash) = 32))),
    CONSTRAINT web_push_setup_operations_request_hash_check CHECK ((length(request_hash) = 32)),
    CONSTRAINT web_push_setup_operations_result_revision_check CHECK (((result_revision IS NULL) OR (result_revision >= 1))),
    CONSTRAINT web_push_setup_operations_retain_until_ms_check CHECK ((retain_until_ms > 0)),
    CONSTRAINT web_push_setup_operations_send_state_check CHECK ((send_state = ANY (ARRAY['RESERVED'::text, 'ATTEMPTED'::text, 'ACCEPTED'::text, 'FAILED'::text, 'UNKNOWN'::text]))),
    CONSTRAINT web_push_setup_operations_session_hash_check CHECK ((length(session_hash) = 32))
);


--
-- Name: web_push_setup_rate_buckets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.web_push_setup_rate_buckets (
    dimension text NOT NULL,
    key_hash bytea NOT NULL,
    window_start_ms bigint NOT NULL,
    used_count integer NOT NULL,
    CONSTRAINT web_push_setup_rate_buckets_dimension_check CHECK ((dimension = ANY (ARRAY['GLOBAL'::text, 'USER'::text, 'ENDPOINT'::text, 'IP'::text]))),
    CONSTRAINT web_push_setup_rate_buckets_key_hash_check CHECK ((length(key_hash) = 32)),
    CONSTRAINT web_push_setup_rate_buckets_used_count_check CHECK (((used_count >= 1) AND (used_count <= 100))),
    CONSTRAINT web_push_setup_rate_buckets_window_start_ms_check CHECK (((window_start_ms >= 0) AND ((window_start_ms % (600000)::bigint) = 0)))
);


--
-- Name: schema_migrations id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations ALTER COLUMN id SET DEFAULT nextval('public.schema_migrations_id_seq'::regclass);


--
-- Name: strava_tokens id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strava_tokens ALTER COLUMN id SET DEFAULT nextval('public.strava_tokens_id_seq'::regclass);


--
-- Name: activity_notification_events activity_notification_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_notification_events
    ADD CONSTRAINT activity_notification_events_pkey PRIMARY KEY (id);


--
-- Name: activity_notification_events activity_notification_events_user_id_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_notification_events
    ADD CONSTRAINT activity_notification_events_user_id_id_key UNIQUE (user_id, id);


--
-- Name: activity_notification_events activity_notification_events_user_id_id_notification_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_notification_events
    ADD CONSTRAINT activity_notification_events_user_id_id_notification_id_key UNIQUE (user_id, id, notification_id);


--
-- Name: background_sync_control background_sync_control_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.background_sync_control
    ADD CONSTRAINT background_sync_control_pkey PRIMARY KEY (id);


--
-- Name: notification_deliveries notification_deliveries_event_id_transport_target_id_target_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_event_id_transport_target_id_target_key UNIQUE (event_id, transport, target_id, target_generation);


--
-- Name: notification_deliveries notification_deliveries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_pkey PRIMARY KEY (id);


--
-- Name: provider_activity_links provider_activity_links_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_activity_links
    ADD CONSTRAINT provider_activity_links_pkey PRIMARY KEY (user_id, provider, object_id);


--
-- Name: provider_event_jobs provider_event_jobs_binding_id_object_type_object_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_event_jobs
    ADD CONSTRAINT provider_event_jobs_binding_id_object_type_object_id_key UNIQUE (binding_id, object_type, object_id);


--
-- Name: provider_event_jobs provider_event_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_event_jobs
    ADD CONSTRAINT provider_event_jobs_pkey PRIMARY KEY (id);


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: push_subscriptions push_subscriptions_user_id_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_user_id_endpoint_key UNIQUE (user_id, endpoint);


--
-- Name: run_save_eligibility run_save_eligibility_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_save_eligibility
    ADD CONSTRAINT run_save_eligibility_pkey PRIMARY KEY (user_id, run_id);


--
-- Name: runs runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_version_key UNIQUE (version);


--
-- Name: strava_connection_fences strava_connection_fences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strava_connection_fences
    ADD CONSTRAINT strava_connection_fences_pkey PRIMARY KEY (user_id);


--
-- Name: strava_ingress_bindings strava_ingress_bindings_athlete_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strava_ingress_bindings
    ADD CONSTRAINT strava_ingress_bindings_athlete_id_key UNIQUE (athlete_id);


--
-- Name: strava_ingress_bindings strava_ingress_bindings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strava_ingress_bindings
    ADD CONSTRAINT strava_ingress_bindings_pkey PRIMARY KEY (id);


--
-- Name: strava_ingress_bindings strava_ingress_bindings_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strava_ingress_bindings
    ADD CONSTRAINT strava_ingress_bindings_user_id_key UNIQUE (user_id);


--
-- Name: strava_tokens strava_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strava_tokens
    ADD CONSTRAINT strava_tokens_pkey PRIMARY KEY (id);


--
-- Name: strava_tokens strava_tokens_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strava_tokens
    ADD CONSTRAINT strava_tokens_user_id_key UNIQUE (user_id);


--
-- Name: user_notifications user_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notifications
    ADD CONSTRAINT user_notifications_pkey PRIMARY KEY (id);


--
-- Name: user_notifications user_notifications_user_id_source_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notifications
    ADD CONSTRAINT user_notifications_user_id_source_key_key UNIQUE (user_id, source_key);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: web_push_challenges web_push_challenges_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_push_challenges
    ADD CONSTRAINT web_push_challenges_pkey PRIMARY KEY (id);


--
-- Name: web_push_challenges web_push_challenges_user_id_operation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_push_challenges
    ADD CONSTRAINT web_push_challenges_user_id_operation_id_key UNIQUE (user_id, operation_id);


--
-- Name: web_push_claims web_push_claims_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_push_claims
    ADD CONSTRAINT web_push_claims_pkey PRIMARY KEY (endpoint_hash);


--
-- Name: web_push_claims web_push_claims_subscription_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_push_claims
    ADD CONSTRAINT web_push_claims_subscription_id_key UNIQUE (subscription_id);


--
-- Name: web_push_setup_operations web_push_setup_operations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_push_setup_operations
    ADD CONSTRAINT web_push_setup_operations_pkey PRIMARY KEY (challenge_id);


--
-- Name: web_push_setup_rate_buckets web_push_setup_rate_buckets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_push_setup_rate_buckets
    ADD CONSTRAINT web_push_setup_rate_buckets_pkey PRIMARY KEY (dimension, key_hash, window_start_ms);


--
-- Name: bg_active_endpoint; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bg_active_endpoint ON public.push_subscriptions USING btree (endpoint) WHERE active;


--
-- Name: bg_active_run_notice; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bg_active_run_notice ON public.activity_notification_events USING btree (user_id, run_id) WHERE (state = 'ACTIVE'::text);


--
-- Name: bg_delivery_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bg_delivery_due ON public.notification_deliveries USING btree (state, available_at, id);


--
-- Name: bg_jobs_due; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bg_jobs_due ON public.provider_event_jobs USING btree (state, available_at, id);


--
-- Name: bg_push_owned_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bg_push_owned_key ON public.push_subscriptions USING btree (user_id, id);


--
-- Name: inbox_owned_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX inbox_owned_key ON public.user_notifications USING btree (user_id, id);


--
-- Name: runs_owned_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX runs_owned_key ON public.runs USING btree (user_id, id);


--
-- Name: strava_unique_athlete; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX strava_unique_athlete ON public.strava_tokens USING btree (athlete_id) WHERE (athlete_id IS NOT NULL);


--
-- Name: background_sync_control bg_activation_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER bg_activation_immutable BEFORE DELETE OR UPDATE ON public.background_sync_control FOR EACH ROW EXECUTE FUNCTION public.bg_activation_immutable();


--
-- Name: strava_ingress_bindings bg_binding_owner_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER bg_binding_owner_guard BEFORE INSERT OR UPDATE ON public.strava_ingress_bindings FOR EACH ROW EXECUTE FUNCTION public.bg_binding_owner_guard();


--
-- Name: push_subscriptions bg_delete_target_claim; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER bg_delete_target_claim BEFORE DELETE ON public.push_subscriptions FOR EACH ROW EXECUTE FUNCTION public.bg_delete_target_claim();


--
-- Name: users bg_erase_user_binding; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER bg_erase_user_binding BEFORE DELETE ON public.users FOR EACH ROW EXECUTE FUNCTION public.bg_erase_user_binding();


--
-- Name: strava_tokens bg_retire_token_binding; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER bg_retire_token_binding BEFORE DELETE OR UPDATE OF connection_generation, athlete_id ON public.strava_tokens FOR EACH ROW EXECUTE FUNCTION public.bg_retire_token_binding();


--
-- Name: activity_notification_events activity_notification_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_notification_events
    ADD CONSTRAINT activity_notification_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: activity_notification_events activity_notification_events_user_id_merged_into_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_notification_events
    ADD CONSTRAINT activity_notification_events_user_id_merged_into_fkey FOREIGN KEY (user_id, merged_into) REFERENCES public.activity_notification_events(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: activity_notification_events activity_notification_events_user_id_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_notification_events
    ADD CONSTRAINT activity_notification_events_user_id_notification_id_fkey FOREIGN KEY (user_id, notification_id) REFERENCES public.user_notifications(user_id, id) ON DELETE CASCADE;


--
-- Name: activity_notification_events activity_notification_events_user_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_notification_events
    ADD CONSTRAINT activity_notification_events_user_id_run_id_fkey FOREIGN KEY (user_id, run_id) REFERENCES public.runs(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: notification_deliveries notification_deliveries_user_id_event_id_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_user_id_event_id_notification_id_fkey FOREIGN KEY (user_id, event_id, notification_id) REFERENCES public.activity_notification_events(user_id, id, notification_id) ON DELETE CASCADE;


--
-- Name: notification_deliveries notification_deliveries_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notification_deliveries notification_deliveries_user_id_target_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_deliveries
    ADD CONSTRAINT notification_deliveries_user_id_target_id_fkey FOREIGN KEY (user_id, target_id) REFERENCES public.push_subscriptions(user_id, id) ON DELETE CASCADE;


--
-- Name: provider_activity_links provider_activity_links_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_activity_links
    ADD CONSTRAINT provider_activity_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: provider_activity_links provider_activity_links_user_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_activity_links
    ADD CONSTRAINT provider_activity_links_user_id_run_id_fkey FOREIGN KEY (user_id, run_id) REFERENCES public.runs(user_id, id) DEFERRABLE INITIALLY DEFERRED;


--
-- Name: provider_event_jobs provider_event_jobs_binding_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_event_jobs
    ADD CONSTRAINT provider_event_jobs_binding_id_fkey FOREIGN KEY (binding_id) REFERENCES public.strava_ingress_bindings(id) ON DELETE CASCADE;


--
-- Name: push_subscriptions push_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: run_save_eligibility run_save_eligibility_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_save_eligibility
    ADD CONSTRAINT run_save_eligibility_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: run_save_eligibility run_save_eligibility_user_id_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.run_save_eligibility
    ADD CONSTRAINT run_save_eligibility_user_id_run_id_fkey FOREIGN KEY (user_id, run_id) REFERENCES public.runs(user_id, id) ON DELETE CASCADE;


--
-- Name: runs runs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.runs
    ADD CONSTRAINT runs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: strava_connection_fences strava_connection_fences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strava_connection_fences
    ADD CONSTRAINT strava_connection_fences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: strava_tokens strava_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.strava_tokens
    ADD CONSTRAINT strava_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_notifications user_notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notifications
    ADD CONSTRAINT user_notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: web_push_challenges web_push_challenges_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_push_challenges
    ADD CONSTRAINT web_push_challenges_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: web_push_challenges web_push_challenges_user_id_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_push_challenges
    ADD CONSTRAINT web_push_challenges_user_id_subscription_id_fkey FOREIGN KEY (user_id, subscription_id) REFERENCES public.push_subscriptions(user_id, id) ON DELETE CASCADE;


--
-- Name: web_push_claims web_push_claims_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_push_claims
    ADD CONSTRAINT web_push_claims_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.push_subscriptions(id) ON DELETE SET NULL;


--
-- Name: web_push_setup_operations web_push_setup_operations_challenge_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.web_push_setup_operations
    ADD CONSTRAINT web_push_setup_operations_challenge_id_fkey FOREIGN KEY (challenge_id) REFERENCES public.web_push_challenges(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--



INSERT INTO schema_migrations(id,version,executed_at) VALUES(1,'background-sync-v2-v3','2026-10-01T12:31:42.259Z');
INSERT INTO schema_migrations(id,version,executed_at) VALUES(2,'background-sync-strava-fence-v1','2026-10-01T12:31:42.292Z');
INSERT INTO schema_migrations(id,version,executed_at) VALUES(3,'background-sync-provider-limits-v1','2026-10-01T12:31:42.292Z');
INSERT INTO schema_migrations(id,version,executed_at) VALUES(4,'background-sync-event-episode-v1','2026-10-01T12:31:42.292Z');
INSERT INTO background_sync_control(id,activation_at,eligibility_bootstrapped,paused,next_allowed_at,quarter_start,quarter_used,day_start,day_used,observed_quarter_cap,observed_day_cap,provider_limits_epoch) VALUES('strava','2026-10-01T12:31:42.277Z',TRUE,FALSE,'2026-10-01T12:31:42.277Z','2026-10-01T12:31:42.277Z',0,'2026-10-01T12:31:42.277Z',0,NULL,NULL,'1');
SELECT pg_catalog.setval('public.schema_migrations_id_seq',4,true);
