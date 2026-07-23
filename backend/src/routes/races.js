const router = require('express').Router();
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { dbGet, dbAll, dbRun } = require('../db');
const auth = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');
const raceCourse = require('../lib/raceCourse');

// GPX uploads are held in memory only; raw coordinates are never persisted.
const gpxUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: raceCourse.GPX_MAX_BYTES, files: 1 },
});
const RACE_STATUSES = new Set(['upcoming', 'completed', 'cancelled']);
const gpxUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req) => String(req.user.id),
  message: { error: 'Too many GPX uploads. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

function cleanString(value, maxLen = 200) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n]+/g, ' ').trim().slice(0, maxLen);
}

function isValidISODate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return false;
  const normalized = value.trim();
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized;
}

function parseGoalTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  return Number.isInteger(seconds) && seconds >= 0 && seconds <= 30 * 24 * 60 * 60 ? seconds : NaN;
}

function catalogEnvelopeJson(catalogRace) {
  const existing = raceCourse.readCourseEnvelope(catalogRace.course_profile_json);
  if (raceCourse.isEnvelope(existing)) return JSON.stringify(existing);
  return JSON.stringify(raceCourse.buildCatalogCourseEnvelope(catalogRace, {
    asOf: catalogRace.created_at || null,
    provenance: 'curated',
  }));
}

function catalogRaceFields(catalogRace) {
  const locationParts = [catalogRace.city, catalogRace.state].filter(Boolean);
  const location = locationParts.length ? locationParts.join(', ') : (catalogRace.country || null);
  return {
    race_name: catalogRace.name,
    race_date: catalogRace.race_date,
    distance_miles: Number(catalogRace.distance_miles),
    location: location ? location.trim() : null,
    elevation_gain_ft: catalogRace.elevation_gain_ft ?? null,
    max_altitude_ft: catalogRace.max_altitude_ft ?? null,
    terrain: catalogRace.terrain || null,
    course_profile_json: catalogEnvelopeJson(catalogRace),
    source: catalogRace.source || null,
    url: catalogRace.url || null,
  };
}

function isSameCatalogEdition(race, catalogRace) {
  if (!race || !catalogRace) return false;
  if (String(race.race_date) !== String(catalogRace.race_date)) return false;
  if (Number(race.distance_miles) !== Number(catalogRace.distance_miles)) return false;
  const envelope = raceCourse.readCourseEnvelope(race.course_profile_json);
  if (raceCourse.isEnvelope(envelope) && envelope.editionId) {
    return String(envelope.editionId) === String(catalogRace.id);
  }
  return raceCourse.normalizeRaceName(race.race_name) === raceCourse.normalizeRaceName(catalogRace.name);
}

function receiveGpx(req, res, next) {
  gpxUpload.single('gpx')(req, res, (err) => {
    if (!err) return next();
    console.error('[races/gpx] upload rejected:', err.message);
    const tooLarge = err.code === 'LIMIT_FILE_SIZE';
    return res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? 'GPX file exceeds the 2 MB limit' : 'Invalid GPX upload' });
  });
}

// Serialize a user-facing race with its honest course-intelligence state and
// without leaking raw GPX coordinates.
function withCourseIntelligence(race) {
  if (!race) return race;
  const intelligence = raceCourse.courseIntelligenceForRace(race);
  return Object.assign({}, race, { course_intelligence: intelligence });
}

router.get('/', auth, async (req, res) => {
  try {
    const items = await dbAll('SELECT * FROM race_events WHERE user_id=? ORDER BY race_date ASC', [req.user.id]);
    res.json({ races: items.map(withCourseIntelligence) });
  } catch (err) {
    console.error('[races/list] failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch races' });
  }
});

router.get('/next', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const race = await dbGet("SELECT * FROM race_events WHERE user_id=? AND status='upcoming' AND race_date>=? ORDER BY race_date ASC LIMIT 1", [req.user.id, today]);
    res.json({ race: race ? withCourseIntelligence(race) : null });
  } catch (err) {
    console.error('[races/next] failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch next race' });
  }
});

