# CLAUDE.md — Forge Project Intelligence

> **Read by: CW3 Codex (before building) AND Claude Code (before QA review)**
> Updated after every build. If you're building or reviewing, read this first.

---

## What This App Is

Forge is a coaching app for **hybrid runners/lifters** — people balancing running, strength work, readiness, and recovery. Do not position it as a generic athlete tracker.
- Backend: Node.js/Express + SQLite (local dev) / PostgreSQL (Railway)
- Frontend/mobile shell: React + Vite + Capacitor in this repo
- GitHub: `Zordon7-pixel/Forge` | Deploy: `git push origin main` → Railway auto-builds

This repo is the active production/TestFlight target. Its Expo/EAS build target is `@zordon/forge-athlete` (`frontend/app.json` project ID `6aeb5fbb-2697-4cf4-b9b3-afe60c63e9e1`) because that project owns the prior TestFlight build history. Do not implement current Forge work in `forge-nextjs` or `forge-native` unless Bryan explicitly says to revive that track. Workspace-level cross-platform specs that describe `forge-app` as deprecated are stale for the current shipping path; translate any useful ideas back into this React/Vite/Capacitor + Express stack before building.

---

## Stack

| Layer | Tech | Notes |
|-------|------|-------|
| Backend | Node.js + Express | `backend/src/` |
| Database | SQLite (local) / PostgreSQL (Railway) | `dbGet`, `dbRun` from db.js |
| Auth | JWT | `req.user.id` scopes ALL queries |
| AI | OpenAI Responses API | GPT-5.5 for complex, GPT-5.4 mini for frequent — see services/ai.js |
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
    └── ai.js             ← All AI prompt functions (OpenAI model tiering)

