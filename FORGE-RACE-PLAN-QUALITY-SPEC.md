# Forged Hybrid Race Plan Quality and Goal-Backsolving Build Spec

> Date: 2026-08-07
> Status: specification only; no product code, deployment, or EAS build is authorized by this document.
> Product owner/tester: Bryan.
> Implementers: Codex build, independent Claude Code QA, Hermes review, Bryan device verification.

## Goal

Make every Forged Hybrid race plan safe, credible, explainable, and capable of preparing the athlete for the selected race goal. A session must not be called a long run merely because it is the last run slot in a week. A plan must not pass validation merely because its mileage changes are gradual.

The reported regression is the acceptance anchor:

- Current date: Friday, 2026-08-07.
- A partial current week contains a Sunday session labeled `Long aerobic run`.
- The prescription is approximately `0.9 mi / 30 min`.
- The plan is preparing for a sub-2-hour half marathon and then a 10-mile race.

That output is internally contradictory and is not a credible long run. This exact result must become impossible at generation and validation boundaries.

## Product truth

1. Forged Hybrid is a deterministic hybrid-training engine first. OpenAI may explain a validated plan or vary bounded coaching language, but an LLM must not decide weekly mileage, long-run dosage, quality frequency, race feasibility, or safety clamps.
2. Recent training is the safe starting point, not the full plan objective. The engine must build forward from validated current capacity and backward from race demands, then reconcile both curves.
3. A goal time is not automatically achievable. The product must classify it as `supported`, `stretch`, or `unsafe` from recorded evidence and time available.
4. A partial first week is a `Bridge Week`, not Week 1 of normal progression. It can contain fewer sessions and miles without corrupting the full block.
5. Safety changes dosage, timing, or goal feasibility. It must not silently produce a plan that cannot prepare the athlete for the race while still claiming the goal is protected.
6. Motivational workout names may remain, but canonical workout type and purpose must always remain visible and machine-readable.
7. Forged Hybrid may apply public research and coaching principles. It must not copy proprietary plan tables, protected wording, or elite volume into a recreational athlete's plan.

## Verified current architecture

The active race-plan path is already deterministic:

- `backend/src/routes/plans.js:3131-3218` owns two-race generation, calls `buildConcurrentPlan`, validates it, and persists it with `generation_source: 'evidence_engine'`.
- `backend/src/lib/concurrentPlan.js:488-515` starts weekly mileage at the recent baseline and grows it by 6% or 8%, with deload/taper/race reductions.
- `backend/src/lib/concurrentPlan.js:529-590` protects completed runs and remaining legal weekdays in the current partial week.
- `backend/src/lib/concurrentPlan.js:592-603` labels the final scheduled run slot `long`, regardless of allocated distance or duration.
- `backend/src/lib/concurrentPlan.js:670-715` allocates about 42-45% of scheduled weekly mileage to that final slot.
- `backend/src/lib/concurrentPlan.js:718-729` forces a long-run duration to at least 30 minutes even when the allocated distance is very short.
- `backend/src/lib/concurrentPlan.js:1456-1491` subtracts completed current-week mileage before allocating the remaining sessions.
- `backend/src/lib/concurrentPlan.js:1716-2040` validates schedule, safety, race dates, goal-pace presence, progression, deload, taper, course truth, and strength conflicts, but does not validate long-run semantic credibility or goal-backward race readiness.
- `backend/src/lib/runWorkoutTaxonomy.js` already owns stable workout IDs and complete deterministic prescriptions.
- `backend/src/lib/trainingEvidence.js` already owns the checked-in evidence registry and the distinction between research and public athlete/coaching examples.
- `frontend/src/components/calendar/ForgedCalendar.jsx` already provides Week, Overview, and Month surfaces.

This work extends those modules. It must not create a second plan model, another calendar, or another evidence registry.

## Root cause

The current validator answers mostly: "Is this plan internally shaped and safely ramped from the recent baseline?"

It does not fully answer:

- Is each workout's label true for its dosage?
- Is time consistent with distance and the athlete's recorded pace anchor?
- Does the long-run curve reach a race-appropriate peak?
- Is there enough time to move from the current long run and weekly volume to that peak safely?
- Does the quality mix develop the pace and terrain demands of this race?
- Is the requested goal supported by actual performances?
- If it is not supported, did the athlete receive an honest choice instead of a misleading plan?

Changing the OpenAI model will not fix this. The failing plan was produced by deterministic source code.

## Locked P0 regression fixture

The first implementation commit must check in this exact redacted fixture. Do not replace it with a looser approximation of the screenshot.

```json
{
  "todayISO": "2026-08-07",
  "profile": {
    "weekly_miles_current": 16,
    "run_days_per_week": 4,
    "lift_days_per_week": 0
  },
  "target": {
    "raceId": "ten",
    "raceName": "Ten",
    "raceDate": "2026-10-11",
    "distanceMiles": 10,
    "goalType": "pr",
    "goalTimeSeconds": 5220,
    "raceTargets": [
      {
        "raceId": "half",
        "raceName": "Half",
        "raceDate": "2026-09-20",
        "distanceMiles": 13.109,
        "goalType": "pr",
        "goalTimeSeconds": 7200
      },
      {
        "raceId": "ten",
        "raceName": "Ten",
        "raceDate": "2026-10-11",
        "distanceMiles": 10,
        "goalType": "pr",
        "goalTimeSeconds": 5220
      }
    ],
    "weeks": 10,
    "startDate": "2026-08-03",
    "planMode": "run_only",
    "trainingDays": ["Mon", "Thu", "Fri", "Sun"],
    "runDaysPerWeek": 4,
    "liftDaysPerWeek": 0
  },
  "history": {
    "weeklyMileageBaseline": 16,
    "recentRunCount": 12,
    "recentLiftCount": 0,
    "performanceProfile": {
      "targetAnchor": {
        "equivalentTimeSeconds": 5400,
        "equivalentPaceSecondsPerMile": 540,
        "date": "2026-07-20",
        "kind": "race"
      }
    },
    "acuteRunLoad": {
      "available": true,
      "protection": { "active": false },
      "currentWeek": {
        "startDate": "2026-08-03",
        "runCount": 2,
        "runDates": ["2026-08-03", "2026-08-06"],
        "miles": 13.8,
        "longRunCompleted": false
      },
      "latestRun": {
        "date": "2026-08-06",
        "distanceMiles": 3,
        "paceSecondsPerMile": 600
      }
    }
  },
  "recovery": { "state": "normal", "available": true, "metrics": {} }
}
```

Current `main` produces:

```json
[
  { "date": "2026-08-07", "type": "quality", "workout_id": "strides", "miles": 1.3, "min": 35 },
  { "date": "2026-08-09", "type": "long", "workout_id": "long_aerobic", "miles": 0.9, "min": 30 }
]
```

`validateConcurrentPlan(plan, context)` currently returns `{ "valid": true, "errors": [] }`. P0 must assert that exact pre-fix behavior, and P2 must make the second session fail `LONG_SEMANTIC_MINIMUM` or rebuild it as a non-long session with a matching canonical prescription.

## Non-goals

- No new AI call, model, dependency, native plugin, database provider, or external API.
- No medical diagnosis or injury clearance.
- No automatic replacement of an active user's plan during rollout.
- No blanket 10% rule presented as a universal physiological law.
- No copying of Nike, Runna, Garmin, coach, or athlete plans.
- No attempt to guarantee a PR.
- No new features outside plan quality, plan explanation, and tester diagnostics.

## Canonical definitions

### Bridge Week

The phone-local calendar week containing plan generation when the phone-local date is later than Monday or meaningful activity has already been recorded in that week. Bridge status is date-derived even when `acuteRunLoad.currentWeek` is absent.

