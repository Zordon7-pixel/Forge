# Claude Code QA: Forged Hybrid Phase 4D private group runs

Repo: `/Volumes/Zordon Storage /openclaw-workspace/forge-app`
Branch: `main`
Date: 2026-07-15
Review range: `f326e4f4..HEAD`

Read `CLAUDE.md` and `.build-prompts/FORGED-HYBRID-PHASE-4-SOCIAL-CHALLENGES-SPEC.md` first. This is a security, privacy, ownership, location-retention, moderation, responsive-UI, and regression QA. Do not edit, commit, push, deploy, run EAS, or mutate production data.

## Intended behavior

- Group runs are private to accepted friends. Invitations reveal only broad meetup/workout details; exact meetup instructions and the private static route appear only after the athlete explicitly joins.
- Creation and friend invitations are transactional and participant capacity is enforced under lock.
- Exact meetup details and route data are removed immediately on cancellation and after the event retention deadline. List/detail responses use `Cache-Control: private, no-store`.
- Blocking any organizer or attendee revokes scheduled and recent historical access. Current and historical moderation actions use opaque membership IDs, never exposed user IDs.
- Joined athletes can mute, leave, report, or block another attendee. Owners can invite, remove, cancel, and complete.
- The planner requires a review-before-join step with clear attendee-name and exact-location disclosures.
- Group-run route state is never globally restored across accounts. Active-run persistence is bound to the authenticated user and cleared on logout or account change.
- A group run launches the existing active-run flow without a training-plan session ID and never updates or queues `/plans/my/progress`.
- Compatibility compares run type, goal, target, zone, pace, and workout structure. Missing plan data and API failure are distinct states.
- No live participant map, public discovery, native notification, or EAS change is included.

## Required inspection

1. Trace every `/api/group-runs` route for auth, accepted-friend proof, UUID handling, parameterized SQL, transaction use, capacity races, and `req.user.id` write predicates.
2. Prove nonmembers, removed members, blocked pairs, cancelled invitees, and expired invited-only viewers receive uniform 404 isolation.
3. Verify exact meetup/route material is absent before join, immediately purged on cancellation, actively purged after retention, and never cacheable by shared intermediaries.
4. Review the periodic purge for bounded batches, unref'd lifecycle, error logging, and owner-scoped updates.
5. Confirm roster payloads never expose account IDs, emails, handles, health data, or live location. Opaque membership IDs must be usable only within the correct run and authorized action.
6. Verify report/block paths remain available for the bounded historical safety window without restoring run detail access.
7. Confirm account export/deletion covers both sides of group-run ownership/membership and account deletion rolls back completely on any failed table cleanup.
8. Trace `GroupRunPanel`, `GroupRunComposer`, and `RoutePlanner` for review-before-join, disclosure copy, modal error placement, stale async state, 44px targets, focus trap, Escape close, focus restoration, and 375-430px overflow.
9. Trace `activeRunSession`, token storage, and `ActiveRun` to prove route/session data cannot cross accounts and group-run completion cannot mutate a hybrid training plan.
10. Inspect the disposable API matrix. It must refuse nonlocal targets by default, use unique accounts, clean up only those accounts in `finally`, and assert privacy headers and redaction.
11. Review the complete diff for regressions in Friends, Challenges, Today reminders, Train, Lift, active-run restore, run saving, and account deletion.

## Commands

```bash
node --check backend/src/routes/groupRuns.js
node --check backend/src/lib/groupRunRules.js
node --check backend/src/routes/socialFriends.js
node --check backend/src/routes/auth.js
node backend/scripts/friends-phase4a-smoke.js
node backend/scripts/friends-phase4a1-smoke.js
node backend/scripts/challenges-phase4b-smoke.js
node backend/scripts/challenges-phase4c-smoke.js
node backend/scripts/group-runs-phase4d-smoke.js
node backend/test/accountDeletionAtomicity.smoke.js
node frontend/test/dailyExecution.smoke.mjs
node frontend/test/runIntegrity.smoke.mjs
node frontend/test/postRunPhase0.smoke.mjs
node frontend/scripts/group-runs-phase4d-smoke.mjs
cd backend && npm run check:account-data
cd ../frontend && npm run build
npm audit --audit-level=high
npx cap sync ios
git diff --check f326e4f4..HEAD
git status --short
```

Run additional focused read-only checks as needed. Do not run the production API matrix.

## Deliverable

Return findings first, ordered CRITICAL/HIGH/MEDIUM/LOW with exact `file:line` evidence. Explicitly state `PASS` or `HOLD`; list every command result; state whether exact-location retention, block revocation, opaque actions, account deletion, user-bound active-run restore, and plan-progress isolation are safe; identify residual risks; and recommend whether Codex may proceed to Hermes review and Railway deployment.
