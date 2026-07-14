# Claude Code QA: Forged Hybrid run integrity and HealthKit source truth

Perform an independent, read-only QA of:

`/Users/zordon/.codex/worktrees/forged-hybrid-run-integrity`

Branch: `codex/forged-hybrid-run-integrity`

Read `CLAUDE.md` first. Inspect the complete branch diff from `d4b7b619`; do not review only this prompt. Do not edit files, mutate production data, push, merge, deploy, or run EAS/TestFlight.

## User-reported failures

1. Pulling down during an active run reloaded the page and reset the run.
2. A user could not clearly delete a run from its detail sheet.
3. The live planned-route map did not make the athlete's exact current location obvious.
4. A July 14 Apple Health import showed 138 bpm / Z2 / 241 calories while the source Garmin activity showed 143 bpm, predominantly Z3, and 280 calories.

## Intended behavior

- `/run/active` bypasses the app's destructive pull-to-refresh wrapper.
- A running or awaiting-distance session persists locally, restores elapsed time from its original timestamp, resumes GPS, preserves route/distance/client id, and clears only after a durable server save or offline queue save.
- The last saved GPS point/fix survives reload so resumed tracking does not silently discard the first post-reload segment.
- The map follows a prominent yellow current-position marker and labels it `You are here`; the planned course remains visually distinct.
- History detail offers a confirmed delete flow. Every delete remains scoped by both `id` and `user_id`, recomputes affected PRs, and explains that Apple Health itself is unchanged.
- Deleting a health-imported activity creates user-scoped source-id and fingerprint tombstones in the same transaction, so a later full Apple Health resync cannot resurrect it. Manual runs do not create import tombstones.
- Imported HealthKit workout IDs are stored and used for exact deduplication.
- Live-run and History zone labels use the same saved HR-zone profile. Sparse zone coverage below 70% cannot override profile classification.
- Apple Health calories are labeled `Active calories`; do not claim they equal Garmin total calories.
- The native bridge prefers heart-rate statistics owned by the `HKWorkout`, otherwise uses workout-associated samples, a same-source/date fallback, and a bounded time-weighted average. It never uses unrelated date-window samples.
- Native metrics/import schema v4 triggers one full-history correction only after a v4-capable shell is installed. An old TestFlight shell must not consume the v4 upgrade marker.
- No EAS build is authorized in this phase.

## Data evidence to validate

The athlete's watch-zone minimums are `[96, 117, 137, 156, 176]`. Therefore 138 bpm and 143 bpm are both Z3. The imported July 14 row had only 390 seconds of zone samples over 1,531 seconds (25.5% coverage), so its partial zone object cannot determine workout intensity.

Garmin's screenshot reports 143 bpm average and 280 total calories. Apple Health stored 138 bpm and 241 active calories. Confirm the implementation fixes the source-query and classification defects without silently rewriting historical user data or falsely equating active and total calories.

## Review priorities

1. Trace active-run state through start, pagehide/reload, restore, GPS resume, finish, API failure, offline queue, retry, and successful save. Check stale/corrupt session bounds and duplicate-save behavior.
2. Inspect React effect dependencies for duplicate GPS watchers, stale closures, timer leaks, map-fit/follow conflicts, or a restored run being restarted at zero.
3. Review `run_import_tombstones` migration, canonical schema, export/delete coverage, PostgreSQL placeholders, exact column/value counts, and all `req.user.id` scoping.
4. Confirm source-id plus fingerprint keys match between imported payloads and legacy existing rows, including walks and non-run activities. Check that a user cannot tombstone another user's import.
5. Review History delete UX, loading/error states, modal transitions, and imported-vs-manual semantics.
6. Validate sparse-zone fallback and saved custom-zone use on both live and History surfaces.
7. Review HealthKit API availability, sample predicates, source fallback, concurrency, sample bounds, time weighting, schema-version gate, and compatibility with the current deployment target.
8. Flag any empty catches, raw SQL interpolation, unscoped write, data fabrication, or accidental production mutation.

## Required commands

```bash
cd /Users/zordon/.codex/worktrees/forged-hybrid-run-integrity
git diff d4b7b619 --check
node --check backend/src/lib/runImportKey.js backend/src/routes/import.js backend/src/routes/runs.js backend/src/db/index.js backend/src/lib/accountDataCoverage.js
node backend/test/forgedHybridH12.smoke.js
node frontend/test/runIntegrity.smoke.mjs
for file in backend/test/forgedHybridH{1,3,4,5,6,8,9,10,11}.smoke.js backend/test/finalBetaTrainingTruth.smoke.js; do node "$file"; done
for file in backend/scripts/{active-run-gps-gap,checkin-time-cap,plans-cow,pr-recompute,race-course,route-engine,streak-anchor,watchsync-dedup}-smoke.js backend/heatDrift-smoke.js backend/interference-smoke.js; do node "$file"; done
for file in frontend/test/*.smoke.mjs; do node "$file"; done
cd frontend && npm run build
cd ../frontend && npm audit --audit-level=high
cd ../backend && npm run check:account-data
cd ../frontend && npx cap sync ios
xcrun swiftc -parse ios/App/App/ForgeHealthPlugin.swift
```

If `npx cap sync ios` rewrites local package paths because this is a worktree, treat that as generated local drift and do not commit it. If full `xcodebuild` is blocked by a missing/mismatched local iOS platform or CoreSimulator, report the environment limitation; do not use EAS as a workaround.

## Verdict format

Lead with findings ordered CRITICAL / HIGH / MEDIUM / LOW and cite exact `file:line` evidence. Then report:

- per-user-failure status: `VERIFIED FIXED`, `DISAGREE`, or `FIX REQUIRED`;
- active-run recovery and duplicate-save assessment;
- deletion/tombstone and account-data assessment;
- HR source/zone/calorie provenance assessment;
- exact smoke totals and toolchain table;
- native residual risk;
- final verdict: `PASS`, `PASS WITH RISKS`, or `FAIL`;
- whether the web/backend changes are safe for Railway merge, while explicitly keeping the native correction pending a separate Bryan-approved EAS build.
