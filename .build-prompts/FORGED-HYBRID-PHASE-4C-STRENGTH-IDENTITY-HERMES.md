# Hermes decision: Phase 4C strength contribution identity

Repo: `/Volumes/Zordon Storage /openclaw-workspace/forge-app`
Date: 2026-07-15

Read `CLAUDE.md`, `.build-prompts/FORGED-HYBRID-PHASE-4-SOCIAL-CHALLENGES-SPEC.md`, `backend/src/lib/challengeScoring.js`, `backend/src/routes/lifts.js`, `backend/src/routes/workouts.js`, and `frontend/src/pages/LogLift.jsx`. Do not edit files, commit, push, deploy, or run EAS.

Before Phase 4C exposes cross-user rankings, resolve the recorded ambiguity where one physical manual strength session can appear in both `workout_sessions` and legacy `lifts`. Current code also collapses every manual legacy lift on the same date to one key (`legacy-manual:${date}`), which undercounts legitimate two-a-day sessions.

Actual write-path facts:

- Current scheduled, AI, and manual Lift UI creates and completes `workout_sessions`; each completed row is a canonical first-party manual strength session.
- Device/watch imports create `lifts` with trusted `watch_sync_id`/watch provenance and replay protection.
- No current frontend POSTs to `/api/lifts`; unprovenance legacy `lifts` are old exercise-summary rows with only a local date, no session timestamp or cross-table identity.
- A date heuristic cannot determine whether a legacy row is a duplicate, an exercise within a session, or a legitimate second session.

Proposed beta contract:

1. `all_activity` strength progress counts completed `workout_sessions` as manual sessions and trusted device-recorded `lifts` as device sessions.
2. `device_only` counts only trusted device-recorded `lifts`.
3. Unprovenance legacy manual `lifts` do not count in social challenges because they cannot prove session identity. They remain in private History/analytics and are not deleted or rewritten.
4. Distinct completed `workout_sessions` and distinct replay-protected device lifts retain unique IDs, so legitimate two-a-days remain countable without date merging.
5. UI copy should state that social strength credit comes from completed in-app workouts or device-recorded sessions; old exercise-only manual logs remain private history.

This is conservative competitive-integrity behavior, but it means an old manual lift row alone will not advance a new challenge. Current users can get manual credit by completing the normal Lift flow.

Return APPROVE, APPROVE WITH CHANGES, or REJECT. State whether this is the correct beta model, identify any must-fix privacy/fairness issue, and separate future identity-linking improvements from the Phase 4C ship decision.
