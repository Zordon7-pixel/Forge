# Forged Hybrid Race Visibility + Travel/No-Gym Adaptation Implementation Plan

> **Implementer:** Codex. Read `CLAUDE.md` and `QA-CHECKLIST.md` before editing. Do not commit or push; leave the reviewed files in the working tree for Hermes.

**Goal:** Make a saved Yonkers race visibly join the existing Army plan through one explicit in-context action, and make Forged Hybrid proactively offer safe nearby-running, runner-specific no-equipment strength, recovery, or keep-plan choices when travel, a gym constraint, or a real run gap makes the prescribed day hard to execute.

**Architecture:** Extend the already-shipped schema-v2 dual-race planner rather than creating another plan model. Add one compact stale-plan reconciliation card on Train that invokes the existing owner-scoped `/plans/generate-for-races` endpoint. Add a deterministic, non-AI travel-choice helper and a user-scoped bodyweight-alternative endpoint that reads the exact active-plan lift session but does not mutate the plan. Reuse existing route planning, recovery prep, daily execution, and plan-session completion contracts.

**Tech stack:** Express/CommonJS backend, React/Vite frontend, existing Capacitor remote-loaded web shell, Node smoke tests. No new dependency, AI call, schema migration, native plugin, EAS build, or background location use.

---

## Product truths

1. One active plan may protect at most two ordered PR race goals. For Bryan’s current case:
   - A1 / first peak: Yonkers Half Marathon, 2026-09-20, 13.109 miles, sub-2:00.
   - A2 / final peak: Army Ten-Miler, 2026-10-11, 10 miles, 1:27:00.
2. `plan.goal` remains the final race for compatibility; `plan.goals` owns both. Do not weaken the existing exact race-session/course/phase invariants.
3. The current production symptom is a stale single-goal plan created before Yonkers was added to the active plan. The race can exist in `race_events` while Train still displays only Army.
4. No-gym does not mean “add another run.” The safe option depends on today’s canonical session, run-gap evidence, readiness, injury state, and whether today’s run is already recorded.
5. The travel/no-gym feature is deterministic. Do not use OpenAI or any LLM.
6. Rest remains a valid choice. Never punish missed work, prescribe catch-up mileage, or overwrite the stored calendar merely because the user opens or dismisses the prompt.
7. Geolocation is requested only after the user taps route planning. Do not infer travel from background location and do not add a native plugin.

---

## Allowed implementation scope — maximum 10 tracked files

Codex may modify/create only these files unless a test-proven blocker requires swapping one test path for another:

1. `FORGE-RACE-TRAVEL-ADAPTATION-SPEC.md` — read only; do not rewrite.
2. `backend/src/routes/plans.js`
3. `backend/src/lib/travelTraining.js` (new)
4. `backend/test/travelTraining.smoke.js` (new)
5. `frontend/src/lib/travelTraining.js` (new)
6. `frontend/src/components/TravelTrainingPrompt.jsx` (new)
7. `frontend/src/pages/Dashboard.jsx`
8. `frontend/src/pages/Plan.jsx`
9. `frontend/src/pages/LogRun.jsx`
10. `frontend/test/travelTraining.smoke.mjs` (new)

Do not edit package locks, Capacitor/native files, environment files, database schema, race catalog data, or unrelated UI.

---

# Phase 1 — Surface and reconcile a saved race missing from the active plan

## WHAT

On Train, detect when the user has exactly one protected race goal in the active plan and exactly one eligible saved upcoming PR race is not protected. Show a compact card immediately below the main calendar header/content:

- Eyebrow: `Race not in this plan`
- Headline: `Add Yonkers Half Marathon to your Army plan?` using live race names.
- Supporting copy: both dates and that one plan will protect both peaks.
- Primary action: `Add to this plan`
- Secondary action: `Review races`

