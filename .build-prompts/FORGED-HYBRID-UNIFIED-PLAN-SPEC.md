# FORGED HYBRID UNIFIED PLAN BUILD SPEC

Status: Approved after Hermes race-first review; phased implementation in progress
Repository: `/Users/zordon/.openclaw/workspace/forge-app`
Production: `https://forge-production-773f.up.railway.app/`
Product owner: Bryan Madera / Madera Technologies LLC

## 1. Product Thesis

Forged Hybrid should be the clearest adaptive training calendar for runners who may also lift. It must jointly optimize race performance, recovery, and an explicit strength/size goal when lifting is enabled. Lifting is always optional.

The core experience is not another metrics dashboard. It is one dated plan that answers:

1. What do I do today?
2. What exact run or lift do I perform?
3. Why did Forged Hybrid schedule it here?
4. What changed because of my recovery, check-in, or completed work?
5. How does today move me toward my race without violating my strength preference?

Primary validation case: 2026 Army Ten-Miler, Sunday October 11, 2026. From July 12 this is a 13-week plan.

The selected race is the organizing target for the live plan, not a directory entry or optional label. Forged Hybrid must build the complete run-and-optional-strength calendar for that race, analyze the athlete as training data arrives, and adapt the work without silently changing the race objective or strength floor. Bryan's Army Ten-Miler plan is the first live dogfood case and the comparison point for friends considering Runna.

## 2. Non-Negotiable Product Rules

- Plan modes are explicit:
  - `run_only`
  - `hybrid_maintain` (run PR plus preserve size/strength)
  - `hybrid_build` (run goal plus continued strength/size progression)
- Never require lifting. Run-only users should not see empty lift controls or guilt messaging.
- Never describe hybrid plans as running-first with strength only for injury prevention.
- A hybrid plan has two protected objectives: the race objective and a strength floor.
- The user can change mode later without deleting completed history or restarting the race plan.
- Apple Health and check-ins can adapt the schedule, but changes must be visible and reversible.
- Do not silently rewrite the entire plan. Normal adaptations affect today and the next 48-72 hours.
- Do not copy Pen and Paper Strength App branding, exact layout, lettering, or trade dress. Build an original Forged Training Log identity.
- No new dependency, endpoint, or database column without proving the existing model cannot support the requirement.
- No EAS build or TestFlight submission without Bryan's explicit approval for that build.

## 3. Setup Experience

Use one short setup flow. Required choices:

- Goal race or distance.
- Race date.
- Finish goal: complete, PR/best possible, or specific target time.
- Plan mode: Run Only, Run + Maintain Strength, Run + Build Strength/Size.
- Available training days.
- Preferred run days.
- Lifting days, only when lifting is enabled.
- Strength experience and available equipment, only when lifting is enabled.
- Maximum session duration or split-session availability.

Prefill, then confirm:

- Current weekly mileage and recent longest run from imported/completed activity.
- Current run pace/effort baselines.
- Existing lifting frequency and recent exercise volume.
- Apple Health recovery baseline when available.
- Profile injury/comeback information.

Do not ask users to re-enter data Forged Hybrid already has. Clearly label inferred values and allow edits.

## 4. Unified Calendar UX

### Default: Week View

- Seven dated rows.
- Each day shows at most two concise session marks: Run and Lift.
- Session states: planned, adjusted, completed, skipped, rest.
- Today is the strongest visual signal.
- One primary action: `Open today` or `Start today`.
- Swipe or arrows move one week at a time.
- A compact plan header shows race, countdown, current phase, and strength mode.

### Month View

- Quiet overview, not a dense dashboard.
- Use small original run, dumbbell, hybrid, and rest marks.
- Show completed and adjusted state without full workout text.
- Tapping a date opens Day View.

### Day View

Render an original paper workout sheet:

- Warm white paper, subtle ruled lines, raw black handwritten headings.
- Forged Hybrid orange for today/progress, green for warm-up/recovery, red for intensity cautions.
- Original dumbbell/barbell/shoe/stopwatch stamps.
- Handwriting only for headings, coach annotations, and short cues.
- Pace, distance, weights, sets, reps, rest, heart-rate targets, and controls use a highly legible UI font.
- Text-size controls and full-screen reading mode follow the shipped StrengthWorkoutRecommendation pattern.
- Avoid nested cards and excessive badges.

