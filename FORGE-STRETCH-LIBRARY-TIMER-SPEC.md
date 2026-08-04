# Forged Hybrid Stretch Variety + Guided Timer Implementation Plan

> **Implementer:** Codex. Read repo `CLAUDE.md` and `QA-CHECKLIST.md` before editing. Build on a fresh branch from the latest `origin/main`. Do not push to `main`; leave final shipping to Hermes.

**Goal:** Give runners materially more injury-prevention mobility variety, rotate routines so consecutive sessions do not feel duplicated, and provide a visible, reliable countdown for every duration-based movement across both Forged Hybrid stretch flows.

**Product reference:** Bend demonstrates useful product patterns: a broad exercise library, short and long routines, focused body-area routines, and simple guided timing. Use those patterns only as inspiration. Do not copy Bend text, artwork, routine composition, branding, or proprietary content. All movement names must be common exercise terms; all cues and routine logic must be original to Forged Hybrid.

**Architecture:** Preserve the existing deterministic local/backend stretch catalogs and rotation helpers. Expand the runner-specific pools using only existing local `/stretches/` artwork that honestly matches the movement. Consolidate timer behavior behind one shared guided-timer state machine used by both `Stretches.jsx` and `StretchSession.jsx`, while preserving each page's visual shell. No AI, schema, native plugin, background task, or paid service.

**Safety model:**
- Pre-run remains dynamic mobility only. Do not add long static holds before a run.
- Post-run/recovery may use static holds.
- Cues must say controlled/gentle range, no bouncing, and stop for sharp pain, numbness, instability, or altered gait.
- Do not claim stretching guarantees injury prevention or treats an injury.
- Active injury flows remain controlled by existing injury/readiness logic; this feature must not override a safety hold.

---

# Baseline findings to preserve

1. `frontend/src/data/stretches.js` currently has 10 pre-run and 12 post-run movements, with six selected per session.
2. `backend/src/routes/stretches.js` has five category pools with eight movements each and returns five to seven at random.
3. `frontend/src/lib/routineRotation.js` already prefers unseen IDs from the immediately remembered routine, but it does not preserve a useful multi-session recency history.
4. `frontend/src/pages/StretchSession.jsx` has a countdown and per-side handling, but the timer behavior is page-local and lacks a restart control.
5. `frontend/src/pages/Stretches.jsx` has a second independent countdown implementation. It auto-starts, has no pause/resume/restart, and treats an `each side` duration as one hold rather than two timed sides.
6. Duration-based dynamic movements and static holds must always display a clock. Rep labels remain supplemental; they never replace the clock when `duration` exists.

---

# Phase A — Expand runner mobility catalogs and strengthen rotation

## A1. Expand the runner pools

**Modify:**
- `frontend/src/data/stretches.js`
- `frontend/src/data/liftMobility.js` only where a genuinely missing runner-relevant movement can reuse an honest existing asset
- `backend/src/routes/stretches.js`

Requirements:

1. Increase pre-run dynamic pool from 10 to at least 16 movements.
2. Increase post-run/recovery pool from 12 to at least 20 movements.
3. Increase every backend targeted category from 8 to at least 12 movements, or refactor common original movement definitions safely so each returned category still exposes at least 12 unique IDs.
4. Favor runner-relevant areas: ankles, calves/soleus, quads, hamstrings, hip flexors, glutes/piriformis, adductors, T-spine, and gentle lower-back mobility.
5. Use only existing local assets under `frontend/public/stretches/`. Do not add remote image URLs, placeholders, or misleading images.
6. Every movement requires:
   - stable unique ID;
   - common movement name;
   - numeric duration from 20 to 60 seconds;
   - original concise cue;
   - correct dynamic/static/mobility type;
   - accurate body area;
   - explicit side semantics when unilateral.
7. A movement may appear in more than one focus pool only through one canonical definition; do not duplicate drifting cue/duration objects.
8. Keep pre-run routines dynamic. Any static hold added to post-run must not appear in pre-run.

