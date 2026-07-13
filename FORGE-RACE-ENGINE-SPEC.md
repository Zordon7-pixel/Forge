# FORGE — Race Engine + Registration Waiver Spec

> Author: Hermes (pre-build design). Date: 2026-07-07.
> Origin: Bryan wants Forge to be the *ultimate* running/info app — know every upcoming race, its course (distance/elevation/altitude), and auto-build a real periodized program to it (e.g. Army 10-Miler, Oct, 12-week). Also wants a registration liability waiver so we're legally covered, modeled (NOT copied) on FivePointFive's breathwork Health & Safety consent.
> Principle: **Simple as possible, smarter than the rest.** One tap to "train for this race," everything else automatic.
> Correction (2026-07-07, Bryan): full-marathon plans must support 16–18 weeks explicitly; the Army 10-Miler is a LOCAL (DC) race used only as an example — the race catalog must cover local/regional races, not just national majors.


---

## Current state (verified 2026-07-13 after H8)

| Capability | Status |
|---|---|
| Personal race calendar `race_events` (name/date/distance/location/goal_time/notes) + CRUD + `/next` | ✅ exists |
| `Races.jsx` page | ✅ exists |
| AI plan generator tied to `goal_type='race'` (`/plans/generate`, `/race-adjust`, adaptive) | ✅ exists |
| Variable plan length (e.g. 12 weeks) | ✅ shipped; race windows create dated, periodized plans through race day |
| Plan auto-derived from weeks-to-race (base/build/peak/taper periodization) | ✅ shipped in the unified concurrent-plan engine |
| Race **catalog** (searchable DB of real upcoming races) | ✅ shipped with name/location search plus manual fallback |
| Course intelligence (distance/elevation gain/altitude profile) | ✅ shipped with provenance/freshness trust gates and privacy-safe GPX analysis |
| Registration medical/liability waiver | ✅ shipped with versioned consent storage and re-prompt support |

H8 completed the race-first entry flow: catalog selection pre-fills date, distance, location, and trusted course data; users then choose available days, run/lift frequency, equipment, and goal time before generating. Malformed or timed-out AI output now falls back to the deterministic plan engine for both ordinary and race-specific routes.

---

## Phase 1 — Registration Waiver & Medical Screening (DO FIRST, legal cover)

**WHAT:** A checkbox-gated **Medical Disclaimer, Assumption of Risk & Health Screening** step in the registration flow. Modeled on FivePointFive's structure, our own wording, scoped to running + strength + breathwork.

Content blocks:
1. **Assumption of risk** — physical exercise (running, lifting, breathwork) carries inherent risk of injury/death; user participates voluntarily and assumes that risk.
2. **Not medical advice** — Forge's plans, readiness scores, and coaching are informational, not medical advice; consult a physician before beginning.
3. **Health screening list** — "Consult a doctor before using Forge if you have any of:" high blood pressure, heart/cardiovascular problems, chest pain, epilepsy, diabetes, asthma/respiratory issues, aneurysm, kidney disease, pregnancy, recent surgery/injury, or any condition affecting safe exercise. (Breathwork-specific for any breathing modules: stop immediately on dizziness/discomfort, practice seated/safe.)
4. **Stop-and-seek-care** acknowledgment.
5. **Data processing consent** — US-based processing per Privacy Policy.
6. **Hard gate** — "I have read and agree" required to continue; explicit "I don't agree" exits registration.

**HOW:**
- New table `user_consents (id, user_id, consent_type, version, accepted_at, ip)`.
- Waiver version constant in code; bump when text changes → re-prompt.
- Registration cannot complete without an accepted current-version row.
- Store acceptance timestamp + version for legal proof.
- Frontend: consent step in signup (Landing/register flow) with scrollable text + checkbox + two buttons.

**WHY:** Prescribing intensity to injured/older/at-risk users without an assumption-of-risk gate is a real liability exposure. This is the cheapest, highest-priority build.

**GATE:** New user cannot reach the app without a logged, versioned consent row. QA verifies no bypass (API + UI), re-prompt on version bump, existing users prompted on next login.

---

## Phase 2 — Variable, Periodized Plan Generator

**WHAT:** Make the plan generator produce a real N-week block sized to the race date, with periodization (base → build → peak → taper) instead of a fixed 4-week loop.

