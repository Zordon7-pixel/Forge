# FORGE.md — Project History and Release State

This file holds Forge's product history, deployment notes, shipped phase log, known risks, and archived document context. Keep `CLAUDE.md` focused on agent rules and QA constraints.

## Current Production

- Production URL: `https://forge-production-773f.up.railway.app/`
- Latest checked deployment: `18ed59b9-e191-46d2-bec5-382b29fc39aa`
- Latest checked bundle: `/assets/index-KbY4Avz3.js`
- iOS version/build: `1.0.3` / `8`
- Bundle identifier: `com.zordon.forge`

Current production checks:
- Demo diagnostics check returns `403`.
- `/api/auth/me/export` returns account/training data and excludes `password_hash`.
- `/api/auth/forgot-password` returns `200 email_sent` for `demo@forge.app` in under one second.
- EAS/TestFlight build is intentionally deferred until May 1, 2026 because Apple Developer credentials/2FA are unavailable before then.

## Recently Fixed Bugs

Do not reintroduce these patterns.

| Bug | Where Fixed | Pattern |
|-----|------------|---------|
| Auth bypass in DELETE | routes/runs.js, routes/lifts.js | DELETE didn't include `AND user_id=?` |
| perceived_effort no validation | routes/runs.js | Accepted any value |
| Profile fields no range check | routes/auth.js | Age/weight/HR accepted anything |
| Prompt injection | services/ai.js | User input interpolated raw into prompts |
| Sign-in race condition | AppNavigator.js | profileLoading not set before token |
| Lift weight zero accepted | History.js | `< 0` should be `<= 0` |
| [H2] hashFile symlink bypass (2026-03-23, commit 8bbd950e) | lib/vault.js | path.resolve() doesn't follow symlinks; fixed with fs.realpathSync() before boundary check |
| Activity photo hijack (2026-04-29 QA fix commit) | routes/social.js | POST photo validates the parent activity owner before INSERT/UPDATE; UPDATE no longer rewrites `user_id`; invalid/missing activities are rejected |
| Gear shoe ownership bypass | backend/src/routes/gear.js | PATCH now includes `WHERE id=? AND user_id=?` |
| Diagnostics exposed to all users | backend/src/routes/diagnostics.js, frontend/src/components/HelpDesk.jsx | Diagnostics/heal routes require admin email allowlist; demo is denied unless explicitly allowed |
| Auth rate limiter blocked normal profile/stat reads | backend/src/app.js | Rate limit narrowed to login/register/password-reset routes only |
| Profile numeric fields weakly validated | frontend/src/pages/Profile.jsx, backend/src/routes/auth.js | Age, weight, max HR, weekly miles are labeled and range-limited |
| Run Hub CTA hidden behind mobile bottom nav | frontend/src/pages/RunHub.jsx | Added bottom spacing and first-run empty state |
| History edit/delete buttons unlabeled | frontend/src/pages/History.jsx | Icon buttons now have labels/titles and delete uses in-app confirmation |
| Community social buttons had numeric-only names | frontend/src/pages/Community.jsx | Like/comment controls now have accessible labels |
| Community duplicate athlete suggestions | frontend/src/pages/Community.jsx | Suggested users are deduped before render |
| Native browser alerts in Community save flow | frontend/src/pages/Community.jsx | Replaced with inline status text |
| Web build analyzed native-only packages | frontend/src/services/HealthService.js, frontend/src/services/StripeService.js | Native modules use runtime import wrappers |
| CORS errors polluted Railway logs | backend/src/app.js | Unknown origins are rejected quietly instead of throwing Express errors |
| Data export/delete controls missing | backend/src/routes/auth.js, frontend/src/pages/Settings.jsx | Added JSON export, account deletion confirmation, and broader user-data cleanup |
| Unavailable/speculative device integrations shown to users | frontend/src/data/devices.js, frontend/src/pages/Dashboard.jsx, frontend/src/pages/Profile.jsx | Removed Meta/Polar style coming-soon UI from normal surfaces |
| Phase 1 cleanup placeholders visible | frontend/src/pages/Dashboard.jsx, frontend/src/pages/Settings.jsx, frontend/src/pages/LogRun.jsx | Removed duplicate Dashboard quick check-in, Settings legacy distance card, Settings notifications placeholder, and leftover run-log `coming soon` copy |
| Account export/delete had incomplete table coverage | backend/src/lib/accountDataCoverage.js, backend/src/routes/auth.js, backend/scripts/check-account-data-coverage.js | Export/delete now share a coverage map, include social/PT/plans/device/user-owned data, exclude secrets, and ship with a coverage script |
| Account deletion only required typed DELETE | backend/src/routes/auth.js, frontend/src/pages/Settings.jsx | Delete account now requires current password plus typed `DELETE`; missing/invalid password blocks deletion |

