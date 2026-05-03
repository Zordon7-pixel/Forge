# FORGE

Forge is a fitness tracking app for running, lifting, readiness, and AI-assisted training guidance.

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

Latest known production deploy:
- Railway deployment: `84c9b107-8b86-496c-9757-bd5c9e87ac74`
- Frontend bundle: `/assets/index-CvpmYLna.js`
- iOS version/build: `1.0.3` / `8`
- Bundle identifier: `com.zordon.forge`

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
FORGE is a fitness tracking app built for athletes who want clarity, consistency, and progress. Log workouts, track training volume, and review trends over time. FORGE keeps your training history organized so you can focus on performance and recovery.
```
