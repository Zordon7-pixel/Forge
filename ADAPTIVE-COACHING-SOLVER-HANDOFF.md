# t_03cc77b1 — second bounded implementation slice

Status: **patched, uncommitted; bounded subset, not Phase 1 complete**. Hermes owns lifecycle and independent verification. Same branch `feat/adaptive-coaching-engine-phase1-shadow`, base commit `47ca307bd4f668ba9b45501da99c852295b7b816`. No route wiring, DB work, credentials, model calls, board/messaging, commits, push, merge, deploy, dependency/config/native changes. The pre-existing coordinator files remain untouched.

## Exact API

```js
const { buildAdaptiveCoachingCandidate, LIMITS } = require('./adaptiveCoachingSolver');
const result = buildAdaptiveCoachingCandidate({
  foundation, // deeply frozen buildAdaptiveCoachingFoundation(...) result
  // OR foundationInput: { ...the existing foundation arguments }, never both
  availability: {
    run: [{ start_at: '2026-09-14T06:00:00Z', end_at: '2026-09-14T08:00:00Z' }],
    lift: [{ start_at: '2026-09-14T17:00:00Z', end_at: '2026-09-14T18:00:00Z' }],
    blocked_dates: [],
    occupied_sessions: [], // complete canonical sessions, precise starts/durations
    locks: [], manual_edits: [], // current active normalized constraint shapes
  },
  search: { max_nodes: 8192 }, // optional; integer 1..8192, can only reduce bound
});
```

Windows require explicit offset-bearing timestamps; at most 28 per modality, within the seven local dates starting at the snapshot planning date. They cannot expand athlete-state day availability. Sessions start at window starts; arbitrary within-window time optimization is not implemented. Start/end intervals, timezone date, elapsed duration, past planning instant, modality, blocked dates, per-session limits and date-specific state time budgets are checked. Occupied sessions may extend six local dates on either side for boundary recovery/rolling checks. At most 28 occupied sessions; an unknown-duration occupied workout is rejected rather than treated as zero load. Use `blocked_dates` for all-day non-training commitments. Availability/occupancy must be supplied completely by the integration caller; absence of omitted history is not inferred.

Pass the current normalized active lock/edit set; this seam is not an M24-04 revision-row loader. It combines supplied constraints with `athlete_state.locks/manual_edits`. Session/prescription conflicts fail closed; it does not rewrite a locked accepted workout. Fixed family/session/requirement dates help prune placements, and the existing constraint validator checks the final result. Session IDs are new objective-derived IDs, not recycled accepted-plan IDs.

```js
// deeply frozen result
{
  status: 'VALID' | 'VALID_WITH_TRADEOFFS' | 'DEFERRED' | 'INFEASIBLE',
  applicable: boolean, // internal objective/safety result, NEVER apply permission
  decision: {
    decision_id, decision_hash, foundation_decision_hash,
    athlete_state_hash, phase, goal_gap,
    weekly_objectives: { /* foundation fields */ dose_policy, weekly_objectives_hash },
    session_selection: {
      weekly_objectives, entries, deferred_objectives,
      unused_running_duration_s, placement_validated: false
    },
    constraints_hash, search_limits, /* existing decision fields */
  },
  selected_candidate: null | {
    // existing materializeGoalBackwardCandidate shape
    sessions, canonical_sessions, canonical_session_set,
    canonical_plan, // existing schemaVersion: 2 envelope
    candidate_hash, material_change, validation,
    skeleton_sessions, /* existing candidate fields */
  },
  deferred_objectives, rest_days,
  event_execution_deferred,
  occupancy, // existing calendarOccupancy receipt for selected unplaced demand
  search: { expanded_nodes, node_limit, frontier, candidates, sessions,
    truncated, tested_candidates, rejection_counts, optimality_claimed: false },
  result_hash, artifacts,
  accepted_surface_manifest: null
}
```

`entries` are unplaced selection contracts: `selection_id`, `objective_ids`, `requirement_id`, `role`, `priority_score/rank`, `workout_family`, `progression_family`, `progression`, dose fields (`duration_s/distance_m/quality_work_s` or exercises), `dose_basis`, reasons. They are not another workout/export schema. `placement_validated:false` refers to this pre-placement selection only; executable candidate truth is `selected_candidate.validation`.

A missing mandatory objective produces no selected candidate, even when an easy-only alternative could pass physiological checks. A bounded search miss reports DEFERRED when truncated, without claiming proof of global infeasibility. A training-only taper candidate can be valid internally while `event_execution_deferred:true` and `applicable:false`; it is not a complete race-week execution plan. No consumer may ignore `applicable` or infer acceptance from a candidate/hash/artifact.

Other exports:

