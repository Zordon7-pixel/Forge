# Hermes re-review: Forged Hybrid Lift mobility fixes

Repo: `/Volumes/Zordon Storage /openclaw-workspace/forge-app`
Branch: `main`
Date: 2026-07-15

Read `CLAUDE.md`, `.build-prompts/FORGED-HYBRID-LIFT-MOBILITY-HERMES-REVIEW.md`, and the current uncommitted diff. Do not edit, commit, push, deploy, or run EAS.

Your prior BLOCK had three actionable concerns. Codex addressed them as follows:

1. Every paired image used by the Lift mobility catalog is now explicitly registered in `MovementDemo.jsx` with `cropToSex: true` and calibrated `maleSide: 'right'`. The broad heuristic was removed: an unregistered `/stretches/` image is no longer assumed paired or cropped.
2. Codex visually inspected every newly surfaced `.webp`. All are 1200x800 paired images with one female model on the left and one male model on the right. A 390x844 browser pass on `lateral-lunge-hold.webp` confirmed the male profile renders only the right-side male model; DOM metadata showed `data-model-sex="male"`, `width: 200%`, `right: 0px`. Earlier passes confirmed `worlds-greatest.webp` and the explicit hip-flexor image. The symmetric left crop is used for female profiles.
3. Quick Actions moved below the active workout prescription and its Start/Copy controls, matching the Train pattern where actions follow the primary information.
4. `inferLiftFocus()` now removes `single-arm`/`one-arm` modifiers before arm scoring; the smoke includes `Single-Arm Dumbbell Row -> back`.
5. The smallest focus pools were expanded beyond six where relevant so rotation changes content, not only order.

Host verification is green:

- `node frontend/scripts/lift-mobility-smoke.mjs`
- `cd frontend && npm run build`
- `npm audit --audit-level=high` (0 vulnerabilities)
- `npx cap sync ios`
- `git diff --check`
- mobile browser flow for both actions, pause/skip controls, image load, and console (no app errors)

Return APPROVE or BLOCK, exact file:line findings, and only must-fix items that remain before Phase 4C. Keep optional later work separate.
