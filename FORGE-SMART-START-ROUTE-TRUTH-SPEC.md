# Forged Hybrid Smart Start + Route Truth — Implementation Spec

Status: Approved for Build Loop
Owner: Hermes
Implementer: Codex
QA: independent Claude Code, then Hermes ship review
Target: `forge-app` React/Vite/Capacitor frontend + Express backend

## Goal

Give an iPhone-only runner a trustworthy, NRC-like recording path: the athlete taps one clear **Start Run** action, Forged Hybrid records the complete GPS route in the background, and later HealthKit/Strava/Garmin data enriches that same canonical run with the best available heart rate, calories, cadence, elevation, and device metrics.

Automatic detection may help the athlete remember or recover a summary, but it must never claim to have a complete route that was not sampled.

## Product Decisions

1. **One primary Start Run action.** Do not expose a confusing technical `Capture route only` mode in the first release. Starting a run means Forged Hybrid records the phone route and may coexist with a watch.
2. **Manual Start is authoritative.** No silent all-day high-accuracy GPS and no claim of fully automatic route recording.
3. **Phone route + provider truth.** Phone GPS owns route coverage after Start. A matched provider owns richer values it actually measured.
4. **One canonical activity.** HealthKit, Strava, or Garmin enrichment must merge into the Forged Hybrid run, not create a duplicate.
5. **Never fabricate.** A missed start may yield a probable time/distance summary from motion/pedometer history, but never an invented street map.
6. **User RPE remains first-class.** Calculated effort never overwrites athlete-rated effort.
7. **Privacy first.** Location collection is active only during an explicitly started run or a narrowly disclosed low-power detection feature the athlete enables.

## Existing Foundation — Reuse, Do Not Rebuild

The current app already has an `ActiveRun` flow with native `@capacitor-community/background-geolocation`, web fallback, approximately 5-meter native updates, route coordinates, altitude, distance, elapsed time, elevation calculation, local active-run persistence, iOS background-location declarations, HealthKit workout-route ingestion, Apple Health import, and Strava matching/enrichment.

Codex must inspect current `origin/main` and implement only real gaps. Do not replace working background GPS, import, recap, or deduplication code with parallel systems.

## Canonical Run Data Contract

Every actively recorded run needs enough identity and provenance to be reconciled later:

- Forged run ID / client capture ID
- user ID
- planned session ID when applicable
- start and end timestamps
- elapsed and moving duration
- phone-estimated distance
- timestamped route points with latitude, longitude, altitude when available, horizontal accuracy when available, and sample time
- phone-derived elevation gain/loss
- recording source: `forged_phone`
- provider identities when later known: HealthKit workout ID, Strava activity ID, Garmin/provider import key
- per-field provenance for route, distance, duration, elevation, calories, HR, cadence, and effort
- reconciliation status and confidence

All coordinates and numeric values must be bounded and validated. All user data queries and mutations must be scoped to `req.user.id` / `user_id`.

### Canonical distance evidence

- Canonical stored and compared distance is `distance_miles` with canonical unit `miles` and an explicit `distance_source`.
- Provider evidence may arrive in miles, kilometers, or meters, but every candidate must declare its unit through an explicit field name or supported unit value before reconciliation or identity-key generation.
- Convert with 1 mile = 1.609344 kilometers = 1609.344 meters, then compare canonical mile values. Equivalent evidence is one value, never summed or duplicated; the deterministic winning source remains attached to that value.
- Unknown units, invalid numeric values, and materially non-equivalent candidates in one evidence set fail closed instead of being guessed or merged.

### Route integrity status

- `missing`: zero valid route points.
- `insufficient`: exactly one valid route point.
- `partial`: two or more valid route points plus explicit evidence of a material recording gap, a discarded catch-up segment, or otherwise known incomplete sampled coverage.
- `complete`: two or more valid route points with no known material recording gap or incomplete coverage.

Route length alone never makes a route `partial`; a short but valid recording with no known material gap is `complete`.

## Source Precedence

Use the richest trustworthy source per field, not one global winner:

