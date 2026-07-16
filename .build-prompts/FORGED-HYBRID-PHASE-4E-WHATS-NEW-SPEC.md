# Forged Hybrid Phase 4E Build Spec: What's New

Status: **SPEC APPROVED; IMPLEMENTATION NOT STARTED (2026-07-15)**
Repo: `/Volumes/Zordon Storage /openclaw-workspace/forge-app`
Release target: current React/Vite/Capacitor + Express/PostgreSQL app only
Native/EAS scope: **none**

## 1. Product objective

Give athletes a reliable, quiet way to understand what changed in Forged Hybrid without making them read build notes, Telegram updates, commit history, or TestFlight metadata.

The first release must provide:

- one concise update sheet after sign-in when a user has not seen the latest eligible release;
- a permanent `What's New` destination under `More`;
- an unread indicator that clears consistently across devices;
- direct links into the feature being described;
- truthful delivery language that distinguishes Railway-delivered web changes from native changes that require a TestFlight/App Store update.

This is a release-communication surface, not a marketing feed or notification center.

## 2. Product decisions

1. **Only verified-live behavior is announced.** A merged commit, successful local build, Railway build in progress, or EAS upload is not enough.
2. **One prompt per release.** Never show a carousel of every historical release after login.
3. **Latest catch-up for first use.** If no read state exists, show only the newest eligible release. The archive still lists older releases.
4. **Do not interrupt training.** Never open over onboarding, a waiver, an active run/lift, a warm-up/stretch session, a feedback/report dialog, or another modal.
5. **Closing is a snooze, not an acknowledgement.** Close/backdrop/Escape hides the sheet for the current browser session and keeps the More unread dot. `Got it`, a release CTA, or opening the complete What's New page marks it read.
6. **No push notifications in Phase 4E.** Major-release push may be evaluated later after notification permissions and preferences have their own spec.
7. **No subscription gate.** Beta testers and free users receive the same release communication for features available to them.

## 3. Information architecture

Add a compact `Product` section to `frontend/src/pages/More.jsx` after `Progress`:

- row label: `What's New`;
- subtitle when read: `Recent improvements and new features`;
- subtitle when unread: `New improvements are ready`;
- icon: Lucide `Sparkles` or `Megaphone`;
- one small accessible unread dot/badge beside the label, never a new bottom-navigation tab.

Add authenticated route `/whats-new` in `frontend/src/App.jsx`.

The page shows newest releases first. Each release contains:

- date;
- short title;
- one-sentence summary;
- at most three user-facing highlights;
- one optional internal CTA;
- a quiet availability label only when native delivery matters.

Do not show commit hashes, Railway deployment IDs, raw bundle names, internal phase labels, provider errors, environment names, or EAS build IDs to athletes.

## 4. One-time update sheet

Create a reusable `WhatsNewSheet` that follows the app's current accessible dialog patterns.

Required content and controls:

- Forged Hybrid identity and `What's New` eyebrow;
- current release title and summary;
- at most three concise highlights;
- primary CTA when the release has a useful destination;
- `Got it` acknowledgement;
- close control labelled `Not now` for assistive technology;
- `View all updates` link to `/whats-new`.

Required behavior:

- focus moves into the sheet when it opens and returns to the prior control when it closes;
- focus is trapped while open;
- Escape and backdrop close only snooze for the current session;
- browser back closes the sheet before navigating away;
- no body scroll behind the sheet;
- buttons remain at least 44px high;
- content fits 320, 375, 390, 430, and 480px widths with no horizontal overflow;
- reduced-motion users receive no entrance animation;
- a failed read-state request never blocks or crashes the app.

The sheet may appear only after all of these are true:

- the user is authenticated and onboarded;
- waiver gating is complete;
- route and lazy chunks have settled;
- the current route is not immersive or safety-critical;
- no other app-owned dialog is open;
- an eligible release is newer than the user's server-backed seen sequence;
- the release has not already been snoozed during this browser session.

Do not use an arbitrary long timeout as the primary coordination mechanism. Add a small release-notice provider/controller at the authenticated app-shell boundary and expose an explicit suppression contract for immersive routes and app dialogs. A short post-render delay is acceptable only after eligibility is known.

