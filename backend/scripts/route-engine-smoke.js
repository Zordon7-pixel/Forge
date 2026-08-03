#!/usr/bin/env node
const assert = require('assert');
const {
  RouteEngineError,
  clearRouteCache,
  generateElevationAwareRoute,
  searchRouteStartPlaces,
  validatePlaceQuery,
  validateRouteInput,
} = require('../src/services/routeEngine');

function featureForCandidate(callIndex) {
  const altitudeProfiles = [
    [100, 101, 100, 101, 100],
    [100, 112, 104, 115, 100],
    [100, 135, 105, 145, 100],
  ];
  const elevations = altitudeProfiles[callIndex];
  return {
    ok: true,
    status: 200,
    json: async () => ({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { summary: { distance: 4828.032, duration: 1800 } },
        geometry: {
          type: 'LineString',
          coordinates: elevations.map((altitude, index) => [-76.61 + (index * 0.001), 39.29 + (index * 0.001), altitude]),
        },
      }],
    }),
  };
}

async function generate(preference) {
  let callIndex = 0;
  const requestUrls = [];
  const requestBodies = [];
  const route = await generateElevationAwareRoute({
    latitude: 39.29,
    longitude: -76.61,
    distanceMiles: 3,
    elevationPreference: preference,
    surface: 'road',
  }, {
    apiKey: 'test-key',
    skipCache: true,
    fetchImpl: async (url, init) => {
      requestUrls.push(url);
      requestBodies.push(JSON.parse(init.body));
      return featureForCandidate(callIndex++);
    },
  });
  return { route, requestUrls, requestBodies };
}

(async () => {
  clearRouteCache();
  const flatResult = await generate('flat');
  const balancedResult = await generate('balanced');
  const hillyResult = await generate('hilly');
  const flat = flatResult.route;
  const balanced = balancedResult.route;
  const hilly = hillyResult.route;

  assert(flat.elevationGainFeet < balanced.elevationGainFeet, 'flat candidate should have less gain than balanced');
  assert(balanced.elevationGainFeet < hilly.elevationGainFeet, 'balanced candidate should have less gain than hilly');
  assert.strictEqual(flat.distanceMiles, 3, 'provider distance should be converted to miles');
  assert.deepStrictEqual(flat.coordinates[0].slice(0, 2), [39.29, -76.61], 'GeoJSON longitude/latitude should convert to Leaflet latitude/longitude');
  assert.strictEqual(flat.alternativesEvaluated, 3, 'all three candidates should be considered');
  assert(
    flatResult.requestUrls.every((url) => url.startsWith('https://api.heigit.org/openrouteservice/v2/directions/')),
    'route requests must use the current HeiGIT OpenRouteService host',
  );
  assert(
    flatResult.requestBodies.every((body) => body.options?.round_trip && !body.options?.profile_params),
    'route requests must use the provider-supported round-trip options shape',
  );

  assert.throws(
    () => validateRouteInput({ latitude: 39, longitude: -76, distanceMiles: 100 }),
    (err) => err instanceof RouteEngineError && err.status === 400,
    'oversized distance should fail at the boundary',
  );

  assert.throws(
    () => validatePlaceQuery('  x  '),
    (err) => err instanceof RouteEngineError && err.code === 'INVALID_PLACE_QUERY',
    'short place searches should fail at the boundary',
  );
  assert.throws(
    () => validatePlaceQuery('x'.repeat(121)),
    (err) => err instanceof RouteEngineError && err.code === 'INVALID_PLACE_QUERY',
    'oversized place searches should fail at the boundary',
  );

  let geocodeUrl = '';
  let geocodeHeaders = null;
  const places = await searchRouteStartPlaces(' Portland,   Maine ', {
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      geocodeUrl = url;
      geocodeHeaders = init.headers;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          features: [
            { geometry: { coordinates: [-70.2568, 43.6591] }, properties: { label: 'Portland, Cumberland County, Maine, USA' } },
            { geometry: { coordinates: [-70.2568, 43.6591] }, properties: { label: 'Duplicate Portland' } },
            { geometry: { coordinates: [-68.0, 45.0] }, properties: { label: 'Maine, USA' } },
            { geometry: { coordinates: ['bad', 44] }, properties: { label: 'Invalid coordinates' } },
          ],
        }),
      };
    },
  });
  assert(geocodeUrl.startsWith('https://api.openrouteservice.org/geocode/search?'), 'place search uses the ORS geocoder host');
  assert(geocodeUrl.includes('text=Portland%2C+Maine') && geocodeUrl.includes('size=5'), 'place search normalizes and bounds the query');
  assert.strictEqual(geocodeHeaders.Authorization, 'test-key', 'provider key stays in the server-side authorization header');
  assert.deepStrictEqual(places, [
    { label: 'Portland, Cumberland County, Maine, USA', latitude: 43.6591, longitude: -70.2568 },
    { label: 'Maine, USA', latitude: 45, longitude: -68 },
  ], 'place search returns unique validated coordinates only');

  await assert.rejects(
    () => generateElevationAwareRoute({ latitude: 39, longitude: -76, distanceMiles: 3 }),
    (err) => err instanceof RouteEngineError && err.code === 'ROUTE_PROVIDER_NOT_CONFIGURED',
    'missing provider configuration should fail cleanly',
  );

  console.log('route engine smoke OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
