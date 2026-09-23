# Explicit canonical workout intent — local slice 3a

Patched/tested locally, not independently release-reviewed or deployed.

## Authority and contract

`workoutSemantics.js` provides optional `workout_semantics` version
`canonical-workout-intent-v1`: `primary_purpose` uses the existing canonical
running-family vocabulary; `primary_step_ids` identifies WORK leaves;
`accessories` contains explicit CADENCE_TECHNIQUE declarations with leaf IDs and
an existing source-evidence reference. `source` binds the server-prescription
authority, decision, objective IDs, target source-evidence IDs and exact step
graph hash. The enclosing owner-accepted canonical/artifact chain supplies
authority; this is not independent attestation of arbitrary client claims.

Main/accessory references must be valid, unique, disjoint, same-family run or
interval leaves with consistent roles. All such leaves must be covered; repeat
containers cannot be leaf references. Cadence accessories require an explicit
declaration, cadence target and matching provenance reference. Cadence presence
alone never establishes accessory intent. Graph depth/leaf/reference limits are
bounded; source/objective references cannot be silently replaced.

Optional step roles are now closed and type-consistent: WORK, WARMUP, RECOVERY,
COOLDOWN, MOBILITY, MANUAL_INSTRUCTION and ACCESSORY. The first group follows
existing producers/assessment exclusions; ACCESSORY requires validated intent.
Previously optional roles remain optional. Bogus roles are rejected, not repaired.

## Real producer and consumer wiring

The adaptive materializer emits intent from its actual server-owned graph and
objective links. It does not infer intent from title or legacy prose. Canonical
copy/rebinding carries explicit accessory metadata, updates referenced step IDs
and preserves targets/source provenance. Existing owned-event material carries
the validated semantic declaration into the copy path.

The completed-prescription reconstruction path currently regenerates targets
and scales WORK. It cannot coherently preserve accessory/cadence authority, so
the selector explicitly defers that objective with
STRUCTURED_ACCESSORY_RECONSTRUCTION_UNSUPPORTED (plus the existing dose reason),
and the builder defensively rejects the same input. No work is silently
simplified or scaled. This also guards an undeclared cadence target without
claiming that it is accessory work. Other objectives retain normal behavior.

Existing authorized REST/RECOVERY successor constructors remove or regenerate
only the changed successor's intent binding; the original prescription and
intent remain in its immutable reduction receipt. Their physiological policy
is unchanged. No running-dose topology or stress policy was extended.

Coaching Context v2 exposes explicit intent with an allowlisted read projection.
Absent or invalid intent remains MISSING; structured physiological stimulus also
remains MISSING. The read remains owner scoped and non-mutating.

## Identity, dosage and limitations

New intent metadata participates in the canonical hash; new plans/artifacts
therefore receive their correctly bound hashes. Old accepted sessions without
intent retain the same hash and are not rewritten/backfilled. Title changes
remain irrelevant. Annotation preserves the original step graph, time,
distance, targets, repeats, derived totals, stress and executable FIT instruction
representation (identity metadata intentionally differs).

An already-compatible explicit easy 50-minute graph with six 20-second cadence
accessories remains easy in the generic canonical contract, with all 3,120
seconds still counted as work. It still fails the stricter source-bound easy
dose topology check. This slice does not make that graph eligible for every
planning path. Structured race-rhythm intervals retain race-rhythm intent.
Mixed long/race-rhythm and mixed easy/interval contributors remain rejected.
No duration-weighted dominance rule, new stimulus, intensity threshold, stride
prescription, automatic recovery personalization or mixed-family stress
composition was added. Standalone catalog strides remain quality/speed.
Legacy prose-only strides are not synthesized into structured targets.

## Verification

`workoutSemantics.smoke.js` covers roles, disjoint/valid/bound references,
forged/mismatched sources, title independence, repeated cadence, retained
accessory load, copied graph remapping, strict mixed/easy-dose boundaries,
actual selector deferral and unchanged FIT instructions. Context's real
authenticated route fixture verifies source-bound intent, ownership and zero
read writes; legacy/invalid projections stay unknown. Existing canonical,
adaptive domain/solver/acceptance/preview/shadow/multiweek, running-dose,
execution/reconciliation, successor and planning regressions remain gates.

Synthetic domain/multiweek fixtures intentionally construct changed
prescriptions. They now explicitly rebuild their source binding instead of
retaining the old graph's metadata. Production validation was not weakened to
accept stale intent. No account/provider/production operations occurred.
