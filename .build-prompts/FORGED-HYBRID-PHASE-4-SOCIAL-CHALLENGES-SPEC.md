# Forged Hybrid Phase 4 Build Spec: Friends, Challenges, and Leaderboards

Status: **PHASES 4A-4C SHIPPED AND RAILWAY-LIVE-VERIFIED; PHASE 4D IMPLEMENTED, LOCALLY VERIFIED, AND RAILWAY-PENDING (2026-07-15)**
Repo: `/Volumes/Zordon Storage /openclaw-workspace/forge-app`
Release target: current React/Vite/Capacitor + Express/PostgreSQL app only
Native/EAS scope: **none for Phases 4A-4C**

## 1. Remaining roadmap before this feature

Release-gate status:

1. **Phase 3D - complete per Bryan on 2026-07-15.** TestFlight build 16 device acceptance is closed with no remaining critical/high blocker. Paired-Watch delivery remains a separate hardware-only check and does not block the iPhone beta.
2. **Phase 3E - implemented and Claude Code QA passed on 2026-07-15.** Tester-facing startup crashes no longer expose raw technical details, and the unused HealthKit write-purpose claim was removed from both metadata sources. The web fix still requires Railway live verification; the metadata correction will ride the next separately approved native build. No EAS build is authorized by this phase.
3. **Phase 4 - this social competition track.** Build friends, private challenges, and trustworthy leaderboards only after Phase 3D has no critical/high blocker.
4. **Partner watch delivery remains external.** Garmin, COROS, TrainingPeaks, Polar, Suunto, and Wahoo direct workout delivery depends on partner approval. It is not an internally finishable code phase. Manual workout copy/export and Apple WorkoutKit remain the available paths.

Friends already testing build 15/16 may continue. Phase 4 must not interrupt the active beta or require another EAS build.

## 2. Product objective

Add a clean social layer that makes consistent hybrid training more enjoyable without turning Forged Hybrid into a noisy social feed.

The first release must let an athlete:

- add and manage trusted friends;
- create or join a private challenge from bounded templates;
- compare progress on a friends/challenge leaderboard;
- understand which activities are device-recorded versus manually entered;
- leave, mute, block, or report without exposing private training or health data.

The differentiator is **hybrid competition**, not maximum mileage. Example: `20 running miles + 3 strength sessions in 14 days`.

## 3. Product boundaries

### Build now

- Mutual friends with opt-in exact `@handle` lookup plus secondary invite links/codes, request/accept/decline/remove, block, and report; maximum 100 accepted friends per user in beta.
- Private challenges for accepted friends.
- Deterministic challenge templates:
  - running distance;
  - running time;
  - running consistency/days;
  - strength-session consistency;
  - hybrid balance: run target plus lift-session target.
- Challenge durations of 7, 14, or 30 days; explicit local start/end dates.
- Friends/challenge leaderboards with progress, rank, ties, and source-quality labels.
- In-app activity and challenge updates. No native push notification requirement.
- One compact entry under `More`, not a new bottom-navigation tab.

### Explicitly defer

- Public/global leaderboards.
- Cash prizes, wagers, sponsored rewards, or financial value.
- Direct messages and unrestricted user-generated feeds.
- Address-book/contact upload.
- Arbitrary formulas or free-form challenge scoring.
- Weight-loss, calorie-burn, body-weight, sleep, HRV, or medical-data leaderboards.
- Team leagues, public group-run discovery, and live participant maps. Private friends-only group-run logistics are Phase 4D; live location sharing remains deferred.
- Native push notifications, deep links, or another EAS build.

## 4. Existing code to reuse or retire carefully

### Reuse

- `backend/src/routes/social.js`: authenticated social boundary, text cleaning, user-scoped media patterns.
- `backend/src/db/index.js`: existing `challenges`, `user_challenges`, and `follows` tables as migration inputs.
- Existing run/lift source-of-truth rows, activity classification, tombstones, and `runActivitySql()` filtering.
- `backend/src/lib/accountDataCoverage.js`: export/deletion registry must cover every new user-owned table.
- `frontend/src/pages/More.jsx`: add one `Community` destination.
- Existing feedback, reporting conventions, beta access, responsive shell, and `en.json` copy patterns.