## Authorization Model

- Activity photos use owner-scoped writes and public authenticated reads by design. `POST /api/social/:activity_type/:activity_id/photo` in `backend/src/routes/social.js` validates parent activity ownership before insert/update, while `GET /api/social/:activity_type/:activity_id/photo` returns media to any signed-in user so public feed photos render consistently.

## 2026-04-28/29 QA and Product Hardening

These changes are already implemented, built, Capacitor-synced, and deployed to Railway unless noted otherwise.

### Production Deployments

| Date | Deployment | Status | Notes |
|------|------------|--------|-------|
| 2026-04-28 | `e07a7201-2f3d-46ce-bd77-e2eb2ae2c61a` | Success | Demo diagnostics hard-deny shipped |
| 2026-04-28 | `72915e0e-dc21-49d7-a3a5-2d0741a835af` | Success | Daily coach/product polish shipped |
| 2026-04-28 | `58c1cfdf-828a-4f18-b851-b9fc76bce371` | Success | Audit/CORS/privacy/device hardening shipped |
| 2026-04-29 | `f8aeebb0-5823-4e13-96ab-ec161a7a62e8` | Success | Phase 1 ship-critical cleanup shipped |
| 2026-04-29 | `31ecd563-a1ed-40a7-90d6-46aa697176a4` | Success | Phase 2 account/data safety shipped |
| 2026-04-29 | `41c67eef-03a3-497a-a29d-3d5c32459114` | Success | Phase 3 Settings restructure shipped |
| 2026-04-29 | `b3548f02-4baf-49ec-8d66-89b26dc52b6d` | Success | Phase 4 Daily Coach UX shipped |
| 2026-04-29 | `48abebe9-493b-41df-b7f3-852f218e8e09` | Success | Phase 5 TestFlight debugging tools shipped |
| 2026-04-29 | `30099833-f7e9-4e38-bdec-434fcb7bf012` | Success | Claude QA security fixes redeployed |
| 2026-04-29 | `b2836789-bdb5-47f2-8d30-2e7a1a811212` | Success | Forgot-password email fixed via Resend API transport |

### Build/Test Status

- `npm audit`: `0 vulnerabilities`
- `npm run build`: passes on Vite `6.4.2`
- `npx cap sync ios`: passes
- Phase 1 local browser smoke passed for Dashboard, Settings, Profile, Run Hub; no console errors found.
- Phase 2 `npm run check:account-data`: passes, 42 user-owned tables checked.
- Phase 2 export smoke: includes metadata/categories and user-owned datasets; account/settings/token rows exclude `password_hash`, Garmin credentials, token secrets, push auth keys, and media binary data.
- Phase 2 deletion guard smoke: `/api/auth/account` rejects typed `DELETE` without current password.
- Phase 3 Settings smoke: Preferences, Devices, Privacy, Account render; delete password guard expands; no console errors found.
- Phase 4 local and production smoke: Today detail sheet opens, More insights expands, and no console errors were reported.
- Phase 5 local and production smoke: seven-tap Settings version unlock opens TestFlight Debug panel, sanitized payload renders, and no console errors were found.
- Phase 6 final QA: `npm run build`, `npm audit`, `npm run check:account-data`, and `npx cap sync ios` pass.
- Phase 6 production mobile smoke: Dashboard, Settings, Profile, Run Hub, History, and Community render with no console errors.
- Phase 6 export/account safety smoke: export returns metadata plus 43 categories without `password_hash`; delete account rejects typed `DELETE` without current password.
- Phase 6 admin safety smoke: demo user receives `403` from `/api/diagnostics`; unauthenticated `/api/diagnostics` and `/api/meta/build` return `401`.

