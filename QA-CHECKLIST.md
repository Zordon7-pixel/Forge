# QA-CHECKLIST.md — Forge

Run through every item for every diff. CRITICAL items block ship. HIGH items must be noted in report.

> **For ship-readiness / pre-launch / full-QA runs, use the `pre-launch-audit` skill instead.** It supersets this checklist (adds mobile UI on iPhone, currency formatting, schema drift, cron health, etc.). Invoke via "do a full QA of Forge" or `/pre-launch-audit forge`. This checklist remains the floor for per-diff reviews in the build pipeline.

---

## CRITICAL — Block ship if any are true

- [ ] DELETE or UPDATE query missing `AND user_id=?` ownership check
- [ ] User input string-interpolated into SQL (not parameterized)
- [ ] New route missing `auth` middleware
- [ ] User-controlled field passed raw into AI prompt (no sanitize() call)
- [ ] Hardcoded user ID in query
- [ ] `catch` block that swallows errors silently
- [ ] JWT secret or API key logged or returned in response
- [ ] Sonnet used on a function that fires on every run/lift log

## HIGH — Flag in report, must fix before next build

- [ ] New numeric input field with no range validation
- [ ] Email field with no format validation
- [ ] Password field with no minimum length check
- [ ] Missing null check before `.property` access on DB result
- [ ] New AI prompt function without model explicitly set
- [ ] New async function with no try/catch

## MEDIUM — Note in report

- [ ] AI prompt that could produce robotic/generic output (check tone matches coaching voice)
- [ ] Error message leaks internal details
- [ ] React Native: form submit with no loading state
- [ ] React Native: no keyboard dismiss on submit
- [ ] Unused import or variable

---

## Forge-Specific Patterns to Watch

- `sanitize()` — must wrap ALL user fields in AI prompts: name, notes, exercise, distance, pace
- Model tier — `claude-haiku-4-5` for per-action feedback, `claude-sonnet-4-6` for plans/insights only
- Lift weight — must validate `> 0` (not `>= 0`, not `> -1`)
- `perceived_effort` — must validate 1–10 range
- Profile updates — age (10–110), weight_lbs (50–700), max_heart_rate (100–220)

## Goal-Backward Coaching v2.4 — Phase 1A

- [ ] Only the approved 10-file Batch 1 allowlist changed; no runtime route, package, lockfile, or native file changed
- [ ] Independent contract versions, closed unions, required reason codes, and truth classes match the approved v2.4 spec
- [ ] Pipeline artifacts reject unknown kinds, invalid links, oversized payloads, and secret/PII/route-shaped keys recursively
- [ ] All seven artifact kinds resolve one owner/decision chain from `evidence_snapshot` through `surface_manifest`
- [ ] `FORGE_GOAL_BACKWARD_V24_MODE` accepts only exact `off\|shadow\|preview\|on`; missing or invalid values resolve to `off`
- [ ] `FORGE_BETA_ACCESS` entitlement behavior is unchanged and independent from the v2.4 mode
- [ ] M24-01 through M24-05 exist in both `migrate.js` and `schema.pg.sql`, use `IF NOT EXISTS`, and remain additive/default-safe for legacy rows
- [ ] Candidate bundle helpers validate all new revision/hash/mode bindings but are not called by the runtime planner or routes
- [ ] Mode `off` retains the existing candidate generation/preview/apply path and current schema-v2 surface behavior

Run the Phase 1A gate:

```sh
node backend/test/goalBackwardContracts.smoke.js
node backend/test/planPersistenceMigration.smoke.js
node backend/test/planCandidateLifecycle.smoke.js
```

## Goal-Backward Coaching v2.4 — Phase 2A-1

- [ ] Only the approved seven-file Batch 3 allowlist changed; no route, package/lock, migration, native, or unrelated tracked file changed
- [ ] Registry anchors match the independent Phase 1 versions; event policies contain closed phase exposure families, running floors, taper windows, and zero/default or HYROX-cluster overload vectors
- [ ] Workout families resolve only from canonical machine-readable family fields; road/HYROX race vectors and assessment element-wise maxima match §8.1 exactly
- [ ] Daily classification adds at most one per-dimension stack surcharge and weekly dimension sums remain uncapped integers
- [ ] Four-plus eligible weeks use the upward-rounded ordinal median ceiling, exactly three are provisional without overload, and fewer than three use the exact class fallback per modality
- [ ] HYROX cluster allowance is dimension-exact and requires event-specific phase, mandatory cluster, established history, passing recovery/safety gates, and two prior passing weeks
- [ ] Rolling seven-local-day lower-body/running hard-day, total hard-day, very-high event, race-minus-six, and mandatory station-skill placement caps fail closed
- [ ] Running volume chooses the highest integer meters in the complete safe intersection and records `CROSS_MODAL_FATIGUE_LIMIT` when no intersection exists
- [ ] Missing, invalid, and explicit `off` v2.4 modes retain the legacy `evaluatePlanFeasibility()` shape; valid non-off modes expose additive evidence only for an explicit workload input

