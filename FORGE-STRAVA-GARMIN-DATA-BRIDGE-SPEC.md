# FORGE Detailed Activity Data Acquisition Build Spec

Status: Draft for Bryan review
Date: 2026-07-20
Scope: `forge-app` Express backend + React/Vite frontend plus later native iOS/Android adapters
Native/EAS impact: None for Phases P0-3. Direct BLE capture and Android Health Connect require separate native builds and explicit EAS approval.
Goal: Import the most complete authorized workout data available from Strava, original activity files, platform health stores, direct sensors, and approved provider APIs; merge it into one canonical Forged Hybrid activity; and never present a summary-only source as a complete workout.

## Product Problem

Garmin Connect intentionally sends incomplete timed-activity data to Apple Health:

- only high/low heart-rate values for timed activities, not the complete workout HR timeline;
- no associated GPS track;
- workout summaries may still include distance, duration, calories, and average values.

That limitation explains Forged Hybrid recaps with sparse HR coverage and missing routes even though Garmin Connect displays the complete workout.

Strava receives new Garmin activities through Garmin's authorized cloud-to-cloud connection. For an athlete who authorizes Forged Hybrid, the Strava Activity Streams API can expose available `time`, `distance`, `latlng`, `altitude`, `velocity_smooth`, `heartrate`, `cadence`, `watts`, `moving`, `grade_smooth`, and `temp` streams.

Official references:

- Garmin Apple Health limitations: https://support.garmin.com/en-GB/?faq=lK5FPB9iPF5PXFkIpFlFPA&tab=topics
- Garmin Activity API: https://developer.garmin.com/gc-developer-program/activity-api/
- Garmin FIT activity contents: https://developer.garmin.com/fit/file-types/activity/
- Garmin-to-Strava connection: https://support.strava.com/en-us/articles/15401903-garmin-and-strava
- Strava Activity Streams API: https://developers.strava.com/docs/reference/
- Apple Core Bluetooth: https://developer.apple.com/documentation/corebluetooth
- Android Health Connect workouts: https://developer.android.com/health-and-fitness/health-connect/experiences/workouts
- Polar AccessLink: https://www.polar.com/accesslink-api/
- TrainingPeaks API: https://help.trainingpeaks.com/hc/en-us/articles/234441128-TrainingPeaks-API
- Suunto Cloud API: https://suunto-api.developer.azure-api.net/how-to-start
- COROS API application: https://support.coros.com/hc/en-us/articles/17085887816340-Submit-an-API-Application
- Wahoo Cloud API: https://developers.wahooligan.com/cloud

## Accuracy Promise

Forged Hybrid must not promise literal `100% heart-rate coverage`.

No downstream service can recover a sample the watch failed to record because of loose skin contact, disabled sensors, battery loss, or a recording interruption. Strava may also report a reduced stream resolution.

The product promise is:

> Forged Hybrid imports 100% of the usable samples made available by the best authorized source, identifies transmission and sensor gaps, and never invents missing workout data.

The UI must distinguish:

- `source completeness`: how much Strava or a FIT file supplied;
- `timeline coverage`: how much of the moving workout has usable HR samples;
- `provider resolution`: `high`, `medium`, or `low` when the provider reports it;
- `sensor gap`: a period within the activity for which no valid sample exists.

Do not call a Garmin-via-Apple-Health timeline `poor` without explaining that Garmin shared summary-only HR data.

## Product Decision

Use Strava as the automatic interim Garmin data bridge while pursuing Garmin Activity API access.

The athlete setup is:

1. Garmin watch syncs to Garmin Connect.
2. Athlete enables Garmin Connect -> Strava activity sharing.
3. Athlete connects Strava to Forged Hybrid.
4. Strava notifies Forged Hybrid when a new activity is created.
5. Forged Hybrid retrieves activity details and available streams.
6. Forged Hybrid links the Strava activity to the matching Apple Health or Forged-recorded run.
7. Forged Hybrid stores one canonical run and derives zones, effort confidence, route, elevation, cadence, and power from the best available field source.

For historical or unmatched activities, add an original Garmin FIT-file import as a later fallback. The permanent direct path remains the Garmin Activity API.

## Complete Source Strategy

Forged Hybrid must support multiple authorized sources because no aggregator can guarantee that another vendor forwarded every sample. Sources are ranked by fidelity and applied field by field, not chosen once for the entire run.

### Available without provider approval

