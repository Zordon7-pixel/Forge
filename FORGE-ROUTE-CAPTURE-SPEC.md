# FORGE Route Capture Mode Build Spec

Status: Draft for Hermes review
Scope: Forge app (`forge-app`) React/Vite/Capacitor frontend + Express backend
Goal: Capture accurate run routes for future runs without requiring users to abandon their watch workflow or creating duplicate runs after Apple Health/Strava sync.

## Product Problem

Forged Hybrid can show route maps only when it receives route coordinates. Apple Health and some watch/app sources often share workout summaries without GPS route data. Once a run is imported as summary-only, Forge cannot reconstruct the route honestly.

Users should have a clear way to capture the route from the phone while still recording on Garmin, Apple Watch, Strava, or another watch/app. Forge should later merge the phone route with the watch summary instead of showing duplicate activities.

## Product Decision

Add `Route Capture Mode` to the Train day sheet and active run flow.

This mode records iPhone GPS + altitude for a planned run while the user can still record the workout on their preferred watch. After Apple Health or Strava syncs the completed workout, Forge links the watch summary to the captured route using timestamp, duration, distance, and source identifiers.

Do not guess missing route data. Do not create fake maps.

## Effort / RPE Decision

Forge should not pretend to determine perceived effort when heart-rate coverage is missing or unreliable.

Keep effort, but make it user-rated:
- After route capture or imported-run review, ask: `How hard did this feel?`
- Store as `perceived_effort` through the existing run check-in/update paths.
- If HR coverage is strong, Forge may show `calculated training effort`, but the copy must say it is calculated and still ask the user to rate how it felt.
- Adaptation should prefer `effort_source='user_rated'` when present.

Do not remove effort. RPE is one of the most useful subjective signals for adaptive training, especially when watch data is incomplete.

## User Experience

### Train Day Sheet

For a scheduled run, show:
- `Start Run`
- `Capture route only`
- `Plan route`

`Start Run` remains the normal full Forge recording path.

`Capture route only` starts GPS route capture without requiring the user to use Forge as the main workout recorder. Copy:

> Recording route in Forge. Keep recording on your watch if you want heart rate, lap, and device metrics. Forge will merge the route with your synced workout later.

### During Capture

Show:
- Live map with yellow location dot
- Planned route if available
- Captured route line
- Elapsed time
- GPS quality
- Elevation gain estimate
- Battery/background warning if native background location is unavailable

Buttons:
- Pause
- Finish capture
- Discard

No pace pressure in route-only mode unless distance is available and stable.

### After Capture

Show:
- `Route captured`
- Map preview
- Distance estimate
- Duration
- Elevation gain estimate
- `Waiting for workout summary`
- `Rate effort`

If a matching Apple Health/Strava workout arrives:

> Matched with your Garmin/Apple/Strava run. Route and summary are now one activity.

If no match after 24 hours:

> No matching workout synced yet. Keep as route-only activity or discard.

## Data Model

Add `run_route_captures`:

- `id`
- `user_id`
- `plan_session_id`
- `started_at`
- `ended_at`
- `duration_seconds`
- `distance_miles`
- `elevation_gain`
- `elevation_loss`
- `route_coords`
- `status`: `capturing`, `finished`, `matched`, `discarded`
- `matched_run_id`
- `match_confidence`
- `created_at`
- `updated_at`

Rules:
- Every SELECT/UPDATE/DELETE must include `AND user_id=?`.
- Route coordinates must be size-limited and validated using the existing route coordinate normalization pattern.
- Discard should soft-delete by status unless there is a strong reason to hard-delete.

## Matching Logic

When Apple Health/Strava imports a run:

1. First use source IDs if available:
   - `health_source_workout_id`
   - Strava activity ID
   - existing import keys
2. Then match by:
   - same user
   - start time within 30 minutes
   - duration within 20%
   - distance within 0.25 mi or 10%, whichever is larger
3. If multiple candidates match, choose the highest confidence and leave the rest untouched.

Merge behavior:
- Keep watch summary values for distance, duration, calories, HR, cadence, zones, and device metrics.
- Use phone route coordinates if imported workout lacks route.
- Use phone elevation only if imported workout lacks elevation.
- Never overwrite richer provider data with weaker phone estimates.
- Do not create a second run if an imported workout matches a captured route.

## Backend Phases

### Phase 1: Route Capture Storage

Add table + routes:
- `POST /api/runs/route-captures/start`
- `PATCH /api/runs/route-captures/:id`
- `POST /api/runs/route-captures/:id/finish`
- `POST /api/runs/route-captures/:id/discard`

Validation:
- Auth required.
- Scope every query to `req.user.id`.
- Validate route points, duration, distance, elevation.
- No empty catches.

### Phase 2: Import Merge

Extend `/api/import/health` and Strava sync:
- On import, look for unmatched finished route captures.
- If match found, attach route/elevation to the run row.
- Mark route capture `matched`.
- Return `matchedRouteCapture: true` in import response metadata.

### Phase 3: Run Recap and History

Update run detail:
- If route exists, show map.
- If route came from phone capture, label: `Route captured by Forged Hybrid`.
- If route missing, keep the existing honest “recording details not shared” message.
- Add `Rate effort` when perceived effort is missing or calculated only.

## Frontend Phases

### Phase 1: Train Entry Points

In Train day view:
- Add `Capture route only`.
- Keep `Start Run` for full Forge recording.
- Keep `Plan route` for route planning.

### Phase 2: Capture Screen

Create a native-aware capture screen:
- Uses existing GPS/background location patterns from `ActiveRun`.
- Saves capture state locally during recording.
- Uploads route points in batches or on finish.
- Handles app background/foreground without resetting.

### Phase 3: Post-Capture Review

After finish:
- Show map preview.
- Ask effort RPE 1-10.
- Ask pain/energy using existing post-run check-in language.
- Show waiting state for watch summary.

## Native Requirements

Use existing Capacitor background geolocation setup.

Do not ship this feature to TestFlight until:
- Route capture works with screen locked.
- App resume does not reset elapsed time or route state.
- GPS points continue after background/foreground transitions.
- Battery impact is acceptable for a 90-minute run.

## Deduplication Requirements

This feature must not double-count:
- Weekly mileage
- PRs
- Challenge mileage
- Friend leaderboards
- Plan completion
- Body/readiness load

If a route capture is unmatched, it should not count as a completed run until the user explicitly chooses `Keep as run`.

## Acceptance Criteria

- User can open Train, tap a scheduled run, and start route-only capture.
- Map shows current position with a clear yellow dot.
- Captured route appears after finish.
- User can rate effort after capture.
- Apple Health/Strava import merges a matching summary into the route capture.
- No duplicate row appears in History after matching.
- Run recap shows route, elevation, HR, calories, and pace from the best available source.
- If no provider route exists and Forge route capture was not used, recap clearly says route was not shared.
- All changed backend queries are scoped by `user_id`.
- `npm run build`, backend account-data check, and relevant route/import smokes pass.

## Open Questions for Hermes

1. Should route-only captures be invisible from History until matched, or visible as `Pending summary`?
2. Should route capture auto-start when the user taps `Start Run`, or stay as a separate explicit action?
3. What is the safest matching threshold for short runs under 2 miles?
4. Should unmatched route captures expire automatically after 7 days?
5. Should the first cut support Strava matching only, Apple Health matching only, or both?

## Suggested Build Order

1. Backend route-capture table and authenticated CRUD.
2. Frontend route-only capture UI using existing ActiveRun GPS patterns.
3. Import merge/dedup.
4. Run recap map + provenance labels.
5. On-device lock-screen QA.
