# FABLE_AUDIT.md — FORGE Production-Readiness Audit (Reliability & Correctness)

**Auditor:** Claude (Fable 5) · **Last updated:** 2026-07-03 (rev 3, updated in place) · **Scope:** run pipeline, aggregates, sync/lifecycle.
**Method:** every finding verified by reading the code at audit time. Rev 2 re-verified all rev-1 findings against remediation commits `1b3b14c1` (Phase A), `5eb816ce` (Phase B), `8fed8664` (Phase C), `484f8843` (ActiveRun hardening). Rev 3 QA-verified Phases D–G (`ab4aafe9` NEW-1, `ffbdce00` calendar correctness, `2e09b3c4` watchSync dedup, `be078c57` GPS gap labeling) — diffs reviewed line-by-line, all four smokes + node checks + account-data (44 tables) + frontend build green. No code modified by the auditor.

**Docs inventoried (rev 2):** `CLAUDE.md` (project instructions — read, not modified), `FORGE.md` (project state/QA history), `QA-CHECKLIST.md`, `.qa/*.md` (per-diff QA pipeline artifacts), `FORGE-*-SPEC.md` (build specs), `README.md`.
**Supersedes: none.** No prior full-audit document exists in the repo; the `.qa/` verdicts and spec files serve different purposes and remain authoritative for their own scopes. Nothing needs deleting on account of this file.

**Rev-2 correction:** rev 1 stated "there are no run edit/delete endpoints." That was wrong (a failed grep). `PUT/PATCH /runs/:id` (runs.js:789-790), `DELETE /runs/:id` (runs.js:815), `PUT/DELETE /lifts/:id` (lifts.js:47,80) all exist and are user-scoped. The corrected analysis produced finding **NEW-1** below.

---

## Status Dashboard

| ID | Finding | Status |
|----|---------|--------|
| CRITICAL-1 | Backgrounding freezes tracking | **PARTIAL** — time fixed (`484f8843`); pace-skew now honestly labeled (`be078c57`, Phase G); distance fix awaits native background-GPS phase |
| CRITICAL-2 | Failed ActiveRun save loses run | **RESOLVED** (`484f8843`) — verified |
| HIGH-1 | Zero-distance silent save | **RESOLVED** (`484f8843`) — verified |
| HIGH-2 | No in-progress run persistence | **OPEN** |
| HIGH-3 | Three definitions of "today" | **RESOLVED** — clients local-date (`484f8843`, `5eb816ce`); server anchor widened to tomorrow/today/yesterday (`ffbdce00`) — QA-verified |
| HIGH-4 | watchSync no dedup | **RESOLVED** (`2e09b3c4`) — sync_uuid + vendor-id + heuristic, both tables, QA-verified |
| NEW-1 | Run delete/edit orphans persisted PRs | **RESOLVED** (`ab4aafe9`) — tx-wrapped recompute w/ next-best fallback, QA-verified |
| MEDIUM-1 | Sub-Z1 HR displayed as Z5 | **RESOLVED** (`484f8843`) — verified |
| MEDIUM-2 | No GPS accuracy filtering | **OPEN** |
| MEDIUM-3 | "Today" bucket spans two days | **RESOLVED** (`ffbdce00`) — explicit `date >= today` query, QA-verified |
| MEDIUM-4 | Queue retry-forever + non-idempotent lift starts | **PARTIAL** — D2 transaction landed (`5eb816ce`); 4xx dead-letter + `/workouts/start` client id still open |
| MEDIUM-5 | ActiveRun hardcodes effort 5 | **OPEN** (still in `buildRunPayload`) |
| MEDIUM-6 | Stats calories assume 185 lb | **OPEN** |
| MEDIUM-7 | Permission loss discards measured distance | **RESOLVED** (`484f8843`) — verified |
| LOW-1 | Two streak implementations | **RESOLVED** (`ffbdce00`) — single `lib/streak.js` shared by auth.js + milestones.js, QA-verified |
| LOW-2 | Inconsistent "week" definitions | **OPEN** |
| LOW-3 | No axios timeout | **RESOLVED** (`484f8843`, `timeout: 15000`) |
| LOW-4 | Remote `server.url` cold-launch dependency | **OPEN** (mitigated by `.qa` lazy-chunk-retry work) |
| LOW-5 | Elapsed tick drift | **RESOLVED** (subsumed by timestamp-derived elapsed in `484f8843`) |
| LOW-6 | Queued-offline saves skip post-run flow | **NEW (rev 2)** — LOW, deliberate degradation worth a product decision |

