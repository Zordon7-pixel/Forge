# Claude Code QA: Forged Hybrid H14 mobility visuals and navigation cleanup

Perform an independent, read-only QA of:

`/Volumes/Zordon Storage /openclaw-workspace/forge-app`

Branch: `main`
Base commit: `b1f590d8`

Read `CLAUDE.md` first. Inspect the full working-tree diff from the base commit, including untracked form-guide assets. Do not edit files, mutate user or production data, commit, push, deploy, or run EAS/TestFlight.

## User-reported failures

1. Some stretch sessions displayed `FORM IMAGE QUEUED` instead of a real movement guide. Every catalog stretch and every warm-up must have a local form image.
2. A stretch guide must show one athlete matching the profile sex, never the male and female models together.
3. Body was cluttered with Data coverage, Connected sources, and Sync controls. Those management surfaces belong under More, with no duplicate Apple Health controls in Settings.
4. Train Quick Actions needed permanent Start Warm-Up and Start Stretches entries plus one deterministic smart shortcut based on the signed-in user's actual navigation frequency.

## Intended behavior

- All 40 backend stretch catalog entries resolve to an existing local `/stretches/*` PNG or WebP. API responses never emit the old remote stock-photo URL.
- The 5 Warmup steps and all 12 static pre/post-run movements resolve through `MovementDemo` to a real local form image.
- Composite generated assets place a woman on the left and a man on the right. `MovementDemo` crops to exactly one side after `/auth/me` resolves. Male profiles receive the male crop; female profiles receive the female crop.
- Warmup, the dynamic stretch library, and the static pre/post-run session do not render until profile sex resolution completes. A profile-fetch failure is logged with context.
- The static pre/post-run countdown does not start until profile sex resolution completes.
- `FORM IMAGE QUEUED` remains only a defensive fallback for unknown future movements; no current catalog or warm-up reaches it.
- Body retains training/readiness metrics and `How your plan uses this data`, but contains no Data coverage, Connected sources, Sync controls, or Sync Apple Health button.
- More contains one compact Health data & sync surface: connected source status, exactly one Apple Health sync button, and collapsible Data coverage.
- Settings retains provider connection/file-import controls but no duplicate Apple Health sync/import or Health Data Center button.
- Train Quick Actions render exactly three stable mobile controls: Start Warm-Up, Start Stretches, and one of View History / Check Body / View PRs.
- Smart shortcut counts only exact destination routes, is namespaced by JWT user id, persists locally, picks the highest count, and has deterministic View History tie/first-use behavior. It does not duplicate the existing plan CTA or run-logger CTA.
- No native code, build number, EAS profile, dependency, database schema, auth scope, user data, or AI behavior changes.

## Review priorities

1. Compare every ID in `POOLS` with `LOCAL_IMAGE_BY_ID`; verify file existence and real PNG/WebP signatures, including `childs-pose` and the exact Butterfly screenshot case.
2. Review the generated image crop assumptions against `MovementDemo` (`maleSide`, female opposite side, profile-sex wait, provided male/female files).
3. Trace all entry points: `/warmup`, `/stretches`, `/stretches/session?type=pre`, and `?type=post`.
4. Look for empty catches, stale remote URLs reaching the UI, a profile race that briefly shows the wrong sex, timer/effect regressions, broken skip/next behavior, or image overflow.
5. Confirm Apple Health management is absent from Body and duplicated nowhere else; provider/file controls in Settings are not incorrectly removed.
6. Review the smart-action storage parser, user namespacing, tie behavior, count overflow, route matching, and React hook use.
7. Inspect mobile layout at 390x844: no horizontal overflow, bottom-nav collision, clipped action labels, nested-card clutter, or blank image states.

## Required commands

```bash
cd "/Volumes/Zordon Storage /openclaw-workspace/forge-app"
git diff b1f590d8 --check
node --check backend/src/routes/stretches.js backend/scripts/stretch-catalog-smoke.js
node backend/scripts/stretch-catalog-smoke.js
for file in frontend/test/*.smoke.mjs; do node "$file"; done
cd frontend && npm run build
npm audit --audit-level=high
npx cap sync ios
cd ../backend && npm run check:account-data
```

If `npx cap sync ios` creates tracked native diffs, report them and do not commit them. Do not use EAS as a workaround for any local limitation.

## Response format

Lead with findings ordered CRITICAL / HIGH / MEDIUM / LOW and cite exact `file:line` evidence. Then report:

- each user-reported failure as `VERIFIED FIXED`, `DISAGREE`, or `FIX REQUIRED`;
- catalog/static-routine coverage counts and missing assets, if any;
- profile-sex crop and fallback assessment;
- Body / More / Settings de-duplication assessment;
- smart-action behavior assessment;
- mobile layout and console assessment;
- exact toolchain results;
- final verdict: `PASS`, `PASS WITH RISKS`, or `FAIL`;
- whether the web/backend changes are safe for Railway, while explicitly stating that no EAS build is authorized.
