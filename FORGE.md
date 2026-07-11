# FORGE.md — Project History and Release State

This file holds Forge's product history, deployment notes, shipped phase log, known risks, and archived document context. Keep `CLAUDE.md` focused on agent rules and QA constraints.

## Current Production

- Production URL: `https://forge-production-773f.up.railway.app/`
- Latest checked deployment: `84c9b107-8b86-496c-9757-bd5c9e87ac74`
- Latest checked bundle: `/assets/index-CvpmYLna.js`
- iOS version/build: `1.0.5` / `5`
- Bundle identifier: `com.zordontech.forge`
- Expo/EAS project: `@zordon/forge-athlete` (`6aeb5fbb-2697-4cf4-b9b3-afe60c63e9e1`)

Current production checks:
- Demo diagnostics check returns `403`.
- `/api/auth/me/export` returns account/training data and excludes `password_hash`.
- `/api/auth/forgot-password` returns `200 email_sent` for `demo@forge.app` in under one second.
- EAS/TestFlight preflight resumed on May 3, 2026 after Apple Developer credentials became available.

## Active Architecture Decision — Current Shipping Path

`forge-app` is the active Forge repo. Its Expo/EAS build target is the existing `@zordon/forge-athlete` project, which owns the prior TestFlight build history. It owns:
- Railway production backend and web frontend
- React/Vite/Capacitor app shell
- EAS/TestFlight build path through `frontend/app.json`, `frontend/eas.json`, and `scripts/deploy-ios.sh`

`forge-nextjs` is future migration research, not the current production target. `forge-native` is a separate native experiment unless Bryan explicitly revives it. Do not dispatch build work there for the current Forge release.

The workspace-level `BUILD-SPEC-2026-04-24-forge-cross-platform-flow.md` has useful ideas around OpenAPI, Sentry, feature flags, and e2e coverage, but it assumes `forge-app` is deprecated. That assumption is stale. Any useful process/architecture ideas from that spec must be rewritten against this active `forge-app` stack before implementation.

## Product Direction — Hybrid Runner/Lifter Reframe (2026-05-03)

Bryan's current direction: FORGE is **not** a generic athlete platform. Position it for hybrid runners/lifters — people trying to run, lift, recover, and adapt their plan without guessing which signal matters.

### Product Promise

FORGE should feel like a plain-English coach for today's training decision:
- What should I do today?
- Why did my readiness/wearable data change that answer?
- What should change in my plan, and can I apply it safely right now?
- How do my running, lifting, recovery, and goals connect over time?

### Build Priorities

1. **Today as the main coaching surface** — keep Today as the first screen and primary decision point: check in, train, reflect, and understand the recommendation.
2. **Recovery-adjusted plan changes users can apply** — recommendations should become explicit plan edits/alternatives the user can accept, not just passive insights.
3. **Plain-English wearable/recovery explanation** — explain WHOOP/Oura/Apple Watch/Garmin-style recovery signals in normal language: what moved, why it matters, and what to do.
4. **Reliability/TestFlight polish before breadth** — prioritize login/session stability, loading states, TestFlight debug visibility, sync confidence, and no-dead-end mobile flows before adding more surfaces.
5. **Privacy/export/delete and offline reliability as differentiators** — make data export, account deletion, secret exclusions, and offline/degraded-state behavior part of the trust story, not buried settings.

### Premium Conversion Spine

Premium should convert around capabilities that compound value for a hybrid runner/lifter:
- advanced AI coaching and deeper recaps
- unified recovery/readiness across wearable sources
- WHOOP/Oura integrations and richer wearable interpretation
- goal cascades from long-term targets to week/day actions
- deeper run/lift/recovery trend recaps with suggested next blocks

### Concrete Next Build Sequence

1. **Stabilize TestFlight/reliability gate** — complete EAS/TestFlight readiness, verify production auth/loading/debug paths, and keep the QA floor green.
2. **Tighten Today copy and hierarchy** — audit Dashboard/Today language so the app speaks to hybrid runners/lifters and makes the daily decision obvious.
3. **Ship apply-able recovery adjustments** — turn existing plan-adjustment signals into user-approved edits/alternatives for today's workout and near-term plan.
4. **Wearable explanation layer** — add plain-English readiness drivers for connected devices, starting with WHOOP/Oura where premium value is clearest.
5. **Premium gates and upgrade moments** — gate advanced AI, unified recovery, deeper recaps, goal cascades, and wearable depth after the core free Today loop proves reliable.

