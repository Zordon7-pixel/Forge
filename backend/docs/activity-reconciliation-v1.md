# Activity reconciliation and durable missed outcomes

Parent: `2639173145914832db4c3064b7a221846a8898dc`.
Design receipt: `HERMES-DESIGN-FORGE-ACTIVITY-REBALANCE-20260910-263-PARENT`.
This is the non-policy tranche; it grants no new dose or recovery authority.

## Independent meanings

All observed running workload is normalized through `canonicalizeRunLoadInput`,
including explicit-unlinked recordings, attributed corrections, unknown metrics,
and proven provider duplicates. Same date or same dose alone does not deduplicate.
Duplicate observations retain the strongest saved athlete effort/pain evidence,
without counting their physical activity twice. Provider coverage remains unknown
when a complete interval was not actually supplied.

Completion is separate. Only an exact server-resolved owned session/date/plan
snapshot can qualify automatic easy-run completion. An old `scheduled_date`
fallback snapshot cannot. A run label, high RPE, or nearby date does not prove
interval/long/race execution. Explicit athlete completion is retained without
inventing an observed target ratio. Unlinked lifts and workouts count as evidence
but do not complete a nearby lift. Explicit lift reconciliation remains supported.
Conflicting explicit no-link intent inside one proven physical duplicate leaves
completion unconfirmed; it does not suppress a different physical linked activity.

Absence under incomplete coverage is unconfirmed, not a missed confession or zero
adherence. Confirmed missed counts require the exact persisted athlete outcome;
an existing explicit skip retains its prior reconciliation semantics.

## Missed outcome

`GET /plans/missed-sessions` exposes exact owned current/past eligible sessions.
`POST /runs/missed` requires validated phone-local clock, assignment/plan/version,
exact session ID/date/content hash and a closed reason. The owner-locked transaction
rechecks current completion, removals and planning constraints, then adds one
`missed-session-outcome-v1` record to `user_plans.progress_json`. A readback must
match before success. Exact replay is idempotent; conflicting outcome is 409.

The map is limited to 280 records, matching the complete-program session bound.
It is included in existing user-plan export/deletion coverage. It is not a new
unbounded history table. No accepted plan bytes, future dates, sets, or doses change
when recording a miss. “Sick” does not invent severity or two days of rest.

## Fresh decisions

Adaptation reads complete saved run fields, attributed corrections, lift/set
observations, local-date workout observations, health state and current check-ins.
The semantic fingerprint includes decision-relevant values and freshness classes;
irrelevant health transport timestamps cannot re-prompt a settled choice. A stricter
observation fingerprint and `planning_input_revision` bind preview acceptance.
Legacy check-ins affect freshness identity only, never physiological policy drivers.
Keep commits a decision without advancing planning authority. Accept records its
resulting plan identity so its own revision advance does not cause a repeat prompt.
Stored decisions without current evidence bindings must refresh before acceptance.

New canonical recovery/withholding reconstruction remains a separate reviewed
policy tranche. Legacy adaptation `after` objects are not new source authority.

## Evidence

- Parent real HTTP: reason-only missed request said “cleared … 2 days” while plan
  bytes were unchanged. Saved RPE9/severe-pain/low-energy was omitted from adaptation
  SQL and yielded no current proposal, though the existing load helper protected it.
- `activityReconciliation`, `activityCompletionAuthority`, `activityEvidenceProjection`
  normal smokes prove identity, workload, completion/unknown and SQL boundaries.
- `activityPersistence.integration.js` reuses the actual isolated PostgreSQL and
  registered HTTP complete-program harness. Its advancing clock is test-process-only;
  production has no date-validation override. 4/4 and 7/7 cover missed readback,
  no-change/replay/stale/foreign cases, real omitted/null/explicit run payloads,
  keep→GET no repeat and check-in change→fresh proposal→old accept rejection.
- The mobile browser test covers 320×568 and 393×874, selector/reasons, scrollable
  controls, load retry, queued202, refreshed409 and actual recorded copy.
- SW revision `forge-v9` makes missed and rescheduling writes replay-unsafe.

These are local synthetic tests, not production or phone acceptance.
