# Activity refresh — foreground correction

Local patch only. New branch is derived from live7d5c, without later planner/C1
changes. No native, backend, provider configuration, database or flag change.
Bryan's acceptance includes automatic closed-app import and a saved-run
notification. This foreground patch DOES NOT satisfy that background outcome.
Independent review, deployment, live checks and phone acceptance remain separate.

## Contracts

- Manual pull independently requests connected Strava on native and web, even
  when Apple fails or is unavailable. Explicit requests bypass the15-minute
  automatic successful-sync cooldown. Disconnected, failed, cancelled, malformed
  and partial results never establish successful-sync freshness.
- Concurrent Strava requests coalesce by captured account/login generation.
  Explicit pulls behind an automatic operation coalesce into one newer forced
  acquisition. Existing HTTP deadlines and server rate limits remain unchanged.
  No authorization/connection prompt is introduced.
- Apple availability/authorization is checked first. History gets priority over
  optional summary work, and the existing scoped HR-zone lookup is preserved.
  That optional HR request retains its existing HTTP timeout; no new HR policy
  or inferred zones are introduced. Summary/profile writes occur independently
  and cannot prevent importing known history workouts. Legacy summary-workout
  fallback remains available when history is empty/unavailable.
- One optional summary may remain unresolved; retries do not start another and
  consume the remaining native slot. The overall two-outstanding-call cap stays.
  A history hang plus summary hang can still exhaust native capacity; JavaScript
  cannot cancel native operations. No background-delivery claim is made.
- History checkpoint precedes native read; server-confirmed batches invalidate
  activity data immediately, even while summary is pending. History acknowledgment
  still requires complete import, no uncertain old history reads and successful
  checkpoint cleanup. Import-version upgrade still requires native schema6.
  Summary failure/pending yields overall partial, with unknown metrics retained
  as null. It is not complete health success or invented athlete evidence.
- Activity invalidation carries only source/account/generation, never tokens,
  samples or exception text. It is emitted after the server import response,
  not after mere provider discovery. It does not assert that a new row was
  inserted: replay/enrichment can also require refreshed data.
- Mounted RunHub, History and Dashboard subscribe to account-scoped persistence
  invalidation and refetch. Bursts during one refetch produce one follow-up;
  stale request responses, old logins and unmounted continuations are ignored.
  Existing History edits/filters are retained. No global remount, navigation,
  active-session mutation or form reset is attached to import events.
- The15-second gesture and120-second Apple operation deadlines stay unchanged.
  Pull status distinguishes pending, partial, error, disconnected and complete
  by source. Attempt-bound promise callbacks update late outcome copy; another
  overlapping sync cannot falsely complete the current gesture's status. Stopping
  the spinner is not treated as success. Dismissed status stays dismissed.
  Existing manual pull may remount its page once as before; import events do not.

## Evidence boundaries

`activitySyncRefresh.smoke.mjs` uses real imported modules/Axios with synthetic
native/API boundaries. Its duplicate Set is not database proof. Existing backend
healthImportConcurrency/canonicalRunMerge/provider/metric-stream suites separately
test local persistence and reconciliation. New authenticated mobile journeys use
the built React app, real native coordinator and synthetic native/provider/API
responses to prove mounted Run/History late updates and edit preservation. They
do not prove real HealthKit/Strava delivery or the installed phone binary.

There are no changes to physiological planning, source priority, workout
reconciliation, provider ingest schema, privacy permissions, HealthKit anchors
on the native side, webhooks or push notifications. Closed-app import and the
post-commit background saved-run notification require separate investigation
and implementation. Do not label this patch a verified phone resolution.

## Independent-review correction

A resolved HTTP request alone is not an Apple persistence acknowledgment.
Before publishing a batch, `importHealthWorkoutBatches` validates the actual
backend `importRows` accounting: integer nonnegative imported/skipped counts,
one uniquely indexed error per failed row, and exactly one terminal accounting
entry for each submitted row. Errors require the backend's index/error/code/
retryable shape; only `IMPORT_ROW_INVALID` is terminal/nonretryable. Failed rows
are not also counted as skipped. The optional identity receipt is separate
metadata, never a substitute for missing accounting. Malformed ACKs throw a
safe retryable client error with earlier valid batch totals preserved. They
cannot publish invalidation, clear the history checkpoint or certify schema6.
Valid acknowledged partial batches still publish their persisted changes while
retryable row failures retain the checkpoint. Existing terminal-invalid-row
completion semantics remain unchanged.

Every API request in the three mounted activity-refetch fanouts carries the
captured login generation, including Dashboard readiness and both daily-execution
reads. The shared daily-execution reader accepts an optional session without
changing its default behavior or normalization. Stale401 is contained before the
Axios interceptor can log out a successor login; state guards remain a separate
protection. Global API authentication policy is not changed.

Mounted browser coverage includes Dashboard persistence beyond the gesture
deadline with its open insights state retained and no navigation/remount, plus
every fanout endpoint held until account switch or same-account relogin and then
returned as401. These are synthetic API/native boundaries, not phone/background
acceptance. The independent cd4 review and its failing adversarial probe remain
part of the release evidence; successor review is still required.
