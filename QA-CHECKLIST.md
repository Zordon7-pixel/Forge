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
