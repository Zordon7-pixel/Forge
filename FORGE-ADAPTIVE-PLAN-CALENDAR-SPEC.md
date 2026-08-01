# FORGE ADAPTIVE PLAN + CALENDAR — CODEX IMPLEMENTATION SPEC

> Origin: Runna teardown (2026-07-31). Runna ships a legible but FROZEN plan: a fixed
> weekly volume ramp (e.g. 25.6mi -> 28.0mi, +2.4mi/wk) baked in weeks ahead, distance-only,
> with "skip" as the only adaptation lever. Forge moat = same clean surface, but the ramp
> and daily load FLEX to recovery, and effort is HR-true, not distance-guessed.

## Existing implementation gate (DO NOT REBUILD)
- Day/session adaptation exists: backend/src/lib/adaptationEngine.js (1,179 lines).
- HR-zone calibration exists: user_hr_profile + zoneForHr (FORGE-ZONE-CALIBRATION-SPEC.md).
- Recovery readiness exists: healthSignals.js (1-99) + recovery.js.
- codex/forge-manual-run-adaptive is IN-FLIGHT on adaptationEngine.js + plans.js.
  DISPATCH SEQUENCES BEHIND that branch merging to origin/main. Never open a 2nd agent on
  adaptationEngine.js / plans.js while that branch is unmerged.
- This spec adds week-macro logic + effort surfacing + equipment substitution + calendar UI
  as NEW modules consuming existing engines. Extend, never duplicate.

## Deterministic rule (NO LLM on the number)
Ramp/load/effort decisions are deterministic rules from data (mileage history, ACWR,
readiness, HR zones). LLM only for the qualitative coach blurb, never the ramp/effort number.

---

## Phase 1 - Weekly Ramp Gate  [NEW: backend/src/lib/weeklyRampEngine.js]
WHAT: Decide ADVANCE / HOLD / DELOAD for next week's target volume.
WHY:  Runna pre-commits the ramp regardless of how the week felt. Injury risk lives in blind ramps.
HOW:  Input last N weeks mileage (runHistory) + planned next-week volume + ACWR (7d/28d) + readiness trend.
      ACWR>1.5 OR readiness RED-trend -> DELOAD (<=0.9x current).
      ACWR 1.3-1.5 OR flat/declining readiness -> HOLD (==current).
      ACWR<1.3 AND readiness stable/up -> ADVANCE (allow ramp, cap +10%/wk).
      Output {decision,targetMiles,reason[],acwr,drivers[]}. Pure function, no I/O.
GATE: node --check; unit tests each branch + 10% cap + empty-history passthrough (byte-identical today). Claude QA on math.

## Phase 2 - HR-true effort on plan sessions  [CONSUME existing zoneForHr]
WHAT: Attach {targetZone,targetBpmRange,effortLabel} to each dated run session.
WHY:  Runna calendar is distance-only; "easy" is a guess. Bryan's easy 152-166bpm is actually Z3-Z4.
HOW:  Plan-serialization helper using zoneForHr/user_hr_profile. No profile -> existing crude label (byte-identical). Surface bpm range in session detail + calendar chip.
GATE: node --check; unit test calibrated vs no-profile.

## Phase 3 - Equipment-aware strength adjunct  [NEW: backend/src/lib/strengthAdjunct.js]
WHAT: User equipment profile + deterministic movement substitution to owned gear.
WHY:  Runna strength needs 6 gym items or skip. Injury-prevention strength must always be doable.
HOW:  Equipment enum (bodyweight always true). Rule table maps each movement -> ordered sub chain down to bodyweight. Missing gear -> highest available equiv -> bodyweight. Annotate session + "adjusted for your gear".
GATE: node --check; unit tests full-gym unchanged / bodyweight-only all-sub / partial-gear correct.

## Phase 4 - Adaptive Plan Calendar UI  [FRONTEND]
WHAT: Calendar view mirroring Runna's layout + adaptation surfacing.
WHY:  Steal what Runna nailed (week-total badge, color legend, 2-slot days); add readiness-swap + HR chips + ramp banner.
HOW:  Week card: WEEK n badge, week-total miles, up to 2 slots/day, left-border color legend (long/easy/interval/speed/strength). Run chip shows targetBpmRange (P2); strength chip shows "adjusted" flag (P3). Week header shows P1 decision + 1-line reason. Readiness-swapped session shows "adjusted for recovery" marker. Premium "dope not cheap" styling.
GATE: build passes; Claude QA with BEFORE/AFTER live screenshots (no screenshots = not done).

---

## Scope / constraints
- Frontend loads remotely from Railway; P2/P3/P4 go live on deploy (no new TestFlight). No native changes.
- Premium-gate only the coach blurb; ramp/effort/substitution logic is free + deterministic.
- No-profile / no-history users byte-identical to today (fallbacks everywhere).

## Gates
Per phase: node --check + unit smoke (Tier-0). Tier-1 Claude QA on P1 (math) + P4 (UI).
Loop: Codex build -> Claude QA -> Hermes review verdict+diff -> ship origin/main -> live verify.
Dispatch ONLY after codex/forge-manual-run-adaptive merges (file-scope safety).