Run the Phase 2A-1 gate:

```sh
node backend/test/goalBackwardPlanning.smoke.js
node backend/test/planFeasibility.smoke.js
node backend/test/racePlanQuality.smoke.js
```

Batch 3 status (2026-08-14): `patched`; the three-command gate passes locally. Independent QA and Hermes verification remain pending.

## Goal-Backward Coaching v2.4 — Phase 2B-1

- [ ] Only the approved 10-file Batch 6 allowlist changed; no route, package/lock, migration, native, surface, or unrelated tracked file changed
- [ ] Canonical session roles, workout families, step types, target fields, metric units, and export capabilities are closed and frozen for schema v1
- [ ] Schema v1 remains embedded in the schema-v2 plan envelope; current adapters preserve stable canonical IDs and dual-write legacy kind/type/distance/duration fields
- [ ] Repeat totals recurse deterministically; stored totals beyond the metric tolerance fail `DERIVED_TOTAL_MISMATCH`
- [ ] Every numerical step target has evidence/athlete-state/policy/confidence/time/decision/unit provenance and the session provenance cache matches it
- [ ] Family derives from machine-readable work steps, assessment uses the exact element-wise maximum plus event floor, and unresolved/mismatched families fail hard
- [ ] Session revisions, plan revisions, criteria, stress vector, capability, and deterministic content hash validate before canonical acceptance
- [ ] Target levels apply freshness, `COMPLETE` quality, conflict, purpose, family, surface, and policy gates before using pace
- [ ] Level 1 uses outward ±2% threshold/interval or ±3% compromised bounds; level 2 uses R type-7 25th–75th work-segment pace rounded outward
- [ ] Nearby-road conversion v1 enforces ratio, duration, freshness, and comparable course/surface gates and can prescribe only race rhythm
- [ ] Unsupported pace falls through valid HR/RPE zones or a duration/repetition/RPE assessment; pace remains null
- [ ] Heat/dew point/altitude/terrain/surface triggers switch authority to effort and retain fresh complete environment provenance
- [ ] Explanation numbers are restricted to canonical facts and attaching explanation copy leaves the prescription hash unchanged
- [ ] Recovery, easy, long, quality, HYROX compromised, and strength floors reject token work without a named beginner/rehab exception

Run the Phase 2B-1 gate:

```sh
node backend/test/goalBackwardCanonical.smoke.js
node backend/test/goalBackwardTargets.smoke.js
node backend/test/forgedHybridH1.smoke.js
node backend/test/racePlanQuality.smoke.js
```

Batch 6 status (2026-08-14): `patched`; the four-command gate passes locally. Independent QA and Hermes verification remain pending.

## Goal-Backward Coaching v2.4 — Phase 3A

- [ ] Only the approved 10-file Batch 8 allowlist changed; no route, package/lock, migration, native, surface, or unrelated tracked file changed
- [ ] The official HYROX registry retains exact current station order, metric standards, division/category loads, sources, and legacy `rulesVersion` while adding explicit ruleset ID/version and reviewed/effective metadata
- [ ] Missing, unknown, or unsupported ruleset ID/version or division returns no exact station loads and preserves registered-load/relative-technique language
- [ ] Singles owns all eight official runs, all eight stations, transition/Roxzone behavior, compromised-running evidence, and individual fatigue/recovery burden
- [ ] Doubles retains partner ID/placeholder, planned and actual split, athlete and partner contribution, team evidence, and athlete-specific fatigue evidence independently
- [ ] Doubles team station time remains visible while individual station time/contribution stays null when the actual split is unknown; no 50/50 inference occurs
- [ ] Team performance burden and individual training burden are separately queryable and both athletes retain the full official Doubles run requirement
- [ ] Missing run, station, and transition projections remain null; known-component sum and unknown-unallocated arithmetic never turn missing evidence into zero or support
- [ ] Sub-60 support requires every mandatory component at `MEDIUM+` confidence and coherent team/individual burden
- [ ] Equipment substitutions remain `pattern_only`, keep prescribed load null, omit the official standard, and cannot satisfy exact station readiness
- [ ] Missing, invalid, and explicit `off` v2.4 modes retain the legacy HYROX plan payload; canonical HYROX artifacts are additive only for a valid non-off mode

