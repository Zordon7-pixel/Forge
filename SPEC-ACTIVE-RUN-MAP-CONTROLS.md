# FORGED HYBRID — ACTIVE RUN BACK NAVIGATION + LIVE MAP VIEWS

**Date:** 2026-07-24  
**Status:** Codex implementation spec  
**Repository:** `/private/tmp/forge-live-map-20260724`  
**Branch:** `codex/forge-live-map-controls`

## User evidence

Bryan supplied the production iPhone screenshot:
`/Users/zordon/.hermes/cache/images/img_7341d68a00a9.jpg`

Visible state:
- Active Run pre-start screen at elapsed `0:00`, distance `0.00 mi`, pace `--`.
- Route-capture/watch-merge explanation and a large `Start Run` button.
- A low-contrast `← Back` control is visible below Start Run but does not navigate.
- No map is visible before Start, and a large unused black area remains under the card.

Bryan also asked whether the map can look/change differently while running.

Treat the Back behavior as a confirmed production bug. Treat the map request as a focused active-run UX improvement, not a new route-planning/navigation product.

## Product decision

1. **Pre-start Back is deterministic.** It must return to the safe Forge screen that launched Active Run and must not depend only on browser history having an entry.
2. **Never lose an active recording.** After recording starts, navigation/back behavior may minimize or warn, but must not silently stop, reset, or discard the run.
3. **Three useful map layouts:**
   - **Follow** — current position stays centered while the recorded path grows.
   - **Overview** — fits the recorded route plus planned route, when present.
   - **Stats** — collapses/hides the map for maximum metric visibility.
4. **Appearance over gimmicks.** Keep high-contrast Forge styling, clear current-position marker, solid recorded route, and visually distinct planned overlay. Do not add turn-by-turn claims.
5. **Provider discipline.** Reuse the existing map component, tile provider, and attribution. If the already-approved provider supports both dark and street styles without a new key or new terms, expose a compact `Dark / Street` layer control. Otherwise do not add a new tile source in this phase. No unapproved satellite tiles, paid API, or hidden billing dependency.
6. **Frontend/web only.** Do not change Capacitor plugins, Info.plist, entitlements, native iOS code, or the route recorder. The existing TestFlight shell remote-loads Railway; no new TestFlight build is required.

## Preflight and scope

Before editing:
- Read `CLAUDE.md`, `QA-CHECKLIST.md`, `FORGE-SMART-START-ROUTE-TRUTH-SPEC.md`, and relevant Active Run/router/map files.
- Trace the exact path from the Run Today sheet into Active Run and explain why Back is a no-op.
- Trace the existing map implementation, current route-follow behavior, planned-route overlay, recorder lifecycle, and map provider/attribution.
- Reuse existing primitives. Do not create a second recorder or second canonical map path.
- Maximum 10 changed files for this Codex session, including this spec. Do not touch unrelated files. Do not push or deploy.

## Phase 1 — Deterministic Back behavior

### Requirements

- When Active Run is **not recording**, Back returns to the launch context supplied by navigation state if it is a validated internal Forge path.
- If no trustworthy return target/history exists, use the correct safe product fallback discovered from the router (Today/Train/Plan rather than a blank browser history operation).
- Do not accept absolute URLs, protocol-relative URLs, or arbitrary external return targets.
- Browser/system back and the visible Back control must behave consistently.
- Back must not leave a stale draft, body lock, or overlay that blocks the returned screen.
- Once recording has started, accidental back/navigation must not unmount the recorder and lose GPS/session state. Use the existing active-session persistence/lifecycle contract. If safe minimization is not already supported, block with a concise in-app confirmation explaining that the run is still recording; never silently terminate it.
- Make the control a semantic button with a minimum 44×44 pt touch target, visible focus state, and stronger contrast than the current screenshot.

### Gate

Behavior tests cover:
- Entered from normal Run Today flow → Back reaches the exact safe origin.
- Direct/deep-linked pre-start route with no history → safe fallback.
- Malformed/external return target → safe fallback, no open redirect.
- Active recording + visible/system back → recording/session survives and no silent discard.

## Phase 2 — Live map view controls

### Requirements

- Add a compact, one-hand-usable segmented control or equivalent with `Follow`, `Overview`, and `Stats`.
- Controls appear only where meaningful and do not cover native safe areas, map attribution, run controls, or metrics.
- **Follow:** center on the newest valid position; resume follow via a visible recenter action after the athlete pans the map.
- **Overview:** fit all valid recorded points plus planned route points. Ignore malformed coordinates and never fabricate a route.
- **Stats:** collapse/hide the map without stopping location updates or resetting elapsed time, distance, route, auto-pause, or active session.
- Switching views must not recreate/restart the recorder, geolocation watcher, native capture session, or canonical route array.
- Recorded route uses a high-contrast Forge treatment; planned route remains visibly distinct and is never presented as completed GPS history.
- Preserve the existing truthful states: acquiring GPS, no route yet, partial route, and planned overlay only.
- Persist the last layout choice locally on the device. Validate stored values and default safely. Do not store coordinates or health data in the view-preference key.
- At short iPhone heights, keep elapsed/distance/pace and pause/finish actions reachable without trapping scroll.
- Touch targets at least 44 pt; proper pressed/selected semantics; VoiceOver names; reduced-motion friendly.
- Maintain map attribution and the existing map-provider terms.

### Optional tile appearance

Only if the existing approved provider already supports it without a new credential/provider:
- Add `Dark / Street` appearance control.
- Persist the choice locally and update the map without restarting recording.
- Preserve attribution.

If not supported, document why it was intentionally omitted. Do not substitute an unapproved public satellite endpoint.

Implementation note: the existing approved frontend architecture uses the standard
OpenStreetMap street tile endpoint directly with OpenStreetMap contributor
attribution. No second dark-style URL, credential, or approved style configuration
exists in the repository, so this phase intentionally preserves the existing street
layer and attribution without adding a Dark / Street switch or another provider.

### Gate

Executable tests prove:
- Follow/Overview/Stats transitions.
- Stats does not stop or reset recording.
- Follow recenters on latest valid point; Overview fits recorded + planned bounds.
- Invalid coordinates are rejected.
- Stored map preference is validated.
- Controls are keyboard/touch accessible and do not intercept pause/finish.
- No horizontal overflow at 375×667, 390×844, or 430×932.
- Desktop sanity viewport passes.

## Phase 3 — Regression, build, and proof

Run the relevant existing suites for:
- Active Run persistence/recovery.
- Smart Start / route truth.
- Planned route overlay.
- Swipe-back/navigation.
- Mobile viewport and responsive polish.
- Run integrity and production Vite build.

Add focused behavior tests rather than string-only assertions where the repo supports executable DOM/map harnesses.

Capture proof outside the repo:
- BEFORE: `/Users/zordon/.hermes/cache/images/img_7341d68a00a9.jpg`
- AFTER pre-start screenshot showing the improved Back control and map preview/state if appropriate.
- AFTER active-run screenshot at iPhone dimensions showing the new live map layout control and map/route state. Synthetic QA coordinates are acceptable only if the screenshot is clearly identified as QA proof and the running built app is actually exercised.

A screenshot cannot prove Back navigation by itself; include executable navigation-test output.

## Completion contract

Commit all intended source/test/spec changes and leave the worktree clean. Return:
- Root cause of Back no-op.
- Existing map/provider architecture discovered.
- Exact files changed.
- Tests and results.
- BEFORE/AFTER proof paths.
- Commit SHA.
- Any residual physical-iPhone field-test requirement.

Do not claim shipped.
