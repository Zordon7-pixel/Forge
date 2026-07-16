# Claude Code QA: Forged Hybrid Phase 4E and follow-up remediation

Repo: `/Volumes/Zordon Storage /openclaw-workspace/forge-app`
Branch: `main`
Date: 2026-07-16
Review range: `c5c2dc3f..HEAD`
Commits under review:

- `0c9341c5` Phase 4E What's New
- `7a4bab1a` editable time-PR persistence and PR Wall mobile zoom contract
- `43731862` Train and Body surface simplification
- `ce7a9577` scheduled-versus-recorded run comparison

Read `CLAUDE.md` and `.build-prompts/FORGED-HYBRID-PHASE-4E-WHATS-NEW-SPEC.md` first. This is a read-only security, data-integrity, accessibility, responsive-UI, and regression QA. Do not edit, commit, push, deploy, run EAS, or mutate production data.

## Intended behavior

- Authenticated users receive a bounded, accessible What's New sheet once per unseen release sequence. Dismissal is session-only; acknowledgement is monotonic per user and persists through `/api/releases/seen`.
- More contains a quiet What's New archive and unread marker. Release telemetry uses the existing allowlist and contains no health or account payloads.
- Time PR edits persist in `personal_records`, override automatically derived run results for the matching standard distance, remain user-scoped, and reject unsupported distances, invalid dates, and invalid durations.
- PR Wall fits 375-430px widths without horizontal overflow. The viewport contract permits pinch zoom in and back out; it does not lock accessibility zoom.
- Train no longer exposes evidence/reference exposition. The adaptation notice is a disclosure that can be minimized, but pending or safety-critical changes open visibly.
- Body leads with readiness history/actionable recovery drivers and moves health-source/sync administration to More. It does not repeat onboarding explanations or raw metric grids.
- New completed/imported runs get an immutable plan-target snapshot only when exactly one scheduled run exists on the exact local calendar date. Wrong-date, ambiguous two-run, non-run, and undated-weekday cases do not match.
- Run detail fetches the owner-scoped canonical run before opening and shows an objective Workout match based only on saved distance/time, numeric pace, and trusted zone evidence. Missing targets are disclosed; nothing is invented.

## Required inspection

1. Trace `backend/src/routes/releases.js` for auth, parameterized SQL, monotonic seen-sequence updates, owner scoping, error logging, and bounded integer handling.
2. Review `ReleaseNotesContext`, `WhatsNewSheet`, `WhatsNew`, Layout integration, and release-state storage for cross-account leakage, modal history/back behavior, focus handling, Escape, 44px targets, and one-per-session behavior.
3. Verify every release analytics event is allowlisted and carries no sensitive metadata.
4. Trace POST `/api/prs/manual` and GET `/api/prs/time` end to end. Prove an edited standard-distance time is returned after save, cannot overwrite another user, and cannot inject an unsupported record type.
5. Check PR Wall at 375, 390, and 430px. Confirm no horizontal overflow and that the viewport meta permits zoom-out without causing global layout regressions.
6. Confirm removed Train/Body exposition is actually absent, health-source controls have one clear home in More, and the adaptation disclosure cannot hide a pending/safety-critical change by default.
7. Trace `plannedRunMatch` through manual run save, Apple Health/import insertion, existing-import enrichment, GET `/runs/:id`, History, and RunDetailModal. Prove owner scoping, exact-date semantics, ambiguity refusal, immutable snapshots, and non-run isolation.
8. Review `runRecap.js` scoring for double counting, fabricated targets, divide-by-zero/NaN behavior, bad pace labels, absent zone totals, and misleading score labels.
9. Inspect all SQL added or changed for parameterization and `req.user.id` scoping. Verify account export/deletion coverage remains complete for release state and no new user-owned table is omitted.
10. Review the complete diff for regressions in authentication, route loading, More, Plan, Health, History, imports, run deletion/editing, and Capacitor startup.

## Commands

```bash
node --check backend/src/app.js
node --check backend/src/routes/releases.js
node --check backend/src/routes/events.js
node --check backend/src/routes/prs.js
node --check backend/src/routes/runs.js
node --check backend/src/routes/import.js
node --check backend/src/lib/plannedRunMatch.js
node backend/test/releases.smoke.js
node backend/test/prTimeOverride.smoke.js
node backend/test/plannedRunMatch.smoke.js
node frontend/test/releases.smoke.mjs
node frontend/test/surfaceSimplification.smoke.mjs
node frontend/test/runRecapPhase1.smoke.mjs
cd backend && npm run check:account-data
cd ../frontend && npm run build
npm audit --audit-level=high
npx cap sync ios
git diff --check c5c2dc3f..HEAD
git status --short
```

Run additional focused read-only checks as needed. Do not use a real user's PR, release-state, health, plan, or run records as test fixtures.

## Deliverable

Return findings first, ordered CRITICAL/HIGH/MEDIUM/LOW with exact `file:line` evidence. Explicitly state `PASS` or `HOLD`; list every command result; state whether release acknowledgement, PR persistence, responsive zoom, Train/Body simplification, exact-date plan matching, immutable snapshots, and recap scoring are safe; identify residual risks; and recommend whether Codex may proceed to Hermes review and Railway deployment. No EAS is authorized.