---

## Architecture Summary (one page, rev 2)

**Client.** React SPA (Vite) wrapped in Capacitor 8 for iOS. `frontend/capacitor.config.ts` sets `server.url` to the production Railway URL — the shipped app **remote-loads the web bundle at launch** (deliberate: TestFlight-free web updates; see LOW-4). `AppDelegate.swift` is stock; no background-task handling. Capacitor plugins: `core`, `app`, `ios` only — **no background-geolocation plugin**. GPS is browser `watchPosition` in WKWebView.

**Server.** Express + PostgreSQL (`pg` Pool; `?`→`$n` shim in `backend/src/db/index.js`, which now also exports `withTransaction` since `5eb816ce`). JWT auth on all user routes. Railway/Nixpacks, no `TZ` set → UTC container.

**Run entry paths (two, now behaviorally aligned):**
1. **`ActiveRun.jsx`** (live tracker) — post-`484f8843`: stable client run UUID (`clientRunIdRef`), elapsed derived from `startTimestampRef` (`Date.now()` math, not tick counting), local-date bucketing via its own `todayISO()`, Haversine distance with 0.25 mi segment cap, explicit `gpsStarted` state, manual-distance prompt (pre-filled with measured partial distance) whenever GPS never started / dropped / recorded zero, save-failure split into 4xx (visible error, no retry) vs network/5xx (queued to offline queue + "Saved offline" banner). Still **no pause/resume** and **no persistence of the in-progress run**.
2. **`LogRun.jsx`** (manual entry) — client UUID + offline queue since earlier phases; metric→miles conversion at `:413`.

**Save endpoint.** `POST /runs` (runs.js:610): validates date/type/perceived_effort, honors client `id` (`uuidValidate`), `INSERT ... ON CONFLICT (id) DO NOTHING`, returns existing row on conflict → all client retries idempotent. Post-insert: calories, target zone, weather-bounded heat drift, interference adjustment, PR auto-detect (`services/prAuto.js` → persisted `personal_records` rows carrying `run_id`).

**Edit/delete (rev-2 correction).** `PUT/PATCH /runs/:id` (COALESCE update, recomputes calories only), `DELETE /runs/:id` (deletes the run row **only**). Neither touches `personal_records` — see NEW-1.

**Aggregates.** Recomputed live from raw rows per request: `GET /auth/me/stats` (auth.js:240) and `/me/streak` (auth.js:316), anchored to **server-UTC today/yesterday** (auth.js:282-293 — unchanged in rev 2). A second, persisted streak lives in `routes/milestones.js` (`users.current_streak`, GREATEST-guarded) and only refreshes when `/milestones/new` is called.

**Sync.** `lib/offlineQueue.js` — flush reads in one tx, fetches with no tx open, deletes only `response.ok` items in a fresh tx (sound). Trigger: `online` event via `useOnlineStatus`. Watch ingestion `routes/watchSync.js` inserts into `watch_sync` + `runs`/`lifts` with **no dedup** (HIGH-4); the CSV/health import path (`routes/import.js:73-100`) *does* dedup via a 30-minute start-window match. FORGE.md confirms the watch-sync API is live with "no native phone collector yet" — the upload path is the active surface.

**Check-in dates.** Since `5eb816ce`: `POST /checkin` accepts strict `YYYY-MM-DD` client date (checkin.js:182-185), and `DailyCheckIn.jsx:185` sends `todayISO()` — client-local bucketing end to end.

---

## Findings (priority order)

### CRITICAL-1 — Backgrounding: time now survives lock, distance still doesn't → recorded pace is skewed slow — **PARTIAL** *(rev 3: interim honesty patch shipped in `be078c57` — gaps >60s or discarded catch-up segments now produce a finish banner + `[gps_gap_notice:…]` in run notes; the distance fix still requires the native background-GPS phase)*

**Files:** `frontend/src/pages/ActiveRun.jsx` (elapsed from `startTimestampRef`, `484f8843`; `watchPosition` unchanged), `frontend/package.json` (no background-geo plugin), `AppDelegate.swift` (stock). Commit message: "Native background GPS remains unresolved and requires a separate Capacitor/iOS phase."