1. **Forged Hybrid direct recording:** iPhone or Android GPS, timestamp, speed, and available altitude while the athlete deliberately records in Forged Hybrid.
2. **Standard BLE heart-rate sensors:** live HR from a chest strap or other device that exposes the standard Bluetooth Heart Rate Service. This does not provide a watch's stored history and does not make a generic Garmin-watch integration.
3. **Strava authorized activity streams:** automatic cloud bridge for available route, HR, cadence, power, movement, speed, grade, altitude, and temperature data.
4. **Original activity files:** `.fit`/`.fit.gz` as the preferred full-fidelity upload, then `.tcx` and `.gpx` when that is all the athlete has.
5. **Apple HealthKit:** workouts, HR, routes, recovery, sleep, and other metrics only when the originating app writes those records.
6. **Android Health Connect:** exercise sessions, routes, HR, speed, distance, elevation, cadence, power, calories, sleep, and recovery records only when the source app shares them and the athlete grants permission.
7. **Athlete input:** post-workout RPE, pain, soreness, sleep quality, missed-session reason, and check-in context. Subjective data remains distinct from sensor-derived effort.

### Provider or commercial approval track

1. **Garmin Activity API:** authoritative Garmin activity details and original FIT/GPX/TCX files.
2. **Polar AccessLink:** OAuth exercises, routes, FIT/TCX/GPX, samples, HR zones, continuous HR, sleep, cardio load, Nightly Recharge, and webhooks.
3. **TrainingPeaks API:** completed workout details, athlete zones and metrics, planned workouts, and outbound planned-workout delivery.
4. **Suunto Cloud API:** OAuth workout access and webhook-ready provider adapter.
5. **Wahoo Cloud API:** workout/profile/zone exchange after application approval.
6. **COROS API:** provider adapter after selective partner approval.

Oura and WHOOP remain recovery/readiness sources. They do not replace detailed activity files or continuous running streams. Fitbit, Withings, and similar wellness sources are lower priority until beta data shows a recovery field that Apple Health, Health Connect, Oura, or WHOOP cannot supply reliably.

### Context sources for plan quality

- official race course pages and organizer-provided GPX files;
- privacy-safe course distance/elevation analysis already defined by the race intelligence layer;
- workout-time temperature, humidity, heat index, wind, and air quality when available;
- training adherence, recent load, missed sessions, and athlete-rated RPE/pain.

These sources can change training interpretation but must never fabricate missing physiological samples.

## Current Architecture to Reuse

The codebase already has most of the bridge:

- Strava OAuth with `activity:read_all,profile:read_all` in `backend/src/routes/strava.js`;
- encrypted access and refresh token storage;
- token refresh;
- Strava webhook registration and idempotent activity processing;
- app-open Strava sync in `frontend/src/App.jsx`;
- canonical matching between Strava and Apple Health/Forged runs;
- route and elevation enrichment without creating a duplicate run;
- user-scoped transactions through `withUserMutation`;
- `runs.route_coords`, `runs.heart_rate_zones`, summary HR/cadence/elevation fields, and `workout_metrics_json`;
- run recap coverage safeguards and user-rated RPE;
- imported-workout tombstones, PR updates, challenges, leaderboards, and plan-load consumers that depend on one canonical run.

The current missing layer is specific: `fetchStravaActivityStreams()` requests only `latlng,altitude,time`, and the normalizer retains only route/elevation plus summary average HR. It does not ingest the detailed HR, cadence, power, movement, distance, speed, grade, or temperature streams.

## Non-Goals

- Do not scrape Garmin Connect or ask users for Garmin usernames/passwords.
- Do not pair directly with Garmin watches over Bluetooth.
- Do not imply that standard BLE sensor support downloads activities from a watch; it captures live sensor broadcasts only while Forged Hybrid is recording.
- Do not claim Strava is the permanent Garmin integration.
- Do not overwrite athlete-rated RPE with a calculated score.
- Do not create a second run when Apple Health, Strava, FIT, and Forged Hybrid describe the same workout.
- Do not infer missing HR samples, route points, cadence, power, or Garmin-only running dynamics.
- Do not run an AI model to normalize streams or calculate zones. This pipeline is deterministic.
- Do not add an EAS build requirement for the backend/web phases.
- Do not activate Android Health Connect, BLE, or new native permissions in an existing TestFlight build. Each native phase requires device QA and Bryan's explicit EAS approval.

## Canonical Data Model

### 1. `run_source_links`

Add a source-identity table so one run can safely link to multiple providers without overloading `runs.health_source_workout_id`:

- `id`
- `user_id`
- `run_id`
- `provider`: `apple_health`, `strava`, `forged_hybrid`, `garmin_fit`, or future approved provider
- `provider_activity_id`
- `provider_device`
- `started_at`
- `duration_seconds`
- `linked_at`
- unique: `(user_id, provider, provider_activity_id)`