Run the Phase 3A gate:

```sh
node backend/test/goalBackwardHyrox.smoke.js
node backend/test/hyroxPlanEngine.smoke.js
node backend/test/hyroxEventContract.smoke.js
```

Batch 8 status (2026-08-14): `patched`; the three-command gate passes locally. Independent QA and Hermes verification remain pending.

## Goal-Backward Coaching v2.4 — Phase 4A

- [ ] Only the approved 10-file Batch 10 allowlist changed; no route, migration, package/lock, native, surface, or unrelated tracked file changed
- [ ] Completion analysis emits only `UNDER_TARGET|ON_TARGET|ABOVE_TARGET|EXCESSIVE_STRAIN|INCOMPLETE|PAIN_LIMITED|UNSCORABLE_PARTIAL_SYNC`
- [ ] Partial/failed sync is unscorable and never derives observed zero, recovery, or a numeric completion ratio from incomplete coverage
- [ ] Derived outcome evidence cites immutable observed evidence IDs; EvidenceSnapshot and AthleteState successors increment and link without rewriting the prior observation envelope
- [ ] One ordinary result cannot drive material progression; a designated assessment may update evidence but never bypasses workload or safety validation
- [ ] Every flagged proposal runs cross-modal workload/rolling-hard-day, safety, interference-spacing, athlete-constraint, and presentation-floor validators
- [ ] Revisioned M24-04 constraints select only the latest active owner-scoped row; day/session locks fail `ATHLETE_LOCK_CONFLICT` when violated
- [ ] Athlete manual edits retain `owner=athlete`, attribution, revision, family/date/prescription identity, and require review before a material overwrite
- [ ] `NO_RUNNING` preserves eligible upper-body work; `FULL_REST` blocks UI, workout start, Watch, FIT, calendar start, map, and warm-up on the same safety revision
- [ ] Recovery/easy/long/quality/HYROX/strength reductions below their class floor become an explicit rest/walk/mobility choice unless a named beginner/rehab exception is valid
- [ ] Missed work is skipped/rescheduled/shortened/replaced by policy, carried debt sessions are omitted, and excess records `NO_WORKOUT_DEBT` without breaching ceilings or spacing
- [ ] Missing and explicit flag-off legacy adaptation responses remain byte-compatible; no v2.4 runtime activation is introduced

Run the Phase 4A gate:

```sh
node backend/test/goalBackwardAdaptation.smoke.js
node backend/test/adaptationRecoveryMinimum.smoke.js
node backend/test/runGapReentry.smoke.js
node backend/test/planningRevisionConcurrency.smoke.js
```

Batch 10 status (2026-08-14): `patched`; the four-command gate passes locally. Independent QA and Hermes verification remain pending.

## Goal-Backward Coaching v2.4 — Phase 5A

- [ ] Only the approved 10-file Batch 12 allowlist changed; no migration, package/lock, native, Watch, FIT, or unrelated tracked file changed
- [ ] Applicable `preview|on` assignments serve one `goal_backward_surface_manifest_v1` beside the legacy-compatible plan; missing, invalid, `off`, and `shadow` responses retain the prior response shape
- [ ] Manifest identity binds the decision/candidate/plan/session-set hashes, candidate/plan/athlete-state/surface revisions, safety-state hash, and goal revisions to the applied assignment and canonical artifact chain
- [ ] Weekly brief, Plan, calendar, and detail consume the exact accepted session role, ordered steps/targets, provenance, reason codes, safety scope/executability, criteria, capability, and content hash
- [ ] The frontend does not invent a v2.4 shoe, HR, pace, load, repetition, or replacement prescription; canonical numeric display is a representation of accepted targets only
- [ ] Any plan, assignment, session revision, content hash, step, target/provenance, safety, or capability mismatch yields `SURFACE_REVISION_MISMATCH`, removes executable sessions, and prevents run/lift/Watch starts
- [ ] `NO_RUNNING`, `MODIFY_IMPACT`, and `FULL_REST` keep applicable run controls closed; restricted sessions disclose the accepted safety scope and executability
- [ ] Legacy plans without a manifest retain their existing calendar, weekly brief, daily execution, and detail presentation
- [ ] The 320 px and 393 px fixtures expose canonical purpose/feasibility/reasons and session truth with bounded width, wrapping, and no unrelated style rewrite