- It is labeled `Bridge Week` in UI and payload.
- It is excluded from full-week frequency and normal progression comparisons.
- It preserves recorded work and schedules only legal remaining sessions.
- It must not fabricate a long run from leftover mileage.
- A remaining-day long run is allowed only when it passes the same semantic and safety policy as a full-week long run. Otherwise it is rebuilt from the canonical easy/recovery/steady prescription.
- If no credible long-run slot remains, the long-run curve starts in the first full week.
- The first Monday after Bridge Week restores the selected run-frequency floor, strength floor, phase policy, and full-week mileage comparison. Bridge reductions must not leak forward.

#### Phone-local authority contract

Plan preview requests submit:

```json
{
  "planning_date_local": "2026-08-07",
  "timezone_offset_minutes": 240
}
```

Rules:

1. `planning_date_local` is required for plan preview/rebuild and must be a real `YYYY-MM-DD` date.
2. Reuse `normalizePlanningDate`; accept only the server-local date or one calendar day on either side. Reject invalid/out-of-window values with `400`, never silently replace them with server time.
3. `timezone_offset_minutes` must be an integer from `-840` through `840`. It is provenance only; it never overrides the submitted local date.
4. Persist the accepted local date and offset in the candidate input snapshot and generation trace. Apply uses the same date; if the phone date changes before apply, return `409 CANDIDATE_STALE` and require a new preview.
5. Bridge status is true when `planning_date_local > mondayFor(planning_date_local)` or when a trusted recorded activity exists from Monday through the planning date.
6. Elapsed dates are never backfilled with planned sessions. Today may be used only when the activity/safety checks allow it.

### Long run

A race-preparation endurance session whose dosage is meaningfully longer than the athlete's ordinary easy run and contributes to the block's validated long-run progression.

A session may use `type: 'long'` and `workout_id: 'long_aerobic'` only when all are true under `RACE_PLAN_POLICY_V1`:

1. It meets the athlete-relative minimum from recent meaningful runs.
2. It meets the race-relative phase minimum.
3. Its prescribed time and estimated distance agree within the configured tolerance.
4. It belongs to the current validated long-run curve.
5. It is not a leftover-mileage artifact in a Bridge Week.

If these conditions are not met, rebuild the complete session from the canonical `easy_aerobic`, `recovery_run`, or steady prescription. Changing only `type`, title, or `workout_id` is invalid. Never inflate distance merely to preserve the word `long`.

### Quality run

A run whose canonical taxonomy is marked quality, including hills, intervals, threshold, progression, race pace, sharpening, or a benchmark. Quality identity comes from stable workout ID, not title parsing.

### Goal feasibility

- `supported`: both pace evidence and workload reachability are supported by the versioned policy.
- `stretch`: at least one dimension is stretch, neither is unsafe, and the plan contains a deterministic reevaluation checkpoint.
- `unsafe`: pace demand or workload demand cannot be reached within the policy without violating safety constraints. The engine offers alternatives instead of pretending to protect the goal.

Pace evidence and workload reachability are computed separately. The combined result uses the more conservative state: `unsafe > stretch > supported`.

## Versioned deterministic policy

Add a pure checked-in policy module, `backend/src/lib/racePlanPolicy.js`, exporting immutable `RACE_PLAN_POLICY_V1`. No route, AI response, title, or frontend copy may contain a second copy of these numbers. Every calculation uses decimal miles internally, rounds displayed distance to `0.1 mi`, rounds duration to the nearest minute, and compares unrounded values with an epsilon of `0.05 mi`.

These are conservative product guardrails, not medical guarantees. Before active rollout, the applicable entries in `trainingEvidence.js` must record the reviewed production rule, reviewer, review date, and policy version. Until that governance gate is complete, the policy may run only in fixtures, preview, diagnostics, and shadow mode.

Every policy decision emits one or more stable reason codes. At minimum: `NO_WEEKLY_BASELINE`, `NO_LONG_RUN_ANCHOR`, `NO_PERFORMANCE_ANCHOR`, `ANCHOR_EXPIRED`, `PACE_EQUIVALENCY_USED`, `BROAD_EQUIVALENCY_ONLY`, `BRIDGE_WEEK`, `LONG_SEMANTIC_MINIMUM`, `TIME_DISTANCE_MISMATCH`, `STRUCTURE_UNQUANTIFIED`, `PEAK_DEMAND_UNREACHABLE`, `QUALITY_EXPOSURE_MISSING`, `CHECKPOINT_UNPLACEABLE`, `POST_A1_RECOVERY`, and `CANDIDATE_STALE`.

### Calendar, taper, and full-training-week policy

Calendar calculations use accepted phone-local dates and Monday-Sunday weeks.

| Race distance | Taper weeks, including race week |
|---|---:|
| Up to 10K | 1 |
| Over 10K through half marathon | 2 |
| Over half marathon through marathon | 3 |

For each race independently:

1. `firstFullMonday` is the current Monday only when generation occurs on Monday before any trusted activity; otherwise it is the next Monday.
2. `raceWeekMonday = mondayFor(raceDate)`.
3. `taperStartMonday = raceWeekMonday - 7 * (taperWeeks - 1)` days.
4. `latestPeakMonday = taperStartMonday - 7 days`. Peak-long-run demand must be met no later than that week.
5. `fullTrainingWeeks` is the count of complete Monday-Sunday weeks from `firstFullMonday` through `latestPeakMonday`, inclusive, that are not race weeks, taper weeks, or weeks intersecting the mandatory first seven days after A1. It is calculated separately for A1 and A2.
6. A Bridge, taper, race, injury/comeback, acute-protection, or post-A1 recovery week never increases pace-improvement allowance or ordinary build-week count.
7. If `latestPeakMonday < firstFullMonday`, `fullTrainingWeeks` is zero. The engine must classify from that fact rather than force a shortened normal block.

Phase assignment is deterministic within those full weeks: `latestPeakMonday` is the one peak week; up to the three immediately preceding eligible weeks are build; any earlier eligible weeks are base. With fewer than four full weeks, keep one peak week and assign the remainder to build; do not invent a base phase. Taper, race, Bridge, injury/comeback, acute-protection, and post-A1 recovery remain overlays and never count as base/build/peak for policy allowances.

For two races, satisfy each race's calendar independently, then overlay with the stated A1/A2 precedence. Races too close to preserve both mandatory recovery and race demand receive an honest `stretch` or `unsafe` result with `RACE_SPACING_CONFLICT`.

### Baseline and anchor policy

**Weekly baseline**

- Consider the six complete phone-local Monday-Sunday weeks before `planning_date_local`.
- A trusted week contains at least two meaningful recorded runs totaling at least `2.0 mi` or `30 min`; duplicate/canonical-merge rules run first.
- With at least two trusted weeks, `weeklyBaselineMiles` is their median and is `trusted`.
- With exactly one trusted week, use that total as `low_confidence`; a timed PR plan cannot be `supported` until a checkpoint or second week confirms it.
- A profile-entered weekly mileage may seed a completion-first preview as `self_reported`, but cannot make a timed goal `supported`.
- With no trusted or self-reported baseline, baseline is `unknown`, not race distance and not a fixed default. Explicitly remove/forbid the current `max(6, raceDistance)` fallback for race-plan feasibility.

**Recent endurance anchor**

- Consider trusted non-race aerobic runs in the preceding 56 days after duplicate merging.
- With at least two eligible runs, use the median of the two longest as `recentEnduranceMiles`; with one, use it as `low_confidence`; with none, it is `unknown`.
- If no long run exists but at least two trusted ordinary easy runs exist, the first endurance progression may start from `ordinaryEasyMiles` and increase by at most the long-run growth cap. It is labeled easy/steady until it passes long-run identity.
- If both endurance and ordinary-easy anchors are unknown, schedule easy familiarization plus a legal benchmark. Do not label a long run, invent race-distance capacity, or classify a timed PR as supported.

**Trusted intensity**