| Field | Preferred source order |
|---|---|
| Route | provider route if complete and valid; otherwise Forged phone route |
| Distance | calibrated provider workout; otherwise Forged phone estimate |
| Duration | provider workout elapsed/moving values when valid; otherwise Forged timestamps |
| Heart rate / zones | HealthKit/watch/provider samples only |
| Calories | provider active energy; otherwise existing labeled estimate |
| Cadence | provider samples; otherwise existing phone estimate if explicitly labeled |
| Elevation | valid provider elevation; otherwise Forged phone altitude-derived estimate |
| Perceived effort | athlete-rated value always wins |
| Calculated effort | deterministic HR-coverage calculation, labeled calculated |

Never overwrite a richer non-null field with a weaker estimate. Preserve provenance labels in the API contract and recap UI.

## Reconciliation Rules

### Identity-first matching

1. Exact existing source/import ID.
2. Exact client capture / server run linkage when an integration carries it.
3. Same user plus deterministic bounded similarity:
   - start time within 30 minutes;
   - duration within 20%;
   - distance within the greater of 0.25 miles or 10%.
4. Short runs under 2 miles use stricter time overlap and do not rely on distance alone.
5. Multiple plausible matches remain unresolved; do not auto-merge ambiguously.

### Merge behavior

- Update the existing canonical run transactionally.
- Attach provider IDs so retries are idempotent.
- Preserve the Forged phone route when the provider lacks route samples.
- Prefer a complete validated provider route if supplied.
- Do not create a second History row, second plan completion, or second mileage/load event.
- Import retries and app-resume retries must be safe.

### Counting behavior

A started and finished normal Forged run is a completed run immediately. It counts once.
A retrospective missed-run candidate does not count until confirmed by the user or matched to a provider workout.

## UX Contract

### Before start

Scheduled run sheet and general Run entry show one dominant action:

- `Start Run`
- Supporting copy: `Your iPhone records the route. Keep your watch running too — Forged Hybrid will combine the data after sync.`
- Show location permission/readiness clearly.
- Do not bury Start behind provider setup.

### Active run

Show:

- live map and captured route line;
- current position;
- elapsed time;
- stable distance/pace when available;
- GPS quality or acquiring state;
- elevation estimate;
- Pause and Finish;
- explicit background-recording status.

Route state and elapsed time must survive screen lock, app switch, process resume where existing architecture supports it, and frontend reload.

### Finish

Save first; cleanup watchers second and fail-soft. Show:

- route map;
- duration and distance;
- elevation;
- `Syncing health data` when enrichment is pending;
- athlete RPE prompt (`How hard did this feel?`, 1–10);
- existing pain/energy check-in;
- source/provenance labels.

### After provider sync

The same run detail updates in place:

- `Route recorded by Forged Hybrid`
- `Heart rate from Apple Watch`, `Garmin`, or `Strava` as applicable
- no duplicate History card;
- no duplicate plan completion or training load.

## Phase 1 — One-Tap Start Contract + Capture Integrity

### WHAT

Audit the current active-run path and close the smallest real gaps that prevent the product promise above. Expected areas include start copy/readiness, stable capture identity and timestamps, route-point validation/persistence, resume safety, and finish ordering.

### WHY

This delivers the reliable worst-case baseline immediately: the runner presses Start and the iPhone records a complete route even without a watch.

### HOW

- Reuse the existing ActiveRun implementation and native background geolocation plugin.
- Add no new native dependency unless the capability is demonstrably absent.
- Keep browser fallback fail-soft.
- Preserve active-run state across reload/resume.
- Validate and bound route coordinates and numeric fields at the backend boundary.
- Ensure save starts before watcher cleanup.
- Add deterministic tests/smokes for any corrected integrity behavior.

### GATE

- `npm run build` for frontend passes.
- Relevant backend tests/smokes pass.
- A simulated reload/resume retains run identity, timestamps, route, and elapsed time.
- Finish produces one canonical run and does not lose data if watcher cleanup throws.
- No auth, SQL-scope, or validation regression.

## Phase 2 — Canonical Provider Reconciliation

### WHAT

Unify the actively recorded Forged run with matching Apple Health, Strava, or Garmin workout data.

### WHY

Phone GPS supplies the route; watches/providers supply harder biometric/device data. The athlete should see one best-available record.

### HOW

