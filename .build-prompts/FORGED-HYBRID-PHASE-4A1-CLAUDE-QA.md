# Claude Code QA: Forged Hybrid Phase 4A.1 exact-handle friend discovery

Repo: `/Volumes/Zordon Storage /openclaw-workspace/forge-app`
Branch: `main`
Date: 2026-07-15

Read `CLAUDE.md` and `.build-prompts/FORGED-HYBRID-PHASE-4-SOCIAL-CHALLENGES-SPEC.md` first. Review the current uncommitted Phase 4A.1 diff against `HEAD`. This is a security/privacy-sensitive full-spec QA. Do not push, deploy, or run EAS. Do not broaden scope into challenges, contacts, public profiles, feeds, QR dependencies, or fuzzy search.

## Intended behavior

- Existing accounts remain hidden by default.
- A user may choose one normalized unique `friend_handle` and explicitly enable/disable exact-handle discoverability.
- Handle rules: 3-24 lowercase-normalized letters, numbers, periods, or underscores; first character alphanumeric; reserved system/support names rejected.
- Search is authenticated, exact match only, rate-limited per authenticated account, and never searches names, emails, phone numbers, contacts, or partial handles.
- Invalid, absent, hidden, self, and blocked results all return the same 404 body.
- Search returns only display name, handle, and relationship state. It never returns email, health/training data, location, or private profile fields.
- Direct handle requests reuse the same transaction, canonical-pair uniqueness, friend caps, row locks, block checks, and reset semantics as private-link requests.
- Reverse pending requests remain incoming; they are never auto-accepted or duplicated.
- Invite links still work and are secondary in the Community UI.
- Account export includes the user's handle and discoverability setting.
- No native or Capacitor files change; no EAS build is required.

## Required inspection

1. Verify every new route requires auth and all mutations scope writes to `req.user.id` or a canonical relationship containing it.
2. Verify the case-insensitive partial unique index is present in `db/index.js`, `db/migrate.js`, and `schema.pg.sql`, and that adding it is safe for existing accounts.
3. Trace concurrent handle update/search/request/block races. Confirm sorted user row locks serialize request versus block.
4. Confirm the direct-request refactor does not consume invite tokens on accepted/pending no-ops and does consume exactly once for a new invite request.
5. Confirm unavailable response uniformity and that rate limits count failed enumeration attempts.
6. Confirm accepted/incoming/outgoing/available relationship states are correct from either side.
7. Confirm the Community UI fits 320px-430px widths, uses 40px+ targets, labels all icon-only controls, and has complete loading/error/empty/busy states.
8. Confirm clearing a handle disables visibility; a conflicting handle returns 409; disabling visibility hides search without damaging existing friendships.
9. Confirm no secrets or personal data are added to logs, responses, invite URLs, or exports beyond the account owner's handle setting.
10. Inspect the complete diff for regressions outside Phase 4A.1.

## Commands

```bash
node --check backend/src/routes/socialFriends.js
node --check backend/src/lib/friendship.js
node --check backend/src/db/index.js
node --check backend/src/db/migrate.js
node --check backend/src/routes/auth.js
node backend/scripts/friends-phase4a-smoke.js
node backend/scripts/friends-phase4a1-smoke.js
cd backend && npm run check:account-data
cd ../frontend && npm run build
npm audit --audit-level=high
npx cap sync ios
git diff --check
git status --short
```

Run additional focused tests you need. Do not mutate production data.

## Deliverable

Return findings first, ordered CRITICAL/HIGH/MEDIUM/LOW with exact `file:line` evidence. Explicitly state PASS or FAIL, list every command result, identify residual device/live-test gaps, and recommend whether Codex may proceed to Hermes review and Railway deployment. If you find a minimum-scope issue, fix it locally, rerun the relevant gates, and report the changed files; still do not commit or push.