### Do not expose as-is

- The one-way `follows` model is not a mutual friend contract and has no pending/decline/block state.
- `social.js /feed` currently discovers recent users broadly and can expose activity from followed accounts. Do not restore that UI as the Phase 4 home.
- Existing `challenges` / `user_challenges.progress` are too weak to be a trustworthy multi-user leaderboard. Do not increment mutable progress blindly.
- `coach.js` creates personal challenge rows from suggested goals. Preserve compatibility, but personal goals must not appear as social challenges unless explicitly converted by their owner.

## 5. UX and information architecture

Add `Community` under the existing `More` screen with subtitle `Friends and challenges`.

The Community screen uses two compact tabs:

1. **Challenges** - default tab. Active challenges first, then invitations, then a single `Create challenge` action.
2. **Friends** - opt-in exact-handle lookup, accepted friends, pending requests, secondary private-link invites, and remove/block/report actions.

Challenge detail contains:

- name, date window, template, target, verification policy, and participant count;
- the athlete's progress and one next useful action;
- a simple leaderboard;
- a compact recent-contribution list;
- mute, leave, report, and owner controls.
- a one-line reminder that challenge progress does not change the athlete's adaptive plan or recovery guidance.

Do not add a generic infinite feed in v1. Do not scatter challenge cards across Today, Train, Body, and More. Today may show at most one compact active-challenge progress row after the feature proves useful.

## 6. Friend safety model

Add a mutual relationship rather than treating a follow as friendship.

Recommended tables:

### `friendships`

