# Claude Code QA: Forged Hybrid Final Testing Phase 3

Perform a read-only QA of the current `codex/forged-hybrid-final-testing` HEAD in:

`/Users/zordon/.codex/worktrees/forged-hybrid-final-testing`

Phase 3 base is Phase 2 commit `eb36d9ab`. Read `CLAUDE.md` first. Do not edit files, push, deploy, or run EAS.

## Objective

Verify that Forged Hybrid uses Apple Health, activity history, custom heart-rate zones, and check-in inputs truthfully when building hybrid plans. This phase specifically codifies the real user examples reported during device testing and removes a hidden walk-as-run assumption from the recent-load helper.

## Changes under review

1. `backend/src/lib/recentRunLoad.js`
   - `normalizeRun()` now rejects known non-running activity rows with shared `isRunActivity()`.
   - Production plan queries already use `runActivitySql()`, so this is defense in depth for direct/future callers.
   - Rows without type metadata remain backward-compatible and default to run under the shared classifier.
2. `backend/test/forgedHybridH9.smoke.js`
   - Realistic Apple Health fixture now explicitly identifies the 7.312-mile run and later 0.287-mile walk.
   - Seven-day run load must be 7.3 miles / 0.80 ratio, not 7.6 / 0.84.
3. `backend/test/finalBetaTrainingTruth.smoke.js`
   - New deterministic, no-DB, no-network final-beta truth suite.
   - Covers activity identity, exact watch HR thresholds, zone-sample coverage fallback, recent-load safety, date-only timezone behavior, health freshness, no fabricated metrics, hybrid adaptation, complete lift prescriptions, input provenance, and automatic native Apple Health sync wiring.

## Real fixtures and required truths

Custom watch zone minimums:

`[96, 117, 137, 156, 176]`

- 129 bpm must be Z2.
- 150 bpm must be Z3.
- Z5 begins at 176 bpm.

Apple Health activities on 2026-07-13:

- Running: 7.31 miles, 5,040 seconds, RPE 5, average HR 150, max HR 174.
- Zone seconds: Z1 31, Z2 171, Z3 2,713, Z4 1,785, Z5 0.
- Walking: 0.29 miles, 369 seconds, average HR 129, logged later than the run.

Required results:

- weekly run volume is 7.3 miles, never 7.6;
- the later walk cannot become the latest meaningful run;
- well-covered zone seconds remain exact and identify Z3 as dominant;
- sparse samples such as 10 seconds in Z5 over an 84-minute run must be discarded in favor of calibrated average HR (Z3);
- the long run protects hard running and lower-body lifting through 2026-07-15 under caution recovery;
- the hybrid strength floor remains present but conflicting lower-body work moves outside protection;
- each strength exercise has sets, reps, rest, load guidance, and RPE/RIR;
- fresh Apple Health data can influence readiness; stale-only data cannot;
- missing advanced metrics stay absent, not zero or invented;
- plan provenance includes the recent run, Apple Health context, and check-in;
- native app open/foreground automatically attempts bounded sync, workout-history fetch, and idempotent import.

## Required review

1. Inspect the complete diff from `eb36d9ab`.
2. Verify importing `isRunActivity` into `recentRunLoad.js` cannot create a cycle or break callers that select only run fields without `type`.
3. Enumerate all `summarizeRecentRunLoad()` callers and confirm production behavior remains correct.
4. Validate every expected number in the new smoke independently, especially zone-second coverage, `loadRatio`, and 24–72-hour dates.
5. Confirm the plan asserts both safety and strength preservation; it must not pass merely by deleting all training.
6. Confirm stale/missing Apple Health assertions cannot pass because of fixture timestamp mistakes.
7. Inspect automatic sync implementation, not just regexes, for:
   - native-only behavior;
   - logged-in guard;
   - in-flight guard;
   - five-minute throttle;
   - app-open and foreground triggers;
   - workout-history classification/import;
   - throttle timestamp only after completed sync;
   - retry eligibility after failure.
8. Confirm no LLM/API/network call occurs in the smoke.
9. Re-run exactly:

```bash
node --check backend/src/lib/recentRunLoad.js backend/test/forgedHybridH9.smoke.js backend/test/finalBetaTrainingTruth.smoke.js
node backend/test/forgedHybridH9.smoke.js
node backend/test/forgedHybridH10.smoke.js
node backend/test/forgedHybridH11.smoke.js
node backend/test/forgedHybridH12.smoke.js
node backend/test/finalBetaTrainingTruth.smoke.js
cd frontend && npm run build
cd frontend && npm audit --audit-level=high
cd backend && npm run check:account-data
cd frontend && npx cap sync ios
```

Do not run the guarded production mutation smoke in this read-only pass.

## Verdict format

Lead with findings ordered CRITICAL/HIGH/MEDIUM/LOW and cite `file:line`. Then provide:

- `VERIFIED` / `DISAGREE` / `FIX REQUIRED` for each changed file;
- exact H9/H10/H11/H12/final truth assertion totals;
- automatic-sync safety assessment;
- whether the exact walk/run/HR-zone examples are now handled correctly;
- toolchain table;
- final verdict: `PASS`, `PASS WITH RISKS`, or `FAIL`.