Day content:

- Exact run: type, purpose, warm-up, blocks, distance/time, pace or HR zone, recoveries, cooldown.
- Exact lift: exercises, target load guidance, sets, reps, rest, RPE/RIR, focus, form cue.
- Recommended order: run first, lift first, same session, or separated by a stated number of hours.
- Recovery note.
- Separate `Why today` explanation after the workout.
- Start Run / Start Lift actions only for sessions scheduled that day.
- Apple Watch direct delivery when supported; manual-entry copy for other watches; partner sync remains Coming Soon.

## 5. Plan Data Contract

The current plan shapes (`weeks[].days` and `weeks[].sessions`) must remain readable. Introduce one canonical internal shape and bidirectional adapters for legacy plans. Store `schemaVersion`, `planMode`, and `strengthPolicy` inside the existing plan JSON; do not add database columns.

Canonical plan:

```json
{
  "schemaVersion": 2,
  "planMode": "hybrid_maintain",
  "goal": {
    "kind": "race",
    "raceId": "uuid",
    "name": "Army Ten-Miler",
    "date": "2026-10-11",
    "distanceMiles": 10,
    "goalType": "pr",
    "goalTimeSeconds": null
  },
  "strengthPolicy": {
    "enabled": true,
    "goal": "maintain",
    "sessionsPerWeek": 3,
    "minimumSessionsPerWeek": 2,
    "equipment": ["barbell", "dumbbell", "rack", "bench"],
    "preferredDays": ["Mon", "Wed", "Fri"]
  },
  "weeks": [
    {
      "week": 1,
      "phase": "base",
      "startDate": "2026-07-13",
      "days": [
        {
          "date": "2026-07-13",
          "day": "Mon",
          "sessions": [
            { "id": "uuid", "kind": "run", "prescription": {} },
            { "id": "uuid", "kind": "lift", "prescription": {} }
          ],
          "orderGuidance": "Run first; lift at least 6 hours later",
          "status": "planned"
        }
      ]
    }
  ]
}
```

Requirements:

- Every day can hold zero, one, or two sessions.
- Every session has a stable ID for completion, rescheduling, and deduplication.
- Existing user plans migrate lazily or through an idempotent migration.
- Never delete or overwrite completed history.
- Every existing day-level consumer must become session-aware before schema v2 can persist: `/plans/today`, `/plans/compliance`, `/plans/reschedule-missed`, `checkinOverride.applyOverride`, `enforceWeekSessionRules`, and the current Plan frontend.
- A run-only schema-v2 plan must produce behavior equivalent to its legacy plan for today, compliance, overrides, rescheduling, and completion.
- Mode switches only modify future uncompleted dates. `hybrid_* -> run_only` removes or converts future lift sessions without touching past/completed work. `run_only -> hybrid_*` injects lift sessions only into future dates after deterministic interference and strength-floor validation.
- Every user-data query is scoped by `req.user.id`; every UPDATE/DELETE includes the user scope.
- Multi-step writes use `withTransaction`.

## 6. Concurrent Programming Engine

Generate a dated race plan with base, build, recovery/down, peak, taper, and race-week phases.

Run programming must account for:

- Current weekly mileage and longest run.
- Recent pace/effort and HR zones.
- Race distance/date/target.
- Preferred frequency and available days.
- Terrain/elevation when race data exists.
- Missed or completed sessions.

Strength programming when enabled must account for:

- Mode: maintain or build.
- Recent lift frequency, sets, volume, and exercise history.
- Equipment and available duration.
- Lower-body fatigue from running.
- A protected minimum strength floor.
- Maintaining intensity while reducing volume as race day approaches.
- Preserving upper-body work when lower-body race volume rises.

Interference rules:

- Do not place heavy lower-body strength immediately before intervals, tempo, hills, or long runs.
- Prefer consolidating hard stress when appropriate so easy days remain easy.
- Provide order and separation guidance for same-day run/lift sessions.
- Deload both running and lifting when recovery signals require it.
- Taper lifting volume before the race without automatically eliminating strength intensity.
- Run-only mode bypasses all strength rules and emits no lift placeholders.

