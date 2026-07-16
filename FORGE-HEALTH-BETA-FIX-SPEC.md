# FORGE-HEALTH-BETA-FIX-SPEC.md — Un-wall Apple Health for Beta + Onboarding Prompt

**Status:** Ready to build (Codex → Claude QA → ship). Frontend-only → live on Railway, no new TestFlight build.
**Author:** Hermes (per Bryan, 2026-07-16)
**Priority:** HIGH — live beta activation leak. 6 of 8 testers signed up but never logged; Apple Health sync is the proven activation lever (the one tester who synced has 79 runs).

## Root cause (verified in code)
1. **False paywall.** `frontend/src/components/InsightsSheet.jsx` shows non-Pro users *"Apple Health sync is available on the Pro tier"* + an **"Upgrade to Pro"** button (the `{!proLoading && !isPro && (...)}` block, ~line 875). But **the backend `/health/sync` is NOT Pro-gated** (only `auth` + rate limit), and the `/health` page + `HealthSourceManager` sync button are login-only. Proof it's open: a **free** user (Jendy) synced 79 runs. So the paywall copy is a bug that tells free testers they can't use the feature → they quit.
2. **No onboarding prompt.** Nothing routes a new user to connect Apple Health; they'd have to find the Sync button themselves.

## Scope (do exactly this — nothing else)
### Change 1 — Remove the false Pro wall on Health sync (InsightsSheet)
- In `InsightsSheet.jsx`, the non-Pro Health branch must **not** claim sync is Pro-only or push "Upgrade to Pro." Instead, show the same **"Sync Health data"** path free users already can use (link to `/health` / trigger sync), matching what the backend actually allows.
- Do NOT change backend gating (it's correctly open). This is a frontend copy/flow correction.
- If readiness *drivers/insights* are intentionally a Pro upsell, keep THAT upsell — but the **sync action itself must be available to free users**. Only the false "sync is Pro" message is removed.

### Change 2 — Onboarding "Connect Apple Health" step
- Add a step/card in the onboarding flow that prompts the user to connect Apple Health, deep-linking to the sync action (`HealthService.syncNativeData({ requestPermission: true })` / `/health`).
- Native-only capability: show it only in the native iOS runtime (guard with the existing `isNativeRuntime` check); on web, show a "open in the iPhone app to connect" note instead of a dead button.
- Skippable (don't block onboarding completion), but present by default.

## Out of scope
- No backend/auth/gating changes. No new native plugins (no TestFlight build). No changes to the readiness/insights Pro gating other than the sync-action wording. Do not resurrect the stale `fix/health-autosync` June-1 branch.

## Gates
- `node --check` / build passes; no console errors on Insights + onboarding.
- A simulated **free (non-Pro)** user sees a usable **Sync Health** action on Insights — NOT an "Upgrade to Pro" wall.
- Onboarding shows the Connect-Apple-Health step (native) / the web note (web); skippable.
- **Before/after screenshots** of the Insights health panel as a free user (Bryan's proof rule) — before: paywall; after: sync action.
- Tier-1 Claude QA (touches monetization-adjacent gating — confirm no *other* Pro feature got un-gated by mistake).