A run may enter ordinary-easy/intensity calculations only when duplicate resolution is complete and at least one applies: it is linked to a completed canonical Forged session; the user supplied RPE (`1-4` for easy/recovery); or the existing recorded-zone parser reports a trusted timeline against the athlete's saved HR zones. Imported title text, average pace alone, or a partial/untrusted HR timeline is insufficient.

**Performance-anchor classes and freshness**

- `same_distance`: race/PR distance is within 3% of the target; fresh for 180 days.
- `nearby_standard`: both are one mile, 5K, 10K, 10 miles, half marathon, or marathon, and target/source distance ratio is from 0.5 through 2.0; fresh for 120 days and converted by the existing reviewed equivalency helper.
- `benchmark`: canonical `benchmark_mile`; fresh for 42 days.
- `broad_estimate`: any wider cross-distance or training-history estimate; fresh for 28 days and never better than `stretch`.
- Outside the freshness window, emit `ANCHOR_EXPIRED` and treat it as no anchor until a new checkpoint.

For completion goals, pace feasibility is `not_applicable`; combined feasibility is governed by workload/calendar/safety. The plan still prescribes effort/zone and optional estimated pacing, but does not imply a timed outcome. A timed PR goal with no fresh anchor is never `supported`.

### Quality exposure and checkpoint policy

An ordinary full build/peak week contains exactly one canonical quality session when safety permits. Base weeks alternate a neuromuscular exposure (`strides` or a canonical hill session) with an all-easy week. Each taper contains one bounded `sharpening_strides` or familiar race-pace exposure; it does not introduce a new workout family.

Minimum distinct pre-taper exposures for a timed PR candidate:

| Race | Hill/strides | Threshold/interval | Race-pace | Notes |
|---|---:|---:|---:|---|
| 5K | 1 | 2 | 1 | One interval exposure must be `short_intervals` or `fartlek`. |
| 10K | 1 | 2 | 2 | Threshold and race-pace work remain separate sessions. |
| 10 mile | 1 | 2 | 2 | At least one threshold exposure precedes race-pace work. |
| Half marathon | 1 | 2 | 2 | Race-pace exposures use bounded intervals, not an all-out long run. |
| Marathon | 1 | 2 | 3 | Race-pace segments are embedded only after baseline support exists. |

One session counts for one exposure family only. If legal full weeks cannot hold the minimum while satisfying demanding-session spacing, the plan cannot be `supported`. Completion-first plans require no race-pace count but retain safe strides/hills only when appropriate.

In a dual-race block, a generic hill or threshold exposure may satisfy both races when its canonical purpose and placement are valid for both. A race-pace exposure counts only for the race whose exact prescribed pace it matches; trace records the credited `race_id` values.

When a timed goal lacks a fresh performance anchor, place canonical `benchmark_mile` in the first legal ordinary full week that is at least 14 days before `taperStartMonday`, has no acute/injury protection, and has at least two calendar dates from another demanding session. When workload alone is `stretch`, the checkpoint is completion of the planned long run in full week `max(2, floor(fullTrainingWeeks / 2))`. A pace-and-workload stretch uses both checks when legal. Checkpoints may not occur after `latestPeakMonday`; if none is legal, emit `CHECKPOINT_UNPLACEABLE` and classify the timed goal `unsafe`.

### Long-run identity policy

For the preceding 56 days:

- `ordinaryEasyMiles` is the median distance of trusted `easy` or `recovery` runs at least `0.5 mi` and `10 min`. Use only runs whose intensity classification is trusted; title parsing is not sufficient.
- `ordinaryEasyMinutes` is the median duration of the same runs.
- If fewer than two such runs exist, both athlete-relative values are `unknown`; do not invent them from profile mileage.

Static race-category floors:

| Target distance | Identity floor |
|---|---:|
| Up to 5K | 3.0 mi |
| Over 5K through 10K | 4.0 mi |
| Over 10K through 10 miles | 5.0 mi |
| Over 10 miles through half marathon | 6.0 mi |
| Over half marathon through marathon | 8.0 mi |

Race-relative phase floors are `raceDistance * fraction`:

| Phase | Fraction |
|---|---:|
| Bridge/base | 0.30 |
| Build | 0.40 |
| Peak | 0.55 |
| Taper | 0.30 |

The required semantic distance is:

```text
max(
  category identity floor,
  race-relative phase floor,
  ordinaryEasyMiles * 1.25 when known
)
```

The required semantic duration is `max(45 min, ordinaryEasyMinutes * 1.20 when known)`. A planned long run must meet both distance and duration requirements. Taper/race-week sessions that cannot meet them are `easy`, `steady`, or `sharpen`, not `long`.

### Time-distance policy

`distance_miles` means total running distance for the complete session, including running warm-up, work repetitions, jog/float recoveries, and running cooldown. Mobility, drills performed in place, standing recovery, and walking cooldown minutes contribute time but zero running distance.

1. Easy/steady/recovery/long sessions choose one trusted pace anchor. Apply the canonical effort factor exactly once. `expectedMinutes = distanceMiles * estimatedPaceSecondsPerMile / 60`, plus explicit zero-distance drill/walk minutes.
2. Every quality taxonomy family must expose machine-readable segments before this policy activates. Each segment contains `kind`, `repeats`, exactly one primary dosage (`duration_seconds` or `distance_miles`), and `pace_source` (`easy`, `recovery`, `threshold`, `interval`, `race`, `benchmark`, or `standing`).
3. For distance-defined segments, derive duration from that segment's canonical pace source. For time-defined running segments, derive distance from that pace source. Multiply repetitions, then sum warm-up, work, recovery, and cooldown into canonical totals. Never multiply the whole structured workout by one average work pace.
4. Stored unrounded totals must match the segment sum within `60 seconds` and `0.05 mi`; displayed totals use normal rounding. A segment with neither quantifiable duration nor distance fails `STRUCTURE_UNQUANTIFIED`.
5. The existing taxonomy families map as follows: `strides`, `fartlek`, `short_intervals`, and `long_intervals` use easy warm-up/cooldown plus work and recovery segments; hill families use effort/duration work plus jog/standing recovery; `tempo_threshold` and `progression_run` use phased pace segments; `race_pace_intervals` uses race-pace work plus easy recovery; `sharpening_strides` uses short work/recovery segments; `benchmark_mile` uses easy warm-up/cooldown plus a measured one-mile benchmark; `race` uses the exact race distance and target/effort source.
6. When no pace anchor exists, a non-benchmark session may carry an estimated total only when `durationIsEstimated: true`, `distance_is_estimate: true`, `anchorState: 'needs_benchmark'`, and every deterministic fallback pace source is identified in trace. It cannot make a timed goal `supported`.
7. A duration/distance clamp triggers full segment recomputation. If the canonical family no longer fits, regenerate a complete simpler canonical session or fail validation; never edit only title/type/duration.
8. For unstructured easy/long sessions, generated duration must remain within the greater of `5 minutes` or `12%` of expected duration. Structured sessions use the stricter segment-sum tolerances above.

### Race-demand policy

Minimum peak-long-run targets for an otherwise `supported` plan:

| Race | Completion | Timed PR |
|---|---:|---:|
| 5K | 3 mi | 5 mi |
| 10K | 5 mi | 6 mi |
| 10 mile | 7 mi | 8 mi |
| Half marathon | 8 mi | 10 mi |
| Marathon | 16 mi | 18 mi |

The required peak weekly mileage is `peakLongRunMiles / 0.45`, rounded up to the next `0.5 mi`; a plan may exceed it only through the safe-forward curve. Peak long-run duration is capped at `180 min`. If the distance target cannot be reached inside that cap at the athlete's easy pace, workload status cannot be `supported` without a reviewed distance-specific exception.

Safe-forward growth is a product cap, not a universal training law:

