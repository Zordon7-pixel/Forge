# CLAUDE.md — Forge Project Intelligence

> **Read by: CW3 Codex (before building) AND Claude Code (before QA review)**
> Updated after every build. If you're building or reviewing, read this first.

---

## What This App Is

Forge is a **fitness tracking app** — running + lifting with AI coaching.
- Backend: Node.js/Express + SQLite (local dev) / PostgreSQL (Railway)
- Mobile: React Native (Expo) in `/Users/zordon/.openclaw/workspace/forge-native/`
- GitHub: `Zordon7-pixel/Forge` | Deploy: `git push origin main` → Railway auto-builds

---

## Stack

| Layer | Tech | Notes |
|-------|------|-------|
| Backend | Node.js + Express | `backend/src/` |
| Database | SQLite (local) / PostgreSQL (Railway) | `dbGet`, `dbRun` from db.js |
| Auth | JWT | `req.user.id` scopes ALL queries |
| AI | Anthropic SDK | Sonnet for complex, Haiku for frequent — see services/ai.js |
| Mobile | React Native (Expo) | `forge-native/` — separate repo/dir |
| Deploy | Railway | `forge-production-773f.up.railway.app` |

---

## Auth Model — Critical

Every route that touches data **must** scope to `req.user.id`. No exceptions.

```js
// CORRECT
await dbRun('DELETE FROM runs WHERE id=? AND user_id=?', [req.params.id, req.user.id]);

// WRONG — auth bypass fixed in this repo, don't reintroduce
await dbGet('SELECT * FROM runs WHERE id=? AND user_id=?', [id, req.user.id]);
await dbRun('DELETE FROM runs WHERE id=?', [id]); // ← SECURITY BUG
```

**This exact bug was found and fixed in routes/runs.js and routes/lifts.js.**

---

## Key Files

```
backend/src/
├── app.js                ← Route registration
├── middleware/auth.js    ← JWT verification, sets req.user
├── routes/
│   ├── runs.js           ← Run logging, history, missed runs
│   ├── lifts.js          ← Lift logging, history
│   └── auth.js           ← User auth + profile update
└── services/
    └── ai.js             ← All AI prompt functions (Sonnet + Haiku tiering)

forge-native/src/
├── screens/
│   ├── Login.js          ← Email validation added
│   ├── Register.js       ← Email + password validation added
│   └── History.js        ← Lift weight validation (> 0, not >= 0)
└── navigation/AppNavigator.js ← Auth flow, signIn race condition fixed
```

---

## AI Model Tiering — Critical, Do Not Change

Forge uses Anthropic SDK. Token cost is real. Model assignments are fixed:

| Function | Model | Reason |
|----------|-------|--------|
| `generateTrainingPlan` | `claude-sonnet-4-6` | Complex, infrequent |
| `generateWeeklyInsight` | `claude-sonnet-4-6` | Complex, weekly |
| `generateRaceAdjustment` | `claude-sonnet-4-6` | Complex, occasional |
| Everything else | `claude-haiku-4-5` | Frequent, simple feedback |

**Never put Sonnet on functions that fire on every run/lift log — that's $10/day at scale.**

---

## Prompt Injection Prevention

All user-controlled fields passed into AI prompts **must** go through `sanitize()`:

```js
function sanitize(val, maxLen = 200) {
  if (val === null || val === undefined) return '';
  return String(val).replace(/[\r\n]+/g, ' ').trim().slice(0, maxLen);
}
```

**Every prompt function in services/ai.js already does this. If you add a new prompt, sanitize ALL user fields before interpolation.**

---

## Input Validation Rules (already in place)

| Field | Validation |
|-------|-----------|
| `perceived_effort` | Must be 1–10 integer |
| `age` | Must be 10–110 |
| `weight_lbs` | Must be 50–700 |
| `max_heart_rate` | Must be 100–220 |
| `email` | Must match `/^[^\s@]+@[^\s@]+\.[^\s@]+$/` |
| `password` | Minimum 6 characters |
| Lift weight | Must be > 0 (not >= 0) |

---

## Env Vars (Railway)

| Var | Required | Notes |
|-----|----------|-------|
| `JWT_SECRET` | YES | |
| `DATABASE_URL` | YES | PostgreSQL on Railway |
| `ANTHROPIC_API_KEY` | YES | For all AI features |
| `APP_URL` | For reset email | Base URL used in password reset links |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | For reset email | SMTP delivery for forgot-password emails |
| `EMAIL_FROM` | For reset email | From address for forgot-password emails |
| `PORT` | No | Defaults to 4002 |

