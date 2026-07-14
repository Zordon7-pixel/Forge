# Claude Code QA — Forged Hybrid Final Test Phase 1

Repo: `/Volumes/Zordon Storage /openclaw-workspace/forge-app`
Branch under review: `codex/forged-hybrid-final-testing`

Read `CLAUDE.md` and `FORGE.md` first. Review Phase 1 as an independent release-candidate auditor. Do not push, deploy, run EAS, mutate production data, or edit documentation. Report findings first, ordered CRITICAL/HIGH/MEDIUM/LOW, with file:line evidence and a reproducible failure path. Do not silently skip a claim you disagree with.

## Scope

- Verify the compatibility migration cleanup in `backend/src/db/index.js` remains idempotent and transactional. A failed migration must fail fast into the existing outer rollback; no error may be swallowed.
- Verify malformed `workout_sessions.muscle_groups` JSON falls back safely and logs context.
- Verify chunk recovery, missed-workout adjustment, workout sharing, injury actions, and dashboard injury dismissal no longer swallow failures or create reload loops.
- Audit changed files for regressions, unsafe user messaging, and accidental broad refactors.
- Recheck auth middleware, parameterized SQL, and `req.user.id` scoping around touched workflows.

## Required Commands

```bash
cd "/Volumes/Zordon Storage /openclaw-workspace/forge-app"
git diff main...codex/forged-hybrid-final-testing --check
node --check backend/src/db/index.js
node --check backend/src/routes/stretches.js
cd frontend && npm run build
cd ../backend && npm run check:account-data
```

Also run all existing H1/H3/H4/H5/H6/H8/H9/H10/H11/H12 and shared backend smoke scripts. Confirm both frontend and backend `npm audit --audit-level=high` return zero high vulnerabilities.

## Acceptance Gate

- Zero CRITICAL/HIGH findings.
- No empty catches in changed workflows.
- User migrations remain idempotent and execute inside the existing transaction.
- Frontend failures are logged and provide an appropriate fallback/message without exposing secrets.
- Full build, audits, account-data coverage, and smokes pass.
- Explicitly state `PASS`, `PASS WITH RISKS`, or `FAIL`, and whether Phase 2 may proceed.
