# FORGE — Recovery Readiness Score (Feature One-Pager)
_Drafted 2026-06-02 by Hermes. Origin: daily Signal review (Efficiency-vs-Safety paradox). Status: PROPOSED — fold into Phase 3 Intelligence Layer, not a separate phase._

## Why (the signal)
The running-app market is splitting along an Efficiency-vs-Safety line. AI plans (Runna, Garmin, Samsung Health) optimize the schedule but cannot sense fatigue, poor sleep, or a tweaky Achilles. TechRadar and Womens Health are publicly flagging injury risk from algorithm-only coaching. FORGE already owns an injury-prevention identity and has the Body tab + biometrics — so the wedge is a Safety-First Intelligence layer that tells the runner: train hard today, or back off.

## What (one sentence)
A daily Recovery Readiness score (0-100) plus a plain-language verdict (GREEN / AMBER / RED) that tells the runner whether their body is ready for the intensity their plan prescribes today.

## Who it is for
- Return-to-Run athletes (post-injury) — highest-stakes, lowest-confidence segment. This is literally Bryan right now.
- Beginner marathoners following a rigid automated block who cannot tell overtraining from normal fatigue.
- Data-rich runners with wearables but no actionable why behind the numbers.

## How it scores (rule-based v1, no ML needed)
Weighted blend of inputs FORGE can already get from HealthKit / manual entry. Each input maps to a 0-100 sub-score; weighted average = readiness.

- Sleep last night vs 7-day average (weight 25)
- Resting HR vs baseline — elevated RHR = under-recovered (weight 20)
- HRV trend where available (weight 20)
- Acute:chronic training load ratio — yesterday + 7-day vs 28-day mileage; spikes flag injury risk (weight 20)
- Subjective check-in: 1-tap soreness / mood / energy prompt (weight 15)

Verdict bands: GREEN 70-100 (go as planned), AMBER 45-69 (reduce intensity / swap to easy), RED 0-44 (rest or cross-train). Each verdict shows the 1-2 inputs that drove it, so it is never a black box — that is the whole anti-algorithm-only pitch.

## MVP scope (smallest shippable)
1. New readiness service that reads existing biometrics + run history already in FORGE.
2. Dashboard card: score, band color, one-line why, one-line action.
3. Morning 1-tap subjective check-in (soreness/energy) feeding the score.
4. Store daily score so trends can be charted later (Body tab).

## Explicitly OUT of v1 (backlog)
- ML/personalized baselines (v1 is transparent rules; revisit after data collects).
- Auto-rewriting the training plan (v1 advises, does not edit the plan).
- Multi-device sync beyond what HealthKit already exposes.

## Fit with existing roadmap
Folds INTO the planned Phase 3 Intelligence Layer (shoe + weather rule engine, needs WEATHER_API_KEY). Same architecture: deterministic rule engine over existing data, surfaced as a Dashboard card — no new nav tab (FORGE nav is a fixed 5-tab bar). Do NOT spin a separate phase for this; bundle it.

## Open questions for Bryan
- Is HRV reliably available from your HealthKit source, or start with sleep + RHR + load + subjective only?
- Acceptable to gate GREEN/RED purely on rules for v1, or do you want a manual override toggle?

_Next step: on greenlight, this becomes the Phase 3 build spec — Codex build -> Claude Code QA -> Hermes review -> ship._

## LOCKED DECISIONS (2026-06-02, Bryan) — these override anything above
1. NO manual override of the verdict. The score is whatever the data says.
2. NO subjective check-in / manual input. Fully PASSIVE: HealthKit data in, readiness out, zero taps from the runner. (Drop the weight-15 subjective input from the scoring blend; re-normalize remaining weights.)
3. NO LLM anywhere in FORGE. AI analysis = on-device / deterministic statistical + ML models over HealthKit data (HRV trend, RHR vs baseline, sleep, acute:chronic load). No language model, no per-user API call.
4. Still SHOW the 1-2 drivers behind every verdict (e.g. RED because HRV down 22 percent and sleep 5.1h). This is transparency, not an override — it is the anti-algorithm-only differentiator.
5. Cold start: needs ~7-14 days of history for baselines. Backfill from existing Apple Watch/HealthKit history on first sync so it works immediately when history exists.

Revised inputs (re-normalized after dropping subjective): Sleep vs baseline 30, RHR vs baseline 25, HRV trend 25, acute:chronic load ratio 20. Verdict bands unchanged (GREEN 70-100, AMBER 45-69, RED 0-44).

## UI DESIGN DIRECTION (Bryan, 2026-06-02): beautiful, on-theme, SIMPLE
Mandate: beautiful but SIMPLE, and it must MATCH the existing FORGE theme — not a separate premium palette.

