# Claude Code QA: Forged Hybrid Phase 4B private challenge engine

Repo: `/Volumes/Zordon Storage /openclaw-workspace/forge-app`
Branch: `main`
Date: 2026-07-15

Read `CLAUDE.md` and `.build-prompts/FORGED-HYBRID-PHASE-4-SOCIAL-CHALLENGES-SPEC.md` first. Review the current uncommitted Phase 4B diff against `HEAD`. This is a security, privacy, data-integrity, migration, and deterministic-scoring QA. Do not push, deploy, or run EAS. Phase 4C owns full leaderboard presentation; do not broaden this pass into public challenges, feeds, teams, prizes, group runs, location sharing, native notifications, or native changes.

## Intended behavior

- Extend dormant `challenges` and `user_challenges` tables idempotently while keeping system catalog rows and coach-created personal goals out of social APIs.
- Authenticated users can create private 7/14/30-day challenges from five bounded templates: run distance, run time, run days, strength sessions, or hybrid balance.
- Only accepted, unblocked friends can be invited and join. Owners can cancel/remove; members can join/decline/leave/mute.
- Challenge scoring is recomputed from source run/lift rows on each read. Mutable legacy `progress` is never leaderboard truth.
- Walks and non-run activities never count. Completed strength sessions count once, not once per set/exercise.
- `device_only` accepts trusted import/watch identifiers only. A user-editable note must never establish device provenance.
- Replayed Health/watch runs de-duplicate; legitimate distinct device strength sessions remain distinct. Edits/deletes immediately alter recomputed progress.
- Hybrid completion is the lower of run-target and lift-target ratios, so excess work on one side cannot compensate for missing the other.
- Local date windows are deterministic across IANA timezones and DST. Ties share rank.
- Nonmembers receive 404. Shared-challenge blocks preserve official ranks but mask the blocked row's identity and all contribution data.
- Deleting an owner transactionally deletes a solo social challenge or anonymizes it and promotes the earliest joined remaining member.
- Community defaults to Challenges with Friends as the second compact tab. Existing friend workflows remain intact.
- No native/Capacitor/EAS files should change.

## Required inspection

1. Trace every endpoint in `backend/src/routes/challenges.js` for auth, parameterization, user-scoped writes, membership/owner proof, 404 isolation, friend/block checks, caps, and races under concurrent invite/join/leave/remove/cancel calls.
2. Verify the challenge INSERT placeholder count and all PostgreSQL `ANY(...::text[])`, row-lock, UPDATE-alias, DELETE-alias, and migration SQL against the repo's `toPositional()` behavior and production PostgreSQL.
3. Verify existing production tables can migrate safely from the legacy shape and that canonical `schema.pg.sql`, `db/index.js`, and `db/migrate.js` remain consistent.
4. Prove system rows and `goal-*` personal rows cannot appear in list/detail/leaderboard or be mutated through social owner actions. Check `coach.js` compatibility.
5. Inspect scoring against `runActivitySql()`/`isRunActivity`, Health/watch replay IDs, manual source spoofing, same-day legitimate strength sessions, completed sessions with multiple sets, run/lift edit/delete behavior, first/last day, timezone boundaries, DST, ties, and max 50 members/30 days.
6. Verify blocked-member output retains rank only and leaks no name, user ID, score, percent, counts, dates, or contribution details.
7. Audit account export/deletion, solo owner deletion, owner promotion, later promoted-owner deletion, social report retention, and transaction rollback failure modes.
8. Inspect frontend create/invite/join/decline/leave/mute/cancel behavior, complete busy/error/empty states, i18n keys, safe text rendering, 320px-430px fit, and 40px+ targets. Confirm no duplicate friend UI.
9. Confirm rate limits are per authenticated user and all free text is sanitized/bounded server-side.
10. Inspect the complete diff for regressions outside Phase 4B.

## Commands

```bash
node --check backend/src/routes/challenges.js
node --check backend/src/lib/challengeRules.js
node --check backend/src/lib/challengeScoring.js
node --check backend/src/lib/challengeOwnership.js
node --check backend/src/routes/coach.js
node --check backend/src/routes/auth.js
node --check backend/src/db/index.js
node --check backend/src/db/migrate.js
node backend/scripts/friends-phase4a-smoke.js
node backend/scripts/friends-phase4a1-smoke.js
node backend/scripts/challenges-phase4b-smoke.js
cd backend && npm run check:account-data
cd ../frontend && npm run build
npm audit --audit-level=high
npx cap sync ios
git diff --check
git status --short
```

Run additional focused static or pure-function tests as needed. Do not mutate production data.

## Deliverable

Return findings first, ordered CRITICAL/HIGH/MEDIUM/LOW with exact `file:line` evidence. Explicitly state PASS or FAIL, list every command result, identify residual live/concurrency gaps, and recommend whether Codex may proceed to Hermes review and Railway deployment. If you find a minimum-scope issue, fix it locally, rerun relevant gates, and list every changed file; still do not commit or push.
