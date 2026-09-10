# Materialized-program storage and rollback

The closed `materialized-program-storage-v1` tier applies only to validated `canonical_session_set` and `surface_manifest` artifacts with a complete-program contract, canonical session identity and content hashes. It supports at most 20 weeks, 280 sessions (20 × 7 × 2), two modalities per date and bounded canonical steps. A tag, self-hashed contract, padding or session count without valid executable canonical identity cannot opt into the tier.

JSON UTF-8 and PostgreSQL JSONB are different representations. Each has its own 4,194,304-byte ceiling. Other artifact kinds and legacy payloads retain 262,144 bytes. Application validation checks JSON; the transaction queries actual `pg_column_size(?::jsonb)` before any linked artifact insert. The database constraint independently limits physical JSONB. A controlled storage-limit error must retain the previous active plan. No large artifact is silently truncated.

Measured storage-bound structure (not an accepted training prescription): 20 weeks/280 sessions using real largest canonical session structures produced 2,204,474-byte JSON and 2,648,131-byte JSONB. The real unknown seven-run/seven-lift five-week HTTP fixture passed persistence. A separate malformed-volume negative used 3,914,393-byte JSON but 4,874,368-byte JSONB and was rejected before any artifact write. These measurements do not guarantee arbitrary user text fits the budget.

## Migration and rollback

Final candidate envelopes have the same 4,194,304-byte JSON ceiling only after complete-program contract, full canonical session/header identity, horizon and step bounds validate. Legacy and all other candidates retain 524,288 bytes. A server-owned preliminary constructor has a distinct in-memory brand and is never persistable; copying it removes the brand but cannot bypass final canonical validation. Mode off/shadow cannot opt legacy candidates into this preliminary path with a client flag.

The closed material-change binding remains limited to 16,384 physical JSONB bytes. Full-program comparisons compact their presentation list before storage, retaining the complete comparison hash, total count and explicit truncation flag. This does not truncate the executable plan or weaken apply identity. A physical JSONB preflight occurs before candidate mutation.

Accepted maximum-horizon HTTP reproduction: 20 weeks/263 canonical sessions, canonical set 1,897,981 JSON bytes / 2,270,544 JSONB bytes; manifest 1,867,283 / 2,237,479 bytes. Generation took 19,631 ms and exact apply 18,636 ms, below the explicit 90-second generation and 45-second apply deadlines. A separate 4,074,251-byte JSON / 4,990,956-byte physical JSONB payload was rejected before artifact writes. These are measured disposable fixtures, not a guarantee for arbitrary unbounded text.

`runAlwaysMigrations` installs the versioned constraint atomically and idempotently; replay is tested with accepted rows present. It does not rewrite, shrink or delete existing payloads.

Read-only rollback preflight:

```sql
SELECT COUNT(*) FILTER (WHERE pg_column_size(payload_json) > 262144) AS exceeds_legacy_storage,
       COUNT(*) FILTER (WHERE payload_json->>'program_storage_version' = 'materialized-program-storage-v1') AS versioned_program_rows,
       COALESCE(MAX(pg_column_size(payload_json)), 0) AS maximum_jsonb_bytes,
       COALESCE(MAX(octet_length(payload_json::text)), 0) AS maximum_jsonb_text_bytes
FROM planning_pipeline_artifacts;
```

Any oversized row prohibits restoring the legacy 256-KiB constraint. Even small versioned rows may be unreadable to old application code; any versioned program row prohibits an unreviewed old-code rollback. Preserve the new constraint and all program rows, disable new generation if necessary, and deploy a reviewed forward-compatible reader/recovery release. Never delete or truncate a user's accepted program to make a downgrade succeed. Only when both counts are zero may a separately authorized transactional schema downgrade be considered; re-run the preflight under the migration lock before changing constraints. This document is not authorization to perform a production downgrade.

The guarded integration gate performs the same count/max preflight, confirms accepted data is preserved by migration replay and proves physical rejection before writes. A source deployment and a database migration still require independent exact-commit release gates.
