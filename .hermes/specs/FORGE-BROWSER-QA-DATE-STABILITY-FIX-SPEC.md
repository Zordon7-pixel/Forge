# FORGE Browser QA Date-Stability Fix Spec

## Problem
The GitHub `Forged Hybrid QA` workflow fails the Weekly Run Brief Playwright journey on Fridays and later weekdays. The test dynamically anchors to the current calendar week, places the lift at `availableIndexes[3]`, then always expects a removal control. On Friday 2026-08-14 that index is Thursday, while production correctly hides removal for past sessions through `allowSessionRemoval={selectedDay.dateISO >= today}`.

The exact failure reproduced on current main `3a37e660` on both iPhone SE and iPhone 15. The identical test passed on the same prior source SHA on Thursday and failed Friday, proving date-dependent fixture drift rather than a planner regression.

A separate `Continue without route` assertion was flaky once in GitHub but passed locally on both devices and on retry; it is not part of this repair unless new deterministic evidence identifies a root cause.

## Scope
Allowed production/test change:
- `frontend/test/e2e/authenticatedJourneys.spec.mjs`

This spec file may be committed but must not be edited by Codex.

Do not change product source, planner code, Playwright config, timeouts, retries, CI workflow, dependencies, or lockfiles.

## Required behavior
1. Keep production behavior intact: removal controls stay hidden for past sessions and visible for removable current/future sessions.
2. Make the Weekly Run Brief fixture deterministic on every weekday, including Friday through Sunday.
3. Preserve all current assertions for naming, provenance, recovery, Gear sizing, run/lift actions, watch export, and copy workout.
4. Do not weaken the assertion by deleting it, converting it to an unconditional absence check, increasing retries, or adding arbitrary sleeps/timeouts.
5. Make the fixture place the strength session on a date where the expected removal control is valid, while retaining the current-day run mission and other week content.

## Gates
- RED evidence already captured: both mobile projects fail at line 960 on current main.
- Focused journey passes on iPhone SE and iPhone 15 with retries disabled.
- Full `npm run qa:browser` passes.
- `git diff --check` passes.
- Diff is limited to this spec plus the one allowed test file.
- Independent Claude Code review confirms the test still exercises real product behavior and does not mask failures.