- Reuse existing import IDs, tombstones, matching, and enrichment helpers.
- Centralize deterministic matching and per-field source precedence rather than duplicating it in each importer.
- Perform merge + source-ID attachment atomically/idempotently.
- Return merge metadata for the client to refresh the canonical run.
- Protect weekly mileage, plans, challenges, leaderboards, PRs, and load from duplicate contribution.
- Add retry, ambiguous-match, short-run, and richer-source regression tests.

### GATE

- Same provider event imported twice leaves one run.
- A phone run plus matching route-less HealthKit summary leaves one run with phone route + provider HR/calories.
- A richer provider route replaces only the route field and preserves athlete-rated RPE.
- Ambiguous candidates do not merge.
- All account-data and ownership checks pass.

## Phase 3 — Recap Truth + Sync Status

### WHAT

Expose field-level provenance, pending enrichment status, and user-rated effort in Run Recap and History.

### WHY

Users need to understand why route, HR, calories, and effort may come from different sources without interpreting that as conflicting duplicate workouts.

### HOW

- Render source labels from backend truth; do not infer them ad hoc in multiple components.
- Use one canonical recap payload across summary card and detail view.
- Show `Syncing health data` only while a realistic sync path is pending.
- Keep honest missing-data copy when no source provided a field.

### GATE

- Phone-only run recap is complete and honest.
- Phone + watch recap displays one activity with correct per-field sources.
- Card and detail view use the same canonical payload.
- Responsive checks pass at 320px and current iPhone viewport.
- Before/after screenshots of the running app are captured for proof.

## Phase 4 — Smart Missed-Start Detection (Native, Opt-In)

### WHAT

Add a privacy-safe assist layer using Core Motion activity history, pedometer history, and low-power significant-location context to detect likely missed runs and prompt the athlete.

### WHY

It reduces lost workouts without pretending silent detection can reconstruct an unsampled route.

### HOW

- Opt-in setting with clear privacy/battery copy.
- Native Core Motion + pedometer bridge; significant-location wake only if justified by battery testing and App Review posture.
- Deterministic confidence model using running classification, cadence, pace/distance, duration, and non-automotive evidence.
- Prompt: `It looks like you ran. Add or match this workout?`
- Recovered activity is summary-only unless a provider later supplies a route.
- No route geometry generated from sparse significant-location points.

### GATE

- Driving and normal walking test fixtures do not become runs.
- Confirmed candidate creates at most one run.
- Candidate remains non-counting until confirmation or provider match.
- Permission denial leaves the current manual Start path fully functional.
- Native bridge, privacy strings, signed IPA capabilities, and physical-device behavior pass before TestFlight release.

## Phase 5 — Lock-Screen Convenience (Native, Optional)

Add a Live Activity / lock-screen status surface for an already active run. It may display elapsed time, distance, pace, and pause/finish controls, but it does not detect or independently record location.

Gate separately as a native release. Do not block Phases 1–3 on this convenience layer.

## Explicitly Out of Scope

- all-day high-accuracy GPS;
- silent automatic run start;
- reconstructing a route after the fact from pedometer or sparse location changes;
- claiming phone-only optical heart rate;
- replacing existing HealthKit/Strava/Garmin integrations;
- requiring a new TestFlight build for web/backend-only Phases 1–3;
- turning provider sync into a prerequisite for starting a run.

## Release Strategy

- Phases 1–3: ship via `origin/main` and Railway when independent QA is green. Forge remote-loads the web frontend, so frontend/web/backend changes reach the existing TestFlight shell after force-close/reopen.
- Phases 4–5: native implementation requires Capacitor sync, Xcode build-number verification, signed IPA inspection, TestFlight submission verification, and physical-device QA. Do not run an EAS build until the code gate is green and the native capability is ready as one intentional release.

## Final Acceptance Criteria

- An iPhone-only athlete can tap Start, lock the phone, complete a run, and retain a valid map and core metrics.
- A watch is optional for route recording and additive for HR/device metrics.
- Matching HealthKit/Strava/Garmin data enriches the same activity with no duplicate mileage/load/plan completion.
- Route, metrics, and effort show honest provenance.
- A forgotten Start can trigger a future probable-run recovery prompt, but no fake map.
- All changed queries are authenticated, parameterized, and user-scoped.
- Frontend build, backend regression, account-data checks, route/import smokes, and independent Claude Code QA pass.
- UI changes have before/after screenshots from a running build.