router.get('/catalog', auth, async (req, res) => {
  try {
    const { q, distance, month, state } = req.query || {};
    const where = [];
    const params = [];

    if (q && String(q).trim()) {
      const searchTokens = raceCourse.normalizeCatalogSearchTokens(q);
      if (searchTokens.length === 0) {
        where.push('1=0');
      } else {
        for (const token of searchTokens) {
          where.push('(name ILIKE ? OR city ILIKE ? OR state ILIKE ? OR country ILIKE ?)');
          const pattern = `%${token}%`;
          params.push(pattern, pattern, pattern, pattern);
        }
      }
    }

    if (distance !== undefined && distance !== '') {
      const distanceMiles = Number(distance);
      if (!Number.isFinite(distanceMiles)) return res.status(400).json({ error: 'distance must be a number' });
      where.push('distance_miles BETWEEN ? AND ?');
      params.push(distanceMiles - 1, distanceMiles + 1);
    }

    if (month !== undefined && month !== '') {
      const monthNumber = Number(month);
      if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
        return res.status(400).json({ error: 'month must be an integer from 1 to 12' });
      }
      where.push('(EXTRACT(MONTH FROM race_date::date) = ? OR substring(race_date from 6 for 2) = ?)');
      params.push(monthNumber, String(monthNumber).padStart(2, '0'));
    }

    if (state && String(state).trim()) {
      where.push('state = ?');
      params.push(String(state).trim().toUpperCase());
    }

    const sql = `
      SELECT *
      FROM race_catalog
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY
        CASE scope WHEN 'local' THEN 0 WHEN 'regional' THEN 1 ELSE 2 END,
        race_date ASC
      LIMIT 50
    `;
    const races = await dbAll(sql, params);
    res.json({ races: races.map(withCourseIntelligence) });
  } catch (err) {
    console.error('[races/catalog] failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch race catalog' });
  }
});

