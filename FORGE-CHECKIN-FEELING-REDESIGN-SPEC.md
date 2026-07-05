# FORGE Check-In "How Are You Feeling" Redesign — BUILD SPEC
_Owner: Bryan • Hermes has the wheel • 2026-06-11 • Source of truth for this build_

## North star
Replace the single 5-face mood scale with a clean, premium, athlete-first check-in that (a) asks only what sensors can't see, and (b) shows the workout mutate live as you tap. Clean, beautiful, fast. No cartoon faces.

## Locked design decisions (Hermes)
- **Two axes, not one mood:** LEGS (physical: Fresh / Okay / Heavy) + DRIVE (mental: Fired up / Okay / Flat). 3 levels each, stored 1-3 (3=best/Fresh-Fired, 1=worst/Heavy-Flat).
- **Imageless, premium:** segmented pill controls, readiness accent color, subtle motion on select. Drop all /checkin/*.png. (Reactive silhouette/energy visual = deferred polish, Phase 4.)
- **Live consequence preview (two-way):** as the athlete taps, a card under the inputs updates in real time — e.g. "Today: Tempo 5mi -> Easy 30 (legs heavy)." Submit just commits it.
- **Backward compatible:** legacy single `feeling` (1-5) stays derivable from legs+drive so old readiness/history keep working; old rows (feeling, no legs/drive) still compute.

## Current wiring (verified 2026-06-11)
- FE `frontend/src/pages/DailyCheckIn.jsx`: `feeling` 1-5 state + FEELINGS PNG scale; submit POST `/checkin` {feeling,time_available,life_flags,sleep_hours}; directive shown only AFTER submit.
- BE `backend/src/routes/checkin.js`: validateCheckinPayload (feeling 1-5 int required); daily_checkins cols feeling/time_available/sleep_hours/life_flags; deriveAction->buildPatch->checkin_overrides; buildDirective->headline+drivers; feelingLabels[1..5].
- BE `backend/src/lib/checkinOverride.js`: deriveAction/buildPatch/buildDirective key off `feeling` thresholds.
- BE `backend/src/lib/healthSignals.js`: consumes subjective check-in feeling.
- Frontend is REMOTE-loaded from Railway -> UI ships live to existing TestFlight on deploy, no new native build.

---

## Phase 1 — Backend data + engine (instant Railway)
**WHAT:** Add `legs` + `drive` (INT 1-3, nullable) to daily_checkins (schema.pg.sql + db/index.js idempotent ALTER). Extend validateCheckinPayload to accept legs+drive (1-3 ints); make `feeling` OPTIONAL — when legs+drive present, derive feeling (1-5) from them; when only legacy feeling present, keep working. Extend deriveAction/buildPatch/buildDirective to use LEGS as the primary physical driver (cut/sub volume) and DRIVE as the mental modifier (intensity ceiling + directive tone). Extend healthSignals subjective input to read legs+drive (fallback to feeling).
**WHY:** The engine must actually consume the new axes or the redesign is theater.
**HOW:** derive feeling = clamp(round(((legs+drive)/6)*4 + 1), 1, 5). LEGS<=1 => force recovery_swap/shorten; DRIVE<=1 => cap intensity + supportive tone; both high => allow as-prescribed. Keep all existing life_flags + time_available logic. user_id-scoped writes only.
**GATE:** node --check; harness EXECUTES deriveAction for (legs,drive) grid {1,2,3}x{1,2,3} + legacy feeling-only row, asserts: legs=1 -> shortened/rest patch; drive=1 -> intensity capped + supportive directive; legacy feeling row still derives an action; derived feeling matches table. 0 CRIT/0 HIGH.

## Phase 2 — Preview endpoint (instant Railway)
**WHAT:** New `POST /checkin/preview` (auth) — runs deriveAction+buildPatch+buildDirective for given {legs,drive,time_available,life_flags,sleep_hours} and returns {headline,adjustment,drivers} WITHOUT writing daily_checkins or checkin_overrides. Refactor the compute block shared by POST /checkin and /checkin/preview into one pure helper.
**WHY:** Powers the live two-way preview without persisting partial state.
**HOW:** Extract computeDirective(checkin, todayDay) used by both routes; preview path skips all dbRun INSERT/UPDATE. Validate same as checkin but tolerate missing fields (preview can run on partial input).
**GATE:** node --check; EXECUTE: call preview handler logic with sample input -> returns directive; confirm NO INSERT/UPDATE on daily_checkins/checkin_overrides in preview path (grep + code review). 0 CRIT/0 HIGH.

## Phase 3 — Frontend redesign (instant Railway frontend; live in current TestFlight on reload)
**WHAT:** Replace the FEELINGS PNG 5-scale in DailyCheckIn.jsx with two segmented pill controls: LEGS (Fresh/Okay/Heavy) + DRIVE (Fired up/Okay/Flat). Imageless, premium: accent border+glow on select, dimmed unselected, smooth transition, large tap targets, athlete-clear labels + 1-line helper. Add a live PREVIEW card below that debounced-calls /checkin/preview on each change and renders "Today -> [adjusted headline]" + 1-2 driver chips. Submit posts {legs,drive,time_available,life_flags,sleep_hours}. Remove PNG imports + the feelingErrorRef single-field error; validate legs+drive selected. Keep time_available + life_flags + sleep UI.
**WHY:** The visible redesign Bryan asked for — clean, beautiful, mutation made tangible.
**HOW:** Segmented control component (reuse styling tokens var(--accent)/(--accent-dim)/(--bg-input)); debounce preview ~250ms; graceful skeleton/empty state before first pick; a11y (role=button, aria-pressed). No layout shift jank.
**GATE:** npm build passes; live preview updates on tap; submit mutates plan (matches non-preview result); no PNG 404s; looks clean on iPhone width (<=480). 0 CRIT/0 HIGH.

## Phase 4 (DEFERRED polish) — reactive visual + micro-animations
Single runner-silhouette/energy-bar that shifts posture/fill with the combined legs+drive state; spring micro-animations on segment select; haptic on native. Not in this build.

## Pipeline (every phase)
Hermes pre-flight -> Codex build -> Claude Code QA (must EXECUTE) -> Hermes review verdict+diff -> ship to main + Railway live-verify. Ship gate: 0 CRITICAL + 0 unresolved HIGH; MED/LOW -> named backlog.
