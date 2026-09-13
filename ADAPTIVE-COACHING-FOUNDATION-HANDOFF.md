# Adaptive Coaching Phase 1 foundation — t_03cc77b1

Status: **patched**, uncommitted. Branch: `feat/adaptive-coaching-engine-phase1-shadow`.
This is the first bounded foundation slice (1A–1F and progression/feedback substrate for 1I/1M), not complete Phase 1 or a SHADOW rollout. Hermes retains board lifecycle, independent verification and commits.

## Changed files

Eight source/test files, plus this handoff (nine total):

- `backend/src/lib/goalBackwardContracts.js`: additive closed goal-gap/action unions and reason registry; original 69 required reasons and legacy feasibility/mode unions preserved.
- `backend/src/lib/goalBackwardEvidence.js`: opt-in enrichment of the existing athlete state before its existing hash/revision calculation; consecutive completed-week gate and conservative context safety.
- `backend/src/lib/goalBackwardDecisionEngine.js`: opt-in `phase_authority: 'adaptive-foundation-v1'` on the existing selector. State/readiness/foundation precede calendar taper outside the six-day race safety window; gap support gates event specificity. Default callers retain legacy behavior.
- `backend/src/lib/adaptiveCoachingGoalGap.js`: owned goal resolution, demand versus observed fitness, feasibility composition.
- `backend/src/lib/adaptiveCoachingProgression.js`: observed completion classification plus weekly ramp gates, family-level ADVANCE/HOLD/REGRESS/OMIT bounds.
- `backend/src/lib/adaptiveCoachingObjectives.js`: objectives, stress/capacity budgets and unplaced session selection contracts.
- `backend/src/lib/adaptiveCoachingFoundation.js`: pure orchestration and three linked artifact envelopes.
- `backend/test/adaptiveCoachingFoundation.smoke.js`: 12 assertion groups covering the foundation invariants and integration boundaries.

No routes, configuration, dependencies, native code, model routing, calendar schema, workout schema, or existing artifact kinds changed. Coordinator artifacts were not edited. No board operations, messages, commits, push, merge, deployment, LLM calls or database writes were performed.

## Exact integration API

Primary export from `backend/src/lib/adaptiveCoachingFoundation.js`:

```js
buildAdaptiveCoachingFoundation({
  snapshot,                  // existing EvidenceSnapshot, explicit timestamp/timezone
  context = {},              // current buildConcurrentContext shape
  stateOptions = {},         // existing buildAthleteState options
  goals = [], races = [],    // owner-scoped existing goal/race shapes
  completionPairs = [],      // linked prescribed canonical sessions + observed evidence
  weeklyMileageHistory = [], // oldest to newest completed weekly miles, not plan targets
  readinessTrend = null,     // existing weeklyRampEngine trend vocabulary
  feasibilityByGoal = {},   // existing evaluateGoalBackwardFeasibility inputs by goal ID
  phaseEvidence = {},        // development_gate_complete, peak_exposure_complete,
                             // safe_useful_peak_fits: established policy evidence only
})
// => deeply frozen { athlete_state, decision, artifacts }
```

Other exports:

```js
// adaptiveCoachingGoalGap.js
buildGoalGaps({ athleteState, goals = [], races = [], feasibilityByGoal = {} })

// adaptiveCoachingProgression.js
PROGRESSION_FAMILIES
progressionFamilyFor(workoutFamily)
buildFamilyProgression({ athleteState, completionPairs = [],
  weeklyMileageHistory = [], readinessTrend = null, phase })

// adaptiveCoachingObjectives.js
buildWeeklyObjectives({ athleteState, goalGaps, phaseDecision, progression })
buildSessionSelectionContracts({ athleteState, weeklyObjectives })

// goalBackwardContracts.js — additive exports
GOAL_GAP_STATUSES
PROGRESSION_ACTIONS
ADAPTIVE_FOUNDATION_REASON_CODES
```