Use FORGE design tokens ONLY (frontend tailwind.config.js + CSS vars). NO hardcoded hex:
- Surface: bg-card on bg-base, border-subtle, rounded corners consistent with existing cards.
- Text: text-primary for the score, text-muted for labels/drivers.
- Accent: accent (gold #EAB308) / accent-dim — used for the readiness ring/arc and the GREEN-band emphasis only. Do not introduce new brand colors.
- MUST respect the dark/light toggle (ThemeContext: forge_theme, root.light class). Looks right in BOTH modes because it uses the vars.

Card anatomy (keep it to ONE clean card, not a dashboard of widgets):
1. A single circular readiness ring/arc (Whoop/Oura-style) with the 0-100 score large and centered in text-primary.
2. The verdict word (READY / EASY / REST) mapped from GREEN/AMBER/RED, colored by band.
3. One short line: the 1-2 drivers in plain language (e.g. 'HRV down 22%, slept 5.1h').
4. That is it. No clutter, no extra charts on the card. Tapping it can open the existing detailed recovery view for depth.

Band -> color: GREEN=accent gold (on-brand 'good'), AMBER=a warm amber, RED=a restrained red. Keep saturation tasteful; premium = restraint, not neon.
Motion: one subtle ring fill animation on load. Nothing flashy.

North star: looks like it was always part of FORGE, reads in under 2 seconds, beautiful through simplicity.

---

## PHASE 3 BUILD PLAN (2026-07-08, Hermes — post pre-flight)

Pre-flight finding: card + engine already shipped and prod-wired. Card matches locked UI spec; engine already emits GREEN/READY, AMBER/EASY, RED/REST bands, driver flags with reasons, and computes acute:chronic ratio. Phase 3 is a targeted reconcile+extend, NOT a rebuild. Do not recreate ReadinessCard.jsx or the band/verdict logic.

Bryan ruling 2026-07-08: ENFORCE PASSIVE-ONLY. Remove subjective/check-in sleep from the readiness scoring path. Readiness = HealthKit data only, zero taps.

### Phase 3a — Engine reconcile to locked spec (backend only)
- WHAT: Refactor backend/src/lib/healthSignals.js readiness scoring from the delta-heuristic to the locked weighted blend. Each signal maps to a 0-100 sub-score; final = Sleep 30% + RHR-vs-baseline 25% + HRV trend 25% + acute:chronic load 20%, re-normalized when a signal is missing. Enforce passive-only: drop subjective_sleep_hours / check-in inputs from the readiness path (synced HealthKit sleep only). Keep band cutoffs (GREEN>=70 READY, AMBER>=45 EASY, RED REST) and the driver-flags-with-reasons output contract that ReadinessCard + recovery.js consume — do not change the API shape (score, band, verdict, drivers[], available).
- WHY: Makes the score the transparent, auditable model in the spec; removes the shipped-code-vs-locked-spec contradiction (subjective input); keeps acute:chronic actually weighted (20%), not just displayed.
- HOW: Codex edits healthSignals.js (+ any direct helper). Preserve exported function signatures. Add/keep missing-signal re-normalization so a user with no HRV still scores on the other 3.
- GATE: 0 CRIT / 0 HIGH from Claude QA. Unit-verify each sub-score is clamped 0-100 and weights sum to 1.0 after re-normalization. Band output unchanged for representative known inputs. No subjective field referenced in the readiness path. recovery.js route response shape unchanged.

### Phase 3b — Daily-score persistence + cold-start backfill
- WHAT: (1) Persist the daily readiness score (new table readiness_scores: id, user_id, date, score, band, drivers jsonb, created_at; unique on user_id+date, idempotent upsert on compute). (2) Cold-start backfill: on first HealthKit sync / when >=7d history exists, compute and store prior days so a new Pro user sees a real score immediately.
- WHY: Unlocks Body-tab trend charting (MVP #4) and a real day-one experience (locked #5). No trend history exists today (route computes live-only).
- HOW: idempotent migration in initDb() (CREATE TABLE IF NOT EXISTS ordered before any ALTER, per the app_feedback lesson) + schema.pg.sql mirror; write-on-compute in recovery.js; backfill helper reading existing HealthKit history rows.
- GATE: 0 CRIT / 0 HIGH. Row written/upserted on compute (no dupes per day). Backfill produces >=1 stored score from >=7d history. Prod health 200 post-deploy; row-level verify on prod.

Pipeline per phase: Hermes pre-flight -> Codex build -> Claude Code QA (must execute/smoke-test) -> Hermes review verdict+diff -> ship to origin/main -> post-deploy live-verify.