- `id TEXT PRIMARY KEY`
- `requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- `addressee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE`
- `user_low_id TEXT NOT NULL`
- `user_high_id TEXT NOT NULL`
- `status TEXT NOT NULL` in `pending|accepted|declined|removed`
- `created_at`, `responded_at`, `updated_at`
- unique `(user_low_id, user_high_id)` so reverse duplicate requests are impossible

### `friend_invites`

- single-purpose random token stored as a hash, never plaintext after creation;
- owner-scoped, expires after seven days, one successful request per token;
- resolving an invite creates a pending request, not an automatic friendship;
- invalid, expired, and already-consumed tokens return the same status and response body;
- the authenticated resolver cannot be the invite owner;
- no user may hold more than five active, unexpired invite tokens;
- response never exposes the inviter's email or private health/training fields.

### `user_blocks`

- directional `(blocker_id, blocked_id)` unique pair;
- blocking cancels pending/accepted friendship and prevents future requests, invitations, and direct interaction;
- if both users already belong to a shared challenge, neither membership is removed unilaterally. Challenge and leaderboard APIs omit each user's identity and contribution rows from the other's response while calculating the official rank/tie basis across all joined members. Rank gaps are allowed and reveal no identity or activity details;
- every mutation must include the authenticated user in the write predicate.

Do not upload contacts in v1. Do not offer fuzzy, name-based, email-based, or browseable global user search. Exact handle lookup is allowed only for accounts that explicitly choose a unique handle and enable discoverability. Invalid, hidden, missing, and blocked lookups return the same response. Invite links remain the fallback.

Turning discoverability off removes the account from exact-handle lookup and hides the handle from new invite-based pending rows. Existing accepted friends may continue to see the handle as stable relationship identity; visibility changes never delete or damage an accepted friendship.

## 7. Challenge data model

Extend the existing `challenges` table idempotently rather than creating a competing catalog:

- `creator_id` nullable for system/personal legacy rows;
- `kind` in `system|personal|social`; all pre-existing rows default to `system`, rows whose existing IDs start with `goal-` are backfilled to `personal`, and only newly created social rows use `social`;
- `visibility` in `system|personal|private|friends` (no `public` in v1), backfilled to match `kind` so every pre-existing row is non-social on migration day;
- `template_type` in the five allowed templates;
- bounded `run_target`, `lift_target`, and unit fields appropriate to the template;
- `start_date`, `end_date`, `timezone`;
- `verification_policy` in `all_activity|device_only`;
- `participant_limit` default 25, maximum 50;
- `status` in `draft|active|completed|cancelled`;
- sanitized name <= 60 characters and optional description <= 280 characters.

Extend `user_challenges` as membership source of truth:

- `role` in `owner|member`;
- `status` in `invited|joined|declined|left|removed`;
- notification mute flag;
- joined/left timestamps;
- unique `(user_id, challenge_id)` retained.

Add a moderation table rather than storing reports in logs:

### `social_reports`

- `id TEXT PRIMARY KEY`;
- nullable `reporter_id` and `subject_user_id` references with `ON DELETE SET NULL`;
- `category` from a bounded server-side allowlist;
- `context_type` in `profile|friendship|challenge|activity` and nullable bounded `context_id`;
- sanitized optional `note` <= 500 characters;
- `status` in `open|reviewed|closed`;
- `created_at`, `reviewed_at`, and nullable admin reviewer ID.

Treat the existing `progress` column as legacy/cache-only. V1 leaderboard truth is derived from qualifying run/lift rows at read time. This ensures edits, deletion, Apple Health tombstones, duplicate protection, and corrected activity classification are immediately reflected without fragile write hooks.

Add indexes for `user_challenges(challenge_id, status)` and the run/lift user/date columns actually used by the aggregate queries. Confirm with `EXPLAIN` against a realistic beta fixture before adding any snapshot table.

Every social challenge list/detail query must require `kind='social'` and `visibility IN ('private','friends')`. System catalog rows and coach-created personal goals must never appear in the social API. Preserve the existing coach flow as `kind='personal'`, `visibility='personal'`.

## 8. Deterministic scoring and verification

Scoring must use structured data only. No LLM determines progress, rank, eligibility, or winners.

- Running aggregates must reuse the shared run-activity classifier so walks and non-running workouts never count.
- Strength counts a completed workout session, not each exercise/set as a separate session.
- Apply the challenge's local date window using the existing user-timezone convention.
- Device-recorded/imported activities display `Device recorded`; manual entries display `Manual`.
- `device_only` excludes manual entries. `all_activity` includes both but retains the label.
- Deduplicate imported/replayed workouts using existing source keys/client IDs.
- Deleted activities disappear from the leaderboard immediately. Imported activities with tombstones cannot reappear after resync.
- Ties share rank. Never rank by hidden health metrics, readiness, sex, age, weight, calories, or subscription tier.
- Challenge participation never overrides the adaptive plan, readiness protection, injury mode, recovery substitutions, or safe-volume bounds.
- Blocking inside an already-shared challenge uses the per-viewer masking rule in section 6. It never deletes another athlete's membership or rewrites the official score set.

For the initial beta, calculate leaderboard aggregates on request for at most 50 members and a 30-day window. Add snapshots only after measured query latency proves they are necessary.

## 9. API surface

Keep friendship routes under `/api/social`; create a bounded `/api/challenges` router rather than expanding `social.js` indefinitely.

Minimum endpoints:

- `POST /api/social/friend-invites`
- `POST /api/social/friend-invites/:token/request`
- `PUT /api/social/friend-discovery-profile`
- `POST /api/social/friend-search` with an exact handle only
- `POST /api/social/friend-requests` with an exact handle only
- `GET /api/social/friends`
- `PATCH /api/social/friendships/:id` with `accept|decline`
- `DELETE /api/social/friendships/:id`
- `POST /api/social/blocks/:userId`
- `DELETE /api/social/blocks/:userId`
- `POST /api/social/reports`
- `GET /api/admin/social-reports` behind the existing diagnostics-admin authorization pattern
- `GET /api/challenges`
- `POST /api/challenges`
- `GET /api/challenges/:id`
- `PATCH /api/challenges/:id` for bounded owner actions only
- `POST /api/challenges/:id/invite`
- `PATCH /api/challenges/:id/membership` with `join|decline|leave|mute`
- `GET /api/challenges/:id/leaderboard`

Every endpoint requires `auth`. Every mutation must prove authenticated ownership/membership in the write itself. Challenge detail and leaderboard return 404 to non-members rather than revealing existence. Use parameterized SQL and `withTransaction` for relationship/membership state changes.

## 10. Privacy, moderation, and account data

- Accepted friends see only challenge-scoped display name, avatar/initials, and qualifying activity summaries.
- Never expose email, DOB, raw HealthKit samples, readiness drivers, injury notes, GPS routes, home location, exact workout start location, or private photos.
- Challenge contributions contain the minimum necessary summary: date, activity category, distance/time or completed lift-session indicator, and verification label.
- Sanitize all challenge/report text with existing helpers.
- Rate-limit invite creation, friend requests, challenge creation, invitations, and reports.
- Add report categories and the admin-only audit path above; no automated punishment in v1.
- Update account export and `accountDataCoverage.js` for both sides of `friendships`, the owner side of `friend_invites`, both sides of `user_blocks`, challenge memberships, and both reporter/subject relationships in `social_reports`.
- Account deletion must run the social cleanup in `withTransaction`. Delete friendship rows where the user is requester or addressee, invite rows they own, block rows where they are blocker or blocked, and their challenge memberships.
- If a deleting current `owner` membership has no other joined challenge member, delete that social challenge. If joined members remain, retain the challenge, set `creator_id=NULL`, replace its name with the deterministic template label, set its description to null, and promote the earliest joined remaining membership to `owner`. This rule keys on `user_challenges.role='owner'`, not `creator_id`, so a later deletion by a previously promoted owner cannot orphan the challenge. Owner authorization is based on the membership role after this transition.
- Moderation reports survive account deletion as anonymized audit records: set a deleted reporter or subject reference to null, remove free-form note/context data that could identify the deleted user, and retain category, status, and timestamps. The export includes reports made by the requesting user but never reports submitted about them by someone else.

## 11. Delivery phases and build loop

### Phase 4A - friends and safety foundation

- migrations, friendship/invite/block/report routes;
- Friends UI under More;
- account export/deletion coverage;
- focused ownership, enumeration, rate-limit, and mobile tests.

Gate: Codex implementation -> Claude Code full QA -> Hermes product/privacy review -> fixes -> Railway deploy -> live two-account verification. No EAS.

### Phase 4A.1 - opt-in exact-handle discovery

- unique, normalized friend handles stored separately from the legacy username field;
- existing users hidden by default until they explicitly enable exact-handle discovery;
- exact-match lookup only, with per-account rate limits and identical unavailable responses;
- block-aware results and the same transactional mutual-request path used by invite links;
- private invite links retained as a secondary option; no contacts, fuzzy search, directory, QR dependency, or public profiles.

Gate: same build loop plus duplicate/case-insensitive handle, hidden-user, blocked-user, reverse-pending, rate-limit, export, mobile-width, and live disposable-account tests. No EAS.

Live verification (2026-07-15): Railway deployment `b09c3251-c4e2-4682-8e5a-8c8b8f43a8b9` served the matching `assets/index-loM_aUUY.js` bundle. A three-account disposable production matrix passed exact and case-insensitive lookup, uniform hidden/missing/invalid masking, duplicate rejection, pending-request de-duplication, reverse-pending state, accepted-friend persistence after discovery is disabled, hidden pending-handle masking, bidirectional block masking, account export, and complete account cleanup. The Community surface rendered at a 390px mobile viewport without horizontal overflow or console errors. No EAS build was run.

### Phase 4B - private challenge engine

- extend legacy challenge tables safely;
- template-based create/invite/join/leave flows;
- deterministic source-of-truth scoring;
- compatibility guard for personal coach-created goals.

Gate: same build loop plus run/walk classification, duplicate import, deletion/tombstone, timezone, manual/device, and concurrent membership tests.

Local verification (2026-07-15): Claude Code returned PASS with no critical/high code finding, Hermes returned APPROVE with no Phase 4B deploy blocker, and syntax checks, Phase 4A/4A.1 regressions, the Phase 4B deterministic smoke, 53-table account-data coverage, frontend build, high-level audit, Capacitor sync, and 375/390/430px responsive browser checks passed. Before Phase 4C exposes cross-user rankings, resolve or explicitly model the ambiguous case where one physical manual strength session is separately logged in both `workout_sessions` and legacy `lifts`; date-only merging is prohibited because it would undercount legitimate two-a-day sessions.

Live verification (2026-07-15): Railway deployment `d3416ea5-7d40-4d84-bcca-35831141af76` served commit `70a8c1c8` and the matching `assets/index-Bl4mWfJf.js` bundle. A three-account disposable production matrix passed 35 checks covering authentication, exact-handle friendship acceptance, friend-only invitations, nonmember concealment, join/list/detail behavior, source-row hybrid scoring, walk exclusion, UUID-safe leaderboard responses, edit/delete recalculation, mute state, blocked-member rank-only masking, owner-account anonymization and successor promotion, cross-user deletion denial, and complete account cleanup. The production Community UI passed a 375x812 browser check with no horizontal overflow, 44px form controls, Challenges first, and the Friends workflow intact. No EAS build was run.

### Phase 4C - leaderboard and beta polish

- challenge detail and leaderboard UI;
- ties, progress, source labels, empty/loading/error states;
- moderation controls and compact in-app updates;
- mobile computer-use test with at least three disposable accounts.

Strength-credit contract (Hermes-approved 2026-07-15): `all_activity` counts completed first-party `workout_sessions` plus trusted device-recorded `lifts`; `device_only` counts trusted device-recorded `lifts` only. Unprovenanced legacy manual `lifts` remain in private History but do not feed social scoring because they may be exercise summaries or duplicates of a first-party session. Distinct canonical session/import IDs preserve legitimate two-a-days. Known beta limitation: an in-app workout later imported independently from a watch can still appear as two strength sessions until both sources share a durable session identity; do not claim perfect cross-source deduplication.

Gate: full toolchain, Claude Code QA, Hermes review, Railway live verification, then Bryan approval before broad beta exposure.

Local verification (2026-07-15): Claude Code returned PASS after fixing one medium truth-state issue so a successful challenge action is not mislabeled failed when only its background refresh fails. Hermes reviewed the real scoring, payload, owner-removal, report, and masking code and returned APPROVE with no must-fix. Phase 4A/4A.1 regressions, Phase 4B/4C scoring smokes, 53-table account-data coverage, frontend build/audit, Capacitor sync, 375/430px browser checks, and a seven-part three-account disposable API matrix passed. No EAS build was run.

Live verification (2026-07-15): Railway deployment `f6d5ffa4-bc0a-4608-85ac-5db95e8b965d` serves commit `5c2bb109` and the matching `/assets/index-BuYpSH0L.js` bundle. The production three-account disposable matrix passed all seven grouped checks covering exact-handle friendship, private invitations, canonical strength credit, tied ranks, source identity, user-ID concealment, member reporting, opaque owner removal, nonmember concealment, and complete account cleanup. The authenticated Community and Lift surfaces rendered cleanly on a phone-sized viewport; both lift mobility actions opened profile-sex image-backed six-movement sessions. No EAS build was run.

### Phase 4D - private group runs

- Private events for accepted friends with a structured workout, scheduled time, broad meetup area, optional static route, and participant cap.
- Review-before-join invitations. Exact meetup instructions and route coordinates unlock only after the athlete joins.
- Mute, leave, report, block, organizer invite/remove, cancellation, completion, and truthful reminder/status handling.
- Private/no-store responses plus immediate cancellation purge and bounded post-event purge for exact location material.
- Group-run workouts may launch Active Run but never mutate the athlete's adaptive training-plan progress.
- Live participant location, public event discovery, native notifications, and EAS changes remain out of scope.

Gate: full toolchain, Claude Code security/privacy QA, Hermes product/privacy review, Railway live verification, three-account disposable production matrix, and 375-430px production browser verification. No EAS.

Local release gate (2026-07-15): backend syntax, Phase 4A-4D regression smokes, 93 daily/run/post-run assertions, the Phase 4D frontend smoke, 54-table account-data coverage, account-deletion atomicity and concurrency guards, frontend build/audit, Capacitor sync, and diff checks pass. Disposable local matrices passed seven challenge checks and ten group-run/privacy checks, including simultaneous reciprocal friend requests and cross-user report paths. The 375x812 and 430x932 planners have no horizontal overflow. Independent code/security and product/privacy re-reviews both returned PASS/APPROVE.

## 12. Required verification matrix

- Reverse/duplicate friend requests cannot create duplicate relationships.
- A blocked pair cannot request, invite, or directly view/interact with each other; an existing shared challenge preserves its official score set only through the masking rule below.
- Shared-challenge blocking masks both users from each other without deleting membership; official ranks remain stable and masked rows reveal no identity/activity data.
- Invite tokens expire, are single-use, stored hashed, cap at five active tokens per owner, reject self-resolution, and do not enumerate accounts through response differences.
- Only accepted friends can be invited to a private challenge.
- System catalog rows and coach-created `goal-` rows never appear in social challenge lists, detail, or leaderboards.
- Non-members receive 404 for challenge detail/leaderboard.
- Owners cannot remove another user's membership without owner-scoped authorization.
- Walks never count as runs.
- One lift workout counts once regardless of exercise count.
- Manual activity labels and `device_only` exclusions are accurate.
- Replay/import dedup prevents double progress.
- Run/lift edits and deletes update derived progress immediately.
- Tombstoned Apple Health runs do not return after sync.
- DST, timezone boundaries, first/last challenge day, and ties are deterministic.
- Account export and deletion cover every new user-owned row.
- Deleting a solo challenge owner deletes the challenge; deleting an owner with remaining members anonymizes it and promotes the earliest joined member transactionally.
- Reports retain only the explicitly defined anonymized moderation record after either referenced account is deleted.
- No screen overflows at 375x812, 390x844, or 430x932.
- Existing Today, Train, Lift, Body, More, beta access, Health sync, and active-run flows remain unchanged.

## 13. Success criteria

- A tester can invite a known friend, accept, create a private hybrid challenge, join, log/import qualifying activity, and see accurate leaderboard movement without exposing sensitive data.
- Challenge progress matches History source rows exactly.
- No critical/high security or privacy finding from Claude Code or Hermes.
- No global/public ranking, feed noise, or native-build dependency is introduced.
- Beta testers understand that challenge completion does not replace their adaptive plan or recovery guidance.

## 14. Hermes review questions

Hermes must return `APPROVE`, `APPROVE WITH CHANGES`, or `REJECT`, and answer:

1. Is friends/challenges the correct next product phase after Phase 3D/3E?
2. Is invite-only discovery the right privacy tradeoff for v1?
3. Should the implementation extend the dormant challenge tables and keep `follows` compatibility as proposed?
4. Are private/friends-only leaderboards and deterministic source-row scoring sufficient for beta?
5. What must be removed, simplified, or added before Codex receives an implementation task?
6. Should Phase 4D group runs remain separate?

Hermes approved this spec on 2026-07-15 with no remaining required changes. Phase 3D is complete and the Phase 3E source/QA gate is green; Phase 4A may begin after the Phase 3E web bundle is verified on Railway. No EAS build is authorized by this spec alone.
