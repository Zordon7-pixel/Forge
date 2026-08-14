# FORGE Dual-Race Immediate Adoption + Race-Specific Challenge Fix

**Date:** 2026-08-14
**Status:** Implementation specification
**Base:** `origin/main` at `8795d37839b5590e33dc5716455e370f9aa8b238`
**Owner:** Codex implementation → independent Claude Code QA → Hermes final review/ship

## Evidence and provenance

Bryan supplied two live iPhone screenshots from production:

- `/Users/zordon/.hermes/cache/images/img_d053096023f6.jpg`
- `/Users/zordon/.hermes/cache/images/img_a9f7217ab077.jpg`

Screenshot 1 shows an impossible state after tapping **Add to this plan**:

- the green status says `Both race peaks are now protected in one plan.`;
- the card still says `RACE NOT IN THIS PLAN` and still offers **Add to this plan**;
- the visible calendar still reflects the prior HYROX-only plan.

Screenshot 2 shows Aug 17–23:

- Mon: Easy aerobic run — 2.2 mi / 24 min;
- Tue: HYROX station strength — 50 min;
- Wed: Rest;
- Thu: Controlled compromised running — 2.5 mi / 1h 4m;
- Fri: Rest;
- Sat: Rest;
- Sun: Long run — 3.5 mi / 39 min.

Visible running volume is 8.2 miles.

Hermes reproduced the persistence defect against live production revision `8795d37839b5590e33dc5716455e370f9aa8b238` with a disposable account and deleted all disposable data afterward:

- first HYROX plan applied with `effective_from=2026-08-14`;
- accepted combined HYROX + Army 10-Miler candidate applied with `effective_from=2026-08-15`;
- immediate `GET /api/plans/my` still returned the one-goal HYROX predecessor;
- the combined candidate itself correctly contained both goals;
- therefore the frontend reload correctly recomputed the race as missing and kept the CTA visible.

The same live reproduction showed that a 2026-08-14 planning date and 2026-09-06 HYROX date create exactly four calendar weeks. Current phase allocation produces:

`orientation_assessment → build → sharpen_reduce → taper_race`

It skips `peak_partial_simulation`, violating the shipped short-runway design: 21–41 day plans must include the largest bounded partial race-order cluster before the final reduction week.

The running-race pivot also currently drops `goal_time_seconds` from the retained secondary race and implements `Controlled running-race rhythm` by relabeling an easy run. That does not produce actual 10-mile target specificity.

## Product verdict

The visible week is technically hybrid because it includes running plus station strength plus compromised running. It is not a convincing race-specific HYROX week for this exact four-week runway because the peak-specific phase is accidentally omitted. Do **not** solve that by arbitrary mileage inflation. Preserve the real recent-running baseline and challenge the athlete through the missing bounded race-order cluster, station density, and honest post-HYROX 10-mile specificity.

The Army 10-Miler is not supposed to be trained as a second simultaneous peak before Sep 6. The ordered architecture remains:

`HYROX specificity → HYROX race → readiness-aware recovery → bounded Army 10-Miler specificity → taper/race`

## Required implementation

### Phase 1 — Make accepted replacement plans active today

**WHAT**

For an explicit, successfully reviewed candidate apply, use `planning_date_local` as the replacement assignment's `effective_from` for add/rebuild operations as well as remove-race operations.

**WHY**

The candidate generator already reconciles completed current-week runs and strength, avoids elapsed-day backfill, preserves recorded history, and regenerates today/future sessions. Delaying the accepted replacement until tomorrow makes the success copy false and keeps the stale race reconciliation CTA.

**HOW**

- Update candidate-apply assignment cutover in `backend/src/routes/plans.js`.
- Preserve candidate replay/idempotence, lineage, superseding, transaction boundaries, planning-input revision checks, and recorded activity history.
- Do not mutate completed runs, lifts, health data, or check-ins.
- Do not duplicate today's completed run or backfill elapsed days.
- An immediate same-day `/plans/my` read after apply must resolve the new combined plan.
- The existing frontend `loadAll()` path must then recompute no missing protected race, causing the CTA to disappear without a page restart.

**GATE**

Add a route-level regression that reproduces the exact sequence: active HYROX assignment → preview combined HYROX + Army candidate → apply on the same local date → immediate active-plan read. Assert:

- response `effective_from` equals `planning_date_local`;
- immediate active plan has two goals;
- the predecessor is not returned for that local date;
- replay returns the same result without a duplicate assignment;
- completed current-week activity remains represented exactly once.

### Phase 2 — Guarantee a peak-specific exposure in four-week short runways

**WHAT**

Correct short-runway phase allocation so any eligible 21–41 day plan with enough calendar weeks includes one peak-specific phase before reduction/taper. The exact Bryan fixture must no longer skip it.

For planning Friday 2026-08-14 toward HYROX Sunday 2026-09-06, expected phase sequence is:

`orientation_assessment → peak_partial_simulation → sharpen_reduce → taper_race`

A five-week short runway remains:

