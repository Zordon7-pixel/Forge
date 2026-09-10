# Activity-aware reduction: recovery and whole-withholding subset

Production parent: `2639173145914832db4c3064b7a221846a8898dc`.
Non-policy activity/missed-outcome base: `32610cb156d34df762a2c2eff2535b6bf1b39202`.

This document describes new, bounded reduction authority. It does **not** claim
complete public partial-and-whole strength withholding, clinical rehabilitation,
an observed-activity stress converter, independent code approval, or deployment.

## Recorded design decisions

Same independent Hermes mission: `20260909_234804_ca071a`.

- `HERMES-DESIGN-FORGE-ACTIVITY-REBALANCE-20260910-263-PARENT`: exact durable missed
  outcomes; workload and completion separated; fresh planning revision; canonical successor required.
- `HERMES-DESIGN-FORGE-ACTIVITY-AWARE-ADAPTATION-V1-20260910-263`: approved two
  reduction primitives, immutable predecessor caps, no headroom, full validation.
- `HERMES-POLICY-CLARIFICATION-FORGE-ACTIVITY-OBSERVED-COMPOSITION-V1-20260910`:
  approved physical observed evidence + existing actual-run protections + separately
  validated future canonical prescriptions. Explicitly prohibited observed runs/lifts
  being assigned legacy prescribed family vectors.
- `HERMES-DESIGN-CLARIFICATION-FORGE-STRENGTH-WITHHOLDING-REACHABILITY-20260910`:
  **NEEDS_POLICY for complete v1**. Existing reachable intents do not supply a
  compatible non-injury set-only partial reduction. Whole withholding is a permitted
  interim fallback; primitive-only partial tests are not a public positive.

These are design decisions, not exact-code/release verdicts. The complete receipts
are retained in the coordinator's `Agent-Shared/projects/FORGE-HERMES-ACTIVITY-*`
and `FORGE-HERMES-STRENGTH-REACHABILITY-2026-09-10.json` evidence files.

## Two distinct domains

`activityObservation` binds all owner-scoped canonical physical observations from
`goalBackwardEvidence.canonicalizeRunLoadInput`. Exact provider/source identities
deduplicate; date, title, and equal quantities do not. Duration, distance, effort,
pain, energy, HR, real instants, local dates, corrections, coverage, and revision
remain bound. Absent and valid-zero fields differ. Observed lifting retains only
known physical fields and qualified completion, never an invented strength vector.

`recentRunLoad.summarizeRecentRunLoad` receives canonical actual rows, with unchanged
hard/long/pain/energy and same-day protection rules. There is no new two-runs rule.
Unlinked and explicitly no-link running counts as workload, not prescribed completion.
Unknown effort is not inferred from average HR, title, or pace.

`goalBackwardRecoveryMaterial.evaluateMaterialDose` separately receives all distinct
current-week observed running meters plus remaining prescribed running meters.
Its legacy `completed_running_credit` name means the canonical physical lower bound
here, **not** completion of a scheduled session. A complete versioned observation
hash binds every sorted activity ID/count and the physical sum; the four-ID envelope
never silently truncates activities. A missing performance comparator may produce
`COMPARATOR_UNKNOWN`: this is disclosed, not fabricated into a safety ceiling or a
generation veto. Unknown future distance does not acquire a pace-derived distance.

Observed workload is never passed into `resolveSessionStress`,
`aggregateWeeklyStress`, `validateRollingHardDays`, or generic family interference.
The receipt explicitly states `FUTURE_PRESCRIPTION_NONINCREASE`,
`observed_v3_vector_state: NOT_AVAILABLE`, and
`absolute_observed_plus_future_v3_budget_claimed: false`.

## Recovery authority

`activity-aware-adaptation-v1` authenticates the accepted predecessor, not a client
description or newly generated source. For protected ordinary training with a fully
resolved canonical duration, the frozen coefficient is
`max(original_seconds / 4666, original_meters / 9656) / original_seconds`, using the
existing immutable running reference. Unknown original distance stays duration-only.
This is a versioned engineering unit conversion, not a validated medical threshold.

Child duration, known distance, speed, effort envelope, and every canonical stress
dimension may not increase. No numeric goal pace is copied into recovery. Existing
easy/recovery sources retain their original source/normalization coefficient and
original pool allocation; changing one member cannot reprice another. Every original
pool member remains represented, including explicit withheld rest dispositions.

