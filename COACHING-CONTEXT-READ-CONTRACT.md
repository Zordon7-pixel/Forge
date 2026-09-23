# Coaching Context read contract — local slices 6a / 6b

Status: implemented locally, not independently release-reviewed or deployed.
This is a bounded composition of existing records, not the complete Adaptive
Coaching or Shoe Intelligence feature. Overall bundle status remains PARTIAL.

## Endpoint and authority

`GET /api/coaching/context/:sessionId` requires the existing authenticated
owner session. No query parameters, caller owner, date override, acceptance,
hash or success flag are accepted. Responses are `private, no-store`.

The reader selects an owned active assignment and its owned training plan,
one applied candidate, the highest unambiguous surface revision and that
surface's exact seven-artifact parent chain. Existing artifact, candidate,
surface and canonical-set validators verify identity, hashes and revisions;
embedded plan session hashes must also agree. Unreferenced artifact history
cannot replace a parent. The existing pure surface predicate is shared with
the normal plan route; the image/telemetry-bearing current-plan reader is not
called. No plan repair, generation, adaptation application or writes occur.

HTTP 200 is a `coaching-context-v1` PARTIAL read, not permission to execute an
adaptation. `executable_authority` is always false. Unknown session returns
404; stale/corrupt/foreign/missing/legacy/bounded-out chains return 409 with an
explicit unavailable reason and no prescription. This only restricts this
read; it never changes or blocks plan creation, training or Garmin export.

For a future-effective active root, the reader follows only its bounded owned
`supersedes_user_plan_id` path to the first currently effective predecessor.
Every visited assignment and training plan must belong to the authenticated
owner. A predecessor path requires nonempty identical lineage IDs, unique
assignment/plan IDs, strict decreasing valid effective dates and positive
decreasing plan revisions. Root stays ACTIVE; every followed row must actually
be SUPERSEDED, never CLEARED. Missing/invalid dates or links, cycles, ambiguous
roots and depth overflow fail closed. Explicit invalid effective dates never
fall back; absent dates may use the persisted started-at date per lifecycle.
Selection uses the authenticated profile timezone, not a request date.

`effective-assignment-read-v1` is an internal proof of that complete path,
independently revalidated by the pure surface predicate's explicit opt-in.
Default plan consumers retain their original ACTIVE-only acceptance. Candidate,
surface and canonical binding checks are unchanged; the selected predecessor
still needs its APPLIED candidate and exact accepted artifact chain. No stored
status is relabeled. The response adds `effective_assignment_read` only for this
case: local date/timezone, path hash/depth, true SUPERSEDED status and reason.
On/after the successor effective date, only successor sessions are readable.
This is compatibility for persisted future-effective lineage, not historical
browsing or a change to the current immediate-apply plan writer.

## Composed sections

- Accepted identity and exact artifact receipt IDs/revisions/hashes.
- Planning-time athlete state, goals/gaps/phase, weekly objectives/stress
  budgets and persisted family progression actions where present. Missing
  optional fields stay null/MISSING. No fresh post-execution action is computed.
- Canonical family/role/phase/objective IDs, metric targets, recursive repeat
  steps, target provenance, prescribed stress vector and totals. Titles are
  deliberately excluded; no title or fastest-step inference is performed.
- Owned raw run observations and separately labeled reconciliation-effective
  totals, source IDs and correction IDs/revisions/values. Whole-run derived
  average pace is explicitly not interval target evidence. Missing/invalid
  measurements are not zero; a recorded zero remains VALID_ZERO.
- Existing exact run-link reconciliation; same-day similarity is not proof
  of completion. Existing immutable measured-receipt loading optionally scopes
  to the requested accepted session, including off-schedule runs and lifts.
  The latest corrected receipt supersedes aggregate fallback. Recorder work
  offsets prove neither interval intensity nor progression success. The
  recorder's synthetic noon marker is never exposed as an observed run time.
- Owned physical actual-shoe association only. Recommended, selected,
  requirement profile, history and travel remain separate explicit missing
  contracts. An unavailable gear lookup degrades gear, not the prescription.
- Prior/upcoming accepted prescribed sessions and observed runs/workout-session
  lifts. Reliable timestamps use an exact ±72-hour window. Date-only records
  are retained in the local ±3-day window with boundary uncertainty, never
  invented midnight/noon. Prescribed strength family/stress is distinct from
  observed strength distribution, which remains unknown here.