The primary action calls the existing `/plans/generate-for-races` endpoint with the current and missing race IDs ordered by race date. After success, reload the active plan/races so the existing `ForgedCalendar` multi-goal cards visibly render A1 and A2.

## WHY

The dual-race engine and header already exist, but a previously generated single-race plan does not auto-upgrade when a second race is saved. The missing reconciliation affordance makes shipped functionality appear absent.

## HOW

Implement pure helper(s) in `frontend/src/lib/travelTraining.js` or a clearly named section in that file to derive one race reconciliation candidate from:

- calendar goals / active plan goal IDs;
- saved race rows;
- phone-local today.

Eligibility rules:

1. Active plan protects exactly one non-empty race ID.
2. Candidate is `status === 'upcoming'`, date today or later, not already protected, has a positive `goal_time_seconds`, and is not the same race/date identity.
3. The current protected race must resolve to a saved race row and also have a positive PR time.
4. The ordered pair must be at least 21 days apart; otherwise do not offer direct generation and route the user to Races for manual review.
5. If more than one eligible unprotected race exists, do not guess. Show a generic `Review races` card instead of a direct one-tap pair.
6. Never auto-generate on page load. Plan replacement is explicit after the tap.
7. On request failure, preserve the current plan and show the server’s safe error. Do not claim the plan changed.
8. Disable duplicate taps while the request is in flight.

## GATE

- A single Army plan plus saved Yonkers produces one direct reconciliation candidate in chronological order.
- Tapping the CTA posts exactly the two owned race IDs to `/plans/generate-for-races`, reloads on success, and exposes both `model.goals` cards.
- Already-combined plans, past races, completion-only races, duplicate identities, pairs under 21 days, and ambiguous 3-race states do not direct-generate.
- Existing dual-race smoke tests remain green.

---

# Phase 2 — Deterministic travel/no-gym choice engine

## WHAT

Add one reusable `TravelTrainingPrompt` used on Today and Train. The prompt should become prominent when any of these are true:

- today’s check-in includes `traveling`;
- today has a scheduled lift and the user may need a no-gym alternative;
- the active adaptation proposal contains `run_gap` or `training_gap` evidence.

Copy should ask a useful question rather than accuse the athlete of missing work, for example:

> `Training away or no gym today?`
> `Keep the plan useful without forcing catch-up mileage.`

Render only choices that are safe and executable:

1. **Run near me**
   - If today has a scheduled run, preserve that exact run and plan-session ID and open the existing route planner at the phone’s current location.
   - If today is rest/lift-only, offer a short recovery-route option only when all are true: a real run-gap proposal exists, no active injury exists, readiness is not poor/red/unavailable due to a safety state, and no run is already recorded today.
   - The fallback recovery run is conservative: 20 minutes, at most 2 miles, Zone 1–2, fully conversational, walking allowed, no goal pace, hills, intervals, tempo, or race effort. It is unplanned and must not steal a plan-session ID.
2. **Runner strength — no equipment**
   - Offer when today has a canonical scheduled lift and no active injury blocks it.
   - Fetch an exact server-built bodyweight alternative for that plan session, then open the existing lift flow with the same plan-session ID/current week so completion still credits the scheduled lift.
3. **Mobility / recovery**
   - Open the existing `/prep?mode=recovery` flow.
4. **Keep today as planned**
   - Dismiss for the phone-local date without mutating the plan. A session-scoped/date-scoped browser key is enough; it must not suppress tomorrow.

## WHY

Travel removes equipment and route familiarity, not the training goal. Forged Hybrid should translate the planned stimulus into an executable option while preserving injury prevention and the user’s right to rest.

## HOW — frontend

Create pure deterministic helpers in `frontend/src/lib/travelTraining.js`. Suggested contracts:

- `deriveRacePlanReconciliation(...)`
- `trainingGapEvidence(...)`
- `deriveTravelTrainingChoices({ execution, checkinData, adaptationProposal, readiness, activeInjury, hasRunRecordedToday })`
- `buildTravelRecoveryWorkout(...)`
- strict `normalizeTravelWorkoutOverride(...)` used by `LogRun` before honoring navigation state.

