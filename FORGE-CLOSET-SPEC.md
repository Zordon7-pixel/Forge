# FORGE-CLOSET-SPEC.md — Smart Shoe Closet, Sneaker Knowledge Base & Rotation Recommender

**Status:** Draft (queue BEHIND current Friends Beta phases)
**Author:** Hermes (per Bryan, 2026-07-15)
**Related:** FORGE-SHOE-FEATURE-SPEC.md, FORGE-RECOVERY-READINESS-SPEC.md, FORGE-ZONE-CALIBRATION-SPEC.md, gear tracker (`gear_shoes`, page `/gear`, routes `/api/gear`, `backend/src/routes/gear.js`, `backend/src/lib/shoeRecommendation.js`)

## MISSION (north star)
Forged Hybrid's purpose is **injury prevention + teaching the runner as they go.** Every feature answers: *should you run today, how hard, and in what shoe — without getting hurt.* This spec adds the missing injury pillar (footwear) to the two Forge already has.

**The injury-prevention loop (3 measurable levers):**
1. Running too HARD → **HR-zone calibration** (already shipped) catches secretly-hard "easy" runs.
2. Running UNDER-RECOVERED → **recovery-readiness engine** (already shipped) catches it.
3. Running in the WRONG or DEAD shoes → **this spec.** Worn-out cushioning, mismatched drop/surface, and single-pair over-use are research-backed injury drivers.
Unifying these three lets the coach say: *"You're 92% on your Vaporfly (dead cushioning), amber on recovery, today is an easy Z2 — take the max-cushion trainer, not the racer."*

## Current data reality (what exists today)
Sneaker data is essentially **user-typed** brand+model, plus a **17-entry hardcoded `RECOMMENDED_MILES` keyword table** in `gear.js` (carbon racers→200mi, trail→350mi, else default **450mi**). There is **no sneaker knowledge base, no specs, no API.** Mileage accrues from logged runs. That is the gap Phase 0.5 fills.

