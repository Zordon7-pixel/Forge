'use strict';

// Approved B1 v2 + v3 schema. No intake, provider, or delivery worker is activated here.
const MIGRATION_VERSION = 'background-sync-v2-v3';

const POSTGRES_SQL = `-- PROPOSED B1 PostgreSQL17 migration. Run in ONE transaction after legacy tables.
ALTER TABLE strava_tokens ADD COLUMN IF NOT EXISTS connection_generation TEXT;
ALTER TABLE strava_tokens ADD COLUMN IF NOT EXISTS token_revision BIGINT NOT NULL DEFAULT 1;
ALTER TABLE strava_tokens ADD COLUMN IF NOT EXISTS refresh_lease_token TEXT;
ALTER TABLE strava_tokens ADD COLUMN IF NOT EXISTS refresh_lease_until TIMESTAMPTZ;
UPDATE strava_tokens SET connection_generation=gen_random_uuid()::text WHERE connection_generation IS NULL;
ALTER TABLE strava_tokens ALTER COLUMN connection_generation SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS strava_unique_athlete ON strava_tokens(athlete_id) WHERE athlete_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS runs_owned_key ON runs(user_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS inbox_owned_key ON user_notifications(user_id,id);
CREATE TABLE IF NOT EXISTS background_sync_control (
 id TEXT PRIMARY KEY CHECK(id='strava'),
 activation_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 eligibility_bootstrapped BOOLEAN NOT NULL DEFAULT FALSE,
 paused BOOLEAN NOT NULL DEFAULT FALSE,
 next_allowed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 quarter_start TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 quarter_used INTEGER NOT NULL DEFAULT 0 CHECK(quarter_used>=0),
 day_start TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 day_used INTEGER NOT NULL DEFAULT 0 CHECK(day_used>=0)
);
INSERT INTO background_sync_control(id) VALUES('strava') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS strava_ingress_bindings (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL UNIQUE,
 athlete_id TEXT NOT NULL UNIQUE CHECK(athlete_id ~ '^[0-9]{1,30}$'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
 -- Deliberately NO FK to users/tokens. Guard/cleanup triggers below are mandatory.
);
CREATE OR REPLACE FUNCTION bg_binding_owner_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS bg_binding_owner_guard ON strava_ingress_bindings;
CREATE TRIGGER bg_binding_owner_guard BEFORE INSERT OR UPDATE ON strava_ingress_bindings
 FOR EACH ROW EXECUTE FUNCTION bg_binding_owner_guard();
CREATE TABLE IF NOT EXISTS provider_event_jobs (
 id TEXT PRIMARY KEY,
 binding_id TEXT NOT NULL REFERENCES strava_ingress_bindings(id) ON DELETE CASCADE,
 object_type TEXT NOT NULL CHECK(object_type IN('activity','athlete')),
 object_id TEXT NOT NULL CHECK(object_id ~ '^[0-9]{1,30}$'),
 last_fingerprint TEXT NOT NULL CHECK(last_fingerprint ~ '^[a-f0-9]{64}$'),
 reported_event_time BIGINT NOT NULL CHECK(reported_event_time>=0),
 last_aspect TEXT NOT NULL CHECK(last_aspect IN('create','update','delete')),
 requested_revision BIGINT NOT NULL DEFAULT 1 CHECK(requested_revision BETWEEN 1 AND 9000000000000000),
 processed_revision BIGINT NOT NULL DEFAULT 0 CHECK(processed_revision>=0 AND processed_revision<=requested_revision),
 state TEXT NOT NULL CHECK(state IN('PENDING','LEASED','RETRY','DONE','DEAD')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 lease_token TEXT, lease_until TIMESTAMPTZ, leased_revision BIGINT,
 last_fetch_at TIMESTAMPTZ, last_error_code TEXT,
 first_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(binding_id,object_type,object_id),
 CHECK((state='LEASED')=(lease_token IS NOT NULL AND lease_until IS NOT NULL AND leased_revision IS NOT NULL)),
 CHECK(state='LEASED' OR (lease_token IS NULL AND lease_until IS NULL AND leased_revision IS NULL)),
 CHECK(leased_revision IS NULL OR leased_revision BETWEEN 1 AND requested_revision),
 CHECK(last_error_code IS NULL OR length(last_error_code)<=80)
);
CREATE INDEX IF NOT EXISTS bg_jobs_due ON provider_event_jobs(state,available_at,id);
CREATE OR REPLACE FUNCTION bg_retire_token_binding() RETURNS trigger LANGUAGE plpgsql AS $$
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
DROP TRIGGER IF EXISTS bg_retire_token_binding ON strava_tokens;
CREATE TRIGGER bg_retire_token_binding BEFORE DELETE OR UPDATE OF connection_generation,athlete_id
 ON strava_tokens FOR EACH ROW EXECUTE FUNCTION bg_retire_token_binding();
CREATE OR REPLACE FUNCTION bg_erase_user_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM strava_ingress_bindings WHERE user_id=OLD.id;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS bg_erase_user_binding ON users;
CREATE TRIGGER bg_erase_user_binding BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION bg_erase_user_binding();
INSERT INTO strava_ingress_bindings(id,user_id,athlete_id)
 SELECT connection_generation,user_id,athlete_id::text FROM strava_tokens WHERE athlete_id IS NOT NULL
 ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS provider_activity_links (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 provider TEXT NOT NULL CHECK(provider='strava'),
 object_id TEXT NOT NULL CHECK(object_id ~ '^[0-9]{1,30}$'),
 run_id TEXT,
 state TEXT NOT NULL CHECK(state IN('ACTIVE','PROVIDER_UNAVAILABLE','USER_DELETED')),
 legacy BOOLEAN NOT NULL DEFAULT FALSE,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,provider,object_id),
 FOREIGN KEY(user_id,run_id) REFERENCES runs(user_id,id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
 CHECK(state<>'USER_DELETED' OR run_id IS NULL)
);
CREATE TABLE IF NOT EXISTS run_save_eligibility (
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL,
 eligible BOOLEAN NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 reason TEXT NOT NULL CHECK(reason IN('LEGACY','NEW_AFTER_ACTIVATION','LATE_HISTORICAL','UNKNOWN_START')),
 PRIMARY KEY(user_id,run_id),
 FOREIGN KEY(user_id,run_id) REFERENCES runs(user_id,id) ON DELETE CASCADE,
 CHECK(eligible=(reason='NEW_AFTER_ACTIVATION'))
);
INSERT INTO run_save_eligibility(user_id,run_id,eligible,reason)
 SELECT user_id,id,FALSE,'LEGACY' FROM runs
 WHERE EXISTS(SELECT 1 FROM background_sync_control WHERE id='strava' AND NOT eligibility_bootstrapped)
 ON CONFLICT DO NOTHING;
UPDATE background_sync_control SET eligibility_bootstrapped=TRUE WHERE id='strava';
CREATE TABLE IF NOT EXISTS activity_notification_events (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 run_id TEXT,
 notification_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN('ACTIVE','MERGED','CANCELLED')),
 merged_into TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,id), UNIQUE(user_id,id,notification_id),
 FOREIGN KEY(user_id,run_id) REFERENCES runs(user_id,id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(user_id,notification_id) REFERENCES user_notifications(user_id,id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,merged_into) REFERENCES activity_notification_events(user_id,id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
 CHECK((state='ACTIVE' AND run_id IS NOT NULL AND merged_into IS NULL)
 OR (state='MERGED' AND run_id IS NULL AND merged_into IS NOT NULL AND merged_into<>id)
 OR (state='CANCELLED' AND run_id IS NULL AND merged_into IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS bg_active_run_notice ON activity_notification_events(user_id,run_id) WHERE state='ACTIVE';
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS generation TEXT NOT NULL DEFAULT gen_random_uuid()::text;
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS disclosure TEXT NOT NULL DEFAULT 'GENERIC';
CREATE UNIQUE INDEX IF NOT EXISTS bg_active_endpoint ON push_subscriptions(endpoint) WHERE active;
CREATE UNIQUE INDEX IF NOT EXISTS bg_push_owned_key ON push_subscriptions(user_id,id);
CREATE TABLE IF NOT EXISTS web_push_claims (
 endpoint_hash TEXT PRIMARY KEY CHECK(endpoint_hash ~ '^[a-f0-9]{64}$'),
 claim_revision BIGINT NOT NULL DEFAULT 0 CHECK(claim_revision>=0),
 proof_hash TEXT NOT NULL CHECK(proof_hash ~ '^[a-f0-9]{64}$'),
 subscription_id TEXT UNIQUE REFERENCES push_subscriptions(id) ON DELETE SET NULL,
 last_operation_id TEXT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS web_push_challenges (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 subscription_id TEXT NOT NULL,
 proof_hash TEXT NOT NULL CHECK(proof_hash ~ '^[a-f0-9]{64}$'),
 expected_revision BIGINT NOT NULL CHECK(expected_revision>=0),
 operation_id TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 consumed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(user_id,subscription_id) REFERENCES push_subscriptions(user_id,id) ON DELETE CASCADE,
 UNIQUE(user_id,operation_id),
 CHECK(expires_at>created_at)
);
CREATE OR REPLACE FUNCTION bg_delete_target_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM web_push_claims WHERE subscription_id=OLD.id;
 RETURN OLD;
END $$;
DROP TRIGGER IF EXISTS bg_delete_target_claim ON push_subscriptions;
CREATE TRIGGER bg_delete_target_claim BEFORE DELETE ON push_subscriptions
 FOR EACH ROW EXECUTE FUNCTION bg_delete_target_claim();
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='strava_tokens'::regclass AND conname='bg_refresh_shape') THEN
  ALTER TABLE strava_tokens ADD CONSTRAINT bg_refresh_shape CHECK(
   token_revision>=1 AND ((refresh_lease_token IS NULL)=(refresh_lease_until IS NULL)));
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='push_subscriptions'::regclass AND conname='bg_disclosure') THEN
  ALTER TABLE push_subscriptions ADD CONSTRAINT bg_disclosure CHECK(disclosure IN('GENERIC','SAVED_RUN'));
 END IF;
END $$;
CREATE TABLE IF NOT EXISTS notification_deliveries (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL, notification_id TEXT NOT NULL,
 transport TEXT NOT NULL CHECK(transport='WEB_PUSH'),
 target_id TEXT NOT NULL,
 target_generation TEXT NOT NULL,
 disclosure TEXT NOT NULL CHECK(disclosure IN('GENERIC','SAVED_RUN')),
 state TEXT NOT NULL CHECK(state IN('PENDING','LEASED','RETRY','ACCEPTED','CANCELLED','DEAD','EXPIRED')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
 available_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 expires_at TIMESTAMPTZ NOT NULL,
 lease_token TEXT, lease_until TIMESTAMPTZ,
 accepted_at TIMESTAMPTZ, transport_receipt_id TEXT, last_error_code TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(event_id,transport,target_id,target_generation),
 FOREIGN KEY(user_id,event_id,notification_id) REFERENCES activity_notification_events(user_id,id,notification_id) ON DELETE CASCADE,
 FOREIGN KEY(user_id,target_id) REFERENCES push_subscriptions(user_id,id) ON DELETE CASCADE,
 CHECK((state='LEASED')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK(state='LEASED' OR (lease_token IS NULL AND lease_until IS NULL)),
 CHECK((state='ACCEPTED')=(accepted_at IS NOT NULL)),
 CHECK(expires_at>created_at),
 CHECK(last_error_code IS NULL OR length(last_error_code)<=80)
);
CREATE INDEX IF NOT EXISTS bg_delivery_due ON notification_deliveries(state,available_at,id);
`;