Rules:

1. Treat check-in life flags as an array or parse a JSON/string representation defensively.
2. Reuse `resolveReadiness` in the caller; do not create a second readiness truth engine.
3. Scheduled run choice must reuse existing `runRouteState(execution)`.
4. Extend `LogRun` to honor only a strictly normalized `travelWorkoutOverride` from navigation state. Clamp/force the recovery contract above. Arbitrary client values must not turn it into a hard workout or attach a plan-session ID.
5. `TravelTrainingPrompt` must have 44px minimum tap targets, accessible labels/status/error text, loading state for the bodyweight request, no horizontal overflow at 320px, and no nested modal trap.
6. Today should pass its already-loaded execution, check-in, readiness, injury, adaptation, and recorded-run truth. Do not add redundant API calls.
7. Train may derive today’s day/session from its already-loaded calendar and adaptation proposal. It may fetch only the small additional safety data it genuinely lacks, or conservatively omit unsafe choices when safety truth is unavailable. Never interpret unavailable safety truth as green.
8. Do not offer an extra run just because a lift exists. The extra recovery route requires run-gap evidence plus safe readiness/injury truth.
9. Keep the existing TrainingGapPrompt’s `Ease my return` / `Keep original` calendar decision. The new prompt supplies executable travel choices; it does not replace or silently accept the seven-day plan adjustment.

## HOW — backend bodyweight alternative

Add a user-scoped authenticated endpoint under plans, named consistently such as:

`POST /api/plans/today/bodyweight-alternative`

Input:

```json
{ "date": "YYYY-MM-DD", "session_id": "stable-plan-session-id" }
```

Contract:

1. Strictly validate the phone-local date using the existing planning-date safety rule and require a non-empty bounded session ID.
2. Load only the requesting user’s active plan through the existing owner-scoped helper.
3. Select the exact dated day with `dailyExecution.selectDayForDate` and recompute stable session IDs using existing plan schema/daily execution helpers.
4. Find the exact lift session ID on that exact date. Reject missing, run, rest, another date, completed/invalid, or arbitrary IDs with 4xx. Do not accept a client-supplied workout body.
5. Build the no-equipment alternative in new pure `backend/src/lib/travelTraining.js`, reusing `strengthAdjunct` where useful.
6. Every returned exercise must be executable with bodyweight only. If a gym-specific or unknown movement cannot be safely translated, replace it with a conservative runner-beneficial no-equipment movement rather than returning unusable equipment.
7. Preserve the original session ID/date/focus linkage, but clearly label the returned session `Runner strength — no equipment`, `adjustedForTravel: true`, `equipment: ['bodyweight']`, and include bounded full prescriptions: sets, reps/time, rest, cue, and progression.
8. No jumps, hops, depth jumps, or high-impact plyometrics by default because the floor/surface and injury state are unknown.
9. Suggested movement families: tempo squat, reverse lunge or split squat, single-leg hip bridge, standing calf raise, push-up/pike push-up when appropriate, prone pull-down, side plank/dead bug. Keep total work around 20–25 minutes and volume submaximal around race training.
10. This endpoint returns an alternative only. It does not mutate the plan, progress, races, or user preferences.
11. No AI call and no new database data.

## GATE

- A traveling check-in or scheduled lift/run-gap state produces the correct bounded prompt; ordinary safe planned days do not create noisy duplicate coaching.
- Active injury/poor safety truth removes the extra-run and strength choices, leaving recovery/keep-plan.
- A scheduled run opens current-location route planning with the original plan session.
- A rest/lift-only run-gap recovery route is always 20 minutes, <=2 miles, Zone 1–2, walking allowed, and has no plan-session ID.
- The bodyweight endpoint cannot access another user, another date, a run, or an arbitrary session ID.
- Bodyweight output contains no gym-equipment requirement and does not mutate the stored plan.
- Completing the bodyweight alternative uses the original scheduled lift session ID.
- Existing `/plans/today`, adaptation, race, route, run, and lift flows remain behavior-compatible.

