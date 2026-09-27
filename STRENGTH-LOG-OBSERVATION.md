# Stored strength-log observations

This bounded acquisition change fixes retrospective public `/workouts/strength`
entries being discarded because their sets were recorded after the declared
workout ended. It does **not** resolve first-plan generation or authorize a
four-run/four-lift prescription.

## Contract

`adaptiveCoachingSources.loadMeasuredSources` composes
`receipt.sessions[].log_observation` with version
`stored-strength-log-observation-v1` from owner-scoped stored sessions/sets.
It preserves declared occurrence separately from original database recording
timestamps. No stored rows are backdated or backfilled.

- `evidence_semantics: USER_RECORDED_LOG`, `verification: UNVERIFIED`,
  `origin: UNKNOWN`. Timestamp appearance does not identify a timer, import,
  sensor, or provider. An elapsed-time agreement is not provenance.
- Each set exposes exercise name, set number, repetitions, external load,
  recording timestamp/precision and usability. Zero external load is distinct
  from unknown load. Known sets/repertoire do not require known duration.
- `known_set_count` is a lower bound from this log only. Duplicate set identities,
  malformed measurements, or invalid chronology withhold the aggregate. These
  rows do not prove completeness of training history, physiological tolerance,
  prescribed-session adherence, interval success, or progression eligibility.
- `duration_s` remains UNKNOWN for the manual import's zero-duration placeholder,
  missing duration or inconsistent elapsed time. A positive stored duration is
  exposed only when it agrees with declared start/end; it remains unverified.
- Coverage remains UNKNOWN, prescription linkage UNSUPPORTED, canonical
  adherence and progression eligibility false. Session log observations do not
  enter COMPLETE lift envelopes or completion pairs. `sourceSupport` and its
  canonical-strength requirement are unchanged.

## Dates and recording clocks

Explicit-offset ISO and PostgreSQL timestamp strings are supported. Strict
SQLite `CURRENT_TIMESTAMP` text on **database recording fields only** means UTC
with second precision; subsecond ordering is not fabricated. Naive client
occurrence timestamps are rejected. Date-only occurrence is preserved as DATE,
not converted to a UTC instant.

The POST route has no authoritative athlete timezone. Its date-only bound rejects
dates future in every civil timezone (using the maximum +14 offset); acquisition
then requires the date not exceed the actual observation date in the planning
timezone or the requested planning window. Therefore a declaration that is today
in +14 but tomorrow in New York can be stored without being treated as observed
past training in the latter context. The route cannot prove a date-only occurrence
is nonfuture for a particular athlete without a timezone contract.

Malformed/future-instant POST input is rejected before writes or planning revision
mutation. Existing optional fields remain optional. This is not a rewrite of all
workout editing routes; corrupted edited rows are withheld on acquisition.

## Identity, bounds and tests

Existing owner/session joins, 64-session/8,192-set limits, correction rejection,
raw source hashing and planning-revision mutations remain in force. Source edits
and deletions change the receipt binding; old accepted artifacts are not changed.
New source snapshots include the versioned projection in their hash.

`backend/test/strengthLogAcquisition.smoke.js` exercises real authenticated public
routes on schema-derived disposable SQLite, native database clock representation,
historical and contemporaneous logs, start/sets/end, UTC/local-date boundaries,
PostgreSQL timestamp strings, malformed/future values with zero writes, unknown
duration/load, zero load, owner isolation, correction/edit/delete bindings and
unchanged canonical-strength gate. This is not a live PostgreSQL concurrency
test or a production first-plan acceptance witness.
