# FORGE.md — Project History and Release State

This file holds Forge's product history, deployment notes, shipped phase log, known risks, and archived document context. Keep `CLAUDE.md` focused on agent rules and QA constraints.

## Current Production

- Production URL: `https://forge-production-773f.up.railway.app/`
- Latest verified application release: commit `cd14b1bf`, deployment `dc344e3d-21f5-495c-807c-7510a8323d42`
- Latest checked bundle: `/assets/index-BchGiqME.js`
- iOS version/build: `1.0.5` / `15`
- Bundle identifier: `com.zordontech.forge`
- Expo/EAS project: `@zordon/forge-athlete` (`6aeb5fbb-2697-4cf4-b9b3-afe60c63e9e1`)

Current production checks:
- H12 Apple Health activity classification, athlete-specific heart-rate zones, workout-metric integrity, and data-coverage UI verified live.
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
| Health summary sync | `HealthService.syncToProfile()` -> `/api/health/sync` | `health_sync` | Body overview, readiness, plan provenance, and bounded plan generation/adaptation context | Expanded H11 backend and web surfaces verified live |
| Apple Health / Apple Watch | Native HealthKit bridge in `ForgeHealthPlugin.swift` | `health_sync`, imported `runs`/`lifts` | Settings sync, Body metrics, activity history, recent run load, recovery, cardio fitness, running form, routes, elevation, and workout context | H12 web/backend classification and exact-zone handling are ready for Railway; schema-v3 native route/dynamics reads require a later Bryan-approved EAS build and phone QA |
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

## HR Zone Calibration

- The default model is heart-rate reserve (Karvonen), computed from maximum and resting heart rate. Percent-of-max and LTHR remain supported alternatives; LTHR is opt-in through the guided field test.
- `user_hr_profile` is the persisted source of truth. `backend/src/lib/hrZones.js` and `backend/src/lib/hrCalibration.js` own deterministic zone calculation, history-derived suggestions, and BPM classification.
- Heat-drift and readiness classification prefer the calibrated profile. Users without a usable profile retain the pre-calibration max-HR fallback.
- The derive flow flags an observed run maximum above the stored maximum and suggests a correction, but never overwrites the profile without user confirmation.
- The field-test path calculates LTHR as 95% of the user's 20-minute time-trial average heart rate.
- H5 closed the execution gap: generated plan zone labels now resolve to the user's calibrated BPM range when a usable heart-rate profile exists, without changing the stored plan contract.

## Unified Hybrid Plan H1-H6 (2026-07-13)

- The Plan surface is now the single training calendar for run-only and hybrid plans. Create/Manage Plan and Races remain reachable through its setup/manage flow instead of competing navigation entries.
- Home, Train, Lift, and Plan share the canonical daily execution contract. An active calendar day cannot be replaced by a disconnected recommendation.
- Existing user-owned legacy plans remain readable through the calendar without a read-time write; normal progress actions perform the existing scoped lazy migration.
- AI-generated coaching, feedback, recommendation, and plan-rationale surfaces use the shared inline `AI guidance — not medical advice.` note. Deterministic metrics and static fallback copy do not trigger it.
- H6 passed Claude Code QA after the deterministic-health disclaimer guard was corrected. H1-H6 smokes, frontend build, both high-severity audits, 47-table account-data coverage, and Capacitor sync passed.
- Production computer-use verified one Plan destination, the legacy calendar, the same 4-mile workout across Home/Plan/Train, preserved setup/race routes, and no browser console errors. No EAS build was run.

## Race-First Plan Builder H8 (2026-07-13)

- Create / Manage Plan now starts with race search by event name or location, while manual race entry and no-race distance blocks remain available.
- Selecting a catalog race pre-fills its canonical name, date, distance, location, and trusted course summary. Race import is idempotent per owned edition and preserves an existing goal time when no replacement is supplied.
- Race setup uses a native date calendar and separately captures available weekdays, run frequency, optional strength mode/frequency, equipment, and goal time.
- AI plan requests have a 75-second backend abort and a 90-second frontend request window. Invalid, malformed, or timed-out AI output reaches the deterministic concurrent-plan fallback for both ordinary and race-specific generation routes.
- H8 passed 39 focused checks, H1/H3/H4/H5/H6 and legacy smokes, both dependency audits, 47-table account-data coverage, frontend build, Capacitor sync, and two independent Claude Code reviews.
- Production verified the exact `/assets/index-CQXv4o1G.js` bundle, authenticated Army Ten-Miler and Washington DC search, `401` unauthenticated catalog access, and a 390px mobile layout without horizontal overflow. No EAS build was run.

## Recent-Run Adaptive Safety H9 (2026-07-13)