No app-code implementation was started from this reframe; it is planning/product direction only.

## Data Foundation Audit — Phase 1 (2026-05-13)

Current source-of-truth map before native Apple Health work:

| Source | Current intake | Storage | Used today | Status |
|--------|----------------|---------|------------|--------|
| Manual runs | `LogRun.jsx` -> `/api/runs` | `runs` | History, Dashboard stats, load analysis, next recommendation, PRs | Working |
| Manual lifts | `LogLift.jsx` / `ActiveWorkout.jsx` -> `/api/lifts`, `/api/workouts` | `lifts`, `workout_sessions`, `workout_sets` | History, Dashboard, AI lift feedback, training-load warnings | Working |
| Morning check-in | `DailyCheckIn.jsx` -> `/api/checkin` | `daily_checkins` | Today flow, readiness breakdown, recovery adjustment | Working |
| Race goals | `Races.jsx` -> `/api/races` | `race_events` | Race countdown, plan generation target | Working |
| File import | Settings file upload -> `/api/import/workouts` or `/api/import/health` | `runs`, `lifts` | History, Dashboard stats, recommendations | Working for Garmin/Strava-style CSV and workout JSON |
| Watch-sync API | `/api/watch-sync` and `/api/watch-sync/upload` | `watch_sync`, plus routed `runs`/`lifts` | Dashboard watch notice, readiness gate, history | Backend works; no native phone collector yet |
| Health summary sync | `HealthService.syncToProfile()` -> `/api/health/sync` | `health_sync` | Dashboard health card only | Backend works; native bridge source added in Phase 2 |
| Apple Health / Apple Watch | Native HealthKit bridge in `ForgeHealthPlugin.swift` | `health_sync`, imported `runs`/`lifts` | Settings sync button, Dashboard health card, recommendations after import | Requires a new EAS/TestFlight binary before phone QA |
| Garmin direct | Settings status/revoke plus legacy backend route | `user_settings`, `garmin_sleep`, `watch_sync`, `runs` | Paused copy in Settings | Paused until official Garmin API access |
| Strava OAuth | Settings device row -> `/api/strava/*` | `strava_tokens`, imported `runs` | History/Dashboard after sync | Available if env/app config is live |
| WHOOP/Oura OAuth | Settings device rows -> `/api/whoop/*`, `/api/oura/*` | `whoop_*`, `oura_*` | Unified recovery endpoint | Premium integration path exists; depends on provider env/config |

## Watch Delivery Foundation (2026-05-27)

Forge now has a provider-neutral watch delivery layer in `frontend/src/services/WatchDeliveryService.js`.

- `WatchDeliveryService.buildStructuredWorkout()` converts Forge run/lift recommendations into a portable schema with goal, steps, targets, notes, and fallback text.
- `WatchWorkoutSendButton` is now labeled **Send to Watch** instead of Apple-specific copy.
- Settings shows one clean Watch Delivery card with adapter slots for Apple Watch, Garmin, COROS, TrainingPeaks, Polar, Suunto, and Wahoo.
- Apple Watch remains the only direct in-app send path today via WorkoutKit.
- Garmin, COROS, TrainingPeaks, Suunto, and Wahoo remain pending partner/API approval before direct workout push can ship.
- Polar remains planned; data access is clearer than workout push, so provider validation is still needed.

Provider applications Bryan should submit next:
1. Garmin Training/Courses API access.
2. COROS partner API access.
3. TrainingPeaks API access as the broad bridge to Garmin/COROS/Polar/Suunto/Wahoo.
4. Suunto Cloud API access.
5. Wahoo Cloud API access.

Phase 1 cleanup from this audit:
- Dashboard/HealthService now states that native Apple Health sync is not wired in TestFlight yet instead of surfacing a `react-native-health` implementation detail.
- Challenges step-copy now points users to File Import/manual entry until native Apple Health ships.
- Device registry marks Apple Watch as `coming_soon` until the HealthKit bridge is implemented.
- Recovery source comments now reflect that Apple Health is present only when imported/synced rows exist.

