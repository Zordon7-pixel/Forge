# Claude Code QA: Forged Hybrid Lift mobility quick actions

Repo: `/Volumes/Zordon Storage /openclaw-workspace/forge-app`
Branch: `main`
Date: 2026-07-15

Read `CLAUDE.md` first. Review the current uncommitted Lift mobility diff against `HEAD`. Do not push, deploy, commit, or run EAS. This phase adds the same compact three-action surface used by Train to Lift, but its warm-up and post-lift stretch routines must be based on the active scheduled, AI, or manual strength workout.

## Intended behavior

- Lift shows `Lift Warm-Up`, `Post-Lift Stretch`, and `Lift History` quick actions without hiding the primary workout.
- The active tab's workout determines a bounded focus: chest, back, legs, shoulders, arms, core, or full body.
- Warm-up and recovery use separate relevant movement catalogs and rotate six movements without immediate repetition.
- Every catalog movement has a checked-in local image under `frontend/public/stretches`; no remote image or queued placeholder is expected.
- The existing `MovementDemo` profile-sex crop must display one male model for male profiles and one female model for female profiles, never both at once.
- The timed session retains pause, skip, next, completion, and safe return to `/log-lift`.
- Run warm-ups and run stretch sessions must remain unchanged.
- Router state is treated as untrusted input: invalid or missing Lift routine data falls back to the local full-body catalog and cannot create a crash or arbitrary redirect.
- No backend, native, dependency, or EAS changes belong in this phase.

## Required inspection

1. Trace active scheduled/AI/manual plan selection in `LogLift.jsx`, including loading, no-plan, manual target, and tab-switch cases.
2. Verify `inferLiftFocus()` handles representative exercise names and does not send upper-body users through unrelated lower-body-only routines.
3. Verify every focus/phase pool contains at least six unique image-backed movements and every referenced asset exists.
4. Confirm rotation keys are user-scoped through the existing routine helper and warm-up/recovery histories remain separate.
5. Audit `StretchSession.jsx` for empty arrays, invalid duration/image/name data, timer transitions, last-item skip, unmount timers, completion, and regression to pre/post-run behavior.
6. Confirm profile-sex behavior for explicit `*-male.png`, `*-female.png`, and paired generic images.
7. Inspect the 320px-430px layout, touch targets, overflow, labels, image framing, and bottom navigation interaction.
8. Review the complete diff for accidental backend/native/dependency changes and empty catches.

## Commands

```bash
node frontend/scripts/lift-mobility-smoke.mjs
cd frontend && npm run build
npm audit --audit-level=high
npx cap sync ios
git diff --check
git status --short
```

Run additional focused static checks as needed. Do not mutate production data.

## Deliverable

Return findings first, ordered CRITICAL/HIGH/MEDIUM/LOW with exact `file:line` evidence. Explicitly state PASS or FAIL, list every command result, identify residual device/profile gaps, and recommend whether Codex may proceed to Hermes review and Phase 4C. If you find a minimum-scope issue, fix it locally, rerun relevant gates, and list every changed file; still do not commit or push.