**What changed:** elapsed is now `Math.round((Date.now() − startTimestampRef.current)/1000)` recomputed each tick — locking the phone no longer freezes the clock. This resolves the *time* half of rev-1's finding (and LOW-5).

**What remains — and the new failure mode it creates (rev-1's "careless-fix trap," now live):**
1. User locks phone mid-run. WKWebView suspends `watchPosition`; distance accumulation stops. Time, however, now keeps (logically) counting.
2. User unlocks after 20 min: elapsed correctly jumps forward; distance did not move. The single catch-up GPS segment is added only if `< 0.25 mi` (`:105` equivalent in current file) — a longer locked stretch is **silently discarded**.
3. Net: duration true, distance undercounted → **pace reads dramatically slower than reality**, and the run is internally inconsistent (a 7:30/mi runner shows 12:00/mi). Rev 1's failure was "everything undercounts"; rev 2's is "time is right, pace is wrong" — arguably more misleading because the duration looks trustworthy.

**Severity: CRITICAL** (unchanged — the core artifact is still wrong under the most common usage).

**Fix approach:** the distance half requires native background location — `@capacitor-community/background-geolocation` (or equivalent), iOS `location` background mode, feed fixes into the same accumulator. Interim honesty patch until that ships: detect fix gaps > ~15 s (timestamp delta between consecutive fixes), accumulate `gapSeconds`, and either (a) exclude gap time from the pace denominator with a "GPS gap — pace estimated from tracked segments" label, or (b) banner the run as "distance incomplete (phone locked)" at save. Do not leave time-correct/distance-wrong runs unlabeled.

**Edge cases:** intentional standing rest vs OS suspension (gap detection can't distinguish — label conservatively); resumed fixes far from last point (>0.25 mi) currently discard the segment silently — with gap labeling, surface it; battery-saver throttling produces sparse-but-present fixes (gap threshold must tolerate 2-5 s cadence).

**Verification:** physical iPhone, 10-min lock mid-run while walking: duration must include the 10 min (now does), and the run must either include the locked distance (post-plugin) or visibly disclose the gap (interim). Foreground stopwatch comparison for LOW-5 regression.

**How a careless fix goes wrong:** shipping the background plugin but keeping `maximumAge: 1000`/foreground-tuned options for the background stream can flood the queue or drain battery; and back-filling distance from the catch-up segment without the 0.25 mi cap reintroduces teleport noise. Cap per-segment, sum the gap path from the native plugin's buffered fixes instead.

---

### CRITICAL-2 — Failed ActiveRun save loses the run — **RESOLVED (`484f8843`), verified**

**Verified in current code:** `clientRunIdRef = useRef(createClientRunId())`; `buildRunPayload()` includes `id`; catch path splits `!err?.response || status >= 500` → `queueRequest('/api/runs', 'POST', payload)` + `setQueuedOffline(true)` + `setSavedRunId(payload.id)` + green "Saved offline — Forge will sync" banner, vs 4xx → red visible error, no queue (correct: validation failures must not retry forever). `api.js` now has `timeout: 15000`. Server side unchanged and already idempotent (`ON CONFLICT (id) DO NOTHING` + return-existing, runs.js:660-668) — the queued flush of the same id can never duplicate.

**Residual (tracked as LOW-6):** the queued-offline branch does not open `PostRunCheckIn`, heat-drift, or AI feedback — those only run on a live 2xx. Deliberate-looking degradation; flagged for a product decision (post-sync nudge?) rather than as a defect.

**Regression tests worth keeping:** airplane-mode at Finish → exactly one row after reconnect; server 500 at Finish → same; 400 at Finish → visible error, nothing queued.

---

### HIGH-1 — Zero-distance silent save — **RESOLVED (`484f8843`), verified**

**Verified:** `startGPS()` with route recording off now sets `gpsStarted=false`, `gpsAvailable=false`, and a banner ("Route recording is off — enter your distance when you finish"). `finishRun()` prompts when `!gpsStarted || !gpsAvailable || distanceMiles <= 0`, pre-filling the input via `displayDistanceForUnit`. `buildRunPayload` recomputes the same condition for which distance to send, with metric→miles conversion on the manual path. The refresh-loses-router-state case now lands in the prompt (mapMyRun default false → gpsStarted false → prompt).

**Note for future edits:** the decoupled flags (`gpsStarted` vs `gpsAvailable`) are the load-bearing part — rev 1's warning stands: don't re-merge them.

---

### HIGH-2 — In-progress run held only in React state; crash/kill/jetsam destroys it — **OPEN**

Unchanged from rev 1. All live-run state (`startTimestampRef`, `distanceMiles`, `routeCoords`, `lastPointRef`) is in-memory; `484f8843` added no checkpointing (only `ActiveRun.jsx` + `api.js` in the diff). The remote `server.url` webview still makes recovery worse (relaunch = network fetch).

**Fix approach (updated for the new code):** checkpoint `{ clientRunId: clientRunIdRef.current, startTimestamp: startTimestampRef.current, distanceMiles, routeCoords, runType, surface, mapMyRun }` to localStorage/IndexedDB every ~10 s and on fix batches; on mount, offer resume/discard/save-as-is. The new timestamp-based elapsed makes resume correct by construction (recompute from the persisted start timestamp — do **not** persist the derived `elapsed`). The persisted `clientRunId` also makes a "save what we had" recovery idempotent against a save that actually succeeded pre-crash.

**Edge cases / verification / traps:** unchanged from rev 1 (stale-checkpoint handling, versioned parse guard, storage quota on route arrays; force-kill at 5 min → resume restores true elapsed from timestamps).

---

### HIGH-3 — "Today" conventions — **RESOLVED (`ffbdce00`), QA-verified rev 3** *(trace below preserved from rev 2; anchor now widened to [tomorrow, today, yesterday] via shared `lib/streak.js` — the Sydney case passes in `streak-anchor-smoke.js`)*

**Resolved half (verified):** ActiveRun now uses `todayISO()` (local, `484f8843`); LogRun already did; `POST /checkin` accepts a validated client date and `DailyCheckIn.jsx:185` sends it (`5eb816ce`). Evening US runs and check-ins now land on the user's local calendar day, consistently with each other. The rev-1 "checked in but it says I didn't" flip is gone.

**Open half (re-verified today, unchanged):** `auth.js:282-293` — streak anchor is still `now.toISOString().slice(0,10)` (server UTC) `today`/`yesterday`. Failure trace, still live: Sydney user (UTC+10/+11) logs a run Monday 8 am local = Sunday ~21:00 UTC; run row is dated Monday (local, correct); the streak walk anchors at UTC-Sunday/Saturday and **cannot reach a date in the server's future** → streak reads 0 (or excludes today) until UTC midnight catches up mid-day local. Same shape affects `calendarDays` (`auth.js:295-310`, "today" flag) and the `/me/streak` variant (`auth.js:329-337`). Every UTC-positive user, every morning.

**Fix approach:** widen the anchor to `tomorrow`/`today`/`yesterday` relative to server UTC (covers all offsets without client trust), or accept a validated `?today=YYYY-MM-DD` from the client like check-in now does. Do it inside a single extracted `computeStreak(dates, anchor)` shared with milestones.js (see LOW-1) so the fix lands once.

**Edge cases:** client clock skew (validate ±1 day of server time); historical rows written under the old UTC convention (accept anchor fuzz rather than migrating); the `tomorrow` widening must not double-count a date walked twice (walk from the newest matching anchor only).

**Verification:** device TZ Auckland, log a morning run → streak increments immediately; calendar marks local-today; New York evening ActiveRun (already fixed client-side) still lands on local today.

---

### HIGH-4 — watchSync ingestion has zero dedup — **RESOLVED (`2e09b3c4`), QA-verified rev 3** *(trace preserved; fix is layered sync_uuid unique-index → vendor-id lookup → date+duration±60s+distance±2% heuristic, guarding both watch_sync and routed runs/lifts, duplicates return 200 + duplicate:true)*

Re-verified unchanged: `watchSync.js:51-139` mints a fresh `uuidv4()` per delivery, plain INSERTs into `watch_sync` and `runs`/`lifts`, no `ON CONFLICT`, no `garmin_activity_id` lookup, no start-window heuristic. `import.js:73-100` remains the in-repo pattern to copy. FORGE.md confirms the endpoint is the live watch surface.

**Rev-2 severity note:** with edit/delete endpoints confirmed to exist (rev-2 correction), a user *can* manually delete a duplicate — but nothing surfaces duplicates to them, and deleting the wrong copy triggers NEW-1 (orphaned PRs). Dedup at ingest remains the fix; remediation-by-user is not a mitigation.

Fix/edge cases/verification: unchanged from rev 1 (vendor-id lookup → start-window heuristic → optional client `sync_uuid` unique index; dedup both the `watch_sync` row and the routed `runs`/`lifts` row; redelivery-with-more-data should update null fields like import.js does).

---

### NEW-1 (rev 2) — Deleting or editing a run leaves persisted PRs stale/orphaned — **RESOLVED (`ab4aafe9`), QA-verified rev 3** *(trace preserved; delete and distance/duration edits now recompute auto PRs inside `withTransaction` with next-best fallback; manual PRs untouched; lift_id PRs confirmed unused and skipped)*

**Files:** `backend/src/routes/runs.js:815-822` (DELETE — deletes the run row only), `:750-788` (updateRunHandler — COALESCE update, recomputes calories only, never re-runs PR detection), `backend/src/services/prAuto.js:78,88` (INSERT/UPDATE `personal_records` with `run_id`), `backend/src/db/index.js:437-449` (`personal_records.run_id TEXT` — no FK cascade).

**Failure traces (verified against the code):**
- **Delete:** user logs a 5K, `autoUpdatePRs` writes/updates the `personal_records` row (`run_id = <that run>`). User deletes the run (typo distance, duplicate from HIGH-4, whatever). The PR row survives untouched: PR Wall still shows the time; `run_id` now dangles. There is no recompute-on-delete and no cascade.
- **Edit:** user corrects the run from 3.5 mi to 3.05 mi (or fixes a wrong duration). `updateRunHandler` updates the row and recomputes calories — but never re-evaluates `personal_records`. A PR earned under the wrong numbers keeps its stale value; an edit that would newly qualify never creates one. Live-computed aggregates (stats, hybrid PRs) self-heal because they read raw rows; the **persisted** PR table is the only aggregate that doesn't.

**Severity: MEDIUM-HIGH.** No crash, but permanently wrong "achievements" displayed to the user, with dangling references — and it converts HIGH-4 cleanup (deleting duplicate watch runs) into a PR-corruption path: the duplicate that set the PR may be the copy deleted.

**Fix approach:** on `DELETE /runs/:id`, after deleting, recompute affected PR categories for the user: find `personal_records WHERE run_id = ?`; for each category, re-scan remaining runs and update-or-delete the row (prAuto already contains the scan logic — factor it to accept "recompute category from scratch"). On edit, if `distance_miles` or `duration_seconds` changed, call the same recompute for that run's categories. Wrap delete+recompute in `withTransaction` (now available since `5eb816ce`).

**Edge cases:** manual PRs (`source != 'auto'`) must never be auto-deleted — only `source='auto'` rows are recompute-eligible; `discrepancy`/`auto_value` fields carry user-override semantics prAuto already respects — the recompute must go through the same code path, not raw SQL; lifts have the same shape (`lift_id` column; `DELETE /lifts/:id` at lifts.js:80) — apply the same treatment; a delete of the *only* run in a category should delete the auto PR, not zero it.

**Verification:** set a distance PR with run A; delete run A → PR Wall must fall back to the next-best run or drop the entry; edit run A's distance below a previous best → PR must revert; manual PR untouched by both.

**How a careless fix goes wrong:** `DELETE FROM personal_records WHERE run_id = ?` alone silently erases the user's PR history instead of falling back to the next-best effort — recompute, don't just cascade. And doing the recompute outside a transaction can leave the run deleted but the PR intact on a mid-step failure (the exact partial-write shape Phase B just fixed for workout sets).

---

### MEDIUM-1 — Sub-Z1 HR displayed as Z5 — **RESOLVED (`484f8843`), verified**

`getZone` now returns an explicit `{ key: 'Z0', name: 'Below Z1', color: '#9CA3AF' }` for `pct < ZONES[0].min`; render sites were already null-tolerant. Backend `classifyRunZone` was already correct (`below_z1`).

### MEDIUM-2 — No GPS accuracy filtering / minimum-movement / auto-pause — **OPEN**

Re-verified: the hardened `watchPosition` callback still never reads `pos.coords.accuracy`; every `0 < segment < 0.25 mi` is summed. Fix/edge cases/verification unchanged from rev 1 (accuracy gate ~30 m, min-segment ≥ max(fix accuracy, ~8 m), rejected fixes must not update `lastPointRef`, stand-still test must gain ≈0).

### MEDIUM-3 — "Today" stats bucket spans two calendar days — **RESOLVED (`ffbdce00`), QA-verified rev 3** *(explicit `date >= <today>` query replaced the rolling now−1day window)*

Re-verified unchanged: `auth.js:245-251` `getRuns(1)` → `date >= yesterday` → the Dashboard "Today" bucket includes yesterday. One-line fix (`date >= <today>`), but land it together with the HIGH-3 anchor decision so "today" means one thing. Write it as an explicit `date = today` (or `>= today`) query, not a `now − N days` window someone will re-break.

### MEDIUM-4 — Offline queue retry-forever + non-idempotent lift starts — **PARTIAL**

- **Resolved sub-item (verified via `5eb816ce`):** `withTransaction` added to `db/index.js`; workout session + set loops wrapped — the 500-after-partial-insert amplifier is closed.
- **Open sub-items (re-verified in current `offlineQueue.js`):** only `response.ok` deletes a queued item — a permanent 400/422 retries on every flush forever and the "queued" badge never clears; `/workouts/start` queue payloads (`LogLift.jsx:169,187,208,218`) still carry no client id, so a 5xx-after-commit still duplicates a session on retry (narrower now that the insert is transactional, but a post-commit response loss still re-sends).

**Fix (remaining):** 4xx → dead-letter + user notice; retry counter with cap for 5xx; client UUID + `ON CONFLICT` for `/workouts/start` mirroring runs. **Trap unchanged:** a 401 during flush (raw `fetch`, bypasses the axios interceptor) must re-queue, not dead-letter — deleting on any non-ok throws away workouts when a token expires offline.

### MEDIUM-5 — ActiveRun hardcodes `perceived_effort: 5` — **OPEN**

Re-verified: the new `buildRunPayload()` still sends `perceived_effort: 5`. RPE-derived features (hybrid PR "Easiest Run After Heavy Lift", AI coach context) still ingest synthetic effort for every live-tracked run. Fix unchanged (collect in `PostRunCheckIn`, PATCH onto the run — the PATCH endpoint exists, runs.js:790 — or send null and relax the backend `perceived_effort || 5` coercion; the backend default is the half people will forget).

### MEDIUM-6 — Stats calories assume 185 lb — **OPEN**

Re-verified: `auth.js:258` still `0.75 * 185 * miles` while per-run `calories_burned` uses real weight (runs.js) — two disagreeing numbers shown to the user. Fix: sum stored `calories_burned` with estimate fallback for null rows.

### MEDIUM-7 — Permission loss discarded measured distance — **RESOLVED (`484f8843`), verified**

Manual prompt now pre-fills the measured partial distance (`setManualDistance(current || displayDistanceForUnit(distanceMiles, units, fmt))`) and shows "Forge measured X before GPS stopped… adjust if needed." Metric round-trip is consistent (prefill ×1.60934; save via `fmt.milesFromKm`).

---

### LOW-1 — Two streak implementations — **RESOLVED (`ffbdce00`), QA-verified rev 3** *(single `computeStreak` in lib/streak.js now serves auth.js /me/stats, /me/streak, and milestones.js)*

`auth.js` (two live variants) + `milestones.js` (persisted). Now the natural vehicle for the HIGH-3 anchor fix: extract one `computeStreak(dates, anchor)`. Rev-2 addition: with delete endpoints confirmed, the persisted `users.current_streak` also goes stale after a run delete until the next `/milestones/new` call — same drift class.

### LOW-2 — Three definitions of "week" — **OPEN**

Rolling 7-day (auth.js stats) vs ISO Monday weeks (hybridPrs) vs rolling-labeled-"This Week" (Dashboard). Unchanged.

### LOW-3 — No axios timeout — **RESOLVED (`484f8843`)**

`axios.create({ baseURL, timeout: 15000 })` verified. Long-running endpoints (AI plan generation) may need a per-call override above 15 s — watch for timeout reports on `/plans` generation.

### LOW-4 — Remote `server.url` webview — **OPEN (mitigated)**

Unchanged config. Partially mitigated since rev 1: `.qa/lazy-retry-*` work added `lazyWithRetry` chunk-reload recovery in `App.jsx` for stale-chunk failures after deploys. Cold-launch-with-no-network UX remains unverified on device; bundling `dist/` + a live-update mechanism remains the eventual fix.

### LOW-5 — Elapsed tick drift — **RESOLVED**

Subsumed by timestamp-derived elapsed (`484f8843`).

### LOW-6 (rev 2) — Queued-offline saves skip the post-run flow — **LOW / product decision**

**Files:** `ActiveRun.jsx` catch path (`484f8843`). When a save is queued offline, `savedRunId` is set (WorkoutCard renders) but `PostRunCheckIn`, heat-drift, and AI feedback are skipped, and nothing triggers them after the queue later syncs. Deliberate-looking degradation; the data (RPE, pain, energy) is simply never collected for those runs. If post-run check-in matters for coaching quality (it feeds readiness + MEDIUM-5's fix), add a "finish your check-in" nudge keyed off the `offline-queue-flushed` event with the stored client run id.

---

## What was checked and found sound (rev 2)

- **All rev-1 sound items re-hold**, plus: LogRun/ActiveRun/check-in now share one idempotency + local-date pattern; `withTransaction` exists and wraps workout multi-row writes (`5eb816ce`).
- `POST /runs` idempotency chain (client UUID → `uuidValidate` → `ON CONFLICT DO NOTHING` → return-existing) — now used by **both** run entry paths.
- Offline flush transaction structure (read-tx → fetch-no-tx → delete-successes-in-fresh-tx) — sound; remaining issues are policy (MEDIUM-4), not structure.
- Weather fetch AbortController + fail-soft; heat-drift never blocks save (also asserted by `bff0d9df` smoke).
- Backend zone classifier (`below_z1`), UnitsContext conversions, Haversine math, 401 interceptor with auth-flow exemption, import.js dedup pattern.
- Streak date-walk arithmetic remains DST-safe on the UTC container; the open issue is the anchor (HIGH-3), not the walk.
- **Corrected from rev 1:** edit/delete endpoints exist and are properly user-scoped (`AND user_id=?` on the DELETE — the historical auth-bypass documented in CLAUDE.md is confirmed fixed in current code). The gap they expose is aggregate consistency (NEW-1), not authorization.

## Suggested fix order (rev 3 — after Phases D–G QA'd green at `be078c57`)

Phases D–G closed: NEW-1, HIGH-3, HIGH-4, MEDIUM-3, LOW-1, and the CRITICAL-1 interim honesty patch (GPS gaps now surfaced in a banner + a `[gps_gap_notice:…]` line in run notes; discarded ≥0.25 mi catch-up segments flagged). Remaining, in order:

1. **CRITICAL-1 distance half** — the native background-geolocation phase (Capacitor plugin + iOS `location` background mode + on-device verification). The only remaining CRITICAL; requires a new TestFlight build (Bryan-gated EAS).
2. **HIGH-2** (run checkpointing) — pairs naturally with #1's phase; the timestamp/clientRunId architecture makes resume correct by construction.
3. **MEDIUM-4 remainder** (4xx dead-letter + retry cap in offlineQueue; client id + ON CONFLICT for `/workouts/start`) + **LOW-6** post-sync check-in nudge — one offline-queue polish pass.
4. MEDIUM-2 (GPS accuracy gate), MEDIUM-5 (real RPE + relax backend `|| 5` coercion), MEDIUM-6 (sum stored per-run calories), LOW-2/4 opportunistically.

Rev-3 QA observations (non-blocking, for the next builder):
- Phase F dedup check runs *before* the insert transaction — a truly simultaneous double-delivery without a `sync_uuid` could still race past the heuristic. The partial unique index catches the `sync_uuid` case; acceptable residual risk for watch traffic, noted for completeness.
- Phase F bonus: watch runs now also persist `health_start_at`/`health_end_at`, aligning watchSync with import.js and strengthening future dedup.
- Phase E leftover (known, in commit message): `calendarDays`' `isToday` flag still uses server-UTC; cosmetic, tracked under LOW-2's "week/day definitions" umbrella.
- Phase G accumulates the full gap duration rather than gap-minus-cadence (~1 s overcount per gap) — immaterial for a >60 s threshold.
