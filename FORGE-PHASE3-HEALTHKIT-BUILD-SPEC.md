# FORGE Phase 3 — HealthKit Full-History + Zones BUILD SPEC
_Owner: Bryan • Drafted by Hermes • 2026-06-11 • Source of truth for P3 build_

## Bridge verification (done 2026-06-11, against real code)
`frontend/ios/App/App/ForgeHealthPlugin.swift` + `HealthService.js` + `backend/src/lib/healthSignals.js`.
- **Permissions:** readTypes ALREADY includes `workoutType()`, heartRate, restingHeartRate, HRV(SDNN), sleepAnalysis, steps, activeEnergy, distance. → NO new permission prompt, NO Info.plist usage-string change needed.
- **fetchWorkouts:** exists but `limit:50` + date-windowed; serializeWorkout returns ONLY {date,start,end,type,distanceMiles,durationSeconds,calories,source}. workoutTypeName covers run/walk/strength/hiit/cycling/swim.
- **GAPS:** (1) NO per-workout HR (avg/max) — zone distribution impossible today. (2) NO in-workout HR-sample query — Z2→Z3 drift needs HR samples inside each workout window. (3) limit 50 + window bound — not full history. (4) No best-effort/split extraction for race prediction.
- **VERDICT:** Phase 3 REQUIRES native Swift changes → **a new TestFlight build is mandatory** (not an instant Railway frontend deploy). Permission scope unchanged.

## Concerns baked into this spec
1. **Native build gate** — split P3 into 3a (native, needs TestFlight) and 3b (web/backend, instant Railway). Native ships first; web consumes its data.
2. **Sync cost** — pulling full history on every app open is heavy. Use incremental/anchored sync (`HKAnchoredObjectQuery`) + cache last anchor; full backfill ONCE, deltas after.
3. **maxHR source** — derive from observed Apple-Health workout max HR; store configurable override. Zone bands computed from it.
4. **Strength fidelity** — HealthKit strength = duration/calories only (no sets/reps/load). Phase 6 hybrid-balance strength side MUST come from Forge Lift tab, not HealthKit. (Noted for P6, not P3.)
5. **Dedup** — a run may exist in BOTH HealthKit and Forge's `runs` table; dedupe by start-time + distance proximity.

---

## Phase 3a — NATIVE bridge expansion (requires new TestFlight build)
**WHAT:** Extend ForgeHealthPlugin.swift: (a) new `getWorkoutHistory` method — paginated/anchored, full history (HKObjectQueryNoLimit or chunked), all activity types; (b) per-workout enrich serializeWorkout with avgHR + maxHR; (c) per-workout HR-sample timeline (or pre-bucketed time-in-HR-zone using maxHR bands) so backend can compute zone distribution; (d) expose maxHR observed.
**WHY:** Zone distribution + full history are physically impossible from the current bridge.
**HOW:** Add CAPPluginMethod `getWorkoutHistory`; for each workout run an HKSampleQuery on heartRate scoped to workout start/end; bucket seconds into Z1-Z5 from configurable maxHR; HKAnchoredObjectQuery for incremental sync; return rows {…existing…, avgHR, maxHR, zoneSeconds:{z1..z5}}. Bump `app.json` ios.buildNumber; `npx cap sync ios`; archive + `eas build -p ios --profile production --auto-submit`.
**GATE:** Device/sim returns full workout history (>50 items if present), each run row carries avgHR/maxHR + zoneSeconds; incremental re-sync pulls only new workouts; TestFlight build installs and HealthService receives the new fields.

## Phase 3b — WEB/backend ingest + readiness + trends (instant Railway)
**WHAT:** Pipe check-in feeling/sleep/flags into `buildHealthSignals()`. Ingest the enriched workout history; dedupe vs Forge `runs`/`workout_sessions`; compute zone distribution, weekly volume, acute:chronic, last-run residual fatigue; surface trends (repeated Z2→Z3 drift, volume ramp, stagnation) as readiness + coaching drivers feeding the daily directive headline. Headline generated FROM readiness, not separate logic.
**WHY:** Subjective + objective meet in ONE engine; a Watch-only run becomes visible.
**HOW:** Extend healthSignals.js input row with check-in fields + history-derived features; new history helpers + `computeAcuteChronicRatio`; merge/dedupe HealthKit + Forge rows; drivers list consumed by Phase-2 headline/breakdown UI (already shipped). No LLM in the readiness number.
**GATE:** Readiness shifts on exhausted/low-sleep; zones reflect Apple-Health max HR; a Watch-only run appears in trend analysis; 3+ recent Z2→Z3 drift runs surface as a driver.

---

## Sequencing
3a (native, TestFlight) → 3b (web) → Phase 4 (heat drift) → THEN evaluate Phase 5 (race predictor) + Phase 6 (hybrid balance) as a SEPARATE epic once 3+4 are live and dogfooded. P5/P6 both CONSUME 3a's enriched data, so they cannot precede it.

## Decisions (Bryan, 2026-06-11)
- **D1:** New TestFlight build for 3a — APPROVED.
- **D2:** Auto-backfill capped at 12-18 months; PLUS a manual-entry option for older efforts/PRs (distance + time + date). Manual PR seeds a HIGH-confidence Race Predictor input — solves the easy-runs-only low-confidence trap. New table manual_efforts (id,user_id,distance_m,duration_sec,effort_date,note,created_at); surfaced in 3b + consumed by P5.
- **D3:** P5 (Race Predictor) + P6 (Hybrid Balance) are a SEPARATE EPIC after 3+4 ship and dogfooded. Not in this build.

## Build pipeline
Per phase: Hermes pre-flight, Codex build, Claude Code QA (must EXECUTE), Hermes review verdict+diff, ship + post-deploy live-verify. 3a adds: TestFlight build + on-device verify before 3b. Ship gate: 0 CRITICAL + 0 unresolved HIGH.
