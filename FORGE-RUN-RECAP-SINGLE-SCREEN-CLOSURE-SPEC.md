# FORGED HYBRID — RUN RECAP SINGLE-SCREEN CLOSURE

**Date:** 2026-08-05
**Status:** Codex implementation spec
**Repo:** `/tmp/forge-run-recap-one-screen-20260805`
**Base:** `origin/main` at `88af32e4`
**Before evidence:** `/Users/zordon/.hermes/cache/images/img_8857060ea590.jpg`
**Known prior error evidence:** `/Users/zordon/.hermes/cache/images/img_f16e46c838a8.jpg`

## Confirmed defects

1. The attached iPhone screenshot shows the immediate post-run check-in as a four-step Effort/Pain/Energy/Confirm wizard while the Active Run map remains mounted behind it. The previously shipped isolation patch removes the map bleed on current main, but it did not satisfy Bryan's intended product requirement that the check-in questions be consolidated onto one screen.
2. A prior device screenshot shows `Forged Hybrid — Startup Error` immediately after post-run completion. Current main contains stale-lazy-chunk recovery, but this closure must preserve it and add regression coverage for the post-run route handoff.

## Product decision

The immediate post-run check-in is one dedicated, opaque, scrollable page containing all questions at once. It is not a sheet, modal, carousel, or four-step wizard. The saved recap remains the next screen after a single submit.

## Scope

Maximum 7 changed files, including this spec. Expected files:

- `frontend/src/components/PostRunCheckIn.jsx`
- `frontend/src/pages/RunRecap.jsx` only if needed
- `frontend/test/runCompletionPhaseA.smoke.mjs`
- one focused new or existing behavior test if justified
- `FORGE-RUN-RECAP-SINGLE-SCREEN-CLOSURE-SPEC.md`

Do not change backend contracts, Active Run recording, map behavior, route data, authentication, native iOS files, package dependencies, or unrelated features.

## Acceptance criteria

### A. One-screen check-in

- In `presentation='page'`, render Effort, Pain/Discomfort, Energy, and any conditional injury-log controls in one DOM page at the same time.
- Remove the numbered Effort/Pain/Energy/Confirm step navigation, Next/Back/Review flow, step locks, downstream reset warnings, and final summary card from the page presentation.
- Provide one primary action at the bottom: `Save check-in and view recap`.
- Effort and pain remain required. Energy remains optional.
- On submit with missing required answers, show inline errors by the relevant section and focus/scroll to the first invalid section; do not send the API request.
- Preserve selected answers when validation or API submission fails.
- Preserve existing draft/offline queue/relaunch behavior, payload fields, injury logging, heat-drift notice, and `onDone` return contract.
- The page owns an opaque full viewport. No Active Run map, controls, or location copy can remain mounted behind it.
- The page must remain usable on short iPhones with safe-area padding and vertical scrolling. No fixed footer may cover form controls.
- Use semantic headings/fieldsets/radiogroup or equivalent accessible grouping and `aria-pressed`/checked state where appropriate.

### B. Retrospective sheet compatibility

- Do not silently break any non-immediate retrospective use of `PostRunCheckIn`.
- If the sheet presentation is still used elsewhere, it may retain its current behavior, but the immediate saved-run path must always use the one-screen page presentation.
- Prefer one shared submission/data implementation rather than duplicating API logic.

### C. Completion/error closure

- Preserve `lazyWithRetry`/`recoverFromChunkError(...allowGenericLoadFailure: true)` behavior for iOS stale dynamic imports.
- Preserve durable completion handoff order: save handoff → clear active run → replace-navigate to `/run/recap/:id`.
- Completing the one-screen check-in must reveal the loaded recap in place without routing through a missing chunk or Startup Error.
- A failed run-detail fetch with a durable snapshot must still display the device recap and truthful sync notice.
- Do not introduce a native dependency or require a new TestFlight binary.

## Tests and gates

Run at minimum:

- `git diff --check origin/main...HEAD`
- `node frontend/test/runCompletionPhaseA.smoke.mjs`
- `node frontend/test/adaptiveManualRunCompletion.smoke.mjs`
- `node frontend/test/runRecapPhase1.smoke.mjs`
- `node frontend/test/chunkRecovery.smoke.mjs`
- `node frontend/test/postRunCheckIn.smoke.mjs` if present
- any other test directly covering `PostRunCheckIn`
- `npm run build --prefix frontend`

Update tests so they fail on the old four-step page. At minimum prove:

- page presentation does not render the step-navigation contract or `Next` flow;
- all three answer sections and the single save action are rendered together;
- required validation and optional energy contract remain intact;
- map/check-in ownership and chunk recovery gates remain intact.

Source-string-only assertions are insufficient if a practical component/unit behavior test already exists; extend the production test seam instead of duplicating a fake implementation.

## Phase B — iPhone post-recap Startup Error closure

**Direct device evidence:** `/Users/zordon/.hermes/cache/images/img_090265c98ea0.jpg`

The screenshot is a full black ErrorBoundary screen with the non-recoverable title `Forged Hybrid — Startup Error`, message `Forged Hybrid could not finish starting. Reload and try again.`, and one Reload button. This is occurring after completing the run recap on the remotely loaded Capacitor iPhone app.

### Required investigation and correction

- Trace the actual boundary path across `App.jsx`, `ErrorBoundary.jsx`, `chunkRecovery.js`, Vite preload handling, and the recap lazy import. Do not assume the existing `lazyWithRetry` catch covers all iOS `Load failed` variants—the screenshot proves one path still reaches ErrorBoundary as non-recoverable.
- Make the ErrorBoundary and lazy-import recovery classification consistent for the iOS generic `Load failed` that occurs at a known dynamic-import/startup boundary.
- Recovery must be bounded to one cache-busted replacement per failed shell and must not create an infinite reload loop.
- If the first automatic recovery cannot complete, show a truthful updating/recovery screen rather than misclassifying a stale app chunk as a generic Startup Error.
- Preserve genuine non-chunk runtime errors as Startup Error; do not turn every React error into a reload.
- The manual Reload action must clear/reset the one-shot guard or otherwise provide a real second recovery attempt rather than repeating the same blocked state.
- Preserve privacy and current URL/recap ID; only add the cache-busting query parameter.
- Add regression tests that reproduce the exact generic `Load failed` entering through ErrorBoundary and prove bounded automatic recovery, correct fallback copy/classification, manual retry semantics, and genuine runtime-error non-recovery.
- Do not add a service worker, dependency, native plugin, or TestFlight requirement.

Expected additional files are limited to:
- `frontend/src/components/ErrorBoundary.jsx`
- `frontend/src/lib/chunkRecovery.js`
- `frontend/test/chunkRecovery.smoke.mjs`
- `frontend/src/App.jsx` only if root-cause evidence requires it

The whole branch must remain at or below 8 changed files.

## Completion contract

Codex must edit and test only. Do not commit, push, merge, or deploy. Return root cause, files changed, exact test output, and residual device-only verification. No bare `fixed` wording; status is `patched` until independent QA and production verification.