Planning-time state is never labeled current physiological state. A changed
planning-input revision is disclosed. Even matching revisions are labeled
PLANNING_TIME_ONLY. Provider confidence/coverage and unsupported rich interval
comparison are UNKNOWN/MISSING, not silently inferred.

## Privacy, limits and consistency

Every query is owner scoped and returns explicit columns. Responses use
allowlisted projections, not raw JSON spreads. No email, tokens, GPS, notes,
whole-user rows, raw provider blobs or unrelated health history are emitted.
Text is data, never agent instructions. No external sharing is performed.

At most 2 active assignments/candidates/surface heads are read to detect
ambiguity, at most 16 assignment rows (including the active root), then six
artifact parent lookups. Canonical sessions cap at 280. Observed
runs cap at 512 (57-day window plus explicit requested-session links),
corrections at 1000, and workout-session lifts at 256 in the context date
window. Scoped measured receipts permit one physical activity and 64 immutable
revisions; overflow is explicit receipt unavailability. Existing unscoped
receipt consumers retain their prior behavior. Context output caps at 64 with
`truncated` and pre-truncation count; other projection-array overflow rejects
the read rather than silently dropping required data. Response cap is 256 KiB.

SQL uses `octet_length(column::text)` before transporting large serialized
JSON (not compressed PostgreSQL physical size). Artifact/plan payload cap is
4 MiB; smaller physical/metadata columns have lower bounds. Oversized critical
plan/correction payloads fail closed rather than falling through to older
values. The SQLite tests emulate byte length, not PostgreSQL storage internals.

The reader fingerprints/rereads both acceptance and relevant physical,
correction, shoe-profile, receipt and owner-revision inputs. A concurrent
shoe-only edit is detected even though it correctly does not increment the
physiological planning revision. Changes return CONTEXT_CHANGED_DURING_READ.
This is bounded optimistic consistency, not a PostgreSQL repeatable-read
transaction or proof of serializability/ABA detection.

Aware ISO and PostgreSQL space-separated timestamps with explicit `+00` or
full offsets normalize to ISO. Naive/malformed times remain unknown; an
unverifiable artifact timestamp rejects acceptance rather than inventing a
zone. IANA timezone and local-date semantics are included.

`content_hash` hashes the entire projected content except itself and the
volatile `as_of` envelope. Revisions, acceptance, observed data, correction
and gear identity changes affect the hash. The effective-predecessor path and
selection date/timezone are hashed when applicable. Input row ordering does not.
The observation local date remains hashed because it changes window meaning.

## Witness and tests

`backend/test/fixtures/coaching-context-witness.json` is an exact synthetic
authenticated-route response. Its accepted fixture contains an ~86-minute,
7.5-mile long run; next-day recovery plus upper-body strength; and the next
primary quality session with nested repeats. This proves structured readability
of supplied accepted artifacts, not that a new personalized recovery policy
was implemented or that these fixture decisions were freshly generated.

`backend/test/coachingContext.smoke.js` tests real JWT HTTP + repository DDL in
disposable SQLite: zero SELECT-only side effects, scope/ownership, foreign and
tampered chains, history ancestry, repeated hashes, null/zero/invalid metrics,
repeat projection, no same-date guesses, corrections/raw-vs-effective totals,
actual-shoe authority/foreign denial/outage, bounded reads/output, aware/naive
timestamps, measured receipt correction/replay/corruption and read-time races.
The effective-assignment matrix uses independently accepted predecessor and
successor fixtures, New York/Tokyo midnight boundaries, requested-session
isolation, owner/lineage/date/status/revision/cycle/depth rejection, strict
default and invalid opt-in proofs, tampered acceptance and concurrent lifecycle
changes. Full visited assignment payloads and path metadata enter the existing
optimistic reread fingerprint; no PostgreSQL isolation proof is claimed.
Image/weather helpers and external/provider/AI/gear fetches fail the test if
invoked. No account/production calls occur. Relevant canonical/FIT, surface,
diagnostic, execution-truth, reconciliation, measured-recorder, actual-shoe
and gear-policy regressions remain release gates.

## Remaining gaps

Trusted interval-by-interval target comparison; structured stimulus/dominant
purpose/modification rules; live evidence-backed next-session decisions;
recovery-pattern learning; broader isolated lift-log context and actual muscle
distribution; full canonical shoe requirement/matcher/receipt/history/travel;
catalog discovery/currentness; frontend UI;
and PostgreSQL concurrency/integration verification remain unimplemented here.
No physiological thresholds, schema migration, feature flag, rollout, merge,
deployment or phone acceptance is included.