Rules:

- Every SELECT, UPDATE, and DELETE includes `user_id=?`.
- A provider activity can link to only one canonical run for that user.
- Creating the same link twice is idempotent.
- Existing source identifiers remain readable during migration; backfill links lazily when a run is next synchronized.

### 2. `run_metric_streams`

Store provider streams separately from the `runs` summary row:

- `id`
- `user_id`
- `run_id`
- `provider`
- `provider_activity_id`
- `stream_type`
- `resolution`
- `original_size`
- `sample_count`
- `data_json`
- `checksum`
- `created_at`
- `updated_at`
- unique: `(user_id, run_id, provider, stream_type)`

Supported first-cut stream types:

- `time`
- `heartrate`
- `distance`
- `latlng`
- `altitude`
- `cadence`
- `watts`
- `moving`
- `velocity_smooth`
- `grade_smooth`
- `temp`

Storage rules:

- Validate stream type against the allowlist.
- Validate every numeric value and reject non-finite values.
- Preserve index alignment with the `time` stream.
- Limit each stream to 200,000 samples and a bounded serialized size.
- Store the provider's `original_size` and `resolution`; do not silently represent a reduced stream as original resolution.
- Upsert inside the same user-scoped transaction as the canonical run merge.
- Add both tables to account export/deletion coverage.

### 3. Canonical `runs` summary

Continue using `runs` as the single row consumed by History, PRs, plans, challenges, leaderboards, and social surfaces.

Derive and store:

- `avg_heart_rate`
- `min_heart_rate`
- `max_heart_rate`
- `heart_rate_zones`
- `cadence_avg`
- `elevation_gain`
- `elevation_loss`
- `route_coords`
- supported averages in `workout_metrics_json`

Add provenance metadata to `workout_metrics_json`:

- `detail_source`
- `detail_source_device`
- `strava_activity_id`
- `hr_timeline_source`
- `hr_sample_count`
- `hr_provider_original_size`
- `hr_provider_resolution`
- `hr_sample_coverage_pct`
- `hr_quality`: `complete`, `high`, `partial`, `summary_only`, or `missing`
- `route_source`
- `cadence_source`
- `power_source`
- `stream_synced_at`

## Field-Level Source Precedence

Source selection is per field, not one winner for the entire activity.

| Field | Preferred order |
|---|---|
| User effort/RPE | Existing Forged Hybrid user rating -> Strava perceived exertion -> missing |
| HR timeline | Original Garmin FIT -> high-resolution Strava stream -> high-coverage native HealthKit timeline -> missing |
| HR summary | Derived from chosen HR timeline -> provider summary -> missing |
| Route | Original device FIT -> Strava lat/lng stream -> native HealthKit route -> Forged phone capture -> missing |
| Elevation | Device/barometric FIT -> provider total elevation -> altitude-stream calculation -> Forged phone estimate -> missing |
| Cadence/power | Original FIT -> Strava stream -> native HealthKit metric -> missing |
| Calories | Original recording source summary -> existing non-zero canonical value -> missing |

Rules:

- Never overwrite an existing richer field with a weaker source.
- Never overwrite Forged Hybrid user-rated RPE.
- Keep provenance for every selected field.
- When equivalent sources disagree, retain the higher-ranked source and log a bounded discrepancy event without exposing private data.

## Stream Normalization

Extend the Strava stream request to ask for:

`time,distance,latlng,altitude,velocity_smooth,heartrate,cadence,watts,moving,grade_smooth,temp`

Normalization requirements:

1. Parse each response by stream key and preserve `resolution` and `original_size`.
2. Require a valid `time` stream before treating another stream as a timeline.
3. Truncate all aligned streams to the shortest valid aligned length for calculations; preserve individual raw stream metadata.
4. Heart rate must be an integer from 30-250 bpm.
5. Cadence, power, altitude, temperature, distance, and speed use existing bounded metric rules or new explicit bounds.
6. Route points must pass the existing route-coordinate normalizer and privacy-safe size cap.
7. Malformed optional streams are dropped individually and logged; one bad stream must not discard the whole activity.
8. A 401 triggers token refresh/reauthorization behavior. A 429 stops optional stream hydration and retries through the existing bounded sync path.

## Heart-Rate Coverage and Zones

Do not calculate coverage as `sample_count / duration_seconds`. Garmin smart recording and provider stream resolution can use irregular time intervals.

Calculate coverage from elapsed timestamps:

