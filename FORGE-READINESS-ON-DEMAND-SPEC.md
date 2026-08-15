# FORGE Readiness On-Demand UI Correction

**Status:** Approved for Codex implementation  
**Date:** 2026-08-15  
**Base:** `828c7343870dfc9fdf39aad71b78e4b92eeb14e4`  
**Primary viewport:** iPhone 17, 402 × 874 CSS pixels at 3×  
**Stress profile:** `compact-mobile-320`, 320 × 568 CSS pixels

## Product Decision

The compact readiness chip in the sticky header is the only readiness element shown by default on the dashboard. The large Daily Readiness arc card must not occupy the main dashboard. Tapping the compact header readiness chip opens the large arc/details experience in the existing readiness sheet or overlay. Coach's Daily Brief becomes the first Signature UI card in normal dashboard flow.

## Why

The shipped dashboard repeats the same readiness score in two prominent places. On Bryan's live screenshot, the compact header chip already shows Readiness 53 while a second large Daily Readiness 53 card pushes the Coach's Daily Brief and Today's Plan down the page. The new arc design is approved; its default placement is not.

## Phase 1 — Move Readiness Behind the Existing Header Trigger

### WHAT

- Remove the large `ReadinessArcCard` from the default dashboard document flow.
- Preserve the compact `HeaderReadinessChip` exactly as the dashboard trigger.
- Preserve the existing `/?readiness=1` interaction contract.
- When that trigger is activated, show the new Daily Readiness arc/details experience in the existing readiness overlay/sheet.
- The opened state must include the canonical score, band, verdict, and available drivers from the same Dashboard readiness payload.
- Coach's Daily Brief remains inline and becomes the first Signature UI card.

### WHY

The dashboard should prioritize today's coaching action while readiness remains one tap away. This removes duplicate information without removing the approved design or its data.

### HOW

- Reuse `ReadinessArcCard`; do not duplicate its score/band/driver rendering.
- Reuse the existing `showReadinessModal` state and header route behavior.
- Keep one Dashboard `/recovery/readiness` request path; do not add a new request or recompute readiness.
- The overlay must close via its Close control and backdrop, remain keyboard-accessible, and use appropriate dialog semantics.
- Do not create a nested or dead disclosure control. The opened experience must have coherent expansion behavior.
- Preserve the existing readiness unavailable/loading/locked/error truth states.

### GATE

- Before tap: no `[data-signature-readiness]` large card in dashboard content; Coach's Daily Brief is visible first.
- Header chip remains visible and has an accessible Open recovery readiness label.
- After tap: exactly one large Daily Readiness arc/details experience appears in the overlay.
- Closing returns to the dashboard without a large readiness card.
- Displayed score/band exactly match the canonical readiness payload.
- Zero added readiness requests, runtime errors, horizontal overflow, nav collision, raw enum identifiers, or customer-visible underscores.

## Phase 2 — Regression and Visual Proof

### WHAT

Update focused smoke and Playwright coverage for default, opened, and closed states at both mobile profiles.

### WHY

The original defect is state-dependent. A static dashboard screenshot alone cannot prove the header-triggered overlay works.

### HOW

- Assert the large card is absent before interaction.
- Click the actual header readiness control.
- Assert the large card appears with canonical score/band/drivers.
- Capture initial opened state and maximum internal-scroll state where relevant.
- Close and assert the large card is absent again.
- Assert Coach's Daily Brief remains on the dashboard and its disclosure still works independently.

### GATE

- Focused smoke passes.
- Playwright passes on `iphone-17` and `compact-mobile-320`.
- Full `npm run qa` passes.
- Claude Code visually inspects the running default and opened states before ship.

## Exact Implementation Allowlist — Maximum 6 Files

1. `frontend/src/pages/Dashboard.jsx`
2. `frontend/src/components/InsightsSheet.jsx`
3. `frontend/src/components/ReadinessArcCard.jsx`
4. `frontend/src/index.css`
5. `frontend/test/signatureUi.smoke.mjs`
6. `frontend/test/e2e/authenticatedJourneys.spec.mjs`

Codex may touch fewer files. It must not touch `Layout.jsx`, `HeaderReadinessChip.jsx`, backend, schema, API routes, package files, lockfiles, Capacitor/native files, or unrelated tests.

## Release Contract

Frontend-only Railway release. The installed TestFlight app loads this frontend remotely after force-close/reopen. No new native build is required.
