# Claude Code QA: Forged Hybrid final visible-test correction

Review the latest commit in `/Volumes/Zordon Storage /openclaw-workspace/forge-app` after the final mobile production crawl found a mismatched visual cue for `Sumo Squat Hold`.

## Scope

- `frontend/src/components/MovementDemo.jsx`
- `frontend/src/pages/Stretches.jsx`
- `frontend/src/pages/StretchSession.jsx`
- `frontend/test/movementDemoCue.smoke.mjs`

## Verify

1. Stretch catalog cues take precedence over `MovementDemo`'s name-based fallback in both stretch flows.
2. Warm-up and lifting callers that do not provide a catalog cue retain their existing fallback behavior.
3. `Sumo Squat Hold`, `Pigeon Pose`, `Butterfly Stretch`, `Inner Thigh Stretch`, and other catalog movements cannot display an unrelated generic cue below the visual.
4. No user data, auth, API, native, EAS, or TestFlight behavior changed.
5. Run:
   - `cd frontend && node test/movementDemoCue.smoke.mjs`
   - `cd frontend && npm run build`
   - `cd frontend && npm audit --audit-level=high`
   - `cd backend && npm run check:account-data`
   - `cd frontend && npx cap sync ios`

Return `PASS`, `PASS WITH RISKS`, or `FAIL`, with findings ordered by severity and exact `file:line` evidence. Do not edit files, commit, push, deploy, or run EAS.
