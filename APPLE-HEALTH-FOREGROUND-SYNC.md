# Apple Health foreground sync — bounded web lifecycle repair

Status: patched locally; independent review, deployment and phone verification
are separate. No Swift/native bridge, schema, provider integration or flag change.

## Runtime contract

- `healthForegroundSync.js` owns foreground lifecycle triggers. Cold mount runs
  once; resume/periodic requests retain five-minute throttling. Workout observer
  events bypass that cooldown and persist an account-scoped pending marker.
  Events received while syncing coalesce into one subsequent read; even an
  already-forceFresh manual operation cannot acknowledge a later observer event.
- A marker is acknowledged only after a complete result and only if no newer
  marker replaced it. Partial/error work remains pending with a thirty-second
  retry backoff. Listener disposal removes timers and every asynchronously
  registered listener independently, including after a sibling registration fails
  synchronously. Registration invocation and asynchronous settlement are isolated
  per listener. Cleanup isolates thrown/rejected removals (including late handles),
  reports each failure, and remains idempotent. An underlying native removal that
  fails cannot be forced to succeed by JavaScript; disposed callbacks are inert.
- The shared service operation has a 120-second total deadline. The existing
  15-second pull-refresh deadline still releases the gesture first, without
  claiming sync success. Late valid completion within the operation deadline
  can still refresh the screen. Once the operation aborts, late continuations
  cannot write a profile, submit another batch, acknowledge history, change an
  upgrade/timestamp, cache a result or publish success.
- Login generation plus token/account identity fences the operation. Logout
  followed by login to the same account also invalidates the old operation.
  Scoped Axios requests recheck at dispatch, preventing token substitution;
  a stale scoped 401 cannot log out the successor. Already dispatched requests
  may have committed on the original account: cancellation is not rollback.
- Workout transfer checkpoints, import upgrades, cached persisted results and
  automatic sync timestamps are account-scoped. Old unscoped checkpoints or
  upgrades do not certify a new account. The absent scoped upgrade forces a
  full-history read. The device authorization hint remains device-scoped.
- Before a native history read can advance an anchor, its transfer checkpoint
  is durable. Partial imports retry full history; backend physical-activity
  reconciliation remains the idempotence authority, unchanged by this patch.
- The shipped native bridge has no cancellation method. At most two bridge
  calls may remain outstanding (original plus one recovery slot). Further
  requests fail promptly rather than accumulating native jobs. If an old history
  read remains unresolved, safe retries may import data but cannot acknowledge
  the anchor checkpoint; they remain partial/full-history-retryable. Native
  settlement restores capacity. Two permanently hung native calls cannot be
  repaired from JavaScript; this is an explicit remaining native limitation.
- Dashboard's native summary path uses this coordinator. Optional Strava
  enrichment no longer holds the Apple latch and also uses captured-session
  request/checkpoint fencing.

## Verification

`frontend/test/healthSyncLiveness.smoke.mjs` loads the real service/coordinator/
foreground helper and real Axios interceptors through Vite. Only native calls,
HTTP adapter, storage and clocks are synthetic. It covers observer within60s,
five-minute expiry, in-flight bursts, manual-to-observer freshness, partial and
transport failures, timeout recovery, late-anchor settlement, repeated hangs,
same/different-account login, mid-batch switch, permission escalation, gesture
deadline, listener teardown/remount and stale401/enrichment boundaries.

Its adapter's duplicate Set is simulated persistence, not database proof.
Existing backend `healthImportConcurrency.smoke.js` and
`canonicalRunMerge.smoke.js` provide separate real local reconciliation gates.
Frontend full smoke, build and mobile-browser core journeys are separate gates.
There are no production credentials, provider calls or real athlete records.

This is not proof of locked-phone background upload, HealthKit delivery timing,
the installed native binary, or Bryan's phone symptom being resolved. Native
observer/upload changes, if needed, require a separately authorized native slice.
