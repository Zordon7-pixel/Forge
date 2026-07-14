# Claude Code QA: Forged Hybrid Final Testing Phase 2

Audit the current `codex/forged-hybrid-final-testing` HEAD in:

`/Users/zordon/.codex/worktrees/forged-hybrid-final-testing`

Base for this phase is Phase 1 commit `ae47431a`. This is a read-only QA pass. Do not edit files, push, deploy, or run EAS.

## Phase 2 scope

Phase 2 adds a guarded synthetic-account production smoke and two minimum-scope fixes found during computer-use testing:

1. `backend/src/routes/auth.js`
   - Registration now applies the existing `emailRegex` at the backend boundary after normalization.
   - Malformed direct API registrations must return HTTP 400 before any account is inserted.
2. `backend/scripts/final-beta-api-smoke.js`
   - Refuses to run unless `FORGE_LIVE_MUTATION_TEST=1` and `FORGE_API_BASE` are explicitly set.
   - Creates only uniquely named synthetic accounts and deletes them in `finally`.
   - Covers login, no-auth protection, profile validation/readback, custom HR zones, health metrics, dropped sleep signaling, check-in validation, Apple Health run/walk classification and deduplication, run/lift/workout ownership, races, gear, injuries, feedback, export, CRUD deletion, and account deletion.
   - `FORGE_EXPECT_EMAIL_GUARD=0` only skips the new release guard when exercising the pre-fix production deployment. The default requires it.
3. `frontend/src/components/StrengthWorkoutRecommendation.jsx`
   - Sparse/legacy strength plans with no exercises now show a direct explanation instead of a blank Workout section.
   - Start, watch delivery, and manual-copy controls must not imply that an empty workout is executable.
   - Existing populated workout rendering, text scaling, expansion, focus trap, start, watch, and copy behavior must remain unchanged.
4. `frontend/src/components/MovementDemo.jsx`
   - Follow-up to the first QA pass: exact stretch names must no longer fall through to materially wrong or plane/position-mismatched form photos.
   - Sumo Squat Hold must not use the loaded squat photo; Overhead Tricep Stretch must not use cable pushdown; Lateral Lunge Hold must not use walking lunges; Kneeling Quad Stretch must not use standing quad.
   - Until exact assets exist, these four movements should use the honest placeholder and retain their text cue.

## Evidence already collected

Production URL: `https://forge-production-773f.up.railway.app`

Pre-fix production smoke (email-guard check intentionally skipped until deployment):

```bash
FORGE_LIVE_MUTATION_TEST=1 \
FORGE_EXPECT_EMAIL_GUARD=0 \
FORGE_API_BASE=https://forge-production-773f.up.railway.app \
node backend/scripts/final-beta-api-smoke.js
```

Result: PASS, 16 workflow groups. Both synthetic accounts were deleted. No personal account data was mutated.

Computer-use at 390x844 and additional responsive route crawls at 430x932 and 375x812 verified:

- no horizontal overflow or broken images across the core route matrix;
- feedback issue/feature modes, draft entry, and dismissal;
- Run Hub links and recent-run snapshot;
- lift recommendation expand and 100% -> 115% text scaling;
- Apple Health browser fallback message;
- Settings device/status presentation and dark/light toggle restored to dark;
- History W/All range filtering;
- warm-up Next and Skip behavior;
- stretch category selection and movement controls.

Toolchain completed:

- `node --check backend/src/routes/auth.js backend/scripts/final-beta-api-smoke.js` — pass
- `cd frontend && npm run build` — pass
- `cd frontend && npm audit --audit-level=high` — 0 vulnerabilities
- `cd backend && npm run check:account-data` — 47 user-owned tables
- `cd frontend && npx cap sync ios` — pass, 2 plugins

## Required review

1. Read `CLAUDE.md` first and inspect the complete Phase 2 diff from `ae47431a`.
2. Verify registration cannot create an account before the malformed-email rejection.
3. Review the smoke for any path that could touch a non-synthetic account, leave data behind, expose a credential, consume meaningful AI quota, or omit cleanup after an assertion/network failure.
4. Verify every cross-user mutation expects 404/401 and that the tested route implementation is scoped by `req.user.id`.
5. Verify the account-export assertion is meaningful and no secret is printed.
6. Verify the sparse strength-plan state is accessible, readable at mobile sizes, and does not offer blank start/watch/copy actions.
7. Confirm populated plans still receive all existing actions.
8. Verify the four guarded stretch names resolve to no photo rather than a wrong photo, while Squat, Tricep Pushdown, Walking Lunges, and Quad Stretch still resolve to their intended existing assets.
9. Re-run:

```bash
node --check backend/src/routes/auth.js backend/scripts/final-beta-api-smoke.js
cd frontend && npm run build
cd frontend && npm audit --audit-level=high
cd backend && npm run check:account-data
```

Do not rerun the live mutation smoke during this read-only QA pass.

## Known content gap, classify separately

Computer-use confirmed that the stretch library still contains movements without exact local form photos. Example: Hips -> Pigeon Pose renders `Form image queued`. `MovementDemo.jsx` intentionally rejects generic external URLs, so this is a real content-coverage gap, not a broken network image. Do not solve it in this QA pass. Report:

- how many catalog movements resolve to an exact local photo for a known male/female profile;
- how many fall back to the placeholder;
- any movement currently mapped to a materially wrong exercise photo;
- whether this should block a friends-and-family beta or be a separately tracked content phase.

## Verdict format

Return findings first, ordered CRITICAL/HIGH/MEDIUM/LOW with `file:line` evidence. Then provide:

- `VERIFIED` / `DISAGREE` / `FIX REQUIRED` for each Phase 2 item;
- exact tool results;
- synthetic-smoke safety assessment;
- stretch-photo coverage counts and recommendation;
- final verdict: `PASS`, `PASS WITH RISKS`, or `FAIL`.