## NON-NEGOTIABLE ARCHITECTURE RULES
- The shoe recommendation is a **DETERMINISTIC RULES ENGINE — NO LLM** (0-cost, instant, can't hallucinate a retired shoe). An LLM voices the decision only (Phase 4); it never makes it. Mirrors Bryan's Forge LLM rule: scoring/decisions = rules; qualitative voice = LLM.
- The sneaker knowledge base is **OWNED, not rented** — a static Forge-owned dataset, no paid shoe API, no live scraping. (Bryan's owned-over-subscription philosophy.)

## Scope guardrails
- Forge nav is a FIXED 5-tab bar (Home/Run/Lift/Body/More) — do NOT add a 6th tab. Surface via a Dashboard card + the More menu.
- NO social/sharing of the closet in beta.
- NO photo/AI sneaker-recognition until Phase 5 (later, Premium).
- Premium-gate the recommender + rotation + apparel; keep basic mileage tracking free.

---

## Phase 0 — Data model extension (per-shoe user attributes)
**WHAT:** Extend `gear_shoes`. Existing: brand, model, recommended_miles, is_retired, category, mileage. ADD: `surface` (road|trail|both), `intent_tags` (array: easy|tempo|race|long|recovery), `wet_ok` (bool), optional `cushion` (max|balanced|firm), `catalog_id` (FK to shoe_catalog, nullable).
**WHY:** The recommender is only as smart as the per-shoe metadata; `catalog_id` links a user shoe to the knowledge base so attributes auto-fill.
**HOW:** Additive `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` in `schema.pg.sql` AND `runAlwaysMigrations()` (deploy MUST run migrations — current `initDb()` does not apply schema.pg.sql; see railway-prod-db-ops migration-gap rule). Backfill defaults from existing `category`.
**GATE:** node --check; migration idempotent on prod; existing no-metadata shoes still track mileage byte-identically.

## Phase 0.5 — Owned Sneaker Knowledge Base (NEW — the injury data foundation)
**WHAT:** A Forge-owned `shoe_catalog` table of real running-shoe specs. Columns: `id`, `brand`, `model`, `aliases` (array, for match), `category` (daily_trainer|tempo|race|trail|stability), `surface` (road|trail|both), `drop_mm` (int), `stack_height_mm` (int), `cushioning` (soft|balanced|firm), `stability` (neutral|stability|motion_control), `weight_g` (int), `recommended_miles` (int), `wet_ok` (bool), `updated_at`. Injury-relevant fields (drop, stack, cushioning, stability, mileage) are the point.
**WHY:** Removes the user-typed-guess problem and powers real fit/injury logic. Owned = $0 ongoing + a data moat.
**HOW (build method — critical):**
1. **Scope:** top **~250 models real runners buy** (covers ~90% of users) — NOT every shoe ever made.
2. **Populate = LLM-assisted DRAFT + source VERIFICATION.** An LLM drafts attributes per model from training knowledge; then **numeric specs (drop_mm, stack, weight) are verified against an authoritative source (RunRepeat / manufacturer)** before insert. NEVER ship unverified LLM specs — a wrong drop number in an injury app is worse than none. Store the dataset as a checked-in seed file (`backend/src/data/shoe_catalog.seed.json`) loaded idempotently on migrate.
3. **Refresh cadence:** quarterly re-seed; new models appended. No live API/scrape at request time.
4. **Autocomplete API:** `GET /api/shoe-catalog?q=` returns matches by brand/model/alias. On add-shoe, selecting a catalog entry auto-fills Phase 0 attributes + sets `catalog_id`. Unknown shoe → manual add + optional "suggest to catalog" (crowd-grows the DB).
**GATE:** seed loads idempotently; autocomplete returns sane matches; a known model (e.g. Pegasus) auto-fills correct drop/cushioning; unknown model still addable manually; numeric-spec verification step documented in the PR. Tier-1 Claude QA (data quality + schema).

## Phase 1 — Rules recommender engine (deterministic, no LLM)
**WHAT:** `services/shoeRecommender.js` — input {route:{intent,surface,distance}, weather:{precip,temp}, shoes (joined with catalog attrs)}; output ranked list + top pick + reason codes (injury-aware).
**WHY:** Core value. Replaces manual pre-run shoe choice AND flags injury risk (dead cushioning, wrong surface).
**HOW:** Score each eligible shoe: intent_tags vs route intent, surface vs route surface, wet_ok vs precip; apply **injury/rotation bias** — de-prioritize shoes near/over recommended_miles (dead cushioning = risk), exclude retired, prefer freshest-mileage eligible pair to spread load. Emit reason codes (e.g. `OVER_MILEAGE`, `WRONG_SURFACE`, `ROTATE_LOAD`). Pure function, unit-tested.
**GATE:** Unit tests: race day→race shoe; wet→excludes non-wet_ok; trail→trail/both; over-mileage demoted + flagged; retired excluded. Tier-1 Claude QA.

## Phase 2 — Closet UI
**WHAT:** Visual grid of collection (per-shoe wear bar vs recommended_miles, injury flag when ≥80%) + "What do I wear today" panel (top pick + 1-2 alternates + reason).
**WHY:** Makes the engine tangible + daily-useful; retention hook.
**HOW:** Page from a Dashboard card + More menu (no 6th tab). Reuse `/api/gear`. Use the day's planned route intent if present, else user picks intent.
**GATE:** Loads with 0/1/many shoes; no console errors; before/after screenshots required.

## Phase 3 — Weather integration
**WHAT:** Live conditions into the recommender.
**WHY:** Wet/cold changes the right (and safest) shoe.
**HOW:** OpenWeather free tier via env `WEATHER_API_KEY`; cache per-user/location per day. Degrade to weather-agnostic rec if unavailable.
**GATE:** Missing key returns a valid pick (no crash).

## Phase 4 — AI coach narrative (LLM, Premium)
**WHAT:** One-line injury-aware rationale for the decided pick.
**WHY:** The "AI" the user feels — but only voices a rules decision.
**HOW:** Reuse `services/ai.js` (cheap model, cache per pick, Premium-gated). LLM phrases the decided pick + reason codes; never chooses.
**GATE:** Never changes the pick; cache hit on repeat; falls back to static reason text if API down.

## Phase 5 — Photo sneaker-ID (LATER / Premium)
**WHAT:** Add shoes by photo — vision model IDs the model, matches to `shoe_catalog`, prefills attributes.
**WHY:** Reduces add-friction; premium delight; leverages the KB.
**HOW:** Vision model on add → catalog match → user confirms/edits. Deferred until core loop proven.
**GATE:** Deferred — not scheduled with v1.

## Monetization
Free: manual add + mileage tracking + wear alerts (injury basics stay free — it's the mission). Premium: smart daily recommendation, rotation/load optimization, weather-aware picks, apparel, photo-ID.
