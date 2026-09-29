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
    : ['bg_binding_insert','bg_binding_update','bg_token_delete','bg_token_update','bg_user_delete','bg_target_delete','bg_activation_immutable','bg_activation_no_delete'];
  const triggers = await db.all(dialect === 'postgres'
    ? "SELECT t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND NOT t.tgisinternal AND t.tgenabled='O'"
    : "SELECT name FROM sqlite_master WHERE type='trigger'");
  if (requiredTriggers.some(name => !triggers.some(row => row.name === name))) throw blocked('RECORDED_TRIGGER_MISSING');
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

async function migrateBackgroundSyncPostgres(pool) {
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

async function migrateBackgroundSyncSqlite(database) {
  if (database.isTransaction) throw blocked('SQLITE_TRANSACTION_ACTIVE');
  const db = sqliteAdapter(database);
  if (!(await db.get('PRAGMA foreign_keys')).foreign_keys) throw blocked('SQLITE_FOREIGN_KEYS_DISABLED');
  await db.exec('PRAGMA foreign_keys=OFF; BEGIN EXCLUSIVE;');
  try {
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
    return { applied: !recorded };
  } catch (error) { await db.exec('ROLLBACK'); throw error; }
  finally { await db.exec('PRAGMA foreign_keys=ON'); }
}

module.exports = { MIGRATION_VERSION, migrateBackgroundSyncPostgres, migrateBackgroundSyncSqlite,
  _test: { providerId, bootstrapLinks, POSTGRES_SQL, SETUP_SQL, OWNED_TABLES } };
