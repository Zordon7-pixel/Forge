const MAX_ROUTE_POINTS = 5000;
const MAX_DISTANCE_MILES = 500;
const DISTANCE_EQUIVALENCE_TOLERANCE_MILES = 0.001;
const DISTANCE_UNIT_TO_MILES = Object.freeze({
  mi: 1,
  mile: 1,
  miles: 1,
  km: 1 / 1.609344,
  kilometer: 1 / 1.609344,
  kilometers: 1 / 1.609344,
  kilometre: 1 / 1.609344,
  kilometres: 1 / 1.609344,
  m: 1 / 1609.344,
  meter: 1 / 1609.344,
  meters: 1 / 1609.344,
  metre: 1 / 1609.344,
  metres: 1 / 1609.344,
});
const RUN_FEEDBACK_INPUT_FIELDS = new Set([
  'distance_miles',
  'duration_seconds',
  'notes',
  'perceived_effort',
  'type',
  'pain_level',
  'post_energy',
]);

function boundedString(value, maxLength) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).replace(/[\r\n]+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function boundedNumber(value, minimum, maximum) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function normalizePlanSessionId(value) {
  return boundedString(value, 160);
}

function normalizeTextList(value, maximumItems = 20) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maximumItems)
    .map((item) => boundedString(typeof item === 'string' ? item : item?.description || item?.label, 240))
    .filter(Boolean);
}

function normalizePlannedSession(value, fallbackSessionId = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value.date || '')) ? String(value.date) : null;
  const snapshot = {
    schemaVersion: 1,
    sessionId: normalizePlanSessionId(value.sessionId || value.id || fallbackSessionId),
    date,
    title: boundedString(value.title, 120),
    type: boundedString(value.type, 40),
    workoutType: boundedString(value.workoutType || value.workout_type, 40),
    prescriptionBasis: boundedString(value.prescriptionBasis || value.prescription_basis, 30),
    distanceMiles: boundedNumber(value.distanceMiles ?? value.distance_miles ?? value.distance, 0, 500),
    durationMinutes: boundedNumber(value.durationMinutes ?? value.duration_min ?? value.duration_minutes, 0, 1440),
    paceTarget: boundedString(value.paceTarget || value.pace_target || value.pace, 100),
    targetZone: boundedString(value.targetZone || value.target_zone || value.zone, 40),
    intensity: boundedString(value.intensity, 80),
    warmup: normalizeTextList(value.warmup),
    steps: normalizeTextList(value.steps || value.structure),
    cooldown: normalizeTextList(value.cooldown),
  };

  const hasPrescription = Object.entries(snapshot).some(([key, item]) => (
    key !== 'schemaVersion'
    && item !== null
    && item !== undefined
    && (!Array.isArray(item) || item.length > 0)
  ));
  return hasPrescription ? snapshot : null;
}

function normalizeTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value))) {
    let millis = Number(value);
    if (!Number.isFinite(millis)) return null;
    if (millis < 10_000_000_000) millis *= 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function downsampleRouteCoords(points) {
  if (points.length <= MAX_ROUTE_POINTS) return points;
  return Array.from({ length: MAX_ROUTE_POINTS }, (_, index) => {
    const sourceIndex = Math.round((index * (points.length - 1)) / (MAX_ROUTE_POINTS - 1));
    return points[sourceIndex];
  });
}

// Keep this closed wire contract aligned with gpsTrace.js (cross-runtime tests compare both).
const GAP_REASONS = ['timeout', 'foreground', 'background', 'restore', 'manual-pause', 'auto-resume', 'auto-pause-disabled', 'unknown']
function normalizeGapReason(value) { return GAP_REASONS.includes(value) ? value : 'unknown' }
function normalizeGpsSource(value) { return ['native_bg', 'web_fallback'].includes(value) ? value : null }
function normalizeBackgroundRefreshStatus(value) {
  return ['available', 'denied', 'restricted', 'unknown', 'error', 'unavailable'].includes(value) ? value : 'unknown'
}
function phoneRunDiagnostics(value = {}) {
  return { gps_source: normalizeGpsSource(value.gps_source), backgroundRefreshStatus: normalizeBackgroundRefreshStatus(value.backgroundRefreshStatus) }
}
function normalizeSegmentedRoute(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { return null } }
  if (!value || value.version !== 2 || !Array.isArray(value.segments) || value.segments.length > 100000) return null
  let count = 0
  const segments = []
  for (const [index, segment] of value.segments.entries()) {
    if (!Array.isArray(segment?.points) || !segment.points.length) return null
    const points = []
    for (const point of segment.points) {
      if (++count > 100000 || !Number.isFinite(point?.lat) || Math.abs(point.lat) > 90 || !Number.isFinite(point?.lon) || Math.abs(point.lon) > 180) return null
      const optional = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : null
      const time = typeof point.time === 'number' ? point.time : typeof point.time === 'string' && point.time.length <= 40 ? Date.parse(point.time) : NaN
      points.push({ lat: point.lat, lon: point.lon, alt: optional(point.alt, -2000, 100000),
        time: Number.isFinite(time) && Math.abs(time) <= 8640000000000000 ? time : null, accuracy: optional(point.accuracy, 0, 10000) })
    }
    segments.push({ gap: index ? { kind: 'gps-gap', reason: normalizeGapReason(segment.gap?.reason) } : null, points })
  }
  return { version: 2, segments }
}