- `adaptiveCoachingSelection`: `POLICY`, `isRun`, `isStrength`, `buildAdaptiveSessionSelection(foundation)`.
- `adaptiveCoachingWorkouts`: `buildAdaptiveWorkoutMaterial(entry, decision, planningInstant)`.
- `adaptiveCoachingValidation`: `localDate`, `weekday`, `duration`, `demanding`, `lowerBody`, `normalizeSolverConstraints(state, availability)`, `validateAdaptivePlacement(sessions, constraints, state, weeklyObjectives, {complete})`, `validateAdaptiveCandidate(candidate, constraints, state, selection)`.
- Existing `goalBackwardValidators` additionally exports its unchanged `longestRequiredSeparation` function.

## Files — exactly ten source/test files, plus this receipt

1. `backend/src/lib/adaptiveCoachingSelection.js` — observed objective dose before identities/placements; aerobic partitions, joint priority, meaningful strength partitions and explicit deferrals.
2. `backend/src/lib/adaptiveCoachingWorkouts.js` — existing canonical targets and closed step graphs, source provenance and complete dose.
3. `backend/src/lib/adaptiveCoachingValidation.js` — actual temporal/occupancy/dose constraints plus existing canonical, required-exposure, floor, safety, interference, hard-day, workload and constraint validators.
4. `backend/src/lib/adaptiveCoachingSolver.js` — pure foundation-consuming seam, bounded priority search, canonical candidate, rest reasons, six artifacts.
5. `backend/src/lib/canonicalWorkout.js` — opt-in adaptive closed graph materialization; retain starts, objective/dose trace and criteria; strength adapter indexes actual exercise steps.
6. `backend/src/lib/strengthDoseAccounting.js` — actual mixed upper/lower full-body dose; explicit adaptive mobility bookends do not masquerade as working sets.
7. `backend/src/lib/goalBackwardLoad.js` — shared dose resolver; opt-in observed same-family total/work duration scaling for long/quality, used by both session and weekly aggregation. Ordinary callers retain prior accounting.
8. `backend/src/lib/goalBackwardValidators.js` — export existing separation policy function, no validator relaxation.
9. `backend/src/lib/goalBackwardContracts.js` — six additive deterministic rest reasons, existing required registry preserved.
10. `backend/test/adaptiveCoachingSolver.smoke.js` — schedule-level positive and negative assertions through real validators.

## Implemented behavior and evidence boundaries

- Foundation phase/goal gap are retained; neither `phaseForWeek` nor `runTypeFor` chooses identity or phase here. Existing route/off/shadow/preview/on authority is untouched.
- Weekly objective dose exists before session identity. Additional aerobic opportunities are bounded by observed weekly duration, actual typical run duration, meaningful floors, requested capacity and recovery. Training-gap forward seed constrains the stale historical median. Missing actual dose does not bootstrap arbitrary running mileage.
- Observed successful canonical completion, not elapsed week index, supplies quality/long identity and source dose. Quality advances only inside family bounds, regresses or holds; insufficient meaningful dose is deferred. Canonical dose is checked against selected dose and policy weekly demand, not just a nominal vector.
- One strength objective partitions an observed completed week's exercise sets across 0–5 meaningful exposures. Every partition retains at least two exercises with two sets each; source weekly sets are conserved where admitted. No fixed Upper/Lower weekday template is introduced. Existing distributed-strength receipts are validated when consuming such observed sources; no template receipt is fabricated for the new observed pool. Missing observed strength uses only a single four-set minimum maintenance exposure from the existing prescription policy, with explicit policy provenance. Observed regression reduces sets; external kg and set advancement remain held.
- All placements are candidate alternatives. A lexicographic inclusion mask preserves higher-priority keys/critical long before strength/supporting omissions. Search has at most 14 selected sessions, frontier 64, 8,192 expansions, 32 final materialized candidates. No optimum/completeness claim after pruning.
- Actual prescribed duration, distance, sets/reps/RPE and stack surcharge feed load validation. Easy/recovery reuse `runningDoseAccounting` with an independently selected pre-placement source. Full-body strength sums regional exercise dose; long/quality use the larger total/work duration ratio against observed same-family source. These are engineering accounting rules, not a validated injury-risk model or a new observed-v3 load source.
- Exact end-to-start recovery uses existing separation policy plus 48 hours between demanding runs, 24-hour protection around any lower-body work, and six-hour same-day separation. Existing interference and rolling caps still run. One session/modality/date, at most two sessions/date and at least one recovery date are enforced during search. Occupied current-week running consumes weekly running dose as well as stress/capacity.
- Road runs have warmup/main/cooldown; quality adds real recovery between bouts. Strength has canonical mobility bookends, exercise working sets, explicit rest and a three-second repetition-time scheduling budget. Rest has an empty canonical graph and specific reason codes. Hash/revision, purpose, objective trace, target provenance, adjustment/stop criteria and capability use existing canonical contracts.
- Targets currently use canonical resolver RPE fallbacks for all new runs. Thus easy/recovery/long are effort-primary, and quality never promotes HR or aspirational goal pace. Observed pace/zone hierarchy remains available in the existing resolver but is not yet forwarded by this seam.
- Taper uses the selected event-policy running factor conservatively as the training-dose envelope; it reduces lower fatigue and preserves a small observed quality touch when readiness and meaningful floors allow. Race execution itself is deferred; this is not a complete race-week solution.
- Six existing artifact kinds are returned for a valid candidate: evidence snapshot → athlete state → planning decision → candidate week → validator result → canonical session set. A failed candidate has only the first five. They are individually validated existing envelopes with deterministic parent links; no persistence occurs. There is deliberately no seventh accepted surface artifact in this internal/shadow seam. Garmin remains downstream, unchanged.