- New plans now use the latest meaningful run's exact distance, duration, computed pace, average heart rate, RPE, trailing seven-day volume, current Apple Health readiness metrics, and today's check-in instead of relying only on aggregate history.
- A recent long or hard run creates a deterministic 24-72-hour protection window: no duplicate same-day run, no conflicting demanding run, and no lower-body strength inside the recovery window. Lower-body work swaps or relocates to preserve the weekly strength floor when a safe slot exists.
- Recovery substitutions replace stale hill/interval instructions, and persisted legacy recovery sessions receive the same display-time safety guard.
- TestFlight build 15 contains the WorkoutKit plugin class but omitted its Capacitor registration. `AppViewController` now registers `ForgeWatchWorkoutPlugin`; automatic Apple Watch delivery requires a future approved build 16, while manual entry remains available.
- H9 passed 32 focused checks, H3/H4/H8 regression smokes, Watch diagnostics smoke, frontend build, dependency audit, 47-table account-data coverage, Capacitor sync, Swift parse, and two independent Claude Code reviews.
- Production verified `/assets/index-IHa1ZhZv.js`, authenticated plan reads, `401` unauthenticated plan access, a 390x844 plan layout without horizontal overflow, and zero browser console errors. No EAS build was run.

## Prescription Integrity and Strength Detail H10 (2026-07-13)

- Persisted plans can no longer present a Recovery / Zone 1-2 label while retaining hill repeats, intervals, tempo work, or steady-effort instructions. The backend repairs contradictory responses without mutating stored data, and the frontend applies the same guard before display, Start Run, watch delivery, or manual copy.
- Every generated strength exercise now includes working sets, reps, between-set rest, load guidance, RPE/RIR, form cue, and progression. The day view exposes the total working sets and a compact `Why these numbers` explanation.
- Exact starting weights require a recent usable set from the same named exercise and implement modality. Barbell and dumbbell history cannot cross-calibrate. With no defensible match, the plan uses RPE/RIR and asks the athlete to log the completed load instead of inventing pounds.
- Plan phase, strength mode, available equipment, run/lift history, Apple Health readiness, and check-in evidence have bounded roles. Apple Health and check-ins can reduce first-week volume/effort; watch data never estimates a lifting load from heart rate, sleep, or steps.
- H10 passed 24 focused checks, H1/H3/H4/H5/H6/H8/H9 regressions, 17 calendar checks, all other frontend smokes, frontend build, zero-vulnerability audit, 47-table account-data coverage, Capacitor sync, and two Claude Code reviews. Claude verdict: PASS — Ship.
- Production verified `/assets/index-CGU9ymkK.js` and `/assets/Plan-DP5Af5aD.js`, the new prescription rationale/detail copy, authenticated plan reads, a 390x844 mobile plan render, and zero browser console errors. No EAS build was run.

## Apple Health Training Intelligence H11 (2026-07-13)

- The native HealthKit bridge now covers training-relevant workout/load, activity, sleep stages and prior-night baseline, HRV/resting-HR athlete baselines, VO2 max, walking heart rate, one-minute heart-rate recovery, respiratory rate, and latest-run power/speed/stride/vertical-oscillation/ground-contact metrics.
- The authenticated `/api/health/sync` boundary validates and whitelists expanded metrics, stores them in the existing user-owned health row, preserves source timestamps, and exposes a flattened read contract. Stale or suspect recovery data is removed before Body, readiness, AI, or plan consumers see it.
- Plan generation keeps completed run/lift history as primary evidence. Fresh Apple Health data supplies bounded recovery, activity, cardio, and running-form context; it cannot independently increase training load or invent lifting weights.
- The Body screen groups activity, recovery, cardio fitness, and running-form data and explains how it informs the plan. Missing or stale inputs now say there is not enough recent data instead of claiming everything looks good.
- Collection remains purpose-limited. ECG, AFib, blood pressure, glucose, reproductive data, clinical records, and unrelated medical categories are not requested.
- H11 passed 36 focused behavioral checks, all H1/H3/H4/H5/H6/H8/H9/H10 regressions, heat-drift/interference checks, four frontend smokes, production build, zero-vulnerability audit, 47-table account-data coverage, Capacitor sync, Swift parse, and three Claude Code QA passes. Final verdict: PASS.
- Railway production verified `/assets/index-D-pIgSi3.js` and `/assets/HealthData-DRmOOl2D.js`; authenticated health/Body reads return `200`, unauthenticated reads return `401`, and invalid extended metrics return `400` without changing stored data. No EAS build was run; expanded native collection awaits Bryan's explicit approval.

## Apple Health Workout Integrity H12 (2026-07-13)