- full-week mileage may grow at most `8%` from the prior ordinary build week;
- long-run distance may grow at most the greater of `0.5 mi` or `10%` from the prior completed/planned long run;
- deload, taper, race, Bridge, acute-protection, injury/comeback, and post-A1 recovery weeks are excluded as comparison denominators and carry explicit reason codes;
- no excluded week resets the last ordinary build anchor.

### Pace-feasibility policy

Calculate `requiredImprovement = max(0, (anchorEquivalentSeconds - goalSeconds) / anchorEquivalentSeconds)`.

- `supportedLimit = min(0.04, 0.005 * fullTrainingWeeks)`.
- `stretchLimit = min(0.08, 0.010 * fullTrainingWeeks)`.
- Same-distance race/PR or a reviewed benchmark may be `supported` when `requiredImprovement <= supportedLimit`.
- A nearby standard-distance anchor may be `supported` under the same limit but records `PACE_EQUIVALENCY_USED`.
- A broad cross-distance/history estimate is capped at `stretch` regardless of the numeric result.
- No anchor is `stretch` only when workload is not unsafe and a benchmark is scheduled; it is never `supported`.
- Improvement above `stretchLimit`, an expired anchor, or an active safety condition that blocks required quality work is `unsafe`.

### Workload-feasibility policy

- `supported`: the safe-forward curve reaches 100% of both required peak weekly mileage and peak long-run distance before taper, while satisfying all spacing and safety rules.
- `stretch`: it reaches at least 90% of both demands, violates no hard rule, and records a reevaluation checkpoint.
- `unsafe`: either demand remains below 90%, any hard safety rule would be violated, or no legal calendar placement exists.

For `stretch`, use the checkpoint-selection and legal-placement policy above. The checkpoint does not use an invented pass score; after the workout or long-run completion is recorded, rerun the same versioned policy with the new evidence and show the resulting state and reasons.

### Demanding-session policy

A run is demanding when its canonical taxonomy marks it quality, when it passes long-run identity, or when it is a race. Allow at most two demanding runs in every rolling seven-day interval, evaluated from phone-local start dates, and at least two intervening calendar dates between demanding starts. The rolling check crosses Sunday/Monday boundaries. Existing acute-load and lower-body strength separation rules remain stricter when applicable.

For two A races, compute demands per race and then overlay them. Do not force one scalar phase when A1 recovery and A2 preparation overlap. Exact precedence is: race date, acute/injury protection, first seven days after A1, A2 taper, A2 race-specific work, ordinary build/base. In a three-week gap, the first post-A1 week is recovery/deload, the next week contains only bounded A2 sharpening, and the final week is A2 race week.

## Required input truth

The engine must build and persist one normalized planning snapshot. Every field includes value, source, observed-at date, and confidence/trust state.

Required inputs:

1. Accepted phone-local planning date, timezone offset, and calculated Bridge Week status.
2. Race IDs, dates, distances, goal times, priority, and trusted course facts.
3. Selected run days per week and eligible weekdays.
4. Plan mode and strength floor.
5. Fifty-six days of meaningful run history, including weekly totals and run count.
6. Recent ordinary-easy medians and long-run anchor based on trusted actual distance/time and canonical/intensity evidence, not an imported title.
7. Trusted performance anchor: PR, race, benchmark, or supported cross-distance estimate.
8. Current-week completed miles and dates.
9. Acute load protection, readiness, pain/injury, training gap, and comeback state.
10. Recent lift history needed for concurrent scheduling.
11. Data gaps that materially reduce confidence.
12. Owner `planning_input_revision`, active plan/user-plan version, and the bounded source timestamps used for explanation. Staleness authority is the monotonic revision, not timestamps that may be absent or commit concurrently.

Unknown data remains unknown. Default values may make a completion plan conservative, but they may not create a `supported` PR classification.

## Canonical plan fidelity

Semantic validation is meaningful only if normalization is lossless. Before any mutation-path work, update `backend/src/lib/planSchema.js` so a normalize/serialize/normalize round trip preserves every canonical field on an untouched session, including:

- `workout_id` and `workout_family`;
- `goal_pace_seconds_per_mile` and `goal_pace_label`;
- `quality_prescription`;
- structured warm-up, work steps, recoveries, and cooldown;
- distance/time estimate flags and anchor state;
- purpose, evidence references, reason codes, and safety annotations;
- plan-session identity and completion/progress references.

Unknown forward-compatible fields must survive normalization unless they are on an explicit denylist for secrets or transient response state. Add deep-equality round-trip fixtures. Run this gate before validating reschedules or adaptations; otherwise a mutation can appear valid only because normalization silently discarded the fields that prove what the workout is.

Changing `type`, title, or `workout_id` without rebuilding the full canonical prescription is invalid. A downgrade from `long_aerobic` to `easy_aerobic`, for example, must be regenerated through `runWorkoutTaxonomy.js` so identity, dosage, structure, purpose, and evidence agree.

## Planning algorithm

### 1. Build the performance anchor

Reuse the existing performance-profile and goal-pace helpers. Select the freshest trustworthy result in this order:

1. Same-distance race or PR.
2. Nearby standard-distance race or PR with an existing supported equivalency calculation.
3. Recent controlled benchmark.
4. Meaningful recent run history sufficient for a bounded estimate.
5. No anchor.

Persist why the anchor was chosen. If no anchor exists, prescribe a benchmark before exact goal-pace work and classify a timed PR goal as `stretch` until measured.

### 2. Calculate goal demand

For every A race derive:

- race distance;
- target time and target pace;
- weeks and full training weeks available;
- trusted course/terrain demand;
- required taper and, for two races, post-A1 recovery bridge;
- race-specific peak long-run range;
- required quality families and minimum exposures.

Do not use a single final race to overwrite A1 requirements. Preserve the current `plan.goals` ordered A1/A2 model.

### 3. Build two curves

**Safe forward curve**

- Starts from validated recent weekly mileage and recent long run.
- Applies bounded progression, planned holds, deloads, recovery, injury, and strength constraints.
- Treats Bridge Week separately.

**Goal-backward curve**

- Starts from race week and works backward through taper, peak, build, base, and Bridge Week.
- Uses `RACE_PLAN_POLICY_V1` to establish the latest acceptable peak long run, peak weekly mileage, quality exposures, and target-pace practice.
- For a half marathon, the peak-long-run requirement is athlete- and risk-adjusted but must be credible for 13.1 miles; a low single-digit peak cannot silently pass for a PR plan.
- For 10-mile and half-marathon A races three weeks apart, A1 supplies endurance; the intervening block recovers, sharpens to A2 pace/course, and does not restart base training.

### 4. Reconcile the curves

The reconciler compares each safe-forward weekly/long-run value with the same-week goal-backward minimum and applies the exact pace/workload policy above.

1. Hard safety, calendar legality, race-date truth, and required recovery always win over goal demand.
2. The weekly allocator may move volume only among legal easy/steady slots and may not reduce a donor below `1.0 mi`, the semantic minimum of its canonical workout, or its complete structured-workout duration.
3. A quality session is never shortened below its taxonomy prescription to fund a long run. A long run is never inflated above the safe-forward cap to satisfy the goal-backward curve.
4. If all required peak values are reached, workload is `supported`.
5. If both reach at least 90%, workload is `stretch` and gets the versioned checkpoint.
6. Otherwise workload is `unsafe` and no normal protected-PR plan may be applied.
7. Never hide a mismatch by shrinking the race-demand policy, changing a canonical label, or treating a Bridge/deload/taper week as the prior ordinary build anchor.

### 5. Allocate each full week

Each non-taper/non-race full week should derive session roles before mileage allocation:

1. One long aerobic run when the block and athlete state support it.
2. One quality stimulus appropriate to phase: strides/fartlek/hills early, threshold/intervals during build, race pace in race-specific phases.
3. Remaining runs easy or recovery; a fourth/fifth day may be steady only when safe.
4. At most two demanding runs in any rolling seven-day interval, with the long run counted as demanding for spacing.
5. Strength placement preserves the selected floor without placing demanding lower-body work adjacent to hard/long runs.

