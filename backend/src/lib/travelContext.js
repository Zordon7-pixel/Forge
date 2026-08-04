// Private, deterministic travel-context inference from completed-run starts.
// Raw historical or current coordinates must never leave the authenticated
// route that calls this helper.

const EARTH_RADIUS_MILES = 3958.8;
const MIN_HISTORY_STARTS = 3;
const HOME_CLUSTER_RADIUS_MILES = 15;
const AWAY_THRESHOLD_MILES = 50;
const MAX_CURRENT_ACCURACY_METERS = 8046.72; // Five miles.
const MAX_INPUT_ACCURACY_METERS = 100000;
const MIN_DOMINANT_CLUSTER_RATIO = 0.6;
const MAX_HISTORY_ROWS = 100;
const MAX_ROUTE_BYTES = 256000;
const MAX_ROUTE_POINTS = 5000;

function response(status, confidence, distanceBand, reason) {
  return { status, confidence, distanceBand, reason };
}

function validISODate(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function validateTravelContextInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'A location object is required' };
  }
  const { latitude, longitude } = value;
  const accuracyMeters = value.accuracy_meters;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return { error: 'latitude must be a finite number between -90 and 90' };
  }
  if (typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return { error: 'longitude must be a finite number between -180 and 180' };
  }
  if (typeof accuracyMeters !== 'number' || !Number.isFinite(accuracyMeters)
    || accuracyMeters < 0 || accuracyMeters > MAX_INPUT_ACCURACY_METERS) {
    return { error: `accuracy_meters must be a finite number between 0 and ${MAX_INPUT_ACCURACY_METERS}` };
  }
  if (!validISODate(value.date)) {
    return { error: 'date must be a valid YYYY-MM-DD local date' };
  }
  return {
    value: {
      latitude,
      longitude,
      accuracyMeters,
      date: value.date,
    },
  };
}

function coordinate(value) {
  const latitude = Array.isArray(value) ? value[0] : value?.lat ?? value?.latitude;
  const longitude = Array.isArray(value) ? value[1] : value?.lon ?? value?.lng ?? value?.longitude;
  if (typeof latitude !== 'number' || !Number.isFinite(latitude) || latitude < -90 || latitude > 90
    || typeof longitude !== 'number' || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

function historicalRoute(value) {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_ROUTE_BYTES) return null;
    try {
      return historicalRoute(JSON.parse(value));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return null;
    }
  }
  if (!Array.isArray(value) || value.length < 2 || value.length > MAX_ROUTE_POINTS) return null;
  return value;
}

function historicalStart(row) {
  const route = historicalRoute(row?.route_coords ?? row);
  if (!route) return null;
  const start = coordinate(route[0]);
  const confirmingPoint = coordinate(route[1]);
  return start && confirmingPoint ? start : null;
}

function degreesToRadians(value) {
  return value * (Math.PI / 180);
}

function distanceMiles(left, right) {
  const lat1 = degreesToRadians(left.latitude);
  const lat2 = degreesToRadians(right.latitude);
  const deltaLat = lat2 - lat1;
  const deltaLon = degreesToRadians(right.longitude - left.longitude);
  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);
  const a = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;
  return EARTH_RADIUS_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(Math.max(0, 1 - a)));
}

function sphericalCentroid(points) {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const point of points) {
    const latitude = degreesToRadians(point.latitude);
    const longitude = degreesToRadians(point.longitude);
    x += Math.cos(latitude) * Math.cos(longitude);
    y += Math.cos(latitude) * Math.sin(longitude);
    z += Math.sin(latitude);
  }
  const longitude = Math.atan2(y, x);
  const hypotenuse = Math.sqrt((x * x) + (y * y));
  const latitude = Math.atan2(z, hypotenuse);
  return {
    latitude: latitude * (180 / Math.PI),
    longitude: longitude * (180 / Math.PI),
  };
}

function clusterKey(cluster) {
  return cluster.members
    .map((point) => `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`)
    .sort()
    .join('|');
}

function inferHomeAnchor(rows) {
  const starts = (Array.isArray(rows) ? rows : [])
    .slice(0, MAX_HISTORY_ROWS)
    .map(historicalStart)
    .filter(Boolean);
  if (starts.length < MIN_HISTORY_STARTS) {
    return { reason: 'insufficient_home_history' };
  }

  const candidates = starts.map((seed) => {
    const firstPass = starts.filter((point) => distanceMiles(seed, point) <= HOME_CLUSTER_RADIUS_MILES);
    const firstCentroid = sphericalCentroid(firstPass);
    const members = starts.filter((point) => distanceMiles(firstCentroid, point) <= HOME_CLUSTER_RADIUS_MILES);
    const anchor = sphericalCentroid(members);
    const radiusMiles = members.reduce((maximum, point) => Math.max(maximum, distanceMiles(anchor, point)), 0);
    return { anchor, members, radiusMiles };
  }).sort((left, right) => (
    right.members.length - left.members.length
    || left.radiusMiles - right.radiusMiles
    || clusterKey(left).localeCompare(clusterKey(right))
  ));

  const dominant = candidates[0];
  const ratio = dominant.members.length / starts.length;
  if (dominant.members.length < MIN_HISTORY_STARTS || ratio < MIN_DOMINANT_CLUSTER_RATIO
    || dominant.radiusMiles > HOME_CLUSTER_RADIUS_MILES) {
    return { reason: 'no_dominant_home_cluster' };
  }
  return {
    anchor: dominant.anchor,
    confidence: ratio >= 0.75 ? 'high' : 'moderate',
  };
}

function broadDistanceBand(miles) {
  if (miles <= HOME_CLUSTER_RADIUS_MILES) return 'within_15_miles';
  if (miles < AWAY_THRESHOLD_MILES) return '15_to_50_miles';
  if (miles < 150) return '50_to_150_miles';
  return 'over_150_miles';
}

function classifyTravelContext(current, rows) {
  if (current.accuracyMeters > MAX_CURRENT_ACCURACY_METERS) {
    return response('unknown', 'none', 'unknown', 'poor_current_accuracy');
  }

  const inferred = inferHomeAnchor(rows);
  if (!inferred.anchor) {
    return response('unknown', 'none', 'unknown', inferred.reason);
  }

  const currentPoint = { latitude: current.latitude, longitude: current.longitude };
  const distance = distanceMiles(currentPoint, inferred.anchor);
  const accuracyMiles = current.accuracyMeters / 1609.344;
  const lowerBound = Math.max(0, distance - accuracyMiles);
  const upperBound = distance + accuracyMiles;
  const band = broadDistanceBand(distance);

  if (upperBound <= HOME_CLUSTER_RADIUS_MILES) {
    return response('home', inferred.confidence, band, 'within_home_training_area');
  }
  if (lowerBound >= AWAY_THRESHOLD_MILES) {
    return response('away', inferred.confidence, band, 'confirmed_away_from_home');
  }
  return response('unknown', 'low', band, 'between_home_and_away_thresholds');
}

module.exports = {
  AWAY_THRESHOLD_MILES,
  HOME_CLUSTER_RADIUS_MILES,
  MAX_CURRENT_ACCURACY_METERS,
  MAX_HISTORY_ROWS,
  MAX_ROUTE_BYTES,
  MIN_HISTORY_STARTS,
  classifyTravelContext,
  distanceMiles,
  historicalStart,
  inferHomeAnchor,
  validateTravelContextInput,
};
