# FORGE Signature UI — Production Implementation Spec

**Status:** Approved for implementation
**Direction:** Readiness Arc + Coach's Log
**Primary viewport:** iPhone 17, 402 × 874 CSS pixels at 3×
**Stress profile:** `compact-mobile-320`, 320 × 568 CSS pixels
**Surface:** Dashboard Monitor surface; Plan remains the Operate/detail surface

## Combined Release Boundary

This branch intentionally combines two separately authorized release phases:

1. **Phase 0 — customer-copy prerequisite**, completed before this Signature UI specification was approved. It humanizes v2.4 calendar and day-detail presentation so no customer sees underscore-delimited enums or improper machine copy. Its scoped commits are `3f7c8e20`, `83348d4b`, and `a7e0f6e3`, affecting:
   - `frontend/src/components/calendar/ForgedCalendar.jsx`
   - `frontend/src/components/calendar/ForgedDayView.jsx`
   - `frontend/src/lib/goalBackwardPresentation.js`
   - `frontend/test/e2e/authenticatedJourneys.spec.mjs`
   - `frontend/test/goalBackwardPresentation.smoke.mjs`
   - `frontend/test/goalBackwardSurfaces.smoke.mjs`
2. **Phases 1–5 — Signature UI**, governed by the implementation allowlist below. The Signature UI build begins at commit `aa7e8aed`; its implementation and follow-up corrections remain inside that allowlist.

The implementation allowlist below applies to the Signature UI phase, not retroactively to the already authorized Phase 0 prerequisite. Both phases are intentionally reviewed and shipped together so the new interface cannot launch while older v2.4 surfaces still expose raw machine labels.

## Product Decision

Evolve the current FORGE interface rather than replace it. Preserve the existing warm orange, dark ink, paper surfaces, navigation, readiness chip, readiness detail sheet, workout prescriptions, and deterministic readiness engine. Add two memorable dashboard elements:

1. A signature **Readiness Arc** driven by the existing readiness payload.
2. A concise **Coach's Log** daily mission driven by existing recommendation and daily-execution payloads.

This is a web-only release. No Capacitor plugin, native project, build number, or TestFlight binary changes are allowed.

## Non-Negotiable Rules

- No customer-visible underscore symbols, raw enums, machine identifiers, hashes, or improper grammar.
- Do not alter stored/API enum values. Presentation-only humanization remains mandatory.
- Do not compute or adjust readiness in the component.
- Do not add a second readiness fetch. The arc consumes the Dashboard's existing readiness state.
- Do not remove the existing `HeaderReadinessChip`, readiness detail sheet, bottom navigation, or familiar dashboard cards.
- Do not invent metrics or coaching rationale. Render only fields already present in readiness, next-recommendation, or daily-execution payloads. Omit unavailable facts.
- Do not use Flight Deck teal, gradients, glassmorphism, generic icon-card grids, or fake performance numbers.
- Minimum interactive target: 44 × 44 CSS pixels.
- Respect `prefers-reduced-motion`.
- No horizontal overflow or bottom-navigation collision at either mobile profile.

## Exact Implementation Allowlist — Maximum 9 Files

1. `FORGE-SIGNATURE-UI-SPEC.md`
2. `frontend/src/components/ReadinessArcCard.jsx` — new
3. `frontend/src/components/CoachsLogCard.jsx` — new
4. `frontend/src/pages/Dashboard.jsx`
5. `frontend/src/index.css`
6. `frontend/test/e2e/support/mockApi.mjs`
7. `frontend/test/e2e/authenticatedJourneys.spec.mjs`
8. `frontend/test/signatureUi.smoke.mjs` — new
9. `frontend/package.json` — only if required to register the new smoke test; otherwise do not touch

Read any file needed for context, but edit no file outside this list.

## Current and Proposed Data Flow

### Readiness

Existing:

`Dashboard` → existing readiness request/state → `resolveReadiness(data)` → current readiness UI/detail flow

Proposed:

`Dashboard` → the same existing readiness request/state → `ReadinessArcCard` props

The component receives the already-loaded state and normalized display fields. It must not fetch, cache, score, infer, or normalize independently. The score and band displayed by the arc must match the existing readiness detail path exactly.

### Coach's Log

Existing Dashboard recommendation and daily-execution payloads remain authoritative.

Proposed:

`Dashboard` → existing recommendation + daily-execution state → `CoachsLogCard` props

Priority for displayed mission facts must follow the current product's canonical authority. Inspect the existing Dashboard and daily-execution code before choosing fields. Do not create hardcoded workout-specific explanations. If no trustworthy coaching note exists, show the mission title/metrics only or omit the card.

## Phase 1 — Signature Components

### WHAT

Build `ReadinessArcCard` and `CoachsLogCard` as controlled, presentation-only components.

### WHY

FORGE needs an ownable daily visual signature and a stronger coaching voice without abandoning its current interface.

### HOW

#### ReadinessArcCard

- Dark FORGE card using existing tokens.
- Large score/availability statement on the left.
- Partial orange readiness arc on the right; decorative and `aria-hidden`.
- Human readiness label and one or two existing drivers beneath the score.
- Expand/collapse via semantic button and `aria-expanded`.
- Loaded, loading, locked, unavailable, and error states must be truthful.
- The arc may animate only with `transform`/stroke properties; disable transitions under reduced motion.
- No score or numeric arc when readiness is unavailable.

