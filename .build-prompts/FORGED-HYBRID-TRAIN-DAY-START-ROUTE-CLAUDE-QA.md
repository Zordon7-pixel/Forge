# Claude Code QA: Training day start controls, route planning, and Watch fallback

Repo: `/Volumes/Zordon Storage /openclaw-workspace/forge-app`

Review the current uncommitted diff on `main`. This is a read-only QA pass: do not edit files, commit, push, deploy Railway, or run EAS.

## User-reported failures

1. A scheduled run or lift could not be started when the athlete opened a calendar day other than today.
2. Training had no route-planning entry point attached to the selected day's prescribed run.
3. TestFlight build 15 exposed a large Apple Watch "coming soon"/native-build warning on every workout. Native automatic delivery genuinely requires the plugin-fixed build 16, but technical build/plugin diagnostics must stay out of the athlete workout card. Manual entry must remain available.

## Intended behavior

- `Start Run` and `Start Lift` are enabled for any non-rest scheduled day.
- Starting a session whose date is not today requires an explicit confirmation; starting today's session does not.
- The exact selected plan session id, week, prescription, pace/zone/duration, and run/lift payload remain linked through execution.
- A selected distance-based run exposes `Map this run` when `/api/routes/planner-status` reports available.
- Route generation reuses the existing authenticated `/api/routes/generate` path, prescribed distance, surface/elevation controls, and sends the selected route through warm-up into `ActiveRun`.
- The route planner stays lazy-loaded and is readable on the warm paper day sheet.
- On build 15/plugin-missing, raw diagnostic details are logged with `[watch-delivery]`; the workout card shows manual copy without a disabled "Apple Watch coming soon" control or automatic warning paragraph.
- The native minimum remains build 16. No native files/build numbers should change in this patch.

## Files in scope

- `frontend/src/pages/Plan.jsx`
- `frontend/src/components/calendar/ForgedDayView.jsx`
- `frontend/src/components/RoutePlanner.jsx`
- `frontend/src/components/WatchWorkoutSendButton.jsx`
- `frontend/src/services/watchWorkoutAvailability.js`
- focused smoke tests in `frontend/test/` and `backend/test/forgedHybridH5.smoke.js`

Ignore the pre-existing untracked `.build-prompts/FORGED-HYBRID-PHASE-3B-READINESS-HISTORY-CLAUDE-QA.md`.

## Required verification

Inspect the actual diff and source. Then run:

```bash
node backend/test/forgedHybridH5.smoke.js
node frontend/test/watchWorkoutAvailability.smoke.mjs
node frontend/test/evidenceTimedPlan.smoke.mjs
node frontend/test/h6RouteScan.smoke.mjs
cd frontend && npm run build
cd frontend && npm audit --audit-level=high
cd backend && npm run check:account-data
cd frontend && npx cap sync ios
```

Confirm `cap sync` creates no tracked native diff and build numbers remain 15. Review specifically for:

- accidental start without confirmation on a non-today day;
- confirmation that loses/corrupts plan session provenance;
- route start bypassing warm-up or losing `plannedRoute`/surface;
- route planner appearing on rest/lift-only or zero-distance days;
- API/pro/beta authorization regressions;
- dark-theme CSS variables making the planner unreadable on paper;
- raw build/plugin messages leaking into normal workout UI;
- a hidden/disabled manual-entry fallback;
- hook-order, stale closure, null-session, mobile overflow, or bundle-size regressions.

## Response format

1. Verdict: `PASS`, `PASS WITH RISKS`, or `FAIL`.
2. Findings first, ordered CRITICAL/HIGH/MEDIUM/LOW, each with `file:line`, failure path, and minimum fix.
3. Explicit verification matrix for the three user-reported failures and intended behaviors.
4. Toolchain results.
5. State whether this is safe for a Railway web deploy now and whether EAS build 16 is still separately required for automatic Apple Watch delivery.

If there are no blocking findings, say so plainly. Do not modify the worktree.
