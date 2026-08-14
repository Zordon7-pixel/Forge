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