## Validation

Node `/Users/zordon/.local/bin/node`, v22.22.3, local installed node_modules, clean process environment (`env -i PATH=...`), no dependency changes.

New suite: **10 assertion groups**, including:

- deterministic schema-v2 complete candidate, canonical set, six valid artifact envelopes;
- 2/3/4/5/6 run capacities yielding distinct meaningful schedule counts within observed duration;
- 0/1/2/3/4/5 strength capacities against the same 24-set observed objective;
- observed threshold + long with full real-validator pass and effort-only targets;
- missing required family dose fails closed;
- per-modality windows, blocked dates, collisions, missing locks;
- no-baseline and bounded-search negatives;
- taper retains small intensity/frequency while reducing volume/lower fatigue, explicitly deferring the event;
- pinned long Tuesday and quality Friday, contradicting first-quality/last-long template assumptions;
- occupied-work running budget and unsupported HYROX failures.

Existing passing suites (logs `/tmp/adaptive-solver-<suite>.log`): `adaptiveCoachingFoundation`, `goalBackwardContracts`, `goalBackwardPlanning` (44, including interference/load/constraint gates), `goalBackwardCanonical` (17, including FIT identity), `goalBackwardTargets`, `racePlanQuality` (exact regression/P0), `goalBackwardGoalFloorRecovery`, `goalBackwardRecoveryMaterial`, `canonicalCombinedCache`, `goalBackwardAdaptation`, `goalBackwardGeneralization`, `planFeasibility`, `planCandidateLifecycle`, `goalBackwardRelease`. New log: `/tmp/adaptive-solver-test.log`. `git diff --check` passes. No production/live/full application QA or independent Hermes acceptance is claimed.

## Exact continuation receipt — do not wire routes yet

Task `t_03cc77b1`, continue from this uncommitted ten-file source/test subset on the same branch/base. Preserve the foundation commit and this internal API. This slice is at its file bound and stops short of full 1G–1L+1N coverage.

1. **Race/event execution and HYROX remain deferred.** Supply owned event material and verified observed station/cluster dose through existing canonical HYROX builders, taxonomy and event policy. Protect exact event date before any other key. Until that exists, event-in-window `applicable` must remain false; mandatory unsupported HYROX must retain no selected candidate. Do not rename easy work to satisfy those objectives.
2. **Joint redistribution variants:** current search varies placements/omissions of a fixed meaningful dose selection; it does not yet search reduced strength partitions or reduced run-dose alternatives before omission. Add bounded dose variants with unchanged observed pool authority and exact withheld-dose receipts. No legacy calendar patching.
3. **Progression:** carry finer repeat/set/load families and authenticated observed exercise-load capacity, repeat/recovery structure, success classifications across ordinary weeks. Current quality reconstructs two same-family bouts; it does not preserve every prior interval structure. External load/set advancement is held. Do not claim the complete 1I/1M feedback loop.
4. **Calendar/lifecycle:** load current revisioned locks/edits through existing owner-scoped normalization; add authenticated accepted-session preservation where needed. Window starts are currently fixed choices, not time optimization. Improve hard/easy intentional stacking only through existing explicit stack policy; never bypass recovery. Honor complete caller-provided boundary occupancy.
5. **Targets/presentation:** forward only evidence-backed existing target-resolver inputs for supported pace/reference/HR displays; retain effort authority rules. Specificity/event-policy taper needs full event-work integration before claiming 1L complete. No parallel Garmin export schema.
6. **Artifacts/SHADOW integration:** foundation snapshot sharing with legacy/new, full structured comparison telemetry and route shadow wiring remain next slices. Acceptance/apply/surface stage seven must come from real lifecycle acceptance, never be manufactured to make a chain look complete. This internal `applicable` boolean is not an apply binding.
7. Expand independent schedule acceptance across the full eight structural classes and multiweek boundaries after domain gaps close. Existing foundation eight-class coverage and legacy generalization tests do not prove this solver's full eight-class success. In particular sparse/returning lack of supported dose and HYROX are deliberately deferred here.

Source/test content receipt: `sha256:292695808d8c2f8b75e6105a209a6ee313aedce549e281ba1fddb42a4aaf1e67` (SHA-256 of lexicographically sorted relative path + NUL + file bytes + NUL, for the ten files listed above; excludes this handoff).
