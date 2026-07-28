# FORGE PULL-TO-REFRESH STUCK REGRESSION — CODEX IMPLEMENTATION SPEC

## Goal
Repair the shipped iPhone pull-to-refresh path so an Apple Health/native sync that never settles cannot leave Forged Hybrid spinning forever. Preserve the forced-fresh HealthKit semantics and refresh the page exactly once after either sync settlement or a bounded handled deadline.

## Confirmed production regression
Bryan reports the pull gesture gets stuck and does not refresh after commits `be306aed` and `74513fa9` shipped.

Hermes reproduced the state-machine defect directly against current `origin/main`: when `runHealthAwarePageRefresh()` receives a `syncNativeData()` promise that never settles, the returned promise remains pending and `refreshPage()` is never called. `PullToRefresh.jsx` has already set `refreshing=true`, so the spinner remains indefinitely.

The native bridge calls `ForgeHealth.isAvailable()`, `ForgeHealth.getSummary()`, and `ForgeHealth.getWorkoutHistory()` without a gesture-level deadline. HTTP workout batches have per-request timeouts, but an unresolved native call or long sync can still block the gesture forever.

## WHAT
1. Add executable RED regression coverage for an unresolved/overlong native sync.
2. Implement the smallest frontend-only bounded-settlement repair in the existing `runHealthAwarePageRefresh` / pull gesture path.
3. Preserve forced-fresh semantics: authenticated native pulls still call `syncNativeData({ forceFresh: true })` exactly once and normally await successful/failed settlement before reload.
4. When the manual-refresh deadline expires, record/report a timeout as a handled Health sync failure and invoke ordinary page refresh exactly once. Do not emit a false Health success.
5. A late sync resolution/rejection after the deadline must not cause a second reload, an unhandled rejection, or a second error callback.
6. Preserve the synchronous gesture latch: duplicate `touchend` events during the active attempt start no second refresh; successful/timeout reload paths keep the latch raised until navigation; a thrown reload callback lowers it so a later gesture can retry.
7. Preserve active-run/share-studio protections and web/logged-out behavior (no HealthKit, still refresh).

## Design constraints
- The deadline must be dependency-injected or otherwise testable with fake/immediate timers; do not add real multi-second sleeps to tests.
- Use one clear exported timeout constant suitable for mobile pull-refresh UX and one typed/named timeout error whose message is handled by existing Health sync failure copy.
- Do not modify native Swift, Capacitor plugins, package dependencies, backend, schema, auth, AI, app version, or build number.
- Do not cancel or clear durable Health transfer state incorrectly. Existing `historyTransferPending` ordering must remain intact.
- Do not broaden scope or touch the two unrelated untracked specs in the original worktree.
- Maximum 5 changed files including this spec; expected source/test files are `frontend/src/lib/healthSync.js`, `frontend/src/components/PullToRefresh.jsx`, `frontend/src/lib/pullToRefresh.js` only if necessary, and `frontend/test/healthAutoSync.smoke.mjs`.
- Do not commit or push. Leave the intended diff for Hermes.

## Required gates
- Demonstrate RED first with the new focused regression test against the existing implementation, then GREEN after the fix.
- `cd frontend && npm run test:health-sync`
- `cd frontend && npm run test:device-source`
- `cd frontend && npm run build`
- `git diff --check`

## Report
Return root cause, precise deadline behavior, files changed, RED evidence, exact test results, confirmation that no native/TestFlight rebuild is required, and any residual risk. Do not claim production verification.
