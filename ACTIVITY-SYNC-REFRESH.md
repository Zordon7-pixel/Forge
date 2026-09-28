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