Phase 2 cleanup from this audit:
- Added a Capacitor `ForgeHealth` iOS plugin backed by HealthKit read permissions for steps, active calories, weekly running/walking distance, workouts, and average heart rate from the latest run.
- Added HealthKit entitlement and native `NSHealthShareUsageDescription` so the next EAS binary can request Apple Health access.
- `HealthService` now routes native iOS through the bridge, saves metrics to `/api/health/sync`, imports workouts through `/api/import/health`, and shows a clear "update TestFlight" message on older binaries that do not contain the plugin.
- Settings now exposes `Sync Apple Health` inside the native app for Pro users. Dashboard still reads passively and tells users to grant permission from Settings first.
- No EAS/TestFlight build was shipped in Phase 2; phone QA must happen before Bryan approves the next EAS build.

## Elevation-Aware Run Routes (2026-07-11)

- The Today run card exposes a Pro route planner when `OPENROUTESERVICE_API_KEY` is configured on Railway.
- A prescribed distance can be planned as a road or trail loop with flat, rolling, or hilly terrain preference.
- The backend compares three deterministic OpenRouteService round-trip candidates, selects by relative elevation gain, caches candidates for 20 minutes, and limits each user to eight generation requests per 15 minutes.
- Generated routes are private and ephemeral. They are not inserted into `shared_routes`; the selected course is passed to Active Run as a planned overlay, separate from recorded GPS points.
- Active Run now calculates phone-recorded elevation gain/loss from smoothed GPS altitude, saves it with the run, and shows gain in run details. Planned elevation is never substituted for measured elevation.
- The first release is course preview plus on-run map overlay, not turn-by-turn navigation or off-route alerts. Users are told to review crossings, access rules, and current conditions.
- This web/backend release does not require an EAS build. Production route generation remains hidden until the server-side provider key is present.

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
| 2026-04-29 | `59a652bf-1df5-4a17-a4a6-4b729b31c959` | Success | Medium/low QA cleanup shipped and live-verified |
| 2026-04-29 | `7a835cf8-f03b-4c97-a0e3-13faee61e88a` | Success | App loading fallback labeled and browser-verified |
| 2026-04-29 | `c44b1fa4-f558-4b36-87c5-afc970b3a954` | Success | Docs-only redeploy after recording loading fallback release |
| 2026-04-29 | `6b496dab-8e0a-40dc-b952-dc9dd0790d48` | Success | Deployment-id doc bump built and production-verified |
| 2026-05-02 | `84c9b107-8b86-496c-9757-bd5c9e87ac74` | Success | Phase 1 TestFlight readiness audit verified current production bundle |

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
- Device registry exposes live provider rows and marks Apple Watch as coming soon until native HealthKit sync ships.
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
- Native bundle identifiers are aligned to `com.zordontech.forge`.
- EAS production iOS builds are pinned to `macos-sequoia-15.6-xcode-26.2` for App Store Connect's iOS 26 SDK requirement.
- iOS build number was bumped to `5`.

### Current Known Risks / Follow-Up

- EAS/TestFlight preflight resumed on May 3, 2026; source/build readiness is handled in the current EAS phases.
- Phase 4 EAS build `1.0.5 (4)` reached App Store Connect on 2026-05-04 but failed upload validation because it used the wrong bundle identifier and the iOS 17.5 SDK. Build `1.0.5 (5)` restores `com.zordontech.forge` and pins the Xcode 26.2 EAS image.
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

Only `README.md`, `CLAUDE.md`, `FORGE.md`, and `QA-CHECKLIST.md` should be treated as active top-level project documentation.

Superseded docs that were consolidated and removed:
- `APP_STORE_README.md` — app store requirements and description moved to `README.md`.
- `DEPLOY-IOS.md` — EAS/TestFlight credential and non-interactive build guidance moved to `README.md`.
- `FORGE-RELEASE-CHECKLIST.md` — release status language moved to `CLAUDE.md`.
- `QA-REPORT-2026-04-17.md` — historical QA report superseded by the current fixed-bug table and 2026-04-29 QA fixes.
- `QA-PHASE-1AB-2026-04-22.md` — old phase checklist superseded by the completed phase log above.
- `BUILD-SPEC-2026-04-22-forge-roadmap.md` — old product roadmap archived as historical backlog context, not active implementation instructions.
- `BUILD-SPEC-2026-04-22-onboarding-dashboard-cleanup.md` — old onboarding/dashboard cleanup spec superseded by current frontend implementation.
- `CLAUDE-MIGRATION.md` and `QA-CHECKLIST-MIGRATION.md` — archived Next.js migration notes; Forge's active app remains this React/Vite/Capacitor repo unless a migration is explicitly restarted.
