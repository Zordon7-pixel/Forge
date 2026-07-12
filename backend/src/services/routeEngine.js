const crypto = require('crypto');

const ORS_BASE_URL = 'https://api.heigit.org/openrouteservice/v2/directions';
const METERS_PER_MILE = 1609.344;
const FEET_PER_METER = 3.28084;
const ROUTE_TIMEOUT_MS = 10000;
const ROUTE_CACHE_TTL_MS = 20 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const CANDIDATE_COUNT = 3;
const MAX_ROUTE_POINTS = 800;
const routeCache = new Map();

class RouteEngineError extends Error {
  constructor(message, { status = 500, code = 'ROUTE_GENERATION_FAILED' } = {}) {
    super(message);
    this.name = 'RouteEngineError';
    this.status = status;
    this.code = code;
  }
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function validateRouteInput(input = {}) {
  const latitude = finiteNumber(input.latitude ?? input.lat);
  const longitude = finiteNumber(input.longitude ?? input.lon ?? input.lng);
  const distanceMiles = finiteNumber(input.distanceMiles ?? input.distance_miles);
  const elevationPreference = String(input.elevationPreference || 'balanced').toLowerCase();
  const surface = String(input.surface || 'road').toLowerCase();

  if (latitude === null || latitude < -90 || latitude > 90) {
    throw new RouteEngineError('A valid starting latitude is required.', { status: 400, code: 'INVALID_START' });
  }
  if (longitude === null || longitude < -180 || longitude > 180) {
    throw new RouteEngineError('A valid starting longitude is required.', { status: 400, code: 'INVALID_START' });
  }
  if (distanceMiles === null || distanceMiles < 0.5 || distanceMiles > 50) {
    throw new RouteEngineError('Distance must be between 0.5 and 50 miles.', { status: 400, code: 'INVALID_DISTANCE' });
  }
  if (!['flat', 'balanced', 'hilly'].includes(elevationPreference)) {
    throw new RouteEngineError('Elevation preference must be flat, balanced, or hilly.', { status: 400, code: 'INVALID_ELEVATION_PREFERENCE' });
  }
  if (!['road', 'trail'].includes(surface)) {
    throw new RouteEngineError('Surface must be road or trail.', { status: 400, code: 'INVALID_SURFACE' });
  }

  return { latitude, longitude, distanceMiles, elevationPreference, surface };
}

function haversineMiles(a, b) {
  const radiusMiles = 3958.8;
  const toRadians = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRadians(b[1] - a[1]);
  const dLon = toRadians(b[0] - a[0]);
  const lat1 = toRadians(a[1]);
  const lat2 = toRadians(b[1]);
  const value = Math.sin(dLat / 2) ** 2
    + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * radiusMiles * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function smoothElevations(values) {
  return values.map((value, index) => {
    if (!Number.isFinite(value)) return null;
    const window = values
      .slice(Math.max(0, index - 2), Math.min(values.length, index + 3))
      .filter(Number.isFinite);
    return window.reduce((sum, item) => sum + item, 0) / window.length;
  });
}

function buildElevationProfile(rawCoordinates) {
  const elevations = smoothElevations(rawCoordinates.map((point) => finiteNumber(point[2])));
  let cumulativeMiles = 0;
  let gainMeters = 0;
  let lossMeters = 0;
  const profile = [];

  for (let index = 0; index < rawCoordinates.length; index += 1) {
    if (index > 0) cumulativeMiles += haversineMiles(rawCoordinates[index - 1], rawCoordinates[index]);
    const elevationMeters = elevations[index];
    if (index > 0 && Number.isFinite(elevationMeters) && Number.isFinite(elevations[index - 1])) {
      const delta = elevationMeters - elevations[index - 1];
      if (delta > 0) gainMeters += delta;
      if (delta < 0) lossMeters += Math.abs(delta);
    }
    if (Number.isFinite(elevationMeters)) {
      profile.push({
        distanceMiles: Number(cumulativeMiles.toFixed(3)),
        elevationFeet: Math.round(elevationMeters * FEET_PER_METER),
      });
    }
  }

  const elevationsMeters = elevations.filter(Number.isFinite);
  return {
    gainMeters,
    lossMeters,
    minElevationMeters: elevationsMeters.length ? Math.min(...elevationsMeters) : null,
    maxElevationMeters: elevationsMeters.length ? Math.max(...elevationsMeters) : null,
    profile,
  };
}

function downsample(items, maximum) {
  if (items.length <= maximum) return items;
  const output = [items[0]];
  const stride = (items.length - 2) / (maximum - 2);
  for (let index = 1; index < maximum - 1; index += 1) {
    output.push(items[Math.round(index * stride)]);
  }
  output.push(items[items.length - 1]);
  return output;
}

function deterministicSeed(input, offset) {
  const source = [
    input.latitude.toFixed(4),
    input.longitude.toFixed(4),
    input.distanceMiles.toFixed(2),
    input.surface,
    offset,
  ].join(':');
  return crypto.createHash('sha256').update(source).digest().readUInt32BE(0) & 0x7fffffff;
}

function providerRequest(input, seed) {
  const profile = input.surface === 'trail' ? 'foot-hiking' : 'foot-walking';
  return {
    url: `${ORS_BASE_URL}/${profile}/geojson`,
    body: {
      coordinates: [[input.longitude, input.latitude]],
      elevation: true,
      instructions: false,
      extra_info: ['surface', 'steepness', 'suitability'],
      options: {
        avoid_features: ['ferries', 'fords', 'steps'],
        round_trip: {
          length: Math.round(input.distanceMiles * METERS_PER_MILE),
          points: 5,
          seed,
        },
      },
    },
  };
}

function providerError(responseStatus, payload) {
  const providerMessage = String(payload?.error?.message || payload?.error || '').toLowerCase();
  if (responseStatus === 429) {
    return new RouteEngineError('The route planner is busy. Try again in a few minutes.', { status: 429, code: 'ROUTE_RATE_LIMITED' });
  }
  if (responseStatus === 401 || responseStatus === 403) {
    return new RouteEngineError('Route planning is temporarily unavailable.', { status: 503, code: 'ROUTE_PROVIDER_AUTH' });
  }
  if (responseStatus >= 400 && responseStatus < 500) {
    const noRoute = providerMessage.includes('could not find') || providerMessage.includes('route');
    return new RouteEngineError(
      noRoute
        ? 'No runnable loop was found here. Try a different surface or move closer to a road or trail.'
        : 'The route request could not be completed.',
      { status: 422, code: 'NO_ROUTE_FOUND' },
    );
  }
  return new RouteEngineError('The route provider did not respond. Try again shortly.', { status: 503, code: 'ROUTE_PROVIDER_FAILED' });
}

function routeFromFeature(feature, input, seed) {
  const rawCoordinates = Array.isArray(feature?.geometry?.coordinates)
    ? feature.geometry.coordinates.filter((point) => (
      Array.isArray(point)
      && Number.isFinite(Number(point[0]))
      && Number.isFinite(Number(point[1]))
    )).map((point) => [Number(point[0]), Number(point[1]), finiteNumber(point[2])])
    : [];

  if (rawCoordinates.length < 2) {
    throw new RouteEngineError('The route provider returned an incomplete course.', { status: 502, code: 'INVALID_ROUTE_RESPONSE' });
  }

  const summary = feature?.properties?.summary || {};
  const elevation = buildElevationProfile(rawCoordinates);
  const providerAscent = finiteNumber(feature?.properties?.ascent ?? summary.ascent);
  const providerDescent = finiteNumber(feature?.properties?.descent ?? summary.descent);
  const profileDistanceMiles = elevation.profile.at(-1)?.distanceMiles;
  const distanceMeters = finiteNumber(summary.distance)
    ?? (Number.isFinite(profileDistanceMiles) ? profileDistanceMiles * METERS_PER_MILE : null);
  if (!Number.isFinite(distanceMeters) || distanceMeters <= 0) {
    throw new RouteEngineError('The route provider returned an invalid distance.', { status: 502, code: 'INVALID_ROUTE_RESPONSE' });
  }
  const elevationGainMeters = providerAscent ?? elevation.gainMeters;
  const elevationLossMeters = providerDescent ?? elevation.lossMeters;
  const simplifiedCoordinates = downsample(rawCoordinates, MAX_ROUTE_POINTS)
    .map(([longitude, latitude, altitude]) => [latitude, longitude, altitude]);

  return {
    id: `ors-${seed}`,
    source: 'generated',
    provider: 'openrouteservice',
    surface: input.surface,
    targetDistanceMiles: Number(input.distanceMiles.toFixed(2)),
    distanceMiles: Number((distanceMeters / METERS_PER_MILE).toFixed(2)),
    durationMinutes: finiteNumber(summary.duration) ? Math.round(Number(summary.duration) / 60) : null,
    elevationGainMeters: Number(elevationGainMeters.toFixed(1)),
    elevationLossMeters: Number(elevationLossMeters.toFixed(1)),
    elevationGainFeet: Math.round(elevationGainMeters * FEET_PER_METER),
    elevationLossFeet: Math.round(elevationLossMeters * FEET_PER_METER),
    minElevationFeet: elevation.minElevationMeters === null ? null : Math.round(elevation.minElevationMeters * FEET_PER_METER),
    maxElevationFeet: elevation.maxElevationMeters === null ? null : Math.round(elevation.maxElevationMeters * FEET_PER_METER),
    coordinates: simplifiedCoordinates,
    elevationProfile: downsample(elevation.profile, 80),
  };
}

async function fetchCandidate(input, seed, apiKey, fetchImpl) {
  const request = providerRequest(input, seed);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(request.url, {
      method: 'POST',
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/geo+json, application/json',
      },
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch (err) {
      throw new RouteEngineError('The route provider returned an invalid response.', { status: 502, code: 'INVALID_ROUTE_RESPONSE' });
    }
    if (!response.ok) throw providerError(response.status, payload);
    return routeFromFeature(payload?.features?.[0], input, seed);
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new RouteEngineError('Route planning timed out. Try again.', { status: 504, code: 'ROUTE_TIMEOUT' });
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function cacheKey(input) {
  return [
    input.latitude.toFixed(4),
    input.longitude.toFixed(4),
    input.distanceMiles.toFixed(2),
    input.surface,
  ].join(':');
}

function readCache(key) {
  const cached = routeCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > ROUTE_CACHE_TTL_MS) {
    routeCache.delete(key);
    return null;
  }
  return cached.candidates;
}

function writeCache(key, candidates) {
  if (routeCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = routeCache.keys().next().value;
    routeCache.delete(oldestKey);
  }
  routeCache.set(key, { createdAt: Date.now(), candidates });
}

function chooseCandidate(candidates, preference) {
  const ordered = [...candidates].sort((a, b) => a.elevationGainFeet - b.elevationGainFeet);
  if (preference === 'flat') return ordered[0];
  if (preference === 'hilly') return ordered[ordered.length - 1];
  return ordered[Math.floor(ordered.length / 2)];
}

async function generateElevationAwareRoute(rawInput, options = {}) {
  const input = validateRouteInput(rawInput);
  const apiKey = options.apiKey ?? process.env.OPENROUTESERVICE_API_KEY;
  const fetchImpl = options.fetchImpl || fetch;
  if (!apiKey) {
    throw new RouteEngineError('Route planning is temporarily unavailable.', { status: 503, code: 'ROUTE_PROVIDER_NOT_CONFIGURED' });
  }

  const key = cacheKey(input);
  let candidates = options.skipCache ? null : readCache(key);
  if (!candidates) {
    const results = await Promise.allSettled(
      Array.from({ length: CANDIDATE_COUNT }, (_, index) => (
        fetchCandidate(input, deterministicSeed(input, index), apiKey, fetchImpl)
      )),
    );
    candidates = results.filter((result) => result.status === 'fulfilled').map((result) => result.value);
    if (!candidates.length) {
      const failure = results.find((result) => result.status === 'rejected')?.reason;
      throw failure instanceof RouteEngineError
        ? failure
        : new RouteEngineError('No route could be generated. Try again shortly.', { status: 503 });
    }
    writeCache(key, candidates);
  }

  const selected = chooseCandidate(candidates, input.elevationPreference);
  return {
    ...selected,
    elevationPreference: input.elevationPreference,
    alternativesEvaluated: candidates.length,
    distanceVariancePercent: Number((Math.abs(selected.distanceMiles - input.distanceMiles) / input.distanceMiles * 100).toFixed(1)),
    notice: 'Review crossings, access rules, and current conditions before starting. Map data can be incomplete.',
  };
}

function clearRouteCache() {
  routeCache.clear();
}

module.exports = {
  RouteEngineError,
  clearRouteCache,
  generateElevationAwareRoute,
  validateRouteInput,
};
