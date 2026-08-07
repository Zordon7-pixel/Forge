# FORGE Week / Month / Run Names Bugfix Spec

## Incident
Bryan reported the same plan-adjustment failure for the third time on 2026-08-07.

Observed production states:
1. Editing weekly run days and rebuilding a multi-race plan returns `Multi-race plan generation failed`.
2. Log Run > Week renders Monday-Sunday as `Undefined` with every badge labeled `Easy`.
3. Log Run exposes only Today / Week / Manual, so the runner cannot see a month view.
4. Bryan wants every scheduled run to have a motivating name, e.g. a hill session named `Hills Pay the Bills`.

## Root-cause requirements
Do not apply another symptom patch. Reproduce the failing multi-race rebuild against current code and inspect the current canonical plan contract. Record the actual root cause in code comments or the commit message. The current Week renderer appears to consume canonical day objects as if they were legacy flat workouts; confirm with a regression test before fixing it. Investigate the current `c4c9eaa` rebuild change and any partial-current-week validation conflict rather than guessing.

## Phase 1 — Rebuild correctness
### WHAT
Make weekly schedule edits rebuild one- and two-race plans successfully while preserving safety constraints and transactionality.

### WHY
The current production endpoint catches an internal error and returns only the generic 500 string.

### HOW
- Add a failing regression fixture for the exact current-week schedule-edit path before changing behavior.
- Prove edited `trainingDays` and `runDaysPerWeek` reach the regenerated plan.
- Preserve current-week partial scheduling: never backfill elapsed days and never overpack remaining eligible days.
- Keep race ownership, date spacing, mileage progression, hard-day spacing, taper, and transaction rollback guarantees.
- Return a safe actionable 4xx for deterministic user-input/schedule conflicts; reserve 500 for unexpected failures. Do not expose internals.
- Do not delete or overwrite the previously active plan unless the replacement validates and persists successfully.

### GATE
Focused dual-race/current-week regression passes, transaction rollback test passes, full backend plan smoke suite passes.

## Phase 2 — Canonical Week + Month views
### WHAT
Fix Week rendering and add a Month tab to Log Run.

### WHY
The Week UI currently assumes flat legacy fields such as `day.type` and `day.distance_miles`; schema-v2 days hold `sessions[]`. Month is absent from the tab list.

### HOW
- Add one normalization helper for canonical and legacy plan shapes. Do not duplicate schema interpretation inside JSX.
- Week must render each date/day with all real sessions, correct Rest/Lift/Run classification, type, distance, title/name, and today highlighting. It must never print `Undefined`.
- Add Month tab/query support. Render the current calendar month from dated plan entries; if the active plan has no dated month overlap, show the next four plan weeks with honest labeling. Include previous/next month controls only when plan data exists for them.
- Week and Month must read the same normalized plan payload and preserve run session IDs for Start This Run.
- Loading, empty, malformed, and API-error states must be distinct and accessible.
- Avoid a second API contract or independent recomputation.

### GATE
Frontend unit/smoke coverage proves canonical schema-v2 days, legacy flat days, multi-session days, rest days, month navigation, malformed entries, and no literal `Undefined` output. Production frontend build passes.

## Phase 3 — Motivational run names
### WHAT
Give every scheduled run a stable, motivating display name while preserving the precise workout prescription.

### WHY
Names make the plan feel like coaching instead of a sterile calendar.

### HOW
- Add a deterministic, owned naming helper. No LLM/API call and no random name changes on rerender.
- Preserve explicit non-generic plan names. Otherwise derive a stable name from workout taxonomy plus date/session ID.
- Include type-appropriate curated names. Required example: hill work can resolve to `Hills Pay the Bills`.
- Cover easy, recovery/shakeout, long, hills, intervals/speed/track, tempo/threshold, race-pace, progression, and fallback run.
- Keep the clinical type and prescription visible as secondary text; the fun name must never hide intensity, distance, pace, zone, or safety context.
- New generated run sessions should persist a display name. Existing/legacy plans should get the same deterministic fallback in normalization so no migration is required.
- Strength and rest entries are not renamed as runs.

### GATE
Determinism test, taxonomy matrix test, legacy-plan fallback test, and UI rendering test pass. Every run in the fixture has a non-empty display name; strength/rest are correctly excluded.

## Build Loop
Codex implements on a feature branch in this clean clone (max 10 changed implementation/test files; split only if necessary). Run host tests/build. Commit and push the feature branch. Claude Code OAuth performs independent read-only full QA. Any blocking finding returns to Codex and is re-QA'd. Hermes reviews the final diff, ships non-force to `origin/main`, verifies the remote SHA, Railway health/artifact identity, live Week/Month behavior, and captures AFTER screenshots. Forge's Capacitor shell remote-loads Railway, so this web/backend change does not require a new TestFlight binary.

## Release status
Do not call this verified fixed until the reviewed commit is live and the running production Week and Month surfaces have been exercised. Physical iPhone confirmation remains the final user-device closure step.