## A2. Multi-session rotation

**Modify:**
- `frontend/src/lib/routineRotation.js`
- `backend/src/routes/stretches.js` only if request parsing/selection needs a bounded recent-ID list

Requirements:

1. Keep rotation user-scoped and scope-scoped in local storage.
2. Store bounded recency across at least the previous three routines, not only the last routine.
3. The selector must:
   - deduplicate malformed catalog IDs;
   - prefer never/recently-unseen movements;
   - avoid every movement from the immediately previous routine whenever pool size permits;
   - never return duplicate IDs inside one routine;
   - never return the exact same ordered routine twice when at least one alternative exists;
   - clamp invalid/oversized counts safely;
   - degrade deterministically when the requested count is close to the pool size.
4. Storage parsing must accept the current legacy flat-ID array and migrate it in memory without breaking existing users.
5. Server query parsing remains bounded, validates IDs, and never trusts arbitrary objects.

## A3. More useful routine size

**Modify:**
- `frontend/src/pages/Stretches.jsx`
- `backend/src/routes/stretches.js`

Requirements:

1. Replace random five-to-seven sizing with an explicit bounded choice:
   - Quick Reset: 5 movements;
   - Daily Runner: 8 movements, default;
   - Full Mobility: 12 movements.
2. Show estimated total time derived from actual durations and side counts.
3. Send `count` to the endpoint as an integer. Backend accepts only 5, 8, or 12 and defaults to 8.
4. If a focused pool cannot safely return the requested count, clamp to its unique catalog size and tell the UI the actual count. Never duplicate a movement to fill space.
5. Keep controls mobile-friendly at 44px minimum.

## Phase A tests

**Modify/create within a maximum of 10 files for this Codex session:**
- `frontend/test/stretchPoolAssets.smoke.mjs`
- `frontend/test/routineRotation.smoke.mjs`
- `backend/test/stretchRotation.smoke.js` (create if no equivalent exists)

Required executable assertions:

1. Minimum pool sizes pass.
2. IDs are unique inside each canonical pool.
3. Every image resolves to a local existing asset.
4. Every duration is bounded and every unilateral static hold is marked for two sides.
5. Pre-run contains no static holds.
6. Three consecutive seeded routines maximize unseen items and are not identical.
7. Legacy flat local-storage history remains readable.
8. Malformed history and malformed server exclude/count input are bounded safely.
9. Count 5/8/12 behavior returns the expected actual count without duplicates.

**Phase A gate:**
```bash
node frontend/test/stretchPoolAssets.smoke.mjs
node frontend/test/routineRotation.smoke.mjs
node backend/test/stretchRotation.smoke.js
npm run build --prefix frontend
git diff --check
```

---

# Phase B — One guided countdown contract across both stretch flows

## B1. Shared timer model/component

**Create:**
- `frontend/src/components/GuidedMovementTimer.jsx`

**Modify:**
- `frontend/src/lib/stretchTimer.js`
- `frontend/src/pages/StretchSession.jsx`
- `frontend/src/pages/Stretches.jsx`

Requirements:

1. One shared timer contract powers both pages. Remove or stop using the duplicate page-local interval implementation.
2. For every movement with numeric `duration`, render a visible `MM:SS` countdown.
3. Initial state is ready and does not silently consume time while the athlete reads the cue. Provide `Start`.
4. Controls:
   - Start;
   - Pause;
   - Resume;
   - Restart current side/movement;
   - Skip;
   - Previous where the parent flow supports it.
5. Unilateral static holds run the full duration on left, show a clear three-second switch-sides transition, then run the full duration on right.
6. Dynamic movements labeled `each side` remain one alternating timed block unless explicitly modeled as two-sided static holds.
7. When the app/tab becomes hidden, pause rather than silently completing movements in the background.
8. On movement change, clear every interval/timeout and reset side/timer state. No double intervals after rapid pause/resume/skip navigation.
9. Completion reaches zero once, advances once, and never produces a negative display.
10. `aria-live=polite` announces ready, paused, switch sides, and complete states without announcing every second.
11. Controls are keyboard accessible and at least 44px tall. Timer remains visible at 320px width and above the bottom navigation/safe area.
12. Preserve existing completion destinations and plan/run/lift credit behavior. Timer changes must not mark a workout complete by themselves.
13. No native timer plugin, wake lock, background execution, sound dependency, or notification permission.

