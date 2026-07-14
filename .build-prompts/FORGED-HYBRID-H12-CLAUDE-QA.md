# Claude Code QA: Forged Hybrid H12 Apple Health and workout integrity

Repo: `/Users/zordon/.codex/worktrees/forged-hybrid-health-workouts`

Branch: `codex/forged-hybrid-health-workouts`

Base: `origin/main` at `1b62be08`

Read `CLAUDE.md` first. Review the working-tree diff; do not review only this prompt.

## User-reported failures

1. A 0.29-mile Apple Health walk appeared as a run and could contaminate plan load.
2. A 7.31-mile run with 150 bpm average was shown as Z5 because the app inferred zones from that workout's observed maximum. The athlete's actual watch boundaries are Z1 96-116, Z2 117-136, Z3 137-155, Z4 156-175, Z5 176+.
3. Apple Health data was underused. Useful route, elevation, weather, heart-rate coverage, cadence, power, speed, stride length, vertical oscillation, ground-contact time, and workout metadata should survive the native-to-backend path when HealthKit exposes them.
4. Garmin-only values shown in the source screenshots (exact Garmin zone totals, GCT balance, respiration, performance condition, run/walk segments) need an honest CSV/structured-JSON import path; the app must never invent absent values.

## Intended behavior

- Preserve Apple Health workout identity. Walks and cross-training can remain in activity history, but only actual runs contribute to running mileage, pace trends, PRs, streaks, readiness run load, AI run feedback, plan generation/adaptation, or race analysis.
- Use an athlete profile for HR classification. Support exact custom watch boundaries and never promote an observed per-workout maximum to athlete max HR.
- Treat a zone timeline covering less than 70% of workout duration as sparse. Show average HR, classify it using the athlete profile, and do not let the partial timeline override it.
- History must say `Walk Detail` for a walk, use local calendar dates for date-only records, omit invented imported RPE, label pace zones as `Pace Z#`, and expose supported advanced metrics only when present.
- Native sync authorization/import schema version is 3. A full-history retry is marked complete only after `getWorkoutHistory` succeeds; fallback summary imports must not suppress the retry.
- All new writes and updates remain authenticated and scoped to `req.user.id`.
- No EAS/TestFlight build is permitted in this QA.

## Review priorities

1. Trace native Swift output through `HealthService`, `/api/import/health`, DB storage, history UI, HR profile, readiness, plans, PRs, and AI routes.
2. Inspect all changed SQL for PostgreSQL and SQLite compatibility, placeholder counts, user scoping, and accidental exclusion/inclusion of legacy real runs.
3. Confirm exact custom-zone validation: five integers, 30-230, strictly increasing; 129 -> Z2 and 150 -> Z3 for `[96,117,137,156,176]`.
4. Confirm imported walks are excluded from every running-intelligence path, not merely relabeled in the frontend.
5. Inspect `ForgeHealthPlugin.swift` concurrency, authorization types, route query completion, 5,000-point cap, metadata units, cadence calculation, and compatibility with the current Capacitor/HealthKit target.
6. Check native sync for variable-scope errors, retry-state mistakes, partial imports, duplicate imports, or permission-version loops.
7. Confirm Garmin/JSON boundary validation drops malformed metrics and no absent metric gets synthesized.
8. Check mobile layout/accessibility for History, activity detail, HR Zones, Body/Health Data, and Settings file import.
9. Identify any changed-file empty catches, raw SQL interpolation, unscoped updates, or prompt-injection exposure.

## Required commands

Run and report:

```bash
cd /Users/zordon/.codex/worktrees/forged-hybrid-health-workouts
git diff --check
node backend/test/forgedHybridH12.smoke.js
for file in backend/test/forgedHybridH{1,3,4,5,6,8,9,10,11}.smoke.js; do node "$file"; done
for file in backend/scripts/{active-run-gps-gap,checkin-time-cap,plans-cow,pr-recompute,race-course,route-engine,streak-anchor,watchsync-dedup}-smoke.js backend/heatDrift-smoke.js backend/interference-smoke.js; do node "$file"; done
cd frontend && npm run build
cd ../frontend && npm audit --audit-level=high
cd ../backend && npm run check:account-data
cd ../frontend && npx cap sync ios
xcrun swiftc -parse ios/App/App/ForgeHealthPlugin.swift
```

If local `xcodebuild` cannot run because the installed CoreSimulator/iOS platform is missing or mismatched, report it as an environment limitation, not a source pass. Do not run EAS as a workaround.

## Response format

- Verdict: PASS / PASS WITH RISKS / FAIL
- Findings first, ordered CRITICAL, HIGH, MEDIUM, LOW, with exact `file:line` evidence
- Explicit matrix for the four user-reported failures
- Security and data-integrity assessment
- Native compilation residual risk
- Toolchain results
- Final recommendation: safe or unsafe for Railway merge; separately state that native additions await a Bryan-approved EAS build

Do not silently fix code, push, deploy, merge, alter credentials, mutate production data, or run EAS. Review and report only.