The AI can propose plan content using the existing complex model tier. Deterministic validation must enforce:

- Correct week/date count through race day.
- At least one rest/recovery day.
- Safe mileage progression and down weeks.
- Required race-specific sessions.
- Strength floor in hybrid modes.
- No strength sessions in run-only mode.
- No impossible duplicate sessions.
- Complete run/lift prescriptions rather than summaries.

If AI output fails validation, use a complete deterministic fallback rather than a partial plan.

## 7. Adaptation Engine

Inputs:

- Morning check-in.
- Sleep, HRV, resting HR, steps, recent workouts, and available Apple Health signals.
- Completed/missed run and lift sessions.
- Injury/comeback state.
- User schedule changes.

Adaptation rules:

- Default adaptation window is today plus 48-72 hours.
- Preserve race date, plan phase, and strength floor unless a safety condition requires a larger change.
- Explain the exact evidence and change in plain language.
- Offer `Accept` and `Keep original`. Free-form `Move session` is deferred until after the canonical model and adjustment ledger are Bryan-verified.
- Store an adjustment ledger: original session, replacement, reason, signals used, timestamp, and user choice.
- Never claim a health metric caused a change when the metric is absent or stale.
- Clearly distinguish Apple Health objective data from subjective check-in answers.

Example:

> Sleep and HRV were below your baseline. Tuesday intervals moved to Thursday; today is an easy Zone 2 run. Upper-body strength stays scheduled.

## 8. Surface Simplification

When a user has an active plan:

- Train shows today's scheduled run, not a disconnected recommendation.
- Lift shows today's scheduled lift, not a disconnected recommendation.
- Home shows one Today card sourced from the calendar.
- Races become part of plan setup/manage instead of a competing plan workflow.
- Plan Catalog becomes Create/Manage Plan, not a separate destination after activation.
- The current Adaptive Plan panel is replaced by calendar adjustments.
- PR Wall moves under Progress/History.
- Community remains accessible under More until the core calendar is proven.
- Raw Apple Health details stay under Health/Body, not on the plan screen.

Do not delete user data or remove secondary features in the first pass. Redirect and consolidate navigation only after replacement flows are verified.

## 9. Phased Build

### Phase H1: Canonical Hybrid Plan Model

- Add plan mode and strength policy to setup/payloads.
- Support zero, one, or two dated sessions per day.
- Persist schema-v2 metadata inside plan JSON, with no new DB columns.
- Add bidirectional legacy adapters and deterministic validator.
- Update today, compliance, check-in overrides, missed-session rescheduling, session-rule enforcement, and Plan consumers together.
- Define future-only mode-switch semantics that preserve all past and completed history.
- Remove existing running-first/injury-prevention-only strength wording from every H1-touched engine or compatibility surface.
- Generate a 13-week Army Ten-Miler hybrid-maintain plan and a run-only equivalent in tests.
- No major UI redesign yet.

Gate: backend checks, account-data coverage, plan-model smoke tests, mode-switch preservation tests, frontend build, and a byte-equivalent run-only regression across today/compliance/override/reschedule before Claude Code QA.

### Phase H2: Forged Training Calendar

- Replace current Plan composition with Week/Month segmented views.
- Add Day View paper workout sheet.
- Add original dumbbell/run visual marks and text/full-screen controls.
- Keep Month View read-only except tap-to-open; do not add month-level editing.
- Use CSS and original inline SVG stamps; do not add a visual dependency or copy reference artwork.
- Remove running-first/injury-prevention-only strength copy from the replaced Plan surface.
- Keep all existing plan actions reachable until migration is complete.

Gate: desktop + 375x812 + larger iPhone screenshots, overflow checks, interaction test, Claude Code QA.

### Phase H3: Concurrent Scheduling Engine

- Generate run-only, maintain, and build modes.
- Enforce race phases, interference rules, strength floor, deload, and taper behavior.
- Use real profile/history inputs and validate AI output.
- Validator must reject invalid AI output before persistence, then use a complete deterministic fallback; reshaping invalid output is not sufficient.
- Hybrid strength sessions must be real barbell/dumbbell prescriptions with sets, reps, rest, RPE/RIR, and progression. Do not satisfy the strength floor with conditioning circuits, rucking, sleds, or generic injury-prevention labels.