1. Pair valid HR samples with their elapsed `time` values.
2. Use the `moving` stream when present so paused time is excluded.
3. Credit the interval between adjacent valid samples only up to a documented maximum credible gap.
4. Treat longer gaps as uncovered rather than interpolating across them.
5. Divide credited seconds by moving duration, falling back to timer duration only when movement data is unavailable.
6. Record provider `resolution` and `original_size` separately from timeline coverage.

Initial quality bands, isolated behind constants for QA calibration:

- `complete`: coverage >= 98%, provider stream not known to be reduced;
- `high`: coverage >= 90%;
- `partial`: coverage 50-89.9%;
- `summary_only`: average/min/max exists but no usable timeline;
- `missing`: no valid HR data.

Only `complete` and `high` timelines may drive dominant-zone intensity, calculated effort, plan load, and adherence.

For `partial`, `summary_only`, or `missing`:

- show all factual samples and summary values;
- do not extrapolate zone seconds to the whole workout;
- ask the athlete for RPE;
- use user-rated RPE for adaptation;
- explain the source limitation in plain language.

Zone derivation must use the athlete's saved exact HR-zone boundaries. If exact boundaries are unavailable, show HR facts without assigning a confident zone distribution.

## Canonical Matching and Deduplication

Perform matching before creating a run.

Match order:

1. Existing `run_source_links` provider ID.
2. Existing `workout_metrics_json.strava_activity_id` or legacy source ID.
3. Same user and activity kind, start time within 15 minutes, duration within 5 minutes, and distance within 0.10 mile.
4. For treadmill runs, omit route requirements and match by source/start/duration/distance.

If one candidate clearly wins, link and enrich it.

If multiple candidates are plausible, do not auto-merge. Record an internal ambiguity event and leave the existing activities untouched for review.

Merging must preserve exactly one completed run for:

- History;
- weekly mileage;
- PR calculations;
- adaptive plan load;
- challenge and leaderboard mileage;
- social posts;
- plan-session completion;
- streaks and badges.

Required ordering tests:

- Apple Health arrives first, then Strava;
- Strava arrives first, then Apple Health;
- Forged-recorded run arrives first, then Apple Health and Strava;
- webhook redelivery occurs three times;
- app-open sync and webhook process the same activity concurrently;
- user deletes an imported run and a later sync respects the tombstone.

## User Experience

### Connected Sources

When a Garmin-sourced Apple Health workout has summary-only HR or no route and Strava is not connected, show:

> Garmin shared only a workout summary through Apple Health. Connect Strava to import available route and detailed workout streams automatically.

Button: `Complete Garmin data with Strava`

Do not say that connecting Strava guarantees every metric.

When Strava is connected, show setup help only if no Garmin-originated Strava activity has been observed:

> In Garmin Connect, enable activity sharing with Strava. Your next Garmin upload can then enrich the matching Forged Hybrid run.

### Run Recap

Show a compact provenance line:

- `Detailed data: Strava • Garmin synced`
- `Summary: Apple Health`
- `Route: Forged Hybrid phone capture`
- `Heart rate: 94% timeline coverage • high confidence`

Replace the generic sparse-coverage warning for known Garmin Apple Health imports with source-specific copy:

> Garmin sent Apple Health summary-only workout heart rate. Detailed zones are unavailable from this source.

If Strava later enriches the run, remove the stale warning automatically.

### Sync Result

After enrichment, provide a non-blocking result:

> Garmin workout details added through Strava. No duplicate run was created.

Display exactly which fields were added: route, elevation, heart-rate timeline, cadence, or power.

## Delivery Phases

### Phase P0: Product and Privacy Truth

Before adding another provider, align every user-facing claim with what production actually supports.

- Remove the unimplemented Android Health Connect claim until Phase 6 ships.
- Replace claims that Forged Hybrid already sends workouts to Garmin, COROS, TrainingPeaks, Suunto, Wahoo, or Polar with accurate `requires partner access` language.
- Keep Apple Health, Strava, Oura, and WHOOP descriptions limited to fields each active integration actually reads.
- Add a source-capability matrix maintained beside the adapter registry so product copy and code cannot drift independently.

Gate:

- Privacy policy, Settings, onboarding, and watch-delivery copy match executable provider capabilities.
- No unapproved provider is presented as connected, automatic, or available.
- Existing legal ownership, privacy contact, and account deletion/export behavior remain unchanged.

### Phase 0: Contract and Fixture Baseline

- Capture sanitized Strava fixtures representing full, partial, summary-only, treadmill, private, and malformed activities.
- Add deterministic stream-normalization tests before modifying production sync.
- Verify the existing webhook subscription and OAuth scope in the target environment without changing credentials.
- Record current request counts so stream hydration stays within Strava rate limits.

