// H7 Race Course Intelligence and Provenance — pure domain module.
//
// Responsibilities (no DB, no network, deterministic):
//  - Normalize race aliases/names and resolve a selected race to a canonical
//    event + dated edition using exact catalog id first, then an unambiguous
//    normalized-name + edition/date/distance match. Never guess a nearest race.
//  - Model provenance, confidence, freshness, and correction history inside the
//    existing course_profile_json envelope while keeping legacy profile JSON
//    readable.
//  - Gate course facts: only trusted, current structured facts are usable by
//    training logic. Stale / unknown / ambiguous facts fall back to distance
//    only.
//  - Analyze user GPX deterministically without ever persisting or returning raw
//    coordinates or precise start/end points.
//  - Validate the H7 non-race goal taxonomy.

// xml2js is required lazily inside analyzeGpx so this pure module loads for all
// non-GPX callers (resolution, trust, seed, plan integration) even in
// environments where optional deps are not yet installed.

const ENVELOPE_VERSION = 1;

const PROVENANCE_KINDS = ['official', 'licensed', 'curated', 'user_gpx', 'unknown'];
const TRUSTED_PROVENANCE = new Set(['official', 'licensed', 'curated', 'user_gpx']);

// Course-intelligence display states (one honest state per race).
const COURSE_STATES = {
  VERIFIED: 'verified',      // official / licensed structured facts
  CURATED: 'curated',        // curated structured facts
  USER_GPX: 'user_gpx',      // user-uploaded GPX derived facts
  STALE: 'stale',            // facts exist but are stale / wrong edition
  DISTANCE_ONLY: 'distance_only', // no trusted structured course data
};

const STATE_LABELS = {
  verified: 'Verified course',
  curated: 'Curated course',
  user_gpx: 'User GPX',
  stale: 'Course details stale',
  distance_only: 'Distance only',
};

// H7 goal taxonomy. `race` is the proven loop; the rest are the non-race kinds.
const GOAL_KINDS = [
  'race',
  'distance_pr',
  'beginner_first_run',
  'weight_loss',
  'general_fitness',
  'hybrid_performance',
  'run_for_enjoyment',
];

// Facts older than this (relative to freshness.asOf) are considered stale and
// therefore untrusted for training logic.
const DEFAULT_STALE_AFTER_DAYS = 400;

// GPX bounds — strict, privacy-first, and deterministic.
const GPX_MAX_BYTES = 2 * 1024 * 1024; // 2 MB
const GPX_MAX_POINTS = 60000;
const GPX_MIN_POINTS = 10;
const ELEV_NOISE_FT = 10; // ignore cumulative gains below this threshold (noise)
const TERRAIN_KINDS = new Set(['road', 'trail', 'track', 'mixed']);
const CATALOG_DISTANCE_TOLERANCE_MILES = 0.2;
const LAT_MIN = -90;
const LAT_MAX = 90;
const LNG_MIN = -180;
const LNG_MAX = 180;
const ELEV_MIN_M = -500;
const ELEV_MAX_M = 9000;

function numberOrNull(value) {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Name normalization + alias handling
// ---------------------------------------------------------------------------

// Deterministic alias map. Keys and values are normalized forms. Only safe,
// well-known aliases for catalog events already present in the repo.
const NAME_ALIASES = {
  'army ten miler': 'army 10 miler',
  'army 10 miler': 'army 10 miler',
  'army tenmiler': 'army 10 miler',
  atm: 'army 10 miler',
  'the army ten miler': 'army 10 miler',
};

function normalizeRaceName(name) {
  if (name === null || name === undefined) return '';
  const cleaned = String(name)
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, '-') // unicode dashes -> hyphen
    .replace(/[^a-z0-9]+/g, ' ') // strip punctuation to spaces
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  if (Object.prototype.hasOwnProperty.call(NAME_ALIASES, cleaned)) {
    return NAME_ALIASES[cleaned];
  }
  return cleaned;
}

function normalizeRaceLocation(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(united states of america|united states|usa|us)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b([a-z])\s+([a-z])\b/g, '$1$2')
    .trim();
}

function catalogLocation(row = {}) {
  return normalizeRaceLocation([row.city, row.state, row.country].filter(Boolean).join(' '));
}

