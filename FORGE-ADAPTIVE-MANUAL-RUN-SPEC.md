# FORGE ADAPTIVE MANUAL RUN COMPLETION — CODEX IMPLEMENTATION SPEC

## Goal
Make Forge adaptive without forcing unnecessary friction: a manually entered run may be an athlete running by feel or following a friend/external training plan, so saving it must not require a post-run check-in.

## Product contract
1. **Live app-tracked run:** keep the immediate post-run check-in. Pain, energy, and RPE can protect the next 24–72 hours of training.
2. **Manual run entry:** save successfully and navigate directly to the run recap/details. Do not open or require `PostRunCheckIn` as part of completion.
3. **Imported/provider run:** continue to sync without interruption or mandatory check-in.
4. Manual and imported recap/details must keep an optional **Add how you felt** action so the athlete can add retrospective pain/energy/RPE when useful.

## Adaptation truth
- Manual runs must still affect deterministic workload, recovery, compliance context, and future plan adaptation using their factual saved metrics.
- Do not invent pain, energy, RPE, mood, or AI coaching when those answers were not provided.
- Optional retrospective answers may influence coaching only after they are durably saved.
- Do not assume a manual run completed a scheduled Forge session. A run performed by feel or from a friend/external plan remains unplanned/external unless an explicit existing session link says otherwise.

## Existing implementation gate
- Audit current save/navigation paths for manual run entry, live tracked runs, offline/live completion recovery, RunRecap, and imports.
- Reuse explicit run provenance/source fields. Do not infer manual provenance from missing metrics.
- `RunRecap.jsx` already exposes `PostRunCheckIn`; preserve it as optional for manual/imported runs rather than deleting it globally.
- `ActiveRun.jsx` is the live tracked path and must retain required immediate check-in behavior.

## Scope / constraints
- Maximum 10 files.
- Prefer a small provenance-aware completion helper plus executable tests over scattered route checks.
- No schema/native plugin changes unless strictly necessary; stop and report rather than expanding scope.
- Preserve offline queue/recovery, exact run ID routing, plan-session completion integrity, and one-time coaching behavior.
- Do not touch unrelated untracked route/Strava spec files.
- Do not commit or push; Hermes owns commit/QA/ship.

## Required executable QA matrix
1. Manual run save → direct recap → no mandatory check-in → optional Add how you felt remains available.
2. Live tracked run finish → immediate post-run check-in still required → durable answers → recap.
3. Imported run → no interruption → optional retrospective action remains available.
4. Manual external/unplanned run does not mark an unrelated Forge calendar session complete.
5. Missing subjective answers remain null/unknown and do not trigger fabricated coaching.

## Gates
- Run focused manual/live/imported completion tests.
- Run relevant run recap, provenance, daily execution/compliance, and offline recovery tests.
- `cd frontend && npm run build`
- `git diff --check`
- Report root cause, files changed, exact test results, and confirm frontend-only/no TestFlight rebuild if true.