## B2. Original safety copy

Add one compact note in both guided flows:

`Move in a controlled, pain-free range. Stop for sharp pain, numbness, instability, or a change in your stride.`

Do not repeat this on every movement if one persistent session-level note is clearer.

## Phase B tests

**Modify/create within a maximum of 10 files for this Codex session:**
- `frontend/test/stretchSessionTimer.smoke.mjs`
- `frontend/test/stretchActionBar.smoke.mjs`
- `frontend/test/guidedMovementTimer.behavior.mjs` (create; use fake timers or an extracted pure reducer/state model rather than brittle source-only regex for the core state machine)

Required executable assertions:

1. Ready state shows full duration and does not decrement before Start.
2. Start decrements once per second.
3. Pause freezes; Resume continues; Restart restores current side duration.
4. Zero emits one completion transition, never negative.
5. Unilateral static hold performs left -> switch -> right -> complete.
6. Dynamic alternating movement does not get doubled.
7. Skip and Previous clear pending transitions.
8. Visibility pause is wired.
9. Both page flows import/use the shared timer instead of independent countdown intervals.
10. 320px/safe-area action bar constraints remain present.

**Phase B gate:**
```bash
node frontend/test/stretchSessionTimer.smoke.mjs
node frontend/test/stretchActionBar.smoke.mjs
node frontend/test/guidedMovementTimer.behavior.mjs
npm run build --prefix frontend
git diff --check
```

---

# Final regression and QA gate

Run at minimum:

```bash
node frontend/test/stretchPoolAssets.smoke.mjs
node frontend/test/routineRotation.smoke.mjs
node frontend/test/stretchSessionTimer.smoke.mjs
node frontend/test/stretchActionBar.smoke.mjs
node frontend/test/movementDemoCue.smoke.mjs
node frontend/test/guidedMovementTimer.behavior.mjs
node backend/test/stretchRotation.smoke.js
npm run build --prefix frontend
node --check backend/src/routes/stretches.js
git diff --check
```

Independent Claude Code OAuth/Opus QA must verify:

1. No static pre-run routine regression.
2. Rotation truly changes consecutive routines and remains bounded/user-scoped.
3. Every duration-bearing movement in both flows has a working visible countdown.
4. Side semantics are correct and no hold is accidentally half-duration.
5. No interval leak/double advancement/background completion.
6. Local assets exist and honestly correspond to movement names.
7. No copied Bend prose/assets/routine composition.
8. No AI, schema, auth, native, secret, or unrelated changes.
9. 0 CRITICAL and 0 unresolved HIGH findings.

---

# Release and proof

This is web/frontend/backend content served remotely by Railway to the existing Capacitor shell. No native plugin or new TestFlight build is required.

Before shipping:

1. Each Codex session stays at or below 10 changed files.
2. Commit only intended files, run commit guard, and prove clean status.
3. Push feature branch before independent QA.
4. Rebase onto current `origin/main` if it advanced; rerun final QA on integrated HEAD if reviewed files overlap.
5. Non-force push reviewed HEAD to `main`, then prove `git ls-remote origin main` equals reviewed HEAD.
6. Verify Railway health and deployed asset.
7. Capture comparable running-app screenshots:
   - BEFORE: existing short/repetitive routine and timer gap from base SHA;
   - AFTER: Daily Runner routine-size choice and a visibly different consecutive routine;
   - AFTER: timer Ready/Start state;
   - AFTER: active MM:SS countdown with Pause and Restart;
   - AFTER: switch-sides state for a unilateral static hold.
8. Status language: `shipped — awaiting physical-device verification` until Bryan confirms behavior in the latest live TestFlight shell.