Allocate distance/time after roles exist. Then run semantic validation. A role may be downgraded when safe dosage cannot support it.

### 6. Build complete prescriptions

Reuse `runWorkoutTaxonomy.js`. Every run retains:

- canonical workout ID and family;
- motivational display name as secondary identity;
- purpose;
- warm-up;
- main structure;
- recoveries/rest between repetitions;
- cooldown;
- time, distance estimate, pace/zone target, and whether each is measured or estimated;
- progression rule;
- evidence references.

## Hard generation and validation invariants

The following are release-blocking:

1. A Bridge Week is explicitly marked and excluded from full-week ramp comparisons.
2. No session is `long` only because it occupies the final run slot.
3. A long run must exceed the configured athlete-relative easy-run threshold and meet its phase/race minimum.
4. A session below the long-run threshold is relabeled, not artificially enlarged.
5. Time and distance estimates must reconcile from the same trusted pace anchor within a documented tolerance.
6. A `0.9 mi / 30 min long run` fails validation.
7. Every full base/build/peak week meets selected run frequency unless a persisted safety adjustment explains the reduction.
8. At most one long run appears per week.
9. At most two demanding runs appear in any rolling seven-day interval, and demanding sessions receive the existing separation protection.
10. Every PR block contains an appropriate quality progression unless active safety protection explicitly removes it.
11. A timed race has structured target-pace exposure when feasible.
12. Peak long-run dosage is credible for the target race and current athlete, or feasibility cannot be `supported`.
13. Race-day distance cannot create an unexplained cliff from the peak long run.
14. Taper reduces fatigue while retaining a bounded sharpening exposure.
15. A1 and A2 each preserve exact date, distance, target pace, taper, race session, and course truth.
16. A post-A1 deload does not erase A2 sharpening.
17. An unsafe target cannot be persisted as a normal protected PR plan.
18. Every safety clamp writes a human-readable reason and machine-readable reason code.
19. Motivational names never replace canonical workout type in payload or UI.
20. Validation runs before every create, rebuild, race reconciliation, reschedule, and adaptation persistence path.

## Feasibility response

Before replacing an active plan, generation returns a bounded preview:

```json
{
  "overall_feasibility": "stretch",
  "goal_feasibilities": [
    {
      "race_id": "half",
      "feasibility": "stretch",
      "goal": { "distance_miles": 13.109, "goal_time_seconds": 7200 }
    }
  ],
  "anchor": { "kind": "recent_race", "observed_at": "2026-07-24" },
  "full_training_weeks": 6,
  "peak_long_run": { "distance_miles": 10.5, "week": 5 },
  "checkpoint": { "week": 3, "kind": "benchmark_mile" },
  "reasons": ["The target requires a faster pace than the current performance anchor."],
  "choices": ["train_for_target", "adjust_goal", "completion_first"]
}
```

For multiple races, `goal_feasibilities[]` contains one owner-visible result keyed by `race_id`; `overall_feasibility` is the most conservative state. A goal-changing preview identifies the affected race and cannot silently change the other goal.

No percentage confidence is shown to users unless it has a calibrated statistical meaning. Use categorical language and evidence.

## Owner-bound preview and apply

Plan generation and plan replacement are separate operations. Preview must never mutate the active plan.

Add a dedicated `plan_generation_candidates` table rather than overloading `plan_adjustment_proposals`, whose pending-row uniqueness and run-trigger semantics serve a different workflow.

Required columns:

- `id`, `user_id`, `status` (`preview`, `applied`, `expired`, `superseded`);
- active `training_plan_id`, `user_plan_id`, and active-plan version captured at preview time;
- `planning_input_revision` captured from the owner row;
- `planning_date_local` and `timezone_offset_minutes`;
- `input_hash`, `candidate_hash`, `engine_version`, `policy_version`, and `invariant_version`;
- bounded redacted normalized planning-snapshot JSON used to reconstruct the candidate fixture;
- normalized candidate plan JSON and redacted generation-trace JSON;
- `applied_choice`, `applied_training_plan_id`, `applied_user_plan_id`, and bounded replay-result JSON;
- `created_at`, `expires_at`, and `applied_at`.

Storage rules:

1. `user_id` is required, references the user with account-deletion behavior matching other owned tables, and is indexed with `status` and `expires_at`.
2. Candidate TTL is 24 hours. Expired candidates are never applied.
3. Add the table to canonical schema, idempotent production migration, account export, account deletion, account-data coverage, and atomicity tests.
4. Candidate plan JSON is at most `512 KiB`; normalized input snapshot and trace JSON are each at most `128 KiB`; stored replay-result JSON is at most `16 KiB`, measured as UTF-8 bytes before database write. The input snapshot follows the trace allowlist and never stores raw Health/GPS/provider data or free text.
5. `input_hash` is a canonical hash of the normalized snapshot plus owner `planning_input_revision`. Volatile IDs and generation timestamps are excluded.

### Monotonic planning-input revision

Add `users.planning_input_revision BIGINT NOT NULL DEFAULT 0` and reuse `withUserMutation`, which already locks the normalized owner row. Add one helper that increments this revision exactly once in the same transaction as a plan-relevant mutation.

Plan-relevant mutations include:

- run insert/update/delete/import/canonical merge and completion-link changes;
- lift/workout-session insert/update/delete/import;
- Health, Strava, Oura, and WHOOP writes that change planning aggregates;
- race create/update/delete/link;
- profile, run-frequency, eligible-day, plan-mode, strength-floor, injury/pain, and schedule-preference changes;
- active-plan assignment, plan progress, reconciliation, reschedule, adaptation, and candidate apply.

Each affected route uses the same owner lock and transaction for its data write and revision increment. Do not infer staleness from missing `updated_at` columns. Preview reads one consistent normalized snapshot and revision under the owner lock, generates outside the lock, then reacquires the owner lock and stores the candidate only if the revision is unchanged. Apply reacquires that owner lock, locks the candidate and active assignment, and compares the revision before any write. A concurrent sync/edit either commits first and changes the revision or waits until apply completes; it cannot slip between validation and activation.

Endpoints:

- `POST /api/plans/preview` generates, validates, stores, and returns an owner-bound candidate. It does not update `training_plans`, `user_plans`, progress, or recorded activities.
- `POST /api/plans/candidates/:candidateId/apply` applies only an explicit athlete choice.

Apply request:

```json
{
  "choice": "train_for_target",
  "candidate_hash": "sha256:..."
}
```

Only `train_for_target` can apply that stored candidate. `adjust_goal` and `completion_first` change planning input and therefore create a new preview with the revised goal before any apply.

Apply runs inside `withUserMutation` and:

1. selects the candidate with `WHERE id=? AND user_id=? FOR UPDATE`;
2. when status is `applied`, handles identical/conflicting replay exactly as below before comparing current revision;
3. otherwise requires `status='preview'`, an unexpired timestamp, and matching accepted phone-local date;
4. compares the locked owner `planning_input_revision` to the candidate revision and recomputes normalized `input_hash`; any mismatch returns `409 CANDIDATE_STALE` without a partial write;
5. revalidates candidate hash and all current invariants;
6. applies the cutover contract below and creates/repoints an owner-scoped future-effective user plan rather than deleting history;
7. marks the candidate applied with `WHERE id=? AND user_id=? AND status='preview'`, records choice/result IDs/replay result, and increments planning revision in the same transaction.

Replay semantics:

- Same owner + candidate + `train_for_target` + matching candidate hash after a successful apply returns the stored `200` replay result without any write or revision increment.
- A different choice/hash, expired/superseded candidate, or unverifiable result returns `409`; a foreign-owned candidate returns `404` to avoid disclosure. None can replace a plan.

