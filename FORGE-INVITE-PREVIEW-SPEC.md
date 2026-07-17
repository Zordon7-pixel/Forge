# FORGE-INVITE-PREVIEW-SPEC.md — Rich "Add me on Forged Hybrid" Invite Link Preview

**Status:** Ready to queue (Codex → Claude QA → ship). Web route — no new TestFlight build.
**Author:** Hermes (per Bryan, 2026-07-16)

## Problem
When a user shares their friend-invite link, it renders as a **bare text bubble** showing the app's generic title ("Forged Hybrid — Coach for runners who lift") with no image. Bryan wants a **rich preview card** that says **"Add me on Forged Hybrid"** (like an Amazon share card).

## Root cause
Link-preview crawlers (iMessage, WhatsApp, social) **do not run JavaScript**, so they never see the React SPA's meta tags — they only read the static `index.html`, which has the generic app title. The invite URL currently resolves to the SPA and thus shows generic meta.

## Solution
Serve the invite URL from a **backend route that returns crawler-readable HTML with Open Graph tags**, then bounce the human into the app. Standard rich-invite pattern.

## Existing hooks
Users table already has `friend_handle` and `friend_discoverable`. The app has a friend-invite/share action. Codex: find the current invite URL scheme + share action and route it through the new endpoint.

---

## Phase 0 — Server-rendered invite route with OG tags
**WHAT:** Backend GET `/invite/:handle` (match/repoint the existing invite URL) returns a small HTML page containing Open Graph + Twitter Card meta:
- `og:title` / `twitter:title`
- `og:description` / `twitter:description`
- `og:image` / `twitter:image` (absolute URL, 1200x630)
- `og:url`, `og:type=website`, `twitter:card=summary_large_image`
The same HTML immediately redirects a real browser into the app (JS redirect + `<meta http-equiv=refresh>` fallback) to the app's add-friend deep link for that handle.
**WHY:** Crawlers read the meta (rich card); humans land in the app to accept.
**HOW:** Look up the inviter by `friend_handle`. If found + discoverable, use personalized copy; else generic. Do NOT leak PII beyond first name/handle. Escape all interpolated values.
**GATE:** `curl -A 'facebookexternalhit' <invite-url>` returns HTML with all og: tags populated; a normal browser hitting it lands in the app add-friend flow; unknown handle → safe generic card (no crash/500).

## Phase 1 — Branded OG image + copy
**WHAT:** A static 1200x630 branded card image at a stable public URL (logo + tagline), referenced by `og:image`.
**Copy (default):**
- Generic: `og:title` = "Add me on Forged Hybrid 💪", `og:description` = "Hybrid training for runners who lift — join me and let's compare progress."
- Personalized (handle resolves): `og:title` = "{FirstName} invited you to Forged Hybrid", same description.
**WHY:** The image is what makes it feel like a real invite card, not a link.
**HOW:** Add the asset to the frontend public assets (served at a stable path) or a backend static route; reference it absolutely in og:image.
**GATE:** og:image URL returns 200 image/*; renders in a link-preview validator (or a real iMessage/WhatsApp paste).

## Phase 2 — Wire the share action to the new link
**WHAT:** The in-app "friend invite link" / share action copies/shares the `/invite/:handle` URL (not a bare SPA URL).
**WHY:** So what users actually send is the rich-preview link.
**HOW:** Update the share/copy handler to build the `/invite/{myHandle}` URL.
**GATE:** Sharing from the app produces the `/invite/:handle` URL; pasting it shows the rich card.

## Out of scope
No new native plugins, no TestFlight build, no auth/gating changes. Personalization must never expose email or sensitive fields — first name/handle only.

## QA (Tier-1 — it's public-facing + PII-adjacent)
Confirm: crawler UA gets full OG tags; human redirect works; unknown/invalid handle is safe; no PII beyond first name/handle in the HTML; image loads; XSS-safe interpolation.