## 5. Release manifest contract

Add `frontend/src/data/releases.js` as the reviewed source of truth. User-facing copy belongs in `frontend/src/locales/en.json`; the manifest stores translation keys and bounded metadata.

Each release must match this shape:

```js
{
  id: 'private-training-together',
  sequence: 1,
  publishedAt: '2026-07-15',
  titleKey: 'whatsNew.releases.privateTraining.title',
  summaryKey: 'whatsNew.releases.privateTraining.summary',
  highlightKeys: [
    'whatsNew.releases.privateTraining.friends',
    'whatsNew.releases.privateTraining.challenges',
    'whatsNew.releases.privateTraining.groupRuns',
  ],
  cta: {
    labelKey: 'whatsNew.releases.privateTraining.cta',
    to: '/community?tab=runs',
  },
  delivery: 'web',
  minIosBuild: null,
  minAndroidBuild: null,
  audience: 'all',
}
```

Manifest rules:

- `id` is unique, lowercase kebab-case, and immutable after publication;
- `sequence` is a unique, strictly increasing positive integer and is the read-state comparison key;
- the manifest is stored in ascending sequence order; selectors reverse it for newest-first display;
- `publishedAt` is a valid ISO calendar date;
- one to three highlight keys are required;
- all translation keys must exist in `en.json`;
- CTA paths must be same-origin app routes from a hardcoded allowlist; no arbitrary external URL;
- `delivery` is exactly `web`, `native`, or `mixed`;
- `minIosBuild`/`minAndroidBuild` are positive integers or null and are legal only for `native`/`mixed`;
- audience is an explicit allowlisted value such as `all`, `ios`, or `android`; no health, subscription, age, sex, or performance targeting;
- draft or future content must not live in the production manifest.

Add a standalone manifest smoke test that fails on duplicate/out-of-order sequences, missing copy keys, invalid dates, too many highlights, invalid delivery/build combinations, or unsafe CTA paths.

## 6. Delivery and eligibility truth

The app live-loads web content from Railway, so most UI/backend changes are available without a new TestFlight build. The release surface must not imply otherwise.

Eligibility rules:

- `web`: show when the release is in the currently served production bundle;
- `native`: show as available only when the current device build meets the release's minimum build;
- `mixed`: show only the highlights available in the current runtime, or use clear per-highlight copy if part of the release requires a native update;
- browser users never receive a TestFlight update CTA;
- iOS users below a verified-published minimum may see `Update Forged Hybrid in TestFlight`, but only after that build is actually available to testers;
- users on an adequate native build see `Available in this app`, not a build number;
- unsupported native features are omitted rather than announced as broken.

Reuse the existing native runtime/build detection and Watch availability helpers where applicable. Do not create a second contradictory build-number parser.

Internal build diagnostics remain in existing diagnostic surfaces and console logs. Raw build requirements and plugin errors do not appear in the update sheet.

## 7. Persistent read state

Reuse the existing `user_settings` table; do not add a table.

Store one user-scoped setting:

- key: `whats_new_seen_sequence`;
- value: decimal string containing the highest acknowledged sequence.

Add authenticated router `backend/src/routes/releases.js` mounted at `/api/releases`:

- `GET /api/releases/state` -> `{ seenSequence: number }`;
- `PUT /api/releases/state` with `{ seenSequence }` -> `{ seenSequence: max(previous, incoming) }`.

Mutation requirements:

- `auth` on both endpoints;
- integer boundary validation, `0 <= seenSequence <= 1000000`;
- parameterized SQL only;
- every query scoped to `req.user.id` and the exact setting key;
- use the current user-mutation/transaction pattern so two devices cannot regress the value;
- update uses `AND user_id=?` in the write predicate;
- no empty catches; log a bounded route context without tokens or setting values;
- no endpoint accepts release titles, copy, routes, dates, or arbitrary setting keys.

`user_settings` is already covered by account export and deletion. Confirm rather than duplicating coverage. The read sequence is not sensitive health data.

