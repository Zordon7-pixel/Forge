const { normalizeRouteCoords } = require('./runPostRun');

const MAX_BYTES = 1024 * 1024;
const MAX_POINTS = 10000;
const MAX_WAYPOINTS = 100;
const FIELDS = ['name', 'waypoints', 'geometry', 'legs', 'distanceMeters', 'targetDistanceMeters', 'elevation', 'display'];
class UserRouteError extends Error {
  constructor(code = 'INVALID_USER_ROUTE', status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}
const invalid = () => { throw new UserRouteError(); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keys = (v, allowed) => object(v) && Object.keys(v).every(k => allowed.includes(k));
const bounded = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const optionalNumber = (v, min, max) => {
  if (v === undefined || v === null) return null;
  if (!bounded(v, min, max)) invalid();
  return v;
};
function text(value, max) {
  // XML 1.0 characters only; reject controls and unpaired surrogates.
  if (typeof value !== 'string' || value.length > max
    || /[^\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(value)) invalid();
  return value.trim();
}
function point(raw, elevationAllowed) {
  if (!Array.isArray(raw) || (raw.length !== 2 && !(elevationAllowed && raw.length === 3))
    || !bounded(raw[0], -180, 180) || !bounded(raw[1], -90, 90)) invalid();
  if (raw.length === 3 && raw[2] !== null && !bounded(raw[2], -2000, 100000)) invalid();
  // Reuse the recorded coordinate normalizer only as a point primitive.
  // Strict checks above prevent coercion; one point at a time avoids its
  // recorded-run downsampling and retains every planned geometry vertex.
  const normalized = normalizeRouteCoords([[raw[1], raw[0], raw[2]]])[0];
  return raw.length === 3 ? [normalized.lon, normalized.lat, normalized.alt] : [normalized.lon, normalized.lat];
}
function validateRoute(value) {
  if (!keys(value, FIELDS) || Buffer.byteLength(JSON.stringify(value)) > MAX_BYTES) invalid();
  const name = text(value.name, 120);
  if (!name || !Array.isArray(value.waypoints) || value.waypoints.length < 2
    || value.waypoints.length > MAX_WAYPOINTS) invalid();
  const waypoints = value.waypoints.map(p => point(p, false));
  if (!keys(value.geometry, ['type', 'coordinates']) || value.geometry.type !== 'LineString'
    || !Array.isArray(value.geometry.coordinates) || value.geometry.coordinates.length < 2
    || value.geometry.coordinates.length > MAX_POINTS) invalid();
  const coordinates = value.geometry.coordinates.map(p => point(p, true));
  if (!Array.isArray(value.legs) || value.legs.length !== waypoints.length - 1) invalid();
  let previousEnd = 0;
  const legs = value.legs.map(leg => {
    if (!keys(leg, ['mode', 'provenance', 'profile', 'startIndex', 'endIndex', 'distanceMeters', 'distanceSource'])
      || !Number.isInteger(leg.startIndex) || !Number.isInteger(leg.endIndex)
      || leg.startIndex !== previousEnd || leg.endIndex <= leg.startIndex
      || leg.endIndex >= coordinates.length) invalid();
    const routed = leg.mode === 'routed' && leg.provenance === 'ors'
      && ['foot-walking', 'foot-hiking'].includes(leg.profile);
    const straight = leg.mode === 'straight' && leg.provenance === 'manual'
      && leg.profile === null && leg.endIndex === leg.startIndex + 1;
    if (!routed && !straight) invalid();
    const hasDistance = Object.hasOwn(leg, 'distanceMeters');
    if (hasDistance !== Object.hasOwn(leg, 'distanceSource')
      || (hasDistance && (!bounded(leg.distanceMeters, 0, 1000000)
        || !(leg.distanceSource === 'saved_total_remainder'
          || routed && leg.distanceSource === 'ors'
          || straight && leg.distanceSource === 'geometry')))) invalid();
    previousEnd = leg.endIndex;
    return { mode: leg.mode, provenance: leg.provenance, profile: leg.profile,
      startIndex: leg.startIndex, endIndex: leg.endIndex,
      ...(hasDistance ? { distanceMeters: leg.distanceMeters, distanceSource: leg.distanceSource } : {}) };
  });
  if (previousEnd !== coordinates.length - 1 || !bounded(value.distanceMeters, 0, 1000000)) invalid();
  // Additive fields live in legs_json; legacy rows remain readable unchanged.
  if (legs.every(leg => Object.hasOwn(leg, 'distanceMeters'))
    && Math.abs(legs.reduce((sum, leg) => sum + leg.distanceMeters, 0) - value.distanceMeters) > 0.000001) invalid();
  const targetDistanceMeters = optionalNumber(value.targetDistanceMeters, 0, 1000000);
  const suppliedElevation = value.elevation ?? {};
  if (!keys(suppliedElevation, ['source', 'gainMeters', 'lossMeters', 'coverage'])) invalid();
  const source = suppliedElevation.source ?? null;
  if (![null, 'manual', 'imported', 'provider'].includes(source)) invalid();
  const gainMeters = optionalNumber(suppliedElevation.gainMeters, 0, 1000000);
  const lossMeters = optionalNumber(suppliedElevation.lossMeters, 0, 1000000);
  const known = coordinates.filter(p => p.length === 3 && p[2] !== null).length;
  const coverage = known === 0 ? 'missing' : known === coordinates.length ? 'complete' : 'partial';
  if (suppliedElevation.coverage !== undefined && suppliedElevation.coverage !== coverage) invalid();
  if ((known > 0 || gainMeters !== null || lossMeters !== null) && source === null) invalid();
  const suppliedDisplay = value.display ?? {};
  if (!keys(suppliedDisplay, ['description', 'surface', 'elevationPreference'])) invalid();
  const description = suppliedDisplay.description == null ? null : text(suppliedDisplay.description, 500) || null;
  const surface = suppliedDisplay.surface ?? null;
  const elevationPreference = suppliedDisplay.elevationPreference ?? null;
  if (![null, 'road', 'trail', 'mixed'].includes(surface)
    || ![null, 'flat', 'balanced', 'hilly'].includes(elevationPreference)) invalid();
  return { name, waypoints, geometry: { type: 'LineString', coordinates }, legs,
    distanceMeters: value.distanceMeters, targetDistanceMeters,
    elevation: { source, coverage, gainMeters, lossMeters },
    display: { description, surface, elevationPreference } };
}
function routeId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid();
  return value.toLowerCase();
}
function pagination(query) {
  if (!keys(query, ['limit', 'offset'])) invalid();
  const number = (value, fallback, min, max) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !/^(0|[1-9]\d{0,6})$/.test(value)) invalid();
    const n = Number(value);
    if (n < min || n > max) invalid();
    return n;
  };
  return { limit: number(query.limit, 20, 1, 100), offset: number(query.offset, 0, 0, 1000000) };
}
const escapeXml = value => value.replace(/[<>&"']/g, c => ({
  '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;',
}[c]));
function toGpx(route) {
  const straight = route.legs?.some(leg => leg.mode === 'straight') === true;
  const points = route.geometry.coordinates.map(([lon, lat, altitude]) => (
    `      <trkpt lat="${lat}" lon="${lon}">${bounded(altitude, -2000, 100000) ? `<ele>${altitude}</ele>` : ''}</trkpt>`
  ));
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Forged Hybrid" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${escapeXml(route.name)}</name>
    <desc>Planned route; not a recorded activity.${straight ? ' Includes explicitly planned straight-line segments.' : ''} Leg modes and provenance remain in the saved route.</desc>
    <trkseg>
${points.join('\n')}
    </trkseg>
  </trk>
</gpx>
`;
}
module.exports = { MAX_BYTES, MAX_POINTS, MAX_WAYPOINTS, UserRouteError, validateRoute, routeId, pagination, toGpx };
