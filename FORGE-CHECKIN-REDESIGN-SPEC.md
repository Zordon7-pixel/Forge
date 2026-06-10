# FORGE — Daily Check-In Redesign Spec
_Owner: Bryan • Drafted by Hermes • 2026-06-09_

## Problem (confirmed by code audit)
The daily check-in is **theater**: it returns a canned `adjustment` string claiming it shortened/recovered today's workout, but it **never mutates the plan**. `readiness_delta` is computed then ignored by the UI. The check-in is an island — it does not feed the existing Recovery Readiness engine (`healthSignals.js`) or the AI Coach. No drift detection exists.

## Goals (Bryan, 2026-06-09)
1. Check-in must **really change today's workout** based on answers + data (APPROVED: real replace).
2. **One headline directive** + optional **full breakdown** (drivers).
3. Heat-aware **drift flag**: compare prescribed vs actual; if Z2→Z3, label heat vs true overreach (APPROVED).
4. HR/zones sourced from **Apple Health** (Garmin API still unanswered — re-apply in parallel, non-code track).

## Architecture decision
Today's workout is GENERATED from JSON (`plan_data`/`plan_json`/`progress_json`) + templates — not a row. So mutation = a **non-destructive daily override layer**:
- New table `checkin_overrides (id, user_id, date, action, patch_json, created_at)`.
- `/plans/today` merges the override on top of the generated day. Reversible, auditable, no plan-JSON rewrite.

---

## Phase 1 — Real plan mutation (override layer)
**WHAT:** Add `checkin_overrides` table. On check-in submit, compute an action (`keep` / `shorten` / `recovery_swap` / `rest`) from feeling+time+flags+sleep, write a patch (e.g. cut distance %, swap type→recovery). `/plans/today` merges it. Adjustment string becomes TRUTHFUL.
**WHY:** Without this the feature is fake — #1 fix.
**HOW:** `checkin.js` derives action; insert override (one per user/day, upsert). `plans.js` getToday() applies patch after building the day. Add migration in `schema.pg.sql` + `migrate.js`.
**GATE:** Submit check-in with low feeling/short time → `/plans/today` returns a visibly shorter/recovery workout; clearing override restores original. Verified on prod data path.

## Phase 2 — Headline directive + full breakdown
**WHAT:** Replace the canned if/else with a structured response: one headline plus a drivers list. Frontend shows the headline; a Why? toggle expands the drivers.
**WHY:** Bryan exact ask — one directive, expandable detail.
**HOW:** Backend builds drivers from check-in inputs plus readiness signals; headline = action verb plus reason. Frontend collapses the breakdown behind a tap on the adjustment screen. Apply readiness_delta (stop ignoring it).
**GATE:** Each driver maps to a real input; headline matches the actual plan mutation from Phase 1.

## Phase 3 — Feed check-in into readiness + Apple Health zones
**WHAT:** Pipe feeling/sleep/flags into buildHealthSignals(); pull HR, resting HR, HRV from HealthKit; derive max HR from observed Apple Health workout max (configurable). Headline generated FROM readiness, not separate logic. ALSO analyze PREVIOUS RUNS: pull run history (pace, distance, HR-zone distribution, weekly volume, acute:chronic load) and surface trends — repeated Z2-to-Z3 drift, volume ramps, stagnation, last-run residual fatigue — as readiness + coaching inputs feeding the daily directive.
**WHY:** Analyze ALL data — subjective plus objective must meet in one engine.
**HOW:** Extend healthSignals.js input row with check-in fields; HealthKit bridge supplies HR fields; zone bands computed from Apple-Health max HR; aggregate recent runs (last 4-6 weeks from runs/workout_sessions) into trend features via computeAcuteChronicRatio plus new history helpers.
**GATE:** Readiness score shifts correctly when check-in says exhausted/low-sleep; zones reflect Apple Health max HR; a runner with 3+ recent Z2-to-Z3 drift runs gets that surfaced as a driver in the directive.

## Phase 4 — Heat-aware drift flag (post-run)
**WHAT:** After a run, compare actual zone/pace vs prescribed. If drifted (Z2 to Z3), factor weather via OpenWeather key, then label heat-expected (e.g. 88F, effort was right) vs true overreach (ease off).
**WHY:** Bryan live case: post-injury base building, heat inflating HR (cardiac drift). Prevents a false you-went-too-hard.
**HOW:** PostRunCheckIn/Dashboard compares run HR-zone vs plan; pull temp at run time (WEATHER_API_KEY); rule-based heat adjustment.
**GATE:** A Z3 easy run on an 88F day is flagged heat-expected, not overreach; a cool-day Z3 on a Z2 plan IS flagged as drift.

---

## Parallel non-code track
- Re-submit Garmin Connect Developer API request (no reply to prior application). Until granted, Apple Health is the data source.

## Build pipeline
Per phase: Hermes pre-flight, Codex build, Claude Code QA (must execute), Hermes review verdict+diff, ship plus post-deploy live-verify. Ship gate: 0 CRITICAL + 0 unresolved HIGH.
