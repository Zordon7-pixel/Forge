#!/usr/bin/env node
const assert = require('assert');
const {
  RouteEngineError,
  clearRouteCache,
  generateElevationAwareRoute,
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
  const route = await generateElevationAwareRoute({
    latitude: 39.29,
    longitude: -76.61,
    distanceMiles: 3,
    elevationPreference: preference,
    surface: 'road',
  }, {
    apiKey: 'test-key',
    skipCache: true,
    fetchImpl: async (url) => {
      requestUrls.push(url);
      return featureForCandidate(callIndex++);
    },
  });
  return { route, requestUrls };
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

  assert.throws(
    () => validateRouteInput({ latitude: 39, longitude: -76, distanceMiles: 100 }),
    (err) => err instanceof RouteEngineError && err.status === 400,
    'oversized distance should fail at the boundary',
  );

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
