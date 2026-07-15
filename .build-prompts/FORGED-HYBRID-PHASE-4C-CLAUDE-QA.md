# Claude Code QA: Forged Hybrid Phase 4C leaderboard and beta polish

Repo: `/Volumes/Zordon Storage /openclaw-workspace/forge-app`
Branch: `main`
Date: 2026-07-15
Base: committed Phase 4B at `70a8c1c8`; review the current uncommitted Phase 4C diff on top of `34bd27a3`.

Read `CLAUDE.md` and `.build-prompts/FORGED-HYBRID-PHASE-4-SOCIAL-CHALLENGES-SPEC.md` first. This is a security, privacy, scoring-identity, moderation, accessibility, responsive-UI, and regression QA. Do not commit, push, deploy, run EAS, or mutate production data. Do not broaden into public challenges, feeds, prizes, group runs, native notifications, or location sharing.

## Intended behavior

- Challenge detail loads the leaderboard for joined members only and keeps detail usable if the leaderboard request fails.
- Tied scores share rank and render as `T<rank>`. Blocked shared members expose rank only; no identity, percentage, source, or contribution data.
- Visible rows show bounded progress plus `In-app` and/or `Device` source labels derived from qualifying contributions.
- Recent updates expose only participant display name, date, run distance/time or one strength session, and source label. No routes, exact times, heart rate, weights, sets, reps, notes, account IDs, or hidden-member details.
- `all_activity` strength credit counts completed canonical `workout_sessions` and trusted device `lifts`. `device_only` counts trusted device lifts only. Unprovenanced legacy manual `lifts` stay in private History but never score socially.
- Distinct canonical session/import IDs preserve legitimate same-day two-a-days. Known beta limitation is documented: an in-app session independently re-imported from a watch can still double-count until both sources share an identity.
- Owners remove another member via an opaque `user_challenges.id` membership key. The backend first resolves the target under owner proof in a transaction, then updates with `id`, `challenge_id`, and target `user_id` guards. No target user ID is returned to the client.
- Joined non-owners can report a challenge. The server derives the owner subject from the challenge, scopes the viewer to joined membership, bounds/cleans note text, rate-limits per authenticated user, and stores `context_type='challenge'`.
- Loading, retry, empty, no-activity, muted, report, leave, cancel, invite, owner-removal, and success/error states remain usable at 375x812, 390x844, and 430x932.
- Challenge source-policy copy explicitly explains eligible strength credit so an old legacy lift that does not move progress is not mistaken for a bug.
- Existing Friends, Challenge creation/join/leave, Today, Train, Lift, Body, More, beta access, Health sync, and active-run flows do not regress. No native project files should change.

## Required inspection

1. Trace `GET /api/challenges/:id/leaderboard`, `PATCH /api/challenges/:id` remove-member, and `POST /api/challenges/:id/report` for auth, membership/owner proof, blocked-row masking, parameterized SQL, transaction behavior, race windows, rate limits, and 404 isolation.
2. Verify the opaque membership key cannot be used cross-challenge, by a non-owner, against the owner, or after membership state changes. Check that every UPDATE includes the target `user_id` guard as required by `CLAUDE.md`.
3. Confirm challenge reports cannot target an arbitrary account, cannot be submitted by the owner against self, and preserve only the existing anonymized moderation record after deletion.
4. Prove `challengeScoring.js` excludes all unprovenanced legacy lift rows, counts two completed in-app sessions on one day twice, counts two distinct trusted device sessions on one day twice, and keeps `device_only` behavior correct.
5. Review the residual in-app-plus-watch cross-source double-count limitation. It is allowed only if accurately documented and no UI claims perfect deduplication.
6. Inspect leaderboard payloads for leaks: user IDs, emails, handles, friendship IDs, routes, HR, notes, exercise names, weights, sets/reps, hidden-user progress, or excessive contribution history.
7. Inspect `ChallengePanel.jsx` for stale state when switching/closing challenges, failed detail versus failed leaderboard requests, duplicate submissions, missing console error context, accessible dialogs/labels, localization, stable keys, text overflow, and 40px+ controls.
8. Confirm tied-rank rendering, zero progress, 100% progress, long names, a masked owner-removable row, single/25-member boards, all five templates, and run-only/lift-only/hybrid source copy fit 375-430px.
9. Audit `challenges-phase4c-api-matrix.js`: it must refuse production by default, use disposable unique accounts, delete only those accounts in `finally`, leave no credentials in source, and assert nonmember concealment after removal.
10. Inspect the complete diff for regressions outside Phase 4C. Do not revisit the already QA-approved Lift mobility commit unless the current diff breaks it.

## Commands

```bash
node --check backend/src/lib/challengeScoring.js
node --check backend/src/routes/challenges.js
node --check backend/scripts/challenges-phase4c-api-matrix.js
node backend/scripts/friends-phase4a-smoke.js
node backend/scripts/friends-phase4a1-smoke.js
node backend/scripts/challenges-phase4b-smoke.js
node backend/scripts/challenges-phase4c-smoke.js
node backend/scripts/challenges-phase4c-api-matrix.js
cd backend && npm run check:account-data
cd ../frontend && npm run build
npm audit --audit-level=high
npx cap sync ios
git diff --check
git status --short
```

Run additional focused static/pure-function checks as needed. The local three-account API matrix is allowed; production mutation is not.

## Deliverable

Return findings first, ordered CRITICAL/HIGH/MEDIUM/LOW with exact `file:line` evidence. Explicitly state PASS or FAIL; list every command result; state whether masked rows, opaque owner actions, strength identity, reports, and cleanup are safe; identify residual risks; and recommend whether Codex may proceed to Hermes review and Railway deployment. For a minimum-scope issue, fix it locally, rerun the relevant gates, and list every changed file. Do not commit or push.