Use a user-scoped local fallback key only for fail-soft continuity:

`forge_whats_new_seen:<userId>`

The server remains authoritative. Never use one global localStorage key that can leak acknowledgement state between accounts on the same phone.

## 8. Client state and failure behavior

Add a small `releaseState` service/hook rather than scattering API and localStorage calls across `App.jsx`, `Layout.jsx`, `More.jsx`, and the page.

Rules:

- merge server and same-user local values using the maximum sequence;
- never move a seen sequence backward;
- update local state immediately after a deliberate acknowledgement, then persist server-side;
- if persistence fails, keep the session quiet, retain the More unread state on the next clean server load, and log a bounded console error;
- retry only from a deliberate acknowledgement or future app open; no tight retry loop;
- signing out or account deletion must not clear another account's scoped fallback key;
- malformed server/local values normalize to zero;
- an unknown future server sequence means all current manifest entries are read;
- removing an old manifest entry never makes it unread again.

The app must still render normally when the manifest is empty, state APIs return 401/500, localStorage is unavailable, or an individual CTA destination no longer exists.

## 9. Initial published release

Seed one catch-up release in the Phase 4E production bundle after its claims and the complete Phase 4E diff pass local/independent QA. Verify the sheet and this entry together after Railway deploys that bundle:

Title: `Train together, privately`

Summary: `Friends, challenges, and structured group runs are now together in Community.`

Highlights:

1. `Find trusted friends with exact handles or private invites.`
2. `Create private run, strength, and hybrid challenges.`
3. `Plan a structured group run with a private route and meetup.`

CTA: `Open Community` -> `/community?tab=runs`

Delivery: `web`

Do not backfill every 2026 phase into the initial prompt. Older major improvements may appear as concise archive entries only if each claim is re-verified before publication.

## 10. Release authoring workflow

For every future release:

1. Finish implementation, independent Claude Code QA, Hermes product review, fixes, and production verification.
2. Decide whether the change is user-visible and important enough to announce. Small bug fixes, internal hardening, docs, dependency bumps, and diagnostics do not need an entry.
3. Add one manifest object and its `en.json` copy after the underlying feature is verified live.
4. Increment sequence by exactly one.
5. Use plain athlete language: what changed, why it helps, and where to use it.
6. Run the manifest smoke and full build gate.
7. Deploy the release-note entry to Railway and verify the sheet, archive, CTA, and read persistence with two accounts/two sessions.

Never announce `coming soon` inside What's New. Roadmap promises belong outside a shipped-feature log.

## 11. Analytics

Extend the existing bounded event allowlists in both frontend and backend with:

- `whats_new_shown`;
- `whats_new_opened`;
- `whats_new_cta`.

Allowed properties use existing safe keys only:

- `surface`: `sheet|more`;
- `action`: `shown|acknowledged|opened|cta`;
- `value`: numeric release sequence.

Do not send release copy, user identity, routes, build IDs, or free-form text. Analytics remain fail-soft and must not delay rendering, navigation, or read-state persistence.

## 12. Privacy, safety, and accessibility

- Release content is application-authored only; no user-generated HTML or Markdown rendering.
- Render copy as text, never `dangerouslySetInnerHTML`.
- No health, injury, race, location, friend, or subscription details enter the manifest/read-state request.
- Same-origin CTA allowlist prevents release metadata from becoming an open redirect.
- Read-state routes return no other `user_settings` values.
- The sheet must meet focus, keyboard, screen-reader, contrast, reduced-motion, and touch-target requirements.
- Pull-to-refresh and left-edge swipe-back must not trigger behind the open sheet.
- The sheet must not cover native safe-area controls or the bottom navigation incoherently.

## 13. Explicitly deferred

- Native push notifications or notification permission prompts.
- Email release newsletters.
- Admin/CMS release authoring.
- Remote-config rollout percentages.
- Per-user behavioral targeting.
- Public roadmap, reactions, comments, or likes.
- Forced update blocking.
- App Store/TestFlight release-note automation.
- Rich video, autoplay, or large image carousels.

## 14. Expected implementation scope

Expected files (keep the final diff close to this list):

