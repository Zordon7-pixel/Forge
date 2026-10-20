# CLAUDE.md — Forge Project Intelligence

> **Read by: CW3 Codex (before building) AND Claude Code (before QA review)**
> Updated after every build. If you're building or reviewing, read this first.

---

## Private saved route builder — t_0f9a44da Phase 1A (patched; uncommitted)

Base `07c356d8a4b5bd43bf213089b54ff59e47642eaf`. Backend foundation only:
`user_routes` is private planned-course storage, separate from `shared_routes`,
sampled ActiveRun coordinates and canonical activity/training evidence. Identical
SQLite/PostgreSQL DDL is additive/idempotent, included in the fresh schema and
the existing locked always-migration transaction. The existing account-data
registry exports/deletes owned routes; the FK also cascades account deletion.

Bearer-authenticated endpoints (private/no-store, Vary Authorization):

- `POST /api/user-routes` → 201 `{route}`, Location header.
- `GET /api/user-routes?limit=20&offset=0` → `{routes,limit,offset}`; summaries
  omit geometry, waypoints and legs. Limit 1–100, offset 0–1,000,000.
- `GET /api/user-routes/:id` → `{route}`.
- `PUT /api/user-routes/:id` → `{route}`; full replacement, not a partial patch.
  Omitted optional metadata clears to unknown. Creation time is preserved.
- `DELETE /api/user-routes/:id` → 204.
- `GET /api/user-routes/:id/gpx` → GPX 1.1 `trk/trkseg/trkpt`, every saved point
  in order, per-point `<ele>` only where finite valid altitude exists. No
  interpolation, simplification, sampled timestamps or elevation synthesis.
  XML escapes the name; download filenames use only the validated UUID. The
  description labels the route planned and discloses straight segments.

POST/PUT accept only this contract:

```js
{
  name: 'My planned course',                      // 1–120 characters
  waypoints: [[-73, 40], [-73.01, 40.01]],         // ordered [lon,lat]
  geometry: { type: 'LineString',
    coordinates: [[-73, 40], [-73.01, 40.01]] },   // [lon,lat,altitudeMeters?]
  legs: [{ mode: 'straight', provenance: 'manual', profile: null,
    startIndex: 0, endIndex: 1 }],
  distanceMeters: 1400,                          // finite, 0–1,000,000
  targetDistanceMeters: null,                    // optional, same range
  elevation: { source: null, gainMeters: null, lossMeters: null },
  display: { description: null, surface: null, elevationPreference: null }
}
```

Bounds: uncompressed JSON at most 1 MiB, 2–100 waypoints, 2–10,000 geometry
vertices; primitive finite numbers only, longitude ±180, latitude ±90, altitude
−2000–100000 meters (existing coordinate-normalizer bounds). No point removal,
rounding or reordering. Exactly one leg per adjacent waypoint pair; leg indexes
are inclusive, contiguous and cover the whole geometry. A `straight/manual`
leg has two points and null profile. A `routed/ors` leg carries `foot-walking`
or `foot-hiking`. Waypoints are selected controls; routed geometry can be snapped
by the existing provider. No waypoint-to-geometry snapping is performed here.

Elevation source is nullable or `manual|imported|provider`; any supplied heights
or gain/loss require a source. Gain/loss are independent nullable supplied values
(0–1,000,000 meters), never computed or filled with zero. `coverage` is derived
from point heights as `missing|partial|complete`; callers may echo it only if
it matches. Coverage describes geometry heights, not aggregate availability.
Display fields: nullable description ≤500 characters, `road|trail|mixed`
surface, `flat|balanced|hilly` elevation preference. Unknown fields, control
characters, malformed UUIDs/numbers and cross-user access fail closed.

Responses add `id`, `schemaVersion:1`, `kind:'planned'`,
`provenanceTrust:'client_declared'`, `createdAt`, `updatedAt`. These generated
fields must not be echoed in POST/PUT. Labels never certify provider evidence.
Missing and foreign IDs both return 404; invalid input 400, oversized bodies 413,
storage failure 503, with no coordinates or raw SQL errors logged/returned.
Writes use the existing account mutation guard; no training revision advances.

The reviewed `POST /api/route-planning/leg` remains unchanged and is the only
manual-builder ORS call path. No new provider logic, quota/cache, live calls,
ActiveRun changes, native code, dependency manifests or release operations.

Local gates: `node backend/test/userRoutes.smoke.js` and `--postgres` (each
8 groups, real SQLite/disposable PostgreSQL); existing plannedLeg (12 groups),
route-engine, account-data coverage (66 tables, atomicity/auth mutation guard),
accountReceiptCoverage and the three planning mutation/plan/concurrency smokes.
All pass with network guards/mocks. Syntax/diff checks are also required.

Verification limitations: this worktree had no dependencies; offline npm ci
failed because xtend was uncached. A separate ignored copy of existing packages
resolves modules, but seven versions differ from the lock (axios, ip-address,
nodemailer, proxy-addr, qs, side-channel, side-channel-list); exact-lock host QA
remains necessary. PostgreSQL's sandbox shared-memory denial recovered under
expanded local permissions. Initial test DDL regex incorrectly matched
`updated_at` and was corrected; a zsh wrapper-variable error also recovered.
No package/lock changes or downloads. This is not independent QA or release
readiness; coordinator owns commit, review and lifecycle.

Phase 1B must build the manual editor/library and map GeoJSON `[lon,lat]` to the
existing `[lat,lon]` planned overlay, convert meters to display units, preserve
straight/routed labels and partial/missing elevation, and keep account-scoped
client state. ActiveRun currently truncates planned overlays to 800 points;
address that seam explicitly without changing recorded samples or their truth.
Do not treat saved routes as completed runs, navigation instructions, or load.

## Share alpha remediation — t_e510d614 (patched; uncommitted)