const SETUP_SQL = `CREATE TABLE IF NOT EXISTS web_push_setup_operations (
 challenge_id TEXT PRIMARY KEY REFERENCES web_push_challenges(id) ON DELETE CASCADE,
 endpoint_hash BYTEA NOT NULL CHECK(length(endpoint_hash)=32),
 client_nonce_hash BYTEA NOT NULL CHECK(length(client_nonce_hash)=32),
 session_hash BYTEA NOT NULL CHECK(length(session_hash)=32),
 request_hash BYTEA NOT NULL CHECK(length(request_hash)=32),
 auth_epoch TEXT NOT NULL CHECK(length(auth_epoch)=36),
 send_state TEXT NOT NULL DEFAULT 'RESERVED'
   CHECK(send_state IN ('RESERVED','ATTEMPTED','ACCEPTED','FAILED','UNKNOWN')),
 send_attempted_at_ms BIGINT,
 cancelled_at_ms BIGINT,
 handoff_hash BYTEA CHECK(handoff_hash IS NULL OR length(handoff_hash)=32),
 handoff_client_id TEXT CHECK(handoff_client_id IS NULL OR length(handoff_client_id) BETWEEN 1 AND 256),
 handoff_until_ms BIGINT,
 handoff_consumed_at_ms BIGINT,
 handoff_count INTEGER NOT NULL DEFAULT 0 CHECK(handoff_count BETWEEN 0 AND 3),
 failed_confirm_count INTEGER NOT NULL DEFAULT 0 CHECK(failed_confirm_count BETWEEN 0 AND 5),
 confirm_hash BYTEA CHECK(confirm_hash IS NULL OR length(confirm_hash)=32),
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
CREATE TABLE IF NOT EXISTS web_push_setup_rate_buckets (
 dimension TEXT NOT NULL CHECK(dimension IN ('GLOBAL','USER','ENDPOINT','IP')),
 key_hash BYTEA NOT NULL CHECK(length(key_hash)=32),
 window_start_ms BIGINT NOT NULL CHECK(window_start_ms>=0 AND window_start_ms%600000=0),
 used_count INTEGER NOT NULL CHECK(used_count BETWEEN 1 AND 100),
 PRIMARY KEY(dimension,key_hash,window_start_ms)
);`;

const OWNED_TABLES = ['strava_ingress_bindings', 'provider_event_jobs', 'provider_activity_links',
  'run_save_eligibility', 'activity_notification_events', 'notification_deliveries',
  'web_push_claims', 'web_push_challenges', 'web_push_setup_operations', 'web_push_setup_rate_buckets',
  'background_sync_control'];