**HOW:**
- Change `generateTrainingPlan(profile, target)` prompt: accept `weeksToRace` (derived from race_date − today, clamped 4–20) and instruct periodization + taper in final 1–2 weeks.
- Distance-aware default lengths (used when the user has not fixed a date): full marathon = 16–18 weeks; half marathon = 12–14 weeks; 10-miler / 10K = 10–12 weeks; 5K = 8 weeks. Never cap a marathon build at a short block — an 18-week full-marathon plan must generate 18 real weeks.
- Add `target.raceDistanceMiles`, `target.raceDate`, `target.goalTimeSeconds`.
- New/updated endpoint `POST /plans/generate-for-race/:raceId` — reads the race, computes weeks, generates, assigns as active plan.
- Respect existing readiness/check-in override layer (non-destructive).

**WHY:** An "18-week full-marathon plan" or a "12-week 10-miler plan" must actually run that many weeks and peak/taper on race week — the current 4-week hardcode cannot express marathon-length periodization at all.

**GATE:** Generating for a race 12 weeks out yields a 12-week plan with a taper in the final week and mileage progression that respects current weekly miles + injury notes. QA executes generation, not just compile.

---

## Phase 3 — Race Catalog ("know all upcoming races")

**WHAT:** A searchable catalog of real races so users **pick** instead of hand-typing. One tap adds to their calendar + offers "build my plan."

**HOW:**
- New table `race_catalog (id, name, date, city, state, country, distance_miles, event_type, source, url, lat, lng)`.
- Seed a MIX across scale: national majors (large marathons/halves) AND regional/LOCAL races. The catalog's real value is covering local/regional races, not just big national events.
  - NOTE: the **Army 10-Miler** is a **local race (Washington, DC)** used in this spec only as Bryan's example — it is NOT a statewide/national flagship. Do not treat it as a marquee; it is representative of the many local races the catalog must include.
  - Tag each race with a `scope` (national / regional / local) so search can surface nearby local races first. Design for periodic refresh.
- Endpoint `GET /races/catalog?q=&distance=&month=&state=` search.
- "Add from catalog" copies into `race_events` and pre-fills the plan target.
- Keep manual add as fallback.

**WHY:** "Forge knows all upcoming races" = a catalog, not a text box. Simple UX: search → tap → done.

**GATE:** Search returns Army 10-Miler by name; adding it populates a race_event with correct date/distance; plan can be generated from it.

---

## Phase 4 — Course Intelligence (distance / elevation / altitude)

**WHAT:** Attach course profile to races so training adapts — elevation gain, altitude, terrain — and the runner sees what they're training for.

**HOW:**
- Extend `race_catalog`/`race_events` with `elevation_gain_ft`, `max_altitude_ft`, `terrain` (road/trail/mixed), `course_profile_json` (optional elevation series for a map/chart).
- Seed course data for cataloged races where known; allow GPX/route import later.
- Plan generator consumes course: hilly → add hill work; high altitude → add altitude-prep note/adjust expectations.
- Frontend: race detail shows distance, elevation chart, altitude, terrain.

**WHY:** "Race map for distance, altitude, everything needed to train" — course-aware plans are the "smarter than the rest" differentiator.

**GATE:** A cataloged race shows an elevation/altitude profile; a hilly race produces a plan that includes hill sessions.

---

## Build order & pipeline

1. Phase 1 (waiver) — ship first, smallest, legal priority.
2. Phase 2 (variable periodization) — unlocks the real 12-week ask.
3. Phase 3 (catalog) — the "knows all races" UX.
4. Phase 4 (course intelligence) — the differentiator.

Each phase: Hermes pre-flight → Codex build → Claude Code QA (executes, not just compile) → Hermes review → ship + post-deploy verify. Frontend changes go live on Railway deploy (no new TestFlight build needed unless native changes). Log each ship to DAILY-OPS.

## Open questions for Bryan
- Catalog seed scope: US road races only to start, or include trail/international?
- Course/elevation data source preference (manual seed vs. an API vs. GPX import) — affects Phase 4 cost/effort.
- Should breathwork be a first-class Forge module (its own screen + sessions), or is the waiver breathwork clause just future-proofing?


---

## Phase 1.5 — Specialized-Workout Paywall + 2-Week Trial + Comp Access

> Added 2026-07-07 per Bryan. Specialized/race workouts are PAID. New users get a 2-week trial then auto-charge. Bryan's friends get full "ultimate Forge" free via comp.

**Existing infra (reuse, do NOT rebuild):** `middleware/premiumGate.js` (`requirePremium(feature)` -> 402 if not `is_pro`), `routes/stripe.js` + `routes/payments.js` (create-subscription, webhook, status, pricing, cancel), users cols `is_pro`, `stripe_customer_id`, `stripe_subscription_id`, `subscription_status`, `subscription_ends_at`. Code already maps `subscription_status IN ('active','trialing')` -> pro.