#### CoachsLogCard

- Paper-toned card with dark ink and a restrained orange edge.
- Label: `Coach's daily brief` or `Today's mission`, with correct apostrophe and grammar.
- Show existing mission title and only available duration, distance, effort, pace, or zone values.
- Optional concise existing rationale under an expandable `Why today matters` control.
- Preserve exact prescriptions; no rounding or recomputation beyond existing formatters.
- No raw machine values. Use the shared presentation helpers where needed.
- If no canonical mission exists, omit the card instead of inventing one.

### GATE

- Components are prop-controlled and issue zero network requests.
- Ordinary authored prose remains unchanged.
- All rendered machine-like values are humanized without altering source payloads.
- Keyboard, screen reader, reduced-motion, and 44px target requirements pass.

## Phase 2 — Dashboard Integration

### WHAT

Place the two new components near the top of the existing Dashboard Monitor surface.

### WHY

The first screen should answer two questions immediately: `How ready am I?` and `What is today's job?`

### HOW

- Reuse Dashboard's existing readiness, recommendation, and execution state.
- Keep `HeaderReadinessChip`, Insights/readiness details, recent activity, Watch sync, prompts, and navigation intact.
- Do not add fetches or move readiness ownership.
- Use the existing detail opener if a safe, already-wired callback is available; otherwise keep the arc's interaction to local expansion only.
- Preserve existing loading and error behavior.
- At 402px, show the full arc and concise coaching brief.
- At 320px, scale/reposition the arc without removing readiness meaning. Keep the brief useful; collapse secondary prose rather than hiding the feature.
- Account for safe areas and existing bottom-nav padding.

### GATE

- Existing API request counts remain unchanged.
- Arc score/band equals the existing detail payload byte-for-byte.
- Mission facts equal the existing canonical recommendation/execution payload.
- Existing dashboard actions and navigation still work.

## Phase 3 — Styling and Responsive Behavior

### WHAT

Add scoped signature styles using existing FORGE tokens.

### WHY

The feature must feel native to FORGE and remain usable across current mobile widths.

### HOW

- Warm orange accent, dark ink background, paper mission surface.
- No default-tech purple/teal, gradient, blur, or decorative metric grid.
- Strong typographic hierarchy before additional boxes/icons.
- Arc is the single signature motif; do not repeat it decoratively elsewhere.
- Explicit `@media (max-width: 340px)` behavior.
- Explicit `@media (prefers-reduced-motion: reduce)` behavior.
- Prevent text/arc intersections and keep all labels inside their cards.

### GATE

- No horizontal overflow at 402×874 or 320×568.
- Fixed bottom navigation stays fully inside the viewport and never obscures controls.
- No clipping, overlap, unreadable copy, or accidental raw enum text.

## Phase 4 — Deterministic Tests and Visual Proof

### WHAT

Add smoke and authenticated browser coverage for loaded, expanded, locked/unavailable, and compact states.

### WHY

A UI release is not complete until the running interface is objectively verified.

### HOW

Tests must prove:

1. Readiness Arc renders the exact fixture score/band from the existing payload.
2. The arc issues no request itself; existing readiness request count does not increase.
3. Coach's Log renders exact canonical mission facts and omits absent facts.
4. Source fixtures remain byte-identical after presentation.
5. Opening every expandable section leaves rendered body text free of `_` and raw closed-enum tokens.
6. `aria-expanded`, focus visibility, 44px targets, and reduced-motion styles exist.
7. `iphone-17` and `compact-mobile-320` both have exact viewport width, no horizontal overflow, and no nav/control collision.
8. Existing v2.4 preview/full-rest fail-closed behavior remains green.
9. Capture viewport screenshots—not stitched full-page screenshots—for baseline and expanded states at iPhone 17, plus compact stress state.
10. Claude Code visually reviews the actual candidate screenshots before release approval.

### GATE

- Focused smokes pass.
- Full frontend/backend QA passes.
- Both Playwright mobile projects pass.
- Candidate screenshots pass Claude Code visual QA with zero CRITICAL/HIGH findings and no copy violations.

## Phase 5 — Release

### WHAT

Fast-forward the independently reviewed candidate to `main`, allow Railway to deploy, and verify the exact live artifact.

### WHY

The existing TestFlight app remotely loads Railway web assets; a verified web deployment updates the app without a native rebuild.

### HOW

- Fetch origin and recheck source drift immediately before shipping.
- If main changed overlapping files, rebase and rerun independent QA.
- Fast-forward only.
- Prove remote main equals reviewed candidate.
- Poll Railway until the live revision and JS asset match the reviewed release.
- Run production-shell QA.
- Capture and visually inspect live iPhone 17 and compact-width screenshots.

### GATE

- Reviewed SHA equals origin/main and live Railway revision.
- Production shell and asset checks pass.
- Live interface has no underscore symbols, raw enums, grammar defects, overflow, clipping, or bottom-nav collisions.
- DAILY-OPS release record written.

## Explicit Non-Goals

- No entire-app redesign.
- No Plan calendar restructuring.
- No backend, schema, readiness-engine, or scoring changes.
- No native iOS changes or TestFlight build.
- No removal of familiar header or navigation controls.
- No new analytics, fake metrics, photography, or illustration dependency.
- No Flight Deck visual system.