Gate:

- Existing sync behavior remains green.
- Fixtures contain no real athlete tokens, names, exact home coordinates, or other identifying data.

### Phase 1: Detailed Strava Stream Ingestion

- Expand the stream request.
- Add pure stream normalization and HR coverage/zone derivation helpers.
- Add `run_metric_streams` and `run_source_links` to migrations, canonical schema, and account-data coverage.
- Store streams and provenance inside a user-scoped transaction.
- Preserve existing route enrichment behavior.

Gate:

- A full Garmin-via-Strava fixture yields aligned HR, route, altitude, cadence, and power data.
- A malformed optional stream is dropped without losing valid streams.
- No provider token or raw response is logged.

### Phase 2: Canonical Merge and Training Consumers

- Extend canonical enrichment to update summary HR, exact zone seconds, cadence, power, route, and elevation according to field precedence.
- Make webhook/app-open concurrency idempotent.
- Ensure plan load, calculated effort, PRs, challenges, and leaderboards read the single enriched run.
- Keep RPE independent from calculated effort.

Gate:

- All arrival-order and redelivery cases produce exactly one run.
- Partial HR never drives calculated intensity.
- High-quality HR changes calculated intensity only through the existing deterministic effort engine.

### Phase 3: Athlete-Facing Source Clarity

- Add the Garmin-through-Strava setup CTA.
- Add recap provenance and field-added sync notices.
- Replace misleading generic coverage copy with source-aware language.
- Keep technical diagnostics internal; users see an actionable explanation, not API terminology.

Gate:

- A summary-only Garmin/Apple Health recap explains the actual limitation.
- A later Strava enrichment updates the same recap and removes the stale warning.
- Mobile layouts pass at 320, 375, 390, and 430 CSS-pixel widths.

### Phase 3.5: Direct Sensor and Phone Capture

Add a native, provider-independent fallback for athletes willing to record directly in Forged Hybrid.

- Reuse the existing native background-GPS run session and canonical run-save path.
- Add a Core Bluetooth adapter for the standard BLE Heart Rate Service on iOS; define the matching Android BLE adapter before Android implementation.
- Pair by explicit athlete action, display the selected sensor, and never scan indefinitely.
- Store timestamped HR through the same bounded `run_metric_streams` schema used by provider imports.
- Preserve elapsed time, GPS, altitude, and HR through screen lock, app suspension, reconnect, and temporary sensor dropout.
- Show live connection state and coverage; never claim a dropped sensor stream is complete.
- Do not treat a Garmin watch as a generic BLE activity source. A watch may expose live HR broadcasting, but historical workout retrieval remains provider/API/file based.

Gate:

- Physical-device tests pass with at least two standard BLE HR sensors.
- Lock-screen and 30-minute background tests preserve timer, GPS, and HR continuity.
- Sensor disconnect/reconnect creates a visible gap without duplicating or fabricating samples.
- The saved activity remains idempotent when Apple Health or Strava later reports the same workout.

Phase 3.5 requires native privacy metadata review, signed-device testing, and a separately approved EAS build.

### Phase 4: Original Garmin FIT Fallback

Add a manual `Import original activity file` path for historical activities and users who do not use Strava.

- Accept `.fit` and `.fit.gz` as the preferred formats through a size-limited authenticated upload; retain bounded `.tcx` and `.gpx` support for lower-fidelity fallbacks.
- Decode with a maintained FIT parser or Garmin FIT SDK-compatible implementation selected during technical review.
- Parse record timestamps, HR, GPS, altitude, cadence, power, laps, events, device metadata, and supported running dynamics.
- Link to an existing canonical run before creating a new one.
- Label provenance as `Original Garmin FIT file`.
- Preserve the actual manufacturer/device identity from the file when present rather than assuming every FIT upload is Garmin.

Gate:

- A known Garmin FIT fixture matches Garmin Connect summary values within documented rounding tolerance.
- Re-uploading the same file is idempotent.
- Corrupt and oversized files fail safely without partial writes.

Phase 4 requires a separate dependency/security review before implementation.

### Phase 5: Direct Garmin Activity API

When Garmin approves Forged Hybrid:

- add a provider adapter that writes into the same `run_source_links`, `run_metric_streams`, and canonical merge pipeline;
- prefer direct Garmin FIT/activity details over Strava for Garmin-originated fields;
- retain Strava as an independent activity source and fallback;
- do not rewrite the recap, plan, PR, or challenge layers.

The bridge architecture must make direct Garmin access a provider swap, not another parallel run system.

### Phase 6: Android Health Connect

Implement the Android data path before restoring Health Connect claims to privacy and product copy.