Base `00e1864bd0fc2a7c8b4068279f92be8e2f359699`. The actual darwin-arm64
batch-1 generator reproduced the alpha assertion failure (exit 1, zero writes).
C1's shared draw wrapper cleared then unconditionally filled the entire canvas
with an opaque theme background. Real Chromium output confirmed all 18 bare C1
variants had zero nonopaque pixels and alpha 255 at all four corners. A second
defect was Studio's hardcoded `transparent=false`, which forced JPEG on Share,
Save and social-post encoding even with a transparent renderer.

C1 now applies its opaque backing only when a photo is selected. Studio selects
PNG for bare C1 designs and JPEG for photo composites/Full-Bleed. Full-Bleed's
renderer is unchanged. The new canvas/decoded-PNG alpha regression fails before
the renderer patch; the actual UI PNG assertion independently fails before the
Studio patch. After repair, all 18 bare C1 variants have transparent corners,
725730–2006432 nonopaque pixels, and zero decoded-PNG alpha-byte mismatches.
All 24 diagnostic photo PNG SHA256s are identical before/after. This is renderer
evidence, not visual golden approval. Half-transparent real File inputs also
exercise opaque backing for all four explicitly selected designs; reopening
restores the bare output. The picker intentionally requests Full-Bleed after a
photo selection, so the regression reselects each C1 design before checking it.

Commands use `PLAYWRIGHT_BROWSERS_PATH=/Users/zordon/Library/Caches/ms-playwright`
for Chromium. Raw logs are `/tmp/t_e510d614-alpha-*.log`:
- `node frontend/test/shareOverlaysC1.smoke.mjs --smoke`: before exit 1;
  after exit 0, 11 groups, all 18 C1 + 24 Full-Bleed cases.
- `node frontend/test/activityShareStudioFramework.smoke.mjs`: before exit 1
  (JPEG instead of PNG); final exit 0, 26 groups, exact export bytes/privacy,
  PR/hybrid entry and photo controls. The first new photo test was strengthened
  to explicitly reselect the intended design; the final rerun includes that fix.
- `node frontend/test/{shareReleaseTemplates,activityShareEntry,shareStats,
  activityShareStudioPhaseC,activityShareStudioSingleFlight,shareGoldenProvenance}.smoke.mjs`
  (six separate commands): all exit 0; provenance retains 88 rejection cases.
- `node frontend/test/shareGoldenProvenance.mjs --prepare`: exit 0; generated
  pending lock/pin only, both platform receipts null. No digest was hand-edited.
- Normal Vite API build from `frontend`, empty envDir
  `/tmp/t_e510d614-alpha-no-env`, output `/tmp/t_e510d614-alpha-build`: exit 0.
  Existing Browserslist age/large-chunk warnings remain; dependencies unchanged.
- `git diff --check`: exit 0.

Seven repository paths: two product files, two browser test files, generated
acceptance-v2 JSON/SHA256, and this document. Zero golden PNGs or generation
receipts written. Batch 1 alone writes ten paths and requires a clean checkpoint;
rerunning it after this uncommitted repair would violate this session's path
budget/clean-generation guard. No guard bypass, batch 2, Linux artifact, review,
commit, push, merge, deployment or handoff message. Actual Mac/Linux captures,
pixel approval and final exact-SHA QA remain pending. The original alpha assertion,
42-case matrix, <=0.1% tolerance, exact four IDs and all privacy/wiring contracts
remain. Trace/Forged Days excluded. This seven-path change must be flagged in the
eventual review packet; no auth/evidence/production-data mutation is involved.

## Share Studio batch 4 — t_e510d614 (patched; host verification pending)

Base: `1a89d2939bb34ea7489f2fd74799bc728a1525ea`. Host QA's first
`iron-chips/light/Story` byte mismatch came from different selected designs.
The picker returned early when clicking the active default Iron Chips, leaving
`requestedTemplate=null` (or a removed saved ID). Feed resolved to Iron Chips;
Story resolved to Full-Bleed. The UI's render effect and export used that new
Full-Bleed canvas, while the independent oracle explicitly requested Iron Chips.
An offline execution of the actual old click closure/resolver/draw dispatch
reproduced both 1080×1920 outputs with different text/draw commands. This is a
selection-contract defect, not evidence for changing the byte oracle or privacy.

The click now records the explicit ID before the active-design early return.
It preserves the ready canvas when the resolved design is unchanged and still
invalidates synchronously for a different design. No renderer, privacy adapter,
export encoding, default resolver, registry or photo behavior was changed.
The deterministic regression failed against the old handler and passes against
the patch for all four IDs, absent/six legacy preferences, sizes/themes and route
states. Browser regressions retain exact bytes and assert selected controls;
reopening waits for the prior mount to detach before checking new readiness.

Six repository paths changed: this file, ActivityShareStudio.jsx, framework smoke,
release-template smoke, and the two generated acceptance-v2 fingerprint files.
`node frontend/test/shareGoldenProvenance.mjs --prepare` refreshed only the
changed component digest and paired pin, with state **pending** and both platform
receipts null. Zero images generated/approved; all 18 C1 + 24 Full-Bleed cases,
strict comparison and provenance guards remain. Trace/Forged Days stay excluded.

Advisory commands and raw logs: `/tmp/t_e510d614-batch4/commands.json`.
Release templates, entry, stats, Phase C, single-flight, provenance (88 negatives),
and C1 `--filter-only` exit 0. Framework syntax, env-isolated normal Vite build
(`/tmp` output; existing large-chunk warning) and diff check exit 0. Framework
browser command exits 1 before page load: sandbox loopback listen EPERM, both
before and after the patch. Full golden gate exits 1 because acceptance remains
pending. Real-host browser bytes, actual Linux captures, golden review and release
gates still require Hermes; no commit, review request, handoff message or shipping
action was performed. This diff exceeds two paths and touches privacy regression
coverage; it changes no auth, evidence, timestamps or production data handling.

