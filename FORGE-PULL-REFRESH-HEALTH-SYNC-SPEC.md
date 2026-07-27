# FORGE PULL-TO-REFRESH APPLE HEALTH SYNC — CODEX IMPLEMENTATION SPEC

## Goal
When the athlete pulls the Forge screen down far enough to refresh on iPhone, Forge must request fresh Apple Health data, synchronize newly available metrics/workouts through the existing native HealthKit path, and only then refresh the page data.

## Existing implementation / starting point
- This behavior was previously attempted in shipped commit `3a744fd2` (`fix(forge): sync health before pull refresh`).
- Current `frontend/src/components/PullToRefresh.jsx` calls `HealthService.syncNativeData()` before `window.location.reload()`.
- The user is asking for this behavior now, so treat the task as an audit/repair of a possibly incomplete or ineffective path, not as a greenfield feature.
- Reuse the existing `ForgeHealth` bridge, `HealthService`, and `frontend/src/lib/healthSync.js`. Do not add a plugin or native dependency.

## WHAT
1. Audit the full manual pull-refresh path from gesture threshold to HealthKit read, profile metric sync, workout-history import, completion signaling, and post-sync page reload.
2. Identify any reason newly available Apple Health data can be skipped on a manual refresh, including automatic-sync interval throttles, in-flight singleflight behavior, permission behavior, partial-success handling, fire-and-forget work, or reload-before-server-ack races.
3. Implement the smallest correct frontend-only repair.
4. Add executable regression coverage that proves a qualifying native authenticated pull refresh invokes a forced/manual fresh HealthKit synchronization exactly once and awaits its settlement before reload/data refresh. Also prove web/non-native and logged-out refreshes do not invoke HealthKit.

## WHY
Pull-to-refresh is an explicit user request for fresh data. It must not be treated like a background auto-sync that may be skipped because of a time interval. The user expects Apple Health metrics and newly completed workouts to be synchronized before refreshed Forge screens render.

## HOW / constraints
- Keep changes within 10 files; prefer `PullToRefresh.jsx`, `HealthService.js`, `healthSync.js`, and focused tests only.
- Preserve current active-run, gesture, and share-studio protections.
- Preserve singleflight/idempotency and do not create recursive loops from health completion events.
- Do not advance durable workout checkpoints on incomplete/partial server acknowledgement.
- Handle sync failures honestly: do not crash or leave the gesture stuck; do not claim success when sync is incomplete. A page refresh may still occur after a bounded, handled failure if that matches existing UX, but the code and tests must make that behavior explicit.
- No backend/schema/native plugin changes unless the audit proves they are strictly necessary; if so, stop and report instead of expanding scope.
- Do not edit unrelated files or the two pre-existing untracked route/Strava spec files.
- Do not commit or push. Leave intended changes in the worktree for Hermes to inspect and commit.

## GATE
- `cd frontend && npm run build`
- Run the focused health auto-sync / pull-refresh tests plus relevant existing frontend tests.
- `git diff --check`
- Report: root cause, files changed, exact tests run/results, and whether this remains frontend-only (no TestFlight build).