### Historical cutover and active-assignment invariant

Add `user_plans.plan_version BIGINT NOT NULL DEFAULT 1`, `lineage_id`, `supersedes_user_plan_id`, and `effective_from`. Before creating a partial unique index enforcing one active assignment per owner (`UNIQUE (user_id) WHERE status='active'`), preflight for duplicate active rows. If duplicates exist, stop and report them for owner-scoped repair; never silently choose or delete one. The migration is idempotent after preflight is clean.

| Session date/state | Source after apply | Rule |
|---|---|---|
| Before `effective_from` | Prior lineage | Immutable history; completed/skipped/progress state remains visible. |
| On `effective_from`, already recorded or completed | Prior lineage | Preserve activity and `plan_session_id`; candidate cannot claim it. |
| On `effective_from`, incomplete | Explicit preview choice | Default is preserve today and start candidate tomorrow; replacing today must be explicitly shown before apply. |
| After `effective_from` | New active plan | Candidate sessions are authoritative. |

Recorded runs/lifts keep their original `plan_session_id`. Reconciliation may associate an unlinked activity only through the existing canonical owner-scoped flow and cannot duplicate credit. `/my` returns the active plan plus read-only lineage completion needed for accurate block progress; prior completion cannot disappear or count twice.

## Plan persistence boundary inventory

Every path that can change plan content must use lossless normalization and the same validator before its transaction commits:

| Current path | Required behavior |
|---|---|
| `POST /generate` | Generate a candidate preview. Do not replace an active plan until explicit apply. |
| `POST /generate-for-races` | Generate a dual-race candidate preview with the same boundary. |
| `POST /generate-for-race/:raceId` | Generate a candidate preview with the same boundary. |
| `POST /assign/:planId` | Lock owner, validate assignment, enforce one-active invariant, increment planning revision, and stale previews. |
| `POST /adaptation/:proposalId/accept` | Lock owner-scoped proposal and plan, apply lossless mutation, validate complete proposed plan, then write. |
| `POST /reconciliation/respond` | Preserve canonical fields when moving/crediting sessions and validate before write. |
| `POST /reschedule-missed` | Preserve full session schema, validate legal dates/spacing/dosage, and write with `AND user_id=?`. |
| `POST /race-adjust` | Replace LLM-selected dosage with a deterministic candidate. AI may explain an already validated adjustment but cannot choose mileage, pace, or session placement. |
| `PUT /my/race-link` | Validate goal metadata, increment the active-plan version, and stale outstanding candidates. |
| `PUT /my/progress` | Keep owner scope, increment planning revision because completion/current-week changes future planning input, and stale previews. |
| `POST /adaptive/accept` | Must not deactivate or replace an active schema-v2 race plan unless it is explicitly migrated into this candidate/apply workflow. Return a clear conflict otherwise. |

Run, lift, Health, provider-sync, race, and profile/preference route files join P4A even when they do not write plan JSON, because their mutations must advance the planning revision. Every `DELETE` or `UPDATE` on user data includes `AND user_id=?` even when an owner-scoped `SELECT` precedes it.

## Generation trace and engine version

Persist with each plan:

- `generationTraceSchemaVersion`, `engineVersion`, `policyVersion`, and `invariantVersion`;
- `generatedAt`, phone-local planning date, and timezone offset;
- `inputHash` and `candidateHash`;
- normalized allowlisted input summary and provenance;
- Bridge Week status;
- feasibility classification and reason codes;
- weekly target curve and long-run curve;
- each clamp, downgrade, or omitted session with reason code;
- validator result and invariant version.

Trace rules:

1. Generation traces are immutable. Later reschedule/adaptation/reconciliation operations append bounded mutation traces containing prior hash, resulting hash, mutation type, actor, timestamp, and validator result.
2. Trace input uses an explicit allowlist and a serialized size ceiling. It may include aggregate mileage, aggregate duration, race targets, trusted-anchor metadata, readiness state, and source timestamps.
3. It must never include raw HealthKit samples, GPS coordinates, route geometry, free-text notes, names, emails, phone numbers, auth tokens, provider tokens, or other secrets.
4. Hashes use stable canonical JSON ordering. IDs/timestamps excluded from deterministic candidate content are listed in the schema, not stripped ad hoc.
5. The normal athlete UI receives only concise explanations; the full redacted trace is diagnostic data.

## User experience

### Train header

Show:

- race(s), date(s), goal time(s), and goal pace(s);
- feasibility: `On track`, `Stretch target`, or `Goal needs adjustment`;
- a single `Review plan` action.

Do not restore the previously removed `Built from your data` or research-reference blocks on the Train landing surface.

### Bridge Week

Label the partial week `Bridge Week` and explain:

> This partial week uses work you already completed. Your first full training week starts Monday.

Do not call a short leftover session the week's long run.

### Whole-block Overview

Extend the existing Overview rather than adding a page. Each week shows:

- phase and weeks to A1/A2;
- weekly purpose in one sentence;
- run count and total time/mileage;
- key quality workout;
- long-run target;
- strength intent;
- why this week advances the race goal;
- any safety hold/deload and its cause.

A collapsed `Why this plan` disclosure in Overview may show recent-week count, meaningful runs, recent endurance anchor, performance anchor, data gaps, and reviewed evidence references. It is closed by default and is not repeated on each week/day.

### Day view

Canonical workout type is the first label. Motivational name is secondary. Exact structure remains expandable without forcing a check-in.

### Unsafe or stretch goal

Offer one decision sheet:

- Keep the target and use checkpoint review when `stretch`.
- Adjust target time.
- Change to completion-first.
- Extend the timeline when race date is editable.

Never silently alter goal time or replace the active plan.

## Tester and diagnostics mode

Bryan is the current acceptance tester. Add an admin/tester-only plan audit surface, not visible to ordinary users, that can copy a redacted diagnostic bundle containing:

- engine version;
- plan ID/version;
- input sources and dates without raw health samples;
- feasibility and reason codes;
- weekly mileage and long-run curves;
- validation result;
- session role, dosage, and downgrade reason;
- active safety constraints.

This turns future screenshots into reproducible fixtures and reduces guesswork. It must not expose another user's data or secrets.

Implementation requirements:

- Reuse the server-side `requireDiagnosticsAdmin` middleware from `backend/src/routes/diagnostics.js`; a client-side tester flag is not authorization.
- Require an explicit owner `user_id` target and scope every diagnostic query to that owner. An admin can inspect one requested athlete, never an unbounded user list through this endpoint.
- Return only the trace allowlist above, cap the complete UTF-8 response at `256 KiB`, and redact again at the response boundary.
- Add `diagnostic_access_audit` with actor/target user IDs (`ON DELETE SET NULL`), plan/candidate identifiers, action, and timestamp only. Never store the diagnostic payload, email, phone, token, Health samples, or GPS. Retain 365 days and prune opportunistically on an audited diagnostics request plus the existing maintenance path; add it to schema/migration/account-data coverage with explicit security-log export/deletion handling.
- Include authorization, cross-user denial, redaction, response-bound, and access-audit tests.

## Implementation phases

### P0 - Reproduce and lock the regression

Expected files:

- `backend/test/racePlanQuality.smoke.js` (new)
- `backend/src/lib/concurrentPlan.js` only if a pure diagnostic export is needed

Work:

1. Add a passing characterization assertion for the exact current output and validator acceptance from the Friday 2026-08-07 fixture.
2. Add a separate semantic acceptance command that intentionally exits nonzero on current `main` because `0.9 mi / 30 min` cannot be a valid long run. Record this as the expected RED gate; do not weaken it to keep P0 green.
3. Add fixtures for low-data, no-data, established, comeback/injury, and dual-race athletes.
4. Capture current output before changing generation.

Gate: characterization is green and the semantic acceptance is RED for `LONG_SEMANTIC_MINIMUM`, not for a brittle title string. P0 is not merged or deployed alone.