router.post('/', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const race_name = cleanString(body.race_name, 200);
    const race_date = cleanString(body.race_date, 10);
    const distance_miles = body.distance_miles;
    const location = cleanString(body.location, 200) || null;
    const notes = cleanString(body.notes, 2000) || null;
    const status = cleanString(body.status || 'upcoming', 20).toLowerCase();
    const goalTimeSeconds = parseGoalTime(body.goal_time_seconds);
    if (!race_name || !race_date || !distance_miles) return res.status(400).json({ error: 'race_name, race_date, distance_miles are required' });
    if (!isValidISODate(race_date)) return res.status(400).json({ error: 'race_date must be YYYY-MM-DD' });
    const distance = Number(distance_miles);
    if (!Number.isFinite(distance) || distance <= 0 || distance > 100) return res.status(400).json({ error: 'distance_miles must be between 0 and 100' });
    if (!RACE_STATUSES.has(status)) return res.status(400).json({ error: 'status is invalid' });
    if (Number.isNaN(goalTimeSeconds)) return res.status(400).json({ error: 'goal_time_seconds is invalid' });

    // H7: try to resolve to an unambiguous current catalog edition and copy the
    // canonical course envelope. Never silently pick a wrong edition; otherwise
    // preserve exactly the typed name/date/distance as an unknown/manual record.
    let course = { elevation_gain_ft: null, max_altitude_ft: null, terrain: null, course_profile_json: null, source: null, url: null };
    try {
      const catalog = await dbAll('SELECT * FROM race_catalog', []);
      const resolution = raceCourse.resolveCatalogRace({
        catalog,
        name: race_name,
        date: race_date,
        distanceMiles: distance,
        location,
      });
      if (resolution.status === 'resolved' && resolution.race) {
        const matched = resolution.race;
        course = {
          elevation_gain_ft: matched.elevation_gain_ft || null,
          max_altitude_ft: matched.max_altitude_ft || null,
          terrain: matched.terrain || null,
          course_profile_json: catalogEnvelopeJson(matched),
          source: matched.source || null,
          url: matched.url || null,
        };
      }
    } catch (resolveErr) {
      console.error('[races/create] catalog resolution failed, using manual fallback:', resolveErr.message);
    }

    const id = uuidv4();
    await dbRun(
      `INSERT INTO race_events (
        id, user_id, race_name, race_date, distance_miles, location, goal_time_seconds, status, notes,
        elevation_gain_ft, max_altitude_ft, terrain, course_profile_json, source, url
      )
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, req.user.id, race_name, race_date, distance, location, goalTimeSeconds, status, notes,
        course.elevation_gain_ft, course.max_altitude_ft, course.terrain, course.course_profile_json, course.source, course.url,
      ]
    );

    const race = await dbGet('SELECT * FROM race_events WHERE id=? AND user_id=?', [id, req.user.id]);
    res.status(201).json({ race: withCourseIntelligence(race) });
  } catch (err) {
    console.error('[races/create] failed:', err.message);
    res.status(500).json({ error: 'Failed to add race' });
  }
});

router.post('/from-catalog/:catalogId', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const hasGoalTime = Object.prototype.hasOwnProperty.call(body, 'goal_time_seconds');
    const requestedGoalTime = parseGoalTime(body.goal_time_seconds);
    if (Number.isNaN(requestedGoalTime)) return res.status(400).json({ error: 'goal_time_seconds is invalid' });

    const catalogRace = await dbGet('SELECT * FROM race_catalog WHERE id=?', [req.params.catalogId]);
    if (!catalogRace) return res.status(404).json({ error: 'Catalog race not found' });

    const canonical = catalogRaceFields(catalogRace);
    const candidates = await dbAll(
      `SELECT * FROM race_events
       WHERE user_id=? AND race_date=? AND distance_miles=?
       ORDER BY created_at ASC, id ASC`,
      [req.user.id, canonical.race_date, canonical.distance_miles]
    );
    const existingRace = candidates.find((race) => isSameCatalogEdition(race, catalogRace));

    if (existingRace) {
      const goalTimeSeconds = hasGoalTime ? requestedGoalTime : (existingRace.goal_time_seconds ?? null);
      await dbRun(
        `UPDATE race_events
         SET race_name=?, race_date=?, distance_miles=?, location=?, goal_time_seconds=?,
             elevation_gain_ft=?, max_altitude_ft=?, terrain=?, course_profile_json=?, source=?, url=?
         WHERE id=? AND user_id=?`,
        [
          canonical.race_name,
          canonical.race_date,
          canonical.distance_miles,
          canonical.location,
          goalTimeSeconds,
          canonical.elevation_gain_ft,
          canonical.max_altitude_ft,
          canonical.terrain,
          canonical.course_profile_json,
          canonical.source,
          canonical.url,
          existingRace.id,
          req.user.id,
        ]
      );
      const refreshed = await dbGet('SELECT * FROM race_events WHERE id=? AND user_id=?', [existingRace.id, req.user.id]);
      return res.json({ race: withCourseIntelligence(refreshed), existing: true });
    }

    const id = uuidv4();

    await dbRun(
      `INSERT INTO race_events (
        id, user_id, race_name, race_date, distance_miles, location, goal_time_seconds, status,
        elevation_gain_ft, max_altitude_ft, terrain, course_profile_json, source, url
       )
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        req.user.id,
        canonical.race_name,
        canonical.race_date,
        canonical.distance_miles,
        canonical.location,
        requestedGoalTime,
        'upcoming',
        canonical.elevation_gain_ft,
        canonical.max_altitude_ft,
        canonical.terrain,
        canonical.course_profile_json,
        canonical.source,
        canonical.url
      ]
    );

    const race = await dbGet('SELECT * FROM race_events WHERE id=? AND user_id=?', [id, req.user.id]);
    res.status(201).json({ race: withCourseIntelligence(race), existing: false });
  } catch (err) {
    console.error('[races/from-catalog] failed:', err.message);
    res.status(500).json({ error: 'Failed to add race from catalog' });
  }
});