### Product Changes Shipped

- Dashboard now has a compact `Today` flow: check in -> train -> reflect.
- Oversized dashboard warm-up card was removed.
- Duplicate Dashboard quick check-in prompt was removed from below the Today flow.
- Help modal is user-support focused by default; admin diagnostics only render for authorized admins.
- Profile injury controls were consolidated into Injury Mode + dedicated Injury Log.
- Speculative Meta/Ray-Ban prompts were removed from Dashboard/Profile.
- Run Hub empty state now guides first-run users through warm-up and run logging.
- Settings now has Preferences, Devices, Privacy, and Account sections.
- Data export moved into Privacy.
- Account deletion moved into Account and requires typed `DELETE` plus current-password confirmation.
- Garmin, Strava, WHOOP, and Oura have consistent status, connect, sync, and revoke controls.
- Settings legacy distance-unit and notifications placeholder cards were removed.
- Device registry only exposes available integrations: Apple Watch, Garmin, WHOOP, Oura.
- Dashboard Today flow is primary and now owns the daily recommendation.
- Today detail sheet explains recommendation reason, readiness drivers, actions, and plan-adjustment signals.
- Secondary dashboard cards now live behind `More insights`.
- Settings has a hidden TestFlight Debug panel behind seven taps on the version label.
- Debug metadata is copyable as JSON when allowed, and production access is gated by local runtime, `VITE_ENABLE_TESTFLIGHT_DEBUG`, or `VITE_DEBUG_ADMIN_EMAILS`.

### Dependency/Native Notes

- `frontend/package.json` now uses:
  - Vite `^6.4.2`
  - `overrides["@xmldom/xmldom"] = ^0.9.10`
  - `overrides["xcode"].uuid = ^14.0.0`
- Do not re-add an `esbuild` major-version override. It cleared audit temporarily but broke Vite transpilation.
- Native bundle identifiers are aligned to `com.zordon.forge`.
- iOS build number was bumped to `8`.

### Current Known Risks / Follow-Up

- EAS is blocked until May 1, 2026 by Apple Developer login/2FA, not by source/build issues.
- Before the TestFlight build, set either `VITE_ENABLE_TESTFLIGHT_DEBUG=true` or `VITE_DEBUG_ADMIN_EMAILS` for approved testers/admins if the hidden debug panel should expose copyable payloads in TestFlight.
- Data-heavy screens can show the Forge loading runner for a few seconds while production API calls resolve; no console errors were observed during Phase 6 smoke.
- Dashboard Phase 4 is shipped: Today, Readiness, and Recent Activity are primary; secondary insight cards are behind `More insights`.

## Completed Phases

### Phase 1 — Ship-Critical Cleanup — Complete 2026-04-29

- [x] Removed duplicate Dashboard check-in prompts.
- [x] Removed Settings `Legacy Distance Units`.
- [x] Removed Settings `Notifications coming soon`.
- [x] Replaced leftover run-log `Feedback coming soon...` copy with a concrete saved/sync message.
- [x] Confirmed no remaining user-facing `coming soon` copy in `frontend/src/pages` or `frontend/src/components`.
- [x] Verified `npm run build` passes.
- [x] Quick browser smoke test passed: Dashboard, Settings, Profile, Run Hub.

### Phase 2 — Account/Data Safety — Complete 2026-04-29