### P1 - Policy, date authority, and lossless schema

Expected files:

- `backend/src/lib/racePlanPolicy.js` (new)
- `backend/src/lib/planSchema.js`
- `backend/test/racePlanQuality.smoke.js`
- focused plan-schema round-trip smoke

Work:

1. Add immutable `RACE_PLAN_POLICY_V1` and the reviewed evidence-governance metadata required before active rollout.
2. Make phone-local date/offset an explicit accepted input with the stale-date behavior above.
3. Make `planSchema` lossless for canonical workout identity, structured prescription, pace, evidence, and progress references.
4. Add stable canonical hashing and the versioned redacted trace schema.

Gate: schema round trips are deeply equal for untouched sessions; Friday/Sunday and timezone fixtures derive the same Bridge Week regardless of `currentWeekLoad`; policy values exist in one module only.

### P2 - Bridge Week and semantic workout truth

Expected files:

- `backend/src/lib/racePlanCandidateEngine.js` (new temporary integration seam over the canonical plan model)
- `backend/src/lib/concurrentPlan.js`
- `backend/test/racePlanQuality.smoke.js`

Work:

1. Mark Bridge Week in payload and UI, including date-derived low-data behavior.
2. Derive long-run identity from validated dosage/curve, not slot position.
3. Reconcile time and distance from one pace anchor.
4. Rebuild the complete canonical session on semantic downgrade.
5. Keep the builder pure and disconnected from all existing persistence routes. Existing `buildConcurrentPlan()` callers retain byte-equivalent legacy behavior; tests invoke the candidate engine explicitly.

Gate: the semantic acceptance command becomes green by producing a valid corrected candidate, not merely rejecting the entire plan; the first ordinary Monday restores normal floors; current-week, acute-load, dual-race, and taxonomy tests remain green.

### P3 - Race demand, backward curve, and block quality

Expected files:

- `backend/src/lib/planFeasibility.js` (new pure module)
- `backend/src/lib/racePlanCandidateEngine.js`
- `backend/src/lib/concurrentPlan.js`
- `backend/src/lib/runWorkoutTaxonomy.js` only if an existing stable workout cannot express a requirement
- `backend/src/lib/trainingEvidence.js` for reviewed policy metadata, never a copied proprietary plan
- `backend/test/planFeasibility.smoke.js` (new)
- focused plan-quality tests

Work:

1. Build the race-demand curve backward before evaluating feasibility.
2. Compute per-race pace and workload `supported`/`stretch`/`unsafe` states from the versioned policy.
3. Validate peak weekly mileage, peak long run, race-day continuity, and target-pace exposure.
4. Validate phase-specific hills, threshold, intervals, race pace, and sharpening.
5. Preserve A1 recovery and A2 sharpening as overlapping concerns rather than one scalar phase.
6. Keep the selected strength floor without compromising key run placement.
7. Keep the demand/feasibility builder pure and disconnected from existing persistence routes.

Gate: 5K, 10K, 10-mile, half-marathon, and marathon matrices pass for run-only and hybrid-maintain modes across conservative and established baselines.

### P4A - Planning-input revision and migration foundations

Expected files:

- `backend/src/db/index.js`
- `backend/src/db/migrate.js`
- `backend/src/db/schema.pg.sql`
- `backend/src/lib/accountDataCoverage.js`
- plan-relevant route files under `backend/src/routes/` for runs/import, workouts/lifts, Health/provider sync, races, profile/preferences, and plans
- owner-revision concurrency and migration smokes

Work:

1. Add and migrate monotonic `planning_input_revision`.
2. Route every plan-relevant mutation through the owner lock and increment once in the same transaction.
3. Add lineage/effective-date fields and preflight/create the one-active-assignment invariant without silently repairing duplicates.
4. Add candidate and diagnostic-audit schemas plus account-data handling, but do not activate preview/apply routes yet.
5. Prove concurrent run/lift/Health/race/profile/progress/assignment writes advance revision without lost updates.

Gate: migrations are idempotent, duplicate-active preflight fails closed, all owner-data coverage checks pass, and concurrent plan-input writes produce a strictly increasing revision.

P4A may be implemented as sequential commits/work sessions of no more than ten files each (for example schema/helper first, then activity/Health routes, then race/profile/plan routes). It remains one integrated phase: do not activate P4B or claim P4A complete until the combined P4A gate passes.

### P4B - Candidate/apply and every plan-write boundary

Expected files:

- `backend/src/lib/planFeasibility.js`
- `backend/src/routes/plans.js`
- candidate/apply concurrency, cutover, replay, and persistence smokes

Work:

1. Connect the pure P2/P3 builder only to owner-bound preview.
2. Add transactional stale-safe apply and exact replay semantics.
3. Apply lossless validation to every plan-content write in the inventory.
4. Remove LLM dosage authority from `/race-adjust`.
5. Preserve lineage progress and activity/session links across cutover.
6. Prove sync/edit-versus-apply races stale or serialize correctly.

Gate: a seven-week sub-2 half fixture gets a credible plan or honest state; preview never mutates active data; stale/expired/foreign/conflicting candidates do no writes; identical replay is a no-write success; every plan mutation rejects invariant failure.

### P5 - Plan explanation and existing calendar UX

Expected files:

- `frontend/src/components/calendar/ForgedCalendar.jsx`
- `frontend/src/components/calendar/ForgedDayView.jsx`
- `frontend/src/pages/Plan.jsx`
- `frontend/src/lib/planCalendar.js`
- `frontend/test/planCalendar.smoke.mjs`

Work:

1. Surface feasibility and a collapsed `Why this plan` truth summary in Overview, not on the Train landing surface.
2. Add week purposes, key quality session, long-run target, and strength intent to existing Overview.
3. Keep complete prescriptions accessible without check-in.
4. Keep one primary action per state and preserve 320px support, tap targets, and no horizontal overflow.

Gate: Bryan can understand the complete block, why each week exists, and what changed without opening every day; the adapter preserves all engine metadata.

### P6 - Diagnostics, shadow rollout, and tester sign-off

No automatic active-plan replacement.

1. Add the admin-authorized, owner-scoped, audited, redacted diagnostics bundle.
2. Run the new engine as a pure no-write shadow against deterministic fixtures and Bryan's redacted input snapshot. Shadow code cannot call plan persistence helpers.
3. Use a checked-in engine-mode constant or an existing feature-control mechanism; do not add an environment variable solely for this rollout.
4. Compare old and new mileage, long runs, quality distribution, feasibility, strength conflicts, and traces while leaving every existing plan untouched.
5. Controlled fixtures require zero hard-invariant, determinism, privacy, or persistence failures.
6. Beta shadow observation requires at least 100 candidate generations across at least 10 distinct consenting beta users over 14 consecutive days. The window extends until both sample minima are met.
7. An expected `supported`, `stretch`, or `unsafe` result is a product outcome, not an error. Errors are uncaught exceptions, timeouts, malformed candidates, hash/determinism mismatches, validator-internal failures, cross-user/redaction failures, or any preview/shadow write.
8. Any hard-invariant, cross-user, redaction, hash, determinism, or write failure blocks activation immediately. Other generation errors above 1% of all beta shadow generations block activation and require root-cause review; never fall back to silently applying an old invalid plan.
9. Independent Claude Code QA reviews source and exact fixtures.
10. Hermes reviews the integrated diff and QA evidence.
11. Bryan reviews the candidate block in the running app and explicitly chooses apply.
12. Only after those gates may the new engine become the default for new previews. Existing plans remain unchanged until their owner applies a reviewed candidate.

Bryan additionally authorized a one-time beta-cohort upgrade on 2026-08-08. That operator action does not weaken the default product rule above: it must run only after independent QA and Hermes approval, default to a no-write dry run, target only onboarded beta accounts with an active plan plus future owned race, write a redacted pre-apply backup, require the checked-in hard confirmation phrase, use the exact preview/apply transaction path, and make each replacement effective on the next phone-local date. The current assignment remains authoritative for the rest of the apply day and lineage remains available for rollback.