frontend/src/
├── pages/                ← App screens and settings/dashboard flows
├── components/           ← Shared UI components
├── services/             ← Client API, Health, Stripe, device integrations
└── data/                 ← Integration/device registry data
```

---

## AI Model Tiering — Critical, Do Not Change

Forge uses the OpenAI Responses API directly from `backend/src/services/ai.js`. Token cost is real. Model assignments are fixed:

| Function | Model | Reason |
|----------|-------|--------|
| `generateTrainingPlan` | `OPENAI_MODEL_COMPLEX` default `gpt-5.5` | Complex, infrequent |
| `generateWeeklyInsight` | `OPENAI_MODEL_COMPLEX` default `gpt-5.5` | Complex, weekly |
| `generateRaceAdjustment` | `OPENAI_MODEL_COMPLEX` default `gpt-5.5` | Complex, occasional |
| Everything else | `OPENAI_MODEL_FREQUENT` default `gpt-5.4-mini` | Frequent, simple feedback |

**Never put the complex model on functions that fire on every run/lift log — that's expensive at scale.**

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
| `OPENAI_API_KEY` | YES | For all AI features |
| `OPENAI_MODEL_FREQUENT` | No | Defaults to `gpt-5.4-mini` for per-action feedback |
| `OPENAI_MODEL_COMPLEX` | No | Defaults to `gpt-5.5` for complex/infrequent planning |
| `OPENROUTESERVICE_API_KEY` | For elevation routes | Server-side route generation only; never expose through Vite/client env |
| `APP_URL` | For reset email | Base URL used in password reset links |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | For reset email | SMTP delivery for forgot-password emails |
| `EMAIL_FROM` | For reset email | From address for forgot-password emails |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | For web push | Enables background activity alerts in compatible installed web apps; keep the private key server-only |
| `VAPID_SUBJECT` | No | Contact URI for web push, defaults to `mailto:support@forgeathlete.app` |
| `PORT` | No | Defaults to 4002 |
| `HOST` | No | Defaults to `0.0.0.0` on Railway, `127.0.0.1` locally |
| `FORGE_BETA_ACCESS` | No | Set to `true` to unlock premium routes and AI limits for beta testers without changing subscription records; set to `false` before paid launch |
| `FORGE_GOAL_BACKWARD_V24_MODE` | No | Goal-backward v2.4 runtime mode: `off\|shadow\|preview\|on`. Missing, malformed, whitespace-padded, or otherwise invalid values resolve to `off`. This flag is independent of `FORGE_BETA_ACCESS`. |

Resend HTTP API is used when `SMTP_HOST=smtp.resend.com` and `SMTP_USER=resend`; in that mode `SMTP_PASS` is the Resend bearer token, while `SMTP_PORT` and `SMTP_SECURE` are unused but still required by `isMailConfigured()`.

## Goal-Backward Coaching v2.4 — Phase 1A Contract

Phase 1A is an additive contract/persistence foundation only. `backend/src/lib/goalBackwardContracts.js` owns the independent schema/policy/ruleset versions, closed truth/state unions, stable reason-code registry, sensitive artifact keys, bounded pipeline-artifact validation, and seven-stage Evidence→surface link validation.

The shipped compatibility anchors remain authoritative:

- `planSchema.js` remains the schema-v2 plan envelope and stable-session adapter.
- `planCandidateLifecycle.js`, `plan_generation_candidates`, and the existing owner-scoped candidate apply route remain the only preview/apply lineage.
- `racePlanPolicy.js`, `hyroxStandards.js`, and `racePlanDiagnostics.js` remain the current policy, official HYROX registry, and diagnostics anchors.
- M24-01 through M24-05 add nullable candidate bindings and append-only artifact/correction/constraint/rejection tables. They do not replace or backfill current plans.

No-runtime-switch guarantee: Phase 1A does not wire the v2.4 planner into any route. `FORGE_GOAL_BACKWARD_V24_MODE` defaults/fails to `off`, and mode `off` continues through the existing candidate generation, preview, apply, assignment, and surface path. `FORGE_BETA_ACCESS` entitlement behavior is unchanged.

Phase 1A gate:

```sh
node backend/test/goalBackwardContracts.smoke.js
node backend/test/planPersistenceMigration.smoke.js
node backend/test/planCandidateLifecycle.smoke.js
```

Batch 1 status (2026-08-14): `patched`; the three-command Phase 1A gate passes locally. No commit, deploy, migration execution, feature activation, independent QA, or Hermes verification is claimed by this source patch.

## Goal-Backward Coaching v2.4 — Phase 2A-1 Workload Contract

Batch 3 adds policy and workload evidence without replacing the current planner. `backend/src/lib/racePlanPolicy.js` owns the event-policy, stress-taxonomy, target-conversion, exposure-floor, and planning-policy registries. `backend/src/lib/goalBackwardLoad.js` owns closed family/vector resolution, assessment maxima, daily stack classification, uncapped weekly stress, modality-specific ceilings, gated HYROX cluster overload, rolling hard-day caps, and running-volume intersection.

Compatibility and safety anchors:

- Session titles and model prose never assign a workout family or stress vector; unresolved canonical families fail closed.
- Three eligible weeks are provisional and cannot authorize overload. Fewer than three use the exact conservative training-class fallback for that dimension.
- HYROX overload is available only for the mandatory event-specific cluster with established per-dimension history, `READY|NORMAL` recovery, no safety restriction, and two prior passing weeks.
- Overload never waives rolling hard-day, very-high, race-minus-six, station-skill placement, or running-volume constraints.
- `evaluatePlanFeasibility()` retains its legacy object shape when `FORGE_GOAL_BACKWARD_V24_MODE` is missing, invalid, or `off`. A valid non-off mode exposes additive `goalBackwardWorkload` evidence only when the later engine supplies `goalBackwardWorkloadInput`.

Phase 2A-1 gate:

```sh
node backend/test/goalBackwardPlanning.smoke.js
node backend/test/planFeasibility.smoke.js
node backend/test/racePlanQuality.smoke.js
```

Batch 3 status (2026-08-14): `patched`; the three-command Phase 2A-1 gate passes locally. No commit, deploy, feature activation, independent QA, or Hermes verification is claimed by this source patch.

## Goal-Backward Coaching v2.4 — Phase 2B-1 Canonical Prescription Contract

Batch 6 adds canonical-workout schema v1 inside the existing schema-v2 plan envelope. `backend/src/lib/canonicalWorkout.js` owns the closed session graph, recursive metric totals, target provenance, deterministic prescription hash, machine-readable family/stress derivation, criteria, and truthful export capability. `backend/src/lib/goalBackwardTargets.js` owns the five-level target hierarchy and target-policy gates.

Compatibility and authority anchors:

- Canonical sessions retain stable `session_id`/revision/hash identity and are adapted to current `id`, `kind`, `type`, `workout_type`, miles, and minutes fields without replacing schema v2.
- Only metric canonical target fields are accepted. Unknown step/family/target fields, unresolved family signatures, missing numerical provenance, divergent stored totals, false capability claims, and hash mismatch fail hard.
- Pace authority requires complete, fresh, conflict-free evidence. Level 1 uses exact benchmark-specific outward ranges; level 2 uses R type-7 work-segment quartiles; road conversion v1 is race-rhythm-only; unsupported pace falls through HR/RPE or assessment.
- Material environment differences make effort authoritative. Pace may remain only as a non-binding reference, and the condition evidence/reason is retained.
- Athlete explanations are downstream copy. A number absent from the canonical explanation facts is rejected, and attaching explanation copy cannot change the prescription hash.
- Training-class presentation floors reject token sessions unless `BELOW_PRESENTATION_FLOOR_EXCEPTION` names a beginner or rehab protocol.

Phase 2B-1 gate:

```sh
node backend/test/goalBackwardCanonical.smoke.js
node backend/test/goalBackwardTargets.smoke.js
node backend/test/forgedHybridH1.smoke.js
node backend/test/racePlanQuality.smoke.js
```

Batch 6 status (2026-08-14): `patched`; the four-command gate passes locally. No commit, deploy, runtime activation, independent QA, or Hermes verification is claimed by this source patch.

## Goal-Backward Coaching v2.4 — Phase 3A HYROX Contract

Batch 8 extends the shipped HYROX anchors without creating a second station or load table. `backend/src/lib/hyroxStandards.js` remains the frozen official registry and now exposes the explicit `hyrox-global` ruleset ID, `2026-2027` ruleset version, effective window, reviewed date, source URLs, and exact-load resolution status. `backend/src/lib/racePlanPolicy.js` owns the Singles/Doubles ownership and performance-budget policy; `backend/src/lib/canonicalWorkout.js` builds the canonical event state; `backend/src/lib/goalBackwardTargets.js` builds the null-preserving performance budget; and `backend/src/lib/hyroxPlan.js` reuses those contracts in the current deterministic planner.

Compatibility and truth anchors:

- The current station order, metric volumes, division/category loads, source URLs, legacy `rulesVersion`, race sequence, and Relay behavior remain intact.
- Singles assigns every official run, station, transition/Roxzone component, compromised-running observation, and fatigue/recovery burden to the athlete.
- Doubles keeps team performance separate from athlete burden. Planned and actual splits are independent, a missing partner may retain `Partner TBD`, and team station time never manufactures an individual 50/50 contribution.
- Unknown or unsupported ruleset ID/version or division returns no official standard or exact load. The prescription stays at registered-load or relative-technique language.
- Missing run, station, or transition projections stay `null`. A known-component sum is arithmetic only; unallocated time is not computed from an entirely empty budget and never proves achievability.
- Equipment substitutions are explicitly `pattern_only`, retain a null prescribed load, omit the official standard, and cannot satisfy exact station readiness.
- Missing, invalid, or explicit `off` v2.4 mode retains the legacy HYROX plan payload; canonical event state, ruleset provenance, and performance budget are additive only in a valid non-off mode.

Phase 3A gate:

```sh
node backend/test/goalBackwardHyrox.smoke.js
node backend/test/hyroxPlanEngine.smoke.js
node backend/test/hyroxEventContract.smoke.js
```

Batch 8 status (2026-08-14): `patched`; the three-command gate passes locally. No commit, deploy, feature activation, independent QA, or Hermes verification is claimed by this source patch.

## Goal-Backward Coaching v2.4 — Phase 4A Adaptation Contract

Batch 10 adds the flagged completion/adaptation layer without wiring a new runtime route or replacing the current adaptation engine. `backend/src/lib/adaptationEngine.js` maps completion evidence to the closed v2.4 outcome enum, keeps ordinary one-off results from driving material progression, applies the training-class presentation floor, records missed-session policy, and reuses the shipped proposal builder. `backend/src/lib/planningRevision.js` creates append-only derived outcome/evidence/state successors while retaining observed envelopes byte-equivalently.

Authority and safety anchors:

- `UNSCORABLE_PARTIAL_SYNC` is an outcome, not a zero result. Partial or failed coverage never produces an observed-to-prescribed zero ratio.
- A single ordinary outcome does not authorize material progression. A designated assessment may update evidence, but its proposal still passes the same workload, safety, spacing, constraint, and presentation-floor validators.
- M24-04 rows are owner-scoped and revisioned. Only the latest active day lock, session lock, or manual edit per scope is authoritative; deactivation still advances the lock/edit binding revision.
- Athlete-authored edits retain `owner=athlete`, attribution, revision, and prescription identity. A violating candidate fails with `ATHLETE_EDIT_PRESERVED`; a lock violation fails with `ATHLETE_LOCK_CONFLICT`.
- Safety action determines per-session and per-surface executability from one state revision. `NO_RUNNING` leaves safe upper-body work eligible, while `FULL_REST` blocks UI/workout/Watch/FIT/calendar/map/warm-up execution.
- Missed work is skipped or explicitly policy-handled. Carried debt sessions are omitted, excess missed work records `NO_WORKOUT_DEBT`, and the remaining candidate must pass cross-modal ceilings, rolling hard-day caps, interference spacing, safety, and presentation floors.
- Missing or explicit flag-off use of `buildAdaptationProposal()` retains the legacy response path. The additive `buildGoalBackwardAdaptationProposal()` is the v2.4 validated path and is not activated by this batch.

Phase 4A gate:

```sh
node backend/test/goalBackwardAdaptation.smoke.js
node backend/test/adaptationRecoveryMinimum.smoke.js
node backend/test/runGapReentry.smoke.js
node backend/test/planningRevisionConcurrency.smoke.js
```

Batch 10 status (2026-08-14): `patched`; the four-command Phase 4A gate passes locally. No commit, deploy, feature activation, independent QA, or Hermes verification is claimed by this source patch.

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
- [ ] New AI prompts use `OPENAI_MODEL_FREQUENT` unless complex/infrequent (use `OPENAI_MODEL_COMPLEX`)
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
| 2026-07-13 | hermes + codex + claude-qa | Shipped H7 canonical race editions, provenance/freshness trust gates, privacy-safe GPX analysis, and course-aware plan inputs; closed QA trust and no-op risks before production | `df07abfe` |
| 2026-07-13 | codex + claude-qa | Shipped H8 race-first plan search, date-calendar setup, availability/strength inputs, idempotent catalog selection, and deterministic fallback for malformed or timed-out AI plans | `c40db938` |
| 2026-07-13 | codex + claude-qa | Shipped H9 exact recent-run plan inputs, 24-72-hour load protection, strength-floor relocation, recovery-step repair, and the Apple Watch native registration fix for the next approved build 16 | `9a7f9b3e` |
| 2026-07-13 | codex + claude-qa | Shipped H10 recovery-prescription integrity plus explicit, data-bounded strength sets/reps/rest/load/RPE/progression; exact loads require matching same-modality set history | `2378714e` |
| 2026-07-13 | codex + claude-qa | Shipped H11 expanded Apple Health training intelligence, per-metric freshness/provenance gates, athlete baselines, Body data surfaces, and conservative plan context; native reads await a Bryan-approved EAS build | `53ae701a` |
| 2026-07-13 | codex + claude-qa + hermes | Prepared H12 workout-kind integrity, exact watch HR zones, sparse-HR safeguards, and validated per-workout HealthKit/Garmin metrics; native schema v3 awaits Bryan-approved EAS | `602251b0` |
| 2026-07-14 | codex + claude-qa + hermes | Shipped reload-safe active runs, pull-refresh protection, runner-following map marker, user-facing deletion with imported-workout tombstones, source-accurate calories, and HealthKit workout HR schema v4; native v4 awaits Bryan-approved EAS | `44bdb4f7` |
| 2026-07-14 | codex + claude-qa | Shipped H13 deterministic evidence-backed race plans, time-first run prescriptions, bounded recent-history baselines, current-week/acute-load protection, internal-only Watch diagnostics, and sparse-screen branding; build 16 remains Bryan-approved EAS only | `e2c3e8f6` |
| 2026-07-14 | codex + claude-qa | Shipped H14 complete local mobility visuals, profile-sex single-athlete crops, health-source management under More, and deterministic usage-based Train actions; no EAS build was run | `92ee28fb` |
| 2026-07-14 | codex + claude-qa | Shipped H15 user-scoped unseen-first warm-up/stretch rotation and guarded left-edge swipe back with active-session and nested-gesture protections; no EAS build was run | `b436b30f` |
| 2026-07-14 | codex | Patched friends-beta Phase 0 post-run truth ordering, durable check-in recovery, plan/run provenance, timestamped routes, one-call AI idempotency, and pain/energy plan protection; awaiting Claude QA, no deploy or EAS | pending QA |
| 2026-07-15 | codex + claude-qa | Built and submitted Forged Hybrid 1.0.5 build 16 with registered HealthKit/WorkoutKit bridges and background GPS; EAS build `71dde0a7-62c1-4d62-b543-6ddb7670961b`, awaiting Apple processing and physical-device verification | `4247d10a` |
| 2026-07-15 | codex + claude-code + hermes | Shipped and Railway-live-verified Phase 4A invite-only mutual friends, one-use hashed invites, block/report safety, account-data coverage, and the mobile Community surface; no EAS build was run | `e656c00f` |
| 2026-07-15 | codex + claude-code + hermes | Shipped and Railway-live-verified Phase 4A.1 opt-in exact-handle friend discovery with uniform unavailable responses, rate limits, block-aware requests, hidden-by-default accounts, secondary invite links, and a passing three-account production matrix on deployment `b09c3251-c4e2-4682-8e5a-8c8b8f43a8b9`; no EAS build was run | `54f8c73e` |
| 2026-07-15 | codex + claude-code + hermes | Shipped and Railway-live-verified Phase 4B private run, strength, and hybrid challenges with friend-only invitations, source-row scoring, walk/replay exclusion, privacy-masked ranks, account-owner transfer, and a passing 35-check production matrix on deployment `d3416ea5-7d40-4d84-bcca-35831141af76`; no EAS build was run | `70a8c1c8` |
| 2026-07-15 | codex + claude-code + hermes | Shipped focus-aware Lift Warm-Up, Post-Lift Stretch, and Lift History quick actions with profile-sex image-backed mobility sessions; no EAS build was run | `34bd27a3` |
| 2026-07-15 | codex + claude-code + hermes | Shipped and Railway-live-verified Phase 4C private challenge leaderboards, deterministic ties/progress/source labels, compact activity, owner removal, member reporting, and a passing seven-part three-account production matrix on deployment `f6d5ffa4-bc0a-4608-85ac-5db95e8b965d`; no EAS build was run | `5c2bb109` |
| 2026-07-15 | codex + claude-code + hermes | Shipped and Railway-live-verified Phase 4D private friends-only group runs with structured workouts, review-before-join, exact-location redaction, opaque moderation, user-bound active-run handoff, canonical account-mutation locking, and passing seven-check challenge plus ten-check group-run production matrices on deployment `16aab5c8-36bf-41c6-ab69-d7b30aa6c46d`; no EAS build was run | `f1d86c2c` |
| 2026-07-16 | codex + claude-code + hermes | Shipped and Railway-live-verified Phase 4E What's New, editable time-PR persistence, quieter Train/Body surfaces, and immutable exact-date workout matching; closed a production-only `personal_records.created_at` drift found by the disposable matrix, then re-verified deployment `c6661452-1a35-4bb4-9b51-18ad1de54b89`; no EAS build was run | `87f984fa` |
| 2026-07-16 | codex + claude-code + hermes | Shipped and Railway-live-verified Forged Closet v1 with a manufacturer-sourced pilot catalog, explicit manual fallback, deterministic session/surface/weather rotation, per-shoe wear estimates, and passing mobile plus disposable ownership matrices on deployment `4ad773cf-8d54-4a26-a177-bfe2d0ddac7d`; no EAS build was run | `73e9a5d9` |
| 2026-07-17 | codex + claude-code | Added accepted-friend monthly running leaderboards plus consent-based contact-email suggestions with opt-in discovery, encrypted short-lived match tokens, bidirectional block checks, least-privilege iOS Contacts access, and 320px mobile coverage; native contact reading awaits a separately approved EAS build | `10159b31` |
| 2026-07-17 | codex | Built and signed Forged Hybrid 1.0.5 build 17 with the native Contacts bridge; EAS build `1105717c-845d-4706-be54-11ae84db0b20` passed local artifact inspection, but App Store submission `6ac31393-ffb7-44b4-a573-8ed29f3f3b59` failed Apple's `ITMS-90683` validation because the binary lacked `NSHealthUpdateUsageDescription` | `c13eba01` |
| 2026-07-17 | codex | Added the missing HealthKit update purpose string to Expo and native metadata plus a fail-before-build privacy verifier used for build 18 | `401c427d` |
| 2026-07-17 | codex | Hardened exact-handle friend search to compare case-insensitively at the SQL boundary, added mixed-case regression coverage, and clarified that target accounts must opt into handle discovery | `c6c401b1` |
| 2026-07-17 | codex | Built Forged Hybrid 1.0.5 build 18 once, inspected the signed IPA, and uploaded EAS build `27a1deca-8dbc-42a8-a553-6cb59df416e0` through submission `c627c4aa-0265-40c9-9b4a-818bcc97126e`; Apple processing is pending | `09c548c4` |
| 2026-07-18 | codex | Shipped source-truth Run Recaps, user-rated post-run effort, route-derived elevation fallback, and duplicate-safe Strava route/elevation enrichment; native HealthKit effort/elevation schema v5 awaits a separately approved EAS build | `a05b3249` |
| 2026-07-19 | codex + claude-code | Added provenance-labeled calculated run effort from reliable heart-rate-zone coverage and duration, wired it into recaps, load protection, plan context, and coach feedback without overwriting athlete-rated RPE; clarified that phone GPS/altitude applies to Forged-recorded runs while native HealthKit v5 still awaits a separately approved EAS build | `34bc5188` |
| 2026-07-20 | codex + claude-code | Added one-decision-per-day adaptation prompts, Apple Health/Strava performance-anchored race targets, exact goal-pace progression, automatic 15K/10-mile PR recognition, and a responsive whole-plan Overview that exposes every week's purpose and actual sessions; no EAS build was run | `bd2120fa`, `20d9eeaa`, `8cbf9b36`, `0ea7efe6`, `04cc5062`, `97b22bf2` |
| 2026-08-14 | codex | Patched Goal-Backward Coaching v2.4 Phase 5A with one revision-bound canonical surface manifest for weekly Plan/calendar/detail consumers, fail-closed mismatch handling, exact safety/capability/provenance disclosure, and 320 px/393 px fixtures; no rollout, deploy, commit, or native build was performed | pending Hermes review |
