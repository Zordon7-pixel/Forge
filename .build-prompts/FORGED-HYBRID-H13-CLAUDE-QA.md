# Claude Code QA: Forged Hybrid evidence-backed timed race plans

Perform an independent, read-only QA of:

`/Volumes/Zordon Storage /openclaw-workspace/forge-app`

Branch: `main`
Base commit: `62159d9c`

Read `CLAUDE.md` first. Inspect the complete working-tree diff from the base commit; do not review only this prompt. Do not edit files, mutate production data, commit, push, deploy, or run EAS/TestFlight.

## User-reported failures

1. The active Army Ten-Miler plan stayed around one or two miles per run even though the athlete recently completed 7.31 miles and wants to race for a PR.
2. Distance was treated as the only useful prescription. Recovery, easy, long, and quality work also need coherent time-based targets.
3. Plans appeared to be generic AI output instead of being grounded in public coaching, research, and athlete-practice evidence.
4. Athletes saw an internal native-shell diagnostic: `Apple Watch delivery requires TestFlight build 16 or newer. You have build 15`.
5. Sparse full-screen states were large blank black areas with no Forged Hybrid identity.

## Intended behavior

- Race-plan generation is deterministic. The two plan-generation routes do not call an LLM and do not consume an AI usage quota.
- Recent meaningful run history establishes bounded 14-, 28-, and 56-day mileage anchors. Tiny fragments under 0.5 miles and under 10 minutes cannot inflate the baseline.
- A single cautious check-in or recovery state changes the next 48-72 hours, not the entire multi-week race block.
- A recent long run protects the immediate window while preventing week one from resetting far below demonstrated capacity.
- The latest run remains truthful, but a short recovery run inside 72 hours cannot hide the prior long run that should anchor acute-load protection.
- Midweek regeneration counts completed current-week mileage, does not backfill past/completed dates, and never schedules a second long run after one is already complete.
- A 10-mile PR plan builds progressively, includes deload/taper structure, reaches a meaningful long-run and weekly-load peak, and preserves the exact race distance/date.
- Non-race runs are prescribed primarily by time and effort. Their distance remains an internal load estimate; the UI must not present it as the athlete's target. Race day remains distance-primary.
- Quality-session total duration is compatible with its warm-up, repetitions, recoveries, and cool-down.
- WatchWorkoutService and WatchDeliveryService preserve time goals for Apple Watch/manual entry instead of converting them to open or distance workouts.
- Public references are clearly labeled as research, coach plans, or athlete practice. Elite examples inform principles only; elite volume is never copied.
- The detailed build/plugin reason remains available in internal console diagnostics. Athlete UI uses a stable friendly message with manual entry still available and never exposes build numbers.
- Ordinary browser-only Watch unavailability does not emit an error-level console log.
- Sparse check-in states use the real `/icon-192.png` asset as a subtle watermark without covering content or bottom navigation.
- No EAS build is authorized.

## Source claims to verify

Check that each URL is reachable and that the local summary is a defensible paraphrase, not an invented result:

- https://pubmed.ncbi.nlm.nih.gov/34749417/
- https://pubmed.ncbi.nlm.nih.gov/35418513/
- https://pubmed.ncbi.nlm.nih.gov/29249083/
- https://www.greatrun.org/train-and-prepare/training-plans/10-mile/
- https://coros.com/stories/athlete-stories/c/inside-the-training-of-jakob-ingebrigtsen
- https://www.nike.com/a/plan-your-ideal-recovery-day-workout

Do not require elite-athlete schedules to become causal evidence. Flag overclaims, medical claims, copied plans, or unsupported numeric thresholds.

## Review priorities

1. Trace `estimateWeeklyMileageBaseline`, mileage progression, allocation, acute-load protection, tapering, and validation. Look for unsafe jumps, double reductions, impossible durations, race-week errors, timezone errors, or a history spike becoming the baseline.
2. Simulate at least these cases: no history, fragmented short activities, a recent 7.31-mile long run before a 10-mile PR block, that long run followed by a 2.17-mile recovery run, midweek regeneration after both runs, a cautious check-in, a run-only athlete, and a hybrid-maintain athlete.
3. Fuzz low-mileage/high-frequency combinations. A 3-mile baseline with 6 requested run days must still produce a valid plan; deload and taper validation must not become mathematically impossible because of a hidden per-session distance floor.
4. Confirm every read/write in plan routes remains authenticated and user-scoped. Inspect the persistence transaction and active-plan replacement behavior.
5. Confirm removal of the LLM call does not leave dead imports, stale AI-limit assumptions, response-contract drift, or frontend reliance on `generation_source: ai`.
6. Trace `duration_min`, `prescription_basis`, and `distance_is_estimate` through backend JSON, plan normalization, calendar rows, day view, Start Run navigation, WatchWorkoutService, WatchDeliveryService, and fallback text.
7. Inspect mobile layout at 390x844. Check references disclosures, long source copy, Watch unavailable state, day metrics, logo watermark, safe areas, overflow, and bottom-nav overlap.
8. Confirm the build-15/build-16 message is accurate against `app.json`, pbxproj, and native plugin registration, but no exact build requirement is rendered to athletes.
9. Flag any empty catch, raw SQL interpolation, unscoped mutation, fabricated data, external source overclaim, or accidental native/EAS change.

## Required commands

```bash
cd "/Volumes/Zordon Storage /openclaw-workspace/forge-app"
git diff 62159d9c --check
node --check backend/src/lib/trainingEvidence.js backend/src/lib/concurrentPlan.js backend/src/routes/plans.js
node backend/test/forgedHybridH13.smoke.js
node backend/test/forgedHybridH3.smoke.js
node backend/test/forgedHybridH8.smoke.js
for file in backend/test/forgedHybridH{1,4,5,6,9,10,11,12}.smoke.js backend/test/finalBetaTrainingTruth.smoke.js; do node "$file"; done
for file in backend/scripts/{active-run-gps-gap,checkin-time-cap,plans-cow,pr-recompute,race-course,route-engine,streak-anchor,watchsync-dedup}-smoke.js backend/heatDrift-smoke.js backend/interference-smoke.js; do node "$file"; done
for file in frontend/test/*.smoke.mjs; do node "$file"; done
cd frontend && npm run build
npm audit --audit-level=high
npx cap sync ios
xcrun swiftc -parse ios/App/App/ForgeHealthPlugin.swift ios/App/App/ForgeWatchWorkoutPlugin.swift ios/App/App/AppViewController.swift
cd ../backend && npm run check:account-data
```

If `npx cap sync ios` creates tracked native diffs, report them and do not commit them. Do not use EAS to compensate for a local native-tooling limitation.

## Verdict format

Lead with findings ordered CRITICAL / HIGH / MEDIUM / LOW and cite exact `file:line` evidence. Then report:

- each user-reported failure as `VERIFIED FIXED`, `DISAGREE`, or `FIX REQUIRED`;
- baseline/progression and acute-protection assessment;
- timed-prescription/watch-payload assessment;
- evidence-source accuracy and overclaim assessment;
- mobile visual assessment;
- exact smoke totals and toolchain table;
- native-shell truth and residual TestFlight risk;
- final verdict: `PASS`, `PASS WITH RISKS`, or `FAIL`;
- whether the web/backend changes are safe for Railway, while explicitly keeping build 16 pending a separate Bryan-approved EAS build.
