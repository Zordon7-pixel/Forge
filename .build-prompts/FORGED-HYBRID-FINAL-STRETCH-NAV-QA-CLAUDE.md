# Claude Code QA: Forged Hybrid stretch action-bar overlap

Review the latest uncommitted correction in `/Volumes/Zordon Storage /openclaw-workspace/forge-app` after mobile browser testing proved that tapping `Next` on step 1 of a stretch session hit the fixed `Body` navigation underneath and navigated to `/health`.

## Scope

- `frontend/src/components/Layout.jsx`
- `frontend/src/pages/Stretches.jsx`
- `frontend/test/stretchActionBar.smoke.mjs`

## Verify

1. The app defines one stable bottom-navigation height that includes `env(safe-area-inset-bottom)`.
2. The navigation and stretch action bar use that same height, so `Done`, `Skip`, and `Next` sit fully above the navigation on iPhone and mobile web.
3. The action bar remains below the navigation stacking layer and cannot block navigation taps outside the session controls.
4. Desktop and narrow mobile widths do not gain horizontal overflow.
5. No session logic, user data, backend, native plugin, EAS, or TestFlight behavior changed.
6. Run:
   - `cd frontend && node test/stretchActionBar.smoke.mjs`
   - `cd frontend && node test/movementDemoCue.smoke.mjs`
   - `cd frontend && npm run build`
   - `cd frontend && npm audit --audit-level=high`
   - `cd backend && npm run check:account-data`
   - `cd frontend && npx cap sync ios`

Return `PASS`, `PASS WITH RISKS`, or `FAIL`, findings ordered by severity with exact `file:line` evidence. Do not edit files, commit, push, deploy, or run EAS.
