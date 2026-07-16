# Claude Code QA: Forged Closet v1

Repo: `/Volumes/Zordon Storage /openclaw-workspace/forge-app`

Review the current uncommitted diff on `main` as a senior security-minded engineer. Do not modify files, commit, push, deploy, or run EAS. Read `CLAUDE.md` and `FORGE-CLOSET-SPEC.md` first.

This release intentionally ships a bounded first version:

- additive `shoe_catalog` and `gear_shoes` metadata migrations in all three schema paths;
- idempotent startup seed for a 14-model, manufacturer-sourced pilot catalog;
- authenticated catalog search and catalog-linked/manual shoe creation;
- deterministic shoe recommendations with surface, session intent, wet-condition, rotation, and wear reason codes;
- Forged Closet mobile UI with zero state, catalog/manual add, edit, retire/delete, per-shoe wear display, top pick, alternatives, and cautious inspection language;
- a web-delivered What's New entry;
- no LLM decision-making, photo identification, social sharing, native changes, or EAS build.

Verify, do not assume:

1. **Security and ownership:** every user-owned SELECT/UPDATE/DELETE is scoped to `req.user.id`; all SQL is parameterized; catalog rows are global/read-only; no cross-user mileage or shoe mutation path exists.
2. **Migration safety:** `initDb()` creates `shoe_catalog` before the `gear_shoes.catalog_id` FK; `runAlwaysMigrations()` is idempotent on an existing production DB; `schema.pg.sql` matches; the FK guard is table-specific; startup seeding cannot destroy user data.
3. **Catalog integrity:** no model claims an unverified numeric field; provenance is manufacturer-owned; unknown models remain manually addable without fabricated specs; source/JSON fields round-trip correctly.
4. **Recommendation correctness:** retired/inactive shoes never win; over-estimate pairs are not silently recommended when a fresh option exists; race/wet/trail/rotation cases are deterministic; one-pair and all-over-estimate behavior is intelligible; no medical/injury causation claim is made.
5. **API boundaries:** query/body values are bounded and normalized; premium gating still honors beta full-access; location/weather failure degrades cleanly; response shapes match frontend expectations.
6. **Frontend behavior:** 0/1/many shoe states, mobile width, catalog/manual add, edit, include-retired, recommendation rationale/alternates, and per-shoe mileage threshold; no hardcoded 500-mile regression; no duplicate route/menu surface.
7. **Release notes:** sequence, translations, CTA allowlist, eligibility, and newest-release behavior remain valid.

Run at minimum:

```bash
node --check backend/src/db/index.js
node --check backend/src/db/migrate.js
node --check backend/src/db/shoe-catalog-seed.js
node --check backend/src/lib/shoeRecommendation.js
node --check backend/src/routes/gear.js
node backend/scripts/shoe-closet-smoke.js
node frontend/test/releases.smoke.mjs
cd frontend && npm run build
cd ../backend && npm run check:account-data
```

Report findings first, ordered CRITICAL/HIGH/MEDIUM/LOW with exact `file:line` evidence and a minimum-scope fix. Explicitly state PASS or BLOCK. Also list commands run and any runtime behavior not checked. Do not silently skip disagreements with the spec.