## Share overlay framework — t_38ab05ed (patched; not deployed)

Card B moves only the six existing run layouts into `shareTemplates.js` with
`{ id, label, supports, themes, sizes, draw }` entries. `shareTheme.js` owns the
brand/theme tokens, Feed/Story dimensions and four bundled FontFace assets.
Story fits the original layout uniformly between y=250 and y=1580; post-image
resizing uses integer multiples of the source aspect ratio. Missing stats and
HR zones are omitted. Footer identity comes only from ShareModel.handle.

ActivityShareStudio accepts `model` or the existing `run` shim. The shim reads
own handle/settings, validates available preference timezones and falls back to
the device timezone (UTC only if the device timezone is unavailable). Show route
starts ON for each mount, is not persisted, and OFF removes geometry/elevation
profiles from the adapter output and the fresh allowlisted renderer model.
Export waits for the current render; synchronous invalidation prevents an old
ON image from being exported after OFF. No C1/C2 overlays or new entry points.

Contract clarification: at base `6059766df7dda83772efa9bb7957399679f9ef2f`,
released A accepts an options object, not a bare boolean. B validates the UI's
showRoute as a primitive boolean and calls `fromRun(run, prefs, { showRoute })`.
Passing bare `false` to that base would leave routes ON. A is unchanged. B does
not compose hybrid models; supplied models are sanitized without retaining META.
Route privacy zones/start-finish trimming remain a follow-up before Trace is
made a default selection; enabled geometry is shown exactly as recorded.

Local gates: `node frontend/test/activityShareStudioFramework.smoke.mjs`
(22 groups, including 36 UI-export matrix cases, safe bounds, exact exported
bytes, alpha, OFF/ON/reset, same-tick privacy, actual Save single-flight, photo,
summary share/download, preferences and font failure fallback), existing
`activityShareStudioPhaseC.smoke.mjs`, `activityShareStudioSingleFlight.smoke.mjs`,
`shareStats.smoke.mjs`, and `npm --prefix frontend run build`.
This is a local implementation candidate, not independent review or release.

## Sync CI acceptance maintenance — 2026-09-27

The QA workflow runs deterministic/audit/build and complete mobile/SW browser
suites in independent bounded Linux jobs. Both install locked frontend/backend
dependencies. The previous combined check name remains a fail-closed aggregate;
production-shell verification requires both suites and the aggregate to succeed.
`frontend/test/ciWorkflow.smoke.mjs` guards commands, omissions and gate outcomes.
Native compilation is byte-for-byte unchanged. This split addresses the observed
combined-job timeout; it does not establish a new remote CI pass by itself.

`finalBetaTrainingTruth.smoke.js` now checks delegated foreground wiring and
executes the real `healthAutoSync`/`healthSyncLiveness` suites for cooldown,
observer bypass, profile/import account fencing and teardown. Stale inline-App
regex assumptions were replaced; production behavior is unchanged.
The H12 gate likewise requires account-scoped checkpoint acknowledgment and runs
the real-service suite, including failed-clear/retry without false completion.

## Manual strength acquisition — 2026-09-27

`STRENGTH-LOG-OBSERVATION.md` documents the versioned USER_RECORDED log projection
for historical strength sessions. Declared occurrence and database recording time
remain separate; known sets can coexist with unknown duration. This is not
canonical adherence, tolerance, complete coverage or progression authority. The
first-plan strength source gate and all initial-dose policies are unchanged.

### Completed-log duration — t_acfb9614 (patched; not deployed)

`POST /api/workouts/strength` optionally accepts explicit `started_at` and
`ended_at` timestamps with timezone offsets. Valid positive pairs retain those
timestamps and elapsed seconds rounded to the existing INTEGER precision;
missing/invalid pairs, values rounding to zero and INTEGER overflow store NULL.
`completed_at` retains its legacy occurrence-marker behavior and never supplies
duration. No migration/backfill or volume column is added; old zero rows remain
untouched. At this base LogLift uses `/workouts/start` then ActiveWorkout's
`/:id/end`, not the completed-log POST. Gates: `strengthLogAcquisition.smoke.js`,
`logLiftSaveFlow.smoke.mjs`, `activeWorkoutMobile.smoke.mjs`.

## ORS one-leg planning — t_fd6b89ea Phase 2 (local candidate)

`POST /api/route-planning/leg` uses existing bearer authentication and accepts only
`{profile, points}`: profile `foot-walking` or `foot-hiking`, exactly two ordered
`[longitude, latitude]` pairs of finite JSON numbers within geographic bounds.
Unknown fields/options and query parameters are rejected. The authenticated JSON
parser rejects compressed bodies and bodies over 1 KiB. Coordinates normalize via
`Number(value.toFixed(5))` before hashing and routing; negative zero becomes zero.
V1 has no client options; fixed `instructions=false`, `elevation=false` and the
contract version participate in the owner/profile/ordered-points SHA-256 key.

