# FORGE HYROX MOBILE + ONE-TAP RACE REMOVAL HOTFIX SPEC

Date: 2026-08-11
Base: origin/main at 6825ecb5fecff008ebae2a57a9f29d6226a0e779
Branch: fix/hyrox-mobile-removal-20260811

## User evidence

1. Real iPhone screenshot `img_cb4156e5f943.jpg`: the opened Build a HYROX plan sheet begins under the iOS status bar. The eyebrow is not visible, the title and close control are clipped at the top edge, and the long form is presented as a nearly full-height desktop dialog instead of a safe-area-bounded mobile sheet.
2. Real iPhone screenshot `img_8032c886c16f.jpg`: tapping Remove on the active Yonkers Half Marathon goal leaves the button at Reviewing while the page shows `The requested plan did not pass safety validation.` The active plan also contains the later Army 10-Miler. The race is not removed.
3. Bryan’s product decision: tapping Remove should be one action. Do not make him wait for or approve a separate removal-review sheet.

## Root-cause evidence already isolated

### Modal
`HyroxPlanSetup.jsx` uses a fixed backdrop aligned to the bottom with constant 10px padding and a dialog max height of `calc(100dvh - 20px)`. The top safe-area inset is not included. In the remote Capacitor/WKWebView shell, `100dvh` extends beneath the iOS status bar, so a tall dialog’s header is clipped under the system chrome. Prior QA only photographed the unopened catalog card, not the opened dialog.

### Removal
`Races.jsx::openRaceRemoval` first calls `/races/:id/removal-preview` and labels the button Reviewing. For an active-plan race, `previewRaceRemovalForUser` rebuilds a remaining-race candidate; `previewPlanForUser` rejects it at `PLAN_VALIDATION_FAILED`, so no confirmation sheet opens and no removal occurs. Existing tests only assert source wiring/rollback; they do not execute the exact two-race-to-one-race removal candidate using current dates or assert one-tap behavior.

## Required behavior

### A. Opened HYROX setup fits real iPhone screens
- The complete header, eyebrow, title, and close button must always begin below `env(safe-area-inset-top)`.
- The sheet must end above `env(safe-area-inset-bottom)` and remain internally scrollable.
- Use a bounded internal scrollport / safe-area-aware backdrop; do not rely on `100dvh - 20px` alone.
- At 393x852 and 320x700 CSS viewports: no horizontal overflow, header visible at scrollTop 0, close target >=44px, all form fields reachable, and the final Preview action can scroll fully clear of the bottom edge/nav.
- Preserve focus trap, Escape handling, body scroll lock, and desktop behavior.

### B. Remove is one tap and truthful
- Tapping an Upcoming race’s Remove action begins the complete removal operation directly. Button copy is `Removing…`, never `Reviewing…`.
- Unlinked race: owner-scoped delete, then reload.
- Active-plan race: create the deterministic remaining-goal candidate and apply it automatically in the same user action; the candidate apply must remain atomic so race deletion and replacement-plan activation succeed or roll back together.
- Do not render a separate RaceRemoveSheet confirmation/review step for this one-tap flow.
- Preserve recorded runs, lifts, health, check-ins, and training history.
- Prevent duplicate taps. On success, remove the card and show truthful success copy. On failure, restore the button, keep race/plan unchanged, and show a specific error.

### C. Fix the exact validation regression
- Add an executable backend regression fixture for planning date 2026-08-11 with two active goals: Yonkers Half Marathon around 2026-09-20 and Army 10-Miler 2026-10-11. Removing Yonkers must generate a valid Army-only candidate and atomically apply it.
- Record and assert the pre-fix validation errors in the RED test so the fix targets the real invariant rather than bypassing validation.
- Do not weaken global safety validation, owner scoping, candidate hash/revision checks, transaction rollback, or plan determinism.
- Also retain a failure fixture proving an actually unsafe replacement still fails closed and leaves both race and plan unchanged.

## TDD and gates

1. Write focused failing tests first and run them to demonstrate RED for both defects.
2. Implement the smallest root-cause fixes.
3. Run focused GREEN tests.
4. Run frontend full smoke, backend full smoke, Vite production build, syntax checks, and `git diff --check`.
5. Do not commit or push; Hermes owns commit, independent QA, and ship.

## File scope

Maximum 10 files. Expected scope:
- frontend/src/components/hyrox/HyroxPlanSetup.jsx
- frontend/src/pages/Races.jsx
- frontend/src/components/races/RaceRemoveSheet.jsx only if removing dead wiring requires it
- frontend/test/hyroxFrontend.smoke.mjs or a focused runtime/browser regression
- frontend/test/raceManagement.smoke.mjs
- backend/src/routes/plans.js and/or the narrow candidate-builder dependency proven responsible
- backend/test/racePlanRemoval.smoke.js
- this spec

No native config, dependency, schema, auth, billing, or unrelated refactor changes.

## Release acceptance

- Codex implementation complete within scope.
- Independent Claude OAuth QA: zero unresolved CRITICAL/HIGH and an executable exact regression.
- Railway serves the reviewed assets/revision.
- AFTER screenshots of the opened HYROX sheet at 393x852 and 320x700 show the full safe header and reachable bottom action.
- AFTER production test shows tapping Remove once transitions through Removing and eliminates the race while the remaining active goal/plan stays valid.