- `backend/src/app.js`
- `backend/src/routes/releases.js`
- `backend/test/releases.smoke.js`
- `frontend/src/App.jsx`
- `frontend/src/pages/More.jsx`
- `frontend/src/pages/WhatsNew.jsx`
- `frontend/src/components/WhatsNewSheet.jsx`
- `frontend/src/context/ReleaseNotesContext.jsx` or one equivalent bounded controller
- `frontend/src/data/releases.js`
- `frontend/src/lib/releaseState.js`
- `frontend/src/lib/track.js`
- `frontend/src/locales/en.json`
- `frontend/test/releases.smoke.mjs`

No dependency, native source, Capacitor config, EAS profile, app version, build number, payment, AI, training-plan, health-data, or social authorization changes.

## 15. Verification matrix

### Backend

- unauthenticated GET/PUT return 401;
- first GET returns zero;
- PUT persists a valid sequence;
- older PUT cannot regress a newer sequence;
- concurrent PUTs from two sessions settle on the maximum;
- invalid, fractional, negative, oversized, string, array, and object values return 400;
- user A cannot read or mutate user B's state;
- no arbitrary `user_settings` key is readable/writable;
- export includes the setting through existing settings coverage;
- account deletion removes it through existing atomic cleanup.

### Manifest

- unique IDs and sequences;
- strict sequence order;
- valid dates;
- one to three highlights;
- every translation key exists;
- CTA allowlist enforced;
- native minimum rules enforced;
- no draft/future entry ships.

### Frontend behavior

- unseen eligible release opens once after authenticated shell settles;
- no sheet during onboarding, waiver, active run/lift, warm-up/stretch, or another dialog;
- `Not now` snoozes only the current session and leaves unread badge;
- `Got it`, CTA, and viewing the archive clear unread state;
- another browser session/device sees the server-backed acknowledgement;
- failed state API is fail-soft and does not cause a render loop;
- web release never asks for TestFlight update;
- native release eligibility matches current runtime/build;
- CTA marks read and navigates once;
- browser back/Escape/focus restoration work;
- More row and archive work with empty, one-release, and multi-release manifests;
- 320/375/390/430/480px widths have no overflow or clipped controls;
- light/dark themes, text zoom, and reduced motion remain usable.

### Regression/toolchain

Run:

```bash
node --check backend/src/app.js
node --check backend/src/routes/releases.js
node backend/test/releases.smoke.js
cd backend && npm run check:account-data
cd frontend && node test/releases.smoke.mjs
cd frontend && npm run build
cd frontend && npm audit --audit-level=high
cd frontend && npx cap sync ios
```

`cap sync` must produce no tracked native diff. Do not run EAS.

## 16. Build loop and release gate

Implementation sequence:

1. Codex implements the bounded Phase 4E diff and focused smokes.
2. Codex writes `.build-prompts/FORGED-HYBRID-PHASE-4E-CLAUDE-QA.md` with the actual commit/diff and verification commands.
3. Claude Code performs independent code/security/regression QA and returns explicit `PASS` or findings.
4. Codex fixes every accepted finding and records evidence for any disagreement.
5. Hermes performs product/copy/accessibility review using `.build-prompts/FORGED-HYBRID-PHASE-4E-HERMES-REVIEW.md`.
6. Codex applies accepted product findings and reruns Claude Code when behavior changed.
7. Push to `main`; wait for Railway success.
8. Verify production with at least two disposable accounts and two browser sessions:
   - first session sees the sheet;
   - `Not now` leaves the More badge;
   - acknowledgement clears it;
   - second session observes the server-backed read state;
   - CTA opens Community Runs;
   - no console errors or horizontal overflow.
9. Update `README.md`, `FORGE.md`, and `CLAUDE.md` only after live verification, using the repo's release-status language.

Completion requires:

- Claude Code `PASS` with no critical/high finding;
- Hermes `APPROVE` with no product/privacy/accessibility blocker;
- full verification matrix green;
- Railway deployment success and matching production bundle;
- production two-account/session matrix green;
- no EAS build;
- initial catch-up release contains only re-verified, already-live claims.