---

# Tests and verification

## New backend smoke

`node backend/test/travelTraining.smoke.js`

Must execute pure helper cases and route-boundary cases with a mocked DB/module cache as existing plan route smokes do. Cover:

- exact owner/date/session success;
- foreign/missing/blank/oversized session ID rejection;
- run/rest/wrong-date rejection;
- bodyweight-only output and no plyometric names;
- original plan object byte/deep equality after generation;
- no write query and no AI call;
- stable plan-session ID preserved.

## New frontend smoke

`node frontend/test/travelTraining.smoke.mjs`

Must import the pure frontend helper and cover:

- Army + Yonkers direct reconciliation;
- already combined, under-21-day, past, completion-only, duplicate, and ambiguous race cases;
- traveling lift choices;
- scheduled-run route preservation;
- run-gap recovery-route eligibility;
- injury, poor/unavailable safety truth, and run-already-recorded suppression;
- recovery override clamps/strips hard content and plan-session IDs.

## Required existing gates

Run at minimum:

```bash
node backend/test/dualRacePlan.smoke.js
node backend/test/forgedHybridH3.smoke.js
node backend/test/forgedHybridH13.smoke.js
node backend/test/forgedHybridRunGap.smoke.js
node backend/test/strengthAdjunct.smoke.js
node backend/test/dailyExecution.smoke.js
node frontend/test/forgedCalendar.smoke.mjs
node frontend/test/dailyExecution.smoke.mjs
npm run build --prefix frontend
node --check backend/src/routes/plans.js
node --check backend/src/lib/travelTraining.js
git diff --check
```

If an exact filename differs, use the existing matching smoke and report the real command. Do not silently skip a missing test.

---

# QA focus

Independent Claude Code QA must verify:

1. No second active plan is created; combined generation remains atomic and user-scoped.
2. Exact Yonkers and Army races, dates, target times, paces, course facts, phases, and race sessions remain protected.
3. The reconciliation helper does not auto-mutate or guess among more than two races.
4. Bodyweight endpoint trusts only the owner’s stored active-plan session, not client workout content.
5. No extra run is offered on active injury, poor/unknown safety state, or after a run already exists today.
6. Rest remains available and no catch-up mileage language/behavior exists.
7. Route planning requests foreground geolocation only after tap.
8. 320px mobile layout, 44px controls, loading/error states, and no duplicate Today/Train noise.
9. No LLM, schema, secret, native, dependency, or build-number changes.

---

# Release gate

This is a frontend/backend web deployment to Railway. Because Forge’s Capacitor shell loads `https://forge-production-773f.up.railway.app` remotely, no EAS/TestFlight rebuild is required.

Do not call it verified until all are true:

1. Codex implementation is committed with the commit guard and the worktree is clean.
2. Independent Claude Code OAuth/Opus QA reports 0 CRITICAL and 0 HIGH.
3. Hermes reviews the integrated diff and all test output.
4. Reviewed head is non-force pushed to `origin/main`; remote SHA is read back and matches.
5. Railway serves the reviewed frontend asset and health check passes.
6. Running-app AFTER screenshots show:
   - stale one-race plan reconciliation card before upgrade;
   - both A1 Yonkers and A2 Army after the combined plan action or an exact deterministic fixture;
   - travel/no-gym choices on a representative safe state;
   - injury/poor-readiness state suppresses unsafe run/strength choices.
7. Compare against Bryan’s provided BEFORE screenshot at `/Users/zordon/.hermes/cache/images/img_fc97ad1569c9.jpg`.

Use precise release language: `patched`, `shipped`, `awaiting physical-device verification`, or `verified fixed`. Do not claim a new native build.