---

## Deploy Process

**Backend (Railway):**
```bash
git push origin main   # Railway auto-builds and deploys
# Health: https://forge-production-773f.up.railway.app/
```

**iOS (TestFlight):** Use `scripts/deploy-ios.sh` — fully non-interactive.
See `DEPLOY-IOS.md` for the one-time EAS credential setup.

> **Hard rule for any agent (Zordon, Hermes, Codex):** Bryan does not run terminal
> commands. If `eas build` complains about missing credentials, that's a one-time
> setup gap — fix it per `DEPLOY-IOS.md`, do NOT punt to Bryan with "run this in
> your terminal." Always pass `--non-interactive` so failures are loud, not prompts.

Before saying a fix is shipped, record whether it is only patched in source,
actually deployed successfully, visibly fixed in live production, and Bryan-verified.
Use `FORGE-RELEASE-CHECKLIST.md` for that release status handoff.

---

## Recently Fixed Bugs — Do NOT Reintroduce

| Bug | Where Fixed | Pattern |
|-----|------------|---------|
| Auth bypass in DELETE | routes/runs.js, routes/lifts.js | DELETE didn't include `AND user_id=?` |
| perceived_effort no validation | routes/runs.js | Accepted any value |
| Profile fields no range check | routes/auth.js | Age/weight/HR accepted anything |
| Prompt injection | services/ai.js | User input interpolated raw into prompts |
| Sign-in race condition | AppNavigator.js | profileLoading not set before token |
| Lift weight zero accepted | History.js | `< 0` should be `<= 0` |
| [H2] hashFile symlink bypass (2026-03-23, commit 8bbd950e) | lib/vault.js | path.resolve() doesn't follow symlinks — fixed with fs.realpathSync() before boundary check |
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

---

## 2026-04-28/29 Forge QA + Product Hardening State

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

Verified production URL:
- `https://forge-production-773f.up.railway.app/`
- Demo diagnostics check returns `403`.
- `/api/auth/me/export` returns account/training data and excludes `password_hash`.

### Build/Test Status

- `npm audit`: `0 vulnerabilities`
- `npm run build`: passes on Vite `6.4.2`
- `npx cap sync ios`: passes
- Railway deployment `f8aeebb0-5823-4e13-96ab-ec161a7a62e8`: success
- Production root returns `200`; deployed HTML now references `/assets/index-Bd-X6pJR.js`
- Railway deployment `31ecd563-a1ed-40a7-90d6-46aa697176a4`: success
- Production root returns `200`; deployed HTML now references `/assets/index-3Cl8KDb6.js`
- Local mobile smoke test passed for Dashboard, Settings, Profile, Run Hub, export endpoint, device revoke controls
- Phase 1 local browser smoke passed for Dashboard, Settings, Profile, Run Hub; no console errors found
- Phase 2 `npm run check:account-data`: passes, 42 user-owned tables checked
- Phase 2 export smoke: includes metadata/categories and user-owned datasets; actual account/settings/token rows exclude `password_hash`, Garmin credentials, token secrets, push auth keys, and media binary data
- Phase 2 deletion guard smoke: `/api/auth/account` rejects typed `DELETE` without current password
- Phase 2 Settings smoke: export, connected-device access, typed `DELETE`, and current-password controls render with no console errors
- Phase 2 production smoke: export metadata returns 43 categories, `daily_checkins` and `activity_feed` datasets are present, account excludes `password_hash`, and delete guard rejects missing password
- Phase 3 `npm run build`, `npm audit`, `npm run check:account-data`, and `npx cap sync ios`: pass
- Phase 3 Settings smoke: Preferences, Devices, Privacy, Account render; delete password guard expands; no console errors found
- Railway deployment `41c67eef-03a3-497a-a29d-3d5c32459114`: success
- Production root returns `200`; deployed HTML now references `/assets/index-Oq2k9GdK.js`
- Phase 3 production smoke: Settings sections render visually, device rows show status/connect actions, Privacy export renders, Account delete renders, and no console errors were reported
- Phase 4 `npm run build`, `npm audit`, `npm run check:account-data`, and `npx cap sync ios`: pass
- Phase 4 local smoke: Today detail sheet opens, More insights expands, and no console errors were reported
- Railway deployment `b3548f02-4baf-49ec-8d66-89b26dc52b6d`: success
- Production root returns `200`; deployed HTML now references `/assets/index-ko_7DMC6.js`
- Phase 4 production smoke: Today detail sheet opens, More insights expands, and no console errors were reported
- Phase 5 `npm run build`, `npm audit`, `npm run check:account-data`, and `npx cap sync ios`: pass
- Phase 5 local smoke: seven-tap Settings version unlock opens TestFlight Debug panel, sanitized payload renders, no console errors found
- Railway deployment `48abebe9-493b-41df-b7f3-852f218e8e09`: success
- Production root returns `200`; deployed HTML now references `/assets/index-BrfltiC5.js`
- Phase 5 production smoke: seven-tap Settings version unlock opens restricted panel for demo, copy action is hidden while restricted, and no console errors were reported
- `/api/meta/build` rejects unauthenticated requests with `401`
- Phase 6 final QA: `npm run build`, `npm audit`, `npm run check:account-data`, and `npx cap sync ios` pass
- Phase 6 production mobile smoke: Dashboard, Settings, Profile, Run Hub, History, and Community render with no console errors
- Phase 6 export/account safety smoke: export returns metadata plus 43 categories without `password_hash`; delete account rejects typed `DELETE` without current password
- Phase 6 admin safety smoke: demo user receives `403` from `/api/diagnostics`; unauthenticated `/api/diagnostics` and `/api/meta/build` return `401`
- EAS/TestFlight build is intentionally deferred until May 1 because Apple Developer credentials/2FA are unavailable before then