const BASE_COLUMNS = {
  users: ['id'],
  runs: ['id', 'user_id', 'health_source', 'health_source_workout_id', 'workout_metrics_json'],
  user_notifications: ['id', 'user_id', 'source_key'],
  strava_tokens: ['id', 'user_id', 'access_token', 'refresh_token', 'expires_at', 'athlete_id', 'athlete_name', 'connected_at'],
  push_subscriptions: ['id', 'user_id', 'endpoint', 'keys_p256dh', 'keys_auth', 'created_at'],
};
function blocked(code) {
  const error = new Error(`Background sync migration blocked: ${code}`);
  error.code = `BACKGROUND_SCHEMA_${code}`;
  return error;
}
function pgAdapter(client) {
  const query = (sql, values = []) => {
    let index = 0;
    return client.query(sql.replace(/\?/g, () => `$${++index}`), values);
  };
  return { exec: sql => client.query(sql), all: async (sql, values) => (await query(sql, values)).rows,
    get: async (sql, values) => (await query(sql, values)).rows[0], run: query };
}
function sqliteAdapter(db) {
  return { exec: sql => db.exec(sql), all: (sql, values = []) => db.prepare(sql).all(...values),
    get: (sql, values = []) => db.prepare(sql).get(...values),
    run: (sql, values = []) => db.prepare(sql).run(...values) };
}
async function columns(db, dialect, table) {
  return dialect === 'postgres'
    ? (await db.all('SELECT column_name AS name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=?', [table])).map(row => row.name)
    : (await db.all(`PRAGMA table_info(${table})`)).map(row => row.name);
}
async function preflight(db, dialect) {
  const original = {};
  for (const [table, required] of Object.entries(BASE_COLUMNS)) {
    original[table] = await columns(db, dialect, table);
    if (required.some(name => !original[table].includes(name))) throw blocked('BASE_COLUMNS');
  }
  const recorded = await db.get('SELECT version FROM schema_migrations WHERE version=?', [MIGRATION_VERSION]);
  const existing = [];
  for (const table of OWNED_TABLES) if ((await columns(db, dialect, table)).length) existing.push(table);
  if (!recorded && (existing.length || ['connection_generation', 'token_revision', 'refresh_lease_token', 'refresh_lease_until'].some(key => original.strava_tokens.includes(key))
    || ['active', 'generation', 'disclosure'].some(key => original.push_subscriptions.includes(key)))) {
    throw blocked('UNRECOGNIZED_PARTIAL_SCHEMA');
  }
  if (recorded && (existing.length !== OWNED_TABLES.length
    || !original.strava_tokens.includes('connection_generation') || !original.push_subscriptions.includes('active'))) {
    throw blocked('RECORDED_SCHEMA_INCOMPLETE');
  }
  if (recorded) await validateRecordedSchema(db, dialect, original);
  if (await db.get('SELECT t.id FROM strava_tokens t LEFT JOIN users u ON u.id=t.user_id WHERE u.id IS NULL LIMIT 1')) throw blocked('TOKEN_OWNER');
  if (await db.get('SELECT athlete_id FROM strava_tokens WHERE athlete_id IS NOT NULL GROUP BY athlete_id HAVING count(*)>1 LIMIT 1')) throw blocked('DUPLICATE_ATHLETE');
  const invalidAthlete = dialect === 'postgres'
    ? "athlete_id::text !~ '^[1-9][0-9]{0,29}$'"
    : "(length(CAST(athlete_id AS TEXT)) NOT BETWEEN 1 AND 30 OR CAST(athlete_id AS TEXT) GLOB '*[^0-9]*' OR substr(CAST(athlete_id AS TEXT),1,1)='0')";
  if (await db.get(`SELECT id FROM strava_tokens WHERE athlete_id IS NOT NULL AND ${invalidAthlete} LIMIT 1`)) throw blocked('ATHLETE_ID');
  return { original, recorded: Boolean(recorded) };
}
async function validateRecordedSchema(db, dialect, original) {
  const authority = Boolean(await db.get('SELECT version FROM schema_migrations WHERE version=?', [WEB_PUSH_AUTHORITY_VERSION]));
  for (const [table, extra] of Object.entries({ strava_tokens: ['connection_generation','token_revision','refresh_lease_token','refresh_lease_until'], push_subscriptions: ['active','generation','disclosure'] })) {
    if (extra.some(name => !original[table].includes(name))) throw blocked('RECORDED_SCHEMA_INCOMPLETE');
  }
  const ddl = POSTGRES_SQL + '\n' + SETUP_SQL;
  for (const table of OWNED_TABLES) {
    const body = ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`))?.[1];
    const required = [...body.matchAll(/(?:^|\n|,)\s*([a-z_]+)\s+(?:TEXT|BYTEA|BIGINT|INTEGER|BOOLEAN|TIMESTAMPTZ)\b/g)].map(match => match[1]);
    const present = await columns(db, dialect, table);
    if (required.some(name => !present.includes(name))) throw blocked('RECORDED_SCHEMA_INCOMPLETE');
  }
  const requiredIndexes = [...POSTGRES_SQL.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (\w+)/g)].map(match => match[1]);
  const indexes = await db.all(dialect === 'postgres'
    ? 'SELECT indexname AS name FROM pg_indexes WHERE schemaname=current_schema()'
    : "SELECT name FROM sqlite_master WHERE type='index'");
  if (requiredIndexes.some(name => !indexes.some(row => row.name === name))) throw blocked('RECORDED_INDEX_MISSING');
  const requiredTriggers = dialect === 'postgres'
    ? ['bg_binding_owner_guard','bg_retire_token_binding','bg_erase_user_binding','bg_delete_target_claim','bg_activation_immutable']
    : ['bg_binding_insert','bg_binding_update','bg_token_delete','bg_token_update','bg_user_delete',authority ? 'bg_delete_target_claim' : 'bg_target_delete','bg_activation_immutable','bg_activation_no_delete'];
  const triggers = await db.all(dialect === 'postgres'
    ? "SELECT t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND NOT t.tgisinternal AND t.tgenabled='O'"
    : "SELECT name FROM sqlite_master WHERE type='trigger'");
  if (requiredTriggers.some(name => !triggers.some(row => row.name === name))) throw blocked('RECORDED_TRIGGER_MISSING');
  await validateWebPushAuthority(db, dialect, authority);
}

// The activation instant is historical authority, never a rerun/reset clock.
const PG_ACTIVATION_GUARD = `CREATE FUNCTION bg_activation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.activation_at IS DISTINCT FROM OLD.activation_at
   OR (OLD.eligibility_bootstrapped AND NOT NEW.eligibility_bootstrapped) THEN
  RAISE EXCEPTION 'background activation immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bg_activation_immutable BEFORE UPDATE OR DELETE ON background_sync_control
 FOR EACH ROW EXECUTE FUNCTION bg_activation_immutable();`;
const SQLITE_ACTIVATION_GUARD = `CREATE TRIGGER bg_activation_immutable BEFORE UPDATE ON background_sync_control
 WHEN NEW.activation_at IS NOT OLD.activation_at OR (OLD.eligibility_bootstrapped=1 AND NEW.eligibility_bootstrapped<>1)
 BEGIN SELECT RAISE(ABORT,'background activation immutable'); END;
CREATE TRIGGER bg_activation_no_delete BEFORE DELETE ON background_sync_control
 BEGIN SELECT RAISE(ABORT,'background activation immutable'); END;`;
function providerId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  return typeof value === 'string' && /^[1-9][0-9]{0,29}$/.test(value) ? value : null;
}
async function bootstrapLinks(db) {
  let after = null, skippedProvenance = 0, linked = 0;
  while (true) {
    const rows = await db.all(`SELECT id,user_id,health_source,health_source_workout_id,workout_metrics_json FROM runs
      ${after === null ? '' : 'WHERE id>?'} ORDER BY id LIMIT 1000`, after === null ? [] : [after]);
    if (!rows.length) break;
    for (const row of rows) {
      const ids = new Set();
      if (row.health_source === 'strava') {
        const id = providerId(row.health_source_workout_id);
        if (id) ids.add(id); else skippedProvenance++;
      }
      if (row.workout_metrics_json !== null && row.workout_metrics_json !== undefined) {
        let metrics;
        try {
          const text = typeof row.workout_metrics_json === 'string' ? row.workout_metrics_json : JSON.stringify(row.workout_metrics_json);
          if (Buffer.byteLength(text) > 32768) throw blocked('PROVENANCE_SIZE');
          metrics = JSON.parse(text);
          if (!metrics || typeof metrics !== 'object' || Array.isArray(metrics)) throw blocked('PROVENANCE_SHAPE');
          if (Object.hasOwn(metrics, 'strava_activity_id')) {
            const id = providerId(metrics.strava_activity_id);
            if (id) ids.add(id); else skippedProvenance++;
          }
        } catch { skippedProvenance++; }
      }
      for (const id of ids) {
        const previous = await db.get("SELECT run_id FROM provider_activity_links WHERE user_id=? AND provider='strava' AND object_id=?", [row.user_id, id]);
        if (previous && previous.run_id !== row.id) throw blocked('AMBIGUOUS_LEGACY_LINK');
        if (!previous) {
          await db.run("INSERT INTO provider_activity_links(user_id,provider,object_id,run_id,state,legacy) VALUES(?,'strava',?,?,'ACTIVE',TRUE)", [row.user_id, id, row.id]);
          linked++;
        }
      }
    }
    after = rows.at(-1).id;
  }
  return { linked, skippedProvenance };
}
async function verifyBootstrap(db, bootstrap) {
  const runs = Number((await db.get('SELECT count(*) AS n FROM runs')).n);
  const legacy = Number((await db.get("SELECT count(*) AS n FROM run_save_eligibility WHERE reason='LEGACY' AND NOT eligible")).n);
  const links = Number((await db.get('SELECT count(*) AS n FROM provider_activity_links')).n);
  if (runs !== legacy || links !== bootstrap.linked) throw blocked('BOOTSTRAP_COUNT');
}

const SQLITE_TRIGGERS = `
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
END;`;

function sqliteSql() {
  const sql = POSTGRES_SQL.replace(/CREATE OR REPLACE FUNCTION[\s\S]*?END \$\$;/g, '')
    .replace(/DO \$\$ BEGIN[\s\S]*?END \$\$;/g, '')
    .replace(/DROP TRIGGER IF EXISTS[^;]+;/g, '')
    .replace(/CREATE TRIGGER[\s\S]*?EXECUTE FUNCTION[^;]+;/g, '')
    .replace(/ALTER TABLE[^;]+;/g, '')
    .replace(/UPDATE strava_tokens SET connection_generation[^;]+;/g, '')
    .replace(/([a-z_]+) ~ '\^\[a-f0-9\]\{64\}\$'/g, "(length($1)=64 AND $1 NOT GLOB '*[^a-f0-9]*')")
    .replace(/([a-z_]+) ~ '\^\[0-9\]\{1,30\}\$'/g, "(length($1) BETWEEN 1 AND 30 AND $1 NOT GLOB '*[^0-9]*')")
    .replace(/([a-z_]+) BOOLEAN NOT NULL DEFAULT (FALSE|TRUE)/g, (_, key, value) => `${key} INTEGER NOT NULL DEFAULT ${value === 'TRUE' ? 1 : 0} CHECK(${key} IN(0,1))`)
    .replace(/BOOLEAN NOT NULL/g, 'INTEGER NOT NULL CHECK(eligible IN(0,1))')
    .replace(/TIMESTAMPTZ/g, 'TEXT').replace(/clock_timestamp\(\)/g, 'CURRENT_TIMESTAMP').replace(/::text/g, '');
  if (/ ~ |ALTER TABLE|EXECUTE FUNCTION/.test(sql)) throw blocked('SQLITE_TRANSLATION');
  return sql;
}

async function rebuildSqlite(db, table, original) {
  if (original.length !== BASE_COLUMNS[table].length || original.some(name => !BASE_COLUMNS[table].includes(name))) throw blocked('UNKNOWN_SQLITE_BASE_COLUMN');
  const dependents = await db.all("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN('index','trigger') AND sql IS NOT NULL", [table]);
  const sequence = table === 'strava_tokens' && await db.get("SELECT name FROM sqlite_master WHERE name='sqlite_sequence'")
    ? await db.get("SELECT seq FROM sqlite_sequence WHERE name='strava_tokens'") : null;
  const body = table === 'strava_tokens'
    ? `id INTEGER PRIMARY KEY AUTOINCREMENT,user_id TEXT UNIQUE REFERENCES users(id) ON DELETE CASCADE,
       access_token TEXT,refresh_token TEXT,expires_at BIGINT,athlete_id BIGINT,athlete_name TEXT,connected_at TEXT DEFAULT CURRENT_TIMESTAMP,
       connection_generation TEXT NOT NULL,token_revision BIGINT NOT NULL DEFAULT 1 CHECK(token_revision>=1),refresh_lease_token TEXT,refresh_lease_until TEXT,
       CHECK((refresh_lease_token IS NULL)=(refresh_lease_until IS NULL))`
    : `id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       endpoint TEXT NOT NULL,keys_p256dh TEXT NOT NULL,keys_auth TEXT NOT NULL,created_at TEXT DEFAULT CURRENT_TIMESTAMP,
       active INTEGER NOT NULL DEFAULT 0 CHECK(active IN(0,1)),generation TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
       disclosure TEXT NOT NULL DEFAULT 'GENERIC' CHECK(disclosure IN('GENERIC','SAVED_RUN')),UNIQUE(user_id,endpoint)`;
  await db.exec(`CREATE TABLE bg_upgrade_${table}(${body})`);
  const names = BASE_COLUMNS[table].join(',');
  await db.exec(`INSERT INTO bg_upgrade_${table}(${names}${table === 'strava_tokens' ? ',connection_generation' : ''})
    SELECT ${names}${table === 'strava_tokens' ? ',lower(hex(randomblob(16)))' : ''} FROM ${table}`);
  await db.exec(`DROP TABLE ${table}; ALTER TABLE bg_upgrade_${table} RENAME TO ${table};`);
  for (const row of dependents) await db.exec(row.sql);
  if (sequence) await db.run('UPDATE sqlite_sequence SET seq=max(seq,?) WHERE name=?', [sequence.seq, table]);
}

async function migrateBackgroundBasePostgres(pool) {
  const client = await pool.connect();
  const db = pgAdapter(client);
  try {
    await db.exec('BEGIN');
    await db.exec("SELECT pg_advisory_xact_lock(hashtext('background-sync-v2'))");
    await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(id SERIAL PRIMARY KEY, version TEXT UNIQUE NOT NULL, executed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP)');
    const { recorded } = await preflight(db, 'postgres');
    if (recorded) {
      const state = await db.get("SELECT eligibility_bootstrapped FROM background_sync_control WHERE id='strava'");
      if (!state?.eligibility_bootstrapped) throw blocked('BOOTSTRAP_STATE');
      await db.exec('COMMIT');
      return { applied: false };
    }
    await db.exec(POSTGRES_SQL);
    await db.exec(SETUP_SQL);
    await db.exec(PG_ACTIVATION_GUARD);
    const bootstrap = await bootstrapLinks(db);
    await verifyBootstrap(db, bootstrap);
    await db.run('INSERT INTO schema_migrations(version) VALUES(?)', [MIGRATION_VERSION]);
    await db.exec('COMMIT');
    return { applied: true, ...bootstrap };
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function migrateBackgroundBaseSqlite(database) {
  if (database.isTransaction) throw blocked('SQLITE_TRANSACTION_ACTIVE');
  const db = sqliteAdapter(database);
  if (!(await db.get('PRAGMA foreign_keys')).foreign_keys) throw blocked('SQLITE_FOREIGN_KEYS_DISABLED');
  let begun = false;
  let migrationError;
  try {
    await db.exec('PRAGMA foreign_keys=OFF;');
    await db.exec('BEGIN EXCLUSIVE;');
    begun = true;
    await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT UNIQUE NOT NULL, executed_at TEXT DEFAULT CURRENT_TIMESTAMP)');
    const { original, recorded } = await preflight(db, 'sqlite');
    if (recorded) {
      const state = await db.get("SELECT eligibility_bootstrapped FROM background_sync_control WHERE id='strava'");
      if (state?.eligibility_bootstrapped !== 1) throw blocked('BOOTSTRAP_STATE');
    } else {
      await rebuildSqlite(db, 'strava_tokens', original.strava_tokens);
      await rebuildSqlite(db, 'push_subscriptions', original.push_subscriptions);
      await db.exec(sqliteSql());
      await db.exec(SQLITE_TRIGGERS);
      await db.exec(SETUP_SQL.replace(/BYTEA/g, 'BLOB'));
      await db.exec(SQLITE_ACTIVATION_GUARD);
      await verifyBootstrap(db, await bootstrapLinks(db));
      await db.run('INSERT INTO schema_migrations(version) VALUES(?)', [MIGRATION_VERSION]);
    }
    if ((await db.all('PRAGMA foreign_key_check')).length) throw blocked('SQLITE_FOREIGN_KEYS');
    await db.exec('COMMIT');
    begun = false;
    return { applied: !recorded };
  } catch (error) {
    migrationError = error;
    if (begun && database.isTransaction) {
      try { await db.exec('ROLLBACK'); }
      catch (rollbackError) {
        migrationError = new AggregateError([error, rollbackError], 'Background sync migration rollback failed');
      }
    }
    throw migrationError;
  } finally {
    // BEGIN itself can fail after OFF. Restoration also needs readback because
    // SQLite silently ignores this pragma inside an unrolled-back transaction.
    try {
      await db.exec('PRAGMA foreign_keys=ON');
      if ((await db.get('PRAGMA foreign_keys')).foreign_keys !== 1) throw blocked('SQLITE_FOREIGN_KEYS_RESTORE');
    } catch (restoreError) {
      const error = blocked('SQLITE_FOREIGN_KEYS_RESTORE');
      error.cause = migrationError
        ? new AggregateError([migrationError, restoreError], 'Migration and foreign-key restoration failed')
        : restoreError;
      throw error;
    }
  }
}

// This separate migration must not enter B1a's OWNED_TABLES/preflight: a valid
// already-recorded B1a database does not have this later table yet.
const FENCE_MIGRATION_VERSION = 'background-sync-strava-fence-v1';
const FENCE_PG_SQL = `CREATE TABLE strava_connection_fences (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 epoch TEXT NOT NULL CHECK (epoch ~ '^[a-f0-9]{64}$')
);`;
const FENCE_SQLITE_SQL = `CREATE TABLE strava_connection_fences (
 user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 epoch TEXT NOT NULL CHECK (length(epoch) = 64 AND epoch NOT GLOB '*[^0-9a-f]*')
);`;
const compactSql = sql => sql.replace(/\s+/g, '').replace(/;$/, '');
async function validateFence(db, dialect) {
  if (dialect === 'sqlite') {
    const row = await db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='strava_connection_fences'");
    if (!row || compactSql(row.sql) !== compactSql(FENCE_SQLITE_SQL)) throw blocked('FENCE_SCHEMA');
  } else {
    const attrs = await db.all(`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull AS required,pg_get_expr(d.adbin,d.adrelid) AS default_value
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname=current_schema() AND c.relname='strava_connection_fences' AND c.relkind='r'
        AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`);
    if (JSON.stringify(attrs) !== JSON.stringify(['user_id','epoch'].map(name => ({ name,type:'text',required:true,default_value:null })))) throw blocked('FENCE_SCHEMA');
    const constraints = await db.all(`SELECT c.contype,pg_get_constraintdef(c.oid) AS definition,c.convalidated
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=current_schema() AND t.relname='strava_connection_fences'`);
    const expected = ["CHECK ((epoch ~ '^[a-f0-9]{64}$'::text))", 'PRIMARY KEY (user_id)',
      'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE'].map(compactSql).sort();
    if (constraints.length !== 3 || constraints.some(c => !c.convalidated)
      || JSON.stringify(constraints.map(c => compactSql(c.definition)).sort()) !== JSON.stringify(expected)) throw blocked('FENCE_SCHEMA');
  }
  let after = null;
  while (true) {
    const rows = await db.all(`SELECT f.user_id,f.epoch,u.id AS owner_id FROM strava_connection_fences f
      LEFT JOIN users u ON u.id=f.user_id ${after === null ? '' : 'WHERE f.user_id>?'} ORDER BY f.user_id LIMIT 1000`, after === null ? [] : [after]);
    if (!rows.length) break;
    if (rows.some(r => !r.owner_id || typeof r.epoch !== 'string' || !/^[a-f0-9]{64}$/.test(r.epoch))) throw blocked('FENCE_ROWS');
    after = rows.at(-1).user_id;
  }
  if (await db.get(`SELECT t.user_id FROM strava_tokens t LEFT JOIN strava_connection_fences f ON f.user_id=t.user_id
    WHERE f.user_id IS NULL LIMIT 1`)) throw blocked('FENCE_COVERAGE');
}
async function applyFence(db, dialect) {
  const recorded = await db.get('SELECT version FROM schema_migrations WHERE version=?', [FENCE_MIGRATION_VERSION]);
  const present = (await columns(db, dialect, 'strava_connection_fences')).length > 0;
  if (!recorded) {
    if (present) throw blocked('FENCE_UNRECORDED_SCHEMA');
    await db.exec(dialect === 'postgres' ? FENCE_PG_SQL : FENCE_SQLITE_SQL);
    let after = null;
    while (true) {
      const rows = await db.all(`SELECT user_id FROM strava_tokens ${after === null ? '' : 'WHERE user_id>?'} ORDER BY user_id LIMIT 1000`, after === null ? [] : [after]);
      if (!rows.length) break;
      for (const row of rows) await db.run('INSERT INTO strava_connection_fences(user_id,epoch) VALUES(?,?)',
        [row.user_id, require('node:crypto').randomBytes(32).toString('hex')]);
      after = rows.at(-1).user_id;
    }
  } else if (!present) throw blocked('FENCE_SCHEMA');
  await validateFence(db, dialect);
  if (!recorded) await db.run('INSERT INTO schema_migrations(version) VALUES(?)', [FENCE_MIGRATION_VERSION]);
}

const LIMITS_MIGRATION_VERSION = 'background-sync-provider-limits-v1';
const LIMIT_FIELDS = [
  ['observed_quarter_cap', 60, 'bg_provider_quarter_cap'],
  ['observed_day_cap', 600, 'bg_provider_day_cap'],
  ['provider_limits_epoch', 9000000000000000, 'bg_provider_limits_epoch'],
];
function limitColumn(name, max, constraint, dialect) {
  const epoch = name === 'provider_limits_epoch';
  const type = dialect === 'postgres' && epoch ? 'BIGINT' : 'INTEGER';
  const check = dialect === 'postgres' ? `${name} BETWEEN 1 AND ${max}`
    : `${epoch ? '' : `${name} IS NULL OR `}(typeof(${name})='integer' AND ${name} BETWEEN 1 AND ${max})`;
  return `${name} ${type}${epoch ? ' NOT NULL DEFAULT 1' : ''} CONSTRAINT ${constraint} CHECK(${check})`;
}
async function validateProviderLimits(db, dialect) {
  if (dialect === 'sqlite') {
    const row = await db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='background_sync_control'");
    const base = sqliteSql().match(/CREATE TABLE IF NOT EXISTS background_sync_control \(([\s\S]*?)\n\);/)[1];
    const expected = `CREATE TABLE background_sync_control (${base},${LIMIT_FIELDS.map(field=>limitColumn(...field,dialect)).join(',')})`;
    if (!row || compactSql(row.sql) !== compactSql(expected)) throw blocked('PROVIDER_LIMITS_SCHEMA');
    const attributes = await db.all('PRAGMA table_info(background_sync_control)');
    for (const [name, max, constraint] of LIMIT_FIELDS) {
      const attribute = attributes.find(a => a.name === name), epoch = name === 'provider_limits_epoch';
      if (!attribute || attribute.type !== 'INTEGER' || attribute.notnull !== Number(epoch)
        || attribute.dflt_value !== (epoch ? '1' : null)
        || !compactSql(row.sql).includes(compactSql(limitColumn(name, max, constraint, dialect)))) throw blocked('PROVIDER_LIMITS_SCHEMA');
    }
  } else {
    const attrs = await db.all(`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull AS required,pg_get_expr(d.adbin,d.adrelid) AS default_value
      FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname=current_schema() AND c.relname='background_sync_control' AND c.relkind='r'
        AND a.attnum>0 AND NOT a.attisdropped`);
    const checks = await db.all(`SELECT c.conname,c.contype,c.convalidated,pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
      WHERE n.nspname=current_schema() AND t.relname='background_sync_control'`);
    const normalize = value => value.replace(/[\s()]/g, '').replace(/::bigint/g, '').replace(/'([0-9]+)'/g, '$1');
    for (const [name, max, constraint] of LIMIT_FIELDS) {
      const attribute = attrs.find(a => a.name === name), epoch = name === 'provider_limits_epoch';
      const check = checks.find(c => c.conname === constraint);
      if (!attribute || attribute.type !== (epoch ? 'bigint' : 'integer') || attribute.required !== epoch
        || attribute.default_value !== (epoch ? '1' : null) || !check || check.contype !== 'c' || !check.convalidated
        || normalize(check.definition) !== normalize(`CHECK (${name} >= 1 AND ${name} <= ${max})`)) throw blocked('PROVIDER_LIMITS_SCHEMA');
    }
  }
  const rows = await db.all('SELECT observed_quarter_cap,observed_day_cap,provider_limits_epoch FROM background_sync_control');
  if (rows.length !== 1 || rows.some(row => LIMIT_FIELDS.some(([name,max]) => {
    const value = row[name];
    return value === null ? name === 'provider_limits_epoch'
      : !((typeof value === 'number' || (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)))
        && Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= max);
  }))) throw blocked('PROVIDER_LIMITS_ROWS');
}
async function applyProviderLimits(db, dialect) {
  const recorded = await db.get('SELECT version FROM schema_migrations WHERE version=?', [LIMITS_MIGRATION_VERSION]);
  const present = await columns(db, dialect, 'background_sync_control');
  if (!recorded) {
    if (LIMIT_FIELDS.some(([name]) => present.includes(name))) throw blocked('PROVIDER_LIMITS_UNRECORDED_SCHEMA');
    for (const field of LIMIT_FIELDS) await db.exec(`ALTER TABLE background_sync_control ADD COLUMN ${limitColumn(...field,dialect)}`);
  }
  await validateProviderLimits(db, dialect);
  if (!recorded) await db.run('INSERT INTO schema_migrations(version) VALUES(?)', [LIMITS_MIGRATION_VERSION]);
}

// A retry episode is not the original slot age or the frequently updated hint
// clock. This additive migration activates no consumer and never resets pause.
// Exact approved correction-v2 affected DDL (f75a7d0a489c60ba...462c2ad4).
// Separate marker: old migrations keep their original meaning and authority.
const WEB_PUSH_AUTHORITY_VERSION = 'background-web-push-authority-control-v1';
const WEB_PUSH_AUTHORITY_PG = `DROP TRIGGER bg_delete_target_claim ON push_subscriptions;
DROP TABLE web_push_setup_operations;
DROP TABLE web_push_challenges;
DROP TABLE web_push_claims;

CREATE TABLE web_push_claims (
 endpoint_hash TEXT PRIMARY KEY CHECK(endpoint_hash ~ '^[a-f0-9]{64}$'),
 incarnation TEXT NOT NULL UNIQUE CHECK(incarnation ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
 state TEXT NOT NULL CHECK(state IN ('ACTIVE','VACANT')),
 claim_revision BIGINT NOT NULL CHECK(claim_revision BETWEEN 0 AND 9000000000000000),
 proof_hash TEXT CHECK(proof_hash IS NULL OR proof_hash ~ '^[a-f0-9]{64}$'),
 subscription_id TEXT UNIQUE REFERENCES push_subscriptions(id) ON DELETE RESTRICT,
 last_operation_id TEXT,
 confirm_hash BYTEA CHECK(confirm_hash IS NULL OR octet_length(confirm_hash)=32),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK((state='VACANT' AND claim_revision=0 AND proof_hash IS NULL
        AND subscription_id IS NULL AND last_operation_id IS NULL AND confirm_hash IS NULL)
    OR (state='ACTIVE' AND claim_revision BETWEEN 1 AND 9000000000000000
        AND proof_hash IS NOT NULL AND subscription_id IS NOT NULL
        AND last_operation_id IS NOT NULL AND confirm_hash IS NOT NULL))
);
CREATE INDEX bg_claim_vacant_due ON web_push_claims(state,updated_at,endpoint_hash);

CREATE FUNCTION bg_push_authority_transition_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.state<>'VACANT' THEN RAISE EXCEPTION 'BG_ACTIVE_AUTHORITY_DELETE'; END IF;
  RETURN OLD;
 END IF;
 IF NEW.endpoint_hash<>OLD.endpoint_hash OR NEW.incarnation=OLD.incarnation THEN
  RAISE EXCEPTION 'BG_AUTHORITY_TRANSITION';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bg_push_authority_transition_guard BEFORE UPDATE OR DELETE ON web_push_claims
 FOR EACH ROW EXECUTE FUNCTION bg_push_authority_transition_guard();

CREATE TABLE web_push_challenges (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 subscription_id TEXT NOT NULL,
 endpoint_hash TEXT NOT NULL REFERENCES web_push_claims(endpoint_hash) ON DELETE RESTRICT
   CHECK(endpoint_hash ~ '^[a-f0-9]{64}$'),
 expected_incarnation TEXT NOT NULL CHECK(expected_incarnation ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
 proof_hash TEXT NOT NULL CHECK(proof_hash ~ '^[a-f0-9]{64}$'),
 expected_revision BIGINT NOT NULL CHECK(expected_revision BETWEEN 0 AND 9000000000000000),
 operation_id TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 consumed_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(user_id,subscription_id) REFERENCES push_subscriptions(user_id,id) ON DELETE CASCADE,
 UNIQUE(user_id,operation_id),
 CHECK(expires_at>created_at)
);
CREATE INDEX bg_challenge_authority ON web_push_challenges(endpoint_hash,id);
CREATE INDEX bg_challenge_retention ON web_push_challenges(created_at,id);

CREATE TABLE web_push_setup_operations (
 challenge_id TEXT PRIMARY KEY REFERENCES web_push_challenges(id) ON DELETE CASCADE,
 endpoint_hash BYTEA NOT NULL CHECK(octet_length(endpoint_hash)=32),
 client_nonce_hash BYTEA NOT NULL CHECK(octet_length(client_nonce_hash)=32),
 session_hash BYTEA NOT NULL CHECK(octet_length(session_hash)=32),
 request_hash BYTEA NOT NULL CHECK(octet_length(request_hash)=32),
 auth_epoch TEXT NOT NULL CHECK(length(auth_epoch)=36),
 send_state TEXT NOT NULL DEFAULT 'RESERVED'
   CHECK(send_state IN ('RESERVED','ATTEMPTED','ACCEPTED','FAILED','UNKNOWN')),
 send_attempted_at_ms BIGINT,
 cancelled_at_ms BIGINT,
 handoff_hash BYTEA CHECK(handoff_hash IS NULL OR octet_length(handoff_hash)=32),
 handoff_client_id TEXT CHECK(handoff_client_id IS NULL OR length(handoff_client_id) BETWEEN 1 AND 256),
 handoff_until_ms BIGINT,
 handoff_consumed_at_ms BIGINT,
 handoff_count INTEGER NOT NULL DEFAULT 0 CHECK(handoff_count BETWEEN 0 AND 3),
 failed_confirm_count INTEGER NOT NULL DEFAULT 0 CHECK(failed_confirm_count BETWEEN 0 AND 5),
 confirm_hash BYTEA CHECK(confirm_hash IS NULL OR octet_length(confirm_hash)=32),
 result_generation TEXT,
 result_revision BIGINT CHECK(result_revision IS NULL OR result_revision BETWEEN 1 AND 9000000000000000),
 result_incarnation TEXT CHECK(result_incarnation IS NULL OR result_incarnation ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
 retain_until_ms BIGINT NOT NULL CHECK(retain_until_ms>0),
 CHECK((send_state='RESERVED' AND send_attempted_at_ms IS NULL)
    OR (send_state<>'RESERVED' AND send_attempted_at_ms IS NOT NULL)),
 CHECK((handoff_hash IS NULL AND handoff_client_id IS NULL AND handoff_until_ms IS NULL AND handoff_consumed_at_ms IS NULL)
    OR (handoff_hash IS NOT NULL AND handoff_client_id IS NOT NULL AND handoff_until_ms IS NOT NULL)),
 CHECK((confirm_hash IS NULL AND result_generation IS NULL AND result_revision IS NULL AND result_incarnation IS NULL)
    OR (confirm_hash IS NOT NULL AND result_generation IS NOT NULL AND result_revision IS NOT NULL AND result_incarnation IS NOT NULL))
);

CREATE TABLE web_push_delivery_control (
 id TEXT PRIMARY KEY CHECK(id='web_push'),
 state TEXT NOT NULL CHECK(state IN ('ACTIVE','CONFIG_PAUSED')),
 revision BIGINT NOT NULL CHECK(revision BETWEEN 1 AND 9000000000000000),
 config_epoch TEXT NOT NULL CHECK(config_epoch ~ '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),
 configuration_identity TEXT CHECK(configuration_identity IS NULL OR configuration_identity ~ '^[a-f0-9]{64}$'),
 pause_reason TEXT CHECK(pause_reason IS NULL OR pause_reason IN ('CONFIG_UNVERIFIED','HTTP_401','HTTP_403','REVISION_EXHAUSTED')),
 paused_at TIMESTAMPTZ,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 CHECK((state='ACTIVE' AND configuration_identity IS NOT NULL AND pause_reason IS NULL AND paused_at IS NULL)
    OR (state='CONFIG_PAUSED' AND pause_reason IS NOT NULL AND paused_at IS NOT NULL)),
 CHECK(pause_reason IS NULL OR pause_reason<>'CONFIG_UNVERIFIED' OR configuration_identity IS NULL)
);

-- Existing notification_deliveries and all its FKs/indexes remain in place.
-- Preflight requires it empty; no fabricated historical terminal clock.
ALTER TABLE notification_deliveries ADD COLUMN terminal_at TIMESTAMPTZ;
ALTER TABLE notification_deliveries ADD COLUMN admitted_lease_token TEXT
 CHECK(admitted_lease_token IS NULL OR
  (state='LEASED' AND lease_token IS NOT NULL AND admitted_lease_token=lease_token));


-- These guards do NOT auto-clear the marker. All state writers must SET it
-- NULL alongside lease clearing, including existing savedRunEvents.cancelPending.
CREATE FUNCTION bg_delivery_admission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.attempts IS DISTINCT FROM OLD.attempts
    OR (OLD.admitted_lease_token IS NULL AND NEW.admitted_lease_token IS NOT NULL) THEN
  IF NOT (OLD.state='LEASED' AND NEW.state='LEASED'
      AND OLD.lease_token IS NOT NULL AND NEW.lease_token=OLD.lease_token
      AND OLD.admitted_lease_token IS NULL
      AND NEW.admitted_lease_token IS NOT NULL
      AND NEW.admitted_lease_token=OLD.lease_token
      AND OLD.attempts<12 AND NEW.attempts=OLD.attempts+1) THEN
   RAISE EXCEPTION 'BG_DELIVERY_ADMISSION_TRANSITION';
  END IF;
 END IF;
 IF OLD.admitted_lease_token IS NOT NULL
    AND NEW.state='LEASED' AND NEW.lease_token IS NOT DISTINCT FROM OLD.lease_token
    AND NEW.admitted_lease_token IS DISTINCT FROM OLD.admitted_lease_token THEN
  RAISE EXCEPTION 'BG_DELIVERY_ADMISSION_REUSE';
 END IF;
 IF NEW.lease_token IS DISTINCT FROM OLD.lease_token AND NEW.admitted_lease_token IS NOT NULL THEN
  RAISE EXCEPTION 'BG_DELIVERY_ADMISSION_NEW_LEASE';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bg_delivery_admission_guard BEFORE UPDATE ON notification_deliveries
 FOR EACH ROW EXECUTE FUNCTION bg_delivery_admission_guard();

CREATE OR REPLACE FUNCTION bg_delete_target_claim() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE web_push_claims SET state='VACANT', incarnation=gen_random_uuid()::text,
  claim_revision=0, proof_hash=NULL, subscription_id=NULL,
  last_operation_id=NULL, confirm_hash=NULL, updated_at=clock_timestamp()
 WHERE subscription_id=OLD.id;
 RETURN OLD;
END $$;
CREATE TRIGGER bg_delete_target_claim BEFORE DELETE ON push_subscriptions
 FOR EACH ROW EXECUTE FUNCTION bg_delete_target_claim();

CREATE OR REPLACE FUNCTION bg_delivery_terminal_clock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.terminal_at IS NOT NULL THEN
  RAISE EXCEPTION 'BG_DELIVERY_CLOCK_SERVER_OWNED';
 END IF;
 IF TG_OP='UPDATE' AND OLD.state IN ('ACCEPTED','CANCELLED','DEAD','EXPIRED')
    AND NEW.state<>OLD.state THEN RAISE EXCEPTION 'BG_DELIVERY_TERMINAL_IMMUTABLE'; END IF;
 IF NEW.state IN ('ACCEPTED','CANCELLED','DEAD','EXPIRED') THEN
  IF TG_OP='UPDATE' THEN
   IF OLD.state IN ('ACCEPTED','CANCELLED','DEAD','EXPIRED') THEN
    IF NEW.state<>OLD.state THEN RAISE EXCEPTION 'BG_DELIVERY_TERMINAL_IMMUTABLE'; END IF;
    NEW.terminal_at:=OLD.terminal_at;
   ELSE NEW.terminal_at:=clock_timestamp(); END IF;
  ELSE NEW.terminal_at:=clock_timestamp(); END IF;
 ELSE NEW.terminal_at:=NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bg_delivery_terminal_clock BEFORE INSERT OR UPDATE ON notification_deliveries
 FOR EACH ROW EXECUTE FUNCTION bg_delivery_terminal_clock();
ALTER TABLE notification_deliveries ADD CONSTRAINT bg_delivery_terminal_shape
 CHECK((state IN ('ACCEPTED','CANCELLED','DEAD','EXPIRED'))=(terminal_at IS NOT NULL));
CREATE INDEX bg_delivery_terminal_purge ON notification_deliveries(terminal_at,id)
 WHERE state IN ('ACCEPTED','CANCELLED','DEAD','EXPIRED');

INSERT INTO web_push_delivery_control
 (id,state,revision,config_epoch,configuration_identity,pause_reason,paused_at)
 VALUES ('web_push','CONFIG_PAUSED',1,gen_random_uuid()::text,NULL,'CONFIG_UNVERIFIED',clock_timestamp());`;
const WEB_PUSH_AUTHORITY_SQLITE = `DROP TRIGGER bg_target_delete;
DROP TABLE web_push_setup_operations;
DROP TABLE web_push_challenges;
DROP TABLE web_push_claims;

CREATE TABLE web_push_claims (
 endpoint_hash TEXT PRIMARY KEY CHECK((length(endpoint_hash)=64 AND endpoint_hash NOT GLOB '*[^0-9a-f]*')),
 incarnation TEXT NOT NULL UNIQUE CHECK((length(incarnation)=36 AND incarnation=lower(incarnation) AND substr(incarnation,9,1)='-' AND substr(incarnation,14,1)='-' AND substr(incarnation,19,1)='-' AND substr(incarnation,24,1)='-' AND length(replace(incarnation,'-',''))=32 AND replace(incarnation,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(incarnation,15,1)='4' AND substr(incarnation,20,1) IN ('8','9','a','b'))),
 state TEXT NOT NULL CHECK(state IN ('ACTIVE','VACANT')),
 claim_revision BIGINT NOT NULL CHECK(claim_revision BETWEEN 0 AND 9000000000000000),
 proof_hash TEXT CHECK(proof_hash IS NULL OR (length(proof_hash)=64 AND proof_hash NOT GLOB '*[^0-9a-f]*')),
 subscription_id TEXT UNIQUE REFERENCES push_subscriptions(id) ON DELETE RESTRICT,
 last_operation_id TEXT,
 confirm_hash BLOB CHECK(confirm_hash IS NULL OR (typeof(confirm_hash)='blob' AND length(confirm_hash)=32)),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK(typeof(claim_revision)='integer'),
 CHECK((state='VACANT' AND claim_revision=0 AND proof_hash IS NULL
        AND subscription_id IS NULL AND last_operation_id IS NULL AND confirm_hash IS NULL)
    OR (state='ACTIVE' AND claim_revision BETWEEN 1 AND 9000000000000000
        AND proof_hash IS NOT NULL AND subscription_id IS NOT NULL
        AND last_operation_id IS NOT NULL AND confirm_hash IS NOT NULL))
);
CREATE INDEX bg_claim_vacant_due ON web_push_claims(state,updated_at,endpoint_hash);

CREATE TRIGGER bg_push_authority_transition_guard BEFORE UPDATE ON web_push_claims
 WHEN NEW.endpoint_hash<>OLD.endpoint_hash OR NEW.incarnation=OLD.incarnation
 BEGIN SELECT RAISE(ABORT,'BG_AUTHORITY_TRANSITION'); END;
CREATE TRIGGER bg_push_authority_delete_guard BEFORE DELETE ON web_push_claims
 WHEN OLD.state<>'VACANT'
 BEGIN SELECT RAISE(ABORT,'BG_ACTIVE_AUTHORITY_DELETE'); END;

CREATE TABLE web_push_challenges (
 id TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 subscription_id TEXT NOT NULL,
 endpoint_hash TEXT NOT NULL REFERENCES web_push_claims(endpoint_hash) ON DELETE RESTRICT
   CHECK((length(endpoint_hash)=64 AND endpoint_hash NOT GLOB '*[^0-9a-f]*')),
 expected_incarnation TEXT NOT NULL CHECK((length(expected_incarnation)=36 AND expected_incarnation=lower(expected_incarnation) AND substr(expected_incarnation,9,1)='-' AND substr(expected_incarnation,14,1)='-' AND substr(expected_incarnation,19,1)='-' AND substr(expected_incarnation,24,1)='-' AND length(replace(expected_incarnation,'-',''))=32 AND replace(expected_incarnation,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(expected_incarnation,15,1)='4' AND substr(expected_incarnation,20,1) IN ('8','9','a','b'))),
 proof_hash TEXT NOT NULL CHECK((length(proof_hash)=64 AND proof_hash NOT GLOB '*[^0-9a-f]*')),
 expected_revision BIGINT NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9000000000000000),
 operation_id TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 consumed_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 FOREIGN KEY(user_id,subscription_id) REFERENCES push_subscriptions(user_id,id) ON DELETE CASCADE,
 UNIQUE(user_id,operation_id),
 CHECK(expires_at>created_at)
);
CREATE INDEX bg_challenge_authority ON web_push_challenges(endpoint_hash,id);
CREATE INDEX bg_challenge_retention ON web_push_challenges(created_at,id);

CREATE TABLE web_push_setup_operations (
 challenge_id TEXT PRIMARY KEY REFERENCES web_push_challenges(id) ON DELETE CASCADE,
 endpoint_hash BLOB NOT NULL CHECK((typeof(endpoint_hash)='blob' AND length(endpoint_hash)=32)),
 client_nonce_hash BLOB NOT NULL CHECK((typeof(client_nonce_hash)='blob' AND length(client_nonce_hash)=32)),
 session_hash BLOB NOT NULL CHECK((typeof(session_hash)='blob' AND length(session_hash)=32)),
 request_hash BLOB NOT NULL CHECK((typeof(request_hash)='blob' AND length(request_hash)=32)),
 auth_epoch TEXT NOT NULL CHECK(length(auth_epoch)=36),
 send_state TEXT NOT NULL DEFAULT 'RESERVED'
   CHECK(send_state IN ('RESERVED','ATTEMPTED','ACCEPTED','FAILED','UNKNOWN')),
 send_attempted_at_ms BIGINT,
 cancelled_at_ms BIGINT,
 handoff_hash BLOB CHECK(handoff_hash IS NULL OR (typeof(handoff_hash)='blob' AND length(handoff_hash)=32)),
 handoff_client_id TEXT CHECK(handoff_client_id IS NULL OR length(handoff_client_id) BETWEEN 1 AND 256),
 handoff_until_ms BIGINT,
 handoff_consumed_at_ms BIGINT,
 handoff_count INTEGER NOT NULL DEFAULT 0 CHECK(handoff_count BETWEEN 0 AND 3),
 failed_confirm_count INTEGER NOT NULL DEFAULT 0 CHECK(failed_confirm_count BETWEEN 0 AND 5),
 confirm_hash BLOB CHECK(confirm_hash IS NULL OR (typeof(confirm_hash)='blob' AND length(confirm_hash)=32)),
 result_generation TEXT,
 result_revision BIGINT CHECK(result_revision IS NULL OR result_revision BETWEEN 1 AND 9000000000000000),
 result_incarnation TEXT CHECK(result_incarnation IS NULL OR (length(result_incarnation)=36 AND result_incarnation=lower(result_incarnation) AND substr(result_incarnation,9,1)='-' AND substr(result_incarnation,14,1)='-' AND substr(result_incarnation,19,1)='-' AND substr(result_incarnation,24,1)='-' AND length(replace(result_incarnation,'-',''))=32 AND replace(result_incarnation,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(result_incarnation,15,1)='4' AND substr(result_incarnation,20,1) IN ('8','9','a','b'))),
 retain_until_ms BIGINT NOT NULL CHECK(retain_until_ms>0),
 CHECK((send_state='RESERVED' AND send_attempted_at_ms IS NULL)
    OR (send_state<>'RESERVED' AND send_attempted_at_ms IS NOT NULL)),
 CHECK((handoff_hash IS NULL AND handoff_client_id IS NULL AND handoff_until_ms IS NULL AND handoff_consumed_at_ms IS NULL)
    OR (handoff_hash IS NOT NULL AND handoff_client_id IS NOT NULL AND handoff_until_ms IS NOT NULL)),
 CHECK((confirm_hash IS NULL AND result_generation IS NULL AND result_revision IS NULL AND result_incarnation IS NULL)
    OR (confirm_hash IS NOT NULL AND result_generation IS NOT NULL AND result_revision IS NOT NULL AND result_incarnation IS NOT NULL))
);

CREATE TABLE web_push_delivery_control (
 id TEXT PRIMARY KEY CHECK(id='web_push'),
 state TEXT NOT NULL CHECK(state IN ('ACTIVE','CONFIG_PAUSED')),
 revision BIGINT NOT NULL CHECK(revision BETWEEN 1 AND 9000000000000000),
 config_epoch TEXT NOT NULL CHECK((length(config_epoch)=36 AND config_epoch=lower(config_epoch) AND substr(config_epoch,9,1)='-' AND substr(config_epoch,14,1)='-' AND substr(config_epoch,19,1)='-' AND substr(config_epoch,24,1)='-' AND length(replace(config_epoch,'-',''))=32 AND replace(config_epoch,'-','') NOT GLOB '*[^0-9a-f]*' AND substr(config_epoch,15,1)='4' AND substr(config_epoch,20,1) IN ('8','9','a','b'))),
 configuration_identity TEXT CHECK(configuration_identity IS NULL OR (length(configuration_identity)=64 AND configuration_identity NOT GLOB '*[^0-9a-f]*')),
 pause_reason TEXT CHECK(pause_reason IS NULL OR pause_reason IN ('CONFIG_UNVERIFIED','HTTP_401','HTTP_403','REVISION_EXHAUSTED')),
 paused_at TEXT,
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 CHECK(typeof(revision)='integer'),
 CHECK((state='ACTIVE' AND configuration_identity IS NOT NULL AND pause_reason IS NULL AND paused_at IS NULL)
    OR (state='CONFIG_PAUSED' AND pause_reason IS NOT NULL AND paused_at IS NOT NULL)),
 CHECK(pause_reason IS NULL OR pause_reason<>'CONFIG_UNVERIFIED' OR configuration_identity IS NULL)
);

-- Existing notification_deliveries and all its FKs/indexes remain in place.
-- Preflight requires it empty; no fabricated historical terminal clock.
ALTER TABLE notification_deliveries ADD COLUMN terminal_at TEXT;
ALTER TABLE notification_deliveries ADD COLUMN admitted_lease_token TEXT
 CHECK(admitted_lease_token IS NULL OR
  (state='LEASED' AND lease_token IS NOT NULL AND admitted_lease_token=lease_token));


-- Explicit clears are required; SQLite CHECK is evaluated before any AFTER
-- trigger could repair an old cancellation statement. No BEFORE self-UPDATE trick.
CREATE TRIGGER bg_delivery_admission_guard BEFORE UPDATE ON notification_deliveries
 BEGIN
 SELECT CASE WHEN
  (NEW.attempts IS NOT OLD.attempts
   OR (OLD.admitted_lease_token IS NULL AND NEW.admitted_lease_token IS NOT NULL))
  AND NOT (OLD.state='LEASED' AND NEW.state='LEASED'
      AND OLD.lease_token IS NOT NULL AND NEW.lease_token IS OLD.lease_token
      AND OLD.admitted_lease_token IS NULL
      AND NEW.admitted_lease_token IS NOT NULL
      AND NEW.admitted_lease_token IS OLD.lease_token
      AND OLD.attempts<12 AND NEW.attempts=OLD.attempts+1)
 THEN RAISE(ABORT,'BG_DELIVERY_ADMISSION_TRANSITION') END;
 SELECT CASE WHEN OLD.admitted_lease_token IS NOT NULL
   AND NEW.state='LEASED' AND NEW.lease_token IS OLD.lease_token
   AND NEW.admitted_lease_token IS NOT OLD.admitted_lease_token
 THEN RAISE(ABORT,'BG_DELIVERY_ADMISSION_REUSE') END;
 SELECT CASE WHEN NEW.lease_token IS NOT OLD.lease_token
   AND NEW.admitted_lease_token IS NOT NULL
 THEN RAISE(ABORT,'BG_DELIVERY_ADMISSION_NEW_LEASE') END;
END;

-- Every SQLite connection MUST register zero-argument, non-deterministic
-- forge_web_push_incarnation() -> node:crypto.randomUUID() before this DDL
-- or any target deletion. No Math.random/randomblob substitute. Missing
-- function makes deletion fail, not silently lose authority. No IO in function.
CREATE TRIGGER bg_delete_target_claim BEFORE DELETE ON push_subscriptions
 FOR EACH ROW BEGIN
 UPDATE web_push_claims SET state='VACANT', incarnation=forge_web_push_incarnation(),
  claim_revision=0, proof_hash=NULL, subscription_id=NULL,
  last_operation_id=NULL, confirm_hash=NULL,
  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE subscription_id=OLD.id;
END;

CREATE TRIGGER bg_delivery_terminal_immutable BEFORE UPDATE OF state,terminal_at ON notification_deliveries
 WHEN OLD.state IN ('ACCEPTED','CANCELLED','DEAD','EXPIRED')
 BEGIN
 SELECT CASE WHEN NEW.state<>OLD.state
 OR (OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS NOT OLD.terminal_at)
 OR (OLD.terminal_at IS NULL AND NEW.terminal_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 THEN RAISE(ABORT,'BG_DELIVERY_TERMINAL_IMMUTABLE') END;
END;
CREATE TRIGGER bg_delivery_insert_clock_owned BEFORE INSERT ON notification_deliveries
 WHEN NEW.terminal_at IS NOT NULL
 BEGIN SELECT RAISE(ABORT,'BG_DELIVERY_CLOCK_SERVER_OWNED'); END;
CREATE TRIGGER bg_delivery_terminal_insert AFTER INSERT ON notification_deliveries
 BEGIN
 UPDATE notification_deliveries SET terminal_at=
 CASE WHEN NEW.state IN ('ACCEPTED','CANCELLED','DEAD','EXPIRED')
 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END WHERE id=NEW.id;
END;
CREATE TRIGGER bg_delivery_terminal_update AFTER UPDATE OF state ON notification_deliveries
 WHEN OLD.state NOT IN ('ACCEPTED','CANCELLED','DEAD','EXPIRED')
 BEGIN
 UPDATE notification_deliveries SET terminal_at=
 CASE WHEN NEW.state IN ('ACCEPTED','CANCELLED','DEAD','EXPIRED')
 THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NULL END WHERE id=NEW.id;
END;
CREATE TRIGGER bg_delivery_nonterminal_clock BEFORE UPDATE OF terminal_at ON notification_deliveries
 WHEN NEW.state NOT IN ('ACCEPTED','CANCELLED','DEAD','EXPIRED') AND NEW.terminal_at IS NOT NULL
 BEGIN SELECT RAISE(ABORT,'BG_DELIVERY_TERMINAL_SHAPE'); END;
CREATE INDEX bg_delivery_terminal_purge ON notification_deliveries(terminal_at,id)
 WHERE state IN ('ACCEPTED','CANCELLED','DEAD','EXPIRED');

INSERT INTO web_push_delivery_control
 (id,state,revision,config_epoch,configuration_identity,pause_reason,paused_at)
 VALUES ('web_push','CONFIG_PAUSED',1,forge_web_push_incarnation(),NULL,'CONFIG_UNVERIFIED',
 strftime('%Y-%m-%dT%H:%M:%fZ','now'));`;

const EPISODE_MIGRATION_VERSION = 'background-sync-event-episode-v1';
const EPISODE_SQLITE_COLUMN = "episode_started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP CONSTRAINT bg_jobs_episode_finite CHECK(typeof(episode_started_at)='text' AND julianday(episode_started_at) IS NOT NULL)";
function jobsBody(dialect, episode) {
  const body = (dialect === 'sqlite' ? sqliteSql() : POSTGRES_SQL)
    .match(/CREATE TABLE IF NOT EXISTS provider_event_jobs \(([\s\S]*?)\n\);/)[1];
  const column = dialect === 'sqlite' ? EPISODE_SQLITE_COLUMN
    : 'episode_started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() CONSTRAINT bg_jobs_episode_finite CHECK(isfinite(episode_started_at))';
  return episode ? body.replace(' UNIQUE(binding_id,object_type,object_id)', ` ${column},\n UNIQUE(binding_id,object_type,object_id)`) : body;
}
async function validateEpisodeShape(db, dialect, episode) {
  if (dialect === 'sqlite') {
    const row = await db.get("SELECT sql FROM sqlite_master WHERE type='table' AND name='provider_event_jobs'");
    const normalize = sql => compactSql(sql.replace(/CREATE TABLE IF NOT EXISTS/, 'CREATE TABLE').replace(/"provider_event_jobs"/g, 'provider_event_jobs'));
    if (!row || normalize(row.sql) !== normalize(`CREATE TABLE provider_event_jobs (${jobsBody(dialect, episode)})`)) throw blocked('EPISODE_SCHEMA');
    const due = await db.get("SELECT sql FROM sqlite_master WHERE type='index' AND name='bg_jobs_due'");
    if (!due || compactSql(due.sql.replace('IF NOT EXISTS ','')) !== compactSql('CREATE INDEX bg_jobs_due ON provider_event_jobs(state,available_at,id)')) throw blocked('EPISODE_INDEX');
  } else {
    // Compile the frozen authority into a temporary catalog reference instead
    // of guessing PostgreSQL's expression normalization. Temp tables cannot
    // reference permanent parents; the single real FK is validated separately.
    await db.exec(`CREATE TEMP TABLE bg_episode_expected_jobs (${jobsBody(dialect, episode).replace('REFERENCES strava_ingress_bindings(id) ON DELETE CASCADE','')}) ON COMMIT DROP`);
    const attributes = table => db.all(`SELECT a.attname AS name,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS required,
      pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=?::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[table]);
    const constraints = table => db.all(`SELECT contype,convalidated,condeferrable,condeferred,pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid=?::regclass AND contype<>'f' ORDER BY contype,definition`,[table]);
    if (JSON.stringify(await attributes('provider_event_jobs')) !== JSON.stringify(await attributes('pg_temp.bg_episode_expected_jobs'))
      || JSON.stringify(await constraints('provider_event_jobs')) !== JSON.stringify(await constraints('pg_temp.bg_episode_expected_jobs'))) throw blocked('EPISODE_SCHEMA');
    const fks = await db.all(`SELECT convalidated,condeferrable,condeferred,pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid='provider_event_jobs'::regclass AND contype='f'`);
    if (fks.length !== 1 || !fks[0].convalidated || fks[0].condeferrable || fks[0].condeferred
      || fks[0].definition !== 'FOREIGN KEY (binding_id) REFERENCES strava_ingress_bindings(id) ON DELETE CASCADE') throw blocked('EPISODE_SCHEMA');
    if (episode && !await db.get("SELECT oid FROM pg_constraint WHERE conrelid='provider_event_jobs'::regclass AND conname='bg_jobs_episode_finite' AND contype='c' AND convalidated")) throw blocked('EPISODE_SCHEMA');
    const due = await db.get(`SELECT i.indisvalid,i.indisready,i.indisunique,i.indpred IS NULL AS full,
      pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i
      WHERE i.indrelid='provider_event_jobs'::regclass AND i.indexrelid=to_regclass('bg_jobs_due')`);
    if (!due || !due.indisvalid || !due.indisready || due.indisunique || !due.full
      || !due.definition.endsWith('USING btree (state, available_at, id)')) throw blocked('EPISODE_INDEX');
    await db.exec('DROP TABLE pg_temp.bg_episode_expected_jobs');
  }
  const invalidClock = name => dialect === 'sqlite'
    ? `(typeof(${name})<>'text' OR julianday(${name}) IS NULL)` : `NOT isfinite(${name})`;
  const badInteger = name => dialect === 'sqlite' ? `typeof(${name})<>'integer' OR ` : '';
  if (await db.get(`SELECT id FROM provider_event_jobs WHERE ${invalidClock('first_seen_at')}
    ${episode ? `OR ${invalidClock('episode_started_at')}` : ''}
    OR ${badInteger('attempts')}attempts<0 OR ${badInteger('requested_revision')}requested_revision NOT BETWEEN 1 AND 9000000000000000
    OR ${badInteger('processed_revision')}processed_revision<0 OR processed_revision>requested_revision LIMIT 1`)) throw blocked('EPISODE_ROWS');
}
async function applyEpisode(db, dialect) {
  const recorded = await db.get('SELECT version FROM schema_migrations WHERE version=?',[EPISODE_MIGRATION_VERSION]);
  const present = (await columns(db,dialect,'provider_event_jobs')).includes('episode_started_at');
  if (!recorded && present) throw blocked('EPISODE_UNRECORDED_SCHEMA');
  if (recorded && !present) throw blocked('EPISODE_SCHEMA');
  await validateEpisodeShape(db,dialect,Boolean(recorded));
  if (recorded) return;
  if (dialect === 'postgres') {
    await db.exec(`ALTER TABLE provider_event_jobs ADD COLUMN episode_started_at TIMESTAMPTZ;
      UPDATE provider_event_jobs SET episode_started_at=first_seen_at;
      ALTER TABLE provider_event_jobs ALTER COLUMN episode_started_at SET NOT NULL;
      ALTER TABLE provider_event_jobs ALTER COLUMN episode_started_at SET DEFAULT clock_timestamp();
      ALTER TABLE provider_event_jobs ADD CONSTRAINT bg_jobs_episode_finite CHECK(isfinite(episode_started_at));`);
  } else {
    const dependents = await db.all("SELECT sql FROM sqlite_master WHERE tbl_name='provider_event_jobs' AND type IN('index','trigger') AND sql IS NOT NULL ORDER BY type,name");
    const names = (await columns(db,dialect,'provider_event_jobs')).join(',');
    await db.exec(`CREATE TABLE bg_episode_jobs (${jobsBody(dialect,true)});
      INSERT INTO bg_episode_jobs(${names},episode_started_at) SELECT ${names},first_seen_at FROM provider_event_jobs;
      DROP TABLE provider_event_jobs;
      ALTER TABLE bg_episode_jobs RENAME TO provider_event_jobs;`);
    for (const row of dependents) await db.exec(row.sql);
  }
  await validateEpisodeShape(db,dialect,true);
  await db.run('INSERT INTO schema_migrations(version) VALUES(?)',[EPISODE_MIGRATION_VERSION]);
}
async function migrateEpisodeSqlite(database) {
  if (database.isTransaction) throw blocked('SQLITE_TRANSACTION_ACTIVE');
  const db=sqliteAdapter(database);let begun=false,migrationError;
  if ((await db.get('PRAGMA foreign_keys')).foreign_keys !== 1) throw blocked('SQLITE_FOREIGN_KEYS_DISABLED');
  try {
    await db.exec('PRAGMA foreign_keys=OFF');
    await db.exec('BEGIN EXCLUSIVE');begun=true;
    await applyEpisode(db,'sqlite');
    if ((await db.all('PRAGMA foreign_key_check')).length) throw blocked('SQLITE_FOREIGN_KEYS');
    await db.exec('COMMIT');begun=false;
  } catch (error) {
    migrationError=error;
    if (begun && database.isTransaction) {
      try { await db.exec('ROLLBACK'); }
      catch (rollbackError) { migrationError=new AggregateError([error,rollbackError],'Episode migration rollback failed'); }
    }
    throw migrationError;
  } finally {
    try {
      await db.exec('PRAGMA foreign_keys=ON');
      if ((await db.get('PRAGMA foreign_keys')).foreign_keys !== 1) throw blocked('SQLITE_FOREIGN_KEYS_RESTORE');
    } catch (restoreError) {
      const error=blocked('SQLITE_FOREIGN_KEYS_RESTORE');
      error.cause=migrationError ? new AggregateError([migrationError,restoreError],'Migration and FK restoration failed') : restoreError;
      throw error;
    }
  }
}
const AUTHORITY_TABLES = ['web_push_claims','web_push_challenges','web_push_setup_operations','notification_deliveries'];
// Whitespace outside SQL literals is cosmetic; whitespace inside a literal is
// authority and must not be erased when comparing trigger/catalog definitions.
function authoritySqlIdentity(sql) {
  return String(sql).match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[^'"\s]+/g)?.join('').replace(/;$/, '') || '';
}
function authorityTableSql(dialect, successor, table) {
  const old = dialect === 'postgres' ? POSTGRES_SQL + '\n' + SETUP_SQL : sqliteSql() + '\n' + SETUP_SQL.replace(/BYTEA/g,'BLOB');
  const current = dialect === 'postgres' ? WEB_PUSH_AUTHORITY_PG : WEB_PUSH_AUTHORITY_SQLITE;
  const source = successor && table !== 'notification_deliveries' ? current : old;
  const match = source.match(new RegExp(`CREATE TABLE(?: IF NOT EXISTS)? ${table} \\([\\s\\S]*?\\n\\);`));
  if (!match) throw blocked('WEB_PUSH_REFERENCE');
  return match[0].replace(' IF NOT EXISTS','');
}
function registerWebPushIncarnation(database) {
  if (typeof database.function !== 'function') throw blocked('SQLITE_UUID_REGISTRATION');
  database.function('forge_web_push_incarnation', {deterministic:false}, () => require('node:crypto').randomUUID());
}
function authorityTriggerSource(dialect, successor) {
  if (successor) return dialect === 'postgres' ? WEB_PUSH_AUTHORITY_PG : WEB_PUSH_AUTHORITY_SQLITE;
  if (dialect === 'sqlite') return SQLITE_TRIGGERS.match(/CREATE TRIGGER bg_target_delete[\s\S]*?END;/)[0];
  return POSTGRES_SQL.match(/CREATE OR REPLACE FUNCTION bg_delete_target_claim\(\)[\s\S]*?END \$\$;/)[0]
    + '\n' + POSTGRES_SQL.match(/CREATE TRIGGER bg_delete_target_claim[\s\S]*?EXECUTE FUNCTION[^;]+;/)[0];
}
async function validateWebPushAuthority(db, dialect, successor) {
  const tables = [...AUTHORITY_TABLES, ...(successor ? ['web_push_delivery_control'] : [])];
  const current = dialect === 'postgres' ? WEB_PUSH_AUTHORITY_PG : WEB_PUSH_AUTHORITY_SQLITE;
  const controlExists = (await columns(db,dialect,'web_push_delivery_control')).length > 0;
  if (controlExists !== successor) throw blocked('WEB_PUSH_PARTIAL_SCHEMA');
  if(dialect==='postgres'&&!successor&&await db.get(`SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=current_schema() AND p.proname IN ('bg_push_authority_transition_guard','bg_delivery_admission_guard','bg_delivery_terminal_clock') LIMIT 1`))throw blocked('WEB_PUSH_PARTIAL_SCHEMA');
  if (dialect === 'sqlite') {
    const {DatabaseSync} = require('node:sqlite');
    const expected = new DatabaseSync(':memory:');
    try {
      registerWebPushIncarnation(expected);
      expected.exec('CREATE TABLE push_subscriptions(id TEXT PRIMARY KEY,user_id TEXT,UNIQUE(user_id,id));');
      for (const table of AUTHORITY_TABLES) expected.exec(authorityTableSql(dialect,false,table));
      expected.exec(authorityTriggerSource(dialect,false));
      expected.exec('CREATE INDEX bg_delivery_due ON notification_deliveries(state,available_at,id);');
      if (successor) expected.exec(current);
      const catalog = connection => connection.all(`SELECT type,name,tbl_name,sql FROM sqlite_master
        WHERE (tbl_name IN (${tables.map(()=>'?').join(',')}) AND sql IS NOT NULL)
        OR (type='trigger' AND name IN ('bg_target_delete','bg_delete_target_claim')) ORDER BY type,name`,tables);
      const normalize = rows => rows.map(row=>({...row,sql:authoritySqlIdentity(row.sql.replace(' IF NOT EXISTS',''))}));
      if (JSON.stringify(normalize(await catalog(db))) !== JSON.stringify(normalize(await catalog(sqliteAdapter(expected))))) throw blocked('WEB_PUSH_CATALOG');
    } finally { expected.close(); }
  } else {
    // Compile all affected references in pg_temp, including their FK parents.
    // Never alter/drop a real constraint to manufacture a matching catalog.
    const prefix='bg_wp_expected_';
    const parents=['users','push_subscriptions','activity_notification_events'];
    const names=[...parents,...tables];
    const rewrite = sql => {
      let out=sql;
      for(const name of names)out=out.replace(new RegExp(`\\b${name}\\b`,'g'),prefix+name);
      return out;
    };
    const normalize = value => String(value).replace(/pg_temp\./g,'').replace(/bg_wp_expected_/g,'');
    let referenceComplete=false;
    try {
      await db.exec(`CREATE TEMP TABLE ${prefix}users(id TEXT PRIMARY KEY) ON COMMIT DROP;
        CREATE TEMP TABLE ${prefix}push_subscriptions(id TEXT PRIMARY KEY,user_id TEXT,UNIQUE(user_id,id)) ON COMMIT DROP;
        CREATE TEMP TABLE ${prefix}activity_notification_events(id TEXT PRIMARY KEY,user_id TEXT,notification_id TEXT,UNIQUE(user_id,id,notification_id)) ON COMMIT DROP;`);
      for(const table of tables) {
        // Let PostgreSQL derive constraint-backed index names from the real
        // table name before isolating the reference. Prefixing first can make
        // its 63-byte name truncation differ from the actual catalog.
        await db.exec(rewrite(authorityTableSql(dialect,successor,table)).replace('CREATE TABLE '+prefix+table,'CREATE TEMP TABLE '+table).replace(/;$/,' ON COMMIT DROP;'));
        await db.exec(`ALTER TABLE pg_temp.${table} RENAME TO ${prefix+table}`);
      }
      if(successor) {
        for(const match of current.matchAll(/ALTER TABLE notification_deliveries[\s\S]*?;/g))await db.exec(rewrite(match[0]));
      }
      const attrs = table => db.all(`SELECT a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,
        pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=?::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[table]);
      const constraints = async table => (await db.all(`SELECT contype,convalidated,condeferrable,condeferred,pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid=?::regclass`,[table])).map(row=>({...row,definition:normalize(row.definition)})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
      for(const table of tables) {
        if(JSON.stringify(await attrs(table))!==JSON.stringify(await attrs('pg_temp.'+prefix+table))
          || JSON.stringify(await constraints(table))!==JSON.stringify(await constraints('pg_temp.'+prefix+table)))throw blocked('WEB_PUSH_CATALOG');
        if(await db.get(`SELECT 1 FROM pg_index WHERE indrelid=?::regclass AND (NOT indisvalid OR NOT indisready) LIMIT 1`,[table]))throw blocked('WEB_PUSH_INDEX');
      }
      const triggerSql=authorityTriggerSource(dialect,successor);
      const expectedTriggers=[...triggerSql.matchAll(/CREATE TRIGGER (\w+) (BEFORE [\s\S]*?) FOR EACH ROW EXECUTE FUNCTION (\w+)\(\);/g)]
        .map(match=>({name:match[1],definition:authoritySqlIdentity(match[0].replace('BEFORE UPDATE OR DELETE','BEFORE DELETE OR UPDATE'))})).sort((a,b)=>a.name.localeCompare(b.name));
      const actualTriggers=await db.all(`SELECT t.tgname AS name,pg_get_triggerdef(t.oid) AS definition,t.tgenabled,t.tgconstraint,
        p.prosrc,p.prosecdef,p.proconfig,p.provolatile,l.lanname,p.proname
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_language l ON l.oid=p.prolang
        WHERE n.nspname=current_schema() AND NOT t.tgisinternal AND
        (c.relname IN (${tables.map(()=>'?').join(',')}) OR t.tgname IN ('bg_target_delete','bg_delete_target_claim')) ORDER BY t.tgname`,tables);
      if(actualTriggers.length!==expectedTriggers.length)throw blocked('WEB_PUSH_TRIGGER');
      for(let i=0;i<actualTriggers.length;i++) {
        const row=actualTriggers[i],expected=expectedTriggers[i];
        const body=triggerSql.match(new RegExp(`CREATE (?:OR REPLACE )?FUNCTION ${row.proname}\\(\\) RETURNS trigger LANGUAGE plpgsql AS \\$\\$([\\s\\S]*?)\\$\\$;`))?.[1];
        if(row.name!==expected.name || row.tgenabled!=='O' || Number(row.tgconstraint)!==0 || row.prosecdef || row.proconfig!==null || row.provolatile!=='v' || row.lanname!=='plpgsql'
          || !body || authoritySqlIdentity(row.prosrc)!==authoritySqlIdentity(body)
          || authoritySqlIdentity(row.definition.replace(/public\./g,''))!==expected.definition)throw blocked('WEB_PUSH_TRIGGER');
      }
      const indexSql='CREATE INDEX bg_delivery_due ON notification_deliveries(state,available_at,id);\n'+(successor ? current : '');
      const indexes=[...indexSql.matchAll(/CREATE INDEX (\w+) ON (\w+)([\s\S]*?);/g)];
      for(const match of indexes) {
        await db.exec(`CREATE INDEX ${prefix+match[1]} ON ${prefix+match[2]}${match[3]}`);
      }
      // Compare both directions, including PostgreSQL's implicit primary and
      // unique indexes. A valid extra index is unsupported catalog state too;
      // it must not be silently dropped by the predecessor transformation.
      const indexCatalog = async (table,reference=false) => (await db.all(`SELECT c.relname AS name,
        i.indisunique,i.indisprimary,i.indisexclusion,i.indimmediate,i.indisvalid,i.indisready,i.indislive,i.indnullsnotdistinct,
        i.indisclustered,i.indisreplident,i.indnatts,i.indnkeyatts,
        i.indkey::text,i.indcollation::text,i.indclass::text,i.indoption::text,
        pg_get_indexdef(i.indexrelid) AS definition FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
        WHERE i.indrelid=?::regclass`,[table])).map(row=>({...row,name:reference?normalize(row.name):row.name,
          // Rewrite only the compiled reference's identifier header, never
          // actual index names or predicate/expression string literals.
          definition:row.definition.replace(/^(CREATE (?:UNIQUE )?INDEX )(\w+)( ON )(?:(?:public|pg_temp)\.)?(\w+)( USING )/,
            (_,create,name,on,target,using)=>create+(reference?normalize(name):name)+on+(reference?normalize(target):target)+using)}))
        .sort((a,b)=>a.name.localeCompare(b.name));
      for(const table of tables) {
        // CLUSTER / REPLICA IDENTITY are not encoded by pg_get_indexdef.
        // Compare table-level NONE/FULL as well as each index's flags. OIDs
        // identifying these relations and indcheckxmin (a transient MVCC/HOT
        // safety horizon) are deliberately not schema identities.
        const replication = name => db.get('SELECT relreplident FROM pg_class WHERE oid=?::regclass',[name]);
        if(JSON.stringify(await replication(table))!==JSON.stringify(await replication('pg_temp.'+prefix+table)))throw blocked('WEB_PUSH_INDEX');
        if(JSON.stringify(await indexCatalog(table))!==JSON.stringify(await indexCatalog('pg_temp.'+prefix+table,true)))throw blocked('WEB_PUSH_INDEX');
      }
      referenceComplete=true;
    } finally {
      // On a catalog failure the owning transaction rolls back these objects.
      // No CASCADE: unexpected dependencies fail closed as well.
      if(referenceComplete) {
        for(const table of [...tables].reverse())await db.exec(`DROP TABLE pg_temp.${prefix+table}`);
        for(const table of [...parents].reverse())await db.exec(`DROP TABLE pg_temp.${prefix+table}`);
      }
    }
  }
  if(successor && !await db.get("SELECT id FROM web_push_delivery_control WHERE id='web_push'"))throw blocked('WEB_PUSH_CONTROL_MISSING');
}
async function applyWebPushAuthority(db,dialect) {
  const recorded=Boolean(await db.get('SELECT version FROM schema_migrations WHERE version=?',[WEB_PUSH_AUTHORITY_VERSION]));
  await validateWebPushAuthority(db,dialect,recorded);
  if(recorded)return;
  for(const table of AUTHORITY_TABLES)if(await db.get(`SELECT 1 AS present FROM ${table} LIMIT 1`))throw blocked('WEB_PUSH_NONEMPTY_PREDECESSOR');
  if(await db.get('SELECT id FROM push_subscriptions WHERE active LIMIT 1'))throw blocked('WEB_PUSH_ACTIVE_PREDECESSOR');
  await db.exec(dialect==='postgres' ? WEB_PUSH_AUTHORITY_PG : WEB_PUSH_AUTHORITY_SQLITE);
  await validateWebPushAuthority(db,dialect,true);
  await db.run('INSERT INTO schema_migrations(version) VALUES(?)',[WEB_PUSH_AUTHORITY_VERSION]);
}
async function migrateWebPushAuthoritySqlite(database) {
  if(database.isTransaction)throw blocked('SQLITE_TRANSACTION_ACTIVE');
  const db=sqliteAdapter(database);let begun=false,migrationError;
  if((await db.get('PRAGMA foreign_keys')).foreign_keys!==1)throw blocked('SQLITE_FOREIGN_KEYS_DISABLED');
  try {
    await db.exec('PRAGMA foreign_keys=OFF');
    await db.exec('BEGIN EXCLUSIVE');begun=true;
    await applyWebPushAuthority(db,'sqlite');
    if((await db.all('PRAGMA foreign_key_check')).length)throw blocked('SQLITE_FOREIGN_KEYS');
    await db.exec('COMMIT');begun=false;
  } catch(error) {
    migrationError=error;
    if(begun&&database.isTransaction)try{await db.exec('ROLLBACK');}catch(rollbackError){migrationError=new AggregateError([error,rollbackError],'Web push authority rollback failed');}
    throw migrationError;
  } finally {
    try{await db.exec('PRAGMA foreign_keys=ON');if((await db.get('PRAGMA foreign_keys')).foreign_keys!==1)throw blocked('SQLITE_FOREIGN_KEYS_RESTORE');}
    catch(restoreError){const error=blocked('SQLITE_FOREIGN_KEYS_RESTORE');error.cause=migrationError ? new AggregateError([migrationError,restoreError]) : restoreError;throw error;}
  }
}
async function migrateBackgroundSyncPostgres(pool) {
  const result = await migrateBackgroundBasePostgres(pool);
  const client = await pool.connect(); const db = pgAdapter(client);
  try {
    await db.exec('BEGIN');
    await db.exec("SELECT pg_advisory_xact_lock(hashtext('background-sync-v2'))");
    await applyFence(db, 'postgres');
    await applyProviderLimits(db, 'postgres');
    await applyEpisode(db, 'postgres');
    await applyWebPushAuthority(db, 'postgres');
    await db.exec('COMMIT');
    return result;
  } catch (error) { await db.exec('ROLLBACK'); throw error; }
  finally { client.release(); }
}
async function migrateBackgroundSyncSqlite(database) {
  registerWebPushIncarnation(database);
  const result = await migrateBackgroundBaseSqlite(database);
  const db = sqliteAdapter(database); let begun = false;
  if ((await db.get('PRAGMA foreign_keys')).foreign_keys !== 1) throw blocked('SQLITE_FOREIGN_KEYS_DISABLED');
  try {
    await db.exec('BEGIN IMMEDIATE'); begun = true;
    await applyFence(db, 'sqlite');
    await applyProviderLimits(db, 'sqlite');
    if ((await db.all('PRAGMA foreign_key_check')).length) throw blocked('SQLITE_FOREIGN_KEYS');
    await db.exec('COMMIT'); begun = false;
    await migrateEpisodeSqlite(database);
    await migrateWebPushAuthoritySqlite(database);
    return result;
  } catch (error) {
    if (begun && database.isTransaction) await db.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { MIGRATION_VERSION, FENCE_MIGRATION_VERSION, LIMITS_MIGRATION_VERSION, EPISODE_MIGRATION_VERSION, WEB_PUSH_AUTHORITY_VERSION, migrateBackgroundSyncPostgres, migrateBackgroundSyncSqlite,
  _test: { providerId, bootstrapLinks, POSTGRES_SQL, SETUP_SQL, OWNED_TABLES } };