- Read authorized exercise sessions and distinguish running, treadmill running, walking, strength, and other supported activity types.
- Read available exercise routes, timestamped HR, speed, distance, elevation, cadence, power, calories, sleep, HRV, resting HR, and recovery records.
- Respect Health Connect route-consent behavior: route reads created by another app may require deliberate foreground user interaction.
- Use Android background-work primitives for deferred sync; do not keep Health Connect active for an entire workout.
- Write provider identity, device metadata, and recording method into source provenance.
- Merge through `run_source_links`, `run_metric_streams`, and the same canonical matching rules used by Apple Health and Strava.

Gate:

- Android fixtures cover outdoor run, treadmill run, walk, strength workout, route-with-consent, route-without-consent, and partial HR.
- One workout shared by Health Connect and Strava remains one canonical run.
- The UI never claims a route or stream exists when the source omitted it.
- Android account export/deletion includes all imported source links and streams.

Phase 6 requires an Android native build, Play policy/privacy review, physical-device QA, and separate shipping approval.

### Phase 7: Approved Provider Adapters

Build each provider behind the same adapter contract only after credentials and production access are granted.

Required adapter methods:

- `getAuthorizationUrl(userId, state)`
- `exchangeAuthorizationCode(code)`
- `refreshAccessToken(connection)`
- `fetchActivities(window)` or webhook/ping-pull equivalent
- `fetchActivityDetails(providerActivityId)`
- `normalizeActivity(payload)`
- `disconnect(userId)`
- optional `pushPlannedWorkout(workout)` when approved

Provider order:

1. Polar AccessLink
2. TrainingPeaks
3. Garmin Activity API, plus Training/Courses API as separately approved
4. Suunto Cloud
5. Wahoo Cloud
6. COROS

Gate for every adapter:

- OAuth state/PKCE or provider-required anti-CSRF controls pass.
- Tokens are encrypted, never logged, refresh safely, and revoke cleanly.
- Webhooks are signature-verified where the provider supports signatures.
- Backfill and redelivery are idempotent.
- Field provenance and source priority are explicit.
- A provider failure cannot prevent other connected sources from syncing.

## Partner Application Campaign

Applications are operational work and proceed in parallel with Phases P0-3. Submission never blocks the Strava bridge.

| Provider | Official entry point | Requested capability | Status on 2026-07-20 | Follow-up |
| --- | --- | --- | --- | --- |
| Garmin | https://developer.garmin.com/gc-developer-program/ | Activity API; Health API; Training API; Courses API | **Business-contact correction submitted 2026-07-20.** Garmin accepted a replacement developer-program contact request from `support@forgeathlete.app`; the message explicitly supersedes the earlier personal-email request. No case ID was shown | Monitor `support@forgeathlete.app`; follow up after 10 business days if Garmin has not replied |
| Polar | https://admin.polaraccesslink.com/ | AccessLink read access, exercise files/samples, sleep/recovery, webhooks | **Business account registration submitted 2026-07-20.** The account uses `support@forgeathlete.app`; password, required consents, name, confirmed date of birth, country, and unit preference are complete. Polar is waiting for email verification before account creation finishes | Verify the email sent to `support@forgeathlete.app`, then create the AccessLink client and record its client ID |
| TrainingPeaks | https://api.trainingpeaks.com/request-access | Profile/zones, workout data/details, calendar events, recovery metrics, planned workout read/write, completed-file upload | **Business-contact correction submitted 2026-07-20.** TrainingPeaks confirmed receipt of the replacement request from `support@forgeathlete.app`; it explicitly supersedes the personal-email request. New-partner onboarding remains paused during API maintenance | Monitor `support@forgeathlete.app` and follow up when TrainingPeaks resumes onboarding |
| Suunto | https://suunto-api.developer.azure-api.net/ | Cloud workout/FIT read access and webhook-ready provider adapter; investigate planned-workout delivery separately | **Submitted and corrected 2026-07-20.** The Cloud API commercial agreement was accepted and signed. Suunto confirmed receipt with a two-week review window, and a business-mail correction was delivered to `partners@suunto.com` directing all replies to `support@forgeathlete.app` | Monitor `support@forgeathlete.app`; follow up after two weeks if Suunto has not replied |
| Wahoo | https://developers.wahooligan.com/cloud | Profile, HR/power zones, workouts, plans, routes, and offline access as approved | **Business account and replacement application submitted 2026-07-20.** Production application `2396`, `Forged Hybrid by Madera Technologies`, is `Pending Approval` under `support@forgeathlete.app` and explicitly supersedes personal-email request `2395`. Requested scopes exclude profile and power-zone writes | Monitor application `2396` and `support@forgeathlete.app`; implement the registered callback before live OAuth testing |
| COROS | https://support.coros.com/hc/en-us/articles/17085887816340-Submit-an-API-Application | Two-way workout sync, structured workouts/plans, GPX routes, and daily health | **Application submitted; contact correction awaiting verification 2026-07-20.** COROS placed the application in its monthly review queue and received all four required unchanged Forged Hybrid logo sizes. An official API-support correction was prepared from `support@forgeathlete.app`, but COROS will not deliver it until that address is verified | Verify the COROS email sent to `support@forgeathlete.app`, then monitor the monthly review queue |

