# FORGE

Forge is a coaching app for hybrid runners/lifters — people balancing miles, strength work, readiness, and recovery without wanting a generic athlete dashboard.

Active project docs:
- `README.md` is the human-facing setup, deploy, and store-submission guide.
- `CLAUDE.md` is the source of truth for agents, QA rules, shipped fixes, security constraints, and release handoffs.
- `FORGE.md` holds product history, deployment notes, shipped phases, known risks, and archived context.
- `QA-CHECKLIST.md` is the per-diff review floor; use the `pre-launch-audit` skill for full release QA.

## Stack

- Backend: Node.js, Express, SQLite for local development, PostgreSQL on Railway
- Frontend: React, Vite, Capacitor
- iOS app: Expo/EAS metadata in `frontend/app.json`, Capacitor native shell in `frontend/ios`
- Production: `https://forge-production-773f.up.railway.app/`

## Active Architecture

This repo, `forge-app`, is the active production and TestFlight path. It owns the Railway backend, web frontend, and Capacitor iOS shell currently being shipped.

Do not dispatch new implementation work to `forge-nextjs` or `forge-native` unless Bryan explicitly restarts one of those tracks. Treat `forge-nextjs` as future migration research and `forge-native` as a separate native experiment, not the current release target.

The workspace-level `BUILD-SPEC-2026-04-24-forge-cross-platform-flow.md` is useful architecture research, but it is not the active implementation plan for this shipping app. If we want OpenAPI, Sentry, feature flags, or cross-platform e2e now, rewrite those specs against this `forge-app` stack first.

Latest verified application release (docs-only commits may create a later Railway deployment with the same bundle):
- Commit: `44bdb4f7`
- Railway deployment: `6d410bad-6436-4832-b511-e68391bb1ae8`
- Frontend bundle: `/assets/index-BkNTEfzQ.js`
- iOS version/build: `1.0.5` / `15`
- Bundle identifier: `com.zordontech.forge`
- Expo/EAS project: `@zordon/forge-athlete` (`6aeb5fbb-2697-4cf4-b9b3-afe60c63e9e1`)

## Install

```bash
npm run install:all
```

## Local Development

```bash
cd backend
node src/app.js
```

```bash
cd frontend
npm run dev
```

For a production-style local build:

```bash
cd frontend
npm run build
cd ../backend
PORT=4003 node src/app.js
```

## Verification

Run these before handoff after backend, frontend, account-data, or native-shell changes:

```bash
cd frontend && npm run build
cd frontend && npm audit --audit-level=high
cd backend && npm run check:account-data
cd frontend && npx cap sync ios
```

## Railway Deploy

Railway deploys the production app from the GitHub repo. Do not call a source change shipped until the Railway build/deploy succeeds and the live production behavior is checked.

```bash
git push origin main
```

Production health target:

```text
https://forge-production-773f.up.railway.app/
```

## iOS and TestFlight

EAS/TestFlight preflight resumed on May 3, 2026 after Apple Developer credentials became available.

Bryan does not run terminal commands. After the one-time App Store Connect credential setup is complete, builds must be non-interactive:

```bash
cd frontend
eas build --platform ios --profile production --non-interactive --no-wait
eas submit --platform ios --latest --non-interactive
```

One-time Apple-side setup:
- Generate an App Store Connect API key named `forge-eas-ci` with App Manager access.
- Save the downloaded `.p8` key securely.
- Configure the key, distribution certificate, and provisioning profile in EAS credentials for the production profile.
- Future EAS builds should fail loudly with `--non-interactive` if credentials are missing instead of prompting.

## App Store Assets

Required before submission:
- App icon: 1024x1024 PNG
- Splash screen: 2732x2732 PNG
- Screenshots: five per required device class
- Privacy policy URL: use the Forge privacy route or final hosted policy URL, not a placeholder
- App Store description:

```text
FORGE is built for hybrid runners/lifters who want one plain-English coach for miles, strength work, readiness, and recovery. FORGE turns today's plan, wearable signals, and recent training into clear actions you can apply — adjust the workout, protect recovery, and keep building without guessing.
```