- Apple Health walks and cross-training keep their activity identity in History but are excluded from running mileage, pace trends, PRs, streaks, readiness run load, plan generation/adaptation, race analysis, and run-specific AI feedback. Manual run-to-walk edits also recompute or remove stale automatic run PRs.
- Heart-rate detail uses the athlete's saved profile instead of deriving zones from one workout's observed maximum. Users can copy five exact watch-zone boundaries; sparse zone timelines do not override a calibrated average-heart-rate classification.
- Native schema v3 adds workout-route coordinates, HealthKit elevation/weather metadata, HR sample coverage, cadence, and per-workout running dynamics when the source writes them. Validated Garmin CSV or structured JSON can supply Garmin-only metrics; absent values remain blank.
- Mobile QA at 390x844 verified Walk Detail, 129 bpm as Z2, 150 bpm as Z3 for boundaries 96/117/137/156/176, local workout dates, advanced metric cards, and no horizontal overflow or console errors.
- H12 passed 32 focused checks, all H1/H3/H4/H5/H6/H8/H9/H10/H11 regressions, shared safety smokes, frontend build, zero-vulnerability audit, 47-table account-data coverage, Capacitor sync, and Swift parse. Claude Code re-QA passed and Hermes approved the Railway merge.
- Commit `602251b0` is source-ready. No EAS build was run; schema-v3 native reads remain unavailable until Bryan explicitly approves a later EAS/TestFlight build and phone verification.

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
| Apple Watch plugin present but unreachable in TestFlight build 15 | frontend/ios/App/App/AppViewController.swift | Native plugin instances must be registered with the Capacitor bridge; fixed for the next approved iOS build (minimum build 16) |
| Recovery adaptation retained hill/interval steps | backend/src/lib/adaptationEngine.js, frontend/src/components/calendar/ForgedDayView.jsx | Recovery substitutions replace the full run prescription; legacy persisted sessions are normalized before display |
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
| Custom plan generation surfaced a generic failure after malformed/slow AI output | backend/src/services/ai.js, backend/src/routes/plans.js, frontend/src/pages/PlanCatalog.jsx | AI requests abort before the UI deadline and both plan routes select a deterministic fallback instead of failing the user flow |
| Apple Health walk counted as a run and workout-average HR appeared as Z5 | backend/src/lib/runActivity.js, backend/src/lib/hrZones.js, backend/src/routes/import.js, frontend/src/components/RunDetailModal.jsx | Preserve workout kind across import, exclude non-runs from running intelligence, and classify average HR only against a saved athlete profile or exact watch boundaries |

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
| 2026-07-13 | `0faa870b-fd59-4b9a-a4f6-fb2139149691` | Success | Unified Hybrid Plan H6 simplification, migration compatibility, and AI guidance labeling verified live |
| 2026-07-13 | `5fb0c377-aeea-43ce-83a2-aa52ad6705e5` | Success | H7 race-course intelligence, provenance trust gating, and privacy-safe GPX analysis verified live |
| 2026-07-13 | `f6c0aff8-7ce1-4847-b0a8-a2dd33e1ae16` | Success | H8 race-first plan search, calendar setup, and resilient plan generation verified live |
| 2026-07-13 | `141a52be-e978-4de7-a5d3-51e8fb520a3a` | Success | H9 exact recent-run adaptation, strength-floor protection, and build-aware Apple Watch diagnostics verified live |
| 2026-07-13 | `14fd2c37-40de-451b-9ac4-f47599c8aa99` | Success | H10 recovery-prescription integrity and data-backed strength details verified live |
| 2026-07-13 | `22655735-758a-40d2-bde0-cc9359fb9b3b` | Success | H11 expanded Apple Health training intelligence, freshness gates, plan provenance, and Body metrics verified live |
| 2026-07-14 | `dc344e3d-21f5-495c-807c-7510a8323d42` | Success | H12 Apple Health activity classification, exact HR zones, workout metrics, and data-coverage handling verified live |

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
- Phase H7 production smoke: Army 10-Miler resolves to trusted curated course facts; unauthenticated race/catalog/GPX requests return `401`; signed-in mobile Races and Plan views render without horizontal overflow or console errors.
- Phase H8 production smoke: exact bundle hash matches local build; Army Ten-Miler alias and Washington DC location searches return the canonical October 11 event; unauthenticated catalog returns `401`; mobile plan search renders at 390px without horizontal overflow.
- Phase H9 production smoke: exact `/assets/index-IHa1ZhZv.js` bundle matches the reviewed build; authenticated plan routes return `200`, unauthenticated current-plan access returns `401`, and the plan renders at 390x844 without horizontal overflow or console errors.
- Phase H10 production smoke: exact `/assets/index-CGU9ymkK.js` and `/assets/Plan-DP5Af5aD.js` assets match the reviewed build; new rationale/working-set/load-basis copy is live, authenticated plan routes return `200`, and the mobile plan renders without console errors.
- Phase H11 production smoke: exact `/assets/index-D-pIgSi3.js` and `/assets/HealthData-DRmOOl2D.js` assets match the reviewed build; health/Body auth boundaries return `401` unauthenticated and `200` signed in, empty data is described honestly, and rejected metrics perform no write.

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