Use one consistent application identity:

- Product: **Forged Hybrid**
- Legal entity: **Madera Technologies LLC**
- Product URL: `https://forgeathlete.app`
- Production service: `https://forge-production-773f.up.railway.app`
- Privacy URL: `https://forge-production-773f.up.railway.app/privacy`
- Support contact: `support@forgeathlete.app`
- Privacy contact: `privacy@forgeathlete.app`
- iOS bundle identifier: `com.zordon.forge`
- Product description: adaptive hybrid running and strength coaching that combines authorized workout, recovery, and athlete check-in data; creates one canonical activity; and sends structured planned workouts only through approved provider channels.

Application rules:

- Request only documented scopes needed for the use case.
- State clearly that the beta is active and that users explicitly authorize each provider.
- State that Forged Hybrid never asks for provider usernames/passwords and does not scrape provider services.
- Explain canonical deduplication, athlete controls, disconnect, export, and deletion.
- Do not claim automatic workout push where the requested program has not approved it.
- Store application date, provider case/client ID, status, reviewer request, and follow-up date in a checked-in status document; never commit client secrets or tokens.
- Store self-service account passwords only in the macOS login keychain under provider-specific Forged Hybrid entries; never place them in source, docs, shell history, logs, screenshots, or chat.
- Treat provider terms, commercial agreements, and signatures as account-owner actions. Prepare every ordinary field first, then obtain action-time confirmation immediately before acceptance or submission.
- Apple HealthKit, Android Health Connect, direct iPhone GPS/altitude capture, original-file import, and standard BLE heart-rate sensors do not require applications to Garmin, Polar, TrainingPeaks, Suunto, Wahoo, or COROS. Their implementation and platform permissions remain separate engineering phases.

## Security and Privacy

- All routes require existing JWT auth.
- Every read/write/delete is scoped to `req.user.id`.
- OAuth tokens remain encrypted at rest and never enter frontend logs.
- Stream responses are treated as untrusted structured input and bounded before persistence.
- Exact route coordinates remain private by default and follow existing sharing controls.
- Never expose exact start/end coordinates in social cards unless the athlete explicitly chooses an approved privacy-safe route share.
- Account export and deletion include source links and streams.
- Disconnecting Strava stops future sync; define whether previously imported factual workout data remains according to the current privacy policy and disclose that behavior in the disconnect confirmation.
- BLE scanning starts only from an athlete action, filters to required services, and stops when the connection flow or workout ends.
- Native location, Bluetooth, health, and background permissions use accurate platform purpose strings and least-privilege declarations.
- Health Connect and HealthKit reads remain source-limited: the app must not imply the platform health store guarantees complete data from every connected watch.
- Uploaded activity files are bounded, parsed as untrusted binary/XML input, deleted after deterministic normalization, and never made public.

## Observability

Record structured, privacy-safe counters:

- Strava activities received;
- canonical matches;
- new canonical runs;
- duplicate/redelivery suppressions;
- ambiguous matches;
- per-stream availability;
- coverage quality band;
- rate-limit responses;
- stream parse failures by type;
- enrichment fields added.

Do not log raw coordinates, HR arrays, access tokens, athlete names, or complete provider payloads.

## QA Matrix

### Automated

- `node --check` every changed backend file.
- Stream normalizer smoke with full and malformed fixtures.
- HR coverage and exact-zone boundary smoke.
- Canonical matching/redelivery/concurrency smoke.
- Account data coverage check includes both new tables.
- Existing run recap, effort, PR, challenge, leaderboard, and plan smokes pass.
- `cd frontend && npm run build`.
- `cd frontend && npm audit --audit-level=high`.
- `cd backend && npm run check:account-data`.
- Capability-matrix test fails when product/privacy copy presents an unimplemented provider as available.
- FIT/TCX/GPX parser fixtures reject oversized, corrupt, decompression-bomb, and unsupported files.
- Provider-contract tests run against sanitized fixtures without live credentials.