### Product Changes Shipped

- Dashboard now has a compact `Today` flow: check in → train → reflect.
- Oversized dashboard warm-up card was removed.
- Duplicate Dashboard quick check-in prompt was removed from below the Today flow.
- Help modal is user-support focused by default; admin diagnostics only render for authorized admins.
- Profile injury controls were consolidated into Injury Mode + dedicated Injury Log.
- Speculative Meta/Ray-Ban prompts were removed from Dashboard/Profile.
- Run Hub empty state now guides first-run users through warm-up and run logging.
- Settings now includes:
  - Preferences section for appearance, language, and units
  - Devices section for Garmin, Strava, WHOOP, Oura, Apple Health, and file import
  - Privacy section for data export
  - Account section for profile and account deletion
  - Data export
  - Account deletion with typed `DELETE` and current-password confirmation
  - Connected-device status, connect, sync, and revoke controls for Garmin, Strava, WHOOP, and Oura
- Settings legacy distance-unit and notifications placeholder cards were removed.
- Device registry only exposes available integrations: Apple Watch, Garmin, WHOOP, Oura.
- Dashboard Today flow is primary and now owns the daily recommendation.
- Today detail sheet explains recommendation reason, readiness drivers, actions, and plan-adjustment signals.
- Secondary dashboard cards now live behind `More insights`.
- Settings now has a hidden TestFlight Debug panel behind seven taps on the version label.
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

- EAS is blocked until May 1 by Apple Developer login/2FA, not by source/build issues.
- Before the TestFlight build, set either `VITE_ENABLE_TESTFLIGHT_DEBUG=true` or `VITE_DEBUG_ADMIN_EMAILS` for approved testers/admins if the hidden debug panel should expose copyable payloads in TestFlight.
- Data-heavy screens can show the Forge loading runner for a few seconds while production API calls resolve; no console errors were observed during Phase 6 smoke.
- Dashboard Phase 4 is shipped: Today, Readiness, and Recent Activity are primary; secondary insight cards are behind `More insights`.

---

## Proposed Next Phases Before Claude Full QA

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

---

## QA Checklist — Check Every Diff

- [ ] Every DELETE/UPDATE includes `AND user_id=?` (not just the SELECT)
- [ ] No `catch (_) {}` or empty catch blocks
- [ ] New AI prompts use `sanitize()` on all user-controlled fields
- [ ] New AI prompts use `claude-haiku-4-5` unless complex/infrequent (use Sonnet)
- [ ] New numeric inputs have range validation
- [ ] New routes have `auth` middleware
- [ ] No raw user input interpolated into SQL (parameterized only)
- [ ] React Native: new form fields validate before submit

---

## Dispatch Log

| Date | Agent | Action | Commit |
|------|-------|--------|--------|
| 2026-04-17 | forge-security-fixes (Sonnet 4.6) | Fixed C1 activity photo hijack — SELECT+UPDATE scoped to `AND user_id=?`, 403 guard added; fixed M1 silent catches (5 catch blocks); committed 4 audited-clean diffs (aiLimit, health, ai, feedback) | `9997eeb3` |