`ORS_API_KEY` is server-only and has no example value. Missing, blank or malformed
keys disable this endpoint, including cached responses. Valid credentials travel
only in the Authorization header to the fixed
`https://api.heigit.org/openrouteservice/v2/directions/{profile}/geojson` endpoint.
See the [official directions response contract](https://giscience.github.io/openrouteservice/api-reference/endpoints/directions/requests-and-return-types).
Redirects, retries and automatic provider/straight-line fallbacks are disabled.
The 8-second abort/deadline covers headers and body; streamed JSON is capped at
512 KiB and geometry at 10,000 two-dimensional points. Responses contain only
`leg: {profile, geometry, distanceMeters, durationSeconds}` and `status.cache`,
or a stable error code plus a bounded integer Retry-After when applicable.
Responses are private/no-store; request coordinates, keys and upstream/SQL errors
are never logged by this boundary. Explicit straight-line mode remains a future
client choice. Planned geometry never updates recorded runs, ActiveRun samples,
route integrity, workout evidence or canonical route truth.

Database `clock_timestamp()` supplies the clock in PostgreSQL; SQLite adapters
use UTC epoch milliseconds. Buckets are `floor(epochMs/86400000)` (00:00 UTC daily)
and `floor(epochMs/60000)` (UTC minute), independent of host/user timezone. Before
each upstream attempt, one owner-guarded transaction locks the global singleton,
checks all four limits, and commits both global and user counters atomically:
1,900/day + 35/minute globally; 100/day + 10/minute per user. This leaves headroom
of 100/day and 5/minute under the stated 2,000/day and 40/minute provider caps.
Reservation failures/unknown state fail closed; every committed reservation
counts even on timeout, 429, invalid credential, provider/body/cache-write failure
or an interrupted process. Cache hits reserve nothing, including at exhausted
limits. Rolling windows are not used. A backwards bucket clock fails closed.

The same DB lock bounds the private persistent cache to 10,000 entries. Entries
expire exactly 24 hours after insertion; expired entries are removed on writes,
then oldest creation time/owner/hash wins deterministic eviction. Per-process
in-flight duplicates coalesce; different processes may each make a budgeted miss.
Cache and user counters survive process/database restart, are owner-scoped and
participate in account export/deletion; the global counter is never reset by an
account deletion. Fresh/upgrade DDL is additive, and a transactional migration
marker seeds the global row only once. Missing/corrupt budget state after that
requires operator repair; startup never silently replenishes it. Do not drop or
reseed these tables during an active quota window.

429 handling persists a service-wide cooldown across instances/restarts. Valid
integer or IMF-fixdate Retry-After values become 60–86,400 seconds; absent/invalid
values become 60 seconds. No automatic timer initiates another request. Other
instances may finish attempts already reserved before a 429, within the same
conservative budgets. Stable 429 responses expose no global or other-user totals.

### Remy P2/P3 remediation — t_fd6b89ea (local candidate)

Starting SHA `0ba2329e185685057f2ad64f05b636c1a209c0e5`; base
`1b80ccc41b97de8f45698eb1ee69fb6dbe2f2ec4`. Legacy `/api/routes/generate`
and `/api/routes/search-start` now use the same `ors_planning_global` and
owner-scoped user ledger as planned legs. Generate reserves exactly three units
in one all-or-nothing transaction, including accepted legacy cache hits; geocoding
reserves one. Planned-leg cache hits remain free. All four limits, UTC buckets,
DB clock, backwards-clock checks, migration marker and account-deletion behavior
are unchanged. No second ledger or schema change. The legacy in-process limiter
remains an extra throttle, never quota authority. Legacy credentials remain
`OPENROUTESERVICE_API_KEY`; safety no longer depends on separate provider accounts.

Legacy calls require an authenticated owner and reserve before upstream work.
Every candidate checks the persisted cooldown before its fixed-host request;
redirects are disabled. A 429 persists bounded Retry-After before body parsing,
and takes precedence over successful sibling candidates. Already-reserved work
may finish; no retries or automatic fallback. Committed units survive every
failure. Unknown ledger state fails closed, and provider/SQL error text is not
logged or sent to clients. Legacy cache keys now include the authenticated owner.
Unrelated external consumers of the provider account remain outside this ledger.

Thunderforest failure removes only the TileLayer. The same MapContainer,
recorded/planned polylines and markers remain mounted over a plain background,
with a bounded non-blocking indicator. The exact attribution text and two links
remain visible. Missing runtime configuration still shows the unavailable state
without making tile requests. No public OSM fallback, proxy, service-worker tile
cache, prefetch or referrer-policy change. Recorded activity truth is untouched.

Local deterministic gates (all exit 0):

```sh
node backend/test/plannedLeg.smoke.js
node backend/test/plannedLeg.smoke.js --postgres
node backend/scripts/route-engine-smoke.js
node backend/test/authMutationGuard.smoke.js
node backend/scripts/check-account-data-coverage.js
node backend/test/planningMutationRoutes.smoke.js
node backend/test/planningPlanRoutes.smoke.js
node backend/test/planningRevisionConcurrency.smoke.js
node backend/test/accountDeletionAtomicity.smoke.js
node backend/test/accountReceiptCoverage.smoke.js
node frontend/test/routePlannerData.smoke.mjs
PLAYWRIGHT_BROWSERS_PATH=/Users/zordon/Library/Caches/ms-playwright node frontend/test/mapTiles.smoke.mjs
git diff --check
```

SQLite: 12 groups, including actual 380 planned legs + 1,140 legacy directions
+ 380 geocodes = 1,900 attempted units; the last geocode's malformed 429 counts.
Per-user/global boundaries, three-unit rejection rollback, cache ownership/cost,
timeouts/errors, actual legacy HTTP/auth/redaction, missing state/backwards clock
and shared cooldown are covered. Real disposable PostgreSQL: three groups,
including concurrent one/three-unit writers, full mixed 1,900 attempts and a
stopped/restarted local server retaining counters/cache/cooldown. Synthetic
credentials and intercepted providers only; zero live provider requests.

Browser gate: actual four consumers at 320/393 px, one simulated image error
preserving exact DOM map/SVG nodes and geometry, visible route/marker overlays,
plain background, exact attribution/links, and missing/bad keys. Screenshots in
`frontend/test-results/map-tiles/` (ignored). The gate builds fresh with the normal
Vite config imported directly, an empty temporary envDir, isolated output and
source maps. All assets/source maps/responses are sentinel-scanned. Leaflet's
source-map documentation example is excluded only from the no-OSM-URL assertion;
executable assets and application mapped sources remain checked, and no mapped
content is exempt from credential scans.

Verification hiccups: sandbox blocked PostgreSQL shared memory and browser
loopback listening; authorized expanded local permissions recovered both gates.
Vite's initial config bundling attempted a write into shared read-only dependency
storage; direct config import avoids that write. The first expanded map scan
flagged Leaflet's documentation example; inspection established its origin and
the assertion was scoped as above. Existing Browserslist age warning remains.

Eight changed paths, including this document and three test files. This exceeds
two paths and touches authenticated quota enforcement; no schema, dependencies,
lockfiles, native code, recorded evidence or production data changes. No auxiliary
reviewer, Hermes/Kanban action, provider/production access, push, release or deploy.
Independent exact-SHA QA/review and release remain Hermes-owned.

### Served referrer / unavailable-config remediation — t_fd6b89ea (patched)

Starting/failed SHA `d9df2d8b8d4319c525624497c0ef50b6bf84edad`, unchanged base
`1b80ccc41b97de8f45698eb1ee69fb6dbe2f2ec4`. This supersedes the prior candidate's
missing-config placeholder and unchanged-referrer statements above. Helmet now
explicitly sends `Referrer-Policy: strict-origin-when-cross-origin`; every other
Helmet/CSP option is unchanged. Once configuration resolves or fails, ForgeMap
mounts Leaflet and its existing children even without a usable key. Only a valid
key may mount TileLayer. Loading retains its prior placeholder; bad tiles still
remove only TileLayer. The bounded, noninteractive unavailable indicator and
exact linked attribution remain visible over the existing plain background.

`mapReferrer.smoke.mjs` builds the normal SPA with an empty envDir into a temporary
frontend/dist, then executes the actual Express app source, route registration,
Helmet, static serving and SPA fallback. Only DB/bootstrap operations are stubbed;
dotenv is disabled and the child environment is allowlisted. Runtime tile config
uses the real endpoint and real JWT middleware with a signed synthetic user.
Other app API data and external font CSS are mocked. Browser tile transport is
intercepted, external DNS is disabled, and backend outbound HTTP/fetch is denied.
No Referer or User-Agent is injected. Chromium loads `/run/active` with a private
query, gets the exact built index and JS, then issues tiles with origin-only
Referer and its own UA. A second execution removes only the new Helmet option:
the actual prior `no-referrer` header produces blank tile Referer, rejecting the
required origin contract. All other served security headers match across runs.

`mapTiles.smoke.mjs` now checks all four actual consumers at both 320/393 px for
absent/null/blank/invalid keys, failed config retrieval, delayed loading, and tile
failure. It asserts visible route/marker SVGs, plain background, zero tiles when
unconfigured, bounded indicator, exact attribution/links and no horizontal
overflow. Existing exact DOM/geometry preservation on tile error and recorder
truth checks remain. All build/cache/screenshots are temporary, outside the repo.
The strengthened regression failed before the component fix (missing Leaflet
container), then passed. Inspected 320 px recorder and 393 px planner failure
screenshots retain the route/markers and readable attribution.

Local commands (all final exits 0; browser commands use
`PLAYWRIGHT_BROWSERS_PATH=/Users/zordon/Library/Caches/ms-playwright`):

- `node frontend/test/mapReferrer.smoke.mjs`
- `node frontend/test/mapTiles.smoke.mjs`
- `node backend/test/plannedLeg.smoke.js` (12 groups, mixed 1,900 units and
  SQLite restart-persistent cooldown; PostgreSQL rerun remains host QA scope)
- `node backend/scripts/route-engine-smoke.js`
- `node frontend/test/routePlannerData.smoke.mjs`
- `node backend/test/authMutationGuard.smoke.js`
- Fresh isolated normal frontend builds within both browser gates; map gate
  retains source-map/key-sentinel/no-public-OSM-fallback scans.
- `git diff --check`

Raw final logs: `/tmp/t_fd6b89ea-referrer-final.log`,
`/tmp/t_fd6b89ea-map-after.log`, and `/tmp/t_fd6b89ea-{plannedLeg,route-engine,
routePlannerData,authMutationGuard}.log`. Verification hiccups: sandbox loopback
EPERM recovered with expanded local permissions; the new Express fixture first
lacked the Strava startup DDL stub, then rejected the SPA's blocked Google Fonts
CSS request, both corrected without product changes. A batch-tool negotiation
timeout returned no test receipts/logs; direct runs verified the focused gates.
Read-only inspection also encountered truncated output, an incorrect db.js path,
stalled search and denied process inspection; direct reads completed the review.
Existing Browserslist age, large-chunk and test-cache Babel warnings remain.

Five changed paths, including this document; flag the security-header change and
scope over two files for independent exact-SHA review. No ORS, routing, auth,
ownership, schema, native, dependency, recorded evidence or production data
implementation changed. No live provider requests, Kanban/messages, push, merge,
deploy or restart. This is local verification, not independent acceptance or
live WebView verification; Hermes owns host QA, review and lifecycle.

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
| `FORGE_GOAL_BACKWARD_V24_MODE` | No | Goal-backward v2.4 runtime mode: `off\|shadow\|preview\|on`. Missing, malformed, whitespace-padded, or otherwise invalid values resolve to `off`. The Railway start configuration explicitly selects `on` for public activation. This flag is independent of `FORGE_BETA_ACCESS`. |
| `FORGE_GOAL_BACKWARD_V24_AUDIENCE` | No | Closed runtime audience: `cohort\|all`. Missing, malformed, whitespace-padded, or unknown values resolve to fail-closed `cohort` behavior. `all` authorizes only production-shaped UUID account IDs. The Railway start configuration explicitly selects `all`. |
| `FORGE_GOAL_BACKWARD_V24_DISPOSABLE_COHORT_REFS` | When runtime audience is `cohort`, and for the migration script | Comma-separated `sha256:` pseudonymous refs for explicitly authorized disposable/canary accounts. Raw user IDs are rejected. Independently of the public runtime audience, the standalone migration/canary script always requires an exact matching ref. |
| `FORGE_GOAL_BACKWARD_V24_EXPECTED_REVISION` / `RAILWAY_GIT_COMMIT_SHA` | For public runtime and v2.4 script apply | The Railway start command binds the expected runtime revision to its exact deployed Git revision. The canary script separately requires independently supplied expected and deployed revisions to match. |
| `FORGE_GOAL_BACKWARD_V24_EXPECTED_ARTIFACT_SHA256` / `FORGE_GOAL_BACKWARD_V24_DEPLOYED_ARTIFACT_SHA256` | For v2.4 apply | Independently supplied expected and deployed frontend artifact identities; both must be full `sha256:` hashes and match exactly. |

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
- A distance-only canonical run can prove a duration floor only from a primitive observed pace in the bounded 180–2400 seconds/mile range, using the conservative 90% faster-side bound; an explicit duration remains authoritative.
- FOUNDATION search may preserve an easy-run source dose as a truthful recovery-run prescription and raise an explicit short dose only to the applicable recovery floor. The canonical family/title/dose must reflect the change, and no exception marker is manufactured.
- Candidate enumeration retains a deterministic 256-entry frontier, prioritizes presentation-floor viability before material-family similarity, and remains subject to the unchanged 65,536 expanded-node ceiling and all hard validators.

Phase 2B-1 gate:

```sh
node backend/test/goalBackwardCanonical.smoke.js
node backend/test/goalBackwardGoalFloorRecovery.smoke.js
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

## Goal-Backward Coaching v2.4 — Phase 6 Release and Public Activation Contract

The runtime release resolver accepts only the closed audiences `cohort` and `all`. Code defaults remain fail-closed (`mode=off`, `audience=cohort`); missing, malformed, whitespace-padded, or unknown audience values are never public. `cohort` retains the exact pseudonymous `sha256:` allowlist check. `all` authorizes only production-shaped UUID account IDs and never blank or synthetic IDs. `shadow` computes and records the comparison while the current candidate stays authoritative, `preview` exposes the canonical candidate but rejects apply, and `on` permits a fully bound apply only while the live mode and audience still authorize the account. `FORGE_BETA_ACCESS` is not release authority.

Repository-controlled Railway startup selects `mode=on` and `audience=all`, and binds `FORGE_GOAL_BACKWARD_V24_EXPECTED_REVISION` to Railway's exact `RAILWAY_GIT_COMMIT_SHA` when the backend process starts. Normal responses expose only the closed normalized mode/audience in `X-Forge-Goal-Backward-Mode` and `X-Forge-Goal-Backward-Audience`; `X-Forge-Revision` remains unchanged. This source configuration is the public activation intent, not evidence that a deployment is live.

Release evidence is a bounded, closed-schema stream containing mode, policy/schema versions, reason counts, candidate selection, outcome, surface capability, and revision-mismatch state. It contains no plan/evidence payload, raw ID, health sample, route, email, token, or free text. A hard-validator bypass, mutation after stale failure, revision mismatch, unknown-to-zero conversion, telemetry redaction failure, surface executability mismatch, or duplicate assignment has a zero threshold and forces subsequent mode resolution to `off`.

The standalone rollout script remains a separate disposable migration/canary utility. It defaults to a database-free, zero-write `off` dry run, and public runtime `all` authority never replaces its explicit target allowlist. An apply additionally requires one explicit non-placeholder disposable ID whose `targetRef()` is in `FORGE_GOAL_BACKWARD_V24_DISPOSABLE_COHORT_REFS`, a fresh authoritative phone-local clock, supported feasibility, exact deployed revision/artifact hashes, exact candidate hash replay, all seven immutable artifacts at the expected schema/policy revisions, `--confirm=APPLY_GOAL_BACKWARD_V24`, and a private 0700 directory outside the checkout. It writes 0600 redacted pre-apply, result, and cleanup evidence. Script rollback runs separately with mode `off`, `--rollback`, `--confirm=ROLLBACK_GOAL_BACKWARD_V24`, the explicit disposable ID, and the private manifest; it supersedes the canary assignment, restores the previous assignment owner-safely, invalidates open v2.4 previews, and verifies one authoritative predecessor.

Emergency public rollback is to deploy with `FORGE_GOAL_BACKWARD_V24_MODE=off` or revert the Railway activation start configuration. Independently, any zero-tolerance release alert forces affected runtime mode resolution to `off` before subsequent preview/apply execution.

Batch 16 gate:

```sh
node backend/test/goalBackwardRelease.smoke.js
node backend/test/betaPlanRollout.smoke.js
node backend/test/racePlanDiagnostics.smoke.js
npm run qa
FORGE_QA_BASE_URL=https://forge-production-773f.up.railway.app npm --prefix frontend run test:e2e:production
node backend/scripts/upgrade-beta-race-plans.js
```

Public activation patch status (2026-08-16): `patched in source`; local gates do not claim deployment, public live exposure, canary execution, rollback, disposable-account deletion, independent acceptance, or live verification.

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

### 2026-09-27 — Foreground Apple sync liveness (patched; not deployed)

Workout events now bypass periodic throttling and coalesce durable account-scoped
follow-ups. Shared syncs have a bounded deadline, abort signals and login-generation
guards through native continuations, profile/import requests, checkpoints and
publication. Scoped API dispatch rejects account replacement and stale401 logout.
Uncancellable native work is capped with one recovery slot; uncertain anchors
remain pending/full-history retryable. See `APPLE-HEALTH-FOREGROUND-SYNC.md` and
`healthSyncLiveness.smoke.mjs`. No Swift, schema, production account or native
background-delivery claim is part of this local repair.

Independent Hermes review found synchronous plugin registration and cleanup
failures could skip sibling listeners. Each invocation/removal is now isolated,
including rejected removal Promises and handles settling after disposal; repeated
disposal is idempotent. Real-module tests cover all registration failures, late
cleanup, unhandled-rejection absence and remount teardown. Native removal failures
remain reported, not silently claimed repaired.

### 2026-09-27 — Coaching Context production SQL repair (patched; not deployed)

Disposable live QA exposed `SELECT users.timezone`, a column absent from actual
PostgreSQL DDL/startup but invented by the legacy SQLite planner fixture. Both
profile reads now select only real identity/revision columns. Assignment cutover
uses owned persisted plan timezone; invalid/conflicting clocks fail closed, absent
legacy metadata uses UTC, and optimistic rereads include the source plan/clock.
The authenticated context fixture disables fictional profile columns and audits
all fixture columns against repository schema/bootstrap, with no-plan, positive,
UTC/non-UTC cutover, corruption and concurrent-change checks. No schema, migration,
planner policy, provider or production-account operations are part of this repair.

### 2026-09-27 — Integrated review repairs (local; not deployed)

Calendar composition validates every original canonical session, including its
optional source-bound intent, before rebinding decision provenance. It must not
repair a corrupt final-window source into a valid composed session. Final-window
source-hash, primary-step, purpose and decision-binding negatives cover this seam.
Coaching Context validates the selected persisted window's bounded allowlisted
phase/objectives/progression shape. Malformed semantic payloads become explicit
MISSING context, never PARTIAL nulls or another week's explanation. Valid generated
foundation/taper/rest-only shapes retain their serialized content and physiological
identity. No planning, dose, cache authority or mobile deadline policy changed.

### 2026-09-26 — Current-main release integration (local; not deployed)

Non-rewriting integration preserves upstream compressed-calendar PR12 and the
seven bounded coaching/gear fixes. Calendar composition now refreshes optional
intent binding after its existing decision-provenance rebind; no step targets,
dose or stress change. Coaching Context selects the requested session's unique
persisted calendar window for objectives, phase and progression rather than
using the first week. Missing/malformed/overlapping windows stay unknown.
Generation now reuses the existing per-operation immutable validation scope:
repeated canonical validation/hashing was pushing the integrated real mobile
preview beyond its unchanged 90-second deadline. A same-fixture diagnostic
proved the complete planning result and database rows identical with/without
the scope (about 90s versus 45s). No search, dose, constraint or error policy
changed; ownership/freshness checks are never cached. A deterministic regression
covers result equality, separate requests and mutable/tampered graphs.
Gates include the 42-day/21-day calendar, real 22-day preview/apply accepted
surface and final-week context witness, synthetic backend/frontend regressions,
and mobile Gear/calendar tests. Release review and deployment remain separate.

### 2026-09-23 — Shoe policy containment (patched; not deployed)

The existing Gear recommendation remains a separate optional downstream call,
not a canonical-workout shoe requirement profile or history-aware matcher.
Active shoes are never excluded or retired by mileage alone. Workout/profile
suitability ranks before wet-profile preferences and tracked-mileage tie-breaks;
condition estimates only inform a review reminder. Known incompatible surfaces
cannot re-enter primary or alternatives, and mixed road/trail requires a `both`
profile. Unknown shoe surface yields no fabricated road match. Unsupported
requested surfaces are rejected by the route or explicitly unknown by the pure
helper; absence of a recommendation does not change training or Garmin export.

Manual category/surface/condition estimate may be null. POST writes explicit
unknown instead of triggering old DB defaults; PATCH omission preserves, while
null/blank clears. No migration/backfill or model-name lifespan guess is used.
Existing mutable profiles lack field-level provenance, so recommendation reasons
and confidence stay `UNVERIFIED_PROFILE`/LOW even for catalog-linked overrides.
Catalog facts remain separate; a wet flag is not independently verified traction.
No retrospective user/source provenance has been assigned to old rows.

Gear displays unknown metadata/estimates without invented Daily/Road/450-mile
defaults, retains known tracked mileage, and distinguishes empty closet from
incompatible/unknown recommendations. Add/edit refreshes that optional card.
Tests: `shoePolicy.smoke.js`, authenticated SQLite `gearMetadataRoutes.smoke.js`,
prior `runActualShoe.smoke.js`, updated `shoe-closet-smoke.js`, the standalone
gear/canonical/Garmin non-mutation witness in `goalBackwardCanonical.smoke.js`,
and mobile Playwright `shoe containment preserves unknown profiles` at 320px
and iPhone viewport sizes. This does not prove an integrated shoe-enabled
planner, PostgreSQL concurrency or real-phone behavior. Full profile/receipt,
history/feedback, travel, race familiarization and catalog currentness remain
open. No account access, production changes, migration, merge or deployment.

### 2026-09-23 — Execution truth containment (patched; not deployed)

Completion classification now distinguishes `UNSCORABLE_INSUFFICIENT_EVIDENCE`
from physical partial sync, incomplete execution and safety outcomes. Missing,
invalid or negative measurements remain unknown; zero remains a measured zero.
Serialization preserves unknown ratios as null. Aggregate observed dose is
separate from execution success: whole-run totals, client success booleans and
manually marked work offsets cannot verify quality-session intensity. Quality
families therefore cannot earn successful progression from these inputs.
Supported completed dose may retain a HOLD-level exposure without claiming
intensity success; established pain/recovery/taper constraints still take
precedence. Existing meaningful easy-dose and measured assessment behavior is
retained. No new physiological thresholds or plan-generation gate were added.

Correction/replay resolution is shared by progression, selection and adaptation:
comparable measurement revisions outrank activity timestamps; unresolved ties
produce explicit completion uncertainty, not array-order-dependent success.
The original activity/load observations are not rewritten. Registered reason
codes have customer-facing labels rather than implying that unknown means failed.

`backend/test/executionTruth.smoke.js` covers missing/zero/malformed metrics,
spoofed success, quality dose-only HOLD, canonical easy/cadence behavior,
serialization, correction permutations, replay, actual-load preservation and
safety precedence. `activityMeasuredReceipt.smoke.js` exercises authenticated
local routes and the real planning pipeline with retained work offsets that do
not falsely verify intensity. The multiweek fixture now distributes distance
across steps correctly; its prior repeated full-distance assignment had been
masked by `target_met`. Full trusted interval target comparisons, interval-level
provider confidence and a coaching-context bundle remain later work, not
implemented by this containment slice. No migration, flag, merge, deployment or
Bryan-account access is included.

### 2026-09-23 — Composed coaching context (patched; not deployed)

Owner-scoped `GET /api/coaching/context/:sessionId` composes a bounded,
allowlisted, hash/version-bound PARTIAL read from the accepted seven-artifact
chain, canonical prescription, exact-linked actuals/corrections, stored
progression and actual shoe. It never generates a coaching decision or shoe
recommendation. Unknown interval/gear/recovery contracts remain explicit.
Existing pure surface validation is shared without invoking current-plan
images/telemetry. Measured-receipt read scoping is optional and does not change
existing unscoped behavior. See `COACHING-CONTEXT-READ-CONTRACT.md` for exact
limits, effective-assignment acceptance, optimistic consistency and synthetic
JSON witness. Gate: `node backend/test/coachingContext.smoke.js`; no release
approval, production change or phone verification is implied.

Slice 6b adds a bounded effective-predecessor read proof for persisted future
assignments. It validates owner/lineage/date/revision/unique-path/status checks,
then the unchanged accepted candidate/canonical/artifact bindings. Stored
SUPERSEDED status is retained; the shared surface predicate stays ACTIVE-only
unless given the independently revalidated internal effective-read path. The
whole visited path enters optimistic rereads. This is not a lifecycle write,
historical browsing, new delayed-apply behavior or PostgreSQL isolation proof.
The authenticated context gate covers midnight selection, corrupt/foreign/
cleared/cyclic/deep paths and concurrent lifecycle changes without read writes.

### 2026-09-23 — Explicit canonical intent (patched; not deployed)

Slice 3a adds optional `canonical-workout-intent-v1` for server-materialized
adaptive running graphs, with strict role/leaf/source/objective/hash validation.
Copied structured cadence accessories retain all targets/load/provenance and
remapped IDs. Unsupported target-regenerating reconstruction explicitly defers;
it never discards cadence or excludes accessories from stress. Context v2 exposes
validated intent; stimulus and unsupported legacy intent remain missing. Existing
accepted absent-intent hashes, mixed-family rejection and source-bound easy-dose
topology stay unchanged. See `CANONICAL-WORKOUT-INTENT.md` and
`backend/test/workoutSemantics.smoke.js`. No new physiological policy, migration,
provider integration or release approval is implied.

### 2026-09-23 — Metric stream truth containment (patched; not deployed)

Slice 2b0 rejects malformed/null stream points before numeric conversion while
preserving legitimate zero. Version 2 stores per-metric DECLARED/UNVERIFIED or
UNKNOWN origin; old global source labels remain legacy-only, never certified.
Enrichment replaces points and origin together and preserves other metrics.
The physical-claim replay lookup now selects retained streams before merging.
Run detail presents declared/unknown metric sources instead of assuming Apple
Watch. No identity/revision policy, schema, native provider or training authority
change. See `METRIC-STREAM-TRUTH-CONTRACT.md`; gates are
`metricStreamTruth.smoke.js` and `metricStreamImportRoutes.smoke.js` plus affected
import, execution, context, canonical/FIT and frontend regressions. Interval
alignment/coverage and target-success evaluation remain missing. No backfill,
production access, reviewer approval or deployment is implied.

### 2026-09-23 — Actual shoe persistence (patched; not deployed)

`routes/runs.js` now validates optional `shoe_id` as an owned physical pair
inside the run-write transaction. Omitted create stores unknown; explicit
null clears; omitted ordinary edits preserve the prior association. Retired
pairs remain valid for historical actual-use recording. Create replay returns
the saved run unchanged, including after an explicit shoe correction; it is
not an alternate edit endpoint. Shoe-only PATCH/PUT is permitted while
Goal-Backward is enabled because it changes no physiological evidence,
planning revision, measurement receipt or plan. Mixed/unknown-field edits
retain the existing `EVIDENCE_IMMUTABLE` gate. No recommendation/provider
inference is added, and the broader selected/recommended/actual authority
ledger, catalog operations and deletion-history policy remain later slices.

Gate: `node backend/test/runActualShoe.smoke.js` uses authenticated HTTP routes
and real disposable in-memory SQLite transactions for ownership, replay,
clear/preserve, rollback, retired pairs and correction-safe mileage. It does
not establish PostgreSQL concurrent-lock behavior or production acceptance.
No migrations, flags, merge, deployment or Bryan-account operations performed.

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
| 2026-08-14 | codex | Patched Goal-Backward Coaching v2.4 Phase 6 with pseudonymous disposable cohort isolation, bounded control/candidate telemetry and zero-tolerance alerts, exact artifact/deployment apply gates, private rollback restoration, and cleanup evidence; no activation, deploy, canary, rollback, cleanup, commit, or Bryan expansion authorization was performed | pending Hermes review |
| 2026-08-15 | codex | Shipped Railway-live Apple Watch full-fidelity workout import and run-recap timelines for route/elevation, heart rate/recovery, pace, power, cadence, stride length, vertical oscillation, and ground-contact time; production late-route enrichment passed, and TestFlight build 20 uploaded successfully through EAS build `ecd258a4-0b01-44c3-bff7-60a330242f9c` / submission `9d926a9f-e8f5-4934-b61f-0a03080863d1`; Apple processing and physical-iPhone verification remain pending | `6d10a9bd`, `e4ab2ea4` |