- [x] Audited every DB table with `user_id`, `follower_id`, `following_id`, or `created_by_user_id`.
- [x] `/auth/me/export` now includes all tracked user-owned datasets and excludes secrets.
- [x] `/auth/account` now deletes tracked user-owned rows, social edges, and dependent interaction rows.
- [x] Account deletion requires typed `DELETE` plus current-password confirmation.
- [x] Export includes generated time, categories included, backend version, and explicit secret exclusions.
- [x] Added `npm run check:account-data` to compare user-owned tables against export/delete coverage.

### Phase 3 — Settings Restructure — Complete 2026-04-29

- [x] Split Settings into clear sections: Preferences, Devices, Privacy, Account.
- [x] Moved data export into Privacy and account deletion into Account.
- [x] Moved Garmin/Strava/WHOOP/Oura into Devices.
- [x] Kept theme/language/units in Preferences.
- [x] Made each device row consistent: status, last sync, connect, sync, revoke.
- [x] Added empty/disconnected states without `coming soon` copy.

### Phase 4 — Daily Coach UX — Complete 2026-04-29

- [x] Turned the Dashboard Today flow into the primary top card.
- [x] Added a Today detail sheet with readiness reason, recommendation reason, warm-up, start/log, and reflect actions.
- [x] Moved lower-priority cards behind `More insights`.
- [x] Added plan-adjustment signals explaining missed sessions, recovery mode, check-in, sleep, steps, and watch-sync effects.
- [x] Reduced first-viewport dashboard card count to Today, Readiness, More insights, and Recent Activity.

### Phase 5 — TestFlight Debugging Tools — Complete 2026-04-29

- [x] Added hidden build/debug panel behind seven taps on the Settings version label.
- [x] Shows app version, build number, backend URL, Railway deployment id if available, user id, environment, bundle id, runtime, host, and platform.
- [x] Added copy-to-clipboard for debug info with a visible JSON fallback when the local browser blocks clipboard access.
- [x] Added authenticated `/api/meta/build` endpoint for sanitized backend/build metadata.
- [x] Production access is restricted unless `VITE_ENABLE_TESTFLIGHT_DEBUG=true`, `VITE_DEBUG_ADMIN_EMAILS` includes the user, or the app is running locally.

### Phase 6 — Final Internal QA Pass — Complete 2026-04-29

- [x] Ran `npm audit`.
- [x] Ran `npm run build`.
- [x] Ran `npm run check:account-data`.
- [x] Ran `npx cap sync ios`.
- [x] Browser smoke tested mobile viewport for Dashboard, Settings, Profile, Run Hub, History, and Community.
- [x] Verified production Railway deployment `48abebe9-493b-41df-b7f3-852f218e8e09`.
- [x] Verified demo user cannot access admin diagnostics.
- [x] Verified export works and account deletion confirmation blocks accidental deletion.
- [x] Documented remaining known risks before Claude Code full QA.

## Superseded Markdown Docs

Only `README.md`, `CLAUDE.md`, and `FORGE.md` should be treated as active top-level project documentation.

Superseded docs that were consolidated:
- `APP_STORE_README.md` — app store requirements and description moved to `README.md`.
- `DEPLOY-IOS.md` — EAS/TestFlight credential and non-interactive build guidance moved to `README.md`.
- `FORGE-RELEASE-CHECKLIST.md` — release status language moved to `CLAUDE.md`.
- `QA-CHECKLIST.md` — active QA rules live in `CLAUDE.md`; phase status lives here.
- `QA-REPORT-2026-04-17.md` — historical QA report superseded by the current fixed-bug table and 2026-04-29 QA fixes.
- `QA-PHASE-1AB-2026-04-22.md` — old phase checklist superseded by the completed phase log above.
- `BUILD-SPEC-2026-04-22-forge-roadmap.md` — old product roadmap archived as historical backlog context, not active implementation instructions.
- `BUILD-SPEC-2026-04-22-onboarding-dashboard-cleanup.md` — old onboarding/dashboard cleanup spec superseded by current frontend implementation.
- `CLAUDE-MIGRATION.md` and `QA-CHECKLIST-MIGRATION.md` — archived Next.js migration notes; Forge's active app remains this React/Vite/Capacitor repo unless a migration is explicitly restarted.
