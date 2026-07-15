# Claude Code QA: Forged Hybrid Phase 4A Friends and Safety

Repo: `/Volumes/Zordon Storage /openclaw-workspace/forge-app`

Review the complete current working-tree Phase 4A diff on `main`, including untracked files. Read `CLAUDE.md` and `.build-prompts/FORGED-HYBRID-PHASE-4-SOCIAL-CHALLENGES-SPEC.md` first. This is a read-only QA pass: do not edit files, commit, push, deploy Railway, create accounts, mutate production data, or invoke EAS.

## Intended scope

Phase 4A adds only the invite-only friends and safety foundation:

- mutual friendships with pending, accept, decline, remove, and a 100-friend cap;
- private one-use invite tokens stored only as SHA-256 hashes, expiring after seven days, with five active invites per owner;
- directional block/unblock and bounded report submission;
- an admin-only social report list using the existing diagnostics-admin authorization;
- a compact Community destination under More with no new bottom-navigation tab;
- invite preservation through login, registration, waiver, and onboarding;
- account export/deletion coverage, with reports about a user excluded from export and moderation records anonymized on deletion.

Challenges, leaderboards, public search, public feeds, contact upload, messages, group runs, live location, push notifications, native deep links, and EAS are explicitly out of scope.

## Security and correctness audit

Verify with exact file:line evidence:

1. Every new route requires `auth`; the admin list also requires `requireDiagnosticsAdmin`.
2. Every `UPDATE` and `DELETE` proves the authenticated participant/owner in the write predicate, except invite consumption where authority must be bound to the hashed one-use token and authenticated resolver.
3. Parameterized SQL only. Multi-step state changes use `withTransaction`. Lock ordering is consistent across resolve, accept, and block paths and cannot create an obvious deadlock cycle.
4. Reverse duplicate friendships are impossible, self-friend/self-block is rejected, and concurrent accepts cannot exceed the 100-friend cap.
5. Invite plaintext is returned only on creation, never stored/exported/logged. Invalid, expired, consumed, blocked, and unavailable invite resolution do not enumerate account details. Invite owners cannot resolve their own token.
6. A block is available only where a relationship already exists, removes active/pending friendship state, hides both directions from friend lists, and prevents future invite resolution.
7. Cross-user accept/decline/remove/unblock attempts fail. Reports require an existing relationship/block context, enforce allowlists and length bounds, sanitize notes, and expose no automatic punishment.
8. `GET /api/social/friends` exposes display names and IDs only as needed; it never exposes email, DOB, health data, routes, precise location, or other private profile fields.
9. Account export excludes invite token hashes and reports submitted about the requester. Account deletion transactionally removes relationships/invites/blocks and anonymizes retained moderation records before deleting the user.
10. Database runtime migrations and `schema.pg.sql` agree on all four tables, constraints, indexes, foreign-key deletion behavior, and canonical friend pair rules.
11. Post-auth redirect storage accepts internal paths only, expires after 24 hours, survives the invite login/register/onboarding flow, and cannot become an open redirect or leak across explicit logout.
12. Community UI has loading, empty, success, error, limit, pending, blocked, and report states; actions are usable at iPhone width with stable 40px+ targets; new user-facing copy comes from `en.json`.
13. Mounting `socialFriends` before the legacy `social` router does not break existing feed/photo/comment routes.
14. No Phase 4B/4C feature, native config, dependency, environment variable, EAS setting, or unrelated app behavior was changed.

## Required commands

Run all of these and report exact results:

```bash
git diff --check
node --check backend/src/routes/socialFriends.js
node --check backend/src/routes/adminSocial.js
node --check backend/src/lib/friendship.js
node --check backend/src/routes/auth.js
node --check backend/src/db/index.js
node --check backend/scripts/check-account-data-coverage.js
node --check backend/scripts/friends-phase4a-smoke.js
node backend/scripts/friends-phase4a-smoke.js
cd backend && npm run check:account-data
cd frontend && npm run build
cd frontend && npm audit --audit-level=high
cd frontend && npx cap sync ios
```

After Capacitor sync, verify no unexpected native/plugin, bundle identifier, version, or build-number diff appeared.

## Report format

Lead with findings ordered `CRITICAL`, `HIGH`, `MEDIUM`, `LOW`, each with exact file:line evidence, failure path, and minimum-scope fix. Do not silently skip disagreements. Then provide:

1. `PASS`, `PASS WITH RISKS`, or `FAIL`.
2. Per-area status: schema, API authorization, invite lifecycle, block/report safety, account data, auth redirect, mobile UI, legacy-route compatibility.
3. All required command results.
4. Whether Phase 4A is safe to commit and push to Railway for disposable two-account live verification.
5. A separate statement that no EAS build was run or authorized.
