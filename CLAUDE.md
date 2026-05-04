# CLAUDE.md — Forge Project Intelligence

> **Read by: CW3 Codex (before building) AND Claude Code (before QA review)**
> Updated after every build. If you're building or reviewing, read this first.

---

## What This App Is

Forge is a coaching app for **hybrid runners/lifters** — people balancing running, strength work, readiness, and recovery. Do not position it as a generic athlete tracker.
- Backend: Node.js/Express + SQLite (local dev) / PostgreSQL (Railway)
- Frontend/mobile shell: React + Vite + Capacitor in this repo
- GitHub: `Zordon7-pixel/Forge` | Deploy: `git push origin main` → Railway auto-builds

This repo is the active production/TestFlight target. Do not implement current Forge work in `forge-nextjs` or `forge-native` unless Bryan explicitly says to revive that track. Workspace-level cross-platform specs that describe `forge-app` as deprecated are stale for the current shipping path; translate any useful ideas back into this React/Vite/Capacitor + Express stack before building.

---

## Stack

| Layer | Tech | Notes |
|-------|------|-------|
| Backend | Node.js + Express | `backend/src/` |
| Database | SQLite (local) / PostgreSQL (Railway) | `dbGet`, `dbRun` from db.js |
| Auth | JWT | `req.user.id` scopes ALL queries |
| AI | Anthropic SDK | Sonnet for complex, Haiku for frequent — see services/ai.js |
| Frontend | React + Vite + Capacitor | `frontend/` |
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

frontend/src/
├── pages/                ← App screens and settings/dashboard flows
├── components/           ← Shared UI components
├── services/             ← Client API, Health, Stripe, device integrations
└── data/                 ← Integration/device registry data
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
| `HOST` | No | Defaults to `0.0.0.0` on Railway, `127.0.0.1` locally |

Resend HTTP API is used when `SMTP_HOST=smtp.resend.com` and `SMTP_USER=resend`; in that mode `SMTP_PASS` is the Resend bearer token, while `SMTP_PORT` and `SMTP_SECURE` are unused but still required by `isMailConfigured()`.

---

## Deploy Process

**Backend (Railway):**
```bash
git push origin main   # Railway auto-builds and deploys
# Health: https://forge-production-773f.up.railway.app/
```

**iOS (TestFlight):** Use non-interactive EAS after the one-time App Store Connect credential setup documented in `README.md`.

> **Hard rule for any agent (Zordon, Hermes, Codex):** Bryan does not run terminal
> commands. If `eas build` complains about missing credentials, that's a one-time
> setup gap — fix it per `README.md`, do NOT punt to Bryan with "run this in
> your terminal." Always pass `--non-interactive` so failures are loud, not prompts.

Before saying a fix is shipped, record whether it is only patched in source,
actually deployed successfully, visibly fixed in live production, and Bryan-verified.

## Release Status Language

A source change is not shipped just because code was edited locally or merged. Use these exact statuses in handoff notes, QA notes, and release updates:

- `patched` — code changed locally/in repo, not yet confirmed deployed live
- `shipped` — deploy/build completed successfully, but live behavior still needs verification
- `awaiting verification` — deploy/build is out, but Bryan or live-device QA has not confirmed the fix
- `verified fixed` — live production behavior was checked and Bryan confirmed the issue is resolved

Do not say `fixed` by itself for mobile-facing changes.

Release handoff checklist:
- Diff is complete, intentional, and bounded to the requested fix.
- Local build or relevant local route/navigation check passed.
- Railway build and deploy succeeded when the change affects production.
- Live production behavior was checked after deployment.
- Mobile-facing artifacts record app version/build number, TestFlight build when applicable, checked surface, checker, and status.
- Bryan verification is still required before moving a mobile-facing issue to `verified fixed`.

Handoff template:

```text
Issue:
Change made:
Status: patched | shipped | awaiting verification | verified fixed
Railway deploy: not started | failed | succeeded
Production check: not run | failed | passed
Artifact/version/build:
Bryan verification: pending | complete
Notes:
```

---

## Project State

Read `FORGE.md` for:
- Current production deployment and checked bundle
- Recently fixed bugs and patterns not to reintroduce
- 2026-04-28/29 QA and product hardening history
- Completed phases, known risks, and superseded markdown docs

---

## QA Checklist — Check Every Diff

- [ ] Every DELETE/UPDATE includes `AND user_id=?` (not just the SELECT)
- [ ] No `catch (_) {}` or empty catch blocks
- [ ] New AI prompts use `sanitize()` on all user-controlled fields
- [ ] New AI prompts use `claude-haiku-4-5` unless complex/infrequent (use Sonnet)
- [ ] New numeric inputs have range validation
- [ ] New routes have `auth` middleware
- [ ] No raw user input interpolated into SQL (parameterized only)
- [ ] Frontend/Capacitor: new form fields validate before submit

---

## Dispatch Log

| Date | Agent | Action | Commit |
|------|-------|--------|--------|
| 2026-04-17 | forge-security-fixes (Sonnet 4.6) | Superseded historical note: this commit added social error logging and other audited-clean diffs; the activity-photo ownership fix actually landed later in `2f9340c9` | `9997eeb3` |
| 2026-04-29 | claude-qa security fixes | Fixed password reset SQL, activity-photo ownership mutation guard, workout-set ownership guard, account deletion logging, meta/build admin gate, social catch logging, and Apple Health native gating | `2f9340c9` |
| 2026-04-29 | codex | Fixed forgot-password delivery by using Resend HTTP API transport with existing Railway mail credentials | `4c9c9804` |
