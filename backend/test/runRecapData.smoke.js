const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  chooseMatchingHealthRun,
  decodeSummaryPolyline,
  normalizeStravaRun,
  routeCoordsFromStravaStreams,
} = require('../src/lib/stravaActivity');
const { normalizeWorkoutMetrics } = require('../src/lib/workoutMetrics');

const root = path.join(__dirname, '..', '..');
const stravaRoute = fs.readFileSync(path.join(root, 'backend/src/routes/strava.js'), 'utf8');
const importRoute = fs.readFileSync(path.join(root, 'backend/src/routes/import.js'), 'utf8');
const swift = fs.readFileSync(path.join(root, 'frontend/ios/App/App/ForgeHealthPlugin.swift'), 'utf8');
const healthService = fs.readFileSync(path.join(root, 'frontend/src/services/HealthService.js'), 'utf8');
const recap = fs.readFileSync(path.join(root, 'frontend/src/components/RunDetailModal.jsx'), 'utf8');
const shareStudio = fs.readFileSync(path.join(root, 'frontend/src/components/ActivityShareStudio.jsx'), 'utf8');

const decoded = decodeSummaryPolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
assert.deepStrictEqual(decoded.slice(0, 3), [
  { lat: 38.5, lon: -120.2 },
  { lat: 40.7, lon: -120.95 },
  { lat: 43.252, lon: -126.453 },
], 'standard encoded polyline should decode deterministically');

const incoming = normalizeStravaRun({
  id: 12345,
  type: 'Run',
  name: 'Morning Run',
  start_date: '2026-07-18T10:00:00Z',
  start_date_local: '2026-07-18T06:00:00-04:00',
  distance: 6598.3,
  moving_time: 2512,
  elapsed_time: 2580,
  average_heartrate: 143.4,
  total_elevation_gain: 30,
  perceived_exertion: 6,
  map: { summary_polyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@' },
});
assert.strictEqual(incoming.distanceMiles, 4.1);
assert.strictEqual(incoming.elevationGainFeet, 98.4);
assert.strictEqual(incoming.averageHeartRate, 143);
assert.strictEqual(incoming.perceivedEffort, 6);
assert.strictEqual(incoming.routeCoords.length, 3);

const detailedRoute = normalizeStravaRun({
  id: 12346,
  type: 'Run',
  distance: 6598.3,
  moving_time: 2512,
  elapsed_time: 2580,
  start_date: '2026-07-18T10:00:00Z',
  map: {
    polyline: '_p~iF~ps|U_ulLnnqC_mqNvxq`@',
    summary_polyline: '_p~iF~ps|U',
  },
});
assert.strictEqual(detailedRoute.routeCoords.length, 3, 'detailed Strava polyline wins over the summary line');

const streamedRoute = routeCoordsFromStravaStreams({
  latlng: { data: [[38.9, -76.99], [38.901, -76.991], ['bad', -76.992]] },
  altitude: { data: [10, 12, 13] },
  time: { data: [0, 30, 60] },
}, '2026-07-20T10:00:00Z');
assert.deepStrictEqual(streamedRoute, [
  { lat: 38.9, lon: -76.99, alt: 10, time: '2026-07-20T10:00:00.000Z' },
  { lat: 38.901, lon: -76.991, alt: 12, time: '2026-07-20T10:00:30.000Z' },
], 'Strava streams preserve valid GPS, altitude, and elapsed-time data');

const matching = chooseMatchingHealthRun([
  { id: 'wrong-time', duration_seconds: 2510, health_start_at: '2026-07-18T08:00:00Z' },
  { id: 'right-time', duration_seconds: 2512, health_start_at: '2026-07-18T10:02:00Z' },
], incoming);
assert.strictEqual(matching?.id, 'right-time', 'matching uses start time as well as date, distance, and duration');
assert.strictEqual(chooseMatchingHealthRun([
  { id: 'ambiguous-a', duration_seconds: 2512, health_start_at: null },
  { id: 'ambiguous-b', duration_seconds: 2512, health_start_at: null },
], incoming), null, 'ambiguous same-day activities are never merged');

const metrics = normalizeWorkoutMetrics({
  workout_effort_user_rated: 1,
  elevation_derived_from_route: 1,
  route_enriched_from_strava: 1,
  elevation_enriched_from_strava: 1,
}).metrics;
assert.strictEqual(metrics.workout_effort_user_rated, 1);
assert.strictEqual(metrics.elevation_derived_from_route, 1);
assert.strictEqual(metrics.route_enriched_from_strava, 1);
assert.strictEqual(metrics.elevation_enriched_from_strava, 1);

assert(/WHERE user_id=\? AND date=\? AND health_source IN \('apple_health', 'forged_hybrid'\)/.test(stravaRoute), 'Strava matching enriches only user-scoped canonical health or Forged recordings');
assert(/WHERE id=\? AND user_id=\?/.test(stravaRoute), 'Strava enrichment updates are user scoped');
assert(/\/streams/.test(stravaRoute) && /latlng,altitude,time/.test(stravaRoute), 'Strava route recovery requests full GPS streams');
assert(/perceived_effort = COALESCE\(\?, perceived_effort\)/.test(importRoute), 'Apple Health re-sync can add a real effort score to an existing run');
assert(/workoutEffortScore/.test(swift) && /HKWorkoutEffortRelationshipQuery/.test(swift), 'native bridge requests the associated HealthKit effort rating');
assert(/elevation_derived_from_route/.test(swift) && /verticalAccuracy/.test(swift), 'route elevation fallback accepts only bounded-accuracy altitude');
assert(/REQUIRED_HEALTH_AUTH_VERSION\s*=\s*4/.test(healthService) && /REQUIRED_WORKOUT_IMPORT_VERSION\s*=\s*5/.test(healthService), 'native authorization and full-history upgrades are versioned');
assert(/Recording details not shared/.test(recap) && /Rate this run/.test(recap), 'recap explains missing source data and offers a check-in');
assert(/Calculated training effort/.test(recap) && /objective load estimate, not your personal RPE/.test(recap), 'recap labels calculated effort separately from athlete-rated RPE');
assert(/backendEffortSource[\s\S]*effort_source/.test(recap), 'recap consumes backend effort provenance before using its legacy fallback');
assert(/Runs started in Forged Hybrid record iPhone GPS and altitude/.test(recap), 'recap explains when the phone can capture route and elevation');
assert(/isRun && !shareOpen && routePositions\.length >= 2/.test(recap), 'the interactive Leaflet map unmounts while the share studio is open');
assert(/z-\[2000\][\s\S]*zIndex: 2000/.test(shareStudio), 'the share studio sits above all Leaflet panes and controls');
assert(!/MapContainer/.test(shareStudio), 'share cards render one canvas route instead of nesting an interactive map');
assert(/ROUTE_START_COLOR\s*=\s*'#22C55E'/.test(shareStudio), 'share routes mark the first coordinate in green');
assert(/ROUTE_END_COLOR\s*=\s*'#EF4444'/.test(shareStudio), 'share routes mark the last coordinate in red');
assert(/fetchRecentWorkoutHistory/.test(swift) && /mergeWorkoutHistory/.test(swift), 'native sync rechecks recent workouts for late HealthKit routes');

console.log('Run recap data smoke passed');