### Native phase additions

- BLE pairing, disconnect, reconnect, screen-lock, and background-duration device tests.
- iOS privacy metadata and signed-IPA inspection after explicit EAS approval.
- Android Health Connect permission, route-consent, background sync, and account deletion tests.
- Platform builds must demonstrate that denied permissions leave the rest of Forged Hybrid usable.

### Production-safe beta verification

Use three Bryan-owned or explicitly consenting beta activities:

1. outdoor Garmin run with GPS and HR;
2. treadmill Garmin run with HR but no route;
3. outdoor run with an intentional HR recording gap if available.

Compare Forged Hybrid against Garmin Connect and Strava for:

- start time;
- sport type;
- moving and elapsed time;
- distance;
- average/min/max HR;
- HR timeline span and zone seconds;
- cadence and power when present;
- route shape;
- elevation gain;
- duplicate count.

Document expected rounding differences. Do not require exact equality where providers apply different elevation-smoothing algorithms.

## Rollout

1. Phase P0 product/privacy truth correction.
2. Submit all partner applications and record case/client IDs without secrets.
3. Phase 0 fixtures and regression baseline.
4. Phase 1 behind an internal server-side allowlist or existing diagnostics-admin gate.
5. Verify Bryan's recent Garmin-via-Strava workouts against Garmin Connect.
6. Phase 2 canonical consumers and dedup matrix.
7. Phase 3 source clarity for beta testers.
8. Monitor rate limits, match ambiguity, duplicates, and coverage quality for seven days.
9. Implement Phase 4 original FIT import if Strava coverage is materially incomplete or Garmin approval remains delayed.
10. Build Phase 3.5 direct BLE capture as a separately approved native release.
11. Build Phase 6 when the Android client is ready for native testing.
12. Activate Phase 7 adapters one provider at a time after approval and fixture QA.

Railway deployment is required for Phases P0-4 and provider backend adapters. EAS is not required for Phases P0-3. Phase 3.5 requires iOS native build approval; Phase 6 requires Android native build approval. No EAS command may run without Bryan's explicit approval for that build.

## Definition of Done

- A Garmin run synced through Apple Health and Strava appears exactly once.
- The canonical run contains every valid detailed stream Strava supplied within defined bounds.
- HR quality is based on elapsed-time coverage, not naive sample count.
- High-quality HR timelines generate exact zone seconds using the athlete's saved boundaries.
- Partial/summary-only HR does not drive intensity or adaptation.
- Route, elevation, cadence, and power use field-level provenance and never overwrite stronger data with weaker estimates.
- The recap explains where each important metric came from.
- Repeated webhook and app-open syncs are idempotent.
- PRs, mileage, plans, challenges, leaderboards, and social surfaces consume one run.
- Account export/deletion covers all new user-owned data.
- Full toolchain and focused smokes pass.
- No EAS build is run.
- Product and privacy copy expose only implemented provider capabilities.
- Original FIT ingestion can preserve available full-fidelity workout records when no approved API supplies them.
- Directly recorded workouts can combine phone route/altitude with a standard BLE HR sensor without depending on a watch-vendor API.
- Android Health Connect is either implemented and verified or absent from active product/privacy claims.
- Every approved provider adapter feeds the same canonical activity and provenance model.
- Partner application status is recorded without committing secrets.

## Decisions Needed Before Build

1. Approve Strava as the automatic interim Garmin bridge.
2. Approve retaining detailed streams for future charts and zone recalculation instead of storing summaries only.
3. Approve Phase P0 immediately so privacy and provider-availability claims are accurate before more applications are reviewed.
4. Decide whether Phase 4 original FIT import should follow immediately or wait for seven days of Strava beta results.
5. Approve direct BLE HR capture as the provider-independent live-recording fallback, with its own later EAS build.
6. Confirm Android Health Connect remains hidden until the native Android implementation and privacy review pass.
7. Confirm that imported factual workout data remains in the account after a provider disconnect unless the athlete deletes the run/account, matching the disclosed policy.

## Recommended Decision

Approve Phase P0 and Phases 0-3 now. They correct current claims and close the largest Garmin data gap using infrastructure already in production, require no new credentials or EAS build, and preserve a clean path to every official provider adapter.

Submit Garmin, Polar, TrainingPeaks, Suunto, Wahoo, and COROS applications in parallel. Hold Phase 4 until Strava stream results are measured, then build it if Strava omits important streams for a meaningful percentage of beta Garmin workouts or if Garmin approval remains delayed. Schedule Phase 3.5 and Phase 6 as independent native releases only after web/backend ingestion is stable.