**WHAT:**
1. Gate specialized workouts — race-program generation + specialized/advanced workouts require Pro via `requirePremium('Race Programs')`. Basic run logging + free plan stay free.
2. 2-week trial -> auto-charge — Stripe `trial_period_days: 14` on subscription creation. Card up front; `trialing` already = pro; auto-charge day 15. Surface trial end date.
3. Comp access (friends = ultimate Forge free): comp codes (`comp_codes` table: code, max_redemptions, redeemed_count, grants_until nullable, active) redeem -> `is_pro=1`, `subscription_status='comp'`, `subscription_ends_at=grants_until`; plus admin-only flip endpoint/script.
4. Webhook guard (CRITICAL) — Stripe webhook must NEVER downgrade `subscription_status='comp'` accounts. Explicit skip.

**HOW:** `comp_codes` + `comp_redemptions` tables in `runAlwaysMigrations()` (idempotent) + schema.pg.sql mirror. New `routes/comp.js`: `POST /comp/redeem` (auth), admin-guarded `POST /comp/grant`. Add `trial_period_days: 14` in subscription-create path. Frontend: reuse existing 402 `upgrade:true` handling for paywall sheet, trial badge, comp-code entry field.

**WHY:** Monetize high-value race/specialized programs, keep free tier useful, zero-cost path to hand friends the full app.

**GATE:** Free user hits race-program generation -> 402 upgrade. New subscriber gets 14-day trial then auto-charge. Comp redemption grants full Pro with no Stripe sub; webhook events never downgrade comp. Admin flip works. QA executes each path.

---

## Phase 2.5 — Plan Catalog UX (Nike-style cards → dynamic generator front door)

> Added 2026-07-07 per Bryan (Nike Run Club screenshots as UX reference). STANDING ORDER captured: Hermes must challenge/question Bryan's ideas, not rubber-stamp — recorded here as a design principle for this app.

**STRATEGIC FRAME (the challenge, on record):** Nike Run Club ships a STATIC catalog — every plan card (4-wk beginner, 8-wk 5K, 18-wk marathon) is a pre-baked shelf product identical for all users. Copying that = a worse Nike. Forge's moat is the OPPOSITE: the card is a DOORWAY to a plan computed live from the user's own Apple Health/Watch data. Steal Nike's card UI + one-tap simplicity; reject Nike's fixed-template payload.

**WHAT:**
1. Plan catalog screen — clean Nike-style card grid (distance/goal: 5K, 10K, Half, Marathon, Army 10-Miler, Custom). Each card shows goal + est. duration + level badge. Simple, beautiful, athlete-first.
2. Card tap = dynamic generation, NOT a template. Feeds the Phase 2 periodized generator with the user's real inputs.
3. Generation inputs:
   - Apple Health/Watch data (current fitness, recent weekly volume, HR/zones, pace) — the differentiator Nike cannot replicate.
   - PR goals (target time for the distance).
   - Distance/race (or race from Phase 3 catalog).
   - Availability — INFER from Apple Health workout history (which days they actually train), then SHOW it and let user tap to correct. Simple + smart, not a blank questionnaire.
   - Lift toggle — 'keep hitting weights?' → concurrent run+lift plan (Forge's core hybrid edge) vs run-only.
4. Output = the Phase 2 variable, periodized plan (base/build/peak/taper), personalized — never a shelf template.

**WHY:** Nike has no idea a user lifts or what their biometrics are. Concurrent runner+lifter personalization off real Apple Health data is Forge's defensible wedge. The catalog gives Nike-grade simplicity of entry without surrendering the smart, custom core.

**HOW:** Frontend plan-catalog grid (reuse card/styling conventions). On tap → prefill generator context from /me + Apple Health signals + inferred availability, show an editable confirm sheet (availability chips, PR goal, lift toggle), then POST to the Phase 2 generator endpoint. Gate specialized/race plans behind Phase 1.5 paywall.

**GATE:** Tapping a card never returns a static template — every plan reflects that user's data. Inferred availability is shown and editable. Lift toggle changes the plan structure. Free user tapping a specialized plan hits the 402 upgrade. QA verifies two different users tapping the same card get different, data-driven plans.

**DEPENDS ON:** Phase 2 (variable periodized generator) + Phase 1.5 (paywall). Sequitur after Phase 2.