// H7: privacy-safe user GPX course upload for an existing, owned race. Stores
// only distance/elevation samples and privacy metadata — never raw coordinates.
router.post('/:id/course/gpx', auth, gpxUploadLimiter, receiveGpx, async (req, res) => {
  try {
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ error: 'gpx file is required' });
    }
    const race = await dbGet('SELECT * FROM race_events WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!race) return res.status(404).json({ error: 'Race not found' });

    let analysis;
    try {
      analysis = await raceCourse.analyzeGpx(req.file.buffer, { maxBytes: raceCourse.GPX_MAX_BYTES });
    } catch (parseErr) {
      console.error('[races/gpx] analysis rejected:', parseErr.message);
      return res.status(400).json({ error: `Could not read GPX: ${parseErr.message}` });
    }

    if (!raceCourse.courseDistanceMatchesRace(analysis.distanceMiles, race.distance_miles)) {
      return res.status(400).json({
        error: `GPX distance (${analysis.distanceMiles} mi) does not match this ${Number(race.distance_miles)} mi race`,
      });
    }

    const envelope = raceCourse.buildUserGpxEnvelope(analysis, {
      baseEnvelope: race.course_profile_json,
      raceDate: race.race_date,
    });
    await dbRun(
      `UPDATE race_events
       SET elevation_gain_ft=?, max_altitude_ft=?, terrain=?, course_profile_json=?, source=?
       WHERE id=? AND user_id=?`,
      [
        analysis.elevationGainFt,
        analysis.maxAltitudeFt,
        analysis.terrain,
        JSON.stringify(envelope),
        'user_gpx',
        req.params.id,
        req.user.id,
      ]
    );

    const updated = await dbGet('SELECT * FROM race_events WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({
      race: withCourseIntelligence(updated),
      analysis: {
        distanceMiles: analysis.distanceMiles,
        elevationGainFt: analysis.elevationGainFt,
        maxAltitudeFt: analysis.maxAltitudeFt,
        terrain: analysis.terrain,
        pointCount: analysis.pointCount,
        privacy: analysis.privacy,
      },
    });
  } catch (err) {
    console.error('[races/gpx] failed:', err.message);
    res.status(500).json({ error: 'Failed to process GPX course' });
  }
});

router.patch('/:id', auth, async (req, res) => {
  try {
    const race = await dbGet('SELECT * FROM race_events WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    if (!race) return res.status(404).json({ error: 'Race not found' });

    const next = { ...race, ...req.body };
    next.race_name = cleanString(next.race_name, 200);
    next.race_date = cleanString(next.race_date, 10);
    next.location = cleanString(next.location, 200) || null;
    next.notes = cleanString(next.notes, 2000) || null;
    next.status = cleanString(next.status, 20).toLowerCase();
    next.distance_miles = Number(next.distance_miles);
    next.goal_time_seconds = parseGoalTime(next.goal_time_seconds);
    if (!next.race_name) return res.status(400).json({ error: 'race_name is required' });
    if (!isValidISODate(next.race_date)) return res.status(400).json({ error: 'race_date must be YYYY-MM-DD' });
    if (!Number.isFinite(next.distance_miles) || next.distance_miles <= 0 || next.distance_miles > 100) return res.status(400).json({ error: 'distance_miles must be between 0 and 100' });
    if (!RACE_STATUSES.has(next.status)) return res.status(400).json({ error: 'status is invalid' });
    if (Number.isNaN(next.goal_time_seconds)) return res.status(400).json({ error: 'goal_time_seconds is invalid' });
    const identityChanged = raceCourse.normalizeRaceName(next.race_name) !== raceCourse.normalizeRaceName(race.race_name)
      || String(next.race_date) !== String(race.race_date)
      || Math.abs(Number(next.distance_miles) - Number(race.distance_miles)) >= 0.01
      || String(next.location || '').trim().toLowerCase() !== String(race.location || '').trim().toLowerCase();
    const course = identityChanged
      ? { elevation_gain_ft: null, max_altitude_ft: null, terrain: null, course_profile_json: null, source: null, url: null }
      : race;
    await dbRun(
      `UPDATE race_events
       SET race_name=?, race_date=?, distance_miles=?, location=?, goal_time_seconds=?, status=?, notes=?,
           elevation_gain_ft=?, max_altitude_ft=?, terrain=?, course_profile_json=?, source=?, url=?
       WHERE id=? AND user_id=?`,
      [
        next.race_name, next.race_date, next.distance_miles, next.location, next.goal_time_seconds, next.status, next.notes,
        course.elevation_gain_ft, course.max_altitude_ft, course.terrain, course.course_profile_json, course.source, course.url,
        req.params.id, req.user.id,
      ]
    );

    const updated = await dbGet('SELECT * FROM race_events WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ race: withCourseIntelligence(updated) });
  } catch (err) {
    console.error('[races/patch] failed:', err.message);
    res.status(500).json({ error: 'Update failed' });
  }
});

router.delete('/:id', auth, async (req, res) => {
  try {
    await dbRun('DELETE FROM race_events WHERE id=? AND user_id=?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[races/delete] failed:', err.message);
    res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;