`normalizeReasonCode` and the aggregate `REASON_CODES` recognize the new reasons. Existing `REQUIRED_REASON_CODES` and `REASON_CODE_FAMILIES` remain compatibility anchors.

Example call (from a backend integration module):

```js
const { buildAdaptiveCoachingFoundation } = require('./adaptiveCoachingFoundation');
const result = buildAdaptiveCoachingFoundation({
  snapshot, // already built with a fixed planning instant; never rebuild using new Date()
  context: {
    target: {
      runDaysPerWeek: 5, liftDaysPerWeek: 2,
      trainingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      maxSessionMinutes: 60,
    },
    safety: { activeInjury: false, comebackMode: false, injuryNotesPresent: false },
  },
  stateOptions: {
    trainingAgeClass: 'DEVELOPING',
    weeks: completedEvidenceWeeks, // buildAthleteState/classifyCompletedWeek shape
    previousState,                // preserve revision lineage when supplied
    performanceAnchors: [
      { evidence_id: benchmarkEvidenceId, goal_id: 'goal-1',
        specificity: 'SAME_DISTANCE', observation_kind: 'RACE', verified: true },
    ],
  },
  goals: [{ goal_id: 'goal-1', athlete_id: snapshot.athlete_id,
    event_kind: 'ROAD_SHORT', distance_miles: 6.2137119224,
    event_state: 'SCHEDULED', event_local_date: '2026-11-15', target_time_s: 3000 }],
  completionPairs: [{
    prescribed_session: acceptedCanonicalSession,
    observation: {
      evidence_id: completionEvidenceId, linked_session_id: acceptedCanonicalSession.session_id,
      observed_at: '2026-09-10T12:00:00Z', quality_state: 'COMPLETE',
      completed: true, observed_distance_m: actualDistanceMeters,
    },
  }],
  weeklyMileageHistory: [20, 20, 20, 20], readinessTrend: 'stable',
});
```

Performance anchor metrics, quality and observation dates come from canonical snapshot activities (including corrections), falling back to the referenced evidence envelope. Supplied anchor pace/time never supplies demonstrated fitness. Source references outside the snapshot fail. Completion pairs must be reconciliation-produced observations linked to accepted sessions; do not pass planned rows as observations. Context profile/target frequencies become integer capacities (run 0–7, lift 0–5). Missing capacity means zero. Observed recovery/options use the existing evidence builder; coarse context fitness/readiness guesses are not promoted into measured state. Current context injury flags can only tighten safety.

Condensed output shape:

```js
{
  athlete_state: {
    athlete_state_id, athlete_state_hash, athlete_state_revision,
    evidence_snapshot_id, consistent_weeks,
    recent_normal_running, cross_modal_recent_normal, performance_anchors,
    recovery_state, safety_action,
    adaptive_foundation: { capacities: { run: 5, lift: 2 }, completion_pairs, /* ... */ }
  },
  decision: {
    decision_id, decision_hash, phase, phase_reason_codes,
    goal_gap: [{ goal_id, goal_gap_hash,
      derived_target_pace_s_per_km, demonstrated_fitness,
      feasibility_status: 'NOT_CURRENTLY_SUPPORTED', training_pace_authority: false }],
    weekly_objectives: {
      weekly_objectives_hash, objectives, progression, capacities, weekly_stress_budget
    },
    session_selection: {
      contracts: [{ selection_id, role: 'PRIMARY_KEY', priority_score, priority_rank,
        objective_ids, workout_family, progression_family, progression,
        stress_vector, fatigue_cost, meaningful_dose, reason_codes }],
      deferred_objectives, used_capacity, unstacked_stress_vector,
      placement_validated: false
    }
  },
  artifacts: [evidenceSnapshotArtifact, athleteStateArtifact, planningDecisionArtifact]
}
```

