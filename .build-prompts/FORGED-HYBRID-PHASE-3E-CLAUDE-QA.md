# Claude Code QA: Forged Hybrid Phase 3E Beta Hardening

Repo: `/Volumes/Zordon Storage /openclaw-workspace/forge-app`

Review the current working-tree Phase 3E diff on `main`. This is a read-only QA pass. Do not edit files, commit, push, deploy Railway, or invoke EAS.

## Phase 3E scope

1. `frontend/src/components/ErrorBoundary.jsx`
   - Non-recoverable startup failures must not render raw `error.message`, stack traces, URLs, tokens, internal paths, or technical exception text to a tester.
   - Detailed diagnostics must remain available through the existing contextual `console.error`.
   - Recoverable chunk-error detection/recovery and the reload action must retain their prior behavior.

2. `frontend/app.json` and `frontend/ios/App/App/Info.plist`
   - The native HealthKit bridge requests read authorization with `toShare: []`.
   - Metadata must not claim Forged Hybrid writes HealthKit workout data.
   - The read-purpose description must remain present and accurate.
   - Do not propose an EAS build in this QA pass; Bryan separately approves all EAS builds.

## Required verification

- Inspect the complete diff and relevant call sites, including `frontend/src/main.jsx`, `frontend/src/lib/chunkRecovery.js`, and `frontend/ios/App/App/ForgeHealthPlugin.swift`.
- Confirm no second metadata source still contains `NSHealthUpdateUsageDescription` or the removed write claim.
- Confirm `Info.plist` remains valid and `app.json` parses.
- Run:
  - `cd frontend && npm run build`
  - `cd frontend && npm audit --audit-level=high`
  - `cd backend && npm run check:account-data`
  - `cd frontend && npx cap sync ios`
- After Capacitor sync, confirm it creates no unexpected changes to plugin linkage, `Package.swift`, the Xcode project, build number, or bundle identifier.
- Confirm the working-tree diff remains limited to the three Phase 3E implementation files plus this QA brief and the already committed Phase 4 spec.

## Report format

Return findings first, ordered `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, with exact file:line evidence. Do not silently skip a disagreement. Then provide:

1. `PASS`, `PASS WITH RISKS`, or `FAIL`.
2. Per-scope status: `VERIFIED`, `FIX NEEDED`, or `DISAGREE`.
3. Results for all four required commands.
4. Whether Phase 3E is safe to commit and push to Railway.
5. A separate statement that no EAS build was run or authorized.
