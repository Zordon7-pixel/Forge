# FORGE iPHONE COMPLETION, WARM-UP TIMER, AND HEALTH SYNC FIX SPEC

**Status:** Approved for Codex implementation
**Scope:** Three confirmed iPhone defects reported by Bryan on 2026-08-07
**Runtime:** Forged Hybrid Capacitor shell loads the Railway web bundle remotely. Keep this frontend-only unless root-cause evidence proves a native bridge change is unavoidable.

## Evidence

1. Warm-up screenshot: Step 3 of 5, **Butt Kicks**, prescription **30 seconds**, but only **Next** and **Skip warmup** controls. There is no countdown, start/pause/resume/restart state, or completion signal.
2. Post-run screenshot: full black screen stuck at **“Opening your saved run recap…”** after saving a run whose distance was entered manually. No error, retry, History, or recovery control.
3. Apple Health screenshot: pull-to-refresh leaves **“Syncing Apple Health”** spinning indefinitely. Readiness 94 and the Aug 7 manual run remain visible; no success/failure/import count appears.

## Non-negotiable product behavior

- Timed warm-up movements count down visibly; rep-only movements remain manual.
- A saved run is never trapped behind a passive loading screen. The recap opens deterministically, and a bounded recovery path exists if route navigation cannot settle.
- Pull-to-sync has a gesture-level deadline. The app must stop waiting, report a truthful timeout/failure result, refresh page data exactly once, and never fabricate successful Apple Health completion.
- Preserve existing HealthKit singleflight, forced-fresh semantics, retry-marker ordering, backend idempotency, partial-import accounting, and late-promise observation.
- No secrets, no native plugin additions, no commits/pushes/deploys from Codex.
- Maximum implementation/test files: 9, excluding this spec.

## Phase 1 — Timed warm-up countdown

### WHAT
Add a guided countdown to warm-up steps that have a positive numeric `duration` and are genuinely time-prescribed. Butt Kicks must show 30 → 0 seconds.

### WHY
The UI currently displays “30 seconds” as static text and tells the athlete to complete the movement before tapping Next. The prescribed timing is unusable without leaving Forge or mentally counting.

### HOW
- Use a small deterministic countdown state/helper with executable tests; avoid timer logic that depends on render count.
- Timed step UX must include visible remaining seconds and accessible **Start**, **Pause/Resume**, and **Restart** controls.
- Start only on explicit athlete action; do not surprise-start when the page opens.
- Countdown must pause/resume without losing remaining time, reach exactly zero once, expose a clear completion state, and never go negative.
- Reset completely when the step changes, including timer cleanup on unmount. No interval leaks or double ticks under React Strict Mode.
- Keep **Next** available; completing the timer must not auto-navigate without user intent.
- Rep-only steps must not show a countdown merely because data contains a display label. Define the eligibility rule explicitly and test it.
- Preserve the form image/cue, step progress, Skip warmup, safe-area/nav spacing, and mobile tap targets.

### GATE
Executable tests cover start, tick, pause, resume, restart, zero boundary, step reset, cleanup semantics, and timed-vs-rep eligibility. Mobile visual check shows Butt Kicks with a usable 30-second timer and no layout clipping.

## Phase 2 — Saved-run recap handoff cannot trap the app

### WHAT
Eliminate the permanent “Opening your saved run recap…” state after a saved run with manual distance.

### WHY
`ActiveRun` restores a durable completion handoff and currently relies on a passive effect plus a full-screen loading return to navigate. If that effect/navigation does not settle during a WKWebView lifecycle recovery, the loading surface has no escape path.

### HOW
- Trace the exact save → durable handoff → recap route flow and prove the root cause in a regression test before fixing.
- Prefer deterministic React Router navigation from restored completion state (for example a render-time redirect contract) over an effect-only handoff.
- Preserve the saved run and durable snapshot. Never clear the handoff before recap owns it.
- Preserve live-tracked vs manual/imported provenance and post-run check-in policy.
- If a route identifier is absent/malformed or navigation cannot be prepared, render a bounded recovery surface with **Open History** and retry/recover behavior; never leave an infinite un-actionable screen.
- Keep active-run history/back protection from blocking an intentional post-save exit.
- Regression-test fresh successful save, WKWebView/remount with existing handoff, manually entered distance, invalid handoff, and queued/offline completion.

### GATE
The exact screenshot state cannot persist: valid handoff deterministically reaches `/run/recap/:id`; invalid state exposes recovery. Existing run-completion smoke suites remain green.

## Phase 3 — Apple Health pull-to-sync bounded settlement

### WHAT
Contain an unresolved native HealthKit promise so the pull spinner cannot run forever.

### WHY
`runHealthAwarePageRefresh()` currently awaits `syncNativeData({ forceFresh: true })` without a gesture-level deadline. Capacitor/native bridge promises can remain pending without resolve/reject, so `refreshing` never clears and page refresh never runs.

### HOW
Follow `capacitor-hybrid-app/references/healthkit-workout-sync-reliability.md` exactly:
- Export one named pull-refresh deadline constant and a typed/named timeout error.
- Race the existing forced-fresh Health sync against a gesture-local soft deadline via an injectable scheduler/canceller; do not alter automatic/background sync semantics.
- On deadline, call the existing Health sync error pathway once and refresh ordinary page data exactly once.
- Do not cancel/reset the underlying Health coordinator; keep the losing promise observed so late resolve/reject cannot cause duplicate refresh, duplicate error callback, completion event, or unhandled rejection.
- Cancel the deadline synchronously after normal settlement.
- Surface a temporary truthful user result after completion/failure/timeout (success counts or the existing `healthSyncFailureMessage`) rather than only logging to console. The persistent spinner must clear in all bounded gesture outcomes.
- Duplicate `touchend` remains singleflight through settlement. A thrown page refresh releases the latch so a later pull can retry.

### GATE
Executable race tests cover unresolved native promise deadline, ordinary success cancellation, late success, late rejection, duplicate touchend, thrown refresh callback, exactly-once page refresh, and no fabricated success event. Existing HealthKit import/coordinator tests stay green.

## Full QA and release gates

1. `git diff --check`.
2. Focused warm-up, run-completion, pull-refresh, and health sync tests.
3. Full frontend smoke suite and production build.
4. Backend smoke suite if any shared/API contract changes (not expected).
5. Independent Claude Code QA on the exact commit.
6. Hermes final diff review.
7. Merge to `main`, GitHub CI green, exact Railway revision and production shell verified.
8. Capture running mobile visual proof for timer, recap recovery/redirect, and bounded sync result where browser/native constraints permit.
9. Because these are remote web-bundle changes, no new TestFlight build is required unless Codex proves a native Swift/plugin change is necessary. Status remains `awaiting-user-verification` until Bryan confirms on his installed iPhone build.
