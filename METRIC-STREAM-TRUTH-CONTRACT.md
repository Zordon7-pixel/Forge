# Metric stream truth containment — local slice 2b0

Status: implemented locally; not release-reviewed or deployed. This is not an
interval comparator or proof that an athlete met a workout's intensity targets.

## Numeric points

`backend/src/lib/workoutMetricStreams.js` accepts exactly two-element `[time,
value]` arrays or `{t, v}` / `{time, value}` objects. Present `t`/`v` keys are
authoritative: an invalid primary value cannot fall through to an alias.
Native `ForgeHealthPlugin.swift` emits numeric points. Compatibility with prior
JSON/import callers retains signed decimal strings of at most 32 characters;
whitespace, exponent/hex forms, booleans, null, containers and nonfinite numbers
are not numeric evidence. Real zeros remain valid where the existing metric
range permits zero. Heart-rate zero, for example, remains out of range.

Existing metric ranges, 48-hour timeline / 300-second recovery bounds, rounding,
timestamp sort/last-duplicate-wins and 600-point deterministic downsampling are
preserved. The frontend parser now applies the same contract, including signed
zero normalization. Neither parser mutates its input.

## JSON version 2 and declared origin

Each retained metric has `metric_sources[metric]` with:

- `declared_source`: sanitized caller-declared text or null.
- `verification_status`: always `UNVERIFIED` in this implementation.
- `basis`: `DECLARED`, `LEGACY_GLOBAL_ONLY`, or `UNKNOWN`.
- `legacy_global_source`: retained only for `LEGACY_GLOBAL_ONLY`.

The top-level `source` is derived from metric origins: one common declaration,
`unknown` when all are unknown, or `mixed` for differing known/unknown origins.
It is not provider attestation. Arbitrary input verification flags are discarded.
An incoming v1 stream's explicit source is a declaration, not trusted identity.
An existing v1 row's global source cannot establish per-metric origin because
the old merger could relabel retained metrics; it remains legacy-only evidence.
No migration or backfill occurs. A wrapper/activity's source is not substituted
for a missing metric-stream declaration.

Enrichment replaces a metric's points and origin together; absent incoming
origin becomes unknown, never inherited. Other valid metrics and origins remain.
Empty/invalid enrichment cannot erase or relabel retained metrics. Repeated
normalization, JSON serialization and merge replay preserve the contract.

`routes/import.js` explicitly normalizes incoming declarations. Its existing
physical-claim `findRunById` lookup now selects `workout_metric_streams_json`;
otherwise replay/enrichment could drop retained metrics before merging. Existing
owner identity, correction authority and planning-input-revision semantics are
unchanged, including the existing revision advance on a claimed import replay.
Owner-scoped run detail returns the persisted contract. History still omits
large streams. Run detail labels metric sources as declared/unverified or
unknown, and no longer calls every timeline an Apple Watch timeline.

## Local evidence and limits

`backend/test/metricStreamTruth.smoke.js` exercises malformed array/object values,
legitimate zeros, bounds, legacy/mixed/missing/spoofed origins, merge preservation,
roundtrip/nonmutation and backend/frontend parity.

`backend/test/metricStreamImportRoutes.smoke.js` uses actual authenticated
Express import/detail handlers and disposable local SQLite transactions with
existing schema/startup DDL. It verifies persisted enrichment, replay, missing
origin, legacy read without backfill, foreign-owner isolation, one physical run
per owner/claim, unchanged plan/artifact/measurement state, and existing planning
revision behavior. It is not PostgreSQL lock/concurrency or native-device proof.

Regression gates include Apple Watch streams, Health import concurrency,
canonical run merge, activity identity/load, planning revision concurrency,
Garmin import coverage, actual shoe, execution truth, coaching context,
canonical/FIT export, frontend recap parsing and a production frontend build.
All are local/synthetic; no provider calls, real-account access or production
changes are part of these gates.

Already-coerced stored zeros cannot be distinguished from genuine zeros, and
lost historical source declarations cannot be recovered from the stored JSON.
This slice does not guess or backfill them. Server-verified metric provenance,
sample-duration/coverage, clock/pause semantics, canonical step-occurrence
alignment and interval target-success comparison remain missing. Stream presence
or a caller's declared provider name must not authorize quality progression.