function normalizeRouteCoords(value) {
  if (value && !Array.isArray(value) && typeof value === 'object') {
    const route = normalizeSegmentedRoute(value);
    if (!route) { const error = new Error('Invalid segmented phone route'); error.status = 400; throw error; }
    return route;
  }
  if (!Array.isArray(value)) return [];
  const points = value.map((raw) => {
    const lat = Number(Array.isArray(raw) ? raw[0] : raw?.lat);
    const lon = Number(Array.isArray(raw) ? raw[1] : raw?.lon ?? raw?.lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) return null;
    const rawAltitude = Array.isArray(raw) ? raw[2] : raw?.alt ?? raw?.altitude;
    const altitude = boundedNumber(rawAltitude, -2000, 100000);
    const time = normalizeTimestamp(Array.isArray(raw) ? raw[3] : raw?.time ?? raw?.timestamp);
    const rawAccuracy = Array.isArray(raw) ? raw[4] : raw?.accuracy ?? raw?.horizontalAccuracy ?? raw?.horizontal_accuracy;
    const accuracy = boundedNumber(rawAccuracy, 0, 10000);
    return {
      lat,
      lon,
      alt: altitude,
      ...(time ? { time } : {}),
      ...(accuracy !== null ? { accuracy } : {}),
    };
  }).filter(Boolean);
  return downsampleRouteCoords(points);
}

function normalizeDistanceEvidence(candidates = []) {
  const supplied = Array.isArray(candidates) ? candidates : [];
  if (supplied.length === 0) {
    return { miles: null, unit: 'miles', source: null };
  }

  const normalized = [];
  for (const candidate of supplied) {
    const unit = String(candidate?.unit || '').trim().toLowerCase();
    const factor = DISTANCE_UNIT_TO_MILES[unit];
    const source = boundedString(candidate?.source, 80);
    const value = Number(candidate?.value);
    if (!factor) return { error: `Unsupported distance unit: ${unit || 'missing'}` };
    if (!source) return { error: 'Distance evidence source is required' };
    if (!Number.isFinite(value) || value < 0) return { error: 'Distance evidence must be a non-negative finite number' };
    const miles = value * factor;
    if (!Number.isFinite(miles) || miles > MAX_DISTANCE_MILES) {
      return { error: `Distance evidence must not exceed ${MAX_DISTANCE_MILES} miles` };
    }
    normalized.push({ miles, source });
  }

  const canonical = normalized[0];
  const conflicting = normalized.some((candidate) => (
    Math.abs(candidate.miles - canonical.miles) > DISTANCE_EQUIVALENCE_TOLERANCE_MILES
  ));
  if (conflicting) return { error: 'Conflicting distance evidence' };

  return {
    miles: Number(canonical.miles.toFixed(6)),
    unit: 'miles',
    source: canonical.source,
  };
}

function classifyRouteIntegrity({ routeCoords = [], materialGap = false, coverageIncomplete = false } = {}) {
  const normalized = normalizeRouteCoords(routeCoords);
  const segmented = !Array.isArray(normalized);
  const pointCount = segmented ? normalized.segments.reduce((sum, segment) => sum + segment.points.length, 0) : normalized.length;
  materialGap ||= segmented && normalized.segments.length > 1;
  if (pointCount === 0) {
    return { status: 'missing', pointCount, reason: 'no_valid_route_points' };
  }
  if (pointCount === 1) {
    return { status: 'insufficient', pointCount, reason: 'one_valid_route_point' };
  }
  if (materialGap === true || coverageIncomplete === true) {
    return { status: 'partial', pointCount, reason: 'known_incomplete_coverage' };
  }
  return { status: 'complete', pointCount, reason: 'valid_recording_no_known_material_gaps' };
}

function normalizePostRunCheckIn(value = {}) {
  const effort = Number(value.perceived_effort);
  const pain = String(value.pain_level || '');
  const energy = value.post_energy === undefined || value.post_energy === null || value.post_energy === ''
    ? null
    : String(value.post_energy);
  if (!Number.isInteger(effort) || effort < 1 || effort > 10) {
    return { error: 'perceived_effort must be an integer between 1 and 10' };
  }
  if (!['none', 'mild', 'moderate', 'severe'].includes(pain)) {
    return { error: 'Invalid pain_level' };
  }
  if (energy !== null && !['low', 'medium', 'high'].includes(energy)) {
    return { error: 'Invalid post_energy' };
  }
  return { value: { perceived_effort: effort, pain_level: pain, post_energy: energy } };
}

function shouldInvalidateRunFeedback(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).some((field) => RUN_FEEDBACK_INPUT_FIELDS.has(field));
}

module.exports = {
  MAX_ROUTE_POINTS,
  phoneRunDiagnostics,
  normalizeSegmentedRoute,
  classifyRouteIntegrity,
  normalizeDistanceEvidence,
  normalizePlanSessionId,
  normalizePlannedSession,
  normalizePostRunCheckIn,
  normalizeRouteCoords,
  shouldInvalidateRunFeedback,
};