`goal_gap` and `weekly_objectives` are typed embedded decision payloads, not new artifact kinds. The first three existing chain stages are returned with deterministic timestamps, hashes, IDs and parent links. No persistence occurs here. Later integration can use existing `persistPipelineArtifacts` with the remaining candidate/validator/canonical/manifest stages. This foundation decision is not a drop-in executable legacy candidate or calendar envelope.

## Behavior and remaining limits

- Same snapshot/options/revision predecessor produce identical state, decision and artifact hashes. Changed capacities or completion evidence change the state content/revision through the existing authority.
- Unknown observed load/fitness remains null. Road target pace is derived arithmetic; it is never an intensity prescription. An unsupported target cannot authorize event-specific progression. HYROX timed feasibility remains conservative until complete event-budget evidence is integrated.
- Policy exposure ordering supplies sport-specific objectives. Recovery, meaningful-dose floors, stress ceilings and progression compatibility filter candidate families. Frequency caps admission; it does not generate enough exposures to fill a quota. Deferred objectives remain explicit.
- The current selection is deterministic greedy admission in policy priority order, not the joint placement solver. Its vectors are unstacked family costs; materialized dose, daily surcharge, interference, spacing, availability, locks, hard-day caps and full workload intersection must still pass existing validators downstream.
- Progression uses distinct linked observed sessions and evidence, recent complete coverage, repeated on-target results, readiness and running ramp gates. Missing, partial, future, duplicate or merely planned outcomes cannot advance. Strain/recovery and repeated failed completion can regress; safety/phase can omit. No week index is accepted as advancement evidence.
- Family contracts cover aerobic volume, long run, threshold, speed/neuromuscular, strength, upper strength, HYROX skill and HYROX specificity. Strength/HYROX bounds currently concern duration exposure; external-load/set progression and taxonomy-level stride variants belong to subsequent materialization work. The canonical workout family registry was not expanded.
- Recovery objectives exist now; there are no scheduled REST days yet. No complete candidate, accepted manifest, Garmin export, solver validation, shadow telemetry, route comparison or PREVIEW/ON activation is claimed.
- New fixtures exercise sparse road, developing/established frequency constraints, recovery/returning behavior, timed endurance, short runway, dual-goal ownership/lifecycle and HYROX singles/doubles foundation differences. They are not the full eight-class valid-schedule acceptance gate; that requires solver/materialization.

Next worker: consume objective-linked selection contracts, solve joint placement using existing enumeration/constraints/validators, materialize existing canonical workouts with target authority and progression bounds, then complete the seven-stage chain. Only after that should a separate slice wire route SHADOW comparison. Existing off/shadow/preview/on callers remain authoritative and usable throughout.

## Validation

All final runs used Node **22.22.3** and a clean process environment. This checkout lacks node_modules. Existing canonical-repository backend dependencies were resolved read-only with NODE_PATH; a temporary `/tmp/adaptive-fit-loader.mjs` resolved the existing frontend FIT SDK for the canonical test. No dependency installation or package/lock changes occurred.

Passing new suite: `node backend/test/adaptiveCoachingFoundation.smoke.js` — **12 assertion groups**.

Passing existing `backend/test/*.smoke.js` suites:

- `goalBackwardContracts` (3), `goalBackwardPlanning` (44), `goalBackwardEvidence`
- `goalBackwardTargets` (18), `goalBackwardAdaptation` (14), `weeklyRampEngine`
- `planFeasibility` (86), `racePlanQuality` (including the exact regression/P0 guard)
- `planCandidateLifecycle`, `planPersistenceMigration`
- `goalBackwardGeneralization` (9 checks / 10 fixtures), `goalBackwardCanonical` (17)
- `goalBackwardGoalFloorRecovery`, `goalBackwardRecoveryMaterial` (34)
- `goalBackwardHyrox` (10), `goalBackwardRelease`

The first canonical run could not resolve the absent local ESM FIT SDK; it passed after read-only resolution through the temporary loader. Final test logs are `/tmp/adaptive-node22-<suite>.log`. `git diff --check` passes. No live/production QA or independent Hermes verification is claimed.