function locationMatches(row, requestedLocation) {
  const target = normalizeRaceLocation(requestedLocation);
  if (!target) return true;
  const candidate = catalogLocation(row);
  if (!candidate) return false;
  return candidate === target || candidate.includes(target) || target.includes(candidate);
}

// Canonical event id: strip a trailing ISO date from a catalog id so multiple
// dated editions share one canonical event family.
function canonicalEventIdFromCatalogId(catalogId) {
  if (!catalogId) return null;
  return String(catalogId).replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

function editionYear(dateISO) {
  if (!dateISO || typeof dateISO !== 'string') return null;
  const match = /^(\d{4})-\d{2}-\d{2}$/.exec(dateISO.trim());
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Catalog resolution
// ---------------------------------------------------------------------------

// Resolve a selected race against the catalog.
// Returns { status: 'resolved'|'ambiguous'|'unknown', race, reason, candidates }.
// - Exact id match wins immediately.
// - Otherwise match by normalized name. If multiple editions match, require an
//   unambiguous edition disambiguator (exact date, else year, else distance).
// - Never silently pick a nearest race or a different edition.
function resolveCatalogRace({ catalog, id, name, date, distanceMiles, location } = {}) {
  const rows = Array.isArray(catalog) ? catalog : [];

  if (id) {
    const exact = rows.find((row) => String(row.id) === String(id));
    if (exact) return { status: 'resolved', race: exact, reason: 'exact_id', candidates: [exact] };
    return { status: 'unknown', race: null, reason: 'id_not_found', candidates: [] };
  }

  const targetName = normalizeRaceName(name);
  if (!targetName) return { status: 'unknown', race: null, reason: 'no_name', candidates: [] };

  const hasDistance = distanceMiles !== undefined && distanceMiles !== null && distanceMiles !== '';
  const targetDistance = hasDistance ? numberOrNull(distanceMiles) : null;
  if (hasDistance && (targetDistance === null || targetDistance <= 0)) {
    return { status: 'unknown', race: null, reason: 'invalid_distance', candidates: [] };
  }

  const nameMatches = rows.filter((row) => normalizeRaceName(row.name) === targetName);
  if (nameMatches.length === 0) {
    return { status: 'unknown', race: null, reason: 'no_name_match', candidates: [] };
  }
  // Apply every supplied discriminator before resolving. A full date must match
  // exactly; a same-year-but-different-day event is a different edition.
  let pool = nameMatches;
  if (date) {
    const exactDate = pool.filter((row) => String(row.race_date) === String(date));
    if (exactDate.length === 0) return { status: 'unknown', race: null, reason: 'edition_date_mismatch', candidates: nameMatches };
    pool = exactDate;
  }
  if (normalizeRaceLocation(location)) {
    const locationMatchesRows = pool.filter((row) => locationMatches(row, location));
    if (locationMatchesRows.length === 0) return { status: 'unknown', race: null, reason: 'location_mismatch', candidates: pool };
    pool = locationMatchesRows;
  }
  if (hasDistance) {
    const distMatches = pool.filter((row) => {
      const rowDistance = numberOrNull(row.distance_miles);
      return rowDistance !== null && Math.abs(rowDistance - targetDistance) <= CATALOG_DISTANCE_TOLERANCE_MILES;
    });
    if (distMatches.length === 0) return { status: 'unknown', race: null, reason: 'distance_mismatch', candidates: pool };
    pool = distMatches;
  }
  if (pool.length === 1) {
    const reason = date ? 'name_and_date' : normalizeRaceLocation(location) ? 'name_and_location' : hasDistance ? 'name_and_distance' : 'unique_name';
    return { status: 'resolved', race: pool[0], reason, candidates: pool };
  }
  return { status: 'ambiguous', race: null, reason: 'multiple_editions', candidates: pool };
}

// ---------------------------------------------------------------------------
// Course fact envelope (stored inside course_profile_json)
// ---------------------------------------------------------------------------

function fact(value, { source, provenance, confidence, asOf } = {}) {
  if (value === null || value === undefined || value === '') return null;
  return {
    value,
    source: source || null,
    provenance: provenance || 'unknown',
    confidence: confidence || 'low',
    asOf: asOf || null,
  };
}

// Build a curated envelope from a structured catalog row. Uses only facts that
// already exist in the catalog. Never upgrades to `official` on the basis of an
// organizer URL alone.
function buildCatalogCourseEnvelope(catalogRace = {}, { asOf, provenance } = {}) {
  const stamp = asOf || null;
  const editionId = catalogRace.id || null;
  const editionDate = catalogRace.race_date || null;
  const kind = PROVENANCE_KINDS.includes(provenance) ? provenance : 'curated';
  const source = catalogRace.source || null;
  const url = catalogRace.url || null;
  const facts = {};
  const elevation = fact(numberOrNull(catalogRace.elevation_gain_ft), { source, provenance: kind, confidence: 'medium', asOf: stamp });
  const altitude = fact(numberOrNull(catalogRace.max_altitude_ft), { source, provenance: kind, confidence: 'medium', asOf: stamp });
  const terrainValue = TERRAIN_KINDS.has(String(catalogRace.terrain || '').toLowerCase())
    ? String(catalogRace.terrain).toLowerCase()
    : null;
  const terrain = fact(terrainValue, { source, provenance: kind, confidence: 'medium', asOf: stamp });
  if (elevation) facts.elevationGainFt = elevation;
  if (altitude) facts.maxAltitudeFt = altitude;
  if (terrain) facts.terrain = terrain;

  return {
    envelopeVersion: ENVELOPE_VERSION,
    canonicalEventId: canonicalEventIdFromCatalogId(editionId),
    editionId,
    editionDate,
    courseVersion: editionYear(editionDate),
    provenance: kind,
    source,
    url,
    facts,
    freshness: { asOf: stamp, staleAfterDays: DEFAULT_STALE_AFTER_DAYS },
    corrections: [],
    privacy: { containsUserGps: false },
  };
}

// Read whatever is stored in course_profile_json. Returns a normalized envelope
// when the stored value is an H7 envelope, otherwise { legacy: <original> } so
// old profile JSON stays readable. Returns null for empty values.
function readCourseEnvelope(stored) {
  if (stored === null || stored === undefined || stored === '') return null;
  let parsed = stored;
  if (typeof stored === 'string') {
    try {
      parsed = JSON.parse(stored);
    } catch {
      return { legacy: String(stored).slice(0, 2000) };
    }
  }
  if (isPlainObject(parsed) && Number(parsed.envelopeVersion) === ENVELOPE_VERSION) {
    return parsed;
  }
  return { legacy: parsed };
}

function isEnvelope(value) {
  return isPlainObject(value) && Number(value.envelopeVersion) === ENVELOPE_VERSION;
}

function daysBetween(aISO, bISO) {
  const a = Date.parse(aISO);
  const b = Date.parse(bISO);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / (1000 * 60 * 60 * 24);
}

// Evaluate whether course facts may be trusted for training logic.
// Returns { trusted, state, label, provenance, facts, reasons }.
// `facts` (elevationGainFt/maxAltitudeFt/terrain) are only populated when
// trusted; otherwise the caller must fall back to distance-only behavior.
function evaluateCourseTrust({ envelope, looseFacts, raceDate, provenance, nowISO } = {}) {
  const now = nowISO || new Date().toISOString();
  const reasons = [];

  let env = null;
  if (isEnvelope(envelope)) env = envelope;
  else if (isEnvelope(readCourseEnvelope(envelope))) env = readCourseEnvelope(envelope);

  // Determine provenance.
  let kind = 'unknown';
  if (env && PROVENANCE_KINDS.includes(env.provenance)) kind = env.provenance;
  else if (PROVENANCE_KINDS.includes(provenance)) kind = provenance;
  const looseHasFacts = !env && hasAnyLooseFact(looseFacts);
  const legacyStructured = looseHasFacts && (
    (looseFacts && (looseFacts.source || looseFacts.url))
    || TRUSTED_PROVENANCE.has(kind)
  );
  if (legacyStructured) {
    // Legacy rows have no review timestamp or edition-bound provenance. Surface
    // them as stale until the seed/migration or a user GPX creates an envelope.
    if (kind === 'unknown') kind = 'curated';
    reasons.push('legacy_curated_inference');
  }

  const rawFacts = env ? factsFromEnvelope(env) : factsFromLoose(looseFacts);
  const hasFacts = rawFacts && (rawFacts.elevationGainFt !== null || rawFacts.maxAltitudeFt !== null || (rawFacts.terrain !== null && rawFacts.terrain !== undefined));

  if (!hasFacts || !TRUSTED_PROVENANCE.has(kind)) {
    reasons.push(!hasFacts ? 'no_structured_facts' : `untrusted_provenance:${kind}`);
    return { trusted: false, state: COURSE_STATES.DISTANCE_ONLY, label: STATE_LABELS.distance_only, provenance: kind, facts: {}, reasons };
  }

  if (legacyStructured) {
    reasons.push('missing_freshness');
    return { trusted: false, state: COURSE_STATES.STALE, label: STATE_LABELS.stale, provenance: kind, facts: {}, reasons };
  }

  // Edition / freshness gating.
  if (env) {
    if (env.editionDate && raceDate && String(env.editionDate) !== String(raceDate)) {
      reasons.push('edition_date_mismatch');
      return { trusted: false, state: COURSE_STATES.STALE, label: STATE_LABELS.stale, provenance: kind, facts: {}, reasons };
    }
    const asOf = env.freshness && env.freshness.asOf;
    const staleAfter = Number(env.freshness && env.freshness.staleAfterDays) || DEFAULT_STALE_AFTER_DAYS;
    if (!asOf) {
      reasons.push('missing_freshness');
      return { trusted: false, state: COURSE_STATES.STALE, label: STATE_LABELS.stale, provenance: kind, facts: {}, reasons };
    }
    const age = daysBetween(asOf, now);
    if (age === null || age < -1 || age > staleAfter) {
      reasons.push(age === null ? 'invalid_freshness' : age < -1 ? 'future_freshness' : 'facts_stale');
      return { trusted: false, state: COURSE_STATES.STALE, label: STATE_LABELS.stale, provenance: kind, facts: {}, reasons };
    }
  }

  let state = COURSE_STATES.CURATED;
  if (kind === 'official' || kind === 'licensed') state = COURSE_STATES.VERIFIED;
  else if (kind === 'user_gpx') state = COURSE_STATES.USER_GPX;

  const facts = {};
  if (rawFacts.elevationGainFt !== null) facts.elevationGainFt = rawFacts.elevationGainFt;
  if (rawFacts.maxAltitudeFt !== null) facts.maxAltitudeFt = rawFacts.maxAltitudeFt;
  if (rawFacts.terrain !== null && rawFacts.terrain !== undefined) facts.terrain = rawFacts.terrain;

  return { trusted: true, state, label: STATE_LABELS[state], provenance: kind, facts, reasons };
}

function hasAnyLooseFact(looseFacts = {}) {
  return (
    numberOrNull(looseFacts.elevationGainFt) !== null
    || numberOrNull(looseFacts.maxAltitudeFt) !== null
    || (looseFacts.terrain !== null && looseFacts.terrain !== undefined && looseFacts.terrain !== '')
  );
}

function factsFromEnvelope(env) {
  const facts = env && env.facts ? env.facts : {};
  const readTrustedFact = (entry, type) => {
    if (!isPlainObject(entry)) return null;
    if (!TRUSTED_PROVENANCE.has(entry.provenance)) return null;
    if (!['medium', 'high'].includes(String(entry.confidence || '').toLowerCase())) return null;
    if (type === 'terrain') {
      const value = String(entry.value || '').toLowerCase();
      return TERRAIN_KINDS.has(value) ? value : null;
    }
    const value = numberOrNull(entry.value);
    if (value === null) return null;
    if (type === 'elevation' && (value < 0 || value > 100000)) return null;
    if (type === 'altitude' && (value < -2000 || value > 30000)) return null;
    return value;
  };
  return {
    elevationGainFt: readTrustedFact(facts.elevationGainFt, 'elevation'),
    maxAltitudeFt: readTrustedFact(facts.maxAltitudeFt, 'altitude'),
    terrain: readTrustedFact(facts.terrain, 'terrain'),
  };
}

function factsFromLoose(looseFacts = {}) {
  return {
    elevationGainFt: numberOrNull(looseFacts.elevationGainFt),
    maxAltitudeFt: numberOrNull(looseFacts.maxAltitudeFt),
    terrain: looseFacts.terrain || null,
  };
}

// Append a correction to an envelope, preserving prior history. Returns a new
// envelope object; never mutates the input.
function appendCorrection(envelope, correction = {}) {
  const base = isEnvelope(envelope) ? envelope : buildCatalogCourseEnvelope({});
  const history = Array.isArray(base.corrections) ? base.corrections.slice() : [];
  history.push({
    field: correction.field || null,
    previous: correction.previous === undefined ? null : correction.previous,
    next: correction.next === undefined ? null : correction.next,
    reason: correction.reason || null,
    source: correction.source || null,
    at: correction.at || new Date().toISOString(),
  });
  return Object.assign({}, base, { corrections: history });
}

// ---------------------------------------------------------------------------
// GPX analysis (privacy-first, deterministic)
// ---------------------------------------------------------------------------

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

function collectTrackPoints(parsed) {
  const points = [];
  const gpx = parsed && parsed.gpx;
  if (!gpx) return points;
  const segmentsFrom = (trk) => {
    const trkseg = trk && trk.trkseg;
    if (!trkseg) return [];
    return Array.isArray(trkseg) ? trkseg : [trkseg];
  };
  const trks = gpx.trk ? (Array.isArray(gpx.trk) ? gpx.trk : [gpx.trk]) : [];
  for (const trk of trks) {
    for (const seg of segmentsFrom(trk)) {
      const pts = seg && seg.trkpt ? (Array.isArray(seg.trkpt) ? seg.trkpt : [seg.trkpt]) : [];
      pts.forEach((pt, index) => points.push({ point: pt, segmentStart: index === 0 }));
    }
  }
  // Fall back to route points if no track points present.
  if (points.length === 0 && gpx.rte) {
    const rtes = Array.isArray(gpx.rte) ? gpx.rte : [gpx.rte];
    for (const rte of rtes) {
      const pts = rte && rte.rtept ? (Array.isArray(rte.rtept) ? rte.rtept : [rte.rtept]) : [];
      pts.forEach((pt, index) => points.push({ point: pt, segmentStart: index === 0 }));
    }
  }
  return points;
}

function pointCoords(pt) {
  const attr = pt && pt.$ ? pt.$ : pt;
  const lat = numberOrNull(attr && attr.lat);
  const lng = numberOrNull(attr && attr.lon !== undefined ? attr.lon : attr && attr.lng);
  let ele = null;
  if (pt && pt.ele !== undefined) {
    const raw = Array.isArray(pt.ele) ? pt.ele[0] : pt.ele;
    ele = numberOrNull(isPlainObject(raw) ? raw._ : raw);
  }
  return { lat, lng, ele };
}

// Analyze a GPX document. Returns a privacy-safe result: distance/elevation and
// bounded distance/elevation samples only. NEVER returns lat/lng or precise
// start/end points. Throws on invalid input.
async function analyzeGpx(input, options = {}) {
  const maxBytes = Number(options.maxBytes) || GPX_MAX_BYTES;
  const maxPoints = Number(options.maxPoints) || GPX_MAX_POINTS;
  const asOf = options.asOf || new Date().toISOString();

  if (input === null || input === undefined) throw new Error('gpx input is required');
  const xml = Buffer.isBuffer(input) ? input.toString('utf8') : String(input);
  const byteLength = Buffer.byteLength(xml, 'utf8');
  if (byteLength === 0) throw new Error('gpx input is empty');
  if (byteLength > maxBytes) throw new Error('gpx input exceeds size limit');

  // eslint-disable-next-line global-require
  const xml2js = require('xml2js');
  let parsed;
  try {
    parsed = await xml2js.parseStringPromise(xml, { explicitArray: false, trim: true });
  } catch (err) {
    throw new Error(`gpx is not valid XML: ${err.message}`);
  }
  if (!parsed || !parsed.gpx) throw new Error('gpx root element missing');

  const rawPoints = collectTrackPoints(parsed);
  if (rawPoints.length > maxPoints) throw new Error('gpx exceeds point limit');

  const coords = [];
  for (const entry of rawPoints) {
    const { lat, lng, ele } = pointCoords(entry.point);
    if (lat === null || lng === null) continue;
    if (lat < LAT_MIN || lat > LAT_MAX || lng < LNG_MIN || lng > LNG_MAX) {
      throw new Error('gpx contains out-of-range coordinates');
    }
    if (ele !== null && (ele < ELEV_MIN_M || ele > ELEV_MAX_M)) {
      throw new Error('gpx contains out-of-range elevation');
    }
    coords.push({ lat, lng, ele, segmentStart: entry.segmentStart });
  }
  if (coords.length < GPX_MIN_POINTS) throw new Error('gpx has too few valid points');

  // Cumulative distance (haversine) and noise-resistant elevation gain.
  let meters = 0;
  let gainFt = 0;
  let maxAltFt = coords[0].ele !== null ? coords[0].ele * 3.28084 : null;
  let pendingGainFt = 0;
  let lastEleFt = coords[0].ele !== null ? coords[0].ele * 3.28084 : null;
  const METERS_PER_MILE = 1609.344;
  const totalSamples = 40; // bounded, privacy-safe elevation profile resolution

  const profile = [];
  for (let i = 1; i < coords.length; i += 1) {
    const prev = coords[i - 1];
    const cur = coords[i];
    if (!cur.segmentStart) meters += haversineMeters(prev.lat, prev.lng, cur.lat, cur.lng);
    if (cur.ele !== null) {
      const eleFt = cur.ele * 3.28084;
      if (maxAltFt === null || eleFt > maxAltFt) maxAltFt = eleFt;
      if (!cur.segmentStart && lastEleFt !== null) {
        const delta = eleFt - lastEleFt;
        if (delta >= 0) {
          pendingGainFt += delta;
          if (pendingGainFt >= ELEV_NOISE_FT) {
            gainFt += pendingGainFt;
            pendingGainFt = 0;
          }
        } else {
          pendingGainFt = 0;
        }
      }
      lastEleFt = eleFt;
      if (cur.segmentStart) pendingGainFt = 0;
    }
  }

  const distanceMiles = Math.round((meters / METERS_PER_MILE) * 100) / 100;
  if (distanceMiles < 0.05) throw new Error('gpx course distance is too short');
  // Build bounded distance/elevation samples (no coordinates).
  const step = Math.max(1, Math.ceil(coords.length / totalSamples));
  let running = 0;
  for (let i = 0; i < coords.length; i += step) {
    const eleFt = coords[i].ele !== null ? Math.round(coords[i].ele * 3.28084) : null;
    profile.push({
      distanceMiles: Math.round((running / METERS_PER_MILE) * 100) / 100,
      elevationFt: eleFt,
    });
    // advance running distance to next sample anchor
    for (let j = i + 1; j <= Math.min(i + step, coords.length - 1); j += 1) {
      if (!coords[j].segmentStart) {
        running += haversineMeters(coords[j - 1].lat, coords[j - 1].lng, coords[j].lat, coords[j].lng);
      }
    }
  }

  const elevationGainFt = Math.round(gainFt);
  const maxAltitudeFt = maxAltFt === null ? null : Math.round(maxAltFt);
  // Coordinates alone cannot prove road/trail/track surface, so do not invent it.
  const terrain = null;

  return {
    distanceMiles,
    elevationGainFt,
    maxAltitudeFt,
    terrain,
    pointCount: coords.length,
    samples: profile,
    asOf,
    privacy: {
      containsUserGps: true,
      coordinatesStored: false,
      startEndStored: false,
    },
  };
}

// Build a user_gpx envelope from an analyzeGpx() result. Stores only distance /
// elevation samples and privacy metadata — never coordinates or start/end.
function buildUserGpxEnvelope(analysis = {}, { asOf, baseEnvelope, raceDate } = {}) {
  const stamp = asOf || analysis.asOf || new Date().toISOString();
  const base = isEnvelope(baseEnvelope) ? baseEnvelope : readCourseEnvelope(baseEnvelope);
  const prior = isEnvelope(base) ? base : null;
  const facts = {};
  const elevation = fact(numberOrNull(analysis.elevationGainFt), { source: 'user_gpx', provenance: 'user_gpx', confidence: 'medium', asOf: stamp });
  const altitude = fact(numberOrNull(analysis.maxAltitudeFt), { source: 'user_gpx', provenance: 'user_gpx', confidence: 'medium', asOf: stamp });
  const terrainValue = TERRAIN_KINDS.has(String(analysis.terrain || '').toLowerCase())
    ? String(analysis.terrain).toLowerCase()
    : null;
  const terrain = fact(terrainValue, { source: 'user_gpx', provenance: 'user_gpx', confidence: 'medium', asOf: stamp });
  if (elevation) facts.elevationGainFt = elevation;
  if (altitude) facts.maxAltitudeFt = altitude;
  if (terrain) facts.terrain = terrain;

  const samples = Array.isArray(analysis.samples)
    ? analysis.samples.map((s) => ({ distanceMiles: numberOrNull(s.distanceMiles), elevationFt: numberOrNull(s.elevationFt) }))
    : [];

  const corrections = Array.isArray(prior && prior.corrections) ? prior.corrections.slice() : [];
  if (prior && prior.provenance !== 'user_gpx') {
    corrections.push({
      field: 'course_source',
      previous: prior.provenance || 'unknown',
      next: 'user_gpx',
      reason: 'User uploaded a course GPX',
      source: 'user_gpx',
      at: stamp,
    });
  }

  return {
    envelopeVersion: ENVELOPE_VERSION,
    canonicalEventId: prior?.canonicalEventId || null,
    editionId: prior?.editionId || null,
    editionDate: prior?.editionDate || raceDate || null,
    courseVersion: `user-gpx:${stamp}`,
    provenance: 'user_gpx',
    source: 'user_gpx',
    url: null,
    facts,
    distanceSamples: samples,
    freshness: { asOf: stamp, staleAfterDays: DEFAULT_STALE_AFTER_DAYS },
    corrections,
    privacy: { containsUserGps: true, coordinatesStored: false, startEndStored: false },
  };
}

function courseDistanceMatchesRace(courseDistanceMiles, raceDistanceMiles) {
  const courseDistance = numberOrNull(courseDistanceMiles);
  const raceDistance = numberOrNull(raceDistanceMiles);
  if (courseDistance === null || raceDistance === null || courseDistance <= 0 || raceDistance <= 0) return false;
  const tolerance = Math.max(0.5, raceDistance * 0.15);
  return Math.abs(courseDistance - raceDistance) <= tolerance;
}

// Convenience: derive one honest course-intelligence state for a race row.
function courseIntelligenceForRace(raceRow = {}, { nowISO } = {}) {
  const envelope = readCourseEnvelope(raceRow.course_profile_json);
  const evaluation = evaluateCourseTrust({
    envelope,
    looseFacts: {
      elevationGainFt: raceRow.elevation_gain_ft,
      maxAltitudeFt: raceRow.max_altitude_ft,
      terrain: raceRow.terrain,
      source: raceRow.source,
      url: raceRow.url,
    },
    raceDate: raceRow.race_date,
    nowISO,
  });
  return {
    state: evaluation.state,
    label: evaluation.label,
    trusted: evaluation.trusted,
    provenance: evaluation.provenance,
    facts: evaluation.facts,
  };
}

// ---------------------------------------------------------------------------
// Goal taxonomy
// ---------------------------------------------------------------------------

function validateGoalKind(kind) {
  return GOAL_KINDS.includes(String(kind));
}

function isRaceGoal(kind) {
  return String(kind) === 'race';
}

function normalizeGoalKind(kind, fallback = 'general_fitness') {
  return validateGoalKind(kind) ? String(kind) : fallback;
}

module.exports = {
  ENVELOPE_VERSION,
  PROVENANCE_KINDS,
  TRUSTED_PROVENANCE,
  COURSE_STATES,
  STATE_LABELS,
  GOAL_KINDS,
  GPX_MAX_BYTES,
  GPX_MAX_POINTS,
  TERRAIN_KINDS,
  normalizeRaceName,
  normalizeRaceLocation,
  canonicalEventIdFromCatalogId,
  editionYear,
  resolveCatalogRace,
  buildCatalogCourseEnvelope,
  readCourseEnvelope,
  isEnvelope,
  evaluateCourseTrust,
  appendCorrection,
  analyzeGpx,
  buildUserGpxEnvelope,
  courseDistanceMatchesRace,
  courseIntelligenceForRace,
  factsFromEnvelope,
  validateGoalKind,
  isRaceGoal,
  normalizeGoalKind,
};