`orientation_assessment → build → peak_partial_simulation → sharpen_reduce → taper_race`

Longer short-runway windows may include additional build/specific work but must have one clear largest partial cluster before reduction.

**WHY**

The current progress thresholds skip the peak phase at count=4. That makes the only full loading week look like maintenance rather than short-runway specialization.

**HOW**

- Correct deterministic phase allocation in `backend/src/lib/hyroxPlan.js`.
- Keep one station strength/skill exposure plus one controlled compromised exposure.
- In a non-safety-hold peak week, the compromised session must be the block's largest bounded partial race-order cluster, not a full simulation.
- Preserve the real current mileage baseline; do not invent race mileage or exceed safe progression just to look harder.
- Preserve `safetyHold`: no heavy station work and no more than two pairings when comeback/injury/low readiness requires it.
- Preserve at most two hard lower-body days in every rolling seven-day window.
- Preserve race-minus-six-to-zero protection, cross-week hard/long spacing, finite distances, and no past-session backfill.

**GATE**

Add exact tests for four- and five-week short-runway phase sequences. For the 2026-08-14 → 2026-09-06 non-safety-hold fixture, assert the Aug 17 week:

- is `peak_partial_simulation`;
- contains station work and one compromised run/station cluster;
- has the largest compromised pairing count before reduction;
- remains within rolling hard-lower-body and race-safety invariants;
- contains no full simulation;
- does not fabricate station distance as running mileage.

Also assert the same fixture with safety hold remains conservative.

### Phase 3 — Make the retained Army 10-Miler goal genuinely specific

**WHAT**

Preserve the retained running race's goal-time contract and generate bounded 10-mile-specific work after HYROX recovery.

**WHY**

`targetFromOwnedRaces()` currently passes secondary name/date/distance but drops `goal_time_seconds`. `buildRunningWeek()` creates an easy run and relabels it `quality`, leaving generic Zone 2 guidance. A 10-mile target cannot be called protected if the plan loses target pace and never prescribes race-specific rhythm.

**HOW**

- Carry `goalTimeSeconds`, `goalType`, and derived `goalPaceSecondsPerMile`/label for the secondary race using existing FORGE goal-pace conventions (`concurrentPlan.goalPaceSecondsPerMile`, `formatPaceLabel`, or equivalent existing contract).
- Preserve these fields in `goals[]` and the normalized secondary-race object.
- Replace the mislabeled easy-run implementation with a real bounded running-specific session after the post-HYROX recovery week.
- If a valid goal time exists, use structured controlled target-pace intervals/rhythm; never prescribe an all-out time trial.
- If no valid goal time exists, use honest effort-based 10-mile/threshold guidance without inventing a pace.
- Progress the long run across the available running-specific weeks from the real baseline and race distance, then reduce it before race week. Do not jump to ten miles in training and do not exceed a defensible weekly progression cap.
- Preserve three versus four run-day authority from the accepted plan.
- Preserve the post-HYROX recovery week and readiness/adaptation safety.
- For Bryan's known Army target fixture, use 1:27:00 / 10 miles = 522 seconds per mile (`8:42/mi`) as the deterministic test case.

**GATE**

For HYROX 2026-09-06 + Army 10-Miler 2026-10-11 with a 1:27:00 goal:

- goals remain ordered HYROX then Army;
- Army goal carries 522 sec/mi and `8:42/mi`;
- the first post-HYROX week remains recovery;
- subsequent running-specific weeks contain real structured race-rhythm work, not an easy Zone 2 session with a renamed title;
- long-run distance rises across the specificity block and reduces before/race week;
- total weekly running remains baseline-bounded and all hard-day/race-safety checks pass.

## Files and scope

Preferred scope, maximum 10 files:

1. `.hermes/specs/FORGE-DUAL-RACE-ADOPTION-AND-LOAD-FIX-SPEC.md`
2. `backend/src/routes/plans.js`
3. `backend/src/lib/hyroxPlan.js`
4. `backend/test/hyroxPlanEngine.smoke.js`
5. `backend/test/dualRacePlan.smoke.js`
6. Any one additional existing focused test file only if required for immediate active-plan resolution.

Do not edit unrelated frontend screens, native files, deployment files, lockfiles, or credentials.

## Required verification

Run at minimum:

```bash
node --check backend/src/routes/plans.js
node --check backend/src/lib/hyroxPlan.js
node backend/test/hyroxPlanEngine.smoke.js
node backend/test/dualRacePlan.smoke.js
npm run test:smoke
npm --prefix frontend run build
npm --prefix frontend run test:smoke
npm --prefix frontend run qa:ios-contract
```

Then run any focused route/test command added by the implementation and `git diff --check`.

## Non-negotiable constraints

- No production mutation, deploy, push, merge, or commit from Codex.
- No real user data access.
- No LLM-generated plan dosage.
- No arbitrary mileage challenge toggle.
- No hard-day safety regression.
- No fake running mileage from station meters.
- No plaintext credentials or tokens.
- Keep output deterministic and timezone-safe.
