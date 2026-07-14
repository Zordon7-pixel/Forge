# Claude Code QA: Forged Hybrid H15 routine rotation and swipe-back navigation

Perform an independent, read-only QA of:

`/Volumes/Zordon Storage /openclaw-workspace/forge-app`

Branch: `main`
Base commit: `1ff16926`

Read `CLAUDE.md` first. Inspect the complete tracked and untracked working-tree diff from the base commit. Do not edit files, mutate user or production data, commit, push, deploy, or run EAS/TestFlight.

## User request

1. Warm-ups and stretch sessions should not repeat the same routine every time. They should rotate safely so consecutive sessions feel different.
2. A deliberate right swipe from the left edge should return to the prior app screen.

## Intended behavior

- `/warmup` chooses 5 unique movements from the 10-item image-backed pre-run pool. It stores the previous routine per signed-in user and prioritizes every movement not in the last routine, so consecutive five-step warm-ups have no overlap when the pool permits it.
- `/stretches/session?type=pre` and `?type=post` choose 6 unique movements from their respective pools and rotate away from the prior routine per user and session type.
- `/stretches` sends up to 20 validated prior IDs as an `exclude` query. The backend prioritizes unseen movements, then fills from recent movements only when the eight-item category pool requires it.
- Rotation is variation, not cryptographic randomness. Malformed storage or query data fails safely, produces no duplicate movement IDs, and never breaks a session.
- Both frontend and backend selectors defensively de-duplicate malformed future pools and clamp negative/oversized counts.
- The old fixed text-only `LogRun?warmup=true` path redirects to the canonical image-backed `/warmup` flow while preserving router state.
- Every newly eligible movement resolves through `MovementDemo` to an existing local image and retains the signed-in profile-sex single-athlete crop behavior.
- Swipe Back starts within 28 px of the left edge, travels at least 78 px right, is at least 1.5x more horizontal than vertical, and completes within 1 second.
- Swipe Back uses React Router history when a previous entry exists and falls back to Today when there is no in-app history.
- It is disabled on Today, `/run/active`, and `/workout/active/*`. It ignores maps, text/form controls, sliders, and elements marked `data-swipe-back-ignore`.
- `/run/treadmill` remains swipe-enabled while idle, but its running, paused, and completed-unsaved states mark the full screen ignored so a gesture cannot discard timed data.
- Forged Calendar's existing horizontal week swipe is marked ignored and remains intact.
- In multi-step warm-up/stretch screens, the gesture first returns to the preceding internal step/screen. When feedback is open, it closes the modal before navigating.
- At 390x844, the image, movement cue, Next, and Skip Warmup controls remain visible/scrollable above the bottom navigation with no horizontal overflow.
- Ordinary vertical scrolling/pull-to-refresh and short/slow/non-edge drags do not navigate.
- No native source, dependency, database schema, AI behavior, user data, app version, or build number changes. No EAS build is authorized.

## Review priorities

1. Prove the rotation algorithm terminates, deduplicates malformed pools, handles zero/oversized counts, and cannot leak one user's recent routine to another user.
2. Trace every warm-up/stretch entry point and identify any remaining fixed routine that the implementation missed.
3. Verify all movement IDs/names resolve to local form assets and that no new `FORM IMAGE QUEUED` state is reachable for current routines.
4. Review storage-key stability across login/logout and malformed localStorage. Confirm storage failures are contextualized and nonfatal.
5. Review the backend `exclude` parser for bounded input, malformed IDs, and selection behavior when 5-7 of 8 items are requested.
6. Challenge gesture safety: active-run data loss, map/calendar conflicts, scroll interference, modal behavior, stale route closures, browser-history escape, iOS edge conflicts, and accessibility controls.
7. Confirm `touchmove` listener cleanup/options are correct and the custom cancelable event is consumed correctly.
8. Inspect mobile layout at 390x844: no horizontal overflow, image clipping, bottom-nav collision, or unusable controls.

## Required commands

```bash
cd "/Volumes/Zordon Storage /openclaw-workspace/forge-app"
git diff 1ff16926 --check
node --check backend/src/routes/stretches.js backend/scripts/stretch-catalog-smoke.js
node backend/scripts/stretch-catalog-smoke.js
for file in frontend/test/*.smoke.mjs; do node "$file"; done
for file in backend/scripts/*smoke*.js; do
  case "$file" in *final-beta-api-smoke.js) continue ;; esac
  node "$file"
done
cd frontend && npm run build
npm audit --audit-level=high
npx cap sync ios
cd ../backend && npm run check:account-data
```

If `npx cap sync ios` creates tracked native diffs, report them and do not commit them. Do not use EAS as a workaround for any limitation.

## Response format

Lead with findings ordered CRITICAL / HIGH / MEDIUM / LOW and cite exact `file:line` evidence. Then report:

- routine rotation as `VERIFIED FIXED`, `DISAGREE`, or `FIX REQUIRED`;
- swipe-back behavior as `VERIFIED FIXED`, `DISAGREE`, or `FIX REQUIRED`;
- all fixed-routine entry points found;
- local image and profile-sex coverage;
- gesture conflict and history-fallback assessment;
- exact toolchain results;
- final verdict: `PASS`, `PASS WITH RISKS`, or `FAIL`;
- whether the web/backend changes are safe for Railway, while explicitly stating that no EAS build is authorized.