P0 through P3 stay dark and pure on one integration branch. They cannot change the default behavior of current `buildConcurrentPlan()` callers, be wired to current `/generate*` persistence, merge to production independently, or deploy before P4A and P4B complete. `racePlanCandidateEngine.js` is a temporary compatibility seam that emits the existing canonical plan schema, not a second plan model; P4B makes it the preview implementation and removes redundant legacy generation only after differential tests pass. First product activation is preview-only through P4B; active replacement remains explicit apply.

## Required acceptance matrix

At minimum:

1. Exact 2026-08-07 partial-week screenshot regression.
2. Seven-week sub-2 half marathon with a supported performance anchor.
3. Seven-week sub-2 half marathon with a low baseline that must become stretch/unsafe.
4. No performance anchor requiring a benchmark.
5. Two, three, four, five, and six run days per week.
6. Run-only and hybrid-maintain modes.
7. Recent long run completed in Bridge Week.
8. Recent hard/long run triggering 24-72-hour protection.
9. Active pain/injury/comeback mode.
10. Training gap without injury.
11. A1 half marathon plus A2 10-miler three weeks later.
12. 5K, 10K, 10-mile, half-marathon, and marathon distances.
13. Taper and race-week low mileage that must not create false long runs.
14. Time/distance property cases across supported pace anchors.
15. Motivational-name changes that do not alter canonical workout identity.
16. Friday and Sunday generation with no `acuteRunLoad.currentWeek` object.
17. Phone-local date at UTC-12/UTC+14 boundaries and daylight-saving transitions.
18. First full week after Bridge restores ordinary frequency, mileage, long-run, and strength floors.
19. A1 recovery overlapping A2 sharpening/taper in a three-week race gap.
20. Candidate becomes stale after a run sync, lift save, Health sync, race edit, preference edit, active-plan change, or phone-local date change.
21. Candidate ownership, 24-hour expiry, concurrent double-apply, and already-applied retry.
22. Candidate preview and shadow generation leave active plan, progress, and recorded activities byte-for-byte unchanged.
23. Reschedule/adaptation/reconciliation round trips preserve canonical prescription fields and plan-session links.
24. `/race-adjust` cannot accept AI-authored mileage, pace, workout identity, or placement.
25. `/adaptive/accept` cannot deactivate an active schema-v2 race plan outside explicit candidate apply.
26. Diagnostics reject non-admin and cross-user requests, redact forbidden fields, enforce size bounds, and create an access audit record.
27. Account export and atomic deletion include `plan_generation_candidates`.
28. Invalid race demand cannot be made feasible by lowering policy demand during reconciliation.
29. No-data marathon and PR fixtures prove race distance never becomes a baseline or starting long-run anchor.
30. Every structured taxonomy family reconciles segment duration and total distance, including zero-distance standing/drill minutes.
31. Concurrent run sync, race edit, profile change, assignment, and progress update versus candidate apply serialize or return stale without lost writes.
32. Unique-active-assignment migration preflight stops on duplicate active rows and succeeds idempotently after owner-scoped repair.
33. Past/today/future cutover preserves prior completion, keeps activity links, and avoids double credit.
34. Same-candidate/same-choice replay returns the original result without writes; conflicting replay returns `409`.
35. Too-close dual races classify `stretch`/`unsafe` when recovery and both race demands cannot coexist.
36. Demanding-session spacing holds across Sunday/Monday in every rolling seven-day interval.
37. Differential fixtures show unaffected plans retain equivalent sessions except intentional metadata/version additions.

Property/fuzz checks must assert:

- no NaN/negative dosage;
- no session date outside the plan/race window;
- no false long run;
- no more than one long run per week;
- no more than two demanding runs in any rolling seven-day interval;
- no time/distance contradiction;
- no unsupported `supported` feasibility;
- no plan persistence after validation failure;
- no persistence at all during preview or shadow mode;
- no loss of canonical fields through normalization or mutation;
- no apply when the current input hash differs from the candidate input hash;
- deterministic identical input produces identical training content, excluding IDs/timestamps.

## Required commands

Exact scripts may be added to `backend/package.json` only when the implementation begins. At minimum run:

```bash
node backend/test/racePlanQuality.smoke.js
node backend/test/planFeasibility.smoke.js
node backend/test/phase5PlanIntelligence.smoke.js
node backend/test/dualRacePlan.smoke.js
node backend/test/forgedHybridH13.smoke.js
node backend/test/planInformationDepth.smoke.js
node backend/test/runFrequencyAuthority.smoke.js
node frontend/test/planCalendar.smoke.mjs
cd frontend && npm run build
cd frontend && npm audit --audit-level=high
cd backend && npm run check:account-data
git diff --check
```

Run `node --check` on every changed backend JavaScript file. Do not silently skip a missing command; report and replace it with the actual matching repository script.

Implementation must also add and run focused smokes for lossless plan-schema round trips, candidate ownership/expiry/staleness/concurrent apply, diagnostics authorization/redaction/audit, and no-write shadow behavior. Name those scripts in the implementing phase commit rather than inventing command names in advance.

## Hermes pre-build review reconciliation

Hermes reviewed two drafts and returned `REVISE`, then reviewed this final draft and returned `APPROVE` with no blockers (session `20260807_150258_39346a`). The revisions:

- locking the exact complete P0 input and observed current output;
- centralizing exact/versioned long-run, race-demand, progression, spacing, and feasibility rules;
- defining phone-local Bridge Week authority and stale-date behavior;
- requiring lossless canonical plan normalization before mutation validation;
- adding owner-bound, expiring, hash-checked preview/apply instead of immediate replacement;
- inventorying every current plan-content persistence path;
- placing race demand before feasibility and defining A1/A2 overlap precedence;
- specifying bounded/redacted/versioned traces and audited diagnostics authorization;
- naming the real frontend adapter and `planCalendar.smoke.mjs` test path;
- defining a pure no-write shadow rollout, hard rollback conditions, and unchanged existing-plan behavior.

Hermes also independently reproduced the current false long run and verified the source causes, lossy normalizer, immediate-persistence routes, missing owner planning revision, and reusable diagnostics middleware. `APPROVE` means this specification is ready for P0 implementation; it does not mean any product bug is fixed, merged, deployed, or shipped.

## Build-loop and release gate

Each phase is a separate commit and follows:

1. Codex implements in its own clean worktree.
2. Codex runs the phase gates and records exact output.
3. Independent Claude Code QA reviews the committed diff from its own worktree.
4. Codex fixes every accepted finding and reruns the gates.
5. Hermes reviews the integrated commit and QA evidence.
6. No merge occurs until Hermes returns explicit approval.
7. After merge, Railway deploy is verified against the reviewed SHA.
8. Bryan verifies the mobile-running-app behavior.

Do not run EAS for these backend/web phases. The Capacitor shell live-loads Railway; a native build is not required unless implementation later changes native code.

Use exact release language from `CLAUDE.md`: `patched`, `shipped`, `awaiting verification`, or `verified fixed`.

## Definition of done

This work is done only when:

1. The exact `0.9 mi / 30 min long-run fixture` produces a valid corrected candidate with a fully regenerated canonical session; a generic generation rejection is not completion.
2. A full plan demonstrates a safe path from recorded capacity to race demand.
3. Unsupported targets receive an honest feasibility state and user choice.
4. Every week and key workout explains its purpose from real inputs.
5. Existing race, current-week, recovery, strength, user-scope, and calendar behavior remains green.
6. Claude Code and Hermes approve the integrated diff.
7. Railway serves the reviewed build.
8. Bryan verifies the plan in the running app before inviting broader beta reliance.
