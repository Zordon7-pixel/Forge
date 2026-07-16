# FORGE-CLOSET-SPEC.md — Smart Shoe Closet & Rotation Recommender

**Status:** Draft (queue BEHIND current Friends Beta phases)
**Author:** Hermes (per Bryan, 2026-07-15)
**Related:** FORGE-SHOE-FEATURE-SPEC.md (auto shoe+apparel rec), gear tracker (`gear_shoes`, page `/gear`)

## Concept
A visual "closet" of the user's shoe collection + a one-tap **"what do I wear today"** that maps route intent + surface + weather + per-shoe wear to the best pick, and **rotates mileage** so no single pair gets over-run. Extends the existing gear tracker; does NOT replace it.

## NON-NEGOTIABLE ARCHITECTURE RULE
The shoe recommendation is a **DETERMINISTIC RULES ENGINE — NO LLM.** Picking a shoe from structured inputs (category, surface, mileage vs recommended, weather, availability) is 0-cost/instant/infinitely-scalable and cannot hallucinate a retired shoe. An LLM/API is used ONLY in Phase 4 for a one-line qualitative coach narrative on top of the already-decided pick. Never route the decision through an API. Mirrors Bryan's standing Forge LLM rule: scoring/decisions = rules; qualitative voice = LLM.

## Scope guardrails
- Forge nav is a FIXED 5-tab bar (Home/Run/Lift/Body/More) — do NOT add a 6th tab. Surface via a Dashboard card + the More menu.
- NO social/sharing of the closet in beta.
- NO photo/AI sneaker-recognition until Phase 5 (later, Premium).
- Premium-gate the recommender + rotation + apparel; keep basic mileage tracking free.

---

## Phase 0 — Data model extension
**WHAT:** Extend `gear_shoes`. Existing: brand, model, recommended_miles, is_retired, category, mileage. ADD: `surface` (road|trail|both), `intent_tags` (array: easy|tempo|race|long|recovery), `wet_ok` (bool), optional `cushion` (max|balanced|firm).
**WHY:** The recommender is only as smart as the per-shoe metadata.
**HOW:** Additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `schema.pg.sql` AND `runAlwaysMigrations()` (deploy must run migrations). Backfill defaults from existing `category`.
**GATE:** node --check; migration idempotent on prod; no-metadata shoes still track mileage identically.

## Phase 1 — Rules recommender engine (deterministic, no LLM)
**WHAT:** `services/shoeRecommender.js` — input {route:{intent,surface,distance}, weather:{precip,temp}, shoes}; output ranked list + top pick + reason codes.
**WHY:** Core value. Replaces Bryan's manual pre-run shoe research.
**HOW:** Score each eligible shoe: intent_tags vs route intent, surface vs route surface, wet_ok vs precip; then rotation bias (prefer freshest-mileage eligible pair, de-prioritize shoes near recommended_miles, exclude retired). Pure function, unit-tested.
**GATE:** Unit tests: race day picks race shoe; wet excludes non-wet_ok; trail picks trail/both; over-mileage demoted; retired excluded. Tier-1 Claude QA.

## Phase 2 — Closet UI
**WHAT:** Visual grid of collection (per-shoe wear bar) + "What do I wear today" panel (top pick + 1-2 alternates).
**WHY:** Makes the engine tangible + daily-useful; retention hook.
**HOW:** Page from a Dashboard card + More menu (no 6th tab). Reuse `/api/gear`. Use the day's planned route intent if present, else user picks intent.
**GATE:** Loads with 0/1/many shoes; no console errors; before/after screenshots required.

## Phase 3 — Weather integration
**WHAT:** Live conditions into the recommender.
**WHY:** Wet/cold changes the right shoe.
**HOW:** OpenWeather free tier via env `WEATHER_API_KEY`; cache per-user/location per day. Degrade to weather-agnostic rec if unavailable.
**GATE:** Missing key returns a valid pick (no crash).

## Phase 4 — AI coach narrative (LLM, Premium)
**WHAT:** One-line rationale for the decided pick.
**WHY:** The "AI" the user feels — but only voices a rules decision.
**HOW:** Reuse `services/ai.js` (cheap model, cache per pick, Premium-gated). LLM phrases the decided pick + reason codes; never chooses.
**GATE:** Never changes the pick; cache hit on repeat; falls back to static reason text if API down.

## Phase 5 — Photo sneaker-ID (LATER / Premium)
**WHAT:** Add shoes by photo (vision model prefills attributes).
**WHY:** Reduces add-friction; premium delight.
**HOW:** Vision model on add; user confirms/edits. Deferred until core loop proven.
**GATE:** Deferred — not scheduled with v1.

## Monetization
Free: manual add + mileage tracking. Premium: smart daily rec, rotation optimization, weather-aware picks, apparel, later photo-ID.
