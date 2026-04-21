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
| Activity photo hijack (2026-04-17, commit 9997eeb3) | routes/social.js | POST photo: SELECT+UPDATE scoped to `AND user_id=?`; 403 if another user owns the record |

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
