const MAX_ROUTE_POINTS = 5000;
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

function normalizeRouteCoords(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_ROUTE_POINTS).map((raw) => {
    const lat = Number(Array.isArray(raw) ? raw[0] : raw?.lat);
    const lon = Number(Array.isArray(raw) ? raw[1] : raw?.lon ?? raw?.lng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) return null;
    const rawAltitude = Array.isArray(raw) ? raw[2] : raw?.alt ?? raw?.altitude;
    const altitude = boundedNumber(rawAltitude, -2000, 100000);
    const time = normalizeTimestamp(Array.isArray(raw) ? raw[3] : raw?.time ?? raw?.timestamp);
    return {
      lat,
      lon,
      alt: altitude,
      ...(time ? { time } : {}),
    };
  }).filter(Boolean);
}

function normalizePostRunCheckIn(value = {}) {
  const effort = Number(value.perceived_effort);
  const pain = String(value.pain_level || '');
  const energy = String(value.post_energy || '');
  if (!Number.isInteger(effort) || effort < 1 || effort > 10) {
    return { error: 'perceived_effort must be an integer between 1 and 10' };
  }
  if (!['none', 'mild', 'moderate', 'severe'].includes(pain)) {
    return { error: 'Invalid pain_level' };
  }
  if (!['low', 'medium', 'high'].includes(energy)) {
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
  normalizePlanSessionId,
  normalizePlannedSession,
  normalizePostRunCheckIn,
  normalizeRouteCoords,
  shouldInvalidateRunFeedback,
};