Known canonical `heart_rate_range_bpm` bounds cannot be silently discarded. Current
running-dose authority does not authorize numeric-HR recovery targets; incompatible
HR sources therefore become whole withholding rather than borrowing RPE-only authority.
Unknown total duration fails closed. Existing useful presentation floors remain
unchanged: an eleven-minute filler is not accepted; a reduced source below its floor
becomes a zero-work rest disposition. Actual owned race sessions are not convertible.

## Strength authority and explicit public limitation

`distributed-strength-withholding-v1` binds the exact original distributed allocation
and every exercise's `original_sets = retained_sets + withheld_sets`. No exercise,
region, repetition, rest, load, effort, cadence, source, or allocation may be substituted.
Withheld work is not redistributed or rescheduled as debt. Below-floor retained
material becomes rest. Whole withholding has zero executable steps and a complete
original-plus-withheld ledger, not a replacement upper-body template.

Public capability currently reports:

- whole withholding: available;
- partial withholding: `UNAVAILABLE_NO_COMPATIBLE_SET_ONLY_INTENT`;
- partial primitive only: true;
- complete partial-and-whole acceptance claimed: false.

The existing moderate-injury intent simultaneously reduces sets and changes load,
RPE/RIR and progression. Keeping original RPE7–8 (or first-week6–7) beneath an injury
intent capped5–6 is prohibited. Existing lower-body protection proposes a different
upper template, also prohibited under retained-original authority. Both therefore
use whole withholding. Optional upper work supplies no partial set quantity.
Any new public set-only trigger/athlete selection requires separate authority.

## Full-program and fresh acceptance

The closed context binds owner, assignment, parent plan/revision/canonical hash,
input revision, full activity/safety/missed fingerprints, actual observation instant,
phone-local date/timezone, bounded window/expiry, exact affected IDs, goals and horizon.
The ephemeral signed observation ticket is outside canonical storage; the accepted
receipt stores authenticated values, not a reusable ticket. GET is non-mutating;
accept rereads inside the existing owner transaction and compares all fresh bindings.

Canonical reconstruction preserves every dated slot and full horizon. Rest is not
a run/lift frequency credit and has no executable work. Unaffected prescriptions
remain byte-equivalent except global revision/hash and authenticated lineage fields.
Repeat adaptations retain earlier reduction receipts through exact predecessor
lineage; unchanged completed prescriptions retain authenticated prior hashes.

Validation includes canonical graph/source authority, per-prescription vector and
physical caps, original placed daily/seven-day ceilings, existing interference,
rolling hard days, constraints/locks, changed presentation floors, qualified completion,
program count/occupancy reconciliation, and current actual-run protections. The
accepted predecessor is a transitive upper bound on its already-approved independent
source, never a new mutable source or observed headroom. Historical overage remains
in evidence; it cannot be undone and does not imply mandatory all-rest.

## User-facing semantics

Recording a missed outcome changes progress only, with exact readback; it never says
work moved when it did not. The canonical legacy reschedule entry point returns
explicit no-change/review. Canonical hybrid reconciliation records the athlete's
selected outcome without moving prescriptions; life-event/skipped is not completion.
Stale/offline/queued202 decisions cannot display success. Unsafe writes are not SW replayed.

Preview discloses actual before/after sessions and requested/delivered/completed/withheld
counts. Today, calendar, Brief and workout starts consume the accepted canonical
successor. Canonical family outranks old legacy labels, so a recovered long run is
not still displayed or counted as a long run.

## Evidence and limits

Named tests and acceptance gaps are mapped in
[activity-reduction-test-matrix.md](activity-reduction-test-matrix.md).
Local HTTP tests use only newly registered synthetic owners and real PostgreSQL,
routers, preview/apply/reload. Their advancing clock exists only in the test process.
Browser acceptance uses actual persisted synthetic HTTP receipts with intercepted
APIs; it is not live backend or physical-phone proof. Fresh-schema account deletion
has an unchanged parent `whoop_data` table failure; unique disposable DB teardown
is not misrepresented as successful account deletion. Deployment/live/phone gates
remain coordinator-owned and separate.