Run the Phase 5A gate:

```sh
node frontend/test/goalBackwardSurfaces.smoke.mjs
node frontend/test/weeklyRunBrief.smoke.mjs
node frontend/test/planCalendar.smoke.mjs
npm --prefix frontend run build
```

Batch 12 status (2026-08-14): `patched`; the four-command gate passes locally. Independent QA and Hermes verification remain pending.

## Goal-Backward Coaching v2.4 — Phase 6 Release and Public Activation

- [ ] At most 10 approved activation/contract files changed; no migration, package/lock, native, Watch, FIT, engine, validator, or unrelated tracked file changed
- [ ] Runtime audience accepts only exact `cohort\|all`; missing, malformed, whitespace-padded, or unknown audience values resolve to non-public `cohort` behavior
- [ ] `cohort` retains the exact pseudonymous `sha256:` authorization check; `all` authorizes only production-shaped UUID accounts and rejects blank/synthetic IDs
- [ ] Preview and apply use the same injected audience decision; missing/invalid modes, missing users, unauthorized audiences, and zero-tolerance alerts resolve to `off`
- [ ] `shadow` preserves the current candidate for response/apply, `preview` cannot apply, and `on` rechecks live mode/audience plus every stale-safe binding before mutation
- [ ] Telemetry contains only the closed release schema: mode, fixed policy/schema versions, pass/fail reason counts, candidate selection, outcome, surface capability, revision mismatch, and pseudonymous target ref
- [ ] Telemetry and release diagnostics reject payloads, raw IDs, emails, tokens, health samples, routes/coordinates, and free text
- [ ] Hard-validator bypass, mutation after stale failure, revision mismatch, unknown-to-zero, telemetry redaction, surface executability mismatch, and duplicate assignment have zero tolerance and force control/rollback
- [ ] The script defaults to `off`, exits without database work, and reports exactly zero writes
- [ ] Apply rejects placeholder or non-allowlisted accounts, old beta confirmation, missing external backup directory, repository-local/symlinked backup paths, missing phone-local clock, unsupported feasibility, hash drift, stale revisions, and missing/mismatched deployment identity
- [ ] Apply verifies all seven linked artifacts, exact schema/policy versions, exact candidate/artifact hashes, one successor assignment, and the private 0700/0600 redacted rollback evidence before reporting success
- [ ] Rollback runs only with mode `off`, restores the exact previous assignment with owner-scoped updates, supersedes the canary assignment, invalidates open v2.4 previews, and proves one active predecessor with no orphan active assignment
- [ ] Cleanup evidence is pseudonymous and is complete only after the disposable account, active assignments, open v2.4 candidates, and orphan assignments are all absent
- [ ] Railway starts the backend after the existing seed step with explicit `mode=on`, `audience=all`, and expected revision bound to exact `RAILWAY_GIT_COMMIT_SHA`; restart policy is unchanged
- [ ] Normal responses expose exact closed `X-Forge-Goal-Backward-Mode` / `X-Forge-Goal-Backward-Audience` values without refs, IDs, hashes, telemetry, environment contents, or secrets
- [ ] The expected-revision wait and production Playwright gates require exact `on` / `all` response headers
- [ ] Emergency public rollback deploys mode `off` or reverts the activation start configuration; the disposable script remains exact-ref-only and separately authorized
- [ ] CI/full QA, exact production revision/artifact, public preview/apply, emergency rollback readiness, and no critical/high/medium independent findings are evidenced before live verification is complete

Run the Phase 6 gate:

```sh
node backend/test/goalBackwardRelease.smoke.js
node backend/test/betaPlanRollout.smoke.js
node backend/test/racePlanDiagnostics.smoke.js
npm run qa
FORGE_QA_BASE_URL=https://forge-production-773f.up.railway.app npm --prefix frontend run test:e2e:production
node backend/scripts/upgrade-beta-race-plans.js
```

Public activation patch status (2026-08-16): `patched in source`; deployment, public live execution, disposable canary mutation/rollback/deletion, independent acceptance, and live verification remain separate gates.