Gate: deterministic fixtures covering novice/advanced, run-only/hybrid, low/high recovery, missed workouts, and 13-week race plan; Claude Code QA.

### Phase H4: Transparent Adaptation

- Integrate Apple Health, check-in, completion, and injury signals.
- Limit normal changes to 72 hours.
- Add adjustment explanation and Accept/Keep controls.
- Persist adjustment ledger.
- Hard-preserve the race ID, race date, distance, plan phase, verified course facts, and hybrid strength floor unless an explicit safety condition requires a broader proposal.
- Thread structured race-catalog elevation, altitude, terrain, source, and URL into the plan contract. Display official/curated provenance when present and an honest `distance-only - no verified course data` state when absent.
- Reject any AI adjustment that introduces or changes a course fact not present in structured catalog data; use the deterministic fallback wholesale.

Gate: no-data/stale-data/suspect-data smokes, timezone tests, rollback tests, Claude Code QA.

### Phase H5: Unified Daily Execution

- Train/Lift/Home source today's work from the calendar.
- Open exact run/lift prescriptions and completion actions.
- Keep manual workout creation as a secondary path.
- Preserve Apple Watch and manual watch delivery behavior.

Gate: end-to-end phone flow, background run save, lift set logging, watch/manual copy, Claude Code QA.

### Phase H6: Simplification and Migration

- Redirect redundant plan/race/recommendation surfaces.
- Move secondary features without deleting data.
- Any surface that renders AI-generated coaching, plan rationale, or recommendations must carry an inline `AI guidance - not medical advice` note; carry this forward onto whatever the coach/recommendation surface becomes after consolidation.
- Update active docs only after behavior is live.

Gate: route scan, navigation QA, account export/delete coverage, full computer-use pass, Claude Code QA.

### Phase H7: Race Course Intelligence and Provenance

- Resolve a selected race to a canonical event, dated edition, and course version while preserving the user-entered race as a deterministic fallback.
- Expand the curated race catalog through official organizer feeds, licensed sources, permissive public data, and user-supplied GPX. Do not scrape sources against their terms.
- Store or embed provenance, confidence, freshness, and correction history for every course fact used by training logic.
- Add deterministic GPX-derived distance, elevation, terrain, and altitude analysis, with privacy protection for user-uploaded start/end coordinates.
- Use verified course demands to adjust pacing, hill work, long runs, and race execution. AI may explain structured facts but may not invent them.
- Add explicit non-race goal taxonomy after the race loop is proven: distance PR, beginner first run, weight loss, general fitness, hybrid performance, and run for enjoyment.

Gate: Army Ten-Miler live dogfood review; verified/unknown/stale-course fixtures; edition-resolution and GPX privacy tests; fabrication rejection test; deterministic distance-only fallback; Claude Code QA.

## 10. Build Loop and Communication

For every phase:

1. Hermes implements only that phase in an isolated worktree/branch.
2. Hermes runs the phase gates and reports files, tests, and commit.
3. Hermes sends Telegram: `BUILD READY`, phase, commit, files changed, and QA request.
4. Claude Code performs independent read-only QA.
5. Codex reviews QA, verifies claims, applies minimum-scope fixes, reruns gates, and reports here.
6. If clean, push to main and wait for Railway.
7. Verify production before Telegram `SHIPPED` status.
8. Bryan performs phone review; status remains `awaiting verification` until confirmed.
9. No EAS/TestFlight build unless Bryan explicitly approves that specific build.

Required Telegram statuses:

- `STARTED: Forged Hybrid Phase H#`
- `BUILD READY: ... ready for Claude QA`
- `QA ISSUE: ... investigating`
- `SHIPPED: ... Railway deployment ... awaiting Bryan verification`
- `BLOCKED: ... exact user/external action required`

## 11. Definition of Success

A user can create either a run-only or hybrid plan for a dated race, open one calendar, tap any date, and understand the exact run/lift work and its purpose. Health/check-in changes are transparent, reversible, and limited. Hybrid users reach race day without the plan silently deleting their strength objective; run-only users never have to interact with lifting.

The app should feel like a coach wrote a clear training notebook for the individual, not like a collection of dashboards and unrelated AI cards.